-- ══════════════════════════════════════════════════════════════════════════════
-- 057 · ARREGLO DE LA 056
--
-- Dos fallos que aparecieron al aplicar la 056. Ninguno ha producido todavía
-- ni un lote, así que no hay histórico que reescribir: solo se corrigen los
-- valores y la función.
--
-- ── 1 · LA SEMILLA CRUZÓ LOS CONTADORES ─────────────────────────────────────
--
-- El `GREATEST` de la 056 aplicaba `MAX(lots.entrada_no)` —que hoy es 1166— a
-- TODAS las series de clase PRODUCTO. Así que DES arrancaba en 1166 cuando su
-- contador real era 5: el primer lote de desinfectante de 2026 habría salido
-- `DES-2026-001167`, y no por un salto: por una serie a la que se le copió el
-- número de otra.
--
-- Cada clase se queda con SU contador:
--   · ENTRADA  → el mayor `entrada_no` emitido.
--   · PRODUCTO → el contador de lotes que decía `LOTE:<PREFIJO>`.
--
-- ── 2 · `anio` AMBIGUO DENTRO DE LA FUNCIÓN ──────────────────────────────────
--
-- `RETURNS TABLE(valor, anio, …)` crea una VARIABLE llamada `anio`, y dentro
-- del plpgsql choca con la COLUMNA `config_series.anio`. Postgres no sabe cuál
-- de las dos es y la función no compilaba.
--
-- Se devuelve un `jsonb` en lugar de una fila: no hay nombres que puedan
-- chocar, y el servidor solo tiene que serializar un valor.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1 · Cada serie, con SU contador ──────────────────────────────────────────
UPDATE config_series s
   SET ultimo_valor = CASE s.clase
         WHEN 'ENTRADA' THEN COALESCE((SELECT MAX(entrada_no) FROM lots), 0)
         WHEN 'PRODUCTO' THEN COALESCE(
              (SELECT last_value FROM code_counters WHERE scope = 'LOTE:' || s.codigo), 0)
         ELSE s.ultimo_valor
       END
 WHERE s.clase IN ('ENTRADA', 'PRODUCTO');

-- ── 2 · La función, sin colisión de nombres ──────────────────────────────────
-- Hay que DROPEARLA antes del CREATE: `CREATE OR REPLACE` puede cambiar el
-- cuerpo, pero NO el tipo de retorno. Pasar de `RETURNS TABLE(...)` a
-- `RETURNS jsonb` sin dropearla da un error que no dice por qué falla.
DROP FUNCTION IF EXISTS fn_siguiente_serie(text);

CREATE OR REPLACE FUNCTION fn_siguiente_serie(p_serie text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_anio    integer;
  v_reinicio boolean;
  v_valor   integer;
  v_serie   config_series%ROWTYPE;
BEGIN
  SELECT s.* INTO v_serie FROM config_series s WHERE s.codigo = p_serie;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La serie % no existe', p_serie USING ERRCODE = '22023';
  END IF;
  IF NOT v_serie.is_active THEN
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

  -- El cambio de año vive DENTRO del UPDATE, no en un IF de antes: así las dos
  -- ramas ocurren en una sola sentencia atómica y dos transacciones
  -- simultáneas no pueden obtener el mismo número.
  UPDATE config_series s
     SET ultimo_valor = CASE
           WHEN v_reinicio AND s.anio IS DISTINCT FROM v_anio THEN 1
           ELSE s.ultimo_valor + 1
         END,
         anio = v_anio,
         actualizado_at = now()
   WHERE s.codigo = p_serie
  RETURNING s.ultimo_valor INTO v_valor;

  -- El ejercicio que se acaba de abrir queda en el historial.
  INSERT INTO config_series_ejercicio (serie, anio, ultimo_valor)
  VALUES (p_serie, v_anio, v_valor)
  ON CONFLICT (serie, anio) DO UPDATE
    SET ultimo_valor = GREATEST(config_series_ejercicio.ultimo_valor, EXCLUDED.ultimo_valor);

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
