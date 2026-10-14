-- ═══════════════════════════════════════════════════════════════════════════
-- 033 · EL PRINCIPAL DE UNA LOCALIDAD, SOLO SI SIGUE VIVO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 030 creó el índice así:
--
--   CREATE UNIQUE INDEX uniq_localidad_principal
--     ON com_localidad_comercial(localidad_id) WHERE es_principal;
--
-- La condición es SOLO `es_principal`. No mira `hasta`.
--
-- Y `quitarLocalidades` no borra la fila: le pone `hasta = HOY` y la deja
-- ahí, que es lo correcto para poder saber quién cubría qué. Pero esa fila
-- cerrada SIGUE TENIENDO `es_principal = TRUE`, y el índice único sigue
-- contando.
--
-- Qué pasaba, en el uso normal de un lunes por la mañana:
--
--   1 · Ségou la lleva el comercial A.
--   2 · Se cambia: A deja Ségou y la lleva el comercial B.
--   3 · `asignarLocalidades` pone `hasta` en la fila de A.
--   4 · Al meter a B… la base dice que ya hay un principal.
--   5 · La asignación se rechaza. Para siempre.
--
-- El pueblo queda sin comercial y no hay forma de volver a asignarlo por la
-- vía normal. No es un caso raro: es exactamente lo que pasa la primera vez
-- que se reorganiza un reparto.
--
-- LO QUE PASA AHORA
--
-- El índice mira las filas VIVAS:
--
--   WHERE es_principal AND hasta IS NULL
--
-- Una fila cerrada es historial, y el historial no bloquea el presente.
--
-- ANTES DE TIRAR EL ÍNDICE VIEJO
--
-- Se comprueba que no haya localidades con dos principals VIVOS. Si las
-- hubiera, se dice y se para: eso sería un dato creado por una vía que ya
-- no existe, y elegir cuál de los dos es el bueno a mano.

DO $$
DECLARE
  dobles int;
BEGIN
  SELECT count(*) INTO dobles FROM (
    SELECT localidad_id
      FROM com_localidad_comercial
     WHERE es_principal AND hasta IS NULL
     GROUP BY localidad_id
    HAVING count(*) > 1
  ) d;

  IF dobles > 0 THEN
    RAISE EXCEPTION
      'Hay % localidades con mas de un comercial principal VIVO. Repartir antes de seguir.', dobles;
  END IF;
END $$;

DROP INDEX IF EXISTS uniq_localidad_principal;

CREATE UNIQUE INDEX uniq_localidad_principal
  ON com_localidad_comercial(localidad_id)
  WHERE es_principal AND hasta IS NULL;
