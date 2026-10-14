#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# PARAR EL SERVIDOR DE FORMA SEGURA.
#
# PGlite es un PostgreSQL dentro de un WebAssembly: la base es un DIRECTORIO
# que el proceso mantiene abierto. Si otro programa lo abre mientras el servidor
# lo está usando, los dos escriben a la vez y el WASM aborta. Ha pasado cuatro
# veces en este proyecto y una dejó la base sin poder arrancar.
#
# Por eso `parar.sh` NO es un `kill`: espera a que el proceso se vaya de verdad
# y comprueba que el puerto queda libre antes de devolver el control.
#
#   sh server/parar.sh          → para y espera
#
# Salida 0 = se puede tocar `.pgdata`. Disto de 0 = NO lo hagas.
# ─────────────────────────────────────────────────────────────────────────────
set -e
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PUERTO="${PUERTO:-10000}"

# 1 · INT primero. Un servidor bien cerrado suelta la base él solo.
for p in $(pgrep -f "arrancar.mjs" 2>/dev/null || true); do kill -INT "$p" 2>/dev/null || true; done

# 2 · Esperar a que muera. Los <defunct> son ZOMBIS: ya están muertos y no
#     sujetan nada, pero su línea de comando sigue en /proc y `pgrep` los cuenta.
#     Por eso se mira `stat` y no solo el PID.
i=0
while [ $i -lt 40 ]; do
  VIVOS=$(ps -eo stat,args 2>/dev/null | grep -F "arrancar.mjs" | grep -v defunct | grep -v grep | wc -l | tr -d ' ')
  [ "$VIVOS" = "0" ] && break
  sleep 0.5
  i=$((i+1))
done

# 3 · El puerto tiene que estar libre. Con el proceso muerto pero el puerto
#     ocupado, hay OTRO servidor detrás y abrir la base a mano es justo el
#     error que estamos intentando evitar.
i=0
while [ $i -lt 20 ]; do
  if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PUERTO}/" 2>/dev/null; then
    echo "  servidor parado. Puedes trabajar con .pgdata."
    exit 0
  fi
  sleep 0.5
  i=$((i+1))
done

echo "  ATENCIÓN: el puerto ${PUERTO} sigue respondiendo. Hay un servidor vivo." >&2
echo "  NO abras .pgdata. Mira qué lo ocupa: ps -eo pid,stat,args | grep -v defunct" >&2
exit 1
