-- ══════════════════════════════════════════════════════════════════════════════
-- 050 · CENTRO DE ALERTAS Y PUNTOS ANCLADOS
--
-- ── ALERTAS ──────────────────────────────────────────────────────────────────
--
-- `alerts` ya existe y ya tiene `dedupe_key`. No se crea otra tabla: la caja
-- está puesta y duplicarla sería exactamente el error de la 044.
--
-- Las de stock (`STOCK_MINIMO`) y las comerciales se distinguen por `kind`, y la
-- vista de abajo las separa para que la pantalla no las mezcle. Son dos cosas
-- distintas —una materia de almacen, otra de un comercial— y una lista con las
-- dos sin distinguir es una lista en la que no se encuentra nada.
--
-- `dedupe_key` es lo que impide que recargar la pantalla cree la misma alerta
-- otra vez. Y el generador NO se ejecuta al abrir la pantalla: se compara lo
-- que hay con lo que debería haber, y solo se inserta lo que falta.
--
-- ── UMBRAL DE INACTIVIDAD ───────────────────────────────────────────────────
--
-- Va en `app_config`, no en el código. Un umbral escrito en una línea de
-- código hay que tocarlo y redesplegar cada vez que el negocio cambia de idea;
-- en una tabla de configuración se cambia desde la administración.
--
-- ⚠ PERO NO SE ACTIVA TODAVÍA, y el motivo está escrito en la vista de abajo.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1 · Configuración de la parte comercial ──────────────────────────────────
INSERT INTO app_config (key, value, description) VALUES
  ('comerciales.inactividad.dias', '15',
   'Dias sin compra valida para considerar que un cliente esta inactivo. Se cambia desde la administracion, no en el codigo.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value, description) VALUES
  ('comerciales.inactividad.activa', 'false',
   'NO ACTIVAR todavia: no hay ni una entrega en el sistema, asi que con la regla de pedido entregado se marcarian a TODOS los clientes, incluidos los que si han pagado.')
ON CONFLICT (key) DO NOTHING;
-- ── 2 · Puntos anclados al evento que los origina ───────────────────────────
--
-- `com_puntos` guardaba (comercial, regla, periodo, puntos). Con eso, la misma
-- visita puntua una vez por cada vez que se recalcula, porque no hay nada que
-- diga que ya se conto. Se anade la referencia al evento y un indice unico por
-- ella: si el mismo evento vuelve a pasar por la misma regla, la base lo
-- rechaza. No es que el codigo intente no duplicar; es que no PUEDE duplicar.
ALTER TABLE com_puntos ADD COLUMN IF NOT EXISTS ref_tipo TEXT;
ALTER TABLE com_puntos ADD COLUMN IF NOT EXISTS ref_id INTEGER;
ALTER TABLE com_puntos ADD COLUMN IF NOT EXISTS regla_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_com_puntos_evento
  ON com_puntos (comercial_id, regla_code, ref_tipo, ref_id)
  WHERE ref_id IS NOT NULL;

COMMENT ON COLUMN com_puntos.ref_id IS
  'Evento que origina estos puntos (id de visita, de pedido, de cliente). Con el indice unico de al lado, recalcular no puede duplicar.';

-- ── 3 · Alertas comerciales, separadas de las de stock ──────────────────────
DROP VIEW IF EXISTS v_alertas_comerciales;
CREATE OR REPLACE VIEW v_alertas_comerciales AS
WITH seguimiento_alerta AS (
  SELECT
    'SEGUIMIENTO_' || s.situacion            AS kind,
    'com_seguimientos'                       AS entity_type,
    s.id                                     AS entity_id,
    CASE s.situacion
      WHEN 'VENCIDA' THEN 3
      WHEN 'HOY'     THEN 2
      ELSE 1
    END                                       AS severity,
    s.titulo                                 AS title,
    'Tarea de seguimiento ' || s.situacion
      || ' · vence ' || COALESCE(s.vence_en::text, 'sin fecha') AS message,
    -- La clave lleva la situación: una tarea que hoy está «PRÓXIMA» y mañana
    -- «VENCIDA» son dos avisos distintos, y el viejo tiene que dejar de
    -- aparecer. Por eso la situación forma parte de la clave, no solo el id.
    'seg:' || s.id || ':' || s.situacion       AS dedupe_key,
    json_build_object('cliente', s.cliente, 'vence', s.vence_en,
                      'asignado', s.asignado_nombre, 'prioridad', s.prioridad) AS data
  FROM v_com_seguimientos s
  WHERE s.situacion IN ('VENCIDA', 'HOY', 'PROXIMA')
    AND s.estado = 'PENDIENTE'
    AND s.cancelada_at IS NULL
),
incidencia_alerta AS (
  SELECT
    'INCIDENCIA_ABIERTA'                     AS kind,
    'com_incidencias'                        AS entity_type,
    i.id                                     AS entity_id,
    CASE i.gravedad WHEN 'URGENTE' THEN 3 ELSE 2 END AS severity,
    COALESCE(c.name, 'Incidencia') || ' · ' || i.tipo AS title,
    left(i.descripcion, 160)                 AS message,
    -- 3 días sin tocar una incidencia alta es el umbral acordado. Se cuenta
    -- desde `actualizado_at`, no desde `creado_at`: abrirla y no hacer nada no
    -- cuenta como movimiento, y una incidencia tocada hace una semana tampoco
    -- lleva tres días parada.
    'inc:' || i.id || ':' || i.gravedad       AS dedupe_key,
    json_build_object('cliente', c.name, 'gravedad', i.gravedad,
                      'dias_sin_actualizar', (CURRENT_DATE - i.actualizado_at::date)) AS data
  FROM com_incidencias i
  LEFT JOIN customers c ON c.id = i.cliente_id
  WHERE i.estado <> 'RESUELTA'
    AND i.gravedad IN ('ALTA', 'URGENTE')
    AND i.actualizado_at <= now() - INTERVAL '3 days'
),
inactividad_alerta AS (
  -- ⚠ A PROPÓSITO DEVUELVE CERO FILAS.
  --
  -- La regla acordada es «compra válida = pedido entregado», y en este sistema
  -- NO HAY NI UNA ENTREGA: la tabla `deliveries` está vacía. Con esa regla,
  -- cero clientes han comprado y el generador marcaría a todos como inactivos,
  -- incluidos los tres que sí tienen pedido y cobros. Eso no es una alerta
  -- useless: es ruido que enseña a ignorar el resto.
  --
  -- Aquí se deja la cuenta CORRECTA —quién no ha comprado nunca, separado de
  -- quién dejó de comprar— y el interruptor apagado, para que cuando haya
  -- entregas reales se encienda sin tocar código. Hasta entonces, esto no
  -- genera nada y `inactividad_bloqueada` dice por qué.
  SELECT
    'INACTIVIDAD_BLOQUEADA' AS kind,
    'sistema'               AS entity_type,
    0                       AS entity_id,
    1                       AS severity,
    'Alertas de inactividad desactivadas' AS title,
    'No hay entregas registradas, así que ningún cliente puede contar como compra válida.' AS message,
    'inact:bloqueada'       AS dedupe_key,
    '{}'::json              AS data
  WHERE false
)
SELECT * FROM seguimiento_alerta
UNION ALL SELECT * FROM incidencia_alerta
UNION ALL SELECT * FROM inactividad_alerta;
