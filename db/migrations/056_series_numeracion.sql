-- ══════════════════════════════════════════════════════════════════════════════
-- 056 · SERIES DE NUMERACIÓN ANUAL CONFIGURABLES
--
-- Los lotes se numeraban `PT-DES-00001`: sin año y con un contador que no se
-- reiniciaba nunca. Eso no sirve en una fábrica:
--
--   · No se sabe en qué ejercicio se fabricó un lote sin mirar la fecha.
--   · El año 2030 seguiría con `PT-DES-00020` y nadie podría distinguir un
--     lote de este año del de hace nueve.
--   · El prefijo estaba clavado en el código, no en un sitio que se pueda
--     cambiar sin tocar código.
--
-- ── EL FORMATO ───────────────────────────────────────────────────────────────
--
--   PREFIJO-AÑO-NÚMERO     DES-2026-000001
--
-- ── LAS CUATRO REGLAS QUE NO SE PUEDEN ROMPER ────────────────────────────────
--
-- 1. Cada serie empieza en 000001 al abrir el año. El contador se reinicia SÓLO
--    cuando cambia el año de la fila, dentro del propio `ON CONFLICT`.
--
-- 2. Nunca se reutiliza un número. No hace falta bloquear nada para Avoidinglo:
--    el año forma parte del código, así que `DES-2026-000001` y
--    `DES-2027-000001` son distintos por construcción, y dentro de un año el
--    contador solo sube. `lots.code` es UNIQUE y es la última red.
--
-- 3. Dos usuarios a la vez reciben números distintos. El `INSERT … ON CONFLICT
--    DO UPDATE … RETURNING` es atómico en PostgreSQL: dos transacciones
--    simultáneas sobre la misma fila se serializan solas.
--
-- 4. Cambiar el prefijo NO reescribe el pasado. Esta tabla guarda CÓMO se
--    numera a partir de ahora; los lotes ya existentes conservan su código
--    guardado en `lots.code`, que no se toca. Un lote de 2024 sigue siendo
--    `PT-DES-00001` aunque mañana el prefijo sea `DES`.
--
-- ── LOS LOTES ANTIGUOS ───────────────────────────────────────────────────────
--
-- No se renumeran. Se quedan con `PT-DES-00001` y `MP-00001` tal cual, y siguen
-- consultables para siempre. Renumerar el histórico sería reescribir el pasado
-- de unas instalaciones que ya salieron de fábrica.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE SEQUENCE IF NOT EXISTS config_series_codigo_seq;

