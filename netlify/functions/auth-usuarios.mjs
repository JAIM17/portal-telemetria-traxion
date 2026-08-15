/* ============================================================================
 * /.netlify/functions/auth-usuarios   (alias /api/auth/usuarios)
 * CRUD de usuarios del portal. Requiere sesión válida.
 * ----------------------------------------------------------------------------
 *   GET                      → lista de usuarios (proyección pública)   [super, admin]
 *   POST                     → alta                                     [super, admin]
 *   PUT                      → edición (datos, rol, UDN, activo, pass)  [super, admin]
 *   DELETE ?username=xxx     → desactivación (baja lógica, nunca borra) [super, admin]
 *   POST { accion:'mi_password', actual, nueva } → cambio de la propia  [cualquiera]
 *
 * MATRIZ DE PERMISOS
 *   · Solo 'super' puede crear, editar o desactivar usuarios con rol 'super'.
 *   · Solo 'super' puede promover a alguien a 'super'.
 *   · 'admin' gestiona únicamente 'admin' y 'lector'.
 *   · Nadie puede cambiar su propio rol ni desactivarse a sí mismo (anti-bloqueo).
 *   · Siempre debe quedar al menos un 'super' activo.
 *
 * Las contraseñas viajan solo de entrada (nunca se devuelven ni se registran).
 * ========================================================================== */

import {
  json, sesionDeRequest, usuarioPublico, listarUsuarios, leerUsuario, guardarUsuario,
  construirUsuario, hashPassword, verificarPassword, validarPassword, validarUsername,
  normalizarUsername, esAdministrador, ROLES,
} from './lib/auth.mjs';

const err = (mensaje, status = 400, code = 'error') => json({ error: code, mensaje }, status);

/** ¿Puede `actor` gestionar a un usuario con rol `rolObjetivo`? */
function puedeGestionarRol(actor, rolObjetivo) {
  if (actor.rol === 'super') return true;
  if (actor.rol === 'admin') return rolObjetivo !== 'super';
  return false;
}

async function quedanSupersActivos(store, excluyendo, forzarInactivo) {
  const todos = await listarUsuarios(store);
  return todos.some((u) => u.rol === 'super' && u.activo !== false &&
    !(u.username === excluyendo && forzarInactivo));
}

