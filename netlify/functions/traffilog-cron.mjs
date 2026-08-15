// Netlify Scheduled Function — recolector acumulativo (cron horario, ver netlify.toml).
// Estrategia — PRINCIPIO: merge por fecha, NUNCA reemplazo total. El histórico
// sólo crece; una corrida parcial no puede borrar lo ya asentado:
//   · get_incremental_events (v3) → union por event_id en blobs "events/<fecha>" (dedupe natural, nunca pisa).
//   · get_vehicle_trips de los últimos 3 días por unidad ACTIVA → pisa por drive_id en "trips/<fecha>"
//     (re-fetch del mismo día = misma llave, así el re-cálculo es idempotente).
//   · Re-agrega SOLO los días tocados en esta corrida y los FUSIONA en el blob "registros"
//     ({ fecha|driver_id|vehicle_id: registro }) con mergeRegistrosPorFecha() — el mismo motor de
//     merge que usa connector/backfill.mjs. El histórico crece solo y nunca se reemplaza entero.
//   · Reconstruye el snapshot completo desde "registros" → blob "snapshot" (lo sirve traffilog.mjs).
import { getStore } from '@netlify/blobs';
import {
  login, fetchFleet, fetchDrivers, fetchVehicleTrips, fetchIncrementalEvents,
  normFleet, normDrivers, normTripRow, normEventRow,
  aggregate, buildSnapshot, mergeRegistrosPorFecha, indexRegistros, mapLimit, ymd, parseApiTime,
} from './lib/core.mjs';
import { empacar, desempacar } from './lib/codec.mjs';

const TRIP_BACKFILL_DAYS = 3;      // re-fetch de viajes (cubre viajes que cierran tarde)
const ACTIVE_WINDOW_H = 72;        // solo unidades con comunicación reciente
const PURGE_BLOBS_DAYS = 120;      // los blobs crudos por fecha se podan; los `registros` NO caducan
const MAX_DIAS_RECALC = 14;        // tope de días re-agregados por corrida (coste acotado)

