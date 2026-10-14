-- ═══════════════════════════════════════════════════════════════════════════
-- 012 · REPARTO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo que le faltaba a la ruta del repartidor para existir de verdad.
--
-- ── 1 · Un paso más en el historial del albarán ────────────────────────────
--
-- «No he podido entregar» no cambia el estado del albarán: sigue impreso y
-- sin firmar, para el día siguiente. Lo único que se guarda es el PORQUÉ, para
-- no ir tres días seguidos a la misma puerta cerrada sin saber la causa.
--
-- Por eso hace falta un evento nuevo en el historial: con los de antes
-- (CREATED/PRINTED/SIGNED/DELIVERED/VOID) no se podía registrar «lo intenté y
-- no pude» sin falsear el estado.

ALTER TABLE albaran_events DROP CONSTRAINT IF EXISTS albaran_events_event_check;
ALTER TABLE albaran_events ADD CONSTRAINT albaran_events_event_check
  CHECK (event IN ('CREATED','PRINTED','SIGNED','DELIVERED','VOID',
                   'NOT_DELIVERED','REASSIGNED'));

COMMENT ON CONSTRAINT albaran_events_event_check ON albaran_events IS
  'NOT_DELIVERED no cambia el estado: el albarán sigue pendiente para el día siguiente.';

-- ── 2 · La ruta se lee por estados, no por fecha ───────────────────────────

-- La hoja de ruta del repartidor se consulta cuarenta veces al día: se abre al
-- empezar, se refresca en cada entrega. Sin índice, cada vez barre la tabla
-- entera de albaranes.
--
-- Es PARCIAL a propósito: solo interesan los que NO están entregados. Los
-- cerrados ya no se buscan en la ruta, y así el índice se queda corto.
CREATE INDEX IF NOT EXISTS idx_albaranes_en_camino
  ON albaranes (status, created_at)
  WHERE status IN ('PRINTED','SIGNED');

COMMENT ON INDEX idx_albaranes_en_camino IS
  'Albaranes en el camión: impresos sin firmar, o firmados sin cerrar. Es lo que ve el repartidor.';

-- ── 3 · El albarán es de UNA hoja ──────────────────────────────────────────
--
-- Antes el documento generaba dos copias: una para el cliente y otra para el
-- archivo. Eso era un almacén que necesitaba las dos en papel, no una regla del
-- albarán.
--
-- Ahora la aplicación genera SIEMPRE un albarán, y quien lo imprime decide
-- cuántas hojas saca en su propio diálogo de impresión. `copies` pasa a ser la
-- nota de cuántas hojas se quedaron en el archivo, y por eso su valor por
-- defecto pasa a ser 1.
--
-- Solo se cambia el VALOR POR DEFECTO. Los albaranes ya emitidos conservan el
-- número que se imprimió de verdad: eso es un hecho del pasado, y reescribirlo
-- sería inventar una historia que no ocurrió.

ALTER TABLE albaranes ALTER COLUMN copies SET DEFAULT 1;

COMMENT ON COLUMN albaranes.copies IS
  'Hojas impresas para el archivo. NO es lo que genera la aplicación: el documento es un único albarán.';

-- El albarán es UNO, siempre. Antes esta columna podía decir 2 y el
-- documento imprimía dos páginas.
ALTER TABLE albaranes ADD CONSTRAINT albaranes_copies_minimo
  CHECK (copies >= 1);
