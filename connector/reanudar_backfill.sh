#!/bin/sh
# Espera a que termine el enriquecimiento y RECIÉN entonces relanza el descargador
# histórico. Nunca puede haber dos sesiones contra Traffilog a la vez: la cuenta
# bloquea (probado). Este guion es el candado.
cd "$(dirname "$0")/.."
while pgrep -f "enriquecer_extendido" > /dev/null; do sleep 30; done
sleep 60   # margen para que la sesión del enriquecimiento se libere del lado de Traffilog
if pgrep -f "archivo_historico" > /dev/null; then
  echo "$(date '+%F %T') el descargador ya estaba vivo — no se duplica"
  exit 0
fi
echo "$(date '+%F %T') enriquecimiento terminado → relanzando backfill W26→W01"
exec node connector/archivo_historico.mjs --from 2026-01-01 --concurrency 16
