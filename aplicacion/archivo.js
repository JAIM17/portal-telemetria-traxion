/* ============================================================
   archivo.js — Lector del ARCHIVO HISTÓRICO LOCAL (navegador).

   Arquitectura acordada con el cliente (2026-07-23):
     · El histórico se baja UNA vez con connector/archivo_historico.mjs y vive en
       datos/historico/<YYYY-Www>.json (formato compacto v3, ver lib/codec.mjs).
     · El portal lee ESE archivo para todo lo pasado. Nunca vuelve a pegarle a la API.
     · Solo la semana en curso se refresca (releyendo su archivo, que el colector reescribe).

   Carga PEREZOSA: al arrancar solo se traen las últimas semanas con datos; el resto
   se piden cuando un filtro de periodo las necesita. Un archivo semanal pesa
   ~0.5–1 MB: con 33 semanas en el archivo, la carga ansiosa costaría decenas de
   MB en el arranque para datos que la mayoría de las sesiones nunca consulta.

   El módulo reutiliza el MISMO núcleo que el pipeline de Node
   (netlify/functions/lib/core.mjs): taxonomía UDN/cliente, agregación y la fórmula
   del score son una sola implementación, no una copia.
   ============================================================ */

import * as core from '../netlify/functions/lib/core.mjs';
import { desempacar } from '../netlify/functions/lib/codec.mjs';

const RUTA_INDICE = 'datos/historico/indice.json';
const RUTA_UDN_MAP = 'docs/udn-map.json';
const RUTA_FLOTA = 'datos/historico/flota.json';
const SEMANAS_INICIALES = 4;      // arranque: las N semanas con datos más recientes

const cache = new Map();          // semana → { registros, unidades, conductores }
const fallidas = new Set();       // semanas listadas en el índice pero ausentes/ilegibles

let INDICE = null;
let FLOTA = null;                 // padrón completo (opcional, datos/historico/flota.json)
let snapCache = null;             // { clave, snapshot }

const noCache = (u) => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();

async function leerJson(url, { obligatorio = true } = {}) {
  const r = await fetch(noCache(url), { cache: 'no-store' });
  if (!r.ok) {
    if (obligatorio) throw new Error(url + ' → HTTP ' + r.status);
    return null;
  }
  return r.json();
}

/* ---------------- índice ---------------- */

/** Semanas del índice que realmente tienen registros y no han fallado al leerse. */
function semanasConDatos() {
  if (!INDICE) return [];
  return (INDICE.semanas || []).filter(s => (s.registros || 0) > 0 && !fallidas.has(s.semana));
}

/** Semanas del índice cuyo rango [from,to] intersecta [desde,hasta] (cualquiera puede ser null). */
function semanasEnRango(desde, hasta) {
  return semanasConDatos().filter(s =>
    (!hasta || s.from <= hasta) && (!desde || s.to >= desde)).map(s => s.semana);
}

/* ---------------- taxonomía UDN / cliente ---------------- */

/* splitGrupo() es puro pero hace media docena de regex por llamada; hay ~8k registros
   por semana y solo ~55 grupos distintos, así que se memoiza por grupo. */
function taxonomiaDeGrupo() {
  const memo = new Map();
  return (grupo) => {
    const g = grupo || '';
    let s = memo.get(g);
    if (!s) { s = core.splitGrupo(g); memo.set(g, s); }
    return s;
  };
}

/* ---------------- rol del conductor (criterio del cliente 2026-07-24) -------------
 * En Traffilog el nombre lleva una INICIAL + PUNTO que codifica el rol. Esa gente
 * NO es plantilla de operadores, pero SÍ está rodando y ensuciando la telemetría,
 * así que no se esconde: se separa en su propio apartado.
 *
 *   P. → escuela        · aspirantes; se evalúan aparte para decidir su liberación
 *   M. → mantenimiento  ┐
 *   C. → coordinador    ├ "administrativos operativos": no son plantilla, pero
 *   A. → instructor     ┘  su operación cuenta y debe verse
 *
 * Es un MAPA editable a propósito: si mañana aparece otra inicial, se agrega aquí
 * y se propaga a todo el portal sin tocar ningún módulo.
 * ---------------------------------------------------------------------------- */
