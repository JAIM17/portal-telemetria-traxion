// censo_actividad.mjs — Estado de actividad por operador y unidad sobre todo el archivo.
// Detecta posibles BAJAS (operadores sin actividad ≥5 semanas) y unidades con GPS
// muerto o intermitente. Salidas: datos/historico/censo.json + docs/reportes/*.csv.
// Correr tras cada semana nueva (lo hace refresco_diario.sh).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { desempacar } from '../netlify/functions/lib/codec.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
mkdirSync(join(raiz, 'docs', 'reportes'), { recursive: true });
const semanas = readdirSync(DIR).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort();
const idx = Object.fromEntries(semanas.map((f, i) => [f.slice(0, 8), i]));
const N = semanas.length;
const porOp = {}, porUni = {};
for (const f of semanas) {
  const regs = desempacar(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
  const sem = f.slice(0, 8);
  for (const r of regs) {
    const sinOp = !r.driver_id || /^SIN OPERADOR/.test(r.conductor || '');
    if (!sinOp && r.conductor) {
      const o = porOp[r.conductor] || (porOp[r.conductor] = { sem: new Set(), h: 0, udn: '' });
      o.sem.add(sem); o.h += r.horas || 0; if (r.udn) o.udn = r.udn;
    }
    if (r.placa) {
      const u = porUni[r.placa] || (porUni[r.placa] = { sem: new Set(), udn: '' });
      u.sem.add(sem); if (r.udn) u.udn = r.udn;
    }
  }
}
const estadoOp = g => g <= 1 ? 'activo' : g <= 4 ? 'inactivo' : 'posible_baja';
const ops = Object.entries(porOp).map(([n, o]) => {
  const ult = [...o.sem].sort().pop(); const gap = N - 1 - idx[ult];
  return { nombre: n, udn: o.udn, ultima_semana: ult, semanas_sin_actividad: gap,
    horas_acumuladas: Math.round(o.h), estado: estadoOp(gap) };
});
const unis = Object.entries(porUni).map(([p, u]) => {
  const ult = [...u.sem].sort().pop(); const gap = N - 1 - idx[ult];
  const cob = u.sem.size / (idx[ult] + 1);
  return { placa: p, udn: u.udn, ultima_semana: ult, semanas_sin_senal: gap,
    cobertura_pct: Math.round(cob * 100),
    estado: gap > 4 ? 'sin_senal_5mas' : gap > 1 ? 'sin_senal_2_4' : cob < 0.6 ? 'intermitente' : 'activa' };
});
writeFileSync(join(DIR, 'censo.json'), JSON.stringify({
  _doc: 'Censo de actividad: estado por operador (activo/inactivo/posible_baja) y unidad (GPS).',
  generado: new Date().toISOString(), semanas: N,
  resumen: {
    operadores: Object.fromEntries(['activo', 'inactivo', 'posible_baja'].map(e => [e, ops.filter(o => o.estado === e).length])),
    unidades: Object.fromEntries(['activa', 'intermitente', 'sin_senal_2_4', 'sin_senal_5mas'].map(e => [e, unis.filter(u => u.estado === e).length])),
  },
  operadores: ops.sort((a, b) => b.semanas_sin_actividad - a.semanas_sin_actividad || b.horas_acumuladas - a.horas_acumuladas),
  unidades: unis.sort((a, b) => b.semanas_sin_senal - a.semanas_sin_senal),
}, null, 1));
const csv = (rows, cols) => cols.join(',') + '\n' +
  rows.map(r => cols.map(c => String(r[c] ?? '').includes(',') ? '"' + r[c] + '"' : r[c]).join(',')).join('\n');
writeFileSync(join(raiz, 'docs', 'reportes', 'operadores-posible-baja.csv'),
  csv(ops.filter(o => o.estado !== 'activo'), ['nombre', 'udn', 'estado', 'ultima_semana', 'semanas_sin_actividad', 'horas_acumuladas']));
writeFileSync(join(raiz, 'docs', 'reportes', 'unidades-gps-revisar.csv'),
  csv(unis.filter(u => u.estado !== 'activa'), ['placa', 'udn', 'estado', 'ultima_semana', 'semanas_sin_senal', 'cobertura_pct']));
console.log('censo: ' + ops.length + ' operadores · ' + unis.length + ' unidades → censo.json + CSVs');