CREATE TABLE IF NOT EXISTS config_series (
  codigo        text PRIMARY KEY
                  CHECK (codigo ~ '^[A-Z0-9]{2,8}$'),
  nombre        text NOT NULL,
  -- Qué clase de cosa numera: PRODUCTO, MATERIA_PRIMA, ENVASE, ENTRADA,
  -- FABRICACION, PEDIDO, ALBARAN, DOCUMENTO.
  clase         text NOT NULL
                  CHECK (clase IN ('PRODUCTO','MATERIA_PRIMA','ENVASE','ENTRADA',
                                   'FABRICACION','PEDIDO','ALBARAN','DOCUMENTO')),
  prefijo       text NOT NULL
                  CHECK (prefijo ~ '^[A-Z0-9]{1,8}$'),
  -- El formato se arma con el nombre. Se guarda POR QUÉ se numera cada cosa,
  -- no una cadena: así cambiar los dígitos no rompe la serie.
  digitos       integer NOT NULL DEFAULT 6 CHECK (digitos BETWEEN 1 AND 12),
  con_anio      boolean NOT NULL DEFAULT true,
  -- Año del contador. NULL hasta la primera vez que se usa.
  anio          integer CHECK (anio IS NULL OR anio BETWEEN 2000 AND 2200),
  ultimo_valor  integer NOT NULL DEFAULT 0 CHECK (ultimo_valor >= 0),
  -- El prefijo con el que YA se numeró. Si alguien cambia `prefijo`, esto
  -- guarda el anterior y se avisa: los códigos viejos no se reescriben.
  prefijo_anterior text,
  is_active     boolean NOT NULL DEFAULT true,
  actualizado_por integer REFERENCES users(id),
  actualizado_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE config_series IS
  'Series de numeración. Una fila = una serie. El contador avanza por año y el '
  'año va en el código, así que un número nunca se reutiliza aunque el '
  'contador se reinicie.';
COMMENT ON COLUMN config_series.anio IS
  'Año del último número gastado. Cambiarlo reinicia la serie; por eso guarda '
  'el ejercicio, para poder consultar el histórico de cada uno.';

-- ── SERIES QUE YA EXISTEN, con el número por el que van ──────────────────────
-- `ultimo_valor` se toma del contador REAL que usaba el sistema, no de 0: si no,
-- el primer lote de 2026 saldría DES-2026-000001 y el código ya existiría.
INSERT INTO config_series (codigo, nombre, clase, prefijo, digitos, con_anio, ultimo_valor, anio)
VALUES
  ('DES', 'Desinfectante 750 ml',   'PRODUCTO',       'DES', 6, true, 5,  NULL),
  ('LAV', 'Lavavajillas 500 ml',    'PRODUCTO',       'LAV', 6, true, 12, NULL),
  ('LIM', 'Limpiador multiusos 1 L', 'PRODUCTO',       'LIM', 6, true, 5,  NULL),
  ('MP',  'Materia prima',          'MATERIA_PRIMA',  'MP',  5, false, 5, NULL),
  ('ENV', 'Envases y embalaje',      'ENVASE',         'ENV', 5, false, 4, NULL),
  ('ENT', 'Entrada de mercancía',    'ENTRADA',        'ENT', 4, true,  0,  NULL),
  ('FAB', 'Orden de fabricación',    'FABRICACION',    'FAB', 4, true,  0,  NULL),
  ('PED', 'Pedido de venta',         'PEDIDO',         'PED', 4, true,  0,  NULL),
  ('ALB', 'Albarán',                 'ALBARAN',        'ALB', 4, true,  0,  NULL)
ON CONFLICT (codigo) DO NOTHING;

-- El contador de ENTRADA no empieza a cero: la secuencia global ya llegó a 1075
-- y esos números están en uso. Se arranca desde el máximo REAL.
UPDATE config_series
   SET ultimo_valor = GREATEST(
     ultimo_valor,
     COALESCE((SELECT MAX(entrada_no) FROM lots), 0),
     COALESCE((SELECT MAX(last_value) FROM code_counters WHERE scope = 'LOTE:' || codigo), 0)
   )
 WHERE clase IN ('ENTRADA','PRODUCTO');

-- ── AÑO DE TRABAJO ───────────────────────────────────────────────────────────
-- Se guarda en `app_config` para que Configuración pueda cambiarlo sin tocar
-- código, y para que «las SERIES de cada ejercicio» se puedan consultar.
INSERT INTO app_config (key, value, description) VALUES
  ('numeracion.anio_activo', to_char(CURRENT_DATE, 'YYYY')::jsonb,
   'Ejercicio en curso. Al cambiarlo se abre la serie nueva sin tocar la anterior.'),
  ('numeracion.digitos_lote', '6'::jsonb,
   'Dígitos del número de lote de fabricación.'),
  ('numeracion.reinicio_anual', 'true'::jsonb,
   'Si está activo, cada serie vuelve a empezar en 1 al cambiar de año.'),
  ('numeracion.formato', '"PREFIJO-ANIO-NUMERO"'::jsonb,
   'Formato del código de lote. El año es lo que impide reutilizar números.')
ON CONFLICT (key) DO NOTHING;

-- ── HISTÓRICO DE SERIES ──────────────────────────────────────────────────────
-- Cada vez que el contador se abre para un año nuevo, se guarda una fila. Sin
-- esto, «¿cuántos lotes se hicieron en 2025?» obliga a recorrer todos los lotes.
-- La secuencia va ANTES de la tabla: en un `CREATE TABLE` el DEFAULT se
-- evalúa en el momento de crearla, y si la secuencia no existe, la sentencia
-- falla y la migración entera se deshace.
CREATE SEQUENCE IF NOT EXISTS config_series_ejercicio_id_seq;

CREATE TABLE IF NOT EXISTS config_series_ejercicio (
  id            integer PRIMARY KEY DEFAULT nextval('config_series_ejercicio_id_seq'),
  serie         text NOT NULL REFERENCES config_series(codigo),
  anio          integer NOT NULL,
  ultimo_valor  integer NOT NULL,
  abierto_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (serie, anio)
);

COMMENT ON TABLE config_series_ejercicio IS
  'Un registro por serie y ejercicio. Es el historial de la numeración: qué se '
  'abrió cada año y hasta dónde llegó. Los lotes de años anteriores se '
  'consultan aquí aunque su código no se cambie nunca.';

-- ══════════════════════════════════════════════════════════════════════════════
-- EL NUMERADOR
-- ══════════════════════════════════════════════════════════════════════════════

/**
 * Siguiente número de una serie.
 *
 * Devuelve el VALOR, no el código: el código lo arma el llamante con la serie
 * que le toca, porque una entrada y un lote de producto no se parecen en nada
 * aunque compartan tabla.
 *
 * El caso difícil es el cambio de año, y por eso está DENTRO del `ON CONFLICT`:
 * si el año de la fila no es el de hoy, el contador vuelve a 1 y se anota el
 * ejercicio nuevo. Si el año es el de hoy, sube de uno en uno. Las dos ramas
 * ocurren en una sola sentencia atómica, así que dos transacciones
 * simultáneas no pueden obtener el mismo número ni saltarse uno.
 */
CREATE OR REPLACE FUNCTION fn_siguiente_serie(p_serie text)
RETURNS TABLE(valor integer, anio integer, prefijo text, digitos integer, con_anio boolean)
LANGUAGE plpgsql AS $$
DECLARE
  v_anio integer;
  v_reinicio boolean;
  v_fila config_series%ROWTYPE;
BEGIN
  SELECT s.* INTO v_fila FROM config_series s WHERE s.codigo = p_serie;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La serie % no existe', p_serie USING ERRCODE = '22023';
  END IF;
  IF NOT v_fila.is_active THEN
    RAISE EXCEPTION 'La serie % está desactivada', p_serie USING ERRCODE = '22023';
  END IF;

  -- El año de trabajo manda sobre el del reloj: si el administrador abrió el
  -- ejercicio 2027 en diciembre, los lotes de diciembre son de 2027.
  v_anio := COALESCE(
    NULLIF(NULLIF(current_setting('app.anio_trabajo', true), ''), '0')::integer,
    (SELECT (value #>> '{}')::integer FROM app_config WHERE key = 'numeracion.anio_activo'),
    EXTRACT(YEAR FROM CURRENT_DATE)::integer
  );
  v_reinicio := COALESCE(
    (SELECT (value #>> '{}')::boolean FROM app_config WHERE key = 'numeracion.reinicio_anual'),
    true
  );

  UPDATE config_series s
     SET ultimo_valor = CASE
           WHEN v_reinicio AND s.anio IS DISTINCT FROM v_anio THEN 1
           ELSE s.ultimo_valor + 1
         END,
         anio = v_anio,
         actualizado_at = now()
   WHERE s.codigo = p_serie
  RETURNING s.ultimo_valor, s.anio, s.prefijo, s.digitos, s.con_anio INTO valor, anio, prefijo, digitos, con_anio;

  -- El ejercicio que se acaba de abrir queda en el historial.
  INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
  VALUES (p_serie, anio, valor)
  ON CONFLICT (serie, anio) DO UPDATE SET ultimo_valor = GREATEST(
    config_series_ejercicio.ultimo_valor, EXCLUDED.ultimo_valor);

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_siguiente_serie(text) IS
  'Reserva el siguiente número de una serie. Atómico: dos llamadas '
  'simultáneas sobre la misma serie nunca devuelven el mismo número.';
