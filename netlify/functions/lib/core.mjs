// core.mjs — Capa de datos Traffilog REST (compartida por funciones Netlify y scripts locales).
// API: https://api.traffilog.mx/clients/json  (login user_login → session_token; strings URL-encoded).
// Contiene: cliente REST, catálogo/clasificación de eventos, agregación operador×unidad×día×semana,
// y la fórmula EXACTA del Score de Seguridad (validada vs CALCULO_SCORE_MANUAL.xlsx).

// Este módulo se importa TANTO desde Node (funciones Netlify, scripts del
// connector) COMO desde el NAVEGADOR (aplicacion/archivo.js), donde `process` no
// existe. La guarda es obligatoria: sin ella, la sola carga del módulo lanza
// ReferenceError en el portal.
const ENV = (typeof process !== 'undefined' && process.env) ? process.env : {};
export const API_URL = ENV.TRAFFILOG_REST_URL || 'https://api.traffilog.mx/clients/json';

// ---------- utilidades ----------
export const dec = (s) => {
  if (s == null) return '';
  const t = String(s);
  try { return decodeURIComponent(t); } catch { return t; }
};
const p2 = (n) => String(n).padStart(2, '0');
export const ymd = (d) => d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());

// Fechas de la API vienen en UTC (a veces sin sufijo). Normaliza a epoch ms.
export function parseApiTime(s) {
  if (!s) return null;
  let t = dec(s).trim();
  if (!t) return null;
  if (!/Z$|[+\-]\d{2}:?\d{2}$/.test(t)) t += 'Z';
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}
// Bucket de día en hora local de Colima (UTC-6 fijo, sin DST desde 2022).
export const TZ_OFFSET_H = 6;
export function fechaLocal(apiTime) {
  const ms = typeof apiTime === 'number' ? apiTime : parseApiTime(apiTime);
  if (ms == null) return null;
  return new Date(ms - TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
}
// Semana ISO "YYYY-Www"
export function isoWeek(fecha) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (((d.getUTCDay() + 6) % 7) + 1)); // jueves de esa semana
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 864e5 + 1) / 7);
  return d.getUTCFullYear() + '-W' + p2(week);
}
export function hoursToHms(h) {
  const s = Math.round((h || 0) * 3600);
  return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor((s % 3600) / 60)) + ':' + p2(s % 60);
}

// ---------- cliente REST ----------
export async function apiCall(action, { retries = 2, url = API_URL } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        /* TIMEOUT DURO, no negociable. La API puede dejar de responder SIN
         * cerrar el socket: las conexiones quedan colgadas indefinidamente, el
         * pool de concurrencia se agota y el proceso se queda vivo al 0% de CPU,
         * de modo que ni siquiera el supervisor puede relanzarlo (nunca muere).
         * Con el abort, la llamada falla, el retry la reintenta y el pool se
         * libera. */
        signal: AbortSignal.timeout(90e3),
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      const props = j?.response?.properties;
      if (!r.ok || !props) throw new Error(`API ${action.name} HTTP ${r.status}: ${text.slice(0, 120)}`);
      /* action_value ≠ 0 es un ERROR de la API, aunque llegue con HTTP 200 y un
       * `data` vacío. Sin esta comprobación, "usuario no autorizado para el
       * vehículo" y "no hay datos en el rango" son indistinguibles, y un fallo de
       * permisos se propaga como un cero legítimo hasta los KPIs.
       * La API tiene más fallos silenciosos de esta familia (token expirado que
       * responde vacío sin error, tope no documentado de 10 placas en
       * get_vehicle_trips_extended): ante la duda, fallar ruidosamente.
       * El login se exceptúa: maneja sus propios 401/500 en login(). */
      const av = String(props.action_value ?? '0');
      if (av !== '0' && action.name !== 'user_login') {
        throw new Error(`API ${action.name} action_value=${av}: ${dec(props.description || 'sin descripción')}`);
      }
      return props;
    } catch (e) { lastErr = e; if (i < retries) await new Promise(res => setTimeout(res, 400 * (i + 1))); }
  }
  throw lastErr;
}

// Dos particularidades del login de Traffilog, ambas con trampa:
//   1. La API espera los strings URL-encoded (igual que los devuelve). Una
//      contraseña con caracteres especiales ($ & % +) enviada en crudo devuelve
//      401, indistinguible de una credencial inválida. Por eso se intentan ambas
//      formas.
//   2. Un HTTP 500 al login NO significa credencial inválida: es el bloqueo
//      temporal por exceso de peticiones. Insistir prolonga el bloqueo, así que
//      se espera con retroceso exponencial.
export async function login(user, pass, { esperas = [0, 30e3, 120e3, 300e3], log = () => {}, ...opts } = {}) {
  let lastErr;
  for (const [i, espera] of esperas.entries()) {
    if (espera) { log(`login bloqueado; esperando ${espera / 1000}s antes de reintentar (${i}/${esperas.length - 1})`); await new Promise(r => setTimeout(r, espera)); }
    for (const p of [encodeURIComponent(pass), pass]) {  // la API espera los strings URL-encoded
      try {
        const props = await apiCall({ name: 'user_login', parameters: { login_name: user, password: p } }, { ...opts, retries: 0 });
        if (props?.session_token) return props.session_token;
        lastErr = new Error(props?.data?.error_description || 'sin session_token');
      } catch (e) { lastErr = e; }
    }
    // Traffilog emite 401 TRANSITORIOS esporádicos con credencial VÁLIDA. Por eso
    // no se aborta al primer 401: sólo se concluye "credencial mala" si persiste
    // en TODOS los intentos, esperas incluidas. Abortar rápido aquí produce
    // diagnósticos falsos de credencial caducada muy caros de rastrear.
  }
  const bloqueo = /HTTP 500/.test(lastErr?.message || '');
  throw new Error(bloqueo
    ? 'Traffilog rechaza el login con HTTP 500 — la cuenta está bloqueada temporalmente por exceso de peticiones. Espera y baja la concurrencia.'
    : 'login Traffilog rechazado (revisa TRAFFILOG_USER/PASS): ' + lastErr.message);
}
export const fetchFleet = (tok, o) =>
  apiCall({ name: 'api_get_data', parameters: [{ last_time: '', license_nmbr: '', group_id: '', version: '4' }], session_token: tok }, o).then(p => p?.data || []);
