// archivo_historico.mjs — Descarga el histórico de Traffilog y lo guarda LOCAL, una semana por archivo.
//
// Arquitectura (decidida con el cliente 2026-07-23):
//   · El histórico se baja UNA vez y vive en datos/historico/<YYYY-Www>.json (JSON local, versionado).
//   · El portal lee el archivo local para todo lo pasado — no vuelve a pegarle a la API.
//   · Solo la SEMANA EN CURSO se consulta en vivo.
//
// Es re-entrante: cada semana ya descargada se salta (salvo --force). Si se interrumpe, se relanza y sigue.
// Va de la semana más RECIENTE hacia atrás, para que lo útil aterrice primero.
//
// Uso:
//   node connector/archivo_historico.mjs                      # 2026-01-01 → hoy
//   node connector/archivo_historico.mjs --from 2026-05-01    # desde una fecha
//   node connector/archivo_historico.mjs --semana 2026-W30 --force
//
// Credenciales: connector/.env (TRAFFILOG_USER/TRAFFILOG_PASS). Nunca se imprimen.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../netlify/functions/lib/core.mjs';
import { empacar } from '../netlify/functions/lib/codec.mjs';
import { extraerDeEventos, acumular } from './extraer_combustible.mjs';
import { agregarGeo, acumularGeo } from './extraer_geo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
mkdirSync(DIR, { recursive: true });

// ---------- entorno ----------
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

// mapa grupo→UDN (fuente de verdad editable)
try {
  const map = JSON.parse(readFileSync(join(raiz, 'docs', 'udn-map.json'), 'utf8'));
  core.setUdnMap(map);
} catch { console.warn('aviso: docs/udn-map.json no disponible; se usan solo las pistas del nombre'); }

// ---------- argumentos ----------
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const FORCE = flag('force');
const CONC = Number(arg('concurrency', 10));
const hoy = core.ymd(new Date());
const from = arg('from', '2026-01-01');
const to = arg('to', hoy);
const soloSemana = arg('semana', null);

// ---------- autotest de la fórmula antes de tocar la red ----------
{
  const t = core.safetyScore({ FrMed: 1, GirMed: 2, GirBajo: 8 }, 21 + 11 / 60);
  if (t.puntos !== 115 || t.score !== 93) throw new Error('autotest de fórmula FALLÓ: ' + JSON.stringify(t));
  console.log('✓ autotest fórmula (ABARCA 115 pts → 93)');
}

// ---------- semanas a procesar ----------
let semanas = core.isoWeeksBetween(from, to);
if (soloSemana) semanas = semanas.filter(s => s.semana === soloSemana);
semanas.reverse();  // más reciente primero

const semanaActual = core.isoWeek(hoy);
/* Sólo los semanales cuentan. En el mismo directorio viven ahora los sidecars
   (<semana>.ralenti.json, combustible.json, indice.json) y con un `.endsWith('.json')`
   se colaban al conteo: decía "10 ya en local" habiendo 4 semanas. El filtro real
   nunca falló (compara contra el nombre de semana), pero el número engañaba. */
const yaBajadas = new Set(
  readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).map(f => f.replace('.json', '')),
);
/* La caminadora estaba en re-bajar la semana en curso EN CADA relanzamiento
 * (~1 h quemada por reinicio). Criterio final: una semana se baja SOLO si su
 * archivo no existe — incluida la actual (parcial). La actual se refresca
 * explícitamente con --semana <W> --force cuando se quiera, no de oficio. */
const pendientes = semanas.filter(s => FORCE || !yaBajadas.has(s.semana));

console.log(`rango ${from} → ${to} · ${semanas.length} semanas · ${yaBajadas.size} ya en local · ${pendientes.length} por bajar`);
if (!pendientes.length) { console.log('nada que hacer'); process.exit(0); }

// ---------- sesión + flota (una sola vez) ----------
const t0 = Date.now();
const { tok, fleet, roster, opts } = await core.openSession({
  user: env.TRAFFILOG_USER, pass: env.TRAFFILOG_PASS,
  log: (m) => console.log('  ' + m),
});
console.log(`flota ${fleet.length} unidades · roster ${roster.length} choferes`);

