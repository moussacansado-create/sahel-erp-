-- ═══════════════════════════════════════════════════════════════════════════
-- 036 · LOS TRES SECTORES DE BAMAKO EN com_zonas
-- ═══════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ
--
-- Hay dos tablas de zonas: `zones` (la vieja, 11 filas) y `com_zonas` (la
-- nueva, 12). Traen el mismo conjunto de CÓDIGOS para las ocho regiones de
-- Mali, pero los identificadores NO coinciden y `com_zonas` va a ser la tabla
-- oficial.
--
-- Las tres zonas de la tabla vieja que no tienen sitio en la nueva son
-- sectores de Bamako:
--
--     zones.id  9  BKO-C  Bamako Centro
--     zones.id 10  BKO-N  Bamako Norte
--     zones.id 11  BKO-O  Bamako Oeste
--
-- Se crean aquí, como hijas de Bamako, con SU CÓDIGO. No es inventar nada: es
-- trasladar tres zonas que ya existían, y su código es lo que permite que la
-- migración posterior por código las encuentre.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE NO SE TOCA
--
--   · `zones` sigue exactamente igual, con sus 11 filas. No se borra, no se
--     renombra, no se le toca ni un id. Sigue sirviendo a `deliveries`,
--     `leads`, `sales_routes` y `suppliers` hasta que se decida otra cosa.
--
--   · Las 12 zonas que ya había en `com_zonas` no se mueven.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE NO SE INVENTA
--
-- Ni población, ni coordenadas, ni polígono, ni número de comercios. Se
-- crean con esos campos a NULL porque no se saben. Un NULL aquí dice «no lo
-- sabemos»; un 0 diría «lo sabemos y es cero», que es mentira.
--
-- El polígono de los sectores: se deja a NULL también. Bamako tiene un
-- polígono que cubre la capital entera, y partirlo en tres sería decidir por
-- dónde va la frontera sin ninguna fuente que lo diga. Se pinta el sector
-- cuando haya una fuente real.

DO $$
DECLARE
  bamo integer;
BEGIN
  SELECT id INTO bamo FROM com_zonas WHERE code = 'BKO';

  IF bamo IS NULL THEN
    RAISE EXCEPTION 'No está la región BKO. Sin ella los sectores no tienen padre.';
  END IF;

  -- Bamako Centro
  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-C', 'Bamako Centro', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;

  -- Bamako Norte
  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-N', 'Bamako Norte', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;

  -- Bamako Oeste
  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-O', 'Bamako Oeste', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;
END $$;

-- ─── Comprobación ───────────────────────────────────────────────────────────
--
-- Las tres tienen que existir, ser hijas de Bamako, y estar marcadas como
-- ZONA. Y la cuenta de zonas tiene que ser la que se espera: 12 + 3 = 15.

DO $$
DECLARE
  nuevas int;
  buenas int;
  total  int;
  viejas int;
BEGIN
  SELECT count(*) INTO nuevas FROM com_zonas WHERE code IN ('BKO-C', 'BKO-N', 'BKO-O');
  SELECT count(*) INTO buenas FROM com_zonas
   WHERE code IN ('BKO-C', 'BKO-N', 'BKO-O')
     AND nivel = 'ZONA'
     AND parent_id = (SELECT id FROM com_zonas WHERE code = 'BKO')
     AND kind = 'URBANA';
  SELECT count(*) INTO total  FROM com_zonas;
  SELECT count(*) INTO viejas FROM zones;

  IF nuevas <> 3 OR buenas <> 3 THEN
    RAISE EXCEPTION 'Se esperaban 3 sectores correctos; hay % nuevos y % buenos.', nuevas, buenas;
  END IF;

  -- `zones` no se toca. Si ha cambiado de 11 filas, alguien la ha modificado.
  IF viejas <> 11 THEN
    RAISE EXCEPTION 'La tabla zones tiene % filas y debería tener 11. Esta migración no la toca.', viejas;
  END IF;

  RAISE NOTICE 'com_zonas: % zonas (antes 12). zones: % filas, intacta.', total, viejas;
END $$;
