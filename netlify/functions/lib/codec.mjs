// codec.mjs — Formato compacto del archivo histórico semanal.
//
// Problema: un snapshot semanal crudo pesa ~15 MB (945 unidades, ~7,700 registros/semana).
// A 30 semanas serían ~450 MB — imposible de versionar y de servir al portal.
//
// Solución: guardar SOLO `registros` (el agregado atómico; trips/events/scores se recalculan)
// en forma columnar con tablas de referencia. Reduce ~10x sin perder un solo dato.
//
// Formato v3:
//   { v:3, semana, from, to, parcial, generado,
//     ref: { conductores:[{n,id,wid}], unidades:[{p,id,g}], grupos:[str], ext:[str], cat:[str], sev:[str] },
//     regs: [ [dia, condIdx, uniIdx, viajes, horas, km, ev12[], extPairs[], catPairs[], sevPairs[], dtc[]] ] }
//
// `dia` es el offset en días desde `from` (0..6). ev12 son las 12 llaves del score en el orden
// de LLAVES; los pares son [idx, cantidad] y se omiten los ceros.

import { LLAVES, isoWeek } from './core.mjs';

const idxOf = (arr, map, key, make) => {
  let i = map.get(key);
  if (i === undefined) { i = arr.length; arr.push(make()); map.set(key, i); }
  return i;
};
const paresDe = (obj, tabla, mapa) => {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (!v) continue;
    out.push([idxOf(tabla, mapa, k, () => k), v]);
  }
  return out;
};

const diaOffset = (fecha, from) =>
  Math.round((Date.parse(fecha + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);
const offsetDia = (off, from) =>
  new Date(Date.parse(from + 'T00:00:00Z') + off * 864e5).toISOString().slice(0, 10);

/** snapshot completo → objeto compacto v3 */
export function empacar(snap) {
  const from = snap.from;
  const conductores = [], cMap = new Map();
  const unidades = [], uMap = new Map();
  const grupos = [], gMap = new Map();
  const ext = [], eMap = new Map();
  const cat = [], catMap = new Map();
  const sev = [], sMap = new Map();

  const regs = (snap.registros || []).map(r => {
    const ci = idxOf(conductores, cMap, r.driver_id || r.conductor,
      () => ({ n: r.conductor, id: r.driver_id || '', wid: r.worker_id || '' }));
    const gi = r.grupo ? idxOf(grupos, gMap, r.grupo, () => r.grupo) : -1;
    const ui = idxOf(unidades, uMap, r.vehicle_id || r.placa,
      () => ({ p: r.placa || '', id: r.vehicle_id || '', g: gi }));
    return [
      diaOffset(r.fecha, from), ci, ui,
      r.viajes || 0, +(r.horas || 0).toFixed(4), +(r.km || 0).toFixed(2),
      LLAVES.map(k => r.eventos?.[k] || 0),
      paresDe(r.extendido, ext, eMap),
      paresDe(r.categorias, cat, catMap),
      paresDe(r.severidades, sev, sMap),
      r.dtc?.length ? r.dtc : 0,
      /* El grupo va POR REGISTRO, no por unidad. Una misma unidad puede cambiar
         de cliente dentro del periodo, así que un diccionario unidad→grupo fija
         el primer grupo visto y etiqueta mal el resto (≈2% de los registros en
         un periodo semanal típico). El campo `g` de la unidad se mantiene por
         compatibilidad con lectores anteriores a este formato. */
      gi,
    ];
  });

  return {
    v: 3, semana: snap.semana, from, to: snap.to,
    parcial: !!snap.parcial, generado: snap.generado,
    meta: snap.meta ? { operadores: snap.meta.operadores, unidades: snap.meta.unidades, eventos: snap.meta.eventos } : undefined,
    ref: { conductores, unidades, grupos, ext, cat, sev },
    regs,
  };
}

/** objeto compacto v3 → arreglo de registros (misma forma que produce el pipeline) */
export function desempacar(c) {
  if (!c || c.v !== 3) throw new Error('formato no reconocido (se esperaba v3)');
  const { conductores, unidades, grupos, ext, cat, sev } = c.ref;
  const desPares = (pares, tabla) => {
    const o = {};
    for (const [i, n] of pares || []) o[tabla[i]] = n;
    return o;
  };
  return c.regs.map(([off, ci, ui, viajes, horas, km, ev, xe, xc, xs, dtc, gi]) => {
    const cond = conductores[ci], uni = unidades[ui];
    const eventos = {};
    LLAVES.forEach((k, i) => { eventos[k] = ev[i] || 0; });
    const fecha = offsetDia(off, c.from);
    return {
      /* Un archivo semanal trae `semana` en la cabecera; un snapshot compactado
         que abarca VARIAS semanas (el que sirve /api/traffilog) no puede: ahí la
         semana se deriva de la fecha, que es de donde salía en el pipeline. */
      fecha, semana: c.semana || isoWeek(fecha),
      driver_id: cond.id, conductor: cond.n, worker_id: cond.wid,
      vehicle_id: uni.id, placa: uni.p,
      /* gi (por registro) manda; los archivos escritos antes del 2026-08-13 no lo
         traen y caen al grupo de la unidad, que es lo que había. */
      grupo: (gi === undefined ? uni.g : gi) >= 0 ? grupos[gi === undefined ? uni.g : gi] : '',
      viajes, horas, km, eventos,
      extendido: desPares(xe, ext), categorias: desPares(xc, cat), severidades: desPares(xs, sev),
      dtc: dtc || [],
    };
  });
}
