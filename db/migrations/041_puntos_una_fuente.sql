-- ══════════════════════════════════════════════════════════════════════════
-- 041 · LOS PUNTOS, CON UNA SOLA FUENTE DE VERDAD
-- ══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- Hay dos cosas que se llaman «los puntos» y no son la misma:
--
--   com_puntos_de()   la VERDAD. Se calcula cada vez, con las reglas de ahora
--                     y los hechos del periodo.
--   com_puntos        un CONGELADO. Lo escribe `concederPuntos()` para que un
--                     bono ya pagado no cambie si mañana suben los puntos por
--                     visita.
--
-- Las dos tienen su razón. El fallo es que la API las mezclaba: sacaba el
-- TOTAL de la primera y el DESGLOSE de la segunda.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE PASABA EN PANTALLA
--
--   { "puntos": 2, "detalle": [] }
--
-- Un total y un desglose que no suman. Y no es un caso raro: el desglose solo
-- aparecía después de pulsar «conceder», así que la respuesta normal del
-- sistema era un número sin explicación. Si alguien miraba esa pantalla para
-- entender por qué alguien tiene 2 puntos, no había manera de saberlo.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LA SOLUCIÓN
--
-- Que el desglose lo produzca la MISMA función que el total, y que no dependa
-- de que nadie haya pulsado nada. Se hace en SQL, no en JavaScript, y por una
-- razón que ya está escrita en el código: si el total y el desglose los
-- calculara cada uno por su lado, los dos números serían ciertos y los dos
-- mentirían.
--
-- Por eso `com_puntos_detalle()` devuelve las filas, y `com_puntos_de()`
-- pasa a ser la SUMA de esas mismas filas. No hay dos cálculos: hay uno, y el
-- otro lo suma. Si alguna vez se separan, es un fallo de alguien.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LA TABLA `com_puntos` NO SE TOCA
--
-- Sigue siendo el registro de lo concedido, con su motivo y su fecha. Lo que
-- deja de hacer es ser la fuente del desglose que ve la pantalla. Son cosas
-- distintas: «lo que ha ganado este mes» y «lo que se le ha pagado y cerrado».
-- Confundirlas era el problema.

CREATE OR REPLACE FUNCTION com_puntos_detalle(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS TABLE (
  regla_id     INT,
  regla        TEXT,
  metrica      TEXT,
  puntos       NUMERIC,
  umbral       NUMERIC,
  tope         NUMERIC,
  logrado      NUMERIC,
  puntos_otorgados NUMERIC
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  h          RECORD;
  v_objetivo NUMERIC := 0;
  v_logrado  NUMERIC;
  v_puntos   NUMERIC;
  r          RECORD;
BEGIN
  -- Sin comercial no hay puntos que detallar. Se devuelve vacío, no cero
  -- filas inventadas: quien lo llame tiene que poder distinguir «no hay
  -- detalle» de «hay detalle y vale cero».
  IF p_comercial_id IS NULL THEN RETURN; END IF;

  SELECT * INTO h FROM com_hechos(p_comercial_id, p_desde, p_hasta);

  -- El objetivo se busca POR COMERCIAL, no por periodo. Buscarlo por periodo
  -- hacía que el cumplimiento nunca saliera, porque `p_comercial_id` no es lo
  -- que se guarda en esa tabla.
  SELECT COALESCE(MAX(o.target_amount), 0) INTO v_objetivo
    FROM com_objetivos o
   WHERE o.comercial_id = p_comercial_id AND o.is_active
     AND CURRENT_DATE BETWEEN o.period_start AND o.period_end;

  FOR r IN SELECT * FROM com_reglas_puntos WHERE is_active ORDER BY orden, id
  LOOP
    v_logrado := CASE r.metrica
      WHEN 'TARGET_ACHIEVEMENT'  THEN CASE WHEN v_objetivo > 0
             THEN h.importe / v_objetivo * 100 ELSE 0 END
      WHEN 'ORDERS'             THEN h.pedidos
      WHEN 'UNITS'              THEN h.unidades
      WHEN 'VISITS'             THEN h.visitas
      WHEN 'DISTINCT_CUSTOMERS' THEN h.clientes_distintos
      ELSE 0
    END;

    -- Sin objetivo, la regla de cumplimiento NO CUENTA. No es que saque 0
    -- puntos: es que no hay contra qué medirse.
    CONTINUE WHEN r.metrica = 'TARGET_ACHIEVEMENT' AND v_objetivo <= 0;
    CONTINUE WHEN v_logrado < r.umbral;

    v_puntos := (v_logrado - r.umbral) * r.puntos;
    v_puntos := CASE WHEN r.tope IS NOT NULL THEN LEAST(v_puntos, r.tope)
                     ELSE v_puntos END;

    regla_id        := r.id;
    regla           := r.nombre;
    metrica         := r.metrica;
    puntos          := r.puntos;
    umbral          := r.umbral;
    tope            := r.tope;
    logrado         := v_logrado;
    puntos_otorgados := v_puntos;
    RETURN NEXT;
  END LOOP;
END $$;

-- El total AHORA ES LA SUMA DEL DETALLE.
--
-- No es una segunda forma de calcular lo mismo: es la suma. Si el detalle y el
-- total se separan alguna vez, es que alguien ha vuelto a meter dos
-- cálculos, y se ve en el primer test que mire la pantalla.
CREATE OR REPLACE FUNCTION com_puntos_de(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(ROUND(SUM(d.puntos_otorgados), 2), 0)
    FROM com_puntos_detalle(p_comercial_id, p_desde, p_hasta) d
$$;

-- ─── Comprobación ──────────────────────────────────────────────────────────
--
-- Se comprueba QUE EL TOTAL ES LA SUMA DEL DETALLE, con los dos leídos por
-- separado. Es la misma promesa que hace la pantalla, escrita aquí para que
-- no dependa de que alguien mire.

DO $$
DECLARE
  p      integer;
  v_calc NUMERIC;
  v_det  NUMERIC;
BEGIN
  SELECT id INTO p FROM com_perfiles ORDER BY id LIMIT 1;
  IF p IS NULL THEN
    RAISE NOTICE 'No hay comerciales todavia; nada que sumar.';
    RETURN;
  END IF;

  SELECT com_puntos_de(p, CURRENT_DATE - 90, CURRENT_DATE) INTO v_calc;
  SELECT COALESCE(ROUND(SUM(puntos_otorgados), 2), 0)
    INTO v_det
    FROM com_puntos_detalle(p, CURRENT_DATE - 90, CURRENT_DATE);

  IF v_calc IS DISTINCT FROM v_det THEN
    RAISE EXCEPTION
      'El total (%) no es la suma del detalle (%). Vuelven a ser dos calculos.', v_calc, v_det;
  END IF;

  RAISE NOTICE 'com_puntos_de = % y el detalle suma %. Coinciden.', v_calc, v_det;
END $$;
