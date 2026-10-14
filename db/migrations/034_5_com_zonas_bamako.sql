-- ══════════════════════════════════════════════════════════════════════════
-- 034_5 · LOS SECTORES DE BAMAKO, ANTES DE QUE LOS PIDA EL GUARDIÁN
-- ══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 035 borra las localidades y, al hacerlo, se vigila: antes de soltar el
-- martillo comprueba que siguen ahí ≥12 zonas, 9 regiones y algún comercial.
-- Es un buen guardián: avisa si el borrado se ha comido de más.
--
-- El problema es que la 036, que crea los tres sectores de Bamako, se ejecuta
-- DESPUÉS de la 035. Así que en una base recién montada, cuando el guardián
-- mira, hay 9 regiones y ni un sector más. Falla por 3 filas que existirían
-- treinta segundos después.
--
-- ──────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ NO SE TOCA LA 035 NI LA 036
--
-- Las dos están aplicadas, y el migrador comprueba el checksum: si el fichero
-- cambia, se niega a arrancar. Editarlas no es «arreglarlas», es romper la
-- historia.
--
-- ──────────────────────────────────────────────────────────────────────────
--
-- QUÉ HACE ESTA
--
-- Lo mismo que la 036, pero antes. Mismos códigos, mismos nombres, mismos
-- padres, mismo `ON CONFLICT DO NOTHING`. CERO filas nuevas: no inventa
-- ninguna zona, adelanta tres que ya existían. Cuando llegue la 036 no
--pasará que hacer nada porque ya están todas.
--
-- En la base de trabajo esto no cambia NADA: los sectores ya existen y el
-- conflicto se resuelve solo. Solo importa en una instalación desde cero.

DO $$
DECLARE
  bamo integer;
BEGIN
  SELECT id INTO bamo FROM com_zonas WHERE code = 'BKO';
  IF bamo IS NULL THEN
    -- Sin Bamako no hay dónde colgar los sectores. Se avisa y se sigue: que
    -- el resto de migraciones decida, en vez de parar aquí con un error que
    -- no explica de dónde viene.
    RAISE NOTICE 'No se encontro la region BKO; no se crean los sectores.';
    RETURN;
  END IF;

  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-C', 'Bamako Centro', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;

  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-N', 'Bamako Norte', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;

  INSERT INTO com_zonas (code, name, parent_id, kind, is_active, nivel)
  VALUES ('BKO-O', 'Bamako Oeste', bamo, 'URBANA', TRUE, 'ZONA')
  ON CONFLICT (code) DO NOTHING;
END $$;