export default async () => {
  const env = process.env;
  if (!env.TRAFFILOG_USER || !env.TRAFFILOG_PASS) return new Response('faltan TRAFFILOG_USER/PASS', { status: 500 });
  const store = getStore('traffilog');
  const opts = { url: env.TRAFFILOG_REST_URL };
  const t0 = Date.now();

  const tok = await login(env.TRAFFILOG_USER, env.TRAFFILOG_PASS, opts);
  const [fleetRaw, driversRaw] = await Promise.all([fetchFleet(tok, opts), fetchDrivers(tok, opts).catch(() => [])]);
  const fleet = normFleet(fleetRaw);
  const roster = normDrivers(driversRaw);
  await store.setJSON('fleet', fleet);
  await store.setJSON('roster', roster);

  // 1) eventos incrementales → union por event_id, agrupados por fecha
  const incRows = (await fetchIncrementalEvents(tok, opts).catch(() => [])).map(normEventRow).filter(e => e.fecha && e.event_id);
  const byFecha = new Map();
  for (const e of incRows) (byFecha.get(e.fecha) || byFecha.set(e.fecha, []).get(e.fecha)).push(e);
  for (const [fecha, rows] of byFecha) {
    const key = 'events/' + fecha;
    const prev = (await store.get(key, { type: 'json' }).catch(() => null)) || {};
    for (const e of rows) if (!prev[e.event_id]) prev[e.event_id] = e; // union: nunca pisa lo ya visto
    await store.setJSON(key, prev);
  }

  // 2) viajes últimos días, solo unidades activas → pisa por drive_id (idempotente)
  const now = Date.now();
  const active = fleet.filter(v => {
    const t = parseApiTime(v.ultima_comunicacion);
    return t != null && now - t < ACTIVE_WINDOW_H * 3600e3;
  });
  const from = ymd(new Date(now - TRIP_BACKFILL_DAYS * 864e5)), to = ymd(new Date(now));
  const tripRows = (await mapLimit(active, 12, v =>
    fetchVehicleTrips(tok, { license_nmbr: v.placa, vehicle_id: v.vehicle_id }, from, to, opts).catch(() => [])
  )).flat().map(normTripRow).filter(t => t.fecha && t.drive_id);
  const tByFecha = new Map();
  for (const t of tripRows) (tByFecha.get(t.fecha) || tByFecha.set(t.fecha, []).get(t.fecha)).push(t);
  for (const [fecha, rows] of tByFecha) {
    const key = 'trips/' + fecha;
    const prev = (await store.get(key, { type: 'json' }).catch(() => null)) || {};
    for (const t of rows) prev[t.drive_id] = t; // misma llave → re-cálculo idempotente
    await store.setJSON(key, prev);
  }

  // 3) días TOCADOS en esta corrida: se re-agregan completos desde los blobs por fecha.
  //    (Los blobs "trips/<fecha>"/"events/<fecha>" ya contienen el día entero acumulado,
  //     así que re-agregar un día tocado produce su registro definitivo.)
  const tocados = [...new Set([...byFecha.keys(), ...tByFecha.keys()])]
    .filter(Boolean).sort().slice(-MAX_DIAS_RECALC);
  const trips = [], events = [];
  for (const fecha of tocados) {
    const [t, e] = await Promise.all([
      store.get('trips/' + fecha, { type: 'json' }).catch(() => null),
      store.get('events/' + fecha, { type: 'json' }).catch(() => null),
    ]);
    if (t) trips.push(...Object.values(t));
    if (e) events.push(...Object.values(e));
  }
  const fleetIdx = new Map(fleet.map(v => [v.vehicle_id, v]));
  const driverIdx = new Map(roster.map(d => [d.driver_id, d]));
  const regs = aggregate({ trips, events, fleetIdx, driverIdx });

  // 4) MERGE acumulativo en el blob "registros" — mismo motor que connector/backfill.mjs.
  //    Solo los días recalculados se reemplazan; el resto del histórico queda intacto.
  //    Bootstrap: la primera corrida tras el despliegue siembra `registros` con el histórico que
  //    ya vivía dentro del blob `snapshot` (o el que dejó el backfill), para no arrancar en vacío.
  let prevRegs = await store.get('registros', { type: 'json' }).catch(() => null);
  if (!prevRegs) {
    const prevSnap = await store.get('snapshot', { type: 'json' }).catch(() => null);
    /* el blob `snapshot` puede venir en crudo (formato viejo) o compacto v3 */
    const regsPrev = prevSnap?.v === 3 ? desempacar(prevSnap) : (prevSnap?.registros || []);
    prevRegs = indexRegistros(regsPrev);
    console.log(`bootstrap registros ← snapshot (${Object.keys(prevRegs).length})`);
  }
  const { merged, stats } = mergeRegistrosPorFecha(prevRegs, regs, tocados);
  await store.setJSON('registros', merged);

  // 5) snapshot completo (todo el histórico acumulado) con scores/agregados recalculados.
  //    Se GUARDA compactado v3 (~15x: 42 MB → 2.9 MB). trips/events/scores no se
  //    almacenan: son derivados y traffilog.mjs los reconstruye con buildSnapshot
  //    a partir de `registros`, que es el dato atómico. Escribir 42 MB cada hora
  //    eran ~30 GB/mes de escrituras a Blobs por un JSON que nadie consumía entero.
  const snapshot = buildSnapshot(merged, { fleet, driverRoster: roster, source: 'traffilog:rest:cron' });
  await store.setJSON('snapshot', empacar(snapshot));

  // 6) poda de blobs crudos antiguos (los `registros` ya los resumen; el histórico no se pierde)
  const cutoff = ymd(new Date(now - PURGE_BLOBS_DAYS * 864e5));
  try {
    const { blobs } = await store.list({ prefix: '' });
    for (const b of blobs) {
      const m = b.key.match(/^(trips|events)\/(\d{4}-\d{2}-\d{2})$/);
      if (m && m[2] < cutoff) await store.delete(b.key).catch(() => {});
    }
  } catch {}

  console.log(`cron ok en ${((Date.now() - t0) / 1000).toFixed(1)}s · +${incRows.length} eventos inc · ${tripRows.length} viajes · ` +
    `días recalculados ${tocados.join(',') || '—'} · registros ${stats.antes}→${stats.despues} (+${stats.nuevas}) · ` +
    `snapshot ${snapshot.registros.length} reg · ${snapshot.from} → ${snapshot.to}`);
  return new Response('ok');
};

export const config = { schedule: '13 * * * *' };
