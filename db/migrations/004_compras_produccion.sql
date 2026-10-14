-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 004 · Compras, recetas y producción
-- ═══════════════════════════════════════════════════════════════════════════
-- Compras: recibir una línea crea el lote y el movimiento en la MISMA
-- transacción, o no ocurre nada.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE purchase_orders (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
  order_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  currency_code TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies(code),
  subtotal      NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at   TIMESTAMPTZ
);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id, order_date DESC);

CREATE TABLE purchase_lines (
  id                SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id           INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty_ordered       NUMERIC(18,4) NOT NULL CHECK (qty_ordered > 0),
  qty_received      NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_id           INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  unit_cost         NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  -- No se puede recibir más de lo pedido sin autorización explícita, y en
  -- cualquier caso no se puede recibir una cantidad negativa.
  CONSTRAINT no_recibir_negativo CHECK (qty_received <= qty_ordered OR qty_ordered >= 0),
  supplier_lot_code TEXT,
  expiry_date       TIMESTAMPTZ,
  notes             TEXT
);
CREATE INDEX idx_po_lines_order ON purchase_lines(purchase_order_id);
CREATE INDEX idx_po_lines_item  ON purchase_lines(item_id);

-- ─── Recetas ─────────────────────────────────────────────────────────────────
-- Una receta por producto y versión. El escalado a 500 / 1.000 / 5.000 /
-- 10.000 / 15.000 L sale de la MISMA fila: no se duplica la receta.

CREATE TABLE recipes (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  product_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Cantidad que produce UNA ejecución de la receta. Todo se escala respecto a esto.
  base_qty          NUMERIC(18,4) NOT NULL CHECK (base_qty > 0),
  base_unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  instructions      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER REFERENCES users(id),
  -- Solo una versión activa por producto
  CONSTRAINT una_receta_por_version UNIQUE (product_id, version)
);
CREATE UNIQUE INDEX uniq_receta_activa ON recipes(product_id) WHERE is_active;

CREATE TABLE recipe_lines (
  id          SERIAL PRIMARY KEY,
  recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  -- Cantidad NECESARIA para producir recipes.base_qty.
  qty_per_batch NUMERIC(18,4) NOT NULL CHECK (qty_per_batch > 0),
  unit_id     INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  -- Tolerancia admitida sobre la cantidad teórica, en tanto por uno.
  -- 0.02 = 2 %. Se usa para proponer el consumo real al operario.
  tolerance   NUMERIC(6,4) NOT NULL DEFAULT 0 CHECK (tolerance >= 0 AND tolerance < 1),
  is_critical BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  UNIQUE (recipe_id, item_id)
);
CREATE INDEX idx_recipe_lines_recipe ON recipe_lines(recipe_id);

-- ─── Producción ─────────────────────────────────────────────────────────────
-- planned_qty es lo teórico, actual_qty lo real obtenido, y la diferencia es la
-- merma. Los tres se guardan; no se recalculan a posteriori.

CREATE TABLE productions (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  product_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  recipe_id         INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  sales_order_id    INTEGER,          -- se fija tras crear 005
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PLANNED','IN_PROGRESS','COMPLETED','CANCELLED','ABORTED')),

  planned_qty       NUMERIC(18,4) NOT NULL CHECK (planned_qty > 0),
  actual_qty        NUMERIC(18,4) CHECK (actual_qty IS NULL OR actual_qty >= 0),
  unit_id           INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  waste_qty         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (waste_qty >= 0),
  waste_reason      TEXT,

  machine_id        INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  operator_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  planned_at        TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER REFERENCES users(id),

  -- La merma solo tiene sentido si hay producción real
  CONSTRAINT merma_exige_motivo CHECK (waste_qty = 0 OR waste_reason IS NOT NULL),
  -- Una producción terminada tiene quantities reales y fecha de fin
  CONSTRAINT completada_tiene_real CHECK (status <> 'COMPLETED' OR (actual_qty IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX idx_productions_product ON productions(product_id, created_at DESC);
CREATE INDEX idx_productions_status  ON productions(status);

-- Qué lote concreto se consumió en cada producción. ESTA TABLA ES LA
-- TRAZABILIDAD: sin ella, un lote de producto terminado no sabe de dónde salió.
CREATE TABLE production_materials (
  id              SERIAL PRIMARY KEY,
  production_id   INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  lot_id          INTEGER NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  recipe_line_id  INTEGER REFERENCES recipe_lines(id) ON DELETE SET NULL,
  theoretical_qty NUMERIC(18,4) NOT NULL CHECK (theoretical_qty >= 0),
  actual_qty      NUMERIC(18,4) NOT NULL CHECK (actual_qty >= 0),
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  consumed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_id, lot_id)
);
CREATE INDEX idx_prod_materials_lot       ON production_materials(lot_id);
CREATE INDEX idx_prod_materials_production ON production_materials(production_id);

-- El lote de producto terminado apunta a su producción. Lo añade un trigger
-- para que sea imposible crear un lote de producto sin rastro de fabricación.
CREATE OR REPLACE FUNCTION lote_producto_hereda_produccion() RETURNS TRIGGER AS $$
DECLARE
  v_prod INTEGER;
BEGIN
  IF NEW.lot_kind = 'FINISHED_GOOD' AND NEW.origin_type = 'PRODUCTION' THEN
    SELECT id INTO v_prod FROM productions WHERE id = NEW.origin_id;
    IF v_prod IS NULL THEN
      RAISE EXCEPTION 'Un lote de producto terminado debe referencia una producción existente (origin_id=%)', NEW.origin_id;
    END IF;
    NEW.production_id := v_prod;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lote_producto
  BEFORE INSERT ON lots
  FOR EACH ROW EXECUTE FUNCTION lote_producto_hereda_produccion();
