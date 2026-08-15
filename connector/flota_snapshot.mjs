// flota_snapshot.mjs — Catálogo de flota + roster de la cuenta REGIONAL, guardado local.
//
// El archivo histórico semanal (datos/historico/<YYYY-Www>.json) solo contiene las unidades
// que reportaron viajes esa semana. El portal necesita además el PADRÓN COMPLETO
// (945 unidades, 55 grupos) para poblar filtros y contar flota total sin pegarle a la API.
//
// Salida: datos/historico/flota.json  { generado, cuenta, unidades:[…], conductores:[…] }
// Credenciales: connector/.env (nunca se imprimen).
//
// Uso: node connector/flota_snapshot.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../netlify/functions/lib/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const DIR = join(raiz, 'datos', 'historico');
mkdirSync(DIR, { recursive: true });

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

try {
  core.setUdnMap(JSON.parse(readFileSync(join(raiz, 'docs', 'udn-map.json'), 'utf8')));
} catch { console.warn('aviso: docs/udn-map.json no disponible'); }

const { fleet, roster } = await core.openSession({
  user: env.TRAFFILOG_USER, pass: env.TRAFFILOG_PASS, log: (m) => console.log('  ' + m),
});

const salida = {
  _doc: 'Padrón de flota y roster de la cuenta regional. Lo consume el portal para los filtros y el conteo de unidades.',
  generado: new Date().toISOString(),
  cuenta: env.TRAFFILOG_USER,
  unidades: fleet.map(v => ({
    vehicle_id: v.vehicle_id, placa: v.placa, grupo: v.grupo, udn: v.udn, cliente: v.cliente,
  })),
  conductores: roster.map(d => ({
    driver_id: d.driver_id, conductor: d.conductor, worker_id: d.worker_id,
    driver_code: d.driver_code, grupo: d.grupo, activo: d.activo,
  })),
};
writeFileSync(join(DIR, 'flota.json'), JSON.stringify(salida));

const porUdn = {};
for (const u of salida.unidades) porUdn[u.udn || 'Sin asignar'] = (porUdn[u.udn || 'Sin asignar'] || 0) + 1;
console.log(`✓ ${salida.unidades.length} unidades · ${salida.conductores.length} choferes · ${new Set(salida.unidades.map(u => u.grupo)).size} grupos`);
console.log('  por UDN:', JSON.stringify(porUdn));
console.log('  →', join(DIR, 'flota.json'));
