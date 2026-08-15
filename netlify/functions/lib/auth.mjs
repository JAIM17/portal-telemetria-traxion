/* ============================================================================
 * lib/auth.mjs — núcleo de autenticación del portal (TRAXION / LIPU)
 * ----------------------------------------------------------------------------
 * Responsabilidades:
 *   · Hash y verificación de contraseñas con scrypt (node:crypto).
 *   · Firma y verificación de sesión JWT HS256 (env AUTH_SESSION_SECRET).
 *   · Cookie de sesión HttpOnly + Secure + SameSite=Lax, 12 h.
 *   · CRUD del store de usuarios en Netlify Blobs (store "usuarios").
 *   · Rate limit por usuario (bloqueo temporal tras 5 intentos fallidos).
 *
 * REGLAS DE ORO
 *   1. NUNCA se persiste ni se registra una contraseña en claro.
 *   2. NUNCA se devuelve `password_hash` / `password_salt` al cliente
 *      (usar siempre `usuarioPublico()`).
 *   3. Si falta AUTH_SESSION_SECRET la función responde 500 — jamás hay
 *      un secreto por defecto.
 * ========================================================================== */

import { getStore } from '@netlify/blobs';
import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

/* ---------------------------------------------------------------- constantes */
export const COOKIE_SESION   = 'rc_sesion';
export const SESION_HORAS    = 12;
export const ROLES           = ['super', 'admin', 'lector'];
export const PASS_MIN        = 10;             // longitud mínima de contraseña
export const MAX_FALLOS      = 5;              // intentos antes del bloqueo
export const BLOQUEO_MIN     = 15;             // minutos de bloqueo
const SECRETO_MIN            = 32;             // longitud mínima del secreto JWT

// Parámetros scrypt (≈ 64 MB, coste OWASP recomendado para N=2^14, r=8, p=1)
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

const STORE_NOMBRE = 'usuarios';
const PREFIJO_USER = 'u/';
const PREFIJO_RL   = 'rl/';

/* ------------------------------------------------------------------ respuestas */
export const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...extra,
    },
  });

/* ------------------------------------------------------------------- el store */
/** Store de usuarios. En una función Netlify el contexto es automático;
 *  en scripts locales (seed) se pasan siteID + token explícitos. */
export function storeUsuarios(opts) {
  if (opts && opts.siteID && opts.token) {
    return getStore({ name: STORE_NOMBRE, siteID: opts.siteID, token: opts.token, consistency: 'strong' });
  }
  return getStore({ name: STORE_NOMBRE, consistency: 'strong' });
}

export const claveUsuario = (u) => PREFIJO_USER + normalizarUsername(u);
export const normalizarUsername = (u) => String(u || '').trim().toLowerCase();

/* ------------------------------------------------------------------ contraseñas */
/** Deriva salt+hash de una contraseña. La contraseña en claro nunca sale de aquí. */
export async function hashPassword(pass) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(pass, salt, KEYLEN, SCRYPT)).toString('hex');
  return { password_salt: salt, password_hash: hash };
}

/** Verificación en tiempo constante. */
export async function verificarPassword(pass, salt, hash) {
  if (!pass || !salt || !hash) return false;
  let esperado;
  try { esperado = Buffer.from(String(hash), 'hex'); } catch { return false; }
  const derivado = await scrypt(pass, salt, KEYLEN, SCRYPT);
  if (esperado.length !== derivado.length) return false;
  return timingSafeEqual(derivado, esperado);
}

/** Trabajo scrypt equivalente para usuarios inexistentes: evita distinguir
 *  "usuario no existe" de "contraseña incorrecta" por tiempo de respuesta. */
export async function hashSeñuelo(pass) {
  try { await scrypt(String(pass || 'x'), 'senuelo-constante', KEYLEN, SCRYPT); } catch { /* noop */ }
  return false;
}

