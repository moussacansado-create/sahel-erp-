#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  TÚNEL DE SAHEL ERP
# ─────────────────────────────────────────────────────────────────────────────
#
#  Levanta un túnel de Cloudflare contra el servidor local y deja la dirección
#  guardada en `url-publica.txt`.
#
#  POR QUÉ ESTE SCRIPT Y NO UN COMANDO SUELTO
#
#  Porque el túnel «quick» de Cloudflare se cae, y hay que volver a levantarlo.
#  Quien lo hace falta que sea un script que: busca el binario en los sitios
#  donde puede estar, espera a que la aplicación responda ANTES de abrir el
#  túnel —si no, Cloudflare levanta el túnel contra un puerto muerto y parece
#  que todo funciona mientras nada responde—, y escribe la dirección.
#
#  MODO NOMBRADO
#
#  Si existen SAHEL_TUNEL_TOKEN y SAHEL_DOMINIO, se usa un túnel CON NOMBRE, que
#  es estable y no cambia nunca: la dirección es la del dominio. Ese es el modo
#  que hay que dejar configurado para trabajar todos los días. Sin esas dos
#  variables se cae al modo temporal, que NO es estable y solo sirve mientras
#  viva este proceso.

set -uo pipefail

BASE=/workspace/cleansahel-v2
URL_FILE="$BASE/url-publica.txt"
LOG=registros/tunel.log
mkdir -p "$BASE/registros"

log() { echo "[$(date -u +%H:%M:%S)] $*" >> "$BASE/$LOG"; }

# El binario de cloudflared no está siempre en el PATH: ha estado en tres
# sitios distintos según la imagen. Se buscan todos antes de rendirse.
CFB=""
for c in "$(command -v cloudflared 2>/dev/null)" \
         "$BASE/.herramientas/cloudflared" \
         "$HOME/.local/bin/cloudflared" \
         "$HOME/.tools/cloudflared"; do
  [ -n "$c" ] && [ -x "$c" ] && CFB="$c" && break
done
if [ -z "$CFB" ]; then
  log "NO SE ENCUENTRA cloudflared. El túnel no se levanta."
  exit 1
fi

# ── Modo con nombre, si está configurado ────────────────────────────────────
if [ -n "${SAHEL_TUNEL_TOKEN:-}" ] && [ -n "${SAHEL_DOMINIO:-}" ]; then
  log "Tunel CON NOMBRE hacia ${SAHEL_DOMINIO}"
  exec "$CFB" tunnel run --token "$SAHEL_TUNEL_TOKEN" \
    --no-autoupdate --protocol http2 --url http://127.0.0.1:10000 2>>"$BASE/registros/tunel-error.log"
fi

# ── Modo temporal: espera a que la aplicación responda de verdad ────────────
# Un túnel contra un puerto que no escucha es un 502/530 que parece un fallo de
# Cloudflare y no lo es. Se espera a la aplicación ANTES de abrirlo.
for i in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:10000/ 2>/dev/null)" = "200" ]; then
    log "La aplicacion responde (intento $i). Abriendo el tunel."
    break
  fi
  [ "$i" = "30" ] && { log "La aplicacion no responde. No se abre el tunel."; exit 1; }
  sleep 2
done

log "Abriendo tunel TEMPORAL (no es estable) con $CFB"
"$CFB" tunnel --url http://127.0.0.1:10000 --no-autoupdate --protocol http2 \
  >>"$BASE/registros/tunel-error.log" 2>&1 &
CF_PID=$!

# La direccion aparece en el log unos segundos despues de arrancar.
for i in $(seq 1 25); do
  NUEVA=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$BASE/registros/tunel-error.log" 2>/dev/null | tail -1)
  if [ -n "$NUEVA" ]; then
    echo "$NUEVA" > "$URL_FILE"
    log "Tunel temporal en $NUEVA  (cambia si se cae; no es una direccion estable)"
    break
  fi
  sleep 2
done

wait $CF_PID
