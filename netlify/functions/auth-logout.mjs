/* ============================================================================
 * POST /.netlify/functions/auth-logout   (alias /api/auth/logout)
 * Borra la cookie de sesión. Idempotente: siempre 200.
 * ========================================================================== */

import { json, cookieBorrar } from './lib/auth.mjs';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET')
    return json({ error: 'metodo_no_permitido' }, 405, { Allow: 'POST, GET' });
  return json({ ok: true }, 200, { 'Set-Cookie': cookieBorrar(req) });
};
