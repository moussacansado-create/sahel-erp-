#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  RESPALDO AUTOMÁTICO
# ─────────────────────────────────────────────────────────────────────────────
#
#  En este servidor no hay cron, así que el calendario se hace con un proceso
#  que duerme entre copias. No es lo elegante, pero es lo que hay, y tiene una
#  ventaja: si el respaldo falla, el proceso lo ve y lo dice en el log en vez
#  de seguir en silencio.
#
#  Cada pasada se anota en `respaldos/historial.log` con fecha, tamaño y número
#  de filas. Un historial sin leer no sirve de nada, y saber que hace tres días
#  que no se copia vale más que tener un directorio lleno de carpetas.

set -uo pipefail
BASE=/workspace/cleansahel-v2
INTERVALO=${SAHEL_RESPALDO_CADA:-21600}   # 6 horas, en segundos
HIST="$BASE/respaldos/historial.log"
NODE=$(command -v node)

mkdir -p "$BASE/respaldos"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] arranca el ciclo de respaldo (cada ${INTERVALO}s)" >> "$HIST"

primera=true
while true; do
  if [ "$primera" = "false" ]; then sleep "$INTERVALO"; fi
  primera=false

  SALIDA=$(cd "$BASE/server" && "$NODE" respaldar.mjs 2>&1)
  if [ $? -eq 0 ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] OK  $SALIDA" >> "$HIST"
    echo "respaldo ok: $SALIDA"
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FALLO  $SALIDA" >> "$HIST"
    echo "respaldo fallido: $SALIDA"
  fi
done
