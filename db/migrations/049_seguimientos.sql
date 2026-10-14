-- ══════════════════════════════════════════════════════════════════════════════
-- 049 · SEGUIMIENTOS COMERCIALES COMO TAREAS
--
-- ── POR QUÉ NO VALE `com_visitas.next_action_date` ───────────────────────────
--
-- Porque ahí solo hay una fecha suelta. Una fecha no es una tarea: no tiene
-- responsable, ni motivo, ni si se ha atendido, ni qué pasó cuando se atendió.
-- «Volver el día 15» anotado en la visita del día 10 se pierde de vista en
-- cuanto pasa el día 15, y no hay forma de saber si alguien lo hizo.
--
-- Aquí la tarea es una fila con vida propia: se crea, se ve, se atiende, y se
-- queda. Las seis visitas que ya tienen `next_action` NO se convierten en
-- tareas: son texto libre sin fecha fiable, y convertirlas sería inventar
-- seguimientos que nadie prometio. Se quedan donde están y se documenta.
--
-- ── VINCULACIÓN ──────────────────────────────────────────────────────────────
--
-- Puede venir de una visita o de una incidencia, o de nada: un comercial
-- puede acordarse con un cliente por teléfono sin haber pasado por la visita.
-- Las tres referencias son opcionales y ninguna es obligatoria: atar la tarea a
-- su origen la dejaría inservible justo cuando más falta hace.
--
-- ── EL ESTADO SE CALCULA, NO SE ESCRIBE A MANO ───────────────────────────────
--
-- «Vencida» no es un estado que alguien marque: es lo que le pasa a una tarea
-- pendiente cuya fecha ya pasó. Guardarlo sería un dato que se queda viejo solo;
-- calcularlo significa que hoy es cierto y mañana también, sin nadie que lo
-- actualice.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS com_seguimientos (
  id              SERIAL PRIMARY KEY,

  cliente_id      INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
  -- FOTO de quién llevaba la cartera cuando se creó la tarea.
  responsable_id  INTEGER REFERENCES com_perfiles(id) ON DELETE SET NULL,
  -- Quién la tiene que hacer AHORA. Puede haber cambiado de manos.
  asignado_a      INTEGER REFERENCES com_perfiles(id) ON DELETE SET NULL,
  creada_por      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cerrada_por     INTEGER REFERENCES users(id) ON DELETE RESTRICT,

  -- De dónde viene, si viene de algún sitio. Los tres son opcionales.
  visita_id       INTEGER REFERENCES com_visitas(id) ON DELETE SET NULL,
  incidencia_id   INTEGER REFERENCES com_incidencias(id) ON DELETE SET NULL,

  titulo          TEXT NOT NULL CHECK (length(btrim(titulo)) > 0),
  descripcion     TEXT,
  motivo          TEXT,

  prioridad       TEXT NOT NULL DEFAULT 'NORMAL'
                    CHECK (prioridad IN ('BAJA', 'NORMAL', 'ALTA', 'URGENTE')),

  -- El estado guardado es solo PENDIENTE o COMPLETADA. Lo que pase mientras la
  -- tarea espera no se escribe: se deduce de `vence_en`.
  estado          TEXT NOT NULL DEFAULT 'PENDIENTE'
                    CHECK (estado IN ('PENDIENTE', 'COMPLETADA')),

  vence_en        DATE,
  completada_at   TIMESTAMPTZ,
  resultado       TEXT,
  cancelada_at    TIMESTAMPTZ,
  motivo_cancelacion TEXT,

  creado_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Atender una tarea tiene que decir qué se hizo. Igual que con las
  -- incidencias: cerrada sin resultado no sirve dentro de seis meses.
  CONSTRAINT com_seguimientos_cierre_completo CHECK (
    estado <> 'COMPLETADA'
    OR (completada_at IS NOT NULL AND resultado IS NOT NULL)
  ),
  -- Cancelar es un estado real: a veces la tarea ya no hace falta. Y también
  -- tiene que decir por qué, o desaparece el motivo de no haberla hecho.
  CONSTRAINT com_seguimientos_cancelacion_completa CHECK (
    cancelada_at IS NULL
    OR (motivo_cancelacion IS NOT NULL AND estado <> 'COMPLETADA')
  )
);