/** Política mínima de contraseña. Devuelve null si es válida, o el motivo. */
export function validarPassword(pass) {
  if (typeof pass !== 'string' || pass.length < PASS_MIN)
    return `La contraseña debe tener al menos ${PASS_MIN} caracteres.`;
  if (pass.length > 200) return 'La contraseña es demasiado larga (máx. 200).';
  if (!/[a-zA-Z]/.test(pass) || !/[0-9]/.test(pass))
    return 'La contraseña debe combinar letras y números.';
  return null;
}

/* ------------------------------------------------------------- sesión JWT HS256 */
const b64u    = (buf) => Buffer.from(buf).toString('base64url');
const deB64u  = (str) => Buffer.from(str, 'base64url').toString('utf8');

/** Secreto de firma. `null` si no está configurado o es demasiado corto. */
export function secretoSesion() {
  const s = process.env.AUTH_SESSION_SECRET;
  if (!s || String(s).length < SECRETO_MIN) return null;
  return String(s);
}

/** Respuesta 500 explícita cuando falta el secreto (nunca un default inseguro). */
export const errorSecreto = () => json({
  error: 'auth_no_configurada',
  mensaje: `Falta la variable de entorno AUTH_SESSION_SECRET (mínimo ${SECRETO_MIN} caracteres). ` +
           'Configúrala en Netlify → Site settings → Environment variables y vuelve a desplegar. ' +
           'Ver docs/AUTH.md.',
}, 500);

export function firmarSesion(payload, secreto, horas = SESION_HORAS) {
  const ahora = Math.floor(Date.now() / 1000);
  const head  = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body  = b64u(JSON.stringify({ ...payload, iat: ahora, exp: ahora + horas * 3600 }));
  const firma = createHmac('sha256', secreto).update(head + '.' + body).digest('base64url');
  return `${head}.${body}.${firma}`;
}

export function verificarSesion(token, secreto) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [head, body, firma] = partes;
  const esperado = createHmac('sha256', secreto).update(head + '.' + body).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(deB64u(body)); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