export const fetchDrivers = (tok, o) =>
  apiCall({ name: 'get_user_drivers', parameters: [{}], session_token: tok }, o).then(p => p?.data || []);
export const fetchVehicleTrips = (tok, veh, fromYmd, toYmd, o) => {
  const params = { from_date: fromYmd, to_date: toYmd };
  if (veh.license_nmbr || veh.license_number) params.license_number = veh.license_nmbr || veh.license_number;
  else params.vehicle_id = veh.vehicle_id;
  return apiCall({ name: 'get_vehicle_trips', parameters: [params], session_token: tok }, o).then(p => p?.data || []);
};
export const fetchTripEvents = (tok, driveId, o) =>
  apiCall({ name: 'get_trip_events', parameters: [{ drive_id: String(driveId), version: '2' }], session_token: tok }, o).then(p => p?.data || []);
export const fetchIncrementalEvents = (tok, o) =>
  apiCall({ name: 'get_incremental_events', parameters: [{ version: '3' }], session_token: tok }, o).then(p => p?.data || []);

// concurrencia limitada
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// ---------- catálogo de eventos ----------
// Las 12 llaves del score (PLAN_MAESTRO §3): familia × nivel.
export const LLAVES = ['AcAlto','AcMed','AcBajo','FrAlto','FrMed','FrBajo','GirAlto','GirMed','GirBajo','VelAlto','VelMed','VelBajo'];
export const LLAVE_LABEL = {
  AcAlto: 'Aceleración nivel alto',  AcMed: 'Aceleración nivel medio',  AcBajo: 'Aceleración nivel bajo',
  FrAlto: 'Freno nivel alto',        FrMed: 'Freno nivel medio',        FrBajo: 'Freno nivel bajo',
  GirAlto: 'Giro nivel alto',        GirMed: 'Giro nivel medio',        GirBajo: 'Giro nivel bajo',
  VelAlto: 'Velocidad nivel alto en carretera', VelMed: 'Velocidad nivel medio en carretera', VelBajo: 'Velocidad nivel bajo en carretera',
};
const LVL_EN = { high: 'Alto', medium: 'Med', low: 'Bajo' };
const LVL_ES = { alto: 'Alto', medio: 'Med', bajo: 'Bajo' };
const LVL_HW = { HI: 'Alto', MD: 'Med', LW: 'Bajo' };

// Categorías extendidas (telemetría más allá del score) con etiqueta en español.
export const EXT_LABEL = {
  ralenti_5min: 'Ralentí > 5 min',
  ralenti_15min: 'Ralentí > 15 min',
  ralenti_20min: 'Ralentí > 20 min',
  ralenti_30min: 'Ralentí > 30 min',
  fuel_carga: 'Carga de combustible',
  fuel_caida: 'Caída de nivel de combustible (posible sifonado)',
  fuel_sensor: 'Sensor de nivel de combustible',
  clutch_arranque_alto: 'Arranque con clutch cargado',
  clutch_parado: 'Clutch presionado >30s detenido',
  clutch_movimiento: 'Clutch presionado >20s en movimiento',
  freno_prolongado: 'Freno presionado >10s a >30 km/h',
  alto_consumo: 'Alto consumo (rpm fuera de banda verde)',
  rpm_fuera_banda: 'RPM alto con bajo torque',
  torque_bajo_rpm: 'Torque alto con RPM bajo (antes de banda verde)',
  acelerador_brusco: 'Aceleración brusca con pedal',
  acelerador_detenido: 'Pedal >50% con vehículo detenido',
  neutral: 'Conducción en neutral',
  exceso_40kmh: 'Velocidad > 40 km/h (zona)',
  apagado_brusco: 'Apagado inmediato del motor',
  falla_sensor: 'Falla de sensor',
  adas: 'ADAS (FCW/LDW/PCW)',
  cinturon: 'Cinturón de seguridad',
  dtc: 'Diagnóstico DTC (SPN/FMI)',
  /* --- categorías nuevas (2026-07-24) rescatadas del cajón `otros` ------------
   * Sin estas reglas, `otros` absorbe ~82,900 eventos por semana y se vuelve el
   * mayor sumidero de información del portal: son señales con valor operativo
   * que quedan invisibles dentro del cajón genérico.
   *
   * NINGUNA lleva peso en el Score de Operación (m3) ni toca las 12 llaves del
   * Score de Seguridad: se separan para poder VERLAS, no para recalificar a
   * nadie por la espalda. Ponderarlas es una decisión aparte y explícita. */
  motor_temp: 'Temperatura de motor fuera de rango',
  motor_fluidos: 'Nivel/presión de aceite o refrigerante',
  bateria: 'Voltaje de batería bajo',
  energia: 'Corte/conexión de alimentación',
  seguridad_robo: 'Alerta de robo o pánico',
  rpm_alto_pedal: 'RPM > 2000 con pedal a fondo',
  odometro_hito: 'Hito de odómetro',
  otros: 'Otros',
};

