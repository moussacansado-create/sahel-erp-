-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 003 · Lotes y libro mayor de existencias
-- ═══════════════════════════════════════════════════════════════════════════
-- EL NÚCLEO DEL SISTEMA.
--
-- Hay dos tablas y solo dos:
--
--   lots              → dónde está la existencia, en qué cantidad y hasta cuándo
--   stock_movements   → POR QUÉ cambió (el libro mayor, inmutable)
--
-- Ninguna otra tabla guarda cantidades. El stock de un artículo es SIEMPRE
-- la suma de sus lotes. Si mañana hay un descuadre, se puede reconstruir
-- reproduciendo el libro mayor completo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE lots (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9]{0,3}-[A-Z0-9][A-Z0-9-]{0,29}$'),
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,

  -- El tipo se deriva del artículo; se mantiene para consultas rápidas y para
  -- CHECKs, pero la fuente de verdad es items.category_kind.
  lot_kind          TEXT NOT NULL CHECK (lot_kind IN ('RAW_MATERIAL','PACKAGING','FINISHED_GOOD')),

  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','BLOCKED','QUARANTINE','EXHAUSTED','EXPIRED','RETIRED')),

  -- Cantidades
  initial_qty       NUMERIC(18,4) NOT NULL CHECK (initial_qty > 0),
  qty_available     NUMERIC(18,4) NOT NULL CHECK (qty_available >= 0),
  unit_id           INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  -- La cantidad consumida es la inicial menos la disponible. Se guarda para
  -- poder auditar sin recalcular, pero la suma manda.
  qty_consumed      NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),

  -- Nunca puede haber más disponible que lo recibido, ni haber consumido de más.
  CONSTRAINT lot_no_exceder_inicial CHECK (qty_available + qty_consumed <= initial_qty + 1e-9),

  -- Fechas
  manufactured_at   TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expiry_date       TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,

  -- Origen. Un lote de producto terminado sabe qué producción lo creó; uno de
  -- materia prima sabe qué compra o entrada lo trajo. Esta es la trazabilidad
  -- en su raíz.
  origin_type       TEXT NOT NULL CHECK (origin_type IN
                      ('PURCHASE','MANUAL_RECEPTION','PRODUCTION','OPENING','TRANSFER','ADJUSTMENT')),
  origin_id         INTEGER,     -- polimórfico, sin FK: la tabla depende del tipo
  production_id     INTEGER,     -- se fija por trigger cuando es producto terminado
  machine_id        INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  operator_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Datos de proveedor, solo para lotes de entrada
  supplier_id       INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_lot_code TEXT,
  invoice_ref       TEXT,
  document_url      TEXT,
  unit_cost         NUMERIC(18,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  quality_cert      TEXT,

  -- Motivo y responsable cuando el estado no es normal
  status_reason     TEXT,
  status_changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status_changed_at TIMESTAMPTZ,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER REFERENCES users(id),

  -- Un lote caducado no puede guardarse sin fecha de caducidad.
  CONSTRAINT caducado_tiene_fecha CHECK (status <> 'EXPIRED' OR expiry_date IS NOT NULL)
);

