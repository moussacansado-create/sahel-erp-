-- ═══════════════════════════════════════════════════════════════════════════
-- 014 · UNA LÍNEA DE PEDIDO SE PUEDE SERVIR DESDE VARIOS LOTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── EL BUG ────────────────────────────────────────────────────────────────
--
-- `delivery_lines` guarda UNA FILA POR LOTE: es lo que permite la trazabilidad
-- hacia atrás, que arranca justo en esta tabla. Si de 100 unidades de un
-- producto salen 60 de un lote y 40 de otro, hay dos filas, y las dos son
-- necesarias.
--
-- El índice único era (delivery_id, order_line_id): UNA fila por línea dentro de
-- una entrega. Con los datos que la tabla realmente guarda, ese índice no
-- describe la realidad, la prohíbe.
--
-- Consecuencia: cualquier entrega que partiese la mercancía entre dos lotes
-- reventaba con un «duplicate key value violates unique constraint». Es
-- justamente el caso normal cuando el producto se fabricó en dos tiradas, que
-- es lo que pasa siempre que se ha producido más de una vez.
--
-- ── EL ARREGLO ────────────────────────────────────────────────────────────
--
-- El índice único pasa a incluir el LOTE, que es lo que la fila identifica de
-- verdad. Sigue impidiendo lo que hay que impedir —que una misma combinación
-- entrega/línea/lote se escriba dos veces, que es lo que rompería el libro
-- mayor— y deja de impedir algo que sí tiene que pasar.
--
-- Es un cambio de ÍNDICE, no de datos: no se toca ni una fila de la tabla.

DROP INDEX IF EXISTS uniq_entrega_linea_orden;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_entrega_linea_lote
  ON delivery_lines (delivery_id, order_line_id, lot_id);

COMMENT ON INDEX uniq_entrega_linea_lote IS
  'Una fila por entrega, línea y lote. La trazabilidad necesita un renglón por lote: una línea servida desde dos lotes son dos renglones.';

-- Y sigue habiendo un índice útil para la pregunta más frecuente: «qué se
-- sirvió de este pedido».
CREATE INDEX IF NOT EXISTS idx_entregas_lineas_linea
  ON delivery_lines (order_line_id);
