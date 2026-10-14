-- ═══════════════════════════════════════════════════════════════════════════
-- 011 · Clientes y pedidos.
--
-- Lo que añade, exactamente:
--   · Una reserva puede consumeRSE A PARTES. Se guarda cuánto se ha servido de
--     cada reserva, sin partir la fila: así una entrega parcial no destruye el
--     resto de lo apartado.
--   · La reserva sabe QUÉ LOTE aparta. Sin esto no hay forma de saber, al
--     entregar, de qué lote sale la mercancía.
--   · La vista de progreso del pedido, de una vez, sin recalcular en cada
--     pantalla.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── La reserva sabe qué lote aparta y cuánto se ha servido ──────────────────
-- `qty` sigue siendo lo apartado. `qty_consumed` es lo que ya salió por
-- albarán. Entre los dos se sabe lo que queda vivo sin partir la fila.
ALTER TABLE order_reservations
  ADD COLUMN IF NOT EXISTS lot_id            INTEGER REFERENCES lots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS qty_consumed      NUMERIC(18,4) NOT NULL DEFAULT 0
                                            CHECK (qty_consumed >= 0),
  ADD COLUMN IF NOT EXISTS consumed_quantity NUMERIC(18,4)
    GENERATED ALWAYS AS (qty - qty_consumed) STORED;

-- Un índice único parcial (línea, lote) sin lote asignado no sirve de nada:
-- PostgreSQL trata cada NULL como distinto, así que la misma línea podría
-- abrir diez reservas sin lote. Este se encarga de cerrar ese agujero.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reserva_linea_lote_con_lote
  ON order_reservations (order_line_id, lot_id)
  WHERE sales_order_id IS NOT NULL
    AND lot_id IS NOT NULL
    AND status IN ('ACTIVE','ASSIGNED');

-- No se puede servir más de lo que se apartó. Ni por la vía rápida.
CREATE OR REPLACE FUNCTION fn_reserva_no_sobre_entrega() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.qty_consumed > NEW.qty + 0.0001 THEN
    RAISE EXCEPTION
      'ENTREGA_EXCEDE_RESERVA: de la reserva % se han servido % y solo había % apartados.',
      NEW.id, NEW.qty_consumed, NEW.qty
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'CONSUMED' AND NEW.qty_consumed < NEW.qty - 0.0001 THEN
    RAISE EXCEPTION
      'RESERVA_NO_TOTAL: la reserva % está marcada consumida pero solo se han servido % de % unidades.',
      NEW.id, NEW.qty_consumed, NEW.qty
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reserva_no_sobre_entrega ON order_reservations;
CREATE TRIGGER trg_reserva_no_sobre_entrega
  BEFORE INSERT OR UPDATE ON order_reservations
  FOR EACH ROW EXECUTE FUNCTION fn_reserva_no_sobre_entrega();

-- ─── El pedido avanza por un camino, no por cualquier salto ─────────────────
-- Reabrir un pedido que ya se entregó dejaría la mercancía entregada y el
-- pedido como si fuera nuevo. Un disparador lo impide.
CREATE OR REPLACE FUNCTION fn_pedido_estado_coherente() RETURNS TRIGGER AS $$
DECLARE
  pendiente NUMERIC;
  entregado NUMERIC;
BEGIN
  IF OLD.status = 'DELIVERED' AND NEW.status = 'DRAFT' THEN
    RAISE EXCEPTION 'PEDIDO_ENTREGADO_NO_SE_REABRE: el pedido % ya se entregó.', OLD.code
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'DELIVERED' THEN
    -- Cerrar el pedido exige que TODAS las líneas estén entregadas enteras.
    -- Si no, es una entrega parcial y el estado correcto es IN_ROUTE.
    SELECT COALESCE(SUM(l.qty - l.qty_delivered), 0), COALESCE(SUM(l.qty_delivered), 0)
      INTO pendiente, entregado
      FROM sales_order_lines l WHERE l.sales_order_id = NEW.id;
    IF pendiente > 0.0001 THEN
      RAISE EXCEPTION
        'PEDIDO_INCOMPLETO: el pedido % tiene % unidades sin entregar y no puede marcarse como entregado.',
        NEW.code, pendiente
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pedido_estado_coherente ON sales_orders;
CREATE TRIGGER trg_pedido_estado_coherente
  BEFORE UPDATE OF status ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION fn_pedido_estado_coherente();

