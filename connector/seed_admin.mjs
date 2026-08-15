/* ============================================================================
 * seed_admin.mjs — siembra (o actualiza) un usuario del portal en Netlify Blobs
 * ----------------------------------------------------------------------------
 * USO
 *   SEED_PASS='…' NETLIFY_AUTH_TOKEN='…' node connector/seed_admin.mjs \
 *        --user jorge.interiano --nombre "Jorge Interiano" [--rol super] [--udn "LIPU COLIMA,YAZAKI"]
 *
 * REGLAS
 *   · La contraseña se lee SIEMPRE de la variable de entorno SEED_PASS.
 *     Nunca va en el código, nunca en un flag (quedaría en el historial del
 *     shell y en `ps`), nunca se imprime ni se registra.
 *   · Si el usuario ya existe se conservan sus datos y se ACTUALIZA la
 *     contraseña (y el rol / UDN si se pasan por flag).
 *   · Solo escribe el hash scrypt + salt: el texto plano nunca se persiste.
 *
 * REQUISITOS DE ENTORNO (para hablar con Netlify Blobs desde tu máquina)
 *   NETLIFY_AUTH_TOKEN  → token personal (Netlify → User settings → Applications)
 *   NETLIFY_SITE_ID     → opcional; si falta se lee de .netlify/state.json
 *
 * Documentación completa: docs/AUTH.md
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  storeUsuarios, leerUsuario, guardarUsuario, hashPassword, construirUsuario,
  validarPassword, validarUsername, normalizarUsername, ROLES,
} from '../netlify/functions/lib/auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, '..');

/* ------------------------------------------------------------------ flags */
function flag(nombre, def = null) {
  const i = process.argv.indexOf('--' + nombre);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const username = normalizarUsername(flag('user'));
const nombre   = flag('nombre', '');
const rol      = flag('rol', 'super');
const udnFlag  = flag('udn', '');
const udn      = udnFlag ? udnFlag.split(',').map((s) => s.trim()).filter(Boolean) : [];

/* ----------------------------------------------------------- validaciones */
const salir = (msg) => { console.error('✗ ' + msg); process.exit(1); };

const motivoUser = validarUsername(username);
if (motivoUser) salir(motivoUser + '  (usa --user <nombre>)');
if (!ROLES.includes(rol)) salir(`Rol desconocido "${rol}". Válidos: ${ROLES.join(', ')}`);

const password = process.env.SEED_PASS;
if (!password) salir(
  'Falta la variable de entorno SEED_PASS con la contraseña inicial.\n' +
  "  Ejemplo:  SEED_PASS='…' node connector/seed_admin.mjs --user admin --nombre \"Admin\"\n" +
  '  (usa un espacio inicial en el comando para que no quede en el historial del shell)');
const motivoPass = validarPassword(password);
if (motivoPass) salir(motivoPass);

/* --------------------------------------------------- credenciales Netlify */
let siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
if (!siteID) {
  try { siteID = JSON.parse(readFileSync(join(raiz, '.netlify', 'state.json'), 'utf8')).siteId || ''; } catch { /* noop */ }
}
const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN || '';
if (!siteID) salir('No se pudo determinar el site de Netlify. Exporta NETLIFY_SITE_ID.');
if (!token)  salir('Falta NETLIFY_AUTH_TOKEN (Netlify → User settings → Applications → Personal access tokens).');

/* -------------------------------------------------------------- siembra */
const store = storeUsuarios({ siteID, token });

const existente = await leerUsuario(store, username);
let resultado;

if (existente) {
  const cred = await hashPassword(password);
  resultado = {
    ...existente,
    ...cred,
    nombre: nombre || existente.nombre,
    rol: flag('rol') ? rol : existente.rol,
    udn_permitidas: udnFlag ? udn : (existente.udn_permitidas || []),
    activo: true,
    actualizado: new Date().toISOString(),
  };
  await guardarUsuario(store, resultado);
  console.log(`✓ usuario "${username}" actualizado (contraseña rotada)`);
} else {
  resultado = await construirUsuario({
    username, nombre: nombre || username, rol, udn_permitidas: udn,
    password, activo: true, creado_por: 'seed_admin.mjs',
  });
  await guardarUsuario(store, resultado);
  console.log(`✓ usuario "${username}" creado`);
}

// Nunca se imprime la contraseña ni el hash.
console.log('  rol            : ' + resultado.rol);
console.log('  nombre         : ' + resultado.nombre);
console.log('  udn_permitidas : ' + (resultado.udn_permitidas.length ? resultado.udn_permitidas.join(', ') : 'todas'));
console.log('  activo         : sí');
console.log('\nSiguiente paso: define AUTH_SESSION_SECRET en Netlify (≥32 caracteres) y despliega.');
console.log('Detalles en docs/AUTH.md.');
