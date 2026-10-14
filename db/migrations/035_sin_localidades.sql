-- ═══════════════════════════════════════════════════════════════════════════
-- 035 · FUERA LAS 18.494 LOCALIDADES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ SE BORRA, Y POR QUÉ ESTO NO SE ESCRIBE EN UN `rm`
--
-- Las localidades de OpenStreetMap se cargaron para poder repartir pueblo a
-- pueblo: REGION > ZONA > LOCALIDAD > COMERCIAL. SeCertificates bien, pero
-- acabó sobrando: para el trabajo diario el mapa de las nueve regiones y sus
-- zonas ya llega, y encima obligaba a buscar y a filtrar para lo que se hace
-- todos los días.
--
-- Se borran las TRES cosas de golpe, porque las tres son lo mismo:
--
--   com_localidad_comercial   a quién cubre cada pueblo
--   com_localidades           los 18.494 pueblos
--   com_mapa_territorio       la vista que los unía
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE NO SE TOCA, Y QUE ES LO IMPORTANTE
--
--   com_zonas            las 9 regiones y sus zonas, con sus polígonos
--   com_perfiles         los comerciales
--   com_comercial_zonas  qué comercial cubre qué zona
--   com_objetivos        los objetivos
--   customers            los clientes
--
-- El mapa de Comerciales se dibuja con com_zonas.poligono, no con las
-- localidades. La ficha, el ranking y la gestión de zonas tampoco las tocan.
-- Esto se borra sin tocar nada de eso.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ UNA MIGRACIÓN Y NO BORRAR LOS FICHEROS .sql
--
-- Una migración aplicada es historia: no se reescribe. La 030, la 032, la 033
-- y la 034 que traían las localidades se quedan donde están, y esta las
-- deshace. Una base nueva que las aplique todas llega al mismo sitio: sin
-- localidades, y con las regiones intactas.

-- Primero la vista: depende de las dos tablas.
DROP VIEW IF EXISTS com_mapa_territorio;

-- Luego el reparto. CASCADE se evita a propósito: si algo que no queremos
-- tocar dependiera de esta tabla, el borrado tiene que FALLAR y decirlo, no
-- llevárselo por delante en silencio.
DROP TABLE IF EXISTS com_localidad_comercial;
DROP TABLE IF EXISTS com_localidades;

-- ─── Comprobación ───────────────────────────────────────────────────────────
--
-- Al final, lo que tiene que seguir ahí. Si esto no cuadra, el borrado ha
-- tocado algo que no debía, y hay que enterarse antes de seguir.

DO $$
DECLARE
  zonas int;
  regiones int;
  comerciales int;
BEGIN
  SELECT count(*) INTO zonas       FROM com_zonas;
  SELECT count(*) INTO regiones    FROM com_zonas WHERE nivel = 'REGION';
  SELECT count(*) INTO comerciales FROM com_perfiles;

  IF zonas < 12 THEN
    RAISE EXCEPTION 'Quedan % zonas; deben quedar al menos 12. Se ha tocado com_zonas.', zonas;
  END IF;
  IF regiones <> 9 THEN
    RAISE EXCEPTION 'Quedan % regiones; deben quedar 9. El mapa se ha quedado sin pais.', regiones;
  END IF;
  IF comerciales = 0 THEN
    RAISE EXCEPTION 'No queda ningun comercial. Algo mas que las localidades ha caido.';
  END IF;

  RAISE NOTICE 'Comprobado: % zonas, % regiones, % comerciales. Las localidades fuera.', zonas, regiones, comerciales;
END $$;
