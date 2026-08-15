/* ============================================================================
 * GET /.netlify/functions/auth-me   (alias /api/auth/me)
 * ----------------------------------------------------------------------------
 * 200 → { usuario: {...} }  sesión válida (el rol se relee del store, no del JWT)
 * 401 → { error:'no_autenticado' }  → el portal muestra la pantalla de login
 * 500 → falta AUTH_SESSION_SECRET
 * ========================================================================== */

import { json, sesionDeRequest, usuarioPublico } from './lib/auth.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'metodo_no_permitido' }, 405, { Allow: 'GET' });
  const s = await sesionDeRequest(req);
  if (!s.ok) return s.res;
  return json({ usuario: usuarioPublico(s.usuario), expira: s.payload.exp });
};
