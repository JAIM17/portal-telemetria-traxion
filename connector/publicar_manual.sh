#!/bin/sh
# publicar_manual.sh — Deploy a producción SOLO a mano, tras validar.
# (El publicador automático se retiró el 2026-07-26 por orden del cliente:
#  "no mandar nada a producción antes de validar".)
cd "$(dirname "$0")/.." || exit 1
N=$(ls datos/historico/2*.json 2>/dev/null | grep -cv ralenti)
echo "Vas a publicar el sitio COMPLETO (código + datos, $N semanas) a:"
echo "  https://telemetriatraxion.netlify.app"
printf "¿Confirmas? (escribe SI): "
read R
[ "$R" = "SI" ] || { echo "cancelado"; exit 1; }
netlify deploy --prod --no-build && echo "✓ publicado"