// clasifica un nombre de evento de la API (inglés crudo o español del portal web)
export function classifyEvent(rawName, { spn } = {}) {
  const name = dec(rawName).trim();
  const n = name.toLowerCase();
  let m;
  // --- las 12 llaves del score ---
  if ((m = n.match(/\b(?:right|left)\s+(high|medium|low)\s+level/))) return { llave: 'Gir' + LVL_EN[m[1]], name };
  if ((m = n.match(/giro a la (?:der|izq)\.?\s*nivel\s+(alto|medio|bajo)/))) return { llave: 'Gir' + LVL_ES[m[1]], name };
  if ((m = n.match(/brak\w*\s+(high|medium|low)\s+level/))) return { llave: 'Fr' + LVL_EN[m[1]], name };
  if ((m = n.match(/freno nivel (alto|medio|bajo)/))) return { llave: 'Fr' + LVL_ES[m[1]], name };
  if ((m = n.match(/accel\w*\s+(high|medium|low)\s+level/))) return { llave: 'Ac' + LVL_EN[m[1]], name };
  if ((m = n.match(/aceleraci[oó]n nivel (alto|medio|bajo)/))) return { llave: 'Ac' + LVL_ES[m[1]], name };
  if ((m = name.match(/HIGHWAY_SPEED_(HI|MD|LW)/i))) return { llave: 'Vel' + LVL_HW[m[1].toUpperCase()], name };
  if ((m = n.match(/velocidad nivel (alto|medio|bajo)/))) return { llave: 'Vel' + LVL_ES[m[1]], name };
  // --- extendidas ---
  if (spn && String(spn).trim() !== '') return { ext: 'dtc', name };
  // Ralentí: el nombre del evento llega en múltiples variantes según el motor y
  // el idioma ("Ralenti mayor a 20 min", "Idle above 5 min", "(AllT) - Engine in
  // idle above 20 minutes", "(MBZ Sprinter) - engine in Idle…"). Cazar literales
  // fijos deja fuera del orden de ~880 eventos cada 2 días, que caen en `otros` y
  // subcuentan el ralentí. Por eso el umbral se LEE del propio nombre y se cubetea
  // al escalón inmediato inferior.
  if ((m = n.match(/(?:ralent[ií]|idle)\D{0,40}?(\d{1,3})\s*min/))) {
    const t = +m[1];
    return { ext: t >= 30 ? 'ralenti_30min' : t >= 20 ? 'ralenti_20min' : t >= 15 ? 'ralenti_15min' : 'ralenti_5min', name };
  }
  // Combustible. OJO: el litraje NO viaja en los eventos (get_trip_events v2 no tiene
  // campo de payload numérico) — esto es el CUÁNDO y el DÓNDE. Los litros salen de
  // get_vehicle_trips_extended (fuel_used / km_per_1_Liter), método aún no habilitado.
  if (/fuel fill/.test(n)) return { ext: 'fuel_carga', name };
  if (/fuel drop/.test(n)) return { ext: 'fuel_caida', name };
  if (/fuel level/.test(n)) return { ext: 'fuel_sensor', name };
  if (/start drive with high clutch/.test(n)) return { ext: 'clutch_arranque_alto', name };
  if (/clutch press.*30\s*sec.*stop/.test(n)) return { ext: 'clutch_parado', name };
  if (/clutch press.*20\s*sec.*motion/.test(n)) return { ext: 'clutch_movimiento', name };
  if (/brake pedal pressed.*10\s*sec/.test(n)) return { ext: 'freno_prolongado', name };
  if (/high fuel consumption/.test(n)) return { ext: 'alto_consumo', name };
  if (/high engine speed in low torque/.test(n)) return { ext: 'rpm_fuera_banda', name };
  if (/high engine torque in low rpm/.test(n)) return { ext: 'torque_bajo_rpm', name };
  if (/high acceleration with acc pedal/.test(n)) return { ext: 'acelerador_brusco', name };
  if (/accelerator pedal position above.*stop/.test(n)) return { ext: 'acelerador_detenido', name };
  if (/gear (?:is )?in neutral/.test(n)) return { ext: 'neutral', name };
  if (/failure.*sensor|sensor.*failure/.test(n)) return { ext: 'falla_sensor', name };
  if (/speed above 40/.test(n)) return { ext: 'exceso_40kmh', name };
  if (/immediate shut off engine/.test(n)) return { ext: 'apagado_brusco', name };
  if (/^adas|fcw|ldw|pcw|forward collision|proximity warning/.test(n)) return { ext: 'adas', name };
  if (/seat.?belt|cintur/.test(n)) return { ext: 'cinturon', name };
  /* --- rescatadas de `otros` (ver nota en EXT_LABEL) ------------------------
   * Van DESPUÉS de todas las reglas con peso, para no robarle eventos a
   * ninguna categoría que ya puntúe. Sin peso en ningún score. */
  if (/posible robo|panic|pánico/.test(n)) return { ext: 'seguridad_robo', name };
  if (/oil temperature|coolant temperature|above critical temperature|engine.*temp/.test(n))
    return { ext: 'motor_temp', name };
  if (/coolant level|oil pressure|oil level|fluid level/.test(n)) return { ext: 'motor_fluidos', name };
  if (/battery voltage|min battery/.test(n)) return { ext: 'bateria', name };
  if (/main_power|power (connect|disconnect)/.test(n)) return { ext: 'energia', name };
  if (/rpm above \d+ while acc/.test(n)) return { ext: 'rpm_alto_pedal', name };
  if (/odometro mayor|odometer above/.test(n)) return { ext: 'odometro_hito', name };
  // --- ruido de sistema (se excluye de KPIs, se cuenta en categorías) ---
  if (/ignition (on|off)|send fuel data|send chart|main_power|battery voltage|unit time|bmu |trip (start|end)|^gps |communication/.test(n))
    return { sistema: true, name };
  return { ext: 'otros', name };
}

// ---------- fórmula EXACTA del Score de Seguridad ----------
// Puntos = (Altos)*50 + (Medios)*25 + (Bajos)*5 ; PuntosX100h = Puntos/horas*100 ;
// Score = FLOOR(95 - 0.003*PuntosX100h), min 5, max 95.  (No alterar: validada vs Excel.)
export function safetyScore(ev, horas) {
  const g = (k) => Number(ev?.[k] || 0);
  const altos  = g('AcAlto') + g('FrAlto') + g('GirAlto') + g('VelAlto');
  const medios = g('AcMed')  + g('FrMed')  + g('GirMed')  + g('VelMed');
  const bajos  = g('AcBajo') + g('FrBajo') + g('GirBajo') + g('VelBajo');
  const puntos = altos * 50 + medios * 25 + bajos * 5;
  if (!(horas > 0)) return { puntos, x100h: null, score: puntos === 0 ? 95 : null };
  const x100h = puntos / horas * 100;
  let score = Math.floor(95 - 0.003 * x100h);
  if (score < 5) score = 5;
  if (score > 95) score = 95;
  return { puntos, x100h, score };
}

