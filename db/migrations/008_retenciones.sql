-- 008 · Retenciones internas sin pedido
--
-- MOTIVO
-- ------
-- En la primera versión, `order_reservations` exigía un `sales_order_id`. Eso
-- obligaba a que una reserva interna (para una orden de producción, una muestra
-- de laboratorio, un control de calidad) fabricara un pedido falso colgado del
-- cliente que fuera por la base de datos. Datos de negocio falsos en la base:
-- justamente lo que este proyecto no admite. Peor aún, contaminaba el histórico
-- de ventas con líneas de precio cero que nadie había pedido.
--
-- La solución no es una tabla nueva —eso reintroduciría dos fuentes de verdad
-- para "lo apartado"— sino permitir la misma tabla con dos orígenes:
--
--   · Una reserva de PEDIDO    → ligada a un pedido y a su línea. La willa.
--   · Una RETENCIÓN INTERNA    → sin pedido, con un motivo obligatorio.
--
-- Una sola tabla, un solo significado: "esto está apartado y no se puede gastar
-- hasta que alguien lo libere o lo consuma".
--
-- Es una migración ADITIVA: solo relaja un NOT NULL y añade columnas. No se
-- borra ni reescribe ninguna fila existente.

BEGIN;

-- 1) Una reserva puede no tener pedido, si explica por qué existe.
ALTER TABLE order_reservations
  ALTER COLUMN sales_order_id  DROP NOT NULL,
  ALTER COLUMN order_line_id   DROP NOT NULL;

ALTER TABLE order_reservations
  ADD COLUMN IF NOT EXISTS hold_type   TEXT NOT NULL DEFAULT 'ORDER',
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

-- 2) Solo dos formas válidas, y nunca las dos a la vez:
--      · ORDER        → tiene pedido y línea, no necesita motivo.
--      · cualquier otra → NO tiene pedido, y SÍ necesita motivo.
--    Así nadie puede dejar una retención sin explicación, y el NOT NULL sobre
--    sales_order_id queda protegido por una regla equivalente y más expresiva.
ALTER TABLE order_reservations
  DROP CONSTRAINT IF EXISTS order_reservations_coherencia;

ALTER TABLE order_reservations
  ADD CONSTRAINT order_reservations_coherencia CHECK (
    (
      hold_type = 'ORDER'
      AND sales_order_id IS NOT NULL
      AND order_line_id  IS NOT NULL
    )
    OR
    (
      hold_type <> 'ORDER'
      AND sales_order_id IS NULL
      AND order_line_id  IS NULL
      AND hold_reason IS NOT NULL
      AND length(btrim(hold_reason)) >= 3
    )
  );

-- 3) Motivos de retención recognized por el sistema. El texto libre sigue
--    estando en hold_reason, que es donde va el detalle.
ALTER TABLE order_reservations
  DROP CONSTRAINT IF EXISTS order_reservations_hold_type_check;

ALTER TABLE order_reservations
  ADD CONSTRAINT order_reservations_hold_type_check
  CHECK (hold_type IN ('ORDER','PRODUCTION','SAMPLE','QUALITY','MAINTENANCE','OTHER'));

-- 4) La vista de existencias ya suma TODAS las reservas activas, así que las
--    retenciones internas se descuentan solas. Esto solo deja constancia de que
--    la decisión es intencionada, no accidental.
COMMENT ON COLUMN order_reservations.hold_type IS
  'ORDER = ligada a un pedido. El resto = retención interna sin pedido, con hold_reason obligatorio.';

-- 5) Índice para localizar las retenciones internas de un artículo.
CREATE INDEX IF NOT EXISTS idx_reservas_hold
  ON order_reservations (item_id, status)
  WHERE sales_order_id IS NULL;

COMMIT;
