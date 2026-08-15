// enriquecer_extendido.mjs — Añade RALENTÍ REAL, horas motor y odómetro al histórico ya bancado.
//
// Por qué existe
// -------------
// El pipeline original arma las horas con `get_vehicle_trips`, que sólo trae
// start_time/end_time: `horas` es tiempo BRUTO, con el ralentí dentro. Durante meses
// se asumió lo contrario ("horas netas = ralentí descontado"); no era cierto.
//
// `get_vehicle_trips_extended` (API v4.3, pág. 15 — ver docs/API-TRAFFILOG-v4.3.txt)
// sí trae `idle_time` y `engine_hours` por viaje, y admite VARIAS placas por llamada
// separadas por coma con rangos de hasta 30 días. Verificado el 2026-07-24:
// 10 placas × 5 días = 357 viajes en UNA llamada. El tope real es 10 (ver MAX_PLACAS).
//
// Diseño: SIDECAR, no migración
// -----------------------------
// No reescribe los archivos semanales v3 (son caros de rebajar: los eventos van
// una llamada por viaje). Escribe `datos/historico/<semana>.ralenti.json` con el
// agregado por operador×unidad×día — la MISMA llave que usa core.regKey(). El portal
// lo lee y lo fusiona. Es aditivo y reversible: borrar el sidecar deja todo como estaba.
//
// Uso:
//   node connector/enriquecer_extendido.mjs                 # todas las semanas en disco
//   node connector/enriquecer_extendido.mjs --semana 2026-W30 --force
//   node connector/enriquecer_extendido.mjs --lote 40 --pausa 5
//
// Política de uso de Traffilog (docs/API-TRAFFILOG-v4.3.txt, pág. 32): el token vive
// 24 h y hay que reusarlo, y los servicios no deben consumirse a más de 1 llamada
// cada 30 s. Por eso: UN login, pausa configurable entre llamadas, y lotes grandes
// de placas en vez de una llamada por unidad.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { desempacar } from '../netlify/functions/lib/codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');

const env = { ...process.env };
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch {}
if (!env.TRAFFILOG_USER || !env.TRAFFILOG_PASS) {
  console.error('faltan TRAFFILOG_USER/TRAFFILOG_PASS en connector/.env');
  process.exit(1);
}
const URL = env.TRAFFILOG_REST_URL || 'https://api.traffilog.mx/clients/json';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FORCE = args.includes('--force');
/* TOPE DURO: la API atiende como máximo 10 placas por llamada y las demás las
 * IGNORA EN SILENCIO — devuelve action_value=0, sin error ni aviso. Medido el
 * 2026-07-24: pedidas 5→5 ✓, 10→10 ✓, 15→10, 20→10, 30→10.
 * Con lote=40 la primera corrida trajo sólo 160 de 711 unidades (23% de los
 * viajes) y parecía correcta. No subir de 10 bajo ninguna circunstancia. */
const MAX_PLACAS = 10;
const LOTE = Math.min(Number(arg('lote', MAX_PLACAS)), MAX_PLACAS);
const PAUSA = Number(arg('pausa', 5));     // segundos entre llamadas
const soloSemana = arg('semana', null);

const dormir = (s) => new Promise(r => setTimeout(r, s * 1000));
const dec = (s) => { try { return decodeURIComponent(String(s ?? '')); } catch { return String(s ?? ''); } };
/** "HH:MM:SS" → horas decimales. La API lo manda URL-encoded ("01%3A46%3A00"). */
const hms = (v) => {
  const m = dec(v).match(/^(\d+):(\d+):(\d+)$/);
  return m ? (+m[1] + +m[2] / 60 + +m[3] / 3600) : 0;
};
/** La fecha del registro es la del INICIO del viaje, igual que core.fechaLocal(). */
const fechaDe = (t) => dec(t).slice(0, 10);

async function call(action, etiqueta) {
  for (let intento = 0; intento < 4; intento++) {
    try {
      const r = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => null);
      const p = j?.response?.properties;
      // action_value != 0 es un ERROR de la API que hoy el conector se traga como
      // "no hay datos". Aquí sí se distingue: un problema de permisos no puede
      // parecerse a una semana vacía.
      if (p && String(p.action_value ?? '0') !== '0') {
        throw new Error(`action_value=${p.action_value} ${dec(p.description || '')}`);
      }
      if (!p) throw new Error('respuesta sin properties (HTTP ' + r.status + ')');
      return p;
    } catch (e) {
      const espera = [0, 30, 90, 240][intento];
      if (intento === 3) throw new Error(`${etiqueta}: ${e.message}`);
      console.log(`    ${etiqueta} falló (${e.message.slice(0, 70)}) — reintento en ${espera}s`);
      await dormir(espera);
    }
  }
}

// ---------- sesión única (el token vive 24 h; NO relogueamos por llamada) ----------
const login = await call(
  { name: 'user_login', parameters: { login_name: env.TRAFFILOG_USER, password: encodeURIComponent(env.TRAFFILOG_PASS) } },
  'login',
);
const tok = login.session_token;
if (!tok) { console.error('login sin session_token'); process.exit(1); }
console.log('✓ sesión abierta (token reutilizado durante toda la corrida)');