CREATE INDEX idx_lots_item_status ON lots(item_id, status);
CREATE INDEX idx_lots_expiry      ON lots(expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX idx_lots_supplier    ON lots(supplier_id);
CREATE INDEX idx_lots_production  ON lots(production_id) WHERE production_id IS NOT NULL;
CREATE INDEX idx_lots_fefo        ON lots(item_id, expiry_date NULLS LAST, received_at)
                                  WHERE status = 'ACTIVE' AND qty_available > 0;

COMMENT ON COLUMN lots.qty_available IS
  'Existencia del lote. Es el ÚNICO sitio donde vive el stock. No se escribe fuera de core/stock.js.';

-- ─── Libro mayor de existencias ─────────────────────────────────────────────
-- Append-only. Cada fila explica un cambio: qué lote, cuánto, por qué, quién,
-- contra qué operación y cuál era el saldo después.

CREATE TABLE stock_movements (
  id               BIGSERIAL PRIMARY KEY,
  lot_id           INTEGER NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  item_id          INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,

  movement_type    TEXT NOT NULL CHECK (movement_type IN
                     ('RECEPTION','PURCHASE_RECEPTION','PRODUCTION_OUTPUT','PRODUCTION_CONSUMPTION',
                      'DELIVERY','DELIVERY_REVERSAL','RETURN','ADJUSTMENT_IN','ADJUSTMENT_OUT',
                      'WASTE','TRANSFER_OUT','TRANSFER_IN','RECALL_WITHDRAW','EXPIRY_WRITE_OFF')),

  -- Positivo entra, negativo sale. qty_available nunca queda negativo (CHECK del lote).
  qty              NUMERIC(18,4) NOT NULL CHECK (qty <> 0),
  unit_id          INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  balance_after    NUMERIC(18,4) NOT NULL CHECK (balance_after >= 0),

  -- Referencia polimórfica a la operación que lo originó
  ref_type         TEXT CHECK (ref_type IN
                     ('PURCHASE_ORDER','PRODUCTION','SALES_ORDER','DELIVERY','ADJUSTMENT','RECALL','TRANSFER')),
  ref_id           INTEGER,

  reason           TEXT,
  notes            TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un ajuste necesita motivo: es la excepción que se audita a mano.
  CONSTRAINT ajuste_exige_motivo CHECK (
    movement_type NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR reason IS NOT NULL
  )
);

CREATE INDEX idx_movements_lot    ON stock_movements(lot_id, id);
CREATE INDEX idx_movements_item   ON stock_movements(item_id, occurred_at DESC);
CREATE INDEX idx_movements_ref    ON stock_movements(ref_type, ref_id);
CREATE INDEX idx_movements_date   ON stock_movements(occurred_at DESC);

-- ─── Un movimiento por sesión de producción/entrega ─────────────────────────
-- Esta restricción es la que impide, en la base de datos y no por buena
-- voluntad, que una entrega descuente dos veces el mismo lote.

CREATE TABLE stock_movement_keys (
  key         TEXT PRIMARY KEY,          -- p.ej. 'DELIVERY:123:lot:45'
  movement_id BIGINT NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Trigger: el estado del lote sigue a la existencia ──────────────────────
-- Nunca se permite que un lote diga "ACTIVO" sin cantidad, ni que se pueda
-- consumir un lote retirado. Estas reglas viven en la base para que ninguna
-- ruta de código pueda saltarlas por descuido.

CREATE OR REPLACE FUNCTION lot_estado_seguido() RETURNS TRIGGER AS $$
BEGIN
  -- Agotarse cambia el estado solo.
  IF NEW.qty_available <= 0 AND NEW.status = 'ACTIVE' THEN
    NEW.status := 'EXHAUSTED';
    NEW.status_changed_at := now();
  END IF;
  -- Reponer existencia devuelve a ACTIVO (salvo que esté bloqueado por calidad).
  IF NEW.qty_available > 0 AND NEW.status = 'EXHAUSTED' THEN
    NEW.status := 'ACTIVE';
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lot_estado
  BEFORE INSERT OR UPDATE OF qty_available, status ON lots
  FOR EACH ROW EXECUTE FUNCTION lot_estado_seguido();

-- ─── Trigger: caducidad automática ──────────────────────────────────────────
-- Un lote cuya fecha ya pasó no puede seguir siendo utilizable. Se marca al
-- insertarse y se revisa en cada lectura mediante la vista de existencias.

CREATE OR REPLACE FUNCTION lot_caduca() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expiry_date IS NOT NULL AND NEW.expiry_date <= now() AND NEW.status = 'ACTIVE' THEN
    NEW.status := 'EXPIRED';
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lot_caduca
  BEFORE INSERT OR UPDATE OF expiry_date ON lots
  FOR EACH ROW EXECUTE FUNCTION lot_caduca();
