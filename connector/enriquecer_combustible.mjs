// enriquecer_combustible.mjs — Añade la MAGNITUD (Δ%) a las caídas de combustible.
//
// Por qué existe
// -------------
// El evento "New Version fuel Drop" dice CUÁNDO, DÓNDE y en QUÉ unidad cayó el
// nivel, pero no CUÁNTO (get_trip_events v2 no trae payload numérico). Sin el
// monto no se distingue una recalibración del 3% de un robo del 40%.
//
// La vía confirmada (2026-07-27, docs/API-TRAFFILOG-v4.3.txt pág. 23) es
// `api_get_vehicle_parameter_values`: la serie histórica de un parámetro en
// ventanas de HASTA 72 h. El nivel de tanque es el parámetro 28929 o 28932
// ("TFL Processed Fuel Level"; varía por instalación — se prueban ambos).
// OJO: el 2026-07-24 este endpoint devolvía 0 lecturas para todo (sin
// habilitar); si sigue así, el script marca el intento y NO truena.
//
// Qué hace
// --------
// Para cada fuel_caida de datos/historico/combustible.json que aún no tenga
// `delta_pct` ni intento fallido registrado (las más recientes primero, hasta
// --max llamadas): pide la serie de nivel alrededor del timestamp, localiza la
// bajada más pronunciada cercana al evento y guarda en el MISMO evento:
//   delta_pct      nivel antes − nivel después (positivo = bajó)
//   nivel_antes / nivel_despues / nivel_param / nivel_t / nivel_offset_h
//   nivel_medido   cuándo se enriqueció
//   nivel_sin_datos:true si la API no dio lecturas (para no reintentar a diario;
//                  --reintentar los vuelve a pedir)
//
// ZONA HORARIA: no está probado si el `time` del evento viene en UTC o en hora
// local (CDMX = UTC−6). Por eso la ventana pedida cubre ambos casos y la caída
// se busca cerca de t, t+6h y t+7h; `nivel_offset_h` registra cuál casó.
//
// Reglas duras de Traffilog (docs/API-TRAFFILOG-v4.3.txt pág. 32):
//   · UNA sola sesión por cuenta — dos simultáneas BLOQUEAN la cuenta. Antes de
//     loguear se verifica que no corra otro proceso del conector.
//   · Máximo 1 llamada cada 30 s (PAUSA por defecto: 30).
//   · El token vive 24 h y se REUSA: se cachea en connector/.token_cache.json
//     para no abrir sesión nueva en cada corrida.
//
// Uso:
//   node connector/enriquecer_combustible.mjs                # hasta 30 llamadas
//   node connector/enriquecer_combustible.mjs --max 10
//   node connector/enriquecer_combustible.mjs --desde 2026-07-01
//   node connector/enriquecer_combustible.mjs --reintentar   # incluye los sin_datos previos
//
// Lo corre refresco_diario.sh al final de cada corte. Idempotente: escribe el
// archivo tras CADA evento resuelto, así un corte a media corrida no pierde nada.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const ARCHIVO = join(raiz, 'datos', 'historico', 'combustible.json');
const TOKEN_CACHE = join(here, '.token_cache.json');

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
const MAX_LLAMADAS = Number(arg('max', 30));
const PAUSA = Math.max(30, Number(arg('pausa', 30)));   // regla dura: nunca menos de 30 s
const DESDE = arg('desde', null);
const REINTENTAR = args.includes('--reintentar');
const PARAMS_NIVEL = ['28929', '28932'];                 // TFL Processed Fuel Level

// ---------- UNA SOLA SESIÓN: si otro proceso usa la API, no arrancamos ----------
// Dos sesiones simultáneas bloquean la cuenta. Se buscan los node del conector
// que le pegan a Traffilog (no el shell de refresco: cuando éste nos invoca,
// sus pasos anteriores ya terminaron).
function apiOcupada() {
  const otros = ['archivo_historico', 'enriquecer_extendido', 'reatribuir_eventos', 'backfill.mjs', 'rest_test'];
  for (const p of otros) {
    try { execSync(`pgrep -f "node.*${p}"`, { stdio: 'pipe' }); return p; } catch {}
  }
  return null;
}
const ocupado = apiOcupada();
if (ocupado) {
  console.log(`la API está ocupada por otro proceso (${ocupado}) — salgo sin abrir sesión`);
  process.exit(0);
}

const dormir = (s) => new Promise(r => setTimeout(r, s * 1000));
const dec = (s) => { try { return decodeURIComponent(String(s ?? '')); } catch { return String(s ?? ''); } };