// ---------- semanas a enriquecer ----------
let semanas = readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).map(f => f.replace('.json', '')).sort().reverse();
if (soloSemana) semanas = semanas.filter(s => s === soloSemana);

let llamadas = 0;
for (const semana of semanas) {
  const destino = join(DIR, semana + '.ralenti.json');
  if (existsSync(destino) && !FORCE) { console.log(`${semana} · ya enriquecida (--force para rehacer)`); continue; }

  const compacto = JSON.parse(readFileSync(join(DIR, semana + '.json'), 'utf8'));
  const regs = desempacar(compacto);
  const from = compacto.from, to = compacto.to;
  // Placas presentes esa semana: no tiene sentido pedir las 945 si sólo rodaron 700.
  const placas = [...new Set(regs.map(r => r.placa).filter(Boolean))];
  const lotes = [];
  for (let i = 0; i < placas.length; i += LOTE) lotes.push(placas.slice(i, i + LOTE));

  console.log(`\n${semana} (${from}→${to}) · ${placas.length} placas · ${lotes.length} llamadas de ${LOTE}`);
  const sinDatos = [];
  const acum = new Map();   // regKey → { ralenti, motor, bruto, viajes, odometro }
  let viajes = 0;
  const t0 = Date.now();

  for (const [i, lote] of lotes.entries()) {
    if (llamadas++) await dormir(PAUSA);
    const p = await call({
      name: 'get_vehicle_trips_extended',
      parameters: [{ vehicle_id: '', license_number: lote.join(','), from_date: from, to_date: to, driver_id: '', version: '' }],
      session_token: tok,
    }, `${semana} lote ${i + 1}/${lotes.length}`);
    const filas = p.data || [];
    // La API no avisa si ignoró placas: lo comprobamos nosotros contra lo pedido.
    const respondieron = new Set(filas.map(t => dec(t.license_number)));
    const mudas = lote.filter(pl => !respondieron.has(pl));
    if (respondieron.size > MAX_PLACAS) throw new Error('la API respondió más placas que el tope conocido — revisar MAX_PLACAS');
    if (mudas.length) sinDatos.push(...mudas);
    viajes += filas.length;
    for (const t of filas) {
      const fecha = fechaDe(t.start_time);
      if (!fecha || fecha < from || fecha > to) continue;
      // MISMA llave que core.regKey(): fecha|driver_id|vehicle_id
      const k = fecha + '|' + String(t.driver_id || '') + '|' + String(t.vehicle_id || '');
      let a = acum.get(k);
      if (!a) acum.set(k, a = { ralenti: 0, motor: 0, bruto: 0, viajes: 0, odometro: 0 });
      a.ralenti += hms(t.idle_time);
      a.motor += Number(dec(t.engine_hours)) || 0;
      a.bruto += hms(t.drive_duration);
      a.viajes += 1;
      a.odometro = Math.max(a.odometro, Number(dec(t.total_mileage)) || 0);
    }
    process.stdout.write(`\r  lote ${i + 1}/${lotes.length} · ${viajes} viajes`);
  }

  const filas = [...acum.entries()].map(([k, a]) => [
    k, +a.ralenti.toFixed(4), +a.motor.toFixed(4), +a.bruto.toFixed(4), a.viajes, +a.odometro.toFixed(1),
  ]);
  const totRal = filas.reduce((s, f) => s + f[1], 0);
  const totBruto = filas.reduce((s, f) => s + f[3], 0);
  writeFileSync(destino, JSON.stringify({
    _doc: 'Sidecar de ralentí/horas motor por operador×unidad×día. Llave = fecha|driver_id|vehicle_id (core.regKey). ' +
          'Origen: get_vehicle_trips_extended. Columnas: [llave, ralenti_h, motor_h, bruto_h, viajes, odometro_km].',
    semana, from, to, generado: new Date().toISOString(),
    fuente: 'get_vehicle_trips_extended',
    placas_sin_viajes: sinDatos.length,
    totales: {
      viajes, registros: filas.length,
      ralenti_h: +totRal.toFixed(1), bruto_h: +totBruto.toFixed(1),
      neto_h: +(totBruto - totRal).toFixed(1),
      pct_ralenti: totBruto ? +(totRal / totBruto * 100).toFixed(1) : 0,
    },
    filas,
  }));
  if (sinDatos.length) console.log(`  aviso: ${sinDatos.length}/${placas.length} placas sin viajes en el rango (normal si no rodaron)`);
  const seg = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n  ✓ ${viajes} viajes · ralentí ${totRal.toFixed(0)} h de ${totBruto.toFixed(0)} h brutas ` +
              `(${totBruto ? (totRal / totBruto * 100).toFixed(1) : 0}%) · ${seg}s → ${semana}.ralenti.json`);
}
console.log(`\n✓ listo · ${llamadas} llamadas a la API en total`);
