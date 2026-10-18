-- ═══════════════════════════════════════════════════════════════════════════
-- 075 · COMISIONES MENSUALES POR COMERCIAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- LA REGLA DE NEGOCIO, QUE ES LO QUE IMPORTA
--
-- La comisión se calcula UNA VEZ AL MES sobre el total de ventas COBRADAS
-- atribuibles al comercial. No se confirma pedido por pedido.
--
-- Y hay un paso que la hace de verdad y no una cifra que sale sola: el
-- administrador REVISA el resumen y lo CONFIRMA. Antes de esa confirmación
-- el comercial ve una ESTIMACIÓN PROVISIONAL. Después ve la comisión
-- DEFINITIVA y su estado de pago.
--
-- Por eso esta migración guarda dos cosas separadas y que no se mezclan:
--
--   · lo CALCULADO  — base_cobrada, base_pendiente, porcentaje_aplicado,
--                     comision_estimada. Se recalcula cuando cambia una
--                     venta o un cobro. Es provisional.
--   · lo CONFIRMADO — base_confirmada, porcentaje_confirmado,
--                     comision_confirmada. Es una FOTOGRAFÍA. No se
--                     recalcula nunca. Un cambio posterior del porcentaje no
--                     la toca, y por eso el porcentaje se congela aquí.
--
-- ── LA MONEDA ──────────────────────────────────────────────────────────────
--
-- Todo el cálculo va en la moneda base contable del ERP, que es el FCFA
-- (XOF). Si un cobro está en euros, se convierte con la TASA CONGELADA
-- que trae el propio cobro (`payments.exchange_rate`), que es la que se
-- usó el día que se cobró. No se convierte con el precio de hoy ni con una
-- regla inventada: se usa la tasa real del movimiento. Y XOF es entero, así
-- que el resultado se redondea al franco.
--
-- ── QUÉ CUENTA COMO COBRADO ───────────────────────────────────────────────
--
-- Solo los cobros VERIFICADOS. Un cobro PENDING es dinero en manos del
-- repartidor, sin comprobar: entra en «pendiente», no en la base de la
-- comisión. Un cobro REJECTED no es dinero. Los tres se ven en el detalle,
-- pero solo uno suma.
--
-- ── LA ATRIBUCIÓN ─────────────────────────────────────────────────────────
--
-- Un cobro pertenece al comercial que VENDIÓ el pedido (`sales_orders.
-- commercial_id`, que es un `users.id`), no al que cobró (`payments.
-- collected_by`, que es quien pasó por la puerta). Si el pedido no tiene
-- comercial, se recurre al de la ficha del cliente. Un pago de caja no
-- reparte comisión: no vende nadie.
--
-- ── LO QUE ESTE BLOQUE NO HACE ────────────────────────────────────────────
--
-- No borra ni modifica ningún cobro ni pedido. La comisión se calcula
-- LEYENDO los movimientos, y si un cobro se equivoca se corrige el cobro,
-- no el histórico de comisiones. Por eso el detalle guarda los
-- identificadores de cada movimiento: se puede ir uno a uno.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 · EL PORCENTAJE Y SU VIGENCIA ────────────────────────────────────────
--
-- El porcentaje tiene fecha de entrada en vigor. El aplicable el día D es
-- el de la fila vigente en D: la más reciente cuyo `vigente_desde` no sea
-- posterior a D y que no tenga `vigente_hasta`.
--
CREATE TABLE IF NOT EXISTS com_comision_porcentajes (
  id            SERIAL PRIMARY KEY,
  comercial_id  INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  porcentaje    NUMERIC(6,3) NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
  vigente_desde DATE NOT NULL,
  vigente_hasta DATE,
  motivo        TEXT NOT NULL,
  creado_por    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_pct_vigencia CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde)
);

-- Un porcentaje por comercial y fecha de entrada en vigor. La REVISIÓN de
-- un porcentaje se haceponiendo uno nuevo con fecha posterior, no
-- reescribiendo el anterior: el histórico dice qué se aplicaba y cuándo.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_com_pct_vigente
  ON com_comision_porcentajes (comercial_id, vigente_desde);
CREATE INDEX IF NOT EXISTS idx_com_pct_buscar
  ON com_comision_porcentajes (comercial_id, vigente_desde DESC);

