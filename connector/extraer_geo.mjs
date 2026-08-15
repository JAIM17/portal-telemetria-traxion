// extraer_geo.mjs — Rejilla geográfica de eventos, rescatada de los tramos crudos.
//
// Por qué existe
// -------------
// El 99.9% de los eventos trae lat/lng y hasta ahora no se usaba para NADA: el
// semanal v3 guarda conteos por operador×unidad×día y los tramos crudos (única
// fuente con la posición) se borran al consolidar. Guardar los ~200,000 puntos
// de cada tramo no es opción (70 MB por 2 días); guardar la REJILLA sí.
//
// Qué guarda
// ----------
// Celdas de 0.01° (~1.1 km) con el conteo por FAMILIA (aceleración, freno, giro,
// velocidad) y por SEVERIDAD (alto/medio/bajo), más las categorías extendidas que
// interesan geográficamente (ralentí, robo/pánico, combustible).
//
// Para qué sirve
// --------------
// Un punto rojo recurrente en un cruce no es un mal operador: es una curva mal
// señalizada, un tope sin pintar o un acceso mal diseñado. Sin esto, todos esos
// eventos se le cargan a la persona.
//
// Uso:
//   node connector/extraer_geo.mjs                    # todos los tramos en disco
// Idempotente: se puede correr las veces que sea (los tramos se suman por celda,
// deduplicando por tramo ya procesado).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { classifyEvent } from '../netlify/functions/lib/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
const TRAMOS = join(DIR, '.tramos');
const DESTINO = join(DIR, 'geo.json');
mkdirSync(DIR, { recursive: true });

const PREC = 2;                      // 0.01° ≈ 1.1 km
const FAM = { Ac: 'ac', Fr: 'fr', Gir: 'gir', Vel: 'vel' };
const SEV = { Alto: 'a', Med: 'm', Bajo: 'b' };
/* Extendidas que tienen sentido en un mapa: dónde se queda parado el motor,
   dónde se dispara el pánico, dónde cae el nivel de combustible. */
const EXT_GEO = {
  ralenti_5min: 'ral', ralenti_15min: 'ral', ralenti_20min: 'ral', ralenti_30min: 'ral',
  seguridad_robo: 'robo', fuel_caida: 'fuel_caida', fuel_carga: 'fuel_carga',
};

const celdaDe = (lat, lng) => lat.toFixed(PREC) + ',' + lng.toFixed(PREC);

/** Agrega una lista de eventos normalizados a un mapa de celdas. */
export function agregarGeo(events, celdas = new Map()) {
  for (const e of events || []) {
    if (e.lat == null || e.lng == null) continue;
    const lat = +e.lat, lng = +e.lng;
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
    const c = classifyEvent(e.name || '', { spn: e.spn });
    const extKey = c.ext && EXT_GEO[c.ext];
    if (!c.llave && !extKey) continue;          // sólo lo que se va a poder mirar
    const k = celdaDe(lat, lng);
    let cel = celdas.get(k);
    if (!cel) celdas.set(k, cel = { lat: +lat.toFixed(PREC), lng: +lng.toFixed(PREC), n: 0, fam: {}, sev: {}, ext: {}, placas: new Set() });
    cel.n++;
    if (e.placa) cel.placas.add(e.placa);
    if (c.llave) {
      const m = c.llave.match(/^(Ac|Fr|Gir|Vel)(Alto|Med|Bajo)$/);
      if (m) {
        const f = FAM[m[1]], s = SEV[m[2]];
        cel.fam[f] = (cel.fam[f] || 0) + 1;
        cel.sev[s] = (cel.sev[s] || 0) + 1;
      }
    } else if (extKey) cel.ext[extKey] = (cel.ext[extKey] || 0) + 1;
  }
  return celdas;
}

/** Fusiona celdas nuevas en el archivo acumulado. */
export function acumularGeo(celdas, tramo, destino = DESTINO) {
  let previo = { celdas: [], tramos: [] };
  if (existsSync(destino)) { try { previo = JSON.parse(readFileSync(destino, 'utf8')); } catch {} }
  const yaVisto = new Set(previo.tramos || []);
  if (tramo && yaVisto.has(tramo)) return { saltado: true, total: (previo.celdas || []).length };

  const idx = new Map();
  for (const c of previo.celdas || []) idx.set(c.lat.toFixed(PREC) + ',' + c.lng.toFixed(PREC), c);
  for (const [k, c] of celdas) {
    const p = idx.get(k);
    if (!p) { idx.set(k, { lat: c.lat, lng: c.lng, n: c.n, fam: c.fam, sev: c.sev, ext: c.ext, u: c.placas.size }); continue; }
    p.n += c.n;
    p.u = Math.max(p.u || 0, c.placas.size);   // aproximación: unidades distintas vistas
    for (const f in c.fam) p.fam[f] = (p.fam[f] || 0) + c.fam[f];
    for (const s in c.sev) p.sev[s] = (p.sev[s] || 0) + c.sev[s];
    for (const x in c.ext) p.ext[x] = (p.ext[x] || 0) + c.ext[x];
  }
  const lista = [...idx.values()].sort((a, b) => b.n - a.n);
  if (tramo) yaVisto.add(tramo);
  writeFileSync(destino, JSON.stringify({
    _doc: 'Rejilla de eventos de 0.01° (~1.1 km) rescatada de los tramos crudos antes de su borrado. ' +
          'fam = familia (ac/fr/gir/vel) · sev = severidad (a/m/b) · ext = ralentí, robo, combustible. ' +
          'Sirve para separar el punto negro de la RUTA del mal hábito del OPERADOR.',
    actualizado: new Date().toISOString(),
    precision_grados: 1 / Math.pow(10, PREC),
    celdas_totales: lista.length,
    eventos_totales: lista.reduce((s, c) => s + c.n, 0),
    tramos: [...yaVisto],
    celdas: lista,
  }));
  return { total: lista.length, eventos: lista.reduce((s, c) => s + c.n, 0) };
}

/* ------------------------------ CLI ------------------------------ */
if (process.argv[1] && process.argv[1].endsWith('extraer_geo.mjs')) {
  const archivos = existsSync(TRAMOS) ? readdirSync(TRAMOS).filter(f => f.endsWith('.json')) : [];
  if (!archivos.length) { console.log('no hay tramos en disco'); process.exit(0); }
  for (const f of archivos) {
    const j = JSON.parse(readFileSync(join(TRAMOS, f), 'utf8'));
    const celdas = agregarGeo(j.events);
    const r = acumularGeo(celdas, f);
    console.log(`  ${basename(f)} → ${r.saltado ? 'ya procesado' : celdas.size + ' celdas · acumulado ' + r.total}`);
  }
  const fin = JSON.parse(readFileSync(DESTINO, 'utf8'));
  console.log(`\n✓ ${fin.celdas_totales} celdas · ${fin.eventos_totales.toLocaleString('es-MX')} eventos → datos/historico/geo.json`);
}
