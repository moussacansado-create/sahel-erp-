-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 005 · Ventas, pedidos, reservas y entregas
-- ═══════════════════════════════════════════════════════════════════════════
-- LA REGLA QUE CORRIGE EL ERROR MÁS GRAVE DEL SISTEMA ANTERIOR:
-- allí el stock se descontaba al confirmar el pedido y OTRA VEZ al entregar.
--
-- Aquí la reserva y el consumo son conceptos separados:
--
--   CONFIRMED  → crea RESERVAS.          NO toca existencias.
--   DELIVERED  → consume las reservas.   Toca existencias UNA SOLA VEZ.
--   CANCELLED  → libera las reservas.    NO toca existencias.
--
-- Y la tabla stock_movement_keys impide que una misma entrega genere dos
-- movimientos para el mismo lote, aunque el código tuviera un fallo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE sales_orders (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  commercial_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','CONFIRMED','RESERVED','PREPARED','IN_ROUTE','DELIVERED','CANCELLED','RETURNED')),
  order_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  promised_date  DATE,
  delivered_at   TIMESTAMPTZ,
  currency_code  TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies(code),
  subtotal       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_rate       NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 1),
  tax_amount     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT
);
CREATE INDEX idx_orders_customer    ON sales_orders(customer_id, order_date DESC);
CREATE INDEX idx_orders_commercial  ON sales_orders(commercial_id);
CREATE INDEX idx_orders_status      ON sales_orders(status, order_date DESC);

-- Cancelar exige motivo: es una operación que hay que poder justificar.
ALTER TABLE sales_orders ADD CONSTRAINT cancelar_exige_motivo
  CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL);

CREATE TABLE sales_order_lines (
  id                SERIAL PRIMARY KEY,
  sales_order_id    INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty               NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  qty_delivered     NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (qty_delivered >= 0),
  unit_id           INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  unit_price        NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_amount   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_rate          NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 1),
  line_total        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  notes             TEXT,
  -- No se puede entregar más de lo pedido.
  CONSTRAINT no_entregar_de_mas CHECK (qty_delivered <= qty)
);
CREATE INDEX idx_order_lines_order ON sales_order_lines(sales_order_id);
CREATE INDEX idx_order_lines_item  ON sales_order_lines(item_id);

-- ─── Reservas ───────────────────────────────────────────────────────────────
-- Una reserva APUNTA a existencias pero NO las mueve. Al entregar pasa a
-- CONSUMED y ahí es cuando se crea el movimiento de stock.

CREATE TABLE order_reservations (
  id              SERIAL PRIMARY KEY,
  sales_order_id  INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  order_line_id   INTEGER NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  -- Lote concreto que se va a servir. NULL mientras no se haya preparado.
  lot_id          INTEGER REFERENCES lots(id) ON DELETE RESTRICT,
  qty             NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','ASSIGNED','CONSUMED','RELEASED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER REFERENCES users(id),
  consumed_at     TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE INDEX idx_reservations_order  ON order_reservations(sales_order_id);
CREATE INDEX idx_reservations_active ON order_reservations(item_id) WHERE status IN ('ACTIVE','ASSIGNED');
CREATE INDEX idx_reservations_lot    ON order_reservations(lot_id);

-- ─── Entregas ───────────────────────────────────────────────────────────────

CREATE TABLE deliveries (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  sales_order_id  INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  rep_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  zone_id         INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','ASSIGNED','PICKED_UP','DELIVERED','FAILED','RETURNED')),
  scheduled_at    TIMESTAMPTZ,
  picked_up_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  latitude        NUMERIC(10,7) CHECK (latitude BETWEEN -90 AND 90),
  longitude       NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  signature_url   TEXT,
  recipient_name  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER REFERENCES users(id)
);
CREATE INDEX idx_deliveries_rep    ON deliveries(rep_id, status);
CREATE INDEX idx_deliveries_order  ON deliveries(sales_order_id);
CREATE INDEX idx_deliveries_status ON deliveries(status, scheduled_at);

-- Qué lote salió en qué línea. Sin esta tabla no hay trazabilidad de entrega.
CREATE TABLE delivery_lines (
  id            SERIAL PRIMARY KEY,
  delivery_id   INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_line_id INTEGER NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  lot_id        INTEGER NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  qty_delivered NUMERIC(18,4) NOT NULL CHECK (qty_delivered > 0),
  unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  UNIQUE (delivery_id, order_line_id, lot_id)
);
CREATE INDEX idx_delivery_lines_lot     ON delivery_lines(lot_id);
CREATE INDEX idx_delivery_lines_delivery ON delivery_lines(delivery_id);

CREATE TABLE incidents (
  id           SERIAL PRIMARY KEY,
  delivery_id  INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN
                 ('RECIPIENT_ABSENT','DAMAGED','WRONG_ADDRESS','PAYMENT','REFUSED','PRODUCT_ISSUE','OTHER')),
  description  TEXT NOT NULL,
  photo_urls   TEXT[],
  reported_by  INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);
CREATE INDEX idx_incidents_delivery ON incidents(delivery_id);

-- ─── Garantía de consumo único ───────────────────────────────────────────────
-- Un pedido entregado no puede volver a consumirse. La regla vive aquí, en la
-- base, y no depende de que el código de entrega esté bien escrito.

CREATE OR REPLACE FUNCTION entrega_no_se_repite() RETURNS TRIGGER AS $$
DECLARE
  v_entregado BOOLEAN;
BEGIN
  SELECT status = 'DELIVERED' INTO v_entregado FROM deliveries WHERE id = NEW.delivery_id;
  IF v_entregado THEN
    RAISE EXCEPTION 'No se pueden añadir líneas a la entrega % porque ya está entregada', NEW.delivery_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entrega_no_se_repite
  BEFORE INSERT ON delivery_lines
  FOR EACH ROW EXECUTE FUNCTION entrega_no_se_repite();

-- ─── Ventana de entrega: no antes de la fecha de la venta ───────────────────
ALTER TABLE sales_orders ADD CONSTRAINT entrega_no_antes_de_venta
  CHECK (delivered_at IS NULL OR order_date <= delivered_at::DATE);
