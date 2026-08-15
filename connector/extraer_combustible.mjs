// extraer_combustible.mjs — Rescata los eventos de COMBUSTIBLE de los tramos crudos
// antes de que se borren, y los acumula en datos/historico/combustible.json.
//
// Por qué existe
// -------------
// El archivo semanal v3 guarda CONTEOS por operador×unidad×día, no eventos sueltos:
// una caída de nivel queda como "+1 en la cubeta fuel_caida", sin hora ni GPS. Y los
// tramos crudos (única fuente con el evento individual) se borran al consolidar la
// semana. Sin esto, la detección de robo es irrecuperable hacia atrás.
//
// Qué guarda
// ----------
//   fuel_caida  — "New Version fuel Drop": bajada brusca de nivel = SOSPECHA DE ROBO
//   fuel_carga  — "New Version Fuel fill": carga de combustible (contexto: una caída
//                 justo antes de una carga suele ser recalibración, no robo)
//   fuel_sensor — lecturas/fallas del sensor de nivel
//
// El litraje NO viaja en el evento (get_trip_events v2 no tiene campo de payload);
// lo que da Traffilog es el CUÁNDO, el DÓNDE y en QUÉ unidad. Para el % caído está
// el parámetro 28932 vía get_parameters, que sólo expone el ÚLTIMO valor.
//
// Uso:
//   node connector/extraer_combustible.mjs                    # todos los tramos en disco
//   node connector/extraer_combustible.mjs --tramo <archivo>  # uno solo
//
// Es idempotente: deduplica por event_id, así que se puede correr las veces que sea.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
const TRAMOS = join(DIR, '.tramos');
const DESTINO = join(DIR, 'combustible.json');
mkdirSync(DIR, { recursive: true });

const RX = {
  fuel_caida: /fuel drop/i,
  fuel_carga: /fuel fill/i,
  fuel_sensor: /fuel level/i,
};
function tipoDe(nombre) {
  for (const t in RX) if (RX[t].test(nombre)) return t;
  return null;
}

/** Extrae los eventos de combustible de una colección de eventos ya normalizados. */
export function extraerDeEventos(events) {
  const out = [];
  for (const e of events || []) {
    const tipo = tipoDe(e.name || '');
    if (!tipo) continue;
    out.push({
      id: String(e.event_id || ''),
      tipo,
      fecha: e.fecha || '',
      time: e.time || '',
      vehicle_id: String(e.vehicle_id || ''),
      placa: e.placa || '',
      driver_id: String(e.driver_id || ''),
      conductor: e.conductor || '',
      lat: e.lat != null ? +(+e.lat).toFixed(5) : null,
      lng: e.lng != null ? +(+e.lng).toFixed(5) : null,
      speed: e.speed != null ? e.speed : null,
    });
  }
  return out;
}

/** Fusiona filas nuevas en el archivo acumulado, deduplicando por id. */
export function acumular(nuevas, destino = DESTINO) {
  let previo = { eventos: [] };
  if (existsSync(destino)) {
    try { previo = JSON.parse(readFileSync(destino, 'utf8')); } catch {}
  }
  const porId = new Map((previo.eventos || []).map(e => [e.id, e]));
  let agregados = 0;
  for (const e of nuevas) {
    if (!e.id || porId.has(e.id)) continue;
    porId.set(e.id, e); agregados++;
  }
  const eventos = [...porId.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const cuenta = {};
  for (const e of eventos) cuenta[e.tipo] = (cuenta[e.tipo] || 0) + 1;
  const fechas = eventos.map(e => e.fecha).filter(Boolean).sort();
  writeFileSync(destino, JSON.stringify({
    _doc: 'Eventos de combustible rescatados de los tramos crudos antes de su borrado. ' +
          'fuel_caida = bajada brusca de nivel (sospecha de robo). El litraje no viaja en el evento.',
    actualizado: new Date().toISOString(),
    cobertura: fechas.length ? { desde: fechas[0], hasta: fechas[fechas.length - 1] } : null,
    dias: [...new Set(fechas)].length,
    cuenta,
    eventos,
  }));
  return { agregados, total: eventos.length, cuenta };
}

/* ------------------------------ CLI ------------------------------ */
const esCLI = process.argv[1] && process.argv[1].endsWith('extraer_combustible.mjs');
if (esCLI) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--tramo');
  const archivos = i >= 0 ? [args[i + 1]]
    : (existsSync(TRAMOS) ? readdirSync(TRAMOS).filter(f => f.endsWith('.json')).map(f => join(TRAMOS, f)) : []);
  if (!archivos.length) { console.log('no hay tramos en disco — nada que extraer'); process.exit(0); }

  let todas = [];
  for (const f of archivos) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const filas = extraerDeEventos(j.events);
      todas = todas.concat(filas);
      console.log(`  ${basename(f)} → ${filas.length} eventos de combustible`);
    } catch (e) { console.warn(`  ${basename(f)} ilegible: ${e.message}`); }
  }
  const r = acumular(todas);
  console.log(`\n✓ ${r.agregados} nuevos · ${r.total} en total → datos/historico/combustible.json`);
  console.log('  ' + Object.entries(r.cuenta).map(([k, v]) => k + '=' + v).join(' · '));
}
