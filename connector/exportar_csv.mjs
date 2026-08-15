// exportar_csv.mjs — Vuelca TODO el archivo histórico a CSVs legibles (Excel)
// en datos/export/. Vista "portal": sidecars de ralentí y re-atribución
// fusionados (los eventos inferidos se marcan en la columna ev_inferidos).
//
//   node connector/exportar_csv.mjs
//
// Salidas:
//   detalle_operador_unidad_dia.csv  — grano completo (todas las semanas)
//   acumulado_operador.csv           — total del año por operador + estado + score
//   acumulado_unidad.csv             — total del año por unidad
//   acumulado_semana.csv             — totales por semana
//   combustible_eventos.csv          — eventos de combustible con GPS
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { desempacar } from '../netlify/functions/lib/codec.mjs';
import * as core from '../netlify/functions/lib/core.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(raiz, 'datos', 'historico');
const OUT = join(raiz, 'datos', 'export');
mkdirSync(OUT, { recursive: true });
try { core.setUdnMap(JSON.parse(readFileSync(join(raiz, 'docs', 'udn-map.json'), 'utf8'))); } catch {}

const LLAVES = ['AcAlto','AcMed','AcBajo','FrAlto','FrMed','FrBajo','GirAlto','GirMed','GirBajo','VelAlto','VelMed','VelBajo'];
const semanas = readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort();

// claves de `extendido` presentes en todo el archivo (columnas dinámicas pero estables)
const extKeys = new Set();
const carga = [];
for (const f of semanas) {
  const sem = f.slice(0, 8);
  const registros = desempacar(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
  // re-atribución (idéntica a aplicacion/archivo.js)
  try {
    const rj = JSON.parse(readFileSync(join(DIR, sem + '.reatrib.json'), 'utf8'));
    if (rj && Array.isArray(rj.filas)) {
      const porKey = new Map(), sinopUD = new Map();
      for (const r of registros) {
        porKey.set(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''), r);
        if (!r.driver_id || /^SIN OPERADOR/.test(r.conductor || '')) sinopUD.set(r.fecha + '|' + r.vehicle_id, r);
      }
      for (const [k, ev, ext] of rj.filas) {
        const dest = porKey.get(k); if (!dest) continue;
        const [fecha, , veh] = k.split('|');
        const sinop = sinopUD.get(fecha + '|' + veh);
        for (const n in ev) { dest.eventos[n] = (dest.eventos[n] || 0) + ev[n]; if (sinop && sinop.eventos[n]) sinop.eventos[n] = Math.max(0, sinop.eventos[n] - ev[n]); }
        for (const n in ext) { dest.extendido[n] = (dest.extendido[n] || 0) + ext[n]; if (sinop && sinop.extendido[n]) sinop.extendido[n] = Math.max(0, sinop.extendido[n] - ext[n]); }
        dest.evInferidos = true;
      }
    }
  } catch {}
  // ralentí
  let idle = new Map();
  try {
    const sc = JSON.parse(readFileSync(join(DIR, sem + '.ralenti.json'), 'utf8'));
    if (sc && Array.isArray(sc.filas)) idle = new Map(sc.filas.map(x => [x[0], { ral: x[1], motor: x[2], odo: x[5] }]));
  } catch {}
  for (const r of registros) {
    const s = core.splitGrupo(r.grupo || '');
    r.udn = s.udn; r.cliente = s.cliente; r.semana = sem;
    const e = idle.get(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''));
    if (e) { r.ralenti = e.ral; r.horasMotor = e.motor; r.odometro = e.odo; r.horasNetas = Math.max(0, (r.horas || 0) - e.ral); }
    for (const k in (r.extendido || {})) extKeys.add(k);
  }
  carga.push(...registros);
  console.log(sem + ': ' + registros.length + ' registros');
}
const EXT = [...extKeys].sort();

const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows, cols) => cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n') + '\n';
const n2 = (x) => x == null ? '' : +(+x).toFixed(2);

