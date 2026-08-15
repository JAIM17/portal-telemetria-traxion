// servidor_local.mjs — Servidor de DESARROLLO del portal (sustituye a python http.server).
// Además de estático, expone el gatillo del refresco "a día vencido" para que el
// botón del portal funcione en local:
//   POST /api/refrescar        → lanza connector/refresco_diario.sh (si no corre ya)
//   GET  /api/refresco-estado  → { corriendo, cola:últimas líneas del log }
// En producción (Netlify) estos endpoints no existen: el botón lo detecta y avisa.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = join(raiz, 'connector');
const PUERTO = Number(process.env.PORT || 4180);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json' };

let proceso = null, terminadoEn = null, codigo = null;
const LOG = '/tmp/refresco_diario.log';

/* ============================================================================
   MONITOR VIVO — alertas de temperatura (y pánico/robo) casi en tiempo real.
   Consulta get_incremental_events cada POLL_MS: la primera llamada trae las
   últimas 24 h (máx 10,000) y las siguientes SOLO lo nuevo desde la anterior.
   Reglas duras Traffilog: UNA sesión por cuenta (el token 24 h se comparte vía
   connector/.token_cache.json con el resto del conector) y se PAUSA solo
   mientras otro proceso del conector esté usando la API (refresco, backfills).
   Solo existe en local: producción (Netlify) no tiene este servidor.
   ========================================================================== */
const MONITOR = { activo: false, pausadoPor: null, ultimaConsulta: null, error: null, alertas: [] };

/* ACUMULADO PERSISTENTE: cada alerta se guarda en datos/historico/alertas_monitor.json
   (dedupe por event_id) para el módulo "Alertas" del portal — el histórico para
   tomar decisiones. Se publica a producción con cada deploy. */
const ALERTAS_FILE = join(raiz, 'datos', 'historico', 'alertas_monitor.json');
let ACUM = null;
const ACUM_IDS = new Set();
function cargarAcum() {
  try { ACUM = JSON.parse(readFileSync(ALERTAS_FILE, 'utf8')); }
  catch { ACUM = { _doc: 'Acumulado del monitor vivo: alertas de temperatura y pánico (hora en UTC).', alertas: [] }; }
  for (const a of ACUM.alertas) ACUM_IDS.add(a.id || (a.time + '|' + a.vehicle_id + '|' + a.evento));
}
cargarAcum();
function acumular(alerta) {
  const k = alerta.id || (alerta.time + '|' + alerta.vehicle_id + '|' + alerta.evento);
  if (ACUM_IDS.has(k)) return false;
  ACUM_IDS.add(k);
  ACUM.alertas.push(alerta);
  return true;
}
/* Al arrancar, el contador del día se SIEMBRA desde el acumulado persistido.
   Sin esto, un reinicio a media tarde dejaba el chip en 0: get_incremental_events
   es incremental por sesión y no vuelve a entregar lo que ya mandó hoy. */
function sembrarDia() {
  const hoy = hoyLocal();
  MONITOR.dia = hoy;
  MONITOR.alertas = ACUM.alertas
    .filter(a => diaLocalDe(a.time) === hoy)
    .sort((x, y) => (y.time || '') < (x.time || '') ? -1 : 1);
}

function guardarAcum() {
  ACUM.actualizado = new Date().toISOString();
  try { writeFileSync(ALERTAS_FILE, JSON.stringify(ACUM)); }
  catch (e) { console.log('monitor vivo: no pude guardar acumulado — ' + e.message); }
}
const POLL_MS = 120e3;              // 1 llamada cada 2 min ≫ regla de 1/30s
/* El chip vivo cuenta el DÍA EN CURSO, no un acumulado. Antes era una pila de
   200 (MAX_ALERTAS) que se llenaba en horas y se quedaba clavada en "200":
   dejaba de informar. El histórico completo sigue en alertas_monitor.json.
   (petición del cliente 2026-08-08) */
