-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 006 · Comercial, gastos, trazabilidad y auditoría
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Comercial ──────────────────────────────────────────────────────────────

CREATE TABLE visits (
  id               SERIAL PRIMARY KEY,
  commercial_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id          INTEGER,
  visit_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  visit_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  result           TEXT NOT NULL CHECK (result IN
                     ('PRODUCT_SHOWN','ORDER_TAKEN','FOLLOW_UP_NEEDED','NO_INTEREST','VISITED_NO_ORDER','CALL')),
  notes            TEXT,
  next_action      TEXT,
  next_action_date DATE,
  latitude         NUMERIC(10,7) CHECK (latitude BETWEEN -90 AND 90),
  longitude        NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_visits_commercial ON visits(commercial_id, visit_date DESC);
CREATE INDEX idx_visits_customer   ON visits(customer_id, visit_date DESC);

CREATE TABLE leads (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  company_name     TEXT,
  phone            TEXT,
  zone_id          INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  assigned_to      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source           TEXT,
  status           TEXT NOT NULL DEFAULT 'NEW'
                   CHECK (status IN ('NEW','CONTACTED','QUALIFIED','CONVERTED','LOST')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at     TIMESTAMPTZ
);

CREATE TABLE commercial_targets (
  id            SERIAL PRIMARY KEY,
  commercial_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  target_amount NUMERIC(18,2) NOT NULL CHECK (target_amount >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT periodo_valido CHECK (period_end >= period_start),
  UNIQUE (commercial_id, period_start)
);

-- ─── Gastos ─────────────────────────────────────────────────────────────────

CREATE TABLE expense_categories (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE expenses (
  id            SERIAL PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  category_id   INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  amount        NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies(code),
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  paid          BOOLEAN NOT NULL DEFAULT FALSE,
  receipt_url   TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id)
);
CREATE INDEX idx_expenses_date ON expenses(expense_date DESC);

-- ─── Retiradas / recalls ────────────────────────────────────────────────────

CREATE TABLE recalls (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  lot_id       INTEGER NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  reason       TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
  severity     TEXT NOT NULL DEFAULT 'MINOR'
               CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','INVESTIGATING','CLOSED_CANCELLED','CLOSED_CONFIRMED')),
  quantity_affected NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_affected >= 0),
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by    INTEGER REFERENCES users(id),
  closed_at    TIMESTAMPTZ,
  closed_by    INTEGER REFERENCES users(id),
  resolution   TEXT
);
CREATE INDEX idx_recalls_lot   ON recalls(lot_id);
CREATE INDEX idx_recalls_status ON recalls(status);

-- A quién hay que avisar. Se rellena recorriendo la cadena real:
-- recalls.lot → lotes que lo consumieron → producciones → pedidos → entregas
-- → clientes. No se escribe a mano, se calcula.
CREATE TABLE recall_affected_customers (
  id            SERIAL PRIMARY KEY,
  recall_id     INTEGER NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sales_order_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
  delivery_id   INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,
  quantity      NUMERIC(18,4) NOT NULL DEFAULT 0,
  notified_at   TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (recall_id, customer_id, sales_order_id)
);
CREATE INDEX idx_recall_affected_customer ON recall_affected_customers(customer_id);

-- ─── Alertas ────────────────────────────────────────────────────────────────
-- Se generan desde datos reales, no se escriben a mano.

CREATE TABLE alerts (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN
                 ('LOW_STOCK','MISSING_MATERIAL','MISSING_PACKAGING','EXPIRING_LOT','EXPIRED_LOT',
                  'PENDING_ORDER','LATE_DELIVERY','INCIDENT','RECALLED_PRODUCT','PRODUCTION_DEVIATION',
                  'CREDIT_LIMIT')),
  severity    TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  read_by     INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ,
  -- La misma alerta no se repite cada vez que se ejecuta el escáner.
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX idx_alerts_open ON alerts(severity, created_at DESC) WHERE NOT is_read;

-- ─── Auditoría append-only ──────────────────────────────────────────────────

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name   TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before_data JSONB,
  after_data  JSONB,
  ip_address  INET,
  user_agent  TEXT,
  outcome     TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS','DENIED','ERROR')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_user   ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_date   ON audit_log(created_at DESC);

-- La auditoría es de solo añadir. Esta función es la ÚNICA excepción y está
-- aquí para dejar constancia de que el acceso directo queda registrado.
CREATE OR REPLACE FUNCTION auditar_solo_lectura() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo añadir: % no permitido', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION auditar_solo_lectura();

-- ─── Facturación de clientes (consumo acumulado) ────────────────────────────
-- Se mantiene como proyección para no recalcular en cada ficha, pero su
-- fuente es la tabla de pedidos, no una cifra escrita a mano.

CREATE TABLE customer_stats (
  customer_id       INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  total_orders      INTEGER NOT NULL DEFAULT 0,
  total_delivered   INTEGER NOT NULL DEFAULT 0,
  total_spent       NUMERIC(18,2) NOT NULL DEFAULT 0,
  last_order_at     TIMESTAMPTZ,
  last_visit_at     TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
