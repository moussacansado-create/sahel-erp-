#!/bin/sh
# Reinicia el servidor de demostración sin corromper la base.
#
# EL PROBLEMA
#
# PGlite corre un PostgreSQL DENTRO del propio proceso Node, por WebAssembly.
# Si se le manda la muerte con la base abierta a medias, el WASM aborta
# (`Aborted()`) y deja el directorio .pgdata corrupto. Y no es que a veces falle:
# falla SIEMPRE, solo que unas veces la base aguanta y otras no.
#
# Ya ha pasado tres veces en una tarde. La última dejó 61 MB de datos de
# demostración inservibles y el arranque siguiente moría sin decir por qué.
#
# POR QUÉ NO BASTA CON `sleep`
#
# Matar y arrancar en la misma línea es una carrera: el proceso viejo sigue
# cerrando ficheros cuando el nuevo ya está abriendo la MISMA base. Dos PGlite
# sobre el mismo directorio, y el segundo se lleva por delante el primero.
#
# LO QUE HACE ESTE SCRIPT
#
#   1. Avisa al proceso con SIGINT para que cierre la base él mismo.
#   2. Espera HASTA QUE DESAPAREZCA DE VERDAD, no un número de segundos.
#   3. Si aun así sobrevive, SIGTERM, espera, y solo entonces SIGKILL.
#   4. Solo entonces arranca el nuevo.
#
# Uso:  sh server/reiniciar.sh

set -e
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
LOG=${LOG:-/workspace/srv.log}

esperar_a_que_muera() {
  limite=$1
  i=0
  while [ "$i" -lt "$limite" ]; do
    pgrep -f "arrancar\.mjs" > /dev/null 2>&1 || return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

echo "· Parando el servidor…"
pids=$(pgrep -f "arrancar\.mjs" 2>/dev/null || true)
if [ -n "$pids" ]; then
  # 1 · SIGINT: deja que PGlite cierre la base por su cuenta.
  for p in $pids; do kill -INT "$p" 2>/dev/null || true; done
  # 2 · Espera real, no un sleep a ciegas.
  esperar_a_que_muera 40 || {
    echo "  · no ha parado solo; SIGTERM"
    for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
    esperar_a_que_muera 15 || {
      # 3 · AQUÍ NO SE USA `kill -9`. NUNCA.
      #
      # PGlite es un Postgres dentro de WebAssembly. `SIGKILL` mata el proceso
      # sin dejarle volcar, el WASM aborta y `.pgdata` queda CORRUPTA. Ha
      # pasado cuatro veces ya y cada vez fue el mismo sitio: un reinicio con
      # prisa que llega a esta línea.
      #
      # Perder la base cuesta un rato y un respaldo. Perderla aquí, por un
      # `kill -9` a un proceso que tardaba dos segundos más, es de las peores
      # cosas que puede hacer una herramienta de despliegue.
      #
      # Si a estas alturas sigue vivo es que hay algo MAL PARADO, y se dice.
      # Se deja a mano, se mira, y se para bien. No se lo mata.
      echo "  · sigue vivo después de SIGINT y SIGTERM."
      echo "  · NO se va a hacer kill -9: PGlite cerraría corrupta."
      echo "  · Si el puerto sigue ocupado: mira qué proceso es y páralo con"
      echo "    'kill -INT <pid>' y espera a que salga solo."
      exit 1
    }
  }
  sleep 2
fi
echo "  parado."

echo "· Arrancando desde server/ (si no, PGlite abre ../.pgdata y el login falla)…"
cd "$RAIZ/server"
setsid nohup env PUBLIC=1 node arrancar.mjs > "$LOG" 2>&1 < /dev/null &

i=0
while [ "$i" -lt 40 ]; do
  sleep 3
  codigo=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:10000/api/health 2>/dev/null || true)
  if [ "$codigo" = "200" ]; then
    echo "  ✅ en marcha (${i}x3s)"
    exit 0
  fi
  i=$((i + 1))
done

echo "  ❌ no responde. Últimas líneas del log:"
tail -n 12 "$LOG" | sed 's/^/     /'
exit 1
