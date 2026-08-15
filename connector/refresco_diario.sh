#!/bin/sh
# refresco_diario.sh — El corte "a día vencido": refresca la SEMANA EN CURSO
# (datos hasta ayer), la enriquece con ralentí real, re-atribuye eventos y
# regenera el censo. NO publica a producción (validación manual del cliente:
# connector/publicar_manual.sh).
#
# INVARIANTE CRÍTICA — VENTANA DE ATRIBUCIÓN DE 30 DÍAS.
# Traffilog conserva el chofer asociado a cada EVENTO sólo ~30 días. Pasada esa
# ventana la API devuelve el evento sin operador, y la atribución se pierde de
# forma IRREVERSIBLE: ya no hay de dónde recuperarla salvo por inferencia, con
# la pérdida de precisión que eso implica (las semanas W01–W25 de 2026 se
# reconstruyeron así y por eso su atribución ronda 52–57%, frente al 68–70%
# de las semanas bajadas dentro de la ventana).
#
# Consecuencia operativa: este refresco NO es cosmético ni diferible. Cada día
# que no corre acerca una semana al borde de la ventana. Si se suspende por
# mantenimiento, hay que reponerlo antes de 30 días.
#
# Lo corre launchd a las 09:00 (com.traxion.refresco-diario) y el botón
# "Día vencido" del portal local. Guarda log en /tmp/refresco_diario.log.
cd "$(dirname "$0")/.." || exit 1
# launchd no hereda el PATH del login shell y node vive en ~/.local/bin.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
LOCK=/tmp/refresco_diario.lock
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "[$(date '+%F %T')] ya hay un refresco corriendo (pid $(cat "$LOCK")) — salgo"; exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
# UNA SOLA SESIÓN contra Traffilog: si algo más usa la API, no arrancamos.
if pgrep -f "node connector/archivo_historico" >/dev/null || pgrep -f "enriquecer_extendido" >/dev/null \
   || pgrep -f "enriquecer_combustible" >/dev/null; then
  echo "[$(date '+%F %T')] la API está ocupada por otro proceso — salgo"; exit 0
fi
SEM=$(date +%G-W%V)
echo "[$(date '+%F %T')] ▶ refresco a día vencido · semana $SEM"
node connector/archivo_historico.mjs --semana "$SEM" --force || { echo "✗ descarga falló"; exit 1; }
node connector/enriquecer_extendido.mjs --semana "$SEM" --force --pausa 2 || echo "aviso: enriquecido falló (se reintenta mañana)"
node connector/reatribuir_eventos.mjs --semana "$SEM" --force
# SELLO DE LA SEMANA ANTERIOR. El corte a día vencido del domingo alcanza hasta
# el sábado, y para cuando corre el lunes la semana ISO ya cambió: sin este
# paso, el DOMINGO de cada semana nunca recibiría su bajada final y quedaría
# permanentemente incompleto en el archivo. Lunes y martes se re-baja la semana
# anterior entera, ya con los datos asentados y todavía dentro de la ventana de
# atribución de 30 días.
if [ "$(date +%u)" -le 2 ]; then
  PREV=$(date -v-7d +%G-W%V)
  echo "[$(date '+%F %T')] ▶ sellando semana anterior $PREV"
  node connector/archivo_historico.mjs --semana "$PREV" --force || echo "aviso: sello de $PREV falló"
  node connector/enriquecer_extendido.mjs --semana "$PREV" --force --pausa 2 || true
  node connector/reatribuir_eventos.mjs --semana "$PREV" --force
fi
node connector/censo_actividad.mjs
# MAGNITUD de las caídas de combustible (Δ%): serie de nivel vía
# api_get_vehicle_parameter_values, 1 llamada/30s, recientes primero.
# Va AL FINAL: para entonces los node anteriores ya cerraron y sigue habiendo
# una sola sesión contra Traffilog (el propio script re-verifica con pgrep).
node connector/enriquecer_combustible.mjs --max 30 || echo "aviso: delta de combustible falló (se reintenta mañana)"
echo "[$(date '+%F %T')] ✓ refresco completo · $SEM al día vencido · SIN publicar (validar y usar publicar_manual.sh)"