/* ---------- 1. detalle grano completo ---------- */
{
  const cols = ['fecha','semana','udn','cliente','grupo','conductor','driver_id','placa','vehicle_id',
    'viajes','horas_brutas','ralenti_h','horas_netas','horas_motor','km','odometro','ev_inferidos',
    ...LLAVES, 'eventos_seguridad_total', ...EXT.map(k => 'ext_' + k)];
  const rows = carga.map(r => {
    const o = {
      fecha: r.fecha, semana: r.semana, udn: r.udn, cliente: r.cliente, grupo: r.grupo,
      conductor: r.conductor, driver_id: r.driver_id || '', placa: r.placa || '', vehicle_id: r.vehicle_id || '',
      viajes: r.viajes || 0, horas_brutas: n2(r.horas), ralenti_h: n2(r.ralenti), horas_netas: n2(r.horasNetas),
      horas_motor: n2(r.horasMotor), km: n2(r.km), odometro: n2(r.odometro), ev_inferidos: r.evInferidos ? 1 : '',
    };
    let tot = 0;
    for (const k of LLAVES) { const v = (r.eventos && r.eventos[k]) || 0; o[k] = v || ''; tot += v; }
    o.eventos_seguridad_total = tot || '';
    for (const k of EXT) o['ext_' + k] = (r.extendido && r.extendido[k]) || '';
    return o;
  });
  writeFileSync(join(OUT, 'detalle_operador_unidad_dia.csv'), csv(rows, cols));
  console.log('detalle_operador_unidad_dia.csv: ' + rows.length + ' filas');
}

/* ---------- 2. acumulado por operador ---------- */
{
  const censo = (() => { try { return JSON.parse(readFileSync(join(DIR, 'censo.json'), 'utf8')); } catch { return null; } })();
  const estadoDe = new Map((censo && censo.operadores || []).map(o => [o.nombre, o]));
  const por = new Map();
  for (const r of carga) {
    if (!r.driver_id || /^SIN OPERADOR/.test(r.conductor || '')) continue;
    let a = por.get(r.conductor);
    if (!a) por.set(r.conductor, a = { conductor: r.conductor, udn: r.udn, dias: new Set(), semanas: new Set(),
      unidades: new Set(), viajes: 0, horas: 0, netas: 0, ral: 0, km: 0, ev: {}, ext: {} });
    a.dias.add(r.fecha); a.semanas.add(r.semana); if (r.placa) a.unidades.add(r.placa);
    a.viajes += r.viajes || 0; a.horas += r.horas || 0; a.km += r.km || 0;
    if (r.ralenti != null) { a.ral += r.ralenti; a.netas += r.horasNetas || 0; } else a.netas += r.horas || 0;
    for (const k of LLAVES) a.ev[k] = (a.ev[k] || 0) + ((r.eventos && r.eventos[k]) || 0);
    for (const k of EXT) a.ext[k] = (a.ext[k] || 0) + ((r.extendido && r.extendido[k]) || 0);
  }
  const cols = ['conductor','udn','estado_actividad','ultima_semana','dias_con_actividad','semanas','unidades',
    'viajes','horas_brutas','ralenti_h','horas_netas','km','score_seguridad', ...LLAVES, 'eventos_seguridad_total', ...EXT.map(k => 'ext_' + k)];
  const rows = [...por.values()].map(a => {
    const e = estadoDe.get(a.conductor) || {};
    const sc = core.safetyScore(a.ev, a.horas);
    const o = { conductor: a.conductor, udn: a.udn, estado_actividad: e.estado || '', ultima_semana: e.ultima_semana || '',
      dias_con_actividad: a.dias.size, semanas: a.semanas.size, unidades: a.unidades.size, viajes: a.viajes,
      horas_brutas: n2(a.horas), ralenti_h: n2(a.ral), horas_netas: n2(a.netas), km: n2(a.km), score_seguridad: sc.score ?? '' };
    let tot = 0; for (const k of LLAVES) { o[k] = a.ev[k] || ''; tot += a.ev[k] || 0; }
    o.eventos_seguridad_total = tot || '';
    for (const k of EXT) o['ext_' + k] = a.ext[k] || '';
    return o;
  }).sort((x, y) => x.conductor.localeCompare(y.conductor, 'es'));
  writeFileSync(join(OUT, 'acumulado_operador.csv'), csv(rows, cols));
  console.log('acumulado_operador.csv: ' + rows.length + ' filas');
}

