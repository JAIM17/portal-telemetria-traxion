// gen_udn_geo.mjs — Asigna UDN a los grupos "Sin asignar" por GEOLOCALIZACIÓN.
// Criterio del cliente (2026-07-24): cada UDN tiene zona operativa clara; si las
// unidades de un grupo operan en municipios cercanos a Guadalajara → Guadalajara, etc.
// Fuente: GPS actual por unidad de api_get_data (una sola llamada). Mayoría por grupo.
// Solo toca grupos con origen 'sin_pista'; lo confirmado/inferido/manual se respeta.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../netlify/functions/lib/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');
const env = {};
for (const l of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}

// Zonas operativas (cajas lat/lng generosas, sin traslape entre sí)
const ZONAS = [
  { udn: 'Guadalajara',     lat: [20.30, 21.00], lng: [-103.90, -102.90] }, // ZMG + corredor (Tepic aparte, ver abajo)
  { udn: 'Guadalajara',     lat: [21.40, 21.60], lng: [-105.00, -104.70] }, // Tepic (opera bajo GDL)
  { udn: 'Colima',          lat: [18.70, 19.60], lng: [-104.80, -103.30] }, // Colima·Tecomán·Manzanillo
  { udn: 'Lázaro Cárdenas', lat: [17.80, 18.30], lng: [-102.60, -101.90] },
];
const zonaDe = (lat, lng) => {
  for (const z of ZONAS) if (lat >= z.lat[0] && lat <= z.lat[1] && lng >= z.lng[0] && lng <= z.lng[1]) return z.udn;
  return null;
};

const tok = await core.login(env.TRAFFILOG_USER, env.TRAFFILOG_PASS);
const fleet = await core.fetchFleet(tok);
console.log('flota:', fleet.length, 'unidades');

// GPS por unidad → voto por grupo
const votos = {};   // grupo → {udn: n}
let conGps = 0, sinGps = 0, fueraZona = 0;
for (const v of fleet) {
  const g = core.dec(v.group_name || '').trim();
  const lat = parseFloat(v.latitude ?? v.lat ?? v.last_latitude);
  const lng = parseFloat(v.longitude ?? v.lng ?? v.last_longitude);
  if (!g || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) { sinGps++; continue; }
  conGps++;
  const z = zonaDe(lat, lng);
  if (!z) { fueraZona++; continue; }
  (votos[g] = votos[g] || {})[z] = (votos[g][z] || 0) + 1;
}
console.log(`GPS válido: ${conGps} · sin GPS: ${sinGps} · fuera de zona: ${fueraZona}`);

// aplicar mayoría (≥70% y ≥2 votos) SOLO a grupos sin_pista
const mapPath = join(raiz, 'docs', 'udn-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
let aplicados = 0, ambiguos = [];
for (const [g, info] of Object.entries(map.grupos)) {
  if (info.origen !== 'sin_pista') continue;
  const v = votos[g];
  if (!v) { console.log(`  ${g}: sin GPS utilizable — queda Sin asignar`); continue; }
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  const [ganadora, n] = Object.entries(v).sort((a, b) => b[1] - a[1])[0];
  const pct = n / total;
  if (pct >= 0.7 && n >= 2) {
    info.udn = ganadora; info.origen = 'geolocalizado';
    info.geo = { votos: v, confianza: +(pct * 100).toFixed(0) + '%' };
    aplicados++;
    console.log(`  ✓ ${g} → ${ganadora} (${n}/${total} unidades en zona)`);
  } else {
    ambiguos.push(g);
    info.geo = { votos: v, nota: 'mayoría insuficiente' };
    console.log(`  ? ${g}: ambiguo ${JSON.stringify(v)} — queda Sin asignar`);
  }
}
map.actualizado = new Date().toISOString().slice(0, 10);
writeFileSync(mapPath, JSON.stringify(map, null, 2));

const por = {};
for (const i of Object.values(map.grupos)) por[i.udn] = (por[i.udn] || 0) + i.unidades;
console.log(`\n✓ ${aplicados} grupos geolocalizados · ${ambiguos.length} ambiguos`);
console.log('unidades por UDN:', JSON.stringify(por));
