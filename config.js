/* Configuración del portal.

   FUENTE ÚNICA: el archivo histórico local (datos/historico/<YYYY-Www>.json + indice.json),
   que baja connector/archivo_historico.mjs desde la cuenta REGIONAL de Traffilog
   (945 unidades · 55 grupos · UDN Guadalajara, Colima y Lázaro Cárdenas).

   Ya NO se usa data.json: era un snapshot viejo de una sola plaza (111 unidades de
   Colima) y por eso el portal "solo mostraba Colima". Tampoco se llama a
   /.netlify/functions/traffilog?group=LIPU%20COLIMA: esa consulta filtraba a un grupo.

   Todo lo pasado sale del archivo local; solo la semana en curso se refresca releyendo
   su archivo (que el colector reescribe). Ver aplicacion/archivo.js. */
window.PORTAL_CONFIG = {
  INDICE_URL: 'datos/historico/indice.json',
  SEMANAS_INICIALES: 4,   // arranque perezoso: últimas N semanas con datos
  REFRESH_MS: 0,
  AUTOCONNECT: true
};
