#!/bin/sh
# supervisor.sh — Lleva el histórico del AÑO COMPLETO hasta el final, solo.
#
# Por qué existe
# -------------
# El descargador muere solo ante un 401 persistente o una semana implausible, y
# hasta ahora había que relanzarlo a mano: si truena a las 3 a.m. se pierde la
# noche entera. Este guion lo vigila y lo vuelve a levantar hasta que las 30
# semanas del año estén en disco.
#
# Reglas que respeta (docs/ESTADO_SESION.md)
#   · NUNCA dos sesiones contra Traffilog a la vez. Todo es secuencial: si ya hay
#     un descargador vivo, espera a que termine en vez de arrancar otro.
#   · El descargador es re-entrante: cada relanzamiento reusa los tramos ya
#     bajados y sólo pide lo que falta. Reintentar no duplica trabajo.
#   · Al terminar la descarga, enriquece con ralentí las semanas que no lo tengan
#     (get_vehicle_trips_extended) — también en serie, nunca en paralelo.
#
# Uso:
#   nohup sh connector/supervisor.sh > /tmp/supervisor.log 2>&1 &
#   tail -f /tmp/supervisor.log
# Para detenerlo:  touch /tmp/parar-supervisor   (o matar el proceso)

cd "$(dirname "$0")/.." || exit 1
DIR="datos/historico"
DESDE="2026-01-01"
ESPERA=300          # segundos entre reintentos tras una caída
MAX_INTENTOS=200    # tope de seguridad: ~30 semanas necesitan bastante menos

log() { echo "$(date '+%F %T') $*"; }

# Semanas completas del año que ya están en disco (los sidecars NO cuentan).
semanas_en_disco() { ls -1 "$DIR" 2>/dev/null | grep -cE '^2026-W[0-9]{2}\.json$'; }

# ¿Cuántas semanas ISO deberían existir hasta hoy?
objetivo() { date '+%V' | sed 's/^0//'; }

log "supervisor arriba · objetivo: todas las semanas de 2026 desde $DESDE"

intento=0
while [ $intento -lt $MAX_INTENTOS ]; do
  [ -f /tmp/parar-supervisor ] && { log "parada solicitada (/tmp/parar-supervisor)"; rm -f /tmp/parar-supervisor; exit 0; }

  # Si ya hay un descargador vivo (arrancado a mano), NO se duplica: se espera.
  if pgrep -f "archivo_historico" > /dev/null; then
    log "ya hay un descargador vivo — esperando a que termine"
    while pgrep -f "archivo_historico" > /dev/null; do sleep 60; done
  else
    intento=$((intento + 1))
    log "lanzando descargador (intento $intento) · $(semanas_en_disco)/$(objetivo) semanas en disco"
    node connector/archivo_historico.mjs --from "$DESDE" --concurrency 16
    log "el descargador terminó con código $? · $(semanas_en_disco)/$(objetivo) semanas en disco"
  fi

  # ¿Ya está todo? El descargador imprime "nada que hacer" y sale 0 cuando no
  # queda ninguna semana pendiente; lo comprobamos por conteo, que es más firme.
  faltan=$(( $(objetivo) - $(semanas_en_disco) ))
  if [ "$faltan" -le 0 ]; then
    log "✓ histórico completo: $(semanas_en_disco) semanas"
    break
  fi

  log "faltan ~$faltan semanas · reintento en ${ESPERA}s"
  sleep $ESPERA
done

# ---- enriquecimiento de ralentí de lo que falte (una sola sesión, en serie) ----
log "descarga terminada — enriqueciendo ralentí de las semanas sin sidecar"
node connector/enriquecer_extendido.mjs --pausa 3
log "✓ supervisor terminado · $(semanas_en_disco) semanas · sidecars: $(ls -1 $DIR/*.ralenti.json 2>/dev/null | wc -l | tr -d ' ')"
