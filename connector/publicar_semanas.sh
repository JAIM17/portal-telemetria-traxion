#!/bin/sh
# publicar_semanas.sh — Vigila datos/historico/ y publica a producción cada vez
# que el backfill banca una semana nueva. Proceso independiente del descargador.
# Uso: nohup sh connector/publicar_semanas.sh > publicar.log 2>&1 &
cd "$(dirname "$0")/.." || exit 1

# REQUISITO: PATH explícito. launchd arranca con un PATH mínimo
# (/usr/bin:/bin:/usr/sbin:/sbin) que NO incluye ~/.local/bin, donde viven node
# y npx. Sin esta línea el deploy muere con "npx: command not found" en cada
# ciclo, de forma silenciosa y indefinida: producción se congela sin que el log
# diga por qué. No sustituir por una ruta relativa ni asumir el PATH del shell
# de login — launchd no lo hereda.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# REQUISITO DE SEGURIDAD: los logs viven en /tmp, legible por cualquier usuario
# de la máquina, y el volcado de error de netlify-cli incluye el header
# Authorization con el token en claro. Doble candado, ambos obligatorios:
#   (1) los archivos de log quedan en modo 600,
#   (2) todo lo que sale del CLI pasa por redactar() antes de tocar disco.
# Quitar cualquiera de los dos expone un token de despliegue con permiso de
# escritura sobre el sitio.
umask 077
chmod 600 /tmp/publicar_semanas.log /tmp/publicar_semanas.err 2>/dev/null

# Tapa tokens de Netlify (nfc_/nfp_/nfu_/nfa_) y cualquier header Authorization.
redactar() {
  sed -E 's/(nf[cpua]_)[A-Za-z0-9_-]+/\1«REDACTADO»/g; s/("[Aa]uthorization": *")[^"]*/\1«REDACTADO»/g' "$@"
}

ULTIMO=""
while true; do
  ACTUAL=$(ls -l datos/historico/*.json 2>/dev/null | tr '\n' ' ')
  if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "$ULTIMO" ]; then
    sleep 30   # deja terminar cualquier escritura en curso (semana + indice)
    N=$(ls datos/historico/2*.json 2>/dev/null | wc -l | tr -d ' ')
    echo "[$(date '+%F %H:%M')] cambio detectado → deploy ($N semanas)"
    # El detalle del error se GUARDA siempre: un fallo silencioso en este punto
    # deja producción congelada sin señal visible. El crudo se escribe con
    # umask 077 (600) y se borra en cuanto existe la copia redactada; el status
    # del deploy se conserva sin tuberías intermedias.
    CRUDO=/tmp/publicar_deploy.crudo
    if npx --yes netlify-cli deploy --prod --no-build >"$CRUDO" 2>&1; then
      redactar "$CRUDO" >/tmp/publicar_ultimo_deploy.log; rm -f "$CRUDO"
      echo "[$(date '+%F %H:%M')] ✓ publicado con $N semanas"
      ULTIMO="$ACTUAL"
    else
      redactar "$CRUDO" >/tmp/publicar_ultimo_deploy.log; rm -f "$CRUDO"
      echo "[$(date '+%F %H:%M')] ✗ deploy falló — detalle:"
      tail -n 15 /tmp/publicar_ultimo_deploy.log | sed 's/^/    /'
      echo "[$(date '+%F %H:%M')] se reintenta en el siguiente ciclo"
    fi
  fi
  sleep 300  # revisa cada 5 min
done