let llamadas = 0;
async function call(action, etiqueta) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const r = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => null);
      const p = j?.response?.properties;
      if (p && String(p.action_value ?? '0') !== '0') {
        const err = new Error(`action_value=${p.action_value} ${dec(p.description || '')}`);
        err.action_value = String(p.action_value);
        throw err;
      }
      if (!p) throw new Error('respuesta sin properties (HTTP ' + r.status + ')');
      return p;
    } catch (e) {
      if (e.action_value) throw e;               // error de la API: no se reintenta a ciegas
      const espera = [0, 30, 90][intento];
      if (intento === 2) throw new Error(`${etiqueta}: ${e.message}`);
      console.log(`    ${etiqueta} falló (${e.message.slice(0, 70)}) — reintento en ${espera}s`);
      await dormir(espera);
    }
  }
}

// ---------- eventos pendientes (ANTES de abrir sesión: sin trabajo no hay login) ----------
const doc = JSON.parse(readFileSync(ARCHIVO, 'utf8'));

// --limpiar: borra TODO enriquecido previo (delta_pct y campos nivel_*) y sale.
// Existe porque la primera corrida real (2026-07-27) grabó Δ1% falsos por un
// umbral que casaba con el consumo normal; tras ajustar el detector hay que
// poder rehacer sin editar el JSON a mano.
if (args.includes('--limpiar')) {
  let n = 0;
  for (const e of doc.eventos || []) {
    if (e.tipo !== 'fuel_caida') continue;
    if (e.delta_pct != null || e.nivel_medido || e.nivel_sin_datos) {
      for (const k of ['delta_pct', 'nivel_antes', 'nivel_despues', 'nivel_param', 'nivel_t',
                       'nivel_offset_h', 'nivel_lejana', 'nivel_medido', 'nivel_sin_datos']) delete e[k];
      n++;
    }
  }
  doc.actualizado = new Date().toISOString();
  writeFileSync(ARCHIVO, JSON.stringify(doc));
  console.log(`--limpiar: ${n} eventos des-enriquecidos (sin llamadas a la API)`);
  process.exit(0);
}
/* --remedir-tope: los medidos con el detector VIEJO que arrancan en el techo del
   sensor (nivel_antes ≥ 97) traen la carga asentándose en vez de la baja negativa.
   Con el detector corregido hay que volver a medirlos para saber su magnitud real
   (o descartarlos). Son ~32 al 2026-08-12: una corrida de ~16 min a 30 s/llamada. */
const REMEDIR_TOPE = args.includes('--remedir-tope');
const TOPE = 97;
const pendientes = (doc.eventos || [])
  .filter(e => e.tipo === 'fuel_caida' && e.time && e.vehicle_id)
  .filter(e => REMEDIR_TOPE
    ? (e.nivel_antes != null && e.nivel_antes >= TOPE)
    : (e.delta_pct == null && (REINTENTAR || !e.nivel_sin_datos)))
  .filter(e => !DESDE || e.fecha >= DESDE)
  .sort((a, b) => (a.time < b.time ? 1 : -1));   // recientes primero: son las accionables

console.log(`${pendientes.length} caídas sin Δ% · presupuesto ${MAX_LLAMADAS} llamadas · pausa ${PAUSA}s`);
if (args.includes('--plan')) {
  for (const e of pendientes.slice(0, 20)) console.log(`  ${e.fecha} ${e.time.slice(11, 16)} · unidad ${e.placa || e.vehicle_id}`);
  if (pendientes.length > 20) console.log(`  … y ${pendientes.length - 20} más`);
  console.log('(--plan: no se abre sesión ni se llama a la API)');
  process.exit(0);
}
if (!pendientes.length) { console.log('nada que enriquecer — no se abre sesión'); process.exit(0); }

// ---------- sesión: token cacheado 24 h; login sólo si no hay o expiró ----------
async function abrirSesion() {
  try {
    const c = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
    if (c.token && (Date.now() - Date.parse(c.obtenido)) < 23 * 3600e3) {
      console.log('✓ token cacheado reutilizado (' + c.obtenido + ')');
      return c.token;
    }
  } catch {}
  const login = await call(
    { name: 'user_login', parameters: { login_name: env.TRAFFILOG_USER, password: encodeURIComponent(env.TRAFFILOG_PASS) } },
    'login',
  );
  const tok = login.session_token;
  if (!tok) { console.error('login sin session_token'); process.exit(1); }
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token: tok, obtenido: new Date().toISOString() }));
  console.log('✓ sesión abierta (token cacheado 24 h en connector/.token_cache.json)');
  return tok;
}
let TOK = await abrirSesion();

