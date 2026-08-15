#!/usr/bin/env node
// backfill.mjs — Histórico incremental semana a semana (ISO) desde la API REST Traffilog.
//
// Trae UNA semana, la FUSIONA en data.json (merge por fecha+operador+unidad, nunca reemplazo
// total), recalcula scores/agregados y escribe progreso. Repite. Si se interrumpe, al volver a
// correr continúa donde quedó (lee connector/.backfill-progress.json).
//
// Uso:
//   node connector/backfill.mjs                                  # 2026-01-01 → hoy, reanudando
//   node connector/backfill.mjs --from 2026-01-01 --to 2026-12-31
//   node connector/backfill.mjs --from 2026-07-13 --to 2026-07-19 --force   # re-descarga esa semana
//   node connector/backfill.mjs --weeks 2026-W29,2026-W30 --force
//
// Flags:
//   --from/--to YYYY-MM-DD   rango (default 2026-01-01 → hoy)
//   --weeks W1,W2            solo esas semanas ISO (dentro del rango)
//   --force                  ignora el progreso y re-descarga las semanas del rango
//   --conc N                 concurrencia de llamadas (default 12)
//   --out ruta               snapshot destino (default ../data.json)
//   --progress ruta          archivo de progreso (default ./.backfill-progress.json)
//   --reverse                de la semana más reciente hacia atrás
//   --relogin N              minutos de vida de la sesión antes de re-loguear (default 20)
//   --grupos "A,B"           solo unidades de esos grupos de la API (subconjunto → merge por unión)
//   --placas 1,2,3           solo esas placas (subconjunto → merge por unión)
//   --dry                    calcula el plan de semanas y sale sin llamar a la API
//
// Credenciales: connector/.env (TRAFFILOG_USER / TRAFFILOG_PASS). NUNCA se imprimen.
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  openSession, fetchRangeRegs, buildSnapshot, safetyScore,
  indexRegistros, mergeRegistros, mergeRegistrosPorFecha, isoWeeksBetween, ymd,
} from '../netlify/functions/lib/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---------- env ----------
const env = { ...process.env };
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch {}
if (!env.TRAFFILOG_USER || !env.TRAFFILOG_PASS) {
  console.error('faltan TRAFFILOG_USER/PASS en connector/.env');
  process.exit(1);
}

// ---------- autotest de la fórmula (intocable) ----------
{
  const t = safetyScore({ FrMed: 1, GirMed: 2, GirBajo: 8 }, 21 + 11 / 60);
  if (t.puntos !== 115 || Math.abs(t.x100h - 542.8796) > 0.01 || t.score !== 93)
    throw new Error('autotest de fórmula FALLÓ: ' + JSON.stringify(t));
}

// ---------- args ----------
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);

