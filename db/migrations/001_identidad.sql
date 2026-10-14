-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 001 · Identidad, acceso y organización
-- ═══════════════════════════════════════════════════════════════════════════
-- Todo lo que identifica a una persona, le da permisos y sitúa el negocio en el
-- territorio. Sin datos de negocio aquí: esta migración es la base sobre la que
-- se apoya todo lo demás.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Roles y permisos ───────────────────────────────────────────────────────
-- Roles y permisos son TABLAS, no enums: añadir un rol nuevo debe ser un INSERT,
-- no una migración que toque cada fila de la aplicación.

CREATE TABLE roles (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]+$'),
  name        TEXT NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,  -- los de sistema no se pueden borrar
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id     SERIAL PRIMARY KEY,
  module TEXT NOT NULL CHECK (module ~ '^[a-z_]+$'),
  action TEXT NOT NULL CHECK (action IN ('view','create','edit','delete','approve','export')),
  UNIQUE (module, action)
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ─── Usuarios ───────────────────────────────────────────────────────────────
-- password_hash guardará el hash argon2id en formato PHC. Nunca la contraseña.

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  email                 TEXT UNIQUE,
  full_name             TEXT NOT NULL CHECK (length(trim(full_name)) >= 2),
  password_hash         TEXT NOT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  locale                TEXT NOT NULL DEFAULT 'es' CHECK (locale IN ('es','fr')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            INTEGER REFERENCES users(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by INTEGER REFERENCES users(id),
  PRIMARY KEY (user_id, role_id)
);

-- ─── Sesiones ───────────────────────────────────────────────────────────────
-- Se guarda el HASH del refresh token, nunca el token. Así, si alguien lee la
-- tabla, no puede suplantar una sesión.

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip_address   INET,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  revoked_reason TEXT,
  CONSTRAINT session_window CHECK (expires_at > issued_at)
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- ─── Auditoría de accesos ───────────────────────────────────────────────────
-- Permite detectar fuerza bruta y bloqueos anómalos con datos reales.

CREATE TABLE login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  successful  BOOLEAN NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  reason      TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_user ON login_attempts(username, attempted_at DESC);

-- ─── Unidades de medida ─────────────────────────────────────────────────────
-- base_factor permite convertir a la unidad base de su dimensión sin hardcodear
-- nada: 1 mL = 0.001 L, 1 bidón = 20 L.

CREATE TABLE units (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9]{0,3}$'),
  name        TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  dimension   TEXT NOT NULL CHECK (dimension IN ('VOLUME','MASS','COUNT')),
  base_factor NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (base_factor > 0),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Monedas ────────────────────────────────────────────────────────────────
-- Mali opera en EUR y XOF. Se guarda el tipo de cambio respecto a la base para
-- no tener que reconstruir nada cuando se añada una moneda.

CREATE TABLE currencies (
  code            TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  rate_to_base    NUMERIC(18,6) NOT NULL CHECK (rate_to_base > 0),
  is_base         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX uniq_currency_base ON currencies(is_base) WHERE is_base;

-- ─── Jerarquía territorial ──────────────────────────────────────────────────
-- Configurable, no codificada: región → zona → sector. Los ejemplos del
-- enunciado (Bamako, Koulikoro, Sikasso…) se cargan como datos, no como código.

CREATE TABLE zones (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('REGION','ZONE','SECTOR')),
  parent_id   INTEGER REFERENCES zones(id) ON DELETE RESTRICT,
  latitude    NUMERIC(10,7) CHECK (latitude BETWEEN -90 AND 90),
  longitude   NUMERIC(10,7) CHECK (longitude BETWEEN -180 AND 180),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_zones_parent ON zones(parent_id);

-- ─── Máquinas y líneas ──────────────────────────────────────────────────────

CREATE TABLE machines (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  location    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Rutas comerciales ──────────────────────────────────────────────────────

CREATE TABLE sales_routes (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  zone_id     INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Configuración de la aplicación ─────────────────────────────────────────

CREATE TABLE app_config (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z_][a-z0-9_.]*$'),
  value       JSONB NOT NULL,
  description TEXT,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Zona horaria: la auditoría usa timestamptz, no string ──────────────────
-- Todos los campos de fecha son TIMESTAMPTZ con la zona. Guardar fechas como
-- texto fue uno de los errores del sistema anterior.
