// generar_rollups.mjs — FASE 2 de la escalabilidad: agregados precalculados.
//
// El problema que resuelve: hoy el navegador baja el registro CRUDO (7,900 por
// semana, uno por operador × unidad × día) y reagrega todo en el cliente para
// pintar cada KPI. Con 945 unidades funciona; a escala nacional (~10,000) ni el
// ancho de banda ni el navegador aguantan.
//
// Este script deja precalculado, por semana, el total por UDN, por cliente y por
// operador. Son unos KB contra ~900 KB del archivo semanal: los tableros pueden
// abrir con esto y bajar el registro crudo SOLO cuando alguien abre un detalle.
//
// No toca ni reemplaza nada: escribe en datos/rollups/ y el portal sigue leyendo
// lo de siempre. El cambio de la UI es un paso aparte y deliberado.
//
// Uso:
//   node connector/generar_rollups.mjs              # todas las semanas
//   node connector/generar_rollups.mjs --semana 2026-W33

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../netlify/functions/lib/core.mjs';
import { desempacar } from '../netlify/functions/lib/codec.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
const OUT = join(raiz, 'datos', 'rollups');
mkdirSync(OUT, { recursive: true });

// La UDN y el cliente no viven en el registro: salen del grupo vía la taxonomía
// del pipeline (docs/udn-map.json). Sin esto los rollups saldrían con udn vacía.
try { core.setUdnMap(JSON.parse(readFileSync(join(raiz, 'docs', 'udn-map.json'), 'utf8'))); }
catch { console.warn('aviso: docs/udn-map.json no disponible; la UDN saldrá solo de las pistas del nombre'); }

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const soloSemana = arg('--semana');

const vacio = () => ({ registros: 0, viajes: 0, horas: 0, km: 0, eventos: 0, ptsSeg: 0, operadores: new Set(), unidades: new Set() });
const sumar = (a, r, ev) => {
  a.registros++; a.viajes += r.viajes || 0; a.horas += r.horas || 0; a.km += r.km || 0; a.eventos += ev;
  if (r.driver_id) a.operadores.add(r.driver_id);
  if (r.vehicle_id) a.unidades.add(r.vehicle_id);
};
const cerrar = (a) => ({
  registros: a.registros, viajes: a.viajes,
  horas: +a.horas.toFixed(2), km: +a.km.toFixed(1), eventos: a.eventos,
  operadores: a.operadores.size, unidades: a.unidades.size,
  evPor100h: a.horas > 0 ? +(a.eventos * 100 / a.horas).toFixed(2) : null,
});
const enMapa = (mapa, llave) => { if (!mapa.has(llave)) mapa.set(llave, vacio()); return mapa.get(llave); };

function rollupDeSemana(archivo) {
  const compacto = JSON.parse(readFileSync(join(DIR, archivo), 'utf8'));
  const regs = desempacar(compacto);
  const total = vacio(), porUdn = new Map(), porCliente = new Map(), porOperador = new Map();

  for (const r of regs) {
    const t = core.splitGrupo(r.grupo || '');
    const ev = Object.values(r.eventos || {}).reduce((s, n) => s + n, 0);
    sumar(total, r, ev);
    sumar(enMapa(porUdn, t.udn || 'Sin asignar'), r, ev);
    sumar(enMapa(porCliente, t.cliente || 'Sin asignar'), r, ev);
    if (r.conductor) {
      const a = enMapa(porOperador, r.driver_id || r.conductor);
      sumar(a, r, ev);
      a.nombre = r.conductor; a.udn = t.udn || 'Sin asignar';
    }
  }

  const objeto = (m, extra) => Object.fromEntries([...m].map(([k, v]) => [k, extra ? { ...cerrar(v), nombre: v.nombre, udn: v.udn } : cerrar(v)]));
  const cabecera = { v: 1, semana: compacto.semana, from: compacto.from, to: compacto.to, generado: new Date().toISOString() };
  return {
    /* DOS archivos a propósito: el tablero abre con `panel` (unos KB, sin datos
       personales) y la tabla de operadores se baja solo cuando alguien la pide.
       Juntos pesaban 260 KB por semana y el 97 % era el detalle por operador. */
    panel: { ...cabecera, total: cerrar(total), udn: objeto(porUdn), cliente: objeto(porCliente) },
    operadores: { ...cabecera, operador: objeto(porOperador, true) },
  };
}

const archivos = readdirSync(DIR)
  .filter((n) => /^\d{4}-W\d{2}\.json$/.test(n))
  .filter((n) => !soloSemana || n === soloSemana + '.json')
  .sort();

if (!archivos.length) { console.error('no hay semanas que procesar'); process.exit(1); }

let pesoIn = 0, pesoPanel = 0, pesoOps = 0;
const indice = [];
for (const a of archivos) {
  const { panel, operadores } = rollupDeSemana(a);
  const jsPanel = JSON.stringify(panel), jsOps = JSON.stringify(operadores);
  writeFileSync(join(OUT, a), jsPanel);
  writeFileSync(join(OUT, a.replace(/\.json$/, '.operadores.json')), jsOps);
  const inBytes = readFileSync(join(DIR, a)).length;
  pesoIn += inBytes; pesoPanel += Buffer.byteLength(jsPanel); pesoOps += Buffer.byteLength(jsOps);
  indice.push({ semana: panel.semana, from: panel.from, to: panel.to, registros: panel.total.registros, operadores: panel.total.operadores });
  console.log(`${panel.semana}  ${String(panel.total.registros).padStart(5)} regs → panel ${(Buffer.byteLength(jsPanel) / 1024).toFixed(1)} KB · operadores ${(Buffer.byteLength(jsOps) / 1024).toFixed(0)} KB (semanal: ${(inBytes / 1024).toFixed(0)} KB)`);
}
writeFileSync(join(OUT, 'indice.json'), JSON.stringify({ v: 1, generado: new Date().toISOString(), semanas: indice }));

const kb = (b) => (b / 1024).toFixed(0) + ' KB';
console.log(`\n✓ ${archivos.length} semanas`);
console.log(`  archivo semanal actual : ${(pesoIn / 1048576).toFixed(1)} MB`);
console.log(`  panel (lo que abre)    : ${kb(pesoPanel)}  → ${(pesoIn / pesoPanel).toFixed(0)}x más chico`);
console.log(`  operadores (bajo demanda): ${(pesoOps / 1048576).toFixed(2)} MB`);
