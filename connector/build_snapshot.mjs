// Genera data.json (snapshot v2) corriendo el pipeline REST completo en local.
// Uso:  node connector/build_snapshot.mjs [--days 21] [--from YYYY-MM-DD --to YYYY-MM-DD]
// Credenciales: connector/.env (TRAFFILOG_USER / TRAFFILOG_PASS). Nunca se imprimen.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildFromApi, ymd, safetyScore } from '../netlify/functions/lib/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch {}
if (!env.TRAFFILOG_USER || !env.TRAFFILOG_PASS) { console.error('faltan TRAFFILOG_USER/PASS en connector/.env'); process.exit(1); }

// autotest de la fórmula (caso verificado ABARCA: 115 pts, 21:11:00 → 542.88 x100h → 93)
{
  const t = safetyScore({ FrMed: 1, GirMed: 2, GirBajo: 8 }, 21 + 11 / 60);
  if (t.puntos !== 115 || Math.abs(t.x100h - 542.8796) > 0.01 || t.score !== 93)
    throw new Error('autotest de fórmula FALLÓ: ' + JSON.stringify(t));
  console.log('✓ autotest fórmula (ABARCA 115 pts → 542.88 x100h → score 93)');
}

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const days = Number(arg('days', 21));
const to = arg('to', ymd(new Date()));
const from = arg('from', ymd(new Date(Date.parse(to) - days * 864e5)));
console.log(`rango ${from} → ${to}`);

const t0 = Date.now();
const { snapshot } = await buildFromApi({
  user: env.TRAFFILOG_USER, pass: env.TRAFFILOG_PASS, from, to,
  concurrency: Number(arg('conc', 12)), url: env.TRAFFILOG_REST_URL,
  log: (m) => console.log('  ' + m),
});
const out = arg('out', join(here, '..', 'data.json'));
writeFileSync(out, JSON.stringify(snapshot, null, 1));
console.log(`✓ snapshot → ${out} (${(Date.now() - t0) / 1000 | 0}s)`);
console.log(`  operadores ${snapshot.meta.operadores} · unidades ${snapshot.meta.unidades} · eventos ${snapshot.meta.eventos} · semanas ${snapshot.semanas.join(', ')}`);
console.log('\nTOP scores:');
for (const s of snapshot.scores.por_operador.slice(0, 8))
  console.log(`  ${String(s.score).padStart(3)}  ${s.conductor}  (${s.puntos} pts · ${s.x100h == null ? '—' : s.x100h.toFixed(2)} x100h · ${s.horas.toFixed(1)} h)`);
const abarca = snapshot.scores.por_operador.find(s => /ABARCA/i.test(s.conductor));
if (abarca) console.log(`\nABARCA → score ${abarca.score} · ${abarca.puntos} pts · ${abarca.x100h?.toFixed(2)} x100h · ${abarca.horas.toFixed(2)} h`);