const ROL_POR_PREFIJO = { P: 'escuela', M: 'mantenimiento', C: 'coordinador', A: 'instructor' };
const ROLES_ADMIN = ['mantenimiento', 'coordinador', 'instructor'];
const ETIQUETA_ROL = {
  operador: 'Operador', escuela: 'Escuela', mantenimiento: 'Mantenimiento',
  coordinador: 'Coordinador', instructor: 'Instructor',
  administrativo: 'Administrativo operativo', sin_identificar: 'Viaje sin identificar',
};

function rolDeConductor(nombre, sinIdentificar) {
  const n = (nombre || '').trim();
  if (sinIdentificar || /^SIN OPERADOR/.test(n)) return 'sin_identificar';
  // "P.ANAYA…", "P. LEON…", "M.Mantenimiento", "M.M.DE LA CRUZ…"
  const m = n.match(/^([A-ZÑ])\.\s*\S/);
  if (m && ROL_POR_PREFIJO[m[1]]) return ROL_POR_PREFIJO[m[1]];
  // Nombres que son un CÓDIGO de nómina, no una persona (L089574, LS83547…):
  // tienen driver_id válido y hoy entran a rankings y scores como si fueran
  // operadores. Son 7 en el histórico cargado.
  if (/^[A-Z]{0,3}\d{3,}$/i.test(n)) return 'sin_identificar';
  return 'operador';
}
/* Agrupador para la vista: los tres roles no-escuela caen en un solo apartado. */
function grupoDeRol(rol) { return ROLES_ADMIN.indexOf(rol) >= 0 ? 'administrativo' : rol; }

/* ---------------- carga de una semana ---------------- */