async function serieNivel(vehicleId, startUtc, endUtc, param, etiqueta) {
  const pedir = () => call({
    name: 'api_get_vehicle_parameter_values',
    parameters: [{
      vehicle_id: String(vehicleId), param_type: param,
      start_time: startUtc, end_time: endUtc, version: '',
    }],
    session_token: TOK,
  }, etiqueta);
  let p;
  try { p = await pedir(); }
  catch (e) {
    // token expirado/ inválido → UN relogin y reintento (sigue siendo una sesión)
    if (!e.action_value) throw e;
    console.log(`    ${etiqueta}: ${e.message} — relogin y reintento`);
    try { writeFileSync(TOKEN_CACHE, '{}'); } catch {}
    TOK = await abrirSesion();
    await dormir(PAUSA);
    p = await pedir();
  }
  return (p.data || []).map(r => ({
    v: Number(dec(r.value)),
    t: Date.parse(dec(r.time)),
  })).filter(r => isFinite(r.v) && isFinite(r.t)).sort((a, b) => a.t - b.t);
}

/* Localiza la bajada de ROBO en la serie: rápida y grande, no el consumo.
   Medido el 2026-07-27 (unidad real): el sensor reporta ENTEROS cada ~1 min y
   el consumo normal baja 1% cada ~40 min. Un umbral de 1% casa con consumo por
   todos lados (así salieron tres Δ1% falsos con offsets incoherentes). Una
   caída de verdad es ≥3% en ≤40 min. Candidatos = para cada lectura, cuánto
   baja el nivel en los 40 min siguientes; se depuran máximos locales y se
   elige el más cercano a t+offset para offset ∈ {0, +6h, +7h} (tolerancia
   90 min); si ninguno casa, el mayor de la ventana marcado como `lejana`. */
function detectarCaida(serie, tEventoMs) {
  if (serie.length < 2) return null;
  const RAPIDA = 40 * 60e3, MIN_DELTA = 3;
  /* SOLO LA BAJA NEGATIVA, NUNCA LA CARGA (corregido 2026-08-12).
     Tras llenar, el sensor se satura y reporta el tope (99–100%) durante HORAS
     antes de desplomarse al nivel real: esa bajada es la carga asentándose, no
     una sustracción. El punto de arranque de una caída legítima tiene que venir
     de una MESETA, no de una subida. Se exige que en los PREVIA_ESTABLE minutos
     anteriores el nivel no haya subido más de SUBIDA_MAX puntos.

     OJO — ESTA REGLA NO BASTA SOLA: la ventana pedida es de ±8 h, así que si la
     carga ocurrió antes de su inicio no se ve la subida, solo la meseta clavada
     en el tope. Por eso el módulo aplica ADEMÁS un descarte por `nivel_antes ≥ 97`
     (UMBRAL_TOPE en aplicacion/modulos/combustible.js). Las dos capas son
     necesarias: ésta arregla la MEDICIÓN, la del módulo arregla la LECTURA de los
     eventos ya medidos con el detector viejo. */
  const PREVIA_ESTABLE = 90 * 60e3, SUBIDA_MAX = 4;
  function vieneDeSubida(i) {
    for (let k = i - 1; k >= 0 && serie[i].t - serie[k].t <= PREVIA_ESTABLE; k--) {
      if (serie[i].v - serie[k].v > SUBIDA_MAX) return true;   // subió: hubo carga
    }
    return false;
  }
  const cands = [];
  for (let i = 0; i < serie.length; i++) {
    if (vieneDeSubida(i)) continue;
    let minV = serie[i].v, minT = serie[i].t;
    for (let j = i + 1; j < serie.length && serie[j].t - serie[i].t <= RAPIDA; j++) {
      if (serie[j].v < minV) { minV = serie[j].v; minT = serie[j].t; }
    }
    const delta = serie[i].v - minV;
    /* ABRUPTEZA: se guarda la DURACIÓN de la bajada y su ritmo en %/min. El evento
       que hay que detectar es el desplome, y el consumo normal baja ~1% cada 40 min
       (0.025 %/min): un robo va uno o dos órdenes de magnitud por encima. Sin esto
       solo se podía ordenar por magnitud, que no distingue un desplome de 20% en
       3 min de una bajada de 20% arrastrada a lo largo de 40. */
    if (delta >= MIN_DELTA) cands.push({
      delta, antes: serie[i].v, despues: minV, tMedio: (serie[i].t + minT) / 2,
      minutos: Math.max(1, Math.round((minT - serie[i].t) / 60e3)),
    });
  }
  if (!cands.length) return null;
  // máximos locales: el mejor de cada racimo (candidatos a <45 min se solapan)
  cands.sort((a, b) => b.delta - a.delta);
  const caidas = [];
  for (const c of cands) {
    if (!caidas.some(k => Math.abs(k.tMedio - c.tMedio) < 45 * 60e3)) caidas.push(c);
  }
  const TOL = 90 * 60e3;
  let mejor = null;
  for (const off of [0, 6 * 3600e3, 7 * 3600e3]) {
    for (const c of caidas) {
      const dist = Math.abs(c.tMedio - (tEventoMs + off));
      if (dist <= TOL && (!mejor || c.delta > mejor.delta)) mejor = { ...c, offsetH: off / 3600e3, lejana: false };
    }
    if (mejor) break;   // el primer offset que casa define la base horaria
  }
  if (!mejor) mejor = { ...caidas[0], offsetH: null, lejana: true };
  return mejor;
}

const fmtUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function guardar() {
  doc.actualizado = new Date().toISOString();
  writeFileSync(ARCHIVO, JSON.stringify(doc));
}

let ok = 0, sinDatos = 0, ambiguas = 0;
for (const ev of pendientes) {
  if (llamadas >= MAX_LLAMADAS) break;
  // El time del evento viene en UTC SIN sufijo de zona (verificado 2026-07-27:
  // las caídas detectadas en la serie caen al segundo del evento). Sin la 'Z',
  // Date.parse lo tomaría como hora local de la máquina y correría el ancla 6 h.
  const tEv = Date.parse(/[Z+]/.test(ev.time.slice(10)) ? ev.time : ev.time + 'Z');
  if (!isFinite(tEv)) continue;
  // OJO (medido 2026-07-27): la API interpreta start/end_time en hora LOCAL
  // (UTC−6) aunque las lecturas vuelven en UTC. Ventana simétrica ±8 h para
  // cubrir el evento bajo cualquiera de las dos interpretaciones del reloj.
  const ini = fmtUtc(tEv - 8 * 3600e3), fin = fmtUtc(tEv + 8 * 3600e3);
  const etq = `caída ${ev.fecha} ${ev.time.slice(11, 16)} · unidad ${ev.placa || ev.vehicle_id}`;

  let serie = [], paramUsado = null;
  for (const param of PARAMS_NIVEL) {
    if (llamadas >= MAX_LLAMADAS) break;
    if (llamadas++) await dormir(PAUSA);
    try {
      serie = await serieNivel(ev.vehicle_id, ini, fin, param, `${etq} · param ${param}`);
    } catch (e) { console.log(`  ✗ ${etq}: ${e.message}`); serie = []; }
    if (serie.length) { paramUsado = param; break; }
  }

  ev.nivel_medido = new Date().toISOString();
  if (!serie.length) {
    ev.nivel_sin_datos = true;
    sinDatos++;
    console.log(`  – ${etq}: sin lecturas de nivel (params ${PARAMS_NIVEL.join('/')})`);
    guardar();
    continue;
  }
  delete ev.nivel_sin_datos;
  const c = detectarCaida(serie, tEv);
  if (!c) {
    // Hubo lecturas pero ninguna bajada ≥1%: caída no confirmada por la serie.
    ev.delta_pct = 0;
    ev.nivel_param = paramUsado;
    console.log(`  ~ ${etq}: ${serie.length} lecturas, sin bajada apreciable → Δ 0%`);
  } else {
    ev.delta_pct = +c.delta.toFixed(1);
    ev.nivel_antes = +c.antes.toFixed(1);
    ev.nivel_despues = +c.despues.toFixed(1);
    ev.nivel_minutos = c.minutos;                              // duración de la bajada
    ev.nivel_ritmo = +(c.delta / c.minutos).toFixed(3);        // %/min — la abrupteza
    ev.nivel_param = paramUsado;
    ev.nivel_t = new Date(c.tMedio).toISOString().slice(0, 19);
    ev.nivel_offset_h = c.offsetH;
    if (c.lejana) { ev.nivel_lejana = true; ambiguas++; }
    ok++;
    console.log(`  ✓ ${etq}: Δ ${ev.delta_pct}% (${ev.nivel_antes}→${ev.nivel_despues}, param ${paramUsado}` +
      (c.lejana ? ', LEJOS del timestamp — revisar' : `, offset ${c.offsetH}h`) + ')');
  }
  guardar();
}

console.log(`\n✓ listo · ${llamadas} llamadas · ${ok} con Δ% · ${sinDatos} sin datos · ${ambiguas} ambiguas · ` +
  `${Math.max(0, pendientes.length - ok - sinDatos)} pendientes para la próxima corrida`);
