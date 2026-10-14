-- ══════════════════════════════════════════════════════════════════════════════
-- 054 · LA LISTA DE MÉTRICAS SE AMPLÍA
--
-- `com_reglas_puntos_metrica_check` limitaba la métrica a los cinco valores que
-- había cuando solo existían cuatro reglas escritas a fuego. Al abrir el sistema
-- a configuraciones nuevas, cualquier métrica nueva —«cliente nuevo»,
-- «pedido entregado», «seguimiento completado»— rebotaba contra el CHECK con un
-- `REGLA_VULNERADA` que no decía qué estaba mal.
--
-- El CHECK se AMPLÍA, no se quita. Sigue siendo la base la que impide escribir
-- una métrica que el motor no sepa calcular: una regla con `metrica = 'LOQUESEA'`
-- tiene que fallar al guardarse, no al ejecutarse tres meses después.
--
-- Los cinco valores antiguos se conservan: las reglas que ya existen siguen
-- leyéndose igual, y sus alias (`VISITS` → `VISITA_REALIZADA`) están en el
-- motor para que el nombre viejo siga teniendo sentido.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE com_reglas_puntos DROP CONSTRAINT IF EXISTS com_reglas_puntos_metrica_check;
ALTER TABLE com_reglas_puntos ADD CONSTRAINT com_reglas_puntos_metrica_check CHECK (
  metrica = ANY (ARRAY[
    -- ── las cinco heredadas, que el motor traduce por alias ──────────────
    'TARGET_ACHIEVEMENT','ORDERS','UNITS','VISITS','DISTINCT_CUSTOMERS',
    -- ── Clientes ────────────────────────────────────────────────────────
    'CLIENTE_NUEVO','CLIENTES_ALCANZADOS','CLIENTE_RECUPERADO','CLIENTE_FIDEL',
    -- ── Pedidos y entregas ──────────────────────────────────────────────
    'PEDIDO_VALIDO','PEDIDO_ENTREGADO','PEDIDOS_ALCANZADOS','ENTREGA_COMPLETADA',
    -- ── Visitas y actividad ─────────────────────────────────────────────
    'VISITA_REALIZADA','VISITAS_ALCANZADAS','SEGUIMIENTO_COMPLETADO',
    -- ── Objetivos ───────────────────────────────────────────────────────
    'OBJETIVO_CUMPLIDO'
  ])
);

COMMENT ON CONSTRAINT com_reglas_puntos_metrica_check ON com_reglas_puntos IS
  'La métrica tiene que existir en el catálogo del motor (core/rankings.js). '
  'Una métrica de más no se puede guardar: es mejor quejarse al configurar que '
  'descubrirlo un día que el ranking no cuadra.';
