import { readFileSync, writeFileSync } from 'node:fs';
const core = await import('../netlify/functions/lib/core.mjs');
const env={};for(const l of readFileSync(new URL('.env', import.meta.url),'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim();}
const tok = await core.login(env.TRAFFILOG_USER, env.TRAFFILOG_PASS);
const fleet = await core.fetchFleet(tok);
const conteo = {};
for (const v of fleet) { const g = core.dec(v.group_name || '(sin grupo)'); conteo[g] = (conteo[g] || 0) + 1; }

const GDL = /\bGDL\b|TLAJOMULCO|ZAPOPAN|PUERTA DE HIERRO|JALISCO/i;
const COL = /\bCOL\b|COLIMA|TECOMAN|MANZANILLO/i;
const LZC = /L\s*CARDENAS|LAZARO|TRUCHAS|BALSAS|FERTINAL/i;
const SIN = /^NO FUNCIONAN?\.?$|^DISPONIBLE$|^UTILITARIO$|^GUARDIA$/i;

const map = {};
for (const g of Object.keys(conteo).sort()) {
  let udn = 'Sin asignar', origen = 'sin_pista';
  if (SIN.test(g)) { udn = 'Sin asignar'; origen = 'no_operativo'; }
  else if (/UTILITARIO\s*:/i.test(g) && LZC.test(g)) { udn = 'Lázaro Cárdenas'; origen = 'nombre'; }
  else if (LZC.test(g)) { udn = 'Lázaro Cárdenas'; origen = 'nombre'; }
  else if (GDL.test(g)) { udn = 'Guadalajara'; origen = 'nombre'; }
  else if (COL.test(g)) { udn = 'Colima'; origen = 'nombre'; }
  else if (/^(FOUR SEASON|ESCUELA)$/i.test(g)) { udn = 'Colima'; origen = 'confirmado_cliente'; }
  else if (/^INGRASIS$/i.test(g)) { udn = 'Guadalajara'; origen = 'confirmado_cliente'; }
  map[g] = { udn, unidades: conteo[g], origen };
}
const out = {
  _doc: 'Mapa grupo API → UDN. Editable desde el portal (rol super). origen: nombre=derivado del texto, confirmado_cliente=dicho por el cliente, sin_pista=pendiente de asignar, no_operativo=flota no asignada.',
  udn_oficiales: ['Guadalajara', 'Colima', 'Lázaro Cárdenas'],
  actualizado: '2026-07-23',
  grupos: map,
};
writeFileSync(new URL('../docs/udn-map.json', import.meta.url), JSON.stringify(out, null, 2));
const por = {};
for (const [g, v] of Object.entries(map)) { por[v.udn] = (por[v.udn] || 0) + v.unidades; }
console.log('grupos:', Object.keys(map).length);
console.log('unidades por UDN:', JSON.stringify(por, null, 1));
console.log('\nPENDIENTES (sin pista):');
Object.entries(map).filter(([,v])=>v.origen==='sin_pista').sort((a,b)=>b[1].unidades-a[1].unidades)
  .forEach(([g,v])=>console.log(String(v.unidades).padStart(5), g));