async function cargarSemana(id) {
  if (cache.has(id) || fallidas.has(id)) return;
  const meta = (INDICE.semanas || []).find(s => s.semana === id);
  if (!meta) { fallidas.add(id); return; }
  let compacto;
  try { compacto = await leerJson(meta.archivo, { obligatorio: false }); }
  catch { compacto = null; }
  if (!compacto) {
    // El índice se escribe tras cada semana; un archivo puede aún no existir o haberse
    // podado por venir vacío. No es un error fatal: el portal sigue con lo que sí hay.
    console.warn('[archivo] semana no disponible:', id);
    fallidas.add(id);
    return;
  }
  let registros;
  try { registros = desempacar(compacto); }
  catch (e) { console.warn('[archivo] ' + id + ': ' + e.message); fallidas.add(id); return; }

  // El formato compacto guarda solo el GRUPO CRUDO de la API ("YAZAKI COLIMA"), que
  // mezcla cliente y plaza. La taxonomía UDN/cliente se deriva aquí con el MISMO
  // core.splitGrupo() del pipeline (que ya aplica docs/udn-map.json vía setUdnMap).
  //
  // Es obligatorio: sin este paso los registros llegan a los módulos con `udn`
  // indefinido, los filtros por plaza salen vacíos y el portal aparenta cubrir
  // una sola UDN.
  // ---- SIDECAR DE RALENTÍ (connector/enriquecer_extendido.mjs) ----------------
  // `horas` del formato v3 es tiempo BRUTO (end_time − start_time): lleva el ralentí
  // DENTRO. El sidecar trae el ralentí real medido por la unidad (idle_time de
  // get_vehicle_trips_extended) para poder separar conducción de motor-encendido-parado.
  // Es opcional: si la semana aún no está enriquecida, el portal sigue igual que antes
  // y `ralenti` queda en null (que NO es lo mismo que cero — hay que poder distinguirlo).
  let idle = null;
  try {
    const sc = await leerJson(meta.archivo.replace(/\.json$/, '.ralenti.json'), { obligatorio: false });
    if (sc && Array.isArray(sc.filas)) {
      idle = new Map(sc.filas.map(f => [f[0], { ralenti: f[1], motor: f[2], bruto: f[3], odometro: f[5] }]));
    }
  } catch {}

  // ---- SIDECAR DE RE-ATRIBUCIÓN (connector/reatribuir_eventos.mjs) -----------
  // Traffilog borra el chofer de los EVENTOS ~30 días atrás (los viajes no):
  // el backfill del año trajo los eventos huérfanos en "SIN OPERADOR" y todo
  // operador calificaba 95 plano en semanas viejas. El sidecar los devuelve por
  // inferencia unidad-día (76% exacto, 18% proporcional a horas). Aquí se SUMA
  // al operador y se RESTA del "SIN OPERADOR" del mismo unidad-día; el receptor
  // queda marcado (`evInferidos`) porque esto mueve scores personales y no
  // puede pasar por dato observado.
  let reatrib = null;
  try {
    const rj = await leerJson(meta.archivo.replace(/\.json$/, '.reatrib.json'), { obligatorio: false });
    if (rj && Array.isArray(rj.filas)) reatrib = rj;
  } catch {}
  if (reatrib) {
    const porKey = new Map(), sinopUD = new Map();
    for (const r of registros) {
      porKey.set(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''), r);
      if (!r.driver_id || /^SIN OPERADOR/.test(r.conductor || '')) sinopUD.set(r.fecha + '|' + r.vehicle_id, r);
    }
    for (const [k, ev, ext] of reatrib.filas) {
      const dest = porKey.get(k);
      if (!dest) continue;
      const [fecha, , veh] = k.split('|');
      const sinop = sinopUD.get(fecha + '|' + veh);
      for (const nombre in ev) {
        dest.eventos[nombre] = (dest.eventos[nombre] || 0) + ev[nombre];
        if (sinop && sinop.eventos[nombre]) sinop.eventos[nombre] = Math.max(0, sinop.eventos[nombre] - ev[nombre]);
      }
      for (const nombre in ext) {
        dest.extendido[nombre] = (dest.extendido[nombre] || 0) + ext[nombre];
        if (sinop && sinop.extendido[nombre]) sinop.extendido[nombre] = Math.max(0, sinop.extendido[nombre] - ext[nombre]);
      }
      dest.evInferidos = true;
    }
  }

  const tax = taxonomiaDeGrupo();
  for (const r of registros) {
    const s = tax(r.grupo); r.udn = s.udn; r.cliente = s.cliente;
    if (idle) {
      const e = idle.get(r.fecha + '|' + (r.driver_id || '') + '|' + (r.vehicle_id || ''));
      if (e) {
        r.ralenti = e.ralenti;                       // h con motor encendido y parado
        r.horasMotor = e.motor || null;
        r.odometro = e.odometro || null;
        // Horas NETAS de conducción. Se apoya en `horas` (bruto del v3) y no en el
        // `bruto` del sidecar para no mezclar dos mediciones distintas del mismo día.
        r.horasNetas = Math.max(0, (r.horas || 0) - e.ralenti);
      }
    }
    // CRITERIO CENTRAL (petición del cliente 2026-07-24): "SIN OPERADOR (unidad)"
    // NO es un operador — es un VIAJE SIN IDENTIFICAR (nadie se logueó). Se marca
    // aquí, una sola vez, y TODOS los módulos leen esta bandera: los KPIs y
    // rankings de personas cuentan solo operadores reales; la telemetría del
    // viaje se conserva agregada por UNIDAD (snapshot.viajesSinIdentificar).
    r.sinIdentificar = !r.driver_id || /^SIN OPERADOR/.test(r.conductor || '');
    r.rol = rolDeConductor(r.conductor, r.sinIdentificar);
    r.esOperador = r.rol === 'operador';        // ← lo único que cuenta como PLANTILLA
  }

  const grupos = compacto.ref.grupos || [];
  const unidades = (compacto.ref.unidades || []).map(u => {
    const g = u.g >= 0 ? grupos[u.g] : '';
    const s = tax(g);
    return { vehicle_id: u.id, placa: u.p, grupo: g, udn: s.udn, cliente: s.cliente };
  });
  const conductores = (compacto.ref.conductores || []).map(c => ({
    driver_id: c.id, conductor: c.n, worker_id: c.wid, grupo: '',
  }));
  cache.set(id, { registros, unidades, conductores, parcial: !!compacto.parcial });
  snapCache = null;
}

