// monitor-alertas.mjs — Puente del MONITOR VIVO hacia producción.
// La Mac (connector/servidor_local.mjs) es el ÚNICO que habla con Traffilog
// (una sola sesión, regla dura); tras cada consulta EMPUJA aquí su estado:
//   POST /api/monitor-alertas  (header x-monitor-secret = MONITOR_PUSH_SECRET)
//   GET  /api/monitor-alertas  → el portal (local o producción) lo lee.
// Si la Mac se apaga, el estado se queda congelado: el GET agrega `desfaseMin`
// para que el portal pueda avisar "monitor sin señal desde hace N min".
import { getStore } from '@netlify/blobs';

const CLAVE = 'monitor/estado';

export default async (req) => {
  const store = getStore('traffilog');
  if (req.method === 'POST') {
    const secreto = process.env.MONITOR_PUSH_SECRET;
    if (!secreto || req.headers.get('x-monitor-secret') !== secreto) {
      return new Response(JSON.stringify({ ok: false, motivo: 'secreto inválido' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    let cuerpo;
    try { cuerpo = await req.json(); } catch { return new Response('JSON inválido', { status: 400 }); }
    cuerpo.recibidoEnNube = new Date().toISOString();
    await store.setJSON(CLAVE, cuerpo);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  const estado = await store.get(CLAVE, { type: 'json' }).catch(() => null);
  if (!estado) {
    return new Response(JSON.stringify({ activo: false, alertas: [], sinDatos: true }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  estado.desfaseMin = estado.recibidoEnNube
    ? Math.round((Date.now() - Date.parse(estado.recibidoEnNube)) / 60e3) : null;
  return new Response(JSON.stringify(estado),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