export default async (req) => {
  const s = await sesionDeRequest(req);
  if (!s.ok) return s.res;
  const { usuario: actor, store } = s;

  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    try { body = await req.json(); } catch { return err('Cuerpo JSON inválido.', 400, 'json_invalido'); }
  }

  /* ---------- cambio de la PROPIA contraseña (cualquier rol autenticado) ---- */
  if (req.method === 'POST' && body && body.accion === 'mi_password') {
    const okActual = await verificarPassword(String(body.actual || ''), actor.password_salt, actor.password_hash);
    if (!okActual) return err('La contraseña actual no es correcta.', 401, 'password_actual_invalida');
    const motivo = validarPassword(String(body.nueva || ''));
    if (motivo) return err(motivo, 400, 'password_debil');
    const cred = await hashPassword(String(body.nueva));
    await guardarUsuario(store, { ...actor, ...cred, actualizado: new Date().toISOString() });
    return json({ ok: true });
  }

  /* ------------------- a partir de aquí: solo super / admin ---------------- */
  if (!esAdministrador(actor))
    return err('Tu rol no permite gestionar usuarios.', 403, 'sin_permiso');

  /* ------------------------------------------------------------------- GET */
  if (req.method === 'GET') {
    const lista = await listarUsuarios(store);
    return json({
      usuarios: lista.map(usuarioPublico),
      yo: usuarioPublico(actor),
      roles: ROLES,
      puede_crear_super: actor.rol === 'super',
    });
  }

  /* ------------------------------------------------------------------ POST */
  if (req.method === 'POST') {
    const username = normalizarUsername(body && body.username);
    const motivoUser = validarUsername(username);
    if (motivoUser) return err(motivoUser, 400, 'username_invalido');

    const rol = ROLES.includes(body && body.rol) ? body.rol : 'lector';
    if (!puedeGestionarRol(actor, rol))
      return err('Solo un superusuario puede crear otros superusuarios.', 403, 'sin_permiso');

    const motivoPass = validarPassword(String((body && body.password) || ''));
    if (motivoPass) return err(motivoPass, 400, 'password_debil');

    if (await leerUsuario(store, username))
      return err(`El usuario "${username}" ya existe.`, 409, 'usuario_duplicado');

    const nuevo = await construirUsuario({
      username,
      nombre: body.nombre,
      rol,
      udn_permitidas: body.udn_permitidas,
      password: body.password,
      activo: body.activo !== false,
      creado_por: actor.username,
    });
    await guardarUsuario(store, nuevo);
    return json({ ok: true, usuario: usuarioPublico(nuevo) }, 201);
  }

  /* ------------------------------------------------------------------- PUT */
  if (req.method === 'PUT') {
    const username = normalizarUsername(body && body.username);
    if (!username) return err('Falta el usuario a editar.', 400);

    const objetivo = await leerUsuario(store, username);
    if (!objetivo) return err(`El usuario "${username}" no existe.`, 404, 'no_encontrado');

    if (!puedeGestionarRol(actor, objetivo.rol || 'lector'))
      return err('Solo un superusuario puede editar a otro superusuario.', 403, 'sin_permiso');

    const esYo = objetivo.username === actor.username;
    const cambios = { ...objetivo, actualizado: new Date().toISOString() };

    if (typeof body.nombre === 'string') cambios.nombre = body.nombre.trim();
    if (Array.isArray(body.udn_permitidas)) cambios.udn_permitidas = body.udn_permitidas.filter(Boolean);

    if (typeof body.rol === 'string' && body.rol !== objetivo.rol) {
      if (!ROLES.includes(body.rol)) return err('Rol desconocido.', 400);
      if (esYo) return err('No puedes cambiar tu propio rol.', 403, 'sin_permiso');
      if (!puedeGestionarRol(actor, body.rol))
        return err('Solo un superusuario puede asignar el rol "super".', 403, 'sin_permiso');
      cambios.rol = body.rol;
    }

    if (typeof body.activo === 'boolean' && body.activo !== (objetivo.activo !== false)) {
      if (esYo && body.activo === false) return err('No puedes desactivar tu propia cuenta.', 403, 'sin_permiso');
      cambios.activo = body.activo;
    }

    if (body.password != null && body.password !== '') {
      const motivo = validarPassword(String(body.password));
      if (motivo) return err(motivo, 400, 'password_debil');
      Object.assign(cambios, await hashPassword(String(body.password)));
    }

    // Anti-bloqueo: nunca dejar el portal sin un superusuario activo.
    const dejaDeSerSuper = (cambios.rol !== 'super' && objetivo.rol === 'super') || cambios.activo === false;
    if (objetivo.rol === 'super' && dejaDeSerSuper &&
        !(await quedanSupersActivos(store, objetivo.username, true)))
      return err('Debe quedar al menos un superusuario activo.', 409, 'ultimo_super');

    await guardarUsuario(store, cambios);
    return json({ ok: true, usuario: usuarioPublico(cambios) });
  }

  /* ---------------------------------------------------------------- DELETE */
  if (req.method === 'DELETE') {
    let username = '';
    try { username = normalizarUsername(new URL(req.url).searchParams.get('username')); } catch { /* noop */ }
    if (!username) return err('Falta ?username=', 400);

    const objetivo = await leerUsuario(store, username);
    if (!objetivo) return err(`El usuario "${username}" no existe.`, 404, 'no_encontrado');
    if (objetivo.username === actor.username) return err('No puedes desactivar tu propia cuenta.', 403, 'sin_permiso');
    if (!puedeGestionarRol(actor, objetivo.rol || 'lector'))
      return err('Solo un superusuario puede desactivar a otro superusuario.', 403, 'sin_permiso');
    if (objetivo.rol === 'super' && !(await quedanSupersActivos(store, objetivo.username, true)))
      return err('Debe quedar al menos un superusuario activo.', 409, 'ultimo_super');

    // Baja LÓGICA — nunca se destruye el registro (auditoría).
    await guardarUsuario(store, { ...objetivo, activo: false, actualizado: new Date().toISOString() });
    return json({ ok: true, usuario: usuarioPublico({ ...objetivo, activo: false }) });
  }

  return json({ error: 'metodo_no_permitido' }, 405, { Allow: 'GET, POST, PUT, DELETE' });
};