// ---------- jornada laboral · umbral de ACTIVIDAD del pipeline ----------
// Un `registro` existe en cuanto la unidad se movió un minuto en el patio: "hay
// registro" ≠ "el operador trabajó ese día". Medido sobre 2026-W27..W30, ~20% de
// los pares operador-día traen menos de 15 min y muchos 0 km. Sin un umbral, toda
// racha de días consecutivos degenera al número de días del periodo.
//
// Este umbral (≥ 15 min Y ≥ 5 km) es el del PIPELINE: alimenta los campos
// `dias_jornada` y `horas_por_jornada` del snapshot, pensados como medida de
// actividad de la unidad.
//
// ATENCIÓN — NO es el criterio de fatiga del portal. El módulo de cargas
// (aplicacion/modulos/cargas-fatiga.js) aplica el criterio corporativo DMAS:
// ≥ 3 horas brutas, sin condición de km. Son dos preguntas distintas
// ("¿hubo actividad?" vs "¿cuenta como jornada laboral?") y dan cifras
// distintas a propósito. Ver docs/METRICAS.md § Jornada y fatiga antes de
// unificarlos: cambiar cualquiera de los dos mueve KPIs publicados.
export const JORNADA_MIN_H = 0.25;
export const JORNADA_MIN_KM = 5;
export const esJornada = (horas, km) => (Number(horas) || 0) >= JORNADA_MIN_H && (Number(km) || 0) >= JORNADA_MIN_KM;

// ---------- taxonomía UDN / cliente ----------
// El grupo de la API mezcla ambos ("YAZAKI COLIMA" = cliente Yazaki, UDN Colima).
// UDN oficiales: Guadalajara · Colima · Lázaro Cárdenas. El resto son clientes.
export const UDN_CANON = ['Guadalajara', 'Colima', 'Lázaro Cárdenas'];
const UDN_PISTAS = [
  [/\b(GDL|GUADALAJARA|JALISCO|ZAPOPAN|TLAQUEPAQUE)\b/i, 'Guadalajara'],
  [/\b(COL|COLIMA|TECOMAN|TECOMÁN|MANZANILLO|VILLA\s*DE\s*ALVAREZ)\b/i, 'Colima'],
  [/\b(LC|LAZARO|LÁZARO|CARDENAS|CÁRDENAS|MICHOACAN|MICHOACÁN)\b/i, 'Lázaro Cárdenas'],
];
// Grupos sin pista geográfica en el nombre — UDN confirmada por operaciones (2026-07-23).
const UDN_EXPLICITA = {
  'FOUR SEASON': 'Colima', 'FOUR SEASONS': 'Colima', 'ESCUELA': 'Colima',
  'INGRASIS': 'Guadalajara',
};
const CLIENTE_ALIAS = { 'COL TERNIUM': 'Ternium', 'FOUR SEASON': 'Four Seasons', 'ESCUELA': 'Escuela (interno)', 'LIPU': 'LIPU (interno)' };
// Grupos que no son operación de cliente (flota parada, utilitarios, guardia).
const NO_OPERATIVO = /^(NO\s*FUNCIONAN?\.?|DISPONIBLE|UTILITARIO|GUARDIA)$/i;
// Marcas cuyo capitalizado no es el genérico Título.
const MARCA = { ARCELORMITTAL: 'ArcelorMittal', PEPSICO: 'PepsiCo', PISA: 'PiSA', ZF: 'ZF', JLL: 'JLL', RHI: 'RHI', 'M2': 'M2', HERSHEY: "Hershey's", "HERSHEY'S": "Hershey's" };
const CONECTOR = /^(de|del|la|el|y|en)$/i;   // conectores en minúscula, salvo al inicio
const titulo = (s) => s.split(/\s+/).map((w, i) => {
  if (MARCA[w.toUpperCase()]) return MARCA[w.toUpperCase()];
  if (i > 0 && CONECTOR.test(w)) return w.toLowerCase();
  if (w.length <= 2) return w.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}).join(' ');

// Mapa editable grupo→UDN (docs/udn-map.json, mantenido desde el portal por el rol super).
// Tiene prioridad sobre las pistas del nombre: es la fuente de verdad que edita operaciones.
let UDN_MAP = {};
/** Inyecta el mapa grupo→UDN. Acepta el JSON completo o solo el objeto `grupos`. */
export function setUdnMap(map) {
  const grupos = map?.grupos || map || {};
  UDN_MAP = {};
  for (const [g, v] of Object.entries(grupos)) {
    const udn = typeof v === 'string' ? v : v?.udn;
    if (udn && udn !== 'Sin asignar') UDN_MAP[g.trim().toUpperCase()] = udn;
  }
  return Object.keys(UDN_MAP).length;
}
export const getUdnMap = () => ({ ...UDN_MAP });

/** Divide el nombre de grupo de la API en { udn, cliente }. */
export function splitGrupo(grupo) {
  const g = dec(grupo || '').trim();
  if (!g) return { udn: '', cliente: '', grupo: '' };
  if (NO_OPERATIVO.test(g)) return { udn: 'Sin asignar', cliente: 'Sin asignar', grupo: g };

  // 1) mapa editable  2) confirmado por el cliente  3) pista en el nombre
  let udn = UDN_MAP[g.toUpperCase()] || UDN_EXPLICITA[g.toUpperCase()] || '';
  if (!udn) for (const [re, name] of UDN_PISTAS) if (re.test(g)) { udn = name; break; }

  // cliente = el grupo sin los tokens geográficos ni los sufijos de plaza
  let resto = g;
  for (const [re] of UDN_PISTAS) resto = resto.replace(new RegExp(re.source, 'gi'), ' ');
  resto = resto
    .replace(/\bL\s+CARDENAS\b|\bTRUCHAS\b|\bTEPIC\b|\bTLAJOMULCO\b|\bMOCTEZUMA\b|\bFORANEA\b/gi, ' ')
    .replace(/\(\s*\)|^\s*[:\-]\s*|\s*[:\-]\s*$/g, ' ')
    .replace(/\s+[A-Z]\s*$/i, ' ')      // letra huérfana tras quitar la plaza ("LIPU L" ← "LIPU L CARDENAS")
    .replace(/\bDE\b/g, 'de')
    .replace(/\s+/g, ' ').trim();
  const cliente = CLIENTE_ALIAS[g.toUpperCase()] || CLIENTE_ALIAS[resto.toUpperCase()] ||
    (resto ? titulo(resto) : (udn || 'Sin asignar'));

  return { udn: udn || 'Sin asignar', cliente, grupo: g };
}

