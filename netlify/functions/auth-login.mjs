/* ============================================================================
 * POST /.netlify/functions/auth-login   (alias /api/auth/login)
 * Body JSON: { username, password }
 * ----------------------------------------------------------------------------
 * · Verifica credenciales contra el store Blobs "usuarios" (scrypt).
 * · Rate limit: 5 intentos fallidos → bloqueo temporal de 15 min (HTTP 429).
 * · Éxito → cookie de sesión JWT HS256 HttpOnly+Secure+SameSite=Lax (12 h).
 * · La contraseña NUNCA se registra en logs ni se devuelve en la respuesta.
 * ========================================================================== */

import {
  json, storeUsuarios, leerUsuario, guardarUsuario, usuarioPublico,
  verificarPassword, hashSeñuelo, normalizarUsername,
  secretoSesion, errorSecreto, firmarSesion, cookieSesion,
  estadoIntentos, registrarFallo, limpiarIntentos,
  SESION_HORAS, MAX_FALLOS,
} from './lib/auth.mjs';

const GENERICO = { error: 'credenciales_invalidas', mensaje: 'Usuario o contraseña incorrectos.' };

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'metodo_no_permitido' }, 405, { Allow: 'POST' });

  const secreto = secretoSesion();
  if (!secreto) return errorSecreto();

  let body;
  try { body = await req.json(); } catch { return json({ error: 'json_invalido' }, 400); }

  const username = normalizarUsername(body && body.username);
  const password = (body && typeof body.password === 'string') ? body.password : '';
  if (!username || !password) return json(GENERICO, 401);

  let store;
  try { store = storeUsuarios(); }
  catch {
    return json({ error: 'store_no_disponible',
      mensaje: 'El store de usuarios (Netlify Blobs) no está disponible en este entorno.' }, 503);
  }

  // 1) rate limit
  const rl = await estadoIntentos(store, username);
  if (rl.bloqueado) {
    return json({
      error: 'bloqueado',
      mensaje: `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(rl.segundos / 60)} min.`,
      reintentar_en: rl.segundos,
    }, 429, { 'Retry-After': String(rl.segundos) });
  }

  // 2) credenciales (trabajo scrypt equivalente aunque el usuario no exista)
  const usuario = await leerUsuario(store, username);
  let ok = false;
  if (!usuario) await hashSeñuelo(password);
  else ok = await verificarPassword(password, usuario.password_salt, usuario.password_hash);

  if (!usuario || !ok || usuario.activo === false) {
    const est = await registrarFallo(store, username);
    const restantes = Math.max(0, MAX_FALLOS - (est.fallos || 0));
    const res = { ...GENERICO };
    if (restantes > 0 && restantes <= 2) res.aviso = `Te quedan ${restantes} intento(s) antes del bloqueo temporal.`;
    if (est.bloqueado_hasta) {
      res.error = 'bloqueado';
      res.mensaje = 'Demasiados intentos fallidos. Cuenta bloqueada temporalmente por 15 minutos.';
      return json(res, 429, { 'Retry-After': '900' });
    }
    return json(res, 401);
  }

  // 3) sesión
  await limpiarIntentos(store, username);
  usuario.ultimo_acceso = new Date().toISOString();
  try { await guardarUsuario(store, usuario); } catch { /* no bloquea el login */ }

  const token = firmarSesion({ sub: usuario.username, rol: usuario.rol, nombre: usuario.nombre || '' }, secreto, SESION_HORAS);

  return json(
    { ok: true, usuario: usuarioPublico(usuario), expira_en: SESION_HORAS * 3600 },
    200,
    { 'Set-Cookie': cookieSesion(token, req) },
  );
};