/* ---------- 3. acumulado por unidad ---------- */
{
  const por = new Map();
  for (const r of carga) {
    const k = r.placa || r.vehicle_id; if (!k) continue;
    let a = por.get(k);
    if (!a) por.set(k, a = { placa: r.placa || '', vehicle_id: r.vehicle_id || '', udn: r.udn, dias: new Set(),
      operadores: new Set(), viajes: 0, horas: 0, ral: 0, km: 0, evTot: 0, sinId: 0 });
    a.dias.add(r.fecha);
    if (r.driver_id && !/^SIN OPERADOR/.test(r.conductor || '')) a.operadores.add(r.conductor); else a.sinId += r.viajes || 0;
    a.viajes += r.viajes || 0; a.horas += r.horas || 0; a.km += r.km || 0;
    if (r.ralenti != null) a.ral += r.ralenti;
    for (const kk of LLAVES) a.evTot += (r.eventos && r.eventos[kk]) || 0;
  }
  const cols = ['placa','vehicle_id','udn','dias_con_actividad','operadores_distintos','viajes','viajes_sin_identificar','horas_brutas','ralenti_h','km','eventos_seguridad_total'];
  const rows = [...por.values()].map(a => ({ placa: a.placa, vehicle_id: a.vehicle_id, udn: a.udn,
    dias_con_actividad: a.dias.size, operadores_distintos: a.operadores.size, viajes: a.viajes,
    viajes_sin_identificar: a.sinId || '', horas_brutas: n2(a.horas), ralenti_h: n2(a.ral), km: n2(a.km),
    eventos_seguridad_total: a.evTot || '' })).sort((x, y) => String(x.placa).localeCompare(String(y.placa), 'es', { numeric: true }));
  writeFileSync(join(OUT, 'acumulado_unidad.csv'), csv(rows, cols));
  console.log('acumulado_unidad.csv: ' + rows.length + ' filas');
}

/* ---------- 4. acumulado por semana ---------- */
{
  const por = new Map();
  for (const r of carga) {
    let a = por.get(r.semana);
    if (!a) por.set(r.semana, a = { semana: r.semana, desde: r.fecha, hasta: r.fecha, registros: 0, operadores: new Set(),
      unidades: new Set(), viajes: 0, horas: 0, ral: 0, km: 0, evTot: 0 });
    a.registros++; if (r.fecha < a.desde) a.desde = r.fecha; if (r.fecha > a.hasta) a.hasta = r.fecha;
    if (r.driver_id && !/^SIN OPERADOR/.test(r.conductor || '')) a.operadores.add(r.conductor);
    if (r.placa) a.unidades.add(r.placa);
    a.viajes += r.viajes || 0; a.horas += r.horas || 0; a.km += r.km || 0;
    if (r.ralenti != null) a.ral += r.ralenti;
    for (const k of LLAVES) a.evTot += (r.eventos && r.eventos[k]) || 0;
  }
  const cols = ['semana','desde','hasta','registros','operadores','unidades','viajes','horas_brutas','ralenti_h','km','eventos_seguridad_total'];
  const rows = [...por.values()].map(a => ({ semana: a.semana, desde: a.desde, hasta: a.hasta, registros: a.registros,
    operadores: a.operadores.size, unidades: a.unidades.size, viajes: a.viajes, horas_brutas: n2(a.horas),
    ralenti_h: n2(a.ral), km: n2(a.km), eventos_seguridad_total: a.evTot })).sort((x, y) => x.semana.localeCompare(y.semana));
  writeFileSync(join(OUT, 'acumulado_semana.csv'), csv(rows, cols));
  console.log('acumulado_semana.csv: ' + rows.length + ' filas');
}

/* ---------- 5. combustible ---------- */
{
  const cb = (() => { try { return JSON.parse(readFileSync(join(DIR, 'combustible.json'), 'utf8')); } catch { return null; } })();
  if (cb && cb.eventos) {
    const cols = ['fecha','time','tipo','placa','vehicle_id','conductor','driver_id','lat','lng','speed'];
    writeFileSync(join(OUT, 'combustible_eventos.csv'), csv(cb.eventos, cols));
    console.log('combustible_eventos.csv: ' + cb.eventos.length + ' filas');
  }
}
console.log('listo → ' + OUT);