// ---------- normalización ----------
export function normFleet(fleet) {
  return fleet.map(v => ({
    vehicle_id: String(v.vehicle_id || ''),
    placa: dec(v.license_nmbr || ''),
    vin: dec(v.chassis_number || ''),
    ...(({ udn, cliente, grupo }) => ({ udn, cliente, grupo }))(splitGrupo(v.group_name)),
    /* La API ya resuelve cliente y grupo; hoy se infieren con heurísticas de texto
       en splitGrupo(). Se capturan para poder contrastarlos y, más adelante,
       dejar de adivinar. NO se usan aún: cambiar la taxonomía ahora movería las
       UDN de todo el portal, y docs/udn-map.json es la fuente de verdad. */
    client_name: dec(v.client_name || ''),
    group_id: String(v.group_id || ''),
    chofer_actual: dec(v.driver_name || '').replace(/\s+/g, ' ').trim(),
    odometro: Number(v.last_mileage || 0) || 0,
    ultima_comunicacion: dec(v.last_communication_time || ''),
    status: String(v.status ?? ''),
  }));
}
export function normDrivers(drivers) {
  return drivers.map(d => ({
    driver_id: String(d.driver_id || ''),
    conductor: dec(d.driver_name || '').replace(/\s+/g, ' ').trim(),
    worker_id: String(d.worker_id || ''),
    driver_code: String(d.driver_code || ''),
    grupo: dec(d.group_name || ''),
    activo: String(d.active_flag ?? '') === '1',
  })).filter(d => d.conductor);
}

// fila de evento normalizada (sirve para get_trip_events v2 y get_incremental_events v3)
export function normEventRow(e) {
  const t = e.time || e.start_time;
  const fecha = fechaLocal(t);
  return {
    event_id: String(e.event_id || ''),
    /* ID numérico ESTABLE del tipo de evento. Hoy classifyEvent() clasifica con
       regex sobre el texto en inglés, que es frágil: por eso el ralentí salía
       22% corto (no cazaba "20 min", "Idle above", ni las variantes por motor).
       Se captura desde ya para poder migrar la clasificación a IDs sin tener
       que volver a bajar el histórico. */
    event_type_id: String(e.event_type_id || ''),
    fecha,
    time: dec(t || ''),
    vehicle_id: String(e.vehicle_id || ''),
    placa: dec(e.license_number || ''),
    driver_id: String(e.driver_id || ''),
    conductor: dec(e.driver_name || '').replace(/\s+/g, ' ').trim(),
    worker_id: String(e.worker_id || ''),
    name: dec(e.event_type_description || ''),
    categoria: dec(e.event_category_description || '') || 'Other',
    severidad: dec(e.severity || ''),
    spn: dec(e.spn || ''),
    fmi: dec(e.fmi || ''),
    fmi_desc: dec(e.fmi_description || ''),
    lat: Number(e.latitude || e.start_latitude || 0) || null,
    lng: Number(e.longitude || e.start_longitude || 0) || null,
    speed: Number(e.speed || 0) || null,
  };
}
export function normTripRow(t) {
  const s = parseApiTime(t.start_time), e = parseApiTime(t.end_time);
  const horas = s != null && e != null && e > s ? (e - s) / 3600e3 : 0;
  return {
    drive_id: String(t.drive_id || ''),
    vehicle_id: String(t.vehicle_id || ''),
    placa: dec(t.license_number || ''),
    driver_id: String(t.driver_id || ''),
    fecha: fechaLocal(t.start_time),
    horas,
    km: Number(t.distance || 0) || 0,
  };
}

// ---------- agregación: operador × unidad × día ----------
const zero12 = () => Object.fromEntries(LLAVES.map(k => [k, 0]));

export function aggregate({ trips = [], events = [], fleetIdx = new Map(), driverIdx = new Map() }) {
  const regs = new Map(); // key: fecha|driver_id|vehicle_id
  const nameByDriverId = new Map();
  for (const ev of events) if (ev.driver_id && ev.conductor) nameByDriverId.set(ev.driver_id, ev.conductor);
  for (const [id, d] of driverIdx) if (d.conductor) nameByDriverId.set(id, d.conductor);

  const resolveConductor = (driver_id, placa) => {
    if (driver_id && nameByDriverId.get(driver_id)) return nameByDriverId.get(driver_id);
    if (driver_id && driver_id !== '0') return 'OPERADOR ' + driver_id;
    return 'SIN OPERADOR' + (placa ? ' (' + placa + ')' : '');
  };
  const ensure = (fecha, driver_id, vehicle_id, placa) => {
    const key = regKey({ fecha, driver_id, vehicle_id });
    let r = regs.get(key);
    if (!r) {
      const veh = fleetIdx.get(String(vehicle_id)) || {};
      const drv = driverIdx.get(String(driver_id)) || {};
      // taxonomía: preferir la unidad (group_name de la flota); si no hay, derivar del grupo del chofer.
      const tax = veh.udn || veh.cliente || veh.grupo
        ? { udn: veh.udn || '', cliente: veh.cliente || '', grupo: veh.grupo || '' }
        : splitGrupo(drv.grupo || '');
      r = {
        fecha, semana: isoWeek(fecha),
        driver_id: String(driver_id || ''), conductor: resolveConductor(driver_id, placa || veh.placa),
        worker_id: drv.worker_id || '',
        vehicle_id: String(vehicle_id || ''), placa: placa || veh.placa || '',
        udn: tax.udn || '', cliente: tax.cliente || '', grupo: tax.grupo || '',
        viajes: 0, horas: 0, km: 0,
        eventos: zero12(),
        extendido: {}, categorias: {}, severidades: {},
        dtc: [], // [{spn,fmi,desc,n}]
      };
      regs.set(key, r);
    }
    return r;
  };

  for (const t of trips) {
    if (!t.fecha) continue;
    const r = ensure(t.fecha, t.driver_id, t.vehicle_id, t.placa);
    r.viajes += 1; r.horas += t.horas; r.km += t.km;
  }
  for (const ev of events) {
    if (!ev.fecha) continue;
    const c = classifyEvent(ev.name, { spn: ev.spn });
    const r = ensure(ev.fecha, ev.driver_id, ev.vehicle_id, ev.placa);
    r.categorias[c.sistema ? 'Sistema' : ev.categoria] = (r.categorias[c.sistema ? 'Sistema' : ev.categoria] || 0) + 1;
    if (c.sistema) continue;
    if (ev.severidad) r.severidades[ev.severidad] = (r.severidades[ev.severidad] || 0) + 1;
    if (c.llave) r.eventos[c.llave] += 1;
    else if (c.ext) {
      r.extendido[c.ext] = (r.extendido[c.ext] || 0) + 1;
      if (c.ext === 'dtc') {
        const d = r.dtc.find(x => x.spn === ev.spn && x.fmi === ev.fmi);
        if (d) d.n += 1; else r.dtc.push({ spn: ev.spn, fmi: ev.fmi, desc: ev.fmi_desc, n: 1 });
      }
    }
  }
  return regs;
}

