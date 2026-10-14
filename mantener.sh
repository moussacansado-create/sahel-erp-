#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# MANTENER LA APLICACIÓN EN PIE
# ═══════════════════════════════════════════════════════════════════════════
#
# EL PROBLEMA QUE ESTE SCRIPT RESUELVE
#
# La aplicación se caía. No por un fallo suyo: porque el sandbox se reinicia,
# y al reiniciarse se llevan el proceso de Node y el del túnel. Luego la URL
# pública daba «página no encontrada» y no había forma de saber por qué desde
# fuera: dentro era un puerto cerrado.
#
# Esto NO es un fallo de la aplicación. Pero es un fallo Operational tan
# molesto como cualquier otro, y un servidor que hay que levantar a mano
# después de cada reinicio no es un servidor: es un programa.
#
# QUÉ HACE
#
# Un bucle tonto a propósito:
#
#   · si el servidor no responde, lo levanta;
#   · si el túnel no responde, lo levanta y ANOTA la URL nueva en un fichero
#     DENTRO del proyecto, no en /tmp, que es lo que se borra al reiniciar.
#
# Por qué la URL se anota en un fichero: `trycloudflare.com` da una dirección
# distinta cada vez que se levanta. Sin anotarla a mano, hay que ir a buscar el
# dominio en el log, y ese log está en /tmp, y /tmp no sobrevive.
#
# NO HACE NADA INTELIGENTE A PROPÓSITO
#
# No reinstala, no migra, no borra, no toca la base. Si la base está corrupta,
# este script no la toca ni la «arregla»: la aparta, como siempre. Un vigilante
# que repara cosas es un vigilante que se come los datos un martes a las tres
# de la mañana.

DIR=/workspace/cleansahel-v2
SERVIDOR=$DIR/server
PUERTO=10000
URL_FICHERO=$DIR/url-publica.txt
LOG=$DIR/ser.log
TUNEL_LOG=$DIR/tunel.log

cd "$SERVIDOR" || exit 1

vivos() {
  # NO se usa `pgrep -f`: se encuentra a sí mismo en su propia línea de
  # comandos y da un falso «sigue vivo». Este ha sido el origen de dos
  # diagnósticos equivocados en esta misma sesión.
  ps -eo args 2>/dev/null | grep -q "[a]rrancar\.mjs"
}

tunel_vivo() {
  ps -eo args 2>/dev/null | grep -q "[c]f tunnel"
}

levantar_servidor() {
  echo "[$(date +%H:%M:%S)] el servidor no responde; levantando" >> "$LOG"
  # Desde `server/`, siempre. Si no, PGlite abre `../.pgdata` y el login falla
  # con CREDENCIALES_INVALIDAS sin decir por qué.
  (cd "$SERVIDOR" && setsid nohup env PUBLIC=1 node arrancar.mjs >> "$LOG" 2>&1 < /dev/null &)
}

levantar_tunel() {
  echo "[$(date +%H:%M:%S)] el túnel no está; levantando" >> "$TUNEL_LOG"
  (cd /tmp && setsid nohup /tmp/cf tunnel --url http://127.0.0.1:$PUERTO \
      --no-autoupdate >> "$TUNEL_LOG" 2>&1 < /dev/null &)
  # La URL tarda unos segundos en aparecer en el log.
  i=0
  while [ $i -lt 30 ]; do
    sleep 2
    U=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNEL_LOG" 2>/dev/null | tail -1)
    if [ -n "$U" ]; then
      echo "$U" > "$URL_FICHERO"
      echo "[$(date +%H:%M:%S)] URL pública: $U" >> "$LOG"
      return 0
    fi
    i=$((i + 1))
  done
  echo "[$(date +%H:%M:%S)] el túnel no ha dado URL en 60s" >> "$LOG"
}

echo "[$(date +%H:%M:%S)] vigilante arrancado" >> "$LOG"

while true; do
  CODIGO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PUERTO/" 2>/dev/null)
  [ "$CODIGO" != "200" ] && { vivos || levantar_servidor; sleep 12; }

  if [ ! -x /tmp/cf ]; then
    echo "[$(date +%H:%M:%S)] no está cloudflared; bajando" >> "$LOG"
    curl -sL -o /tmp/cf "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
      && chmod +x /tmp/cf
  fi

  # El túnel se comprueba por la URL, no por el proceso: el proceso puede
  # seguir ahí con la conexión caída, y eso es justo cuando más duele.
  U=$(cat "$URL_FICHERO" 2>/dev/null)
  if [ -n "$U" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$U/" 2>/dev/null)
    [ "$CODE" != "200" ] && { tunel_vivo || levantar_tunel; }
  else
    tunel_vivo || levantar_tunel
  fi

  sleep 25
done
