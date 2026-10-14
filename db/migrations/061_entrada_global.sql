-- ══════════════════════════════════════════════════════════════════════════════
-- 061 · EL NÚMERO DE ENTRADA NO ES ANUAL
--
-- ── EL FALLO ─────────────────────────────────────────────────────────────────
--
-- Al abrir el ejercicio 2027, la serie `ENT` reinició a 1. Las entradas
-- pasaron de la 1176 a la 1 y a la 2, y el numerario quedó con un hueco del 1
-- al 1166 repartido en dos años.
--
-- No es un problema de formato —el número de entrada sigue siendo un entero y
-- `entrada_no` es UNIQUE—, pero sí lo es de substancia:
--
--   · `entrada_no` NO lleva el año dentro. `entrada_no = 1` y `entrada_no = 1`
--     son el MISMO número, y el ejercicio 2030 acabaría chocando con el 1 de
--     2027 en cuanto llegase a la 1001.
--   · La entrada es una recepción de mercancía, no un movimiento de un
--     ejercicio contable. El mismo lote recibido en diciembre y en enero es el
--     mismo lote, y su número no puede depender de dónde cayó la frontera.
--
-- ── LA SOLUCIÓN ──────────────────────────────────────────────────────────────
--
-- Cada serie dice si reinicia al cambiar de año. Las de LOTE y de DOCUMENTO sí,
-- porque su código lleva el año dentro y por eso no hay colisión posible. La de
-- ENTRADA no, porque su código es un número pelado: reiniciar ahí solo puede
-- acabar en una violación de la clave única.
--
-- El cambio de ejercicio sigue ABRIENDO la serie nueva de los lotes. Lo que ya
-- no hace es reiniciar la entrada, que es global desde siempre.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE config_series ADD COLUMN IF NOT EXISTS reinicia_anual boolean NOT NULL DEFAULT true;

UPDATE config_series SET reinicia_anual = false WHERE clase = 'ENTRADA';

COMMENT ON COLUMN config_series.reinicia_anual IS
  'Si está activo, la serie vuelve a 1 al cambiar de ejercicio. Las series cuyo '
  'código lleva el año dentro SÍ deben reiniciar. La de entradas NO, porque su '
  'número es global y reiniciarla choca contra la clave única de lots.entrada_no.';

-- La función lee la serie, así que la bandera nueva se usa sola.
DROP FUNCTION IF EXISTS fn_siguiente_serie(text);

CREATE OR REPLACE FUNCTION fn_siguiente_serie(p_serie text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_anio     integer;
  v_reinicio boolean;
  v_valor    integer;
  v_serie    config_series%ROWTYPE;
BEGIN
  SELECT s.* INTO v_serie FROM config_series s WHERE s.codigo = p_serie;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La serie % no existe', p_serie USING ERRCODE = '22023';
  END IF;
  IF NOT v_serie.is_active THEN
    RAISE EXCEPTION 'La serie % está desactivada', p_serie USING ERRCODE = '22023';
  END IF;

  v_anio := COALESCE(
    NULLIF(NULLIF(current_setting('app.anio_trabajo', true), ''), '0')::integer,
    (SELECT (value #>> '{}')::integer FROM app_config WHERE key = 'numeracion.anio_activo'),
    EXTRACT(YEAR FROM CURRENT_DATE)::integer
  );

  -- La serie manda, no la preferencia global: una serie que no reinicia nunca
  -- reinicia, aunque el ejercicio cambie.
  v_reinicio := v_serie.reinicia_anual AND COALESCE(
    (SELECT (value #>> '{}')::boolean FROM app_config WHERE key = 'numeracion.reinicio_anual'),
    true
  );

  IF v_reinicio THEN
    -- Un ejercicio ABIERTO avanza; uno NUEVO nace en 1. Todo en una sentencia,
    -- para que dos fabricaciones simultáneas no puedan obtener el mismo número.
    INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
    VALUES (p_serie, v_anio, 1)
    ON CONFLICT (serie, anio) DO UPDATE
      SET ultimo_valor = config_series_ejercicio.ultimo_valor + 1
    RETURNING ultimo_valor INTO v_valor;
  ELSE
    -- Serie GLOBAL: un solo contador para siempre, escribas lo que escribas en
    -- `numeracion.anio_activo`. Se guarda bajo el año de creación de la serie,
    -- no bajo el actual, para que cambiar de año no abra un contador nuevo que
    -- volvería a empezar por uno.
    INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
    VALUES (p_serie, COALESCE((SELECT MIN(e.anio) FROM config_series_ejercicio e
                                 WHERE e.serie = p_serie),
                              v_serie.anio, v_anio), 1)
    ON CONFLICT (serie, anio) DO UPDATE
      SET ultimo_valor = config_series_ejercicio.ultimo_valor + 1
    RETURNING ultimo_valor INTO v_valor;
  END IF;

  UPDATE config_series s
     SET ultimo_valor = v_valor, anio = v_serie.anio, actualizado_at = now()
   WHERE s.codigo = p_serie;

  RETURN jsonb_build_object(
    'valor',    v_valor,
    'anio',     v_anio,
    'prefijo',  v_serie.prefijo,
    'digitos',  v_serie.digitos,
    'con_anio', v_serie.con_anio,
    'serie',    v_serie.codigo,
    'clase',    v_serie.clase
  );
END;
$$;

-- La entrada se queda por encima de lo ya emitido. Es un hecho, no un número
-- que se pueda volver a repartir.
UPDATE config_series s
   SET ultimo_valor = GREATEST(
         s.ultimo_valor,
         COALESCE((SELECT MAX(entrada_no) FROM lots WHERE entrada_no IS NOT NULL), 0))
 WHERE s.codigo = 'ENT';

UPDATE config_series_ejercicio e
   SET ultimo_valor = GREATEST(
         e.ultimo_valor,
         COALESCE((SELECT MAX(entrada_no) FROM lots WHERE entrada_no IS NOT NULL), 0))
 WHERE e.serie = 'ENT';