const TZ_LOCAL = 'America/Mexico_City';
const TOPE_DIA = 5000;              // solo malla de seguridad de memoria
function diaLocalDe(iso) {
  const d = new Date(/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(iso || '') ? iso : (iso || '') + 'Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-CA', { timeZone: TZ_LOCAL });
}
function hoyLocal() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ_LOCAL }); }
const RX_TEMP = /temperature|coolant|overheat|temperatura/i;
const RX_PANICO = /panic|posible robo|p[áa]nico/i;
const TOKEN_CACHE = join(here, '.token_cache.json');

const envMon = { ...process.env };
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !envMon[m[1]]) envMon[m[1]] = m[2].trim();
  }
} catch {}
const API_URL = envMon.TRAFFILOG_REST_URL || 'https://api.traffilog.mx/clients/json';

function apiOcupada() {
  const otros = ['archivo_historico', 'enriquecer_extendido', 'enriquecer_combustible',
    'reatribuir_eventos', 'backfill.mjs', 'rest_test'];
  for (const p of otros) {
    try { execSync(`pgrep -f "node.*${p}"`, { stdio: 'pipe' }); return p; } catch {}
  }
  if (proceso) return 'refresco_diario';   // el botón "Día vencido" en curso
  return null;
}

async function apiCall(action) {
  const r = await fetch(API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }), signal: AbortSignal.timeout(60e3),
  });
  const j = await r.json().catch(() => null);
  const p = j?.response?.properties;
  if (!p) throw new Error('respuesta sin properties (HTTP ' + r.status + ')');
  if (String(p.action_value ?? '0') !== '0') {
    const e = new Error('action_value=' + p.action_value + ' ' + (p.description || ''));
    e.action_value = String(p.action_value);
    throw e;
  }
  return p;
}

async function tokenMonitor(forzar) {
  if (!forzar) {
    try {
      const c = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
      if (c.token && (Date.now() - Date.parse(c.obtenido)) < 23 * 3600e3) return c.token;
    } catch {}
  }
  const login = await apiCall({ name: 'user_login',
    parameters: { login_name: envMon.TRAFFILOG_USER, password: encodeURIComponent(envMon.TRAFFILOG_PASS) } });
  if (!login.session_token) throw new Error('login sin session_token');
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token: login.session_token, obtenido: new Date().toISOString() }));
  return login.session_token;
}

let monitorPrimera = true;
sembrarDia();
async function tickMonitor() {
  if (!envMon.TRAFFILOG_USER || !envMon.TRAFFILOG_PASS) { MONITOR.error = 'sin credenciales (connector/.env)'; return; }
  const ocupado = apiOcupada();
  if (ocupado) { MONITOR.pausadoPor = ocupado; return; }
  MONITOR.pausadoPor = null;
  try {
    let tok = await tokenMonitor(false);
    let p;
    try {
      p = await apiCall({ name: 'get_incremental_events', parameters: [{ version: '3' }], session_token: tok });
    } catch (e) {
      if (!e.action_value) throw e;
      tok = await tokenMonitor(true);   // token muerto: una sola reapertura y reintento
      p = await apiCall({ name: 'get_incremental_events', parameters: [{ version: '3' }], session_token: tok });
    }
    const eventos = Array.isArray(p.data) ? p.data : [];
    const dec = (s) => { try { return decodeURIComponent(String(s ?? '')); } catch { return String(s ?? ''); } };
    let nuevos = 0;
    for (const e of eventos) {
      const nombre = dec(e.event_type_description || '');
      /* "coolant less than 70C after cranking" = motor FRÍO al arrancar: no es
         sobrecalentamiento, dispara decenas al día y ahogaría la alerta real. */
      if (/less\s*(than\s*)?70\s*C/i.test(nombre)) continue;
      const esTemp = RX_TEMP.test(nombre), esPanico = RX_PANICO.test(nombre);
      if (!esTemp && !esPanico) continue;
      const alerta = {
        id: dec(e.event_id || ''),
        tipo: esTemp ? 'temperatura' : 'panico',
        time: dec(e.time || '').replace(/\.\d+.*$/, ''), evento: nombre,
        severidad: dec(e.severity || '') || (/above|120|overheat/i.test(nombre) ? 'critical' : ''),
        placa: dec(e.license_number || ''), vehicle_id: dec(e.vehicle_id || ''),
        conductor: dec(e.driver_name || ''), lat: dec(e.start_latitude || ''), lng: dec(e.start_llongitude || e.start_longitude || ''),
        spn: dec(e.spn || ''), fmi: dec(e.fmi_description || ''),
        recibido: new Date().toISOString(),
      };
      MONITOR.alertas.unshift(alerta);
      acumular(alerta);
      nuevos++;
    }
    if (nuevos) guardarAcum();
    /* Corte diario: se descarta lo que ya no es de hoy (incluye las 24 h que
       trae la primera consulta y cruzan la medianoche). */
    const hoy = hoyLocal();
    MONITOR.dia = hoy;
    MONITOR.alertas = MONITOR.alertas.filter(a => diaLocalDe(a.time) === hoy);
    if (MONITOR.alertas.length > TOPE_DIA) MONITOR.alertas.length = TOPE_DIA;
    MONITOR.activo = true; MONITOR.error = null;
    MONITOR.ultimaConsulta = new Date().toISOString();
    if (monitorPrimera) {
      console.log(`monitor vivo: primera consulta — ${eventos.length} eventos de 24 h, ${nuevos} alertas`);
      monitorPrimera = false;
    } else if (nuevos) console.log(`monitor vivo: ${nuevos} alerta(s) nueva(s)`);
    await empujarANube();
  } catch (e) {
    MONITOR.error = e.message.slice(0, 160);
    console.log('monitor vivo: ' + MONITOR.error);
    await empujarANube();   // el error también se publica: mejor "monitor caído" visible que silencio
  }
}