/* ------------------------------------------------------------------- cookies */
export function leerCookie(req, nombre) {
  const raw = req.headers.get('cookie') || '';
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

/** true si la petición viene de localhost por http (netlify dev). */
function esLocalHttp(req) {
  try {
    const u = new URL(req.url);
    return u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  } catch { return false; }
}

/** Cookie de sesión. `Secure` se omite SOLO en http://localhost (netlify dev),
 *  porque el navegador descarta cookies Secure en orígenes no seguros. */
export function cookieSesion(token, req, maxAgeSeg = SESION_HORAS * 3600) {
  const secure = esLocalHttp(req) ? '' : '; Secure';
  return `${COOKIE_SESION}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAgeSeg}`;
}
export function cookieBorrar(req) {
  const secure = esLocalHttp(req) ? '' : '; Secure';
  return `${COOKIE_SESION}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

/* ------------------------------------------------------------- CRUD de usuarios */
export async function leerUsuario(store, username) {
  const u = normalizarUsername(username);
  if (!u) return null;
  try { return await store.get(claveUsuario(u), { type: 'json' }); } catch { return null; }
}

export async function guardarUsuario(store, usuario) {
  await store.setJSON(claveUsuario(usuario.username), usuario);
  return usuario;
}

export async function listarUsuarios(store) {
  let res;
  try { res = await store.list({ prefix: PREFIJO_USER }); } catch { return []; }
  const claves = (res && res.blobs ? res.blobs : []).map((b) => b.key);
  const out = [];
  for (const k of claves) {
    try { const u = await store.get(k, { type: 'json' }); if (u) out.push(u); } catch { /* ignora */ }
  }
  return out.sort((a, b) => String(a.username).localeCompare(String(b.username), 'es'));
}

/** Proyección segura: JAMÁS incluye hash ni salt. */
export const usuarioPublico = (u) => u && ({
  username: u.username,
  nombre: u.nombre || '',
  rol: u.rol || 'lector',
  udn_permitidas: Array.isArray(u.udn_permitidas) ? u.udn_permitidas : [],
  activo: u.activo !== false,
  creado: u.creado || null,
  creado_por: u.creado_por || null,
  actualizado: u.actualizado || null,
  ultimo_acceso: u.ultimo_acceso || null,
});

/** Construye un usuario nuevo ya hasheado. */
export async function construirUsuario({ username, nombre, rol, udn_permitidas, password, activo, creado_por }) {
  const cred = await hashPassword(password);
  return {
    username: normalizarUsername(username),
    nombre: String(nombre || '').trim(),
    rol: ROLES.includes(rol) ? rol : 'lector',
    udn_permitidas: Array.isArray(udn_permitidas) ? udn_permitidas.filter(Boolean) : [],
    activo: activo !== false,
    ...cred,
    creado: new Date().toISOString(),
    creado_por: creado_por || null,
    actualizado: new Date().toISOString(),
    ultimo_acceso: null,
  };
}

export function validarUsername(username) {
  const u = normalizarUsername(username);
  if (!u) return 'El usuario es obligatorio.';
  if (!/^[a-z0-9._-]{3,40}$/.test(u))
    return 'Usuario inválido: 3–40 caracteres, solo letras, números, punto, guion y guion bajo.';
  return null;
}

/* --------------------------------------------------- rate limit por usuario */
const claveRL = (u) => PREFIJO_RL + normalizarUsername(u);

/** Devuelve { bloqueado, segundos } para el usuario dado. */
export async function estadoIntentos(store, username) {
  let rl = null;
  try { rl = await store.get(claveRL(username), { type: 'json' }); } catch { /* sin blobs */ }
  if (!rl || !rl.bloqueado_hasta) return { bloqueado: false, segundos: 0, fallos: (rl && rl.fallos) || 0 };
  const restante = Date.parse(rl.bloqueado_hasta) - Date.now();
  if (restante <= 0) return { bloqueado: false, segundos: 0, fallos: rl.fallos || 0 };
  return { bloqueado: true, segundos: Math.ceil(restante / 1000), fallos: rl.fallos || 0 };
}

export async function registrarFallo(store, username) {
  let rl = null;
  try { rl = await store.get(claveRL(username), { type: 'json' }); } catch { /* sin blobs */ }
  const previos = (rl && Date.parse(rl.bloqueado_hasta || 0) < Date.now() && rl.fallos >= MAX_FALLOS) ? 0 : ((rl && rl.fallos) || 0);
  const fallos = previos + 1;
  const dato = { fallos, ultimo: new Date().toISOString(), bloqueado_hasta: null };
  if (fallos >= MAX_FALLOS) dato.bloqueado_hasta = new Date(Date.now() + BLOQUEO_MIN * 60000).toISOString();
  try { await store.setJSON(claveRL(username), dato); } catch { /* sin blobs */ }
  return dato;
}

export async function limpiarIntentos(store, username) {
  try { await store.delete(claveRL(username)); } catch { /* sin blobs */ }
}

/* ---------------------------------------------------------- sesión de la request */
/**
 * Resuelve la sesión de la petición.
 * @returns {{ ok:true, usuario:object, payload:object }} o
 *          {{ ok:false, res:Response }} con la respuesta de error ya lista.
 */
export async function sesionDeRequest(req) {
  const secreto = secretoSesion();
  if (!secreto) return { ok: false, res: errorSecreto() };

  const token = leerCookie(req, COOKIE_SESION);
  const payload = verificarSesion(token, secreto);
  if (!payload) return { ok: false, res: json({ error: 'no_autenticado' }, 401) };

  const store = storeUsuarios();
  const usuario = await leerUsuario(store, payload.sub);
  if (!usuario || usuario.activo === false)
    return { ok: false, res: json({ error: 'usuario_inactivo' }, 401, { 'Set-Cookie': cookieBorrar(req) }) };

  // Si el rol cambió tras emitir el token, manda el del store (fuente de verdad).
  return { ok: true, usuario, payload, store, secreto };
}

export const esAdministrador = (u) => !!u && (u.rol === 'super' || u.rol === 'admin');