-- ── 2 · LA COMISIÓN DEL MES ────────────────────────────────────────────────
--
-- Una fila por comercial y mes. Es a la vez el resumen que se prepara, el
-- cálculo provisional y, cuando el administrador confirma, la instantánea
-- congelada.
--
CREATE TABLE IF NOT EXISTS com_comisiones (
  id                   SERIAL PRIMARY KEY,
  comercial_id         INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  periodo              TEXT NOT NULL CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  estado               TEXT NOT NULL DEFAULT 'EN_CURSO'
                         CHECK (estado IN ('EN_CURSO','PENDIENTE_REVISION',
                                           'CONFIRMADA_PENDIENTE_PAGO','PAGADA')),
  -- LO CALCULADO. Provisional. Se recalcula.
  base_cobrada         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (base_cobrada >= 0),
  base_pendiente       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (base_pendiente >= 0),
  porcentaje_aplicado  NUMERIC(6,3) CHECK (porcentaje_aplicado IS NULL
                                           OR porcentaje_aplicado >= 0),
  comision_estimada    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (comision_estimada >= 0),
  moneda               TEXT NOT NULL DEFAULT 'XOF' REFERENCES currencies(code),
  calculado_en         TIMESTAMPTZ,

  -- LO CONFIRMADO. Una fotografía. No se recalcula nunca.
  base_confirmada      NUMERIC(18,2) CHECK (base_confirmada IS NULL OR base_confirmada >= 0),
  porcentaje_confirmado NUMERIC(6,3) CHECK (porcentaje_confirmado IS NULL
                                            OR porcentaje_confirmado >= 0),
  comision_confirmada  NUMERIC(18,2) CHECK (comision_confirmada IS NULL
                                             OR comision_confirmada >= 0),
  confirmado_por       INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  confirmado_en        TIMESTAMPTZ,
  nota_confirmacion    TEXT,

  -- EL PAGO. Solo se rellena cuando el administrador registra el pago.
  pagado_importe       NUMERIC(18,2) CHECK (pagado_importe IS NULL OR pagado_importe >= 0),
  pagado_en            DATE,
  pagado_por           INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  pagado_referencia    TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_comision_unica UNIQUE (comercial_id, periodo),
  -- Si está pagada, tiene que haber importe, fecha y responsable. Si no
  -- está pagada, no puede tenerlos: un pago sin fecha no es un pago.
  CONSTRAINT com_comision_pago_completo CHECK (
    (estado = 'PAGADA' AND pagado_importe IS NOT NULL AND pagado_en IS NOT NULL
              AND pagado_por IS NOT NULL)
    OR
    (estado <> 'PAGADA' AND pagado_importe IS NULL AND pagado_en IS NULL)
  ),
  -- Confirmada significa confirmada: con base, porcentaje e importe, y con
  -- quién y cuándo. Sin eso no está confirmada.
  CONSTRAINT com_comision_confirmacion_completa CHECK (
    (confirmado_en IS NULL
      AND base_confirmada IS NULL
      AND porcentaje_confirmado IS NULL
      AND comision_confirmada IS NULL)
    OR
    (confirmado_en IS NOT NULL
      AND base_confirmada IS NOT NULL
      AND porcentaje_confirmado IS NOT NULL
      AND comision_confirmada IS NOT NULL
      AND confirmado_por IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_com_comisiones_periodo
  ON com_comisiones (periodo, comercial_id);
CREATE INDEX IF NOT EXISTS idx_com_comisiones_comercial
  ON com_comisiones (comercial_id, periodo DESC);

-- ── 3 · LOS PAGOS ──────────────────────────────────────────────────────────
--
-- Un comercial puede cobrar la comisión en varias veces. Cada pago es una
-- fila: importe, fecha, quién lo registra y el justificante. La suma de los
-- pagos es lo que se ha pagado de verdad.
--
CREATE TABLE IF NOT EXISTS com_comision_pagos (
  id           SERIAL PRIMARY KEY,
  comision_id  INTEGER NOT NULL REFERENCES com_comisiones(id) ON DELETE CASCADE,
  importe      NUMERIC(18,2) NOT NULL CHECK (importe > 0),
  fecha        DATE NOT NULL,
  usuario_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referencia   TEXT,
  nota         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_com_pagos_comision
  ON com_comision_pagos (comision_id, fecha);

-- ── 4 · LA AUDITORÍA ───────────────────────────────────────────────────────
--
-- Todo lo que se toca queda anotado: quién, cuándo, qué valor había, qué
-- valor se puso y por qué. Including los cambios de porcentaje, que son la
-- parte que más duele cuando no se puede explicar de dónde salió una cifra.
--
CREATE TABLE IF NOT EXISTS com_comision_auditoria (
  id            SERIAL PRIMARY KEY,
  comision_id   INTEGER REFERENCES com_comisiones(id) ON DELETE SET NULL,
  comercial_id  INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  periodo       TEXT,
  accion        TEXT NOT NULL,
  valor_anterior TEXT,
  valor_nuevo   TEXT,
  motivo        TEXT,
  usuario_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_com_auditoria_comercial
  ON com_comision_auditoria (comercial_id, created_at DESC);

-- ── 5 · LO CONFIRMADO NO SE TOCA ───────────────────────────────────────────
--
-- Esta es la garantía de que un cambio posterior del porcentaje no altera
-- una comisión ya confirmada. No es código: es la base. Aunque alguien
-- escriba un UPDATE a mano, la base lo veta.
--
CREATE OR REPLACE FUNCTION com_comision_bloquea_confirmada()
RETURNS TRIGGER AS $$
BEGIN
  -- Los campos congelados no se pueden cambiar en una comisión confirmada.
  -- Si cambian, se registra un ajuste nuevo: la comisión NO se reescribe.
  IF OLD.comision_confirmada IS NOT NULL THEN
    IF NEW.base_confirmada        IS DISTINCT FROM OLD.base_confirmada
    OR NEW.porcentaje_confirmado IS DISTINCT FROM OLD.porcentaje_confirmado
    OR NEW.comision_confirmada   IS DISTINCT FROM OLD.comision_confirmada
    OR NEW.periodo                IS DISTINCT FROM OLD.periodo
    OR NEW.comercial_id           IS DISTINCT FROM OLD.comercial_id THEN
      RAISE EXCEPTION 'La comisión de % ya esta confirmada. No se puede reescribir: '
        'hay que registrar un ajuste.', OLD.periodo
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- El pago solo avanza: no se puede des-pagar en silencio.
  IF OLD.estado = 'PAGADA' AND NEW.estado <> 'PAGADA' THEN
    RAISE EXCEPTION 'Una comision pagada no vuelve a estar pendiente sin un ajuste audited.'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_com_comision_bloquea_confirmada ON com_comisiones;
CREATE TRIGGER trg_com_comision_bloquea_confirmada
  BEFORE UPDATE ON com_comisiones
  FOR EACH ROW EXECUTE FUNCTION com_comision_bloquea_confirmada();

-- ── 6 · LOS PERMISOS ───────────────────────────────────────────────────────
--
-- `commissions:view`    → ver (el comercial, solo lo suyo; el servidor lo
--                         comprueba, no solo la interfaz)
-- `commissions:create`  → configurar porcentajes
-- `commissions:approve` → confirmar la comisión del mes
-- `commissions:edit`    → registrar el pago
--
-- SOLO ADMIN recibe permisos de gestión. El comercial recibe `view` y nada
-- más, y el servidor le recorta los datos a los suyos. Al JEFE COMERCIAL no
-- se le amplía nada.
--
INSERT INTO permissions (module, action) VALUES
  ('commissions','view'), ('commissions','create'),
  ('commissions','approve'), ('commissions','edit')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'ADMIN' AND p.module = 'commissions'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'COMMERCIAL' AND p.module = 'commissions' AND p.action = 'view'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ── 7 · LA MONEDA BASE ─────────────────────────────────────────────────────
--
-- El módulo no inventa una moneda: usa la que el ERP tiene marcada como
-- base. Si algún día esa cambia, esto cambia con ella.
--
DO $$
DECLARE
  base TEXT;
BEGIN
  SELECT code INTO base FROM currencies WHERE is_base AND is_active LIMIT 1;
  IF base IS NOT NULL THEN
    UPDATE com_comisiones SET moneda = base WHERE moneda IS DISTINCT FROM base;
  END IF;
END $$;

COMMENT ON TABLE com_comisiones IS
  'Comision mensual por comercial. Lo calculado (base_cobrada, comision_estimada) es provisional; lo confirmado (base_confirmada, comision_confirmada) es una fotografia y no se reescribe.';
COMMENT ON TABLE com_comision_porcentajes IS
  'Porcentaje de comision con fecha de vigencia. Se revisa añadiendo uno nuevo con fecha posterior; el anterior no se reescribe.';
COMMENT ON COLUMN com_comisiones.base_confirmada IS
  'Copia congelada de la base aprobada en el momento de confirmar. Un cambio posterior de porcentaje o de ventas NO la altera.';