/* Empuja el estado a producción (función monitor-alertas + Blobs) para que el
   portal publicado muestre el MISMO chip. La Mac sigue siendo la única sesión. */
async function empujarANube() {
  if (!envMon.MONITOR_PUSH_SECRET || !envMon.MONITOR_PUSH_URL) return;
  try {
    await fetch(envMon.MONITOR_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-monitor-secret': envMon.MONITOR_PUSH_SECRET },
      body: JSON.stringify(MONITOR), signal: AbortSignal.timeout(15e3),
    });
  } catch (e) { console.log('monitor vivo: push a nube falló — ' + e.message.slice(0, 80)); }
}

/* Solo el servidor PRINCIPAL (puerto 4180) monitorea: si un segundo servidor
   arranca en otro puerto (preview con autoPort), no debe partir el cursor
   incremental de Traffilog en dos. */
if (PUERTO === 4180) {
  setTimeout(tickMonitor, 5e3);
  setInterval(tickMonitor, POLL_MS);
} else {
  MONITOR.error = 'monitor desactivado: solo corre en el servidor principal (:4180)';
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/refrescar' && req.method === 'POST') {
    if (proceso) { res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, motivo: 'ya está corriendo' })); }
    /* el estado del botón lee /tmp/refresco_diario.log: el run manual escribe
       ahí igual que el de las 9:00 (antes iba solo a la consola del server) */
    const { openSync } = await import('node:fs');
    const fd = openSync(LOG, 'a');
    proceso = spawn('/bin/sh', [join(raiz, 'connector', 'refresco_diario.sh')],
      { stdio: ['ignore', fd, fd] });
    terminadoEn = null; codigo = null;
    proceso.on('exit', c => { codigo = c; proceso = null; terminadoEn = new Date().toISOString(); });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/monitor-alertas') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(MONITOR));
  }
  if (url.pathname === '/api/refresco-estado') {
    let cola = '';
    try { const t = readFileSync(LOG, 'utf8'); cola = t.slice(-600); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ corriendo: !!proceso, codigo, terminadoEn, cola }));
  }
  /* estático */
  let ruta = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (ruta === '' || ruta === '.') ruta = 'index.html';
  const abs = join(raiz, ruta);
  if (!abs.startsWith(raiz)) { res.writeHead(403); return res.end(); }
  try {
    const st = await stat(abs);
    const fin = st.isDirectory() ? join(abs, 'index.html') : abs;
    const cuerpo = await readFile(fin);
    res.writeHead(200, { 'Content-Type': MIME[extname(fin)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    res.end(cuerpo);
  } catch { res.writeHead(404); res.end('404'); }
}).listen(PUERTO, () => console.log('portal local en http://localhost:' + PUERTO +
  ' · POST /api/refrescar disponible'));