// ---------- llave canónica del grano mínimo: operador × unidad × día ----------
// Es la MISMA llave que usa aggregate(); sirve para re-indexar `registros` de un snapshot ya escrito.
export function regKey(r) {
  return r.fecha + '|' + (r.driver_id || '0') + '|' + (r.vehicle_id || '0');
}
/** Indexa un array de `registros` (p.ej. el de data.json) en { llave: registro }. */
export function indexRegistros(registros = []) {
  const out = {};
  for (const r of registros) if (r && r.fecha) out[regKey(r)] = r;
  return out;
}

// Merge acumulativo. PRINCIPIO: nunca reemplazo total del histórico — una
// corrida parcial o fallida no debe poder borrar datos ya asentados. `newRegs`
// pisa la MISMA llave; las llaves que no vienen en la corrida se conservan.
export function mergeRegistros(oldObj = {}, regsMap) {
  const out = { ...oldObj };
  for (const [k, v] of (regsMap instanceof Map ? regsMap : Object.entries(regsMap))) out[k] = v;
  return out;
}

/**
 * Merge por FECHA recalculada — la variante que usan backfill y cron.
 * `fechas` son los días que se volvieron a agregar COMPLETOS desde la fuente; para esos días
 * las llaves viejas se descartan (evita registros fantasma si un operador dejó de aparecer)
 * y para todo lo demás el histórico queda intacto. Nunca es un reemplazo total.
 * Salvaguarda: si un día recalculado no produjo NINGÚN registro (API vacía / fallo silencioso)
 * se conserva lo que ya había para ese día.
 * @returns { merged, stats:{ fechas_reemplazadas, fechas_conservadas, antes, despues, nuevas, pisadas } }
 */
export function mergeRegistrosPorFecha(oldObj = {}, regsMap, fechas = null) {
  const nuevos = regsMap instanceof Map ? Object.fromEntries(regsMap) : { ...regsMap };
  const dias = new Set(fechas || Object.values(nuevos).map(r => r.fecha));
  const conDatos = new Set(Object.values(nuevos).map(r => r.fecha));
  const reemplaza = new Set([...dias].filter(d => conDatos.has(d)));   // solo días con datos nuevos
  const conserva = [...dias].filter(d => !conDatos.has(d));

  const merged = {};
  for (const [k, v] of Object.entries(oldObj)) if (!reemplaza.has(v.fecha)) merged[k] = v;
  let nuevas = 0, pisadas = 0;
  for (const [k, v] of Object.entries(nuevos)) { (k in oldObj ? pisadas++ : nuevas++); merged[k] = v; }

  return {
    merged,
    stats: {
      fechas_reemplazadas: [...reemplaza].sort(),
      fechas_conservadas: conserva.sort(),
      antes: Object.keys(oldObj).length, despues: Object.keys(merged).length,
      nuevas, pisadas,
    },
  };
}

// ---------- snapshot (modelo que consume el portal) ----------
const sum12 = (a, b) => { for (const k of LLAVES) a[k] += b[k] || 0; return a; };
const sumObj = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };

