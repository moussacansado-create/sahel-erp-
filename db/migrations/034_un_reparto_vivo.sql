-- ═══════════════════════════════════════════════════════════════════════════
-- 034 · UN SOLO REPARTO VIVO, Y EL HISTÓRICO QUE SE ACUMULE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 030 puso:
--
--   CONSTRAINT uniq_localidad_comercial UNIQUE (localidad_id, comercial_id, desde)
--
-- Incluía la FECHA. El intento era no repetir la misma asignación, pero lo
-- que hizo fue HISTÓRICAR con la misma llave, y el histórico tiene fecha:
-- dos repartos del mismo pueblo al mismo comercial el mismo día son la MISMA
-- tupla.
--
-- Y eso pasa el primer día, de la manera más tonta:
--
--   1 · Se asigna Ségou a Amadou.
--   2 · «Uy, no era ese» → se le quita.
--   3 · Se vuelve a asignar a Amadou. Mismo día. Misma localidad.
--   4 · La base lo rechaza.
--
-- No se puede deshacer una asignación ni deshacerla bien, y no es un caso
-- raro: es lo que pasa cada vez que alguien se corrige a media tarde.
--
-- Peor aún: como la restricción estaba sobre TODAS las filas, ningún
-- histórico podía repetirse jamás. El pasado quedaba escrito una sola vez.
--
-- LO QUE PASA AHORA
--
-- La regla de negocio real es: un pueblo, un comercial, UNA asignación
-- VIGENTE. El historial es otra cosa y vive sin estorbar.
--
--   · índice único sobre (localidad_id, comercial_id) SOLO de las vivas;
--   · las cerradas se acumulan las veces que haga falta.
--
-- Y esto no afloja nada: seguiría siendo imposible tener al mismo comercial
-- repartiendo dos veces el mismo pueblo a la vez. Lo único que se permite es
-- que el pasado exista.

DO $$
DECLARE
  dobles int;
BEGIN
  SELECT count(*) INTO dobles FROM (
    SELECT localidad_id, comercial_id
      FROM com_localidad_comercial
     WHERE hasta IS NULL
     GROUP BY localidad_id, comercial_id
    HAVING count(*) > 1
  ) d;

  IF dobles > 0 THEN
    RAISE EXCEPTION
      'Hay % repartos vivos repetidos (mismo pueblo, mismo comercial). Limpiar antes de seguir.', dobles;
  END IF;
END $$;

ALTER TABLE com_localidad_comercial
  DROP CONSTRAINT IF EXISTS uniq_localidad_comercial;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_localidad_comercial_viva
  ON com_localidad_comercial(localidad_id, comercial_id)
  WHERE hasta IS NULL;
