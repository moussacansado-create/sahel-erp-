-- ══════════════════════════════════════════════════════════════════════════════
-- 060 · EL CONTADOR ES POR SERIE Y POR EJERCICIO
--
-- ── EL FALLO ─────────────────────────────────────────────────────────────────
--
-- El contador vivía en la fila de la serie, con un campo `anio` que decía
-- «el año del último número gastado». Funcionaba mientras el año solo avanza,
-- pero al VOLVER a un ejercicio anterior el contador se reiniciaba:
--
--   2026 → lote LAV-2026-000008
--   abrir 2027 → LAV-2027-000001
--   volver a 2026 → «el año no es 2027, reinicio» → LAV-2026-000001
--
-- Y `LAV-2026-000001` YA EXISTÍA. El índice único de `lots.code` lo paró, así
-- que no se creó ningún lote duplicado, pero la recepción falló y el contador
-- quedó en un valor que ya no describe nada.
--
-- ── EL MODELO CORRECTO ───────────────────────────────────────────────────────
--
-- El contador NO es «el último número de la serie»: es «el último número de
-- ESTA serie EN ESTE ejercicio». Ese par es justo lo que ya guarda
-- `config_series_ejercicio`, que la 056 creó para el historial y que nadie
-- estaba usando.
--
-- Con esto:
--   · Abrir 2027 abre una serie nueva en 1, y 2026 se queda en 8.
--   · Volver a 2026 CONTINÚA en 9. No reinicia: el ejercicio ya se abrió.
--   · Cada año tiene su contador y su historial, consultable por separado.
--
-- ── LA CONCURRENCIA SIGUE SIENDO ATÓMICA ─────────────────────────────────────
--
-- La reserva es un `INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre la fila
-- única `(serie, anio)`. Dos producciones simultáneas del mismo producto en el mismo
-- ejercicio se serializan en ESA fila, que es la que existe. El contador por ejercicio es, además, lo que hace posible consultar
-- «cuántos lotes se hicieron en 2025» sin recorrer todos.
-- ── SOBRE EL HISTÓRICO YA GASTADO ───────────────────────────────────────────
--
-- Los lotes que existen son un hecho: si la serie `LAV` ya llegó a la 8 en
-- 2026, sembrar el ejercicio 2026 en 0 haría que el siguiente número
-- chocara contra un código que ya existe. El ejercicio se siembra con el MÁXIMO que
-- aparece en `lots`, y que no se puede reescribir: es el pasado.
-- ══════════════════════════════════════════════════════════════════════════════
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
  v_reinicio := COALESCE(
    (SELECT (value #>> '{}')::boolean FROM app_config WHERE key = 'numeracion.reinicio_anual'),
    true
  );

  IF v_reinicio THEN
    -- Un ejercicio ABIERTO para esta serie avanza; uno NUEVO nace en 1.
    --
    -- Todo en una sentencia: si el ejercicio no existe, se crea con 1; si ya
    -- existe, sube de uno en uno. No hay un `if` por delante que otro proceso
    -- pueda colarse, y por eso dos fabricaciones simultáneas del mismo producto
    -- reciben números distintos en vez de repetir el mismo.
    INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
    VALUES (p_serie, v_anio, 1)
    ON CONFLICT (serie, anio) DO UPDATE
      SET ultimo_valor = config_series_ejercicio.ultimo_valor + 1
    RETURNING ultimo_valor INTO v_valor;
  ELSE
    -- Sin reinicio anual, la serie es UNA sola para siempre.
    INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
    VALUES (p_serie, v_anio, 1)
    ON CONFLICT (serie, anio) DO UPDATE
      SET ultimo_valor = config_series_ejercicio.ultimo_valor + 1
    RETURNING ultimo_valor INTO v_valor;
  END IF;

  -- `config_series` guarda dónde está la serie AHORA. Es informativo: el
  -- contador que manda es el de `config_series_ejercicio`.
  UPDATE config_series s
     SET ultimo_valor = v_valor, anio = v_anio, actualizado_at = now()
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

-- ── SEMBRAR LO YA GASTADO ───────────────────────────────────────────────────
-- El ejercicio en curso de cada serie arranca, como mínimo, donde llegó el
-- histórico real. Si no, la siguienteFabricación volvería a un número que un
-- lote existente ya lleva escrito encima.
INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
SELECT s.codigo,
       COALESCE((SELECT (value #>> '{}')::integer FROM app_config
                  WHERE key = 'numeracion.anio_activo'),
                EXTRACT(YEAR FROM CURRENT_DATE)::integer),
       GREATEST(
         s.ultimo_valor,
         COALESCE((
           SELECT MAX(SUBSTRING(l.code FROM '[0-9]+$'))::int
             FROM lots l
            WHERE s.con_anio
              AND l.code LIKE s.prefijo || '-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-%'
         ), 0),
         COALESCE((
           SELECT MAX(SUBSTRING(l.code FROM '[0-9]+$'))::int
             FROM lots l
            WHERE NOT s.con_anio AND l.code LIKE s.prefijo || '-%'
         ), 0)
       )
  FROM config_series s
 WHERE NOT EXISTS (
   SELECT 1 FROM config_series_ejercicio e
    WHERE e.serie = s.codigo
      AND e.anio = COALESCE((SELECT (value #>> '{}')::integer FROM app_config
                              WHERE key = 'numeracion.anio_activo'),
                             EXTRACT(YEAR FROM CURRENT_DATE)::integer))
ON CONFLICT (serie, anio) DO UPDATE
  SET ultimo_valor = GREATEST(config_series_ejercicio.ultimo_valor, EXCLUDED.ultimo_valor);
