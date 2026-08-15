// Netlify Function — endpoint on-demand del portal (API REST oficial api.traffilog.mx).
// Orden de servicio:
//   1) Cache en Netlify Blobs (snapshot que mantiene la scheduled function traffilog-cron).
//   2) ?mode=live → construye en vivo un rango corto (máx 7 días) directo de la API REST.
//   3) (retirado) Ya no hay fallback a /data.json: ese snapshot era de la cuenta GG_LTSC
//      y solo cubría 111 unidades de Colima. El histórico completo de la cuenta REGIONAL
//      vive en datos/historico/ y lo lee el portal directo (aplicacion/archivo.js).
//
// Env (Netlify → Environment variables): TRAFFILOG_USER, TRAFFILOG_PASS, TRAFFILOG_REST_URL (opcional).
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (solo mode=live) · ?mode=live|cache · ?refresh=1 ignora blob.
import { getStore } from '@netlify/blobs';
import { buildFromApi, buildSnapshot, indexRegistros, ymd } from './lib/core.mjs';
import { desempacar } from './lib/codec.mjs';

const jsonRes = (obj, status = 200, extra = {}) =>
  new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
      ...extra,
    },
  });

export default async (req) => {
  const env = process.env;

  // Protección opcional del feed de datos (ver docs/AUTH.md § "Blindar los datos").
  // Desactivada por defecto para no romper el portal si aún no hay usuarios sembrados.
  // Con AUTH_PROTEGER_DATOS=1 el endpoint exige una sesión válida del portal.
  if (env.AUTH_PROTEGER_DATOS === '1') {
    const { sesionDeRequest } = await import('./lib/auth.mjs');
    const ses = await sesionDeRequest(req);
    if (!ses.ok) return ses.res;
  }

  let params; try { params = new URL(req.url).searchParams; } catch { params = new URLSearchParams(''); }
  const mode = params.get('mode') || 'cache';

  // 1) cache Blobs (lo llena traffilog-cron). Desde 2026-08-13 el blob vive
  //    COMPACTADO v3 (~2.9 MB en vez de 42 MB) y eso es lo que se sirve por
  //    defecto: mismo dato, formato columnar con diccionarios (lib/codec.mjs).
  //    ?formato=completo rehidrata y recalcula trips/events/scores para quien
  //    necesite el snapshot gordo de siempre.
  if (mode !== 'live' && !params.get('refresh')) {
    try {
      const store = getStore('traffilog');
      const snap = await store.get('snapshot', { type: 'json' });
      if (snap) {
        const completo = params.get('formato') === 'completo';
        if (!completo || snap.v !== 3) {
          return jsonRes(snap, 200, { 'X-Data-Source': 'blobs', 'X-Formato': snap.v === 3 ? 'compacto-v3' : 'completo' });
        }
        const full = buildSnapshot(indexRegistros(desempacar(snap)), { source: 'traffilog:rest:cron' });
        return jsonRes(full, 200, { 'X-Data-Source': 'blobs', 'X-Formato': 'completo' });
      }
    } catch (e) { console.error('blobs:', e.message); /* blobs no disponible (local) → sigue */ }
  }

  // 2) en vivo (rango corto para caber en el timeout de la función)
  if (env.TRAFFILOG_USER && env.TRAFFILOG_PASS && (mode === 'live' || params.get('refresh'))) {
    try {
      const now = new Date();
      const to = params.get('to') || ymd(now);
      let from = params.get('from') || ymd(new Date(now.getTime() - 2 * 864e5));
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > 7) from = ymd(new Date(Date.parse(to) - 7 * 864e5));
      const { snapshot } = await buildFromApi({ user: env.TRAFFILOG_USER, pass: env.TRAFFILOG_PASS, from, to, concurrency: 10, url: env.TRAFFILOG_REST_URL });
      snapshot.source = 'traffilog:rest:live';
      return jsonRes(snapshot, 200, { 'X-Data-Source': 'live' });
    } catch (e) {
      // cae al estático
      console.error('live fetch falló:', e.message);
    }
  }

  // 3) sin fallback estático: /data.json ya NO es una fuente (era el snapshot GG_LTSC
  //    de 111 unidades de Colima). El histórico vive en datos/historico/ y lo lee el
  //    propio portal con aplicacion/archivo.js, sin pasar por esta función.
  return jsonRes({
    error: 'sin datos en vivo: ni cache Blobs ni API',
    usa: 'datos/historico/indice.json (archivo histórico local, cuenta regional)',
  }, 502);
};