const FROM = arg('from', '2026-01-01');
const TO = arg('to', ymd(new Date()));
const OUT = arg('out', join(here, '..', 'data.json'));
const PROGRESS = arg('progress', join(here, '.backfill-progress.json'));
const CONC = Number(arg('conc', 12));
const FORCE = flag('force');
const DRY = flag('dry');
const REVERSE = flag('reverse');
const RELOGIN_MIN = Number(arg('relogin', 20));
const SOLO = (arg('weeks', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const GRUPOS = (arg('grupos', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const PLACAS = (arg('placas', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SUBSET = GRUPOS.length > 0 || PLACAS.length > 0;   // subconjunto de flota → merge por UNIÓN

const HOY = ymd(new Date());
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(`[${ts()}]`, ...m);

// ---------- escritura atómica ----------
function writeJsonAtomic(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameSync(tmp, path);
}

// ---------- estado previo ----------
let snapPrev = null;
try { snapPrev = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
let indice = indexRegistros(snapPrev?.registros || []);   // { llave: registro } — el histórico acumulado
let fleet = snapPrev?.unidades || [];
let roster = snapPrev?.drivers || [];
log(`histórico previo: ${Object.keys(indice).length} registros` + (snapPrev ? ` (${snapPrev.from} → ${snapPrev.to})` : ' (data.json inexistente)'));

let prog = { semanas_ok: [], semanas_error: [] };
try { prog = { ...prog, ...JSON.parse(readFileSync(PROGRESS, 'utf8')) }; } catch {}
const hechas = new Set(FORCE ? [] : prog.semanas_ok || []);

// ---------- plan de semanas ----------
let semanas = isoWeeksBetween(FROM, TO);
if (SOLO.length) semanas = semanas.filter(w => SOLO.includes(w.semana));
// una semana solo se da por terminada si está COMPLETA y ya cerró (las semanas en curso se refrescan siempre)
const cerrada = (w) => w.completa && w.to < HOY;
const pendientes = semanas.filter(w => !(hechas.has(w.semana) && cerrada(w)));
if (REVERSE) pendientes.reverse();

log(`rango ${FROM} → ${TO} · ${semanas.length} semanas ISO · ${pendientes.length} pendientes` +
    (FORCE ? ' (--force)' : '') + (SOLO.length ? ` · filtro ${SOLO.join(',')}` : ''));

function guardarProgreso(estado, extra = {}) {
  const ok = [...new Set(prog.semanas_ok || [])].sort();
  writeJsonAtomic(PROGRESS, {
    actualizado: new Date().toISOString(),
    estado,
    rango: { from: FROM, to: TO },
    ultima_semana_ok: ok.length ? ok[ok.length - 1] : null,
    ultima_semana_procesada: prog.ultima_semana_procesada || null,
    semanas_ok: ok,
    semanas_pendientes: pendientes.filter(w => !hechas.has(w.semana)).map(w => w.semana),
    semanas_error: prog.semanas_error || [],
    registros: Object.keys(indice).length,
    salida: OUT,
    ...extra,
  });
}

if (DRY) {
  log('plan (--dry):');
  for (const w of pendientes) log(`  ${w.semana}  ${w.from} → ${w.to}${w.completa ? '' : ' (parcial)'}`);
  guardarProgreso('plan');
  process.exit(0);
}
if (!pendientes.length) { log('nada pendiente — histórico al día'); guardarProgreso('completo'); process.exit(0); }

// respaldo único antes de tocar data.json
if (existsSync(OUT) && !existsSync(OUT + '.prebackfill.bak')) {
  copyFileSync(OUT, OUT + '.prebackfill.bak');
  log(`respaldo → ${OUT}.prebackfill.bak`);
}

// ---------- sesión (se reusa entre semanas, se renueva por TTL) ----------
let ses = null, sesT = 0;
async function sesion(forzar = false) {
  if (!forzar && ses && Date.now() - sesT < RELOGIN_MIN * 60e3) return ses;
  ses = await openSession({ user: env.TRAFFILOG_USER, pass: env.TRAFFILOG_PASS, url: env.TRAFFILOG_REST_URL, log: (m) => log('  ' + m) });
  sesT = Date.now();
  // los catálogos también se acumulan (una corrida por subconjunto no debe vaciar la flota previa)
  fleet = unirPor(fleet, ses.fleet, v => v.vehicle_id || v.placa);
  roster = unirPor(roster, ses.roster, d => d.driver_id || d.conductor);
  return ses;
}
function unirPor(viejos, nuevos, key) {
  const m = new Map((viejos || []).map(x => [key(x), x]));
  for (const x of nuevos || []) m.set(key(x), x);
  return [...m.values()];
}
/** Subconjunto de flota pedido por --grupos/--placas (vacío = flota completa). */
function filtrarFlota(f) {
  if (!SUBSET) return f;
  const sel = f.filter(v =>
    (GRUPOS.length && GRUPOS.includes(String(v.grupo || '').toUpperCase())) ||
    (PLACAS.length && PLACAS.includes(String(v.placa))));
  log(`  subconjunto de flota: ${sel.length}/${f.length} unidades` +
      (GRUPOS.length ? ` · grupos ${GRUPOS.join('|')}` : '') + (PLACAS.length ? ` · placas ${PLACAS.join('|')}` : ''));
  return sel;
}

let interrumpido = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { interrumpido = true; log(`⚠︎ ${sig} — cerrando tras la semana en curso`); });

// ---------- bucle semana a semana ----------
const t0 = Date.now();
for (const [i, w] of pendientes.entries()) {
  if (interrumpido) break;
  const tw = Date.now();
  log(`── ${w.semana} (${i + 1}/${pendientes.length})  ${w.from} → ${w.to}${w.completa ? '' : ' · parcial'}`);
  let res;
  const traer = async (s) => fetchRangeRegs({
    tok: s.tok, fleet: filtrarFlota(s.fleet), roster: s.roster,
    from: w.from, to: w.to, concurrency: CONC, opts: s.opts, log: (m) => log('  ' + m),
  });
  try {
    res = await traer(await sesion());
  } catch (e) {
    log(`  ✗ ${w.semana}: ${e.message} — reintento con sesión nueva`);
    try {
      res = await traer(await sesion(true));
    } catch (e2) {
      log(`  ✗✗ ${w.semana} falló: ${e2.message}`);
      prog.semanas_error = [...(prog.semanas_error || []).filter(x => x.semana !== w.semana), { semana: w.semana, error: e2.message, cuando: new Date().toISOString() }];
      guardarProgreso('corriendo');
      continue;
    }
  }

  // --- MERGE por (fecha, operador, unidad). Con la flota COMPLETA los días recalculados se
  //     reemplazan (limpia registros fantasma); con subconjunto de flota se fusiona por UNIÓN
  //     para no borrar las unidades que no se pidieron. Nunca hay reemplazo total. ---
  const { merged, stats } = SUBSET
    ? { merged: mergeRegistros(indice, res.regs), stats: { antes: Object.keys(indice).length, despues: 0, nuevas: 0, pisadas: 0, fechas_conservadas: [] } }
    : mergeRegistrosPorFecha(indice, res.regs, w.dias);
  if (SUBSET) {
    for (const k of res.regs.keys()) (k in indice ? stats.pisadas++ : stats.nuevas++);
    stats.despues = Object.keys(merged).length;
  }
  indice = merged;
  log(`  merge${SUBSET ? ' (unión, subconjunto de flota)' : ''}: ${stats.antes} → ${stats.despues} registros ` +
      `(+${stats.nuevas} nuevos, ${stats.pisadas} actualizados)` +
      (stats.fechas_conservadas?.length ? ` · sin datos nuevos, conservados: ${stats.fechas_conservadas.join(',')}` : ''));

  // --- RECALCULO de scores/agregados sobre TODO el histórico acumulado ---
  const snapshot = buildSnapshot(indice, { fleet, driverRoster: roster, source: 'traffilog:rest:backfill' });
  writeJsonAtomic(OUT, snapshot);

  prog.ultima_semana_procesada = w.semana;
  if (cerrada(w)) { prog.semanas_ok = [...new Set([...(prog.semanas_ok || []), w.semana])]; hechas.add(w.semana); }
  prog.semanas_error = (prog.semanas_error || []).filter(x => x.semana !== w.semana);
  guardarProgreso('corriendo', { ultimo_merge: stats });

  const ab = snapshot.scores.por_operador.find(s => /ABARCA/i.test(s.conductor));
  log(`  ✓ ${w.semana} en ${((Date.now() - tw) / 1000).toFixed(0)}s · snapshot ${snapshot.registros.length} reg · ` +
      `${snapshot.semanas.length} semanas (${snapshot.from} → ${snapshot.to})` +
      (ab ? ` · ABARCA ${ab.score} (${ab.puntos} pts / ${ab.x100h?.toFixed(2)} x100h)` : ''));
}

guardarProgreso(interrumpido ? 'interrumpido' : (pendientes.every(w => hechas.has(w.semana)) ? 'completo' : 'parcial'));
log(`fin en ${((Date.now() - t0) / 60000).toFixed(1)} min · ${Object.keys(indice).length} registros en ${OUT}`);