-- ─── Progreso del pedido, en una vista ───────────────────────────────────────
-- Cada pantalla que necesite «cuánto va servido» lee aquí en vez de sumar tres
-- consultas distintas y equivocarse en una de ellas.
CREATE VIEW v_order_progress AS
SELECT
  o.id                    AS order_id,
  o.code                  AS order_code,
  o.status                AS status,
  c.id                    AS customer_id,
  c.code                  AS customer_code,
  c.name                  AS customer_name,
  COALESCE(SUM(l.qty), 0)            AS qty_ordered,
  COALESCE(SUM(l.qty_delivered), 0)   AS qty_delivered,
  COALESCE(SUM(l.qty - l.qty_delivered), 0) AS qty_pending,
  COUNT(l.id) FILTER (WHERE l.qty - l.qty_delivered > 0.0001) AS pending_lines,
  o.total, o.currency_code, o.order_date, o.promised_date, o.created_at
FROM sales_orders o
JOIN customers c       ON c.id = o.customer_id
LEFT JOIN sales_order_lines l ON l.sales_order_id = o.id
GROUP BY o.id, c.id;

COMMENT ON VIEW v_order_progress IS
  'Pedido con sus totales de cantidad, sin recalcular en cada pantalla.';

-- ─── Una entrega no se cierra dos veces ─────────────────────────────────────
-- La garantía de verdad es que la línea de entrega apunta a SU lote, y que
-- `stock_movement_keys` impide escribir dos veces el mismo par entrega/lote.
-- Esto solo hace explícita la regla en el esquema.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_entrega_linea_orden
  ON delivery_lines (delivery_id, order_line_id);

-- Índice para el «qué se ha servido de este pedido», que es la pregunta más
-- frecuente de la pantalla de entrega.
CREATE INDEX IF NOT EXISTS idx_entregas_pedido ON deliveries (sales_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservas_linea_vivas
  ON order_reservations (order_line_id) WHERE status IN ('ACTIVE','ASSIGNED');

-- ─── La firma puede colgar de la entrega, no solo del albarán ───────────────
-- En la Fase 5 toda entrega tendrá su albarán, y entonces la firma se cuelga
-- de él. Pero el reparto ya registra entregas hoy, y exigir un documento que
-- aún no tiene pantalla dejaría la venta parada por un detalle de interfaz.
--
-- Lo que NO se negocia es la garantía: una entrega sin evidencia no se cierra.
-- Por eso la columna se vuelve opcional SOLO si la entrega está ahí, y sigue
-- siendo única cuando la hay.
-- Se RELAJA la columna, no se borra y se vuelve a crear. Borrarla y añadirla
-- de nuevo sobre una tabla con datos rompe el binario de PGlite (aborta el
-- WASM), y además tiraría por tierra la fila que ya exista. `DROP NOT NULL`
-- es exactamente lo que hace falta y no toca nada más.
ALTER TABLE delivery_signatures
  ALTER COLUMN albaran_id DROP NOT NULL;

-- Índices ÚNICOS SIN predicado, a propósito: `ON CONFLICT (albaran_id)` no
-- encuentra un índice parcial si la sentencia no repite su `WHERE`. Y en
-- PostgreSQL un único índice sobre una columna nullable ya admite varios NULL,
-- que es justo lo que hace falta: varias entregas pueden no tener albarán.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_firma_albaran
  ON delivery_signatures (albaran_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_firma_entrega
  ON delivery_signatures (delivery_id);

-- Una firma sin documento detrás no es una firma: es un dibujo suelto.
ALTER TABLE delivery_signatures
  ADD CONSTRAINT delivery_signatures_tiene_documento
  CHECK (albaran_id IS NOT NULL OR delivery_id IS NOT NULL);
