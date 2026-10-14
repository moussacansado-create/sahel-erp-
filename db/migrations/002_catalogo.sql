-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 002 · Catálogo maestro
-- ═══════════════════════════════════════════════════════════════════════════
-- LA DECISIÓN ESTRUCTURAL MÁS IMPORTANTE DEL PROYECTO.
--
-- Materias primas, envases y productos terminados son filas de UNA SOLA tabla
-- `items`, distinguidas por `category_kind`. En el sistema anterior eran tres
-- tablas con tres stocks que nadie mantía sincronizados. Aquí es imposible que
-- ocurra: no existe una cuarta forma de representar un artículo.
--
-- CONSECUENCIA CLAVE: `items` NO TIENE COLUMNA DE STOCK. El stock vive
-- exclusivamente en `lots.qty_available` y se deriva por suma. Nadie puede
-- escribir existencias aquí porque no hay donde escribirlas.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE item_categories (
  id             SERIAL PRIMARY KEY,
  category_kind  TEXT NOT NULL CHECK (category_kind IN ('RAW_MATERIAL','PACKAGING','FINISHED_GOOD')),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  parent_id      INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (category_kind, name)
);

CREATE TABLE items (
  id               SERIAL PRIMARY KEY,
  sku              TEXT NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9][A-Z0-9._-]{2,30}$'),
  name             TEXT NOT NULL CHECK (length(trim(name)) >= 2),
  category_kind    TEXT NOT NULL CHECK (category_kind IN ('RAW_MATERIAL','PACKAGING','FINISHED_GOOD')),
  category_id      INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,

  -- Unidad de compra/venta y unidad base del lote
  unit_id          INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  base_unit_id     INTEGER REFERENCES units(id) ON DELETE RESTRICT,

  -- Formato / presentación (500 ml, 750 ml, bidón 20 L…)
  format_label     TEXT,

  -- Umbrales. El stock mínimo dispara alertas; se calcula contra lotes.
  min_stock        NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  max_stock        NUMERIC(18,4) CHECK (max_stock IS NULL OR max_stock >= min_stock),

  -- Importes
  purchase_cost    NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
  sale_price       NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  tax_rate         NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 1),
  currency_code    TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies(code),

  -- Comportamiento
  track_lots       BOOLEAN NOT NULL DEFAULT TRUE,
  requires_expiry  BOOLEAN NOT NULL DEFAULT FALSE,
  shelf_life_days  INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ,

  -- Un producto terminado no se archiva si tiene existencias.
  CONSTRAINT archivar_solo_sin_stock CHECK (archived_at IS NULL)
);

-- Un artículo en Archivado no puede quedarse sin categoría ni unidad.
COMMENT ON TABLE items IS
  'Maestro único de artículos. NO contiene stock: las existencias se derivan de lots.qty_available.';

CREATE INDEX idx_items_kind      ON items(category_kind) WHERE is_active;
CREATE INDEX idx_items_category  ON items(category_id);
CREATE INDEX idx_items_name      ON items(lower(name));

-- ─── Proveedores ────────────────────────────────────────────────────────────

CREATE TABLE suppliers (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL CHECK (length(trim(name)) >= 2),
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  tax_id        TEXT,
  country       TEXT,
  address       TEXT,
  zone_id       INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_suppliers_name ON suppliers(lower(name));

-- ─── Clientes ───────────────────────────────────────────────────────────────
-- qr_token es un valor aleatorio opaco: el QR apunta a una ruta de la
-- aplicación, no a un identificador predecible del cliente.

CREATE TABLE customers (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL CHECK (length(trim(name)) >= 2),
  company_name   TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  zone_id        INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  latitude       NUMERIC(10,7) CHECK (latitude BETWEEN -90 AND 90),
  longitude      NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  commercial_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit   NUMERIC(18,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  qr_token       TEXT NOT NULL UNIQUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INTEGER REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_commercial ON customers(commercial_id);
CREATE INDEX idx_customers_zone       ON customers(zone_id);
CREATE INDEX idx_customers_name       ON customers(lower(name));
