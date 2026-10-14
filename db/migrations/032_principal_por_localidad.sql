-- ═══════════════════════════════════════════════════════════════════════════
-- 032 · UN COMERCIAL PUEDE SER PRINCIPAL DE MUCHAS LOCALIDADES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL ÍNDICE QUE SE VUELA
--
-- La 030 creó dos índices únicos:
--
--   uniq_localidad_principal            una localidad → un principal
--   uniq_comercial_localidad_principal  un comercial → una localidad
--
-- El primero es correcto y se queda: una localidad tiene un solo comercial
-- principal, que es el que responde por ella.
--
-- El SEGUNDO es un error, y rompe el uso normal. Decía que un comercial podía
-- ser principal de una sola localidad. Un comercial que cubre sus 50 pueblos
-- no podía ser principal de ninguno más que del primero: al meter el segundo,
-- la base rechazaba la operación entera.
--
-- No es un caso raro. Es lo que pasa en cuanto se asignan dos pueblos seguidos
-- al mismo comercial, que es exactamente lo que hace una persona al repartir
-- un distrito.
--
-- LO QUE PASA AHORA
--
--   · una localidad tiene UN comercial principal;
--   · un comercial es principal de TANTAS localidades como cubren.
--
-- El reparto no se reparte a medias: cada pueblo tiene un dueño claro.

DROP INDEX IF EXISTS uniq_comercial_localidad_principal;

-- Sigue habiendo una sola zona principal por comercial, pero eso es otra
-- tabla. Aquí lo que se vigila es que un comercial no sea "el principal" de
-- dos personas distintas sobre la misma localidad, que el primer índice ya
-- impide por ser único en la localidad.

-- ─── Comprobación de que el arreglo no rompe nada ───────────────────────────
--
-- Si al tirar el índice hubiera localidades con DOS principales, hay que
-- saberlo y no dejarlo pasar. Se avisa y se para: significa que se creó el
-- dato por una vía que ya no existe.

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
      'Hay % localidades con mas de un comercial principal. Repartir antes de seguir.', dobles;
  END IF;
END $$;