// ---------- sesión con renovación ----------
// El token de Traffilog expira a los ~40 min y la API responde VACÍO en vez de dar error:
// una semana entera se guardaba en blanco sin avisar. Renovamos por tramo y validamos que
// la primera unidad del tramo devuelva algo antes de dar el tramo por bueno.
let tokVivo = tok, tokNacido = Date.now();
const TOKEN_TTL_MS = 20 * 60e3;
async function tokenFresco() {
  if (Date.now() - tokNacido < TOKEN_TTL_MS) return tokVivo;
  tokVivo = await core.login(env.TRAFFILOG_USER, env.TRAFFILOG_PASS);
  tokNacido = Date.now();
  return tokVivo;
}

/** Descarga un rango partiéndolo en tramos de `dias`, renovando el token en cada uno.
 *  CHECKPOINT POR TRAMO: cada tramo se persiste en datos/historico/.tramos/ al terminar.
 *  Si el proceso muere a mitad de una semana, el relanzamiento reusa los tramos ya
 *  bajados y solo pide a la API lo que falta — se pierde como máximo un tramo (2 días). */
const TRAMOS_DIR = join(DIR, '.tramos');
mkdirSync(TRAMOS_DIR, { recursive: true });
async function bajarRango(from, to, dias = 2) {
  const out = [];
  for (let ini = from; ini <= to; ini = core.shiftYmd(ini, dias)) {
    const fin = core.shiftYmd(ini, dias - 1) > to ? to : core.shiftYmd(ini, dias - 1);
    const cachePath = join(TRAMOS_DIR, ini + '_' + fin + '.json');
    let r = null;
    // Piso de plausibilidad: con ~945 unidades activas, un tramo de 2 días trae
    // MILES de viajes. Uno con pocos cientos es un token que murió a MITAD del
    // barrido (algunas unidades respondieron antes de morir) — envenena la semana.
    // El tramo que toca HOY es parcial por naturaleza: sin piso y sin caché
    // (congelarlo dejaría la mañana fija todo el día).
    const tocaHoy = fin >= hoy;
    const MIN_TRIPS_TRAMO = tocaHoy ? 1 : 500;
    try {
      const c = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (c && Array.isArray(c.regs) && (c.trips?.length || 0) >= MIN_TRIPS_TRAMO) r = c;
      else if (c) { unlinkSync(cachePath); console.log(`    tramo ${ini}→${fin} en caché implausible (${c.trips?.length || 0} viajes) — purgado`); }
    } catch {}
    if (!r) {
      // Un tramo de 2 días SIN NINGÚN viaje en 945 unidades es implausible: casi
      // siempre es el token muerto (la API responde vacío sin error). Si sale
      // vacío, forzamos re-login y reintentamos UNA vez; si persiste, la semana
      // truena completa y el siguiente relanzamiento la reintenta. Así ya no se
      // consolidan semanas con días huecos (pasó con W28: solo traía el 12/jul).
      let raw;
      for (let intento = 0; intento < 2; intento++) {
        const t = await tokenFresco();
        raw = await core.fetchRangeRegs({
          tok: t, fleet, roster, from: ini, to: fin,
          concurrency: CONC, opts, log: () => {},
        });
        if (raw.trips.length) break;
        tokNacido = 0;                       // fuerza login fresco en el reintento
        console.log(`    tramo ${ini}→${fin} vacío — relogin y reintento`);
      }
      if (raw.trips.length < MIN_TRIPS_TRAMO) throw new Error(`tramo ${ini}→${fin} implausible (${raw.trips.length} viajes) tras reintento (token/API)`);
      // fetchRangeRegs devuelve regs como Map → normalizamos a arreglo AQUÍ:
      // un Map ni se aplana con flatMap ni sobrevive a JSON.stringify (queda {}).
      r = { regs: [...raw.regs.values()], trips: raw.trips, events: raw.events };
      if (!tocaHoy && r.trips.length >= MIN_TRIPS_TRAMO) {
        const tmp = cachePath + '.tmp';                            // escritura atómica
        writeFileSync(tmp, JSON.stringify(r));
        renameSync(tmp, cachePath);
      }
    }
    out.push(r);
  }
  return {
    regs: out.flatMap(r => r.regs), trips: out.flatMap(r => r.trips), events: out.flatMap(r => r.events),
  };
}
/** Limpia los tramos de una semana ya consolidada en su archivo semanal. */
function limpiarTramos(from, to) {
  for (const f of readdirSync(TRAMOS_DIR)) {
    const ini = f.slice(0, 10);
    if (ini >= from && ini <= to) { try { unlinkSync(join(TRAMOS_DIR, f)); } catch {} }
  }
}

