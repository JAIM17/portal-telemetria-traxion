// Netlify Function: /.netlify/functions/data
//
// OBSOLETA. Servía data.json, que era un snapshot de la cuenta GG_LTSC con solo
// 111 unidades de Colima — la causa de que el portal "solo mostrara Colima".
//
// La fuente única es ahora el ARCHIVO HISTÓRICO LOCAL de la cuenta REGIONAL:
//   datos/historico/indice.json  +  datos/historico/<YYYY-Www>.json (compacto v3)
// El portal lo lee directo del sitio estático con aplicacion/archivo.js; no hay
// que pasar por una función. Este endpoint solo devuelve el índice para que
// cualquier consumidor viejo sepa a dónde ir en vez de recibir datos rancios.
import { readFile } from 'node:fs/promises';

export default async () => {
  try {
    const raw = await readFile(new URL('../../datos/historico/indice.json', import.meta.url), 'utf8');
    return new Response(JSON.stringify({
      obsoleto: true,
      motivo: 'data.json era un snapshot de una sola plaza (GG_LTSC, 111 unidades de Colima).',
      usa: 'datos/historico/indice.json',
      lector: 'aplicacion/archivo.js',
      indice: JSON.parse(raw),
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'sin datos/historico/indice.json', detail: String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