export function rollup(rows) {
  // agrupa registros por conductor (y opcionalmente semana) → métricas + score
  const g = {
    horas: 0, km: 0, viajes: 0, eventos: zero12(), extendido: {}, categorias: {}, severidades: {},
    dtc: [], unidades: new Set(), dias: new Set(), udn: {}, cliente: {},
  };
  // operador × día (sumando sus unidades) — necesario para evaluar la JORNADA
  const porDia = new Map();
  for (const r of rows) {
    const d = porDia.get(r.fecha) || { horas: 0, km: 0 };
    d.horas += r.horas; d.km += r.km;
    porDia.set(r.fecha, d);
  }
  for (const r of rows) {
    g.horas += r.horas; g.km += r.km; g.viajes += r.viajes;
    sum12(g.eventos, r.eventos); sumObj(g.extendido, r.extendido);
    sumObj(g.categorias, r.categorias); sumObj(g.severidades, r.severidades);
    for (const d of r.dtc) { const f = g.dtc.find(x => x.spn === d.spn && x.fmi === d.fmi); if (f) f.n += d.n; else g.dtc.push({ ...d }); }
    if (r.placa) g.unidades.add(r.placa);
    if (r.viajes > 0 || r.horas > 0) g.dias.add(r.fecha);
    if (r.udn) g.udn[r.udn] = (g.udn[r.udn] || 0) + 1;
    if (r.cliente) g.cliente[r.cliente] = (g.cliente[r.cliente] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const sc = safetyScore(g.eventos, g.horas);
  // jornadas reales: días con conducción ≥ JORNADA_MIN_H y ≥ JORNADA_MIN_KM
  // (dias_activos cuenta cualquier movimiento; no sirve para fatiga ni para h/día)
  let dias_jornada = 0, horas_jornada = 0;
  for (const d of porDia.values()) if (esJornada(d.horas, d.km)) { dias_jornada++; horas_jornada += d.horas; }
  return {
    udn: top(g.udn), cliente: top(g.cliente),
    horas: +g.horas.toFixed(4), km: +g.km.toFixed(2), viajes: g.viajes,
    dias_activos: g.dias.size, unidades: [...g.unidades].sort(),
    dias_jornada, horas_por_jornada: dias_jornada ? +(horas_jornada / dias_jornada).toFixed(4) : 0,
    eventos: g.eventos, extendido: g.extendido, categorias: g.categorias, severidades: g.severidades, dtc: g.dtc,
    puntos: sc.puntos, x100h: sc.x100h == null ? null : +sc.x100h.toFixed(4), score: sc.score,
  };
}

/** registros → { por_operador, por_operador_semana }. Única fuente de verdad del
 *  bloque `scores` del snapshot: la usa buildSnapshot() y también la migración
 *  offline (connector/migrate_taxonomia.mjs), para que nunca queden desfasados
 *  respecto de `registros` (taxonomía UDN/cliente, jornadas, score). */
export function buildScores(registros = []) {
  const byDriver = new Map(), byDriverWeek = new Map();
  for (const r of registros) {
    (byDriver.get(r.conductor) || byDriver.set(r.conductor, []).get(r.conductor)).push(r);
    const wk = r.semana + '|' + r.conductor;
    (byDriverWeek.get(wk) || byDriverWeek.set(wk, []).get(wk)).push(r);
  }
  const por_operador = [...byDriver.entries()].map(([conductor, rows]) => ({ conductor, ...rollup(rows) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.conductor||'').localeCompare(String(b.conductor||'')));
  const por_operador_semana = [...byDriverWeek.entries()].map(([k, rows]) => {
    const i = k.indexOf('|');
    return { semana: k.slice(0, i), conductor: k.slice(i + 1), ...rollup(rows) };
  }).sort((a, b) => String(a.semana||'').localeCompare(String(b.semana||'')) || String(a.conductor||'').localeCompare(String(b.conductor||'')));
  return { por_operador, por_operador_semana, operadores: byDriver.size };
}

export function buildSnapshot(regsMap, { fleet = [], driverRoster = [], from, to, source = 'traffilog:rest' } = {}) {
  const registros = [...(regsMap instanceof Map ? regsMap.values() : Object.values(regsMap))]
    .sort((a, b) => String(a.fecha||'').localeCompare(String(b.fecha||'')) || String(a.conductor||'').localeCompare(String(b.conductor||'')));
  for (const r of registros) { r.horas = +(r.horas || 0).toFixed(4); r.km = +(r.km || 0).toFixed(2); }

  // --- legacy: trips/events/drivers por conductor×día (retrocompatible con el portal actual) ---
  // `grupo` = nombre crudo del grupo de la API (lo usa el selector del portal); `udn`/`cliente` = taxonomía derivada.
  const tByKey = new Map(), eByKey = new Map();
  for (const r of registros) {
    const g = r.grupo || r.udn || '';
    const tk = r.fecha + '|' + r.conductor;
    const t = tByKey.get(tk) || { fecha: r.fecha, conductor: r.conductor, grupo: g, udn: r.udn || '', cliente: r.cliente || '', recuento_de_viajes: 0, horas: 0, distancia_km: 0 };
    t.recuento_de_viajes += r.viajes; t.horas += r.horas; t.distancia_km += r.km;
    if (!t.grupo && g) { t.grupo = g; t.udn = r.udn || ''; t.cliente = r.cliente || ''; }
    tByKey.set(tk, t);
    const bump = (evName, n) => { const k = tk + '|' + evName; const e = eByKey.get(k) || { fecha: r.fecha, conductor: r.conductor, grupo: g, evento: evName, cantidad: 0, udn: r.udn || '', cliente: r.cliente || '' }; e.cantidad += n; eByKey.set(k, e); };
    for (const k of LLAVES) if (r.eventos[k]) bump(LLAVE_LABEL[k], r.eventos[k]);
    for (const [k, n] of Object.entries(r.extendido)) bump(EXT_LABEL[k] || k, n);
  }
  const trips = [...tByKey.values()].map(t => ({
    fecha: t.fecha, conductor: t.conductor, grupo: t.grupo,
    recuento_de_viajes: t.recuento_de_viajes, tiempo_de_inactividad: '',
    tiempo_neto_de_conduccion: hoursToHms(t.horas), distancia_km: +t.distancia_km.toFixed(2),
    udn: t.udn, cliente: t.cliente,
  }));
  const events = [...eByKey.values()];

  // --- scores ---
  const { por_operador, por_operador_semana, operadores } = buildScores(registros);

  // --- catálogos / meta ---
  const unidades = normFleetMaybe(fleet);
  const semanas = [...new Set(registros.map(r => r.semana))].sort();
  const rosterNames = new Set(registros.map(r => r.conductor));
  const drivers = (driverRoster.length ? driverRoster : [...rosterNames].map(c => ({ conductor: c, grupo: '' })))
    .map(d => {
      const s = splitGrupo(d.grupo || '');
      return { conductor: d.conductor, grupo: d.grupo || '', driver_id: d.driver_id || '', worker_id: d.worker_id || '', driver_code: d.driver_code || '', udn: s.udn, cliente: s.cliente };
    })
    .sort((a, b) => String(a.conductor||'').localeCompare(String(b.conductor||'')));
  const fmt = (s) => s ? s.split('-').reverse().join('/') : '—';

  // rango: si no se pasa, se deriva del histórico acumulado (backfill incremental).
  const fechas = registros.map(r => r.fecha);
  from = from || (fechas.length ? fechas.reduce((a, b) => (b < a ? b : a)) : '');
  to = to || (fechas.length ? fechas.reduce((a, b) => (b > a ? b : a)) : '');

  return {
    version: 2,
    updated_at: new Date().toISOString(),
    from, to, range: fmt(from) + ' – ' + fmt(to),
    source,
    // legacy (portal actual)
    trips, events, drivers,
    // extendido (PLAN_MAESTRO Fase 1)
    unidades,
    registros,
    scores: { por_operador, por_operador_semana },
    semanas,
    meta: {
      udns: [...new Set([...unidades.map(u => u.udn), ...registros.map(r => r.udn)])].filter(Boolean).sort(),
      clientes: [...new Set([...unidades.map(u => u.cliente), ...registros.map(r => r.cliente)])].filter(Boolean).sort(),
      operadores,
      unidades: unidades.length,
      eventos: registros.reduce((s, r) => s + LLAVES.reduce((x, k) => x + r.eventos[k], 0) + Object.values(r.extendido).reduce((x, n) => x + n, 0), 0),
      catalogo: { llaves: LLAVES, llave_label: LLAVE_LABEL, extendido: EXT_LABEL, pesos: { Alto: 50, Med: 25, Bajo: 5 } },
      formula: 'Puntos=(Altos*50+Medios*25+Bajos*5); X100h=Puntos/horas*100; Score=FLOOR(95-0.003*X100h) [5..95]',
      tz: 'UTC-' + TZ_OFFSET_H + ' (Colima)',
      grupos_api: [...new Set([...unidades.map(u => u.grupo), ...registros.map(r => r.grupo)])].filter(Boolean).sort(),
      taxonomia: { udn_oficiales: UDN_CANON, derivada_de: 'group_name de api_get_data', confirmado: '2026-07-23' },
    },
  };
}
function normFleetMaybe(fleet) {
  if (!fleet.length) return [];
  return 'udn' in fleet[0] ? fleet : normFleet(fleet);
}

// ---------- pipeline completo desde la API (backfill / on-demand) ----------

/** Abre sesión y trae los catálogos que NO dependen del rango (flota + roster). Reutilizable entre semanas. */
export async function openSession({ user, pass, url, log = () => {} } = {}) {
  const opts = { url };
  const tok = await login(user, pass, opts);
  log('login ok');
  const [fleetRaw, driversRaw] = await Promise.all([fetchFleet(tok, opts), fetchDrivers(tok, opts).catch(() => [])]);
  const fleet = normFleet(fleetRaw);
  const roster = normDrivers(driversRaw);
  log(`flota ${fleet.length} unidades · roster ${roster.length} choferes`);
  return { tok, fleet, roster, opts };
}

const shiftYmd = (d, days) => ymd(new Date(Date.parse(d + 'T00:00:00Z') + days * 864e5));

/**
 * MOTOR ÚNICO de descarga por rango: viajes por unidad + eventos por viaje → registros agregados.
 * La API filtra por UTC y el bucket de día es UTC−6, así que se pide con 1 día de colchón a cada
 * lado y se recorta por fecha LOCAL; así un rango semanal cubre sus días completos y no invade
 * los días vecinos (crítico para el merge por fecha del backfill).
 */
export async function fetchRangeRegs({ tok, fleet, roster = [], from, to, concurrency = 8, log = () => {}, opts = {}, padDays = 1 } = {}) {
  const fleetIdx = new Map(fleet.map(v => [v.vehicle_id, v]));
  const driverIdx = new Map(roster.map(d => [d.driver_id, d]));
  const qFrom = shiftYmd(from, -padDays), qTo = shiftYmd(to, padDays);

  const tripsNested = await mapLimit(fleet, concurrency, async (veh) => {
    try { return (await fetchVehicleTrips(tok, { license_nmbr: veh.placa, vehicle_id: veh.vehicle_id }, qFrom, qTo, opts)).map(normTripRow); }
    catch (e) { log(`  trips ${veh.placa}: ${e.message}`); return []; }
  });
  const tripsAll = tripsNested.flat().filter(t => t.fecha && t.drive_id);
  // los viajes del colchón se consultan (sus eventos pueden caer dentro del rango local) pero no se agregan
  const trips = tripsAll.filter(t => t.fecha >= from && t.fecha <= to);
  log(`viajes ${trips.length} (consultados ${tripsAll.length} con colchón)`);

  // eventos por viaje (histórico real; get_incremental_events no da histórico)
  const evNested = await mapLimit(tripsAll, concurrency, async (t, i) => {
    if (i && i % 500 === 0) log(`  eventos ${i}/${tripsAll.length} viajes…`);
    try { return (await fetchTripEvents(tok, t.drive_id, opts)).map(normEventRow); }
    catch { return []; }
  });
  const events = evNested.flat().filter(e => e.fecha && e.fecha >= from && e.fecha <= to);
  log(`eventos ${events.length}`);

  const regs = aggregate({ trips, events, fleetIdx, driverIdx });
  return { regs, trips, events, tripsAll };
}

export async function buildFromApi({ user, pass, from, to, concurrency = 8, log = () => {}, url, padDays = 1 } = {}) {
  const { tok, fleet, roster, opts } = await openSession({ user, pass, url, log });
  const { regs, trips, events } = await fetchRangeRegs({ tok, fleet, roster, from, to, concurrency, log, opts, padDays });
  return { snapshot: buildSnapshot(regs, { fleet, driverRoster: roster, from, to }), regs, fleet, roster, trips, events };
}

// ---------- semanas ISO ----------
/** Lunes (UTC) de la semana ISO que contiene `fecha`. */
export function isoWeekStart(fecha) {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return ymd(d);
}
/** Lista de semanas ISO que cubren [from,to], cada una recortada al rango: [{semana,from,to,dias[]}] */
export function isoWeeksBetween(from, to) {
  const out = [];
  for (let cur = isoWeekStart(from); cur <= to; cur = shiftYmd(cur, 7)) {
    const wFrom = cur < from ? from : cur;
    const wEndFull = shiftYmd(cur, 6);
    const wTo = wEndFull > to ? to : wEndFull;
    if (wFrom > wTo) continue;
    const dias = [];
    for (let d = wFrom; d <= wTo; d = shiftYmd(d, 1)) dias.push(d);
    out.push({ semana: isoWeek(cur), from: wFrom, to: wTo, dias, completa: wFrom === cur && wTo === wEndFull });
  }
  return out;
}
export { shiftYmd };