// ---------- descarga semana por semana ----------
let ok = 0, fallidas = [];
for (const [i, sem] of pendientes.entries()) {
  const ini = Date.now();
  const etq = `[${i + 1}/${pendientes.length}] ${sem.semana} (${sem.from}→${sem.to})`;
  try {
    const { regs, trips, events } = await bajarRango(sem.from, sem.to);
    // Una semana en blanco casi siempre es token muerto, no ausencia real de operación:
    // no la damos por buena ni la escribimos, para que el relanzamiento la reintente.
    if (!trips.length) throw new Error('sin viajes (probable sesión expirada) — se reintentará');
    const snapshot = core.buildSnapshot(regs, { fleet, driverRoster: roster, from: sem.from, to: sem.to });
    snapshot.semana = sem.semana;
    snapshot.parcial = sem.semana === semanaActual;   // la semana en curso aún no cierra
    snapshot.generado = new Date().toISOString();

    // se guarda en formato compacto v3 (~16x más chico, sin pérdida): ver lib/codec.mjs
    const compacto = empacar(snapshot);
    writeFileSync(join(DIR, sem.semana + '.json'), JSON.stringify(compacto));
    const seg = ((Date.now() - ini) / 1000).toFixed(0);
    const mb = (JSON.stringify(compacto).length / 1e6).toFixed(2);
    console.log(`${etq} ✓ ${snapshot.registros.length} registros · ${trips.length} viajes · ${events.length} eventos · ${mb} MB · ${seg}s`);
    // Los eventos INDIVIDUALES sólo viven en los tramos; el semanal v3 guarda
    // conteos. Antes de borrarlos rescatamos los de combustible: una caída de
    // nivel sin hora ni GPS no sirve para investigar un robo.
    try {
      const r = acumular(extraerDeEventos(events));
      if (r.agregados) console.log(`   combustible: +${r.agregados} eventos (${r.cuenta.fuel_caida || 0} caídas acumuladas)`);
    } catch (e) { console.warn('   aviso: no se pudo extraer combustible — ' + e.message); }
    // Misma razón: la POSICIÓN sólo vive en los tramos. Se guarda la rejilla
    // (no los ~200k puntos sueltos) para poder distinguir el punto negro de la
    // RUTA del mal hábito del OPERADOR.
    try {
      const g = acumularGeo(agregarGeo(events), sem.semana);
      if (!g.saltado) console.log(`   geo: ${g.total} celdas · ${g.eventos.toLocaleString('es-MX')} eventos acumulados`);
    } catch (e) { console.warn('   aviso: no se pudo agregar geo — ' + e.message); }
    limpiarTramos(sem.from, sem.to);   // semana consolidada → sus tramos ya no hacen falta
    ok++;
  } catch (e) {
    console.error(`${etq} ✗ ${e.message.slice(0, 160)}`);
    fallidas.push(sem.semana);
  }
  // índice actualizado tras CADA semana: el portal puede leer lo que ya cayó
  escribirIndice();
}

function escribirIndice() {
  const archivos = readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort();
  const semanas = archivos.map(f => {
    const s = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    return {
      semana: s.semana, archivo: 'datos/historico/' + f, formato: s.v || 1,
      from: s.from, to: s.to, parcial: !!s.parcial, generado: s.generado,
      registros: s.regs?.length ?? s.registros?.length ?? 0,
      operadores: s.meta?.operadores || 0, unidades: s.meta?.unidades || 0, eventos: s.meta?.eventos || 0,
      bytes: statSync(join(DIR, f)).size,
    };
  });
  writeFileSync(join(DIR, 'indice.json'), JSON.stringify({
    _doc: 'Índice del archivo histórico local. El portal lee estas semanas de disco; solo la semana en curso se consulta en vivo.',
    actualizado: new Date().toISOString(),
    semana_actual: semanaActual,
    cobertura: semanas.length ? { desde: semanas[0].from, hasta: semanas[semanas.length - 1].to } : null,
    semanas,
  }, null, 1));
}

const min = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\n✓ ${ok}/${pendientes.length} semanas en ${min} min → ${DIR}`);
if (fallidas.length) console.log(`✗ fallidas (relanza para reintentar): ${fallidas.join(', ')}`);