CREATE INDEX IF NOT EXISTS idx_com_seg_cliente   ON com_seguimientos (cliente_id, estado);
CREATE INDEX IF NOT EXISTS idx_com_seg_asignado  ON com_seguimientos (asignado_a, estado);
CREATE INDEX IF NOT EXISTS idx_com_seg_pendientes ON com_seguimientos (vence_en)
  WHERE estado = 'PENDIENTE' AND cancelada_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_com_seg_visita    ON com_seguimientos (visita_id) WHERE visita_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_com_seg_incidencia ON com_seguimientos (incidencia_id) WHERE incidencia_id IS NOT NULL;

COMMENT ON TABLE com_seguimientos IS
  'Tareas de seguimiento comercial. Tarea propia, no una fecha suelta dentro de '
  'una visita. Las tareas no se borran: se completan o se cancelan con motivo.';
COMMENT ON COLUMN com_seguimientos.vence_en IS
  'Fecha prevista. Con ella se CALCULA si la tarea esta vencida, proxima o a '
  'tiempo; no hay un estado guardado para eso.';
COMMENT ON COLUMN com_seguimientos.responsable_id IS
  'FOTO de quien llevaba la cartera al crearse. No cambia aunque despues la '
  'cambie: es lo que paso, no lo que pasara.';

-- ── Una tarea no se borra ni se reescribe por dentro ─────────────────────────
CREATE OR REPLACE FUNCTION trg_seguimiento_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una tarea de seguimiento no se borra (id %). Se completa o se cancela con su motivo.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.estado = 'COMPLETADA' AND NEW.estado <> 'COMPLETADA' THEN
    RAISE EXCEPTION 'La tarea % ya esta completada y no se puede reabrir. Crea otra.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.creada_por IS DISTINCT FROM OLD.creada_por
     OR NEW.creado_at IS DISTINCT FROM OLD.creado_at THEN
    RAISE EXCEPTION 'En la tarea % no se cambian el cliente, quien la creo ni cuando. Esos tres son su identidad.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.actualizado_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER seguimiento_no_se_borra
  BEFORE UPDATE OR DELETE ON com_seguimientos
  FOR EACH ROW EXECUTE FUNCTION trg_seguimiento_append_only();

-- ── El estado real, calculado en el momento de leer ──────────────────────────
-- Una tarea PENDIENTE puede estar «al día», «próxima» o «VENCIDA». Eso NO se
-- guarda: se calcula aquí, con la fecha de hoy. Guardarlo obligaría a que
-- alguien lo actualizara cada mañana, y nadie lo haría.
CREATE OR REPLACE VIEW v_com_seguimientos AS
SELECT
  s.*,
  CASE
    WHEN s.estado = 'COMPLETADA' THEN 'COMPLETADA'
    WHEN s.cancelada_at IS NOT NULL THEN 'CANCELADA'
    WHEN s.vence_en IS NULL THEN 'SIN_FECHA'
    WHEN s.vence_en < CURRENT_DATE THEN 'VENCIDA'
    WHEN s.vence_en = CURRENT_DATE THEN 'HOY'
    WHEN s.vence_en <= CURRENT_DATE + 3 THEN 'PROXIMA'
    ELSE 'A_TIEMPO'
  END AS situacion,
  (s.estado = 'PENDIENTE' AND s.vence_en IS NOT NULL AND s.vence_en < CURRENT_DATE) AS vencida,
  c.name AS cliente, c.code AS cliente_code,
  u.full_name AS creada_por_nombre,
  au2.username AS asignado, au2.full_name AS asignado_nombre,
  ru.username AS responsable, ru.full_name AS responsable_nombre
FROM com_seguimientos s
LEFT JOIN customers c ON c.id = s.cliente_id
LEFT JOIN users u ON u.id = s.creada_por
  LEFT JOIN com_perfiles ap ON ap.id = s.asignado_a
  LEFT JOIN users au2 ON au2.id = ap.user_id
  LEFT JOIN com_perfiles rp ON rp.id = s.responsable_id
  LEFT JOIN users ru ON ru.id = rp.user_id