/* ---------------- construcción del snapshot v2 ---------------- */

function construir() {
  const ids = [...cache.keys()].sort();
  const clave = ids.join(',');
  if (snapCache && snapCache.clave === clave) return snapCache.snapshot;

  const registros = [];
  const uniIdx = new Map();
  const condIdx = new Map();
  const ultimaVista = new Map();    // conductor → última semana con actividad (ids van ordenados)
  for (const id of ids) {
    const w = cache.get(id);
    for (const r of w.registros) {
      registros.push(r);
      if (!r.sinIdentificar) ultimaVista.set(r.conductor, id);
    }
    for (const u of w.unidades) if (!uniIdx.has(u.vehicle_id || u.placa)) uniIdx.set(u.vehicle_id || u.placa, u);
    for (const c of w.conductores) if (!condIdx.has(c.conductor)) condIdx.set(c.conductor, { ...c });
  }
  // El grupo del chofer no viaja en el formato compacto: se deduce del grupo que más
  // veces aparece en sus propios registros. Sin esto todos los operadores salían
  // "Sin asignar" en el roster (y el cliente lo leía como "no hay UDN").
  const votos = new Map();
  for (const r of registros) {
    if (!r.grupo) continue;
    let m = votos.get(r.conductor);
    if (!m) votos.set(r.conductor, m = new Map());
    m.set(r.grupo, (m.get(r.grupo) || 0) + 1);
  }
  for (const [nombre, m] of votos) {
    const c = condIdx.get(nombre);
    if (!c) continue;
    c.grupo = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Padrón de unidades/operadores: MERGE padrón ∪ observado (2026-07-28).
  // Antes era excluyente (flota.json O lo observado): un padrón parcial
  // escondía flota real. Ahora el padrón manda en atributos, pero lo observado
  // en las semanas cargadas nunca desaparece. FLOTA puede venir de flota.json
  // o del Excel importado por el usuario (ARCHIVO.setPadron / localStorage).
  const fleet = [...uniIdx.values()];
  if (FLOTA && FLOTA.unidades && FLOTA.unidades.length) {
    const porClave = new Map(fleet.map(u => [String(u.vehicle_id || u.placa), u]));
    for (const u of FLOTA.unidades) {
      const k = String(u.vehicle_id || u.placa || '');
      if (!k) continue;
      // la UDN/cliente EXPLÍCITOS del padrón mandan; splitGrupo solo rellena huecos
      const s = core.splitGrupo(u.grupo || '');
      const n = { ...u, udn: u.udn || s.udn, cliente: u.cliente || s.cliente };
      const prev = porClave.get(k);
      if (prev) Object.assign(prev, n);
      else { porClave.set(k, n); fleet.push(n); }
    }
  }
  const roster = [...condIdx.values()];
  if (FLOTA && FLOTA.conductores && FLOTA.conductores.length) {
    const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const porNombre = new Map(roster.map(c => [norm(c.conductor), c]));
    for (const c of FLOTA.conductores) {
      const k = norm(c.conductor);
      if (!k) continue;
      const prev = porNombre.get(k);
      if (prev) Object.assign(prev, c);
      else { porNombre.set(k, { ...c }); roster.push({ ...c }); }
    }
  }

  const desde = ids.length ? (INDICE.semanas.find(s => s.semana === ids[0]) || {}).from : '';
  const hasta = ids.length ? (INDICE.semanas.find(s => s.semana === ids[ids.length - 1]) || {}).to : '';

  const snapshot = core.buildSnapshot(registros, {
    fleet, driverRoster: roster, from: desde, to: hasta,
    source: 'archivo-local:' + (INDICE.cobertura ? INDICE.cobertura.desde + '→' + INDICE.cobertura.hasta : 'histórico'),
  });

  // ---- DOS POBLACIONES (criterio central, ver cargarSemana) -------------
  // `operadoresReales`: personas con nombre/driver_id — lo único que cuentan
  // los KPIs de "operadores", rankings, listas y acordeones de los módulos.
  // `viajesSinIdentificar`: la telemetría de los viajes sin logueo, agregada
  // por UNIDAD (no se tira: es el indicador de disciplina de logueo y entra
  // al daño de la unidad, aunque no sepamos quién condujo).
  const esFantasma = (n) => /^SIN OPERADOR/.test(n || '');
  snapshot.operadoresReales = (snapshot.drivers || []).filter(d => !esFantasma(d.conductor));
  snapshot.drivers = snapshot.operadoresReales;
  for (const d of snapshot.drivers) { d.rol = rolDeConductor(d.conductor); d.esOperador = d.rol === 'operador'; }
  for (const t of snapshot.trips || []) t.sinIdentificar = esFantasma(t.conductor);
  for (const e of snapshot.events || []) e.sinIdentificar = esFantasma(e.conductor);
  if (snapshot.scores) {
    snapshot.scores.por_operador = (snapshot.scores.por_operador || []).filter(s => !esFantasma(s.conductor));
    snapshot.scores.por_operador_semana = (snapshot.scores.por_operador_semana || []).filter(s => !esFantasma(s.conductor));
    for (const s of snapshot.scores.por_operador) s.rol = rolDeConductor(s.conductor);
    for (const s of snapshot.scores.por_operador_semana) s.rol = rolDeConductor(s.conductor);
  }
  // ---- ESTADO DE ACTIVIDAD POR OPERADOR (petición del cliente 2026-07-27) --
  // "Activo" es RECENCIA, no volumen: un operador con 1,000 h en el año pero
  // 6 semanas sin señal es POSIBLE BAJA para efectos de decisiones. Mismo
  // criterio que connector/censo_actividad.mjs (censo.json): el gap se mide
  // contra la ÚLTIMA semana del ARCHIVO (no la última cargada) para que el
  // estado no dependa de qué semanas tenga abiertas el usuario.
  //   gap ≤1 → activo · 2–4 → inactivo · ≥5 → posible_baja
  const semanasArchivo = semanasConDatos().map(s => s.semana).sort();
  const idxSemana = new Map(semanasArchivo.map((s, i) => [s, i]));
  const idxUltima = semanasArchivo.length - 1;
  const estadoDeGap = (g) => g <= 1 ? 'activo' : g <= 4 ? 'inactivo' : 'posible_baja';
  const estadoOperador = {};
  for (const [nombre, sem] of ultimaVista) {
    // Semana cargada pero ya no listada en el índice: sin referencia fiable → activo.
    const gap = idxUltima - (idxSemana.has(sem) ? idxSemana.get(sem) : idxUltima);
    estadoOperador[nombre] = { estado: estadoDeGap(gap), ultimaSemana: sem, semanasSin: gap };
  }
  snapshot.estadoOperador = estadoOperador;
  for (const d of snapshot.drivers) d.estado = (estadoOperador[d.conductor] || {}).estado || null;
  if (snapshot.scores) {
    for (const s of snapshot.scores.por_operador) s.estado = (estadoOperador[s.conductor] || {}).estado || null;
  }

  // ---- PLANTILLA vs NO-PLANTILLA -----------------------------------------
  // Escuela (P.) y administrativos operativos (M./C./A.) NO son plantilla, pero
  // ruedan y su telemetría afecta a la flota: se agregan aparte para que se vean,
  // no para esconderlos.  snapshot.porRol[rol] = { personas, viajes, horas, km, dias }
  const porRol = {};
  const nombresPorRol = {};
  const acumRol = (rol, r) => {
    const a = porRol[rol] || (porRol[rol] = { rol, etiqueta: ETIQUETA_ROL[rol] || rol, personas: 0, viajes: 0, horas: 0, km: 0, eventos: 0 });
    const set = nombresPorRol[rol] || (nombresPorRol[rol] = new Set());
    set.add(r.conductor);
    a.viajes += r.viajes || 0; a.horas += r.horas || 0; a.km += r.km || 0;
    if (r.ralenti != null) { a.ralenti = (a.ralenti || 0) + r.ralenti; a.conRalenti = (a.conRalenti || 0) + 1; }
    for (const key in (r.eventos || {})) a.eventos += r.eventos[key] || 0;
  };
  const porUnidad = new Map();
  const reales = new Set();
  let viajesSin = 0, viajesTot = 0, horasSin = 0;
  for (const r of registros) {
    viajesTot += r.viajes || 0;
    acumRol(grupoDeRol(r.rol || rolDeConductor(r.conductor, r.sinIdentificar)), r);
    if (!r.sinIdentificar) { if (r.esOperador) reales.add(r.conductor); continue; }
    viajesSin += r.viajes || 0; horasSin += r.horas || 0;
    const k = r.placa || r.vehicle_id || '?';
    let u = porUnidad.get(k);
    if (!u) porUnidad.set(k, u = { placa: r.placa || '', vehicle_id: r.vehicle_id || '',
      grupo: r.grupo || '', udn: r.udn || '', cliente: r.cliente || '',
      viajes: 0, horas: 0, km: 0, eventos: 0, dias: new Set() });
    u.viajes += r.viajes || 0; u.horas += r.horas || 0; u.km += r.km || 0;
    for (const key in (r.eventos || {})) u.eventos += r.eventos[key] || 0;
    if (r.fecha) u.dias.add(r.fecha);
  }
  snapshot.viajesSinIdentificar = [...porUnidad.values()]
    .map(u => ({ ...u, horas: +u.horas.toFixed(2), km: +u.km.toFixed(1), dias: u.dias.size }))
    .sort((a, b) => b.viajes - a.viajes);
  for (const rol in porRol) {
    porRol[rol].personas = nombresPorRol[rol].size;
    porRol[rol].horas = +porRol[rol].horas.toFixed(1);
    porRol[rol].km = +porRol[rol].km.toFixed(1);
  }
  snapshot.porRol = porRol;
  // Nómina de los que NO son plantilla, para poder listarlos en su apartado.
  snapshot.noPlantilla = Object.keys(nombresPorRol)
    .filter(rol => rol !== 'operador' && rol !== 'sin_identificar')
    .map(rol => ({ rol, etiqueta: ETIQUETA_ROL[rol] || rol, nombres: [...nombresPorRol[rol]].sort() }));

  snapshot.meta.operadores_brutos = snapshot.meta.operadores;
  // Con el año entero cargado, contar a cualquiera del rango infla la plantilla
  // con bajas: `operadores` son SOLO los activos (actividad ≤2 semanas);
  // el total del rango queda en `operadores_historicos`.
  let opActivos = 0, opInactivos = 0, opBajas = 0;
  for (const n of reales) {
    const e = (estadoOperador[n] || {}).estado;
    if (e === 'inactivo') opInactivos++;
    else if (e === 'posible_baja') opBajas++;
    else opActivos++;
  }
  snapshot.meta.operadores_historicos = reales.size;            // total del rango cargado
  snapshot.meta.operadores = opActivos;                         // PLANTILLA productiva (activos)
  snapshot.meta.operadores_inactivos = opInactivos;
  snapshot.meta.operadores_posible_baja = opBajas;
  snapshot.meta.escuela = (porRol.escuela || {}).personas || 0;
  snapshot.meta.administrativos = (porRol.administrativo || {}).personas || 0;

  // ---- RALENTÍ DE FLOTA -----------------------------------------------------
  // Sólo se publica si hay cobertura del sidecar; si no, queda en null para que la UI
  // muestre "sin medir" en vez de un cero que se leería como "no hay ralentí".
  // Los parámetros de costo son de operación, no del código: se ajustan aquí.
  const COSTO = { litros_por_hora: 3.0, mxn_por_litro: 26.0 };
  let ralentiTot = 0, brutoConRalenti = 0, regsConRalenti = 0;
  for (const r of registros) {
    if (r.ralenti == null) continue;
    ralentiTot += r.ralenti; brutoConRalenti += r.horas || 0; regsConRalenti++;
  }
  snapshot.ralenti = regsConRalenti ? {
    horas: +ralentiTot.toFixed(1),
    horas_netas: +(brutoConRalenti - ralentiTot).toFixed(1),
    pct: +(ralentiTot / brutoConRalenti * 100).toFixed(1),
    litros: Math.round(ralentiTot * COSTO.litros_por_hora),
    mxn: Math.round(ralentiTot * COSTO.litros_por_hora * COSTO.mxn_por_litro),
    cobertura_pct: +(regsConRalenti / registros.length * 100).toFixed(1),
    parametros: COSTO,
  } : null;
  snapshot.meta.viajes_totales = viajesTot;
  snapshot.meta.viajes_sin_identificar = viajesSin;
  snapshot.meta.horas_sin_identificar = +horasSin.toFixed(1);

  // Metadatos propios del archivo (no los produce buildSnapshot)
  snapshot.archivo = {
    cuenta: (FLOTA && FLOTA.cuenta) || 'regional',
    semanas_cargadas: ids,
    semanas_disponibles: semanasConDatos().map(s => s.semana),
    cobertura: INDICE.cobertura || null,
    semana_actual: INDICE.semana_actual || null,
    actualizado: INDICE.actualizado || null,
  };
  // Todas las semanas del archivo (no solo las cargadas) para el filtro nº 8.
  snapshot.semanas = snapshot.archivo.semanas_disponibles.slice();
  // Tamaño de la flota de la cuenta, tal y como lo reportó la API al descargar.
  snapshot.meta.unidades_padron = Math.max(
    fleet.length, ...(INDICE.semanas || []).map(s => s.unidades || 0));
  snapshot.updated_at = INDICE.actualizado || new Date().toISOString();

  snapCache = { clave, snapshot };
  return snapshot;
}

/* ---------------- API pública ---------------- */

const LS_PADRON = 'padron_importado_v1';

/** Fusiona un padrón sobre FLOTA (unidades por vehicle_id/placa, conductores por nombre). */
function fusionarPadron(base, extra) {
  const out = { unidades: [...(base && base.unidades || [])], conductores: [...(base && base.conductores || [])] };
  const uIdx = new Map(out.unidades.map(u => [String(u.vehicle_id || u.placa), u]));
  for (const u of (extra && extra.unidades || [])) {
    const k = String(u.vehicle_id || u.placa || '');
    if (!k) continue;
    const prev = uIdx.get(k);
    if (prev) Object.assign(prev, u); else { uIdx.set(k, { ...u }); out.unidades.push({ ...u }); }
  }
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const cIdx = new Map(out.conductores.map(c => [norm(c.conductor), c]));
  for (const c of (extra && extra.conductores || [])) {
    const k = norm(c.conductor);
    if (!k) continue;
    const prev = cIdx.get(k);
    if (prev) Object.assign(prev, c); else { cIdx.set(k, { ...c }); out.conductores.push({ ...c }); }
  }
  return out;
}

const ARCHIVO = {
  /** Carga índice + mapa UDN + padrón. Debe llamarse antes que nada. */
  async iniciar() {
    const mapa = await leerJson(RUTA_UDN_MAP, { obligatorio: false }).catch(() => null);
    if (mapa) core.setUdnMap(mapa);
    else console.warn('[archivo] docs/udn-map.json no disponible: la UDN saldrá solo de las pistas del nombre');
    FLOTA = await leerJson(RUTA_FLOTA, { obligatorio: false }).catch(() => null);
    // Padrón importado por el usuario (Excel → localStorage): se fusiona SOBRE
    // flota.json (si existe) y sobrevive a las recargas hasta que se quite.
    try {
      const p = JSON.parse(localStorage.getItem(LS_PADRON) || 'null');
      if (p && (p.unidades || p.conductores)) FLOTA = fusionarPadron(FLOTA, p);
    } catch {}
    INDICE = await leerJson(RUTA_INDICE);
    snapCache = null;
    return INDICE;
  },

  /** Fusiona un padrón importado (Excel) y lo persiste. Devuelve conteos. */
  setPadron(p, origen) {
    const previo = (() => { try { return JSON.parse(localStorage.getItem(LS_PADRON) || 'null'); } catch { return null; } })();
    const nuevo = fusionarPadron(previo, p);
    nuevo.generado = new Date().toISOString();
    nuevo.origen = origen || '';
    try { localStorage.setItem(LS_PADRON, JSON.stringify(nuevo)); }
    catch (e) { console.warn('[archivo] padrón no cupo en localStorage:', e.message); }
    FLOTA = fusionarPadron(FLOTA, nuevo);
    snapCache = null;
    return { unidades: nuevo.unidades.length, conductores: nuevo.conductores.length };
  },

  /** Quita el padrón importado (no toca flota.json si existiera). */
  quitarPadron() {
    try { localStorage.removeItem(LS_PADRON); } catch {}
    FLOTA = null;   // se repobla de flota.json en la próxima carga; el snapshot cae al observado
    snapCache = null;
  },

  get padronImportado() {
    try { return JSON.parse(localStorage.getItem(LS_PADRON) || 'null'); } catch { return null; }
  },

  /** Relee el índice (el colector lo reescribe tras cada semana) y refresca la semana en curso. */
  async refrescar() {
    INDICE = await leerJson(RUTA_INDICE);
    const actual = INDICE.semana_actual;
    if (actual && cache.has(actual)) { cache.delete(actual); fallidas.delete(actual); await cargarSemana(actual); }
    snapCache = null;
    return INDICE;
  },

  get indice() { return INDICE; },
  get disponibles() { return semanasConDatos(); },
  get cargadas() { return [...cache.keys()].sort(); },
  semanasEnRango,

  /** Asegura que estén cargadas las semanas indicadas. Devuelve true si algo nuevo entró. */
  async asegurar(ids) {
    const faltan = [...new Set(ids)].filter(id => !cache.has(id) && !fallidas.has(id));
    if (!faltan.length) return false;
    // en paralelo pero de a pocas: son archivos de ~1 MB
    for (let i = 0; i < faltan.length; i += 4) {
      await Promise.all(faltan.slice(i, i + 4).map(cargarSemana));
    }
    return true;
  },

  /** Asegura las semanas que cubren [desde,hasta]. null = sin límite por ese lado. */
  async asegurarRango(desde, hasta) {
    return ARCHIVO.asegurar(semanasEnRango(desde, hasta));
  },

  /** Arranque: las últimas N semanas con datos. */
  async asegurarRecientes(n) {
    const todas = semanasConDatos().map(s => s.semana);
    return ARCHIVO.asegurar(todas.slice(-(n || SEMANAS_INICIALES)));
  },

  /** Todo el histórico disponible (lo pide el usuario explícitamente). */
  async asegurarTodo() {
    return ARCHIVO.asegurar(semanasConDatos().map(s => s.semana));
  },

  /** Snapshot v2 (DATA_CONTRACT.md) con lo que haya cargado. */
  snapshot: construir,

  core,
};

window.ARCHIVO = ARCHIVO;
window.dispatchEvent(new Event('archivo-listo'));
export default ARCHIVO;
