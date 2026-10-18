-- ═══════════════════════════════════════════════════════════════════════════
-- 077 · EL DESCARTE NO ES UNA REESCRITURA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 075 puso un disparador que impide tocar una comisión confirmada:
--
--   «La comisión de % ya esta confirmada. No se puede reescribir:
--    hay que registrar un ajuste.»
--
-- Correcto en el fondo. Pero el disparador miraba SI HUBO CAMBIO, y no
-- miraba QUÉ cambio. Y el descarte —devolver un mes a revisión porque el
-- administrador se equivocó al confirmar— también cambia esos campos: los
-- vacía. Así que el disparador, que existía para proteger la comisión, la
-- dejaba en un estado en el que no se podía ni corregir ni preparar de
-- nuevo. Un mes confirmado con un error quedaba congelado con el error.
--
-- LA DISTINCIÓN
--
--   REESCRITURAR  → cambiar un importe por otro. Prohibido, siempre.
--   DESCARTAR     → vaciarlo todo y devolver el mes a revisión. Es una
--                    corrección trazada, y tiene que poder hacerse.
--
-- La diferencia se ve en el propio cambio: en un descarte, TODO lo
-- congelado pasa a NULL a la vez, y el mes vuelve a 'PENDIENTE_REVISION'.
-- En una reescritura, un valor se sustituye por otro. No hay forma de que
-- una se confunda con la otra.
--
-- Y el descarte queda escrito: quién, cuándo, por qué, y cuál era el
-- importe que se apartó. El histórico no pierde nada.
--
-- La 075 NO se toca. Esto es una migración nueva que corrige el disparador.
--
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION com_comision_bloquea_confirmada()
RETURNS TRIGGER AS $$
DECLARE
  es_descarte BOOLEAN;
BEGIN
  es_descarte := (
    NEW.base_confirmada        IS NULL
    AND NEW.porcentaje_confirmado IS NULL
    AND NEW.comision_confirmada   IS NULL
    AND NEW.confirmado_en        IS NULL
    AND NEW.confirmado_por       IS NULL
    AND NEW.estado = 'PENDIENTE_REVISION'
  );

  IF OLD.comision_confirmada IS NOT NULL AND NOT es_descarte THEN
    IF NEW.base_confirmada        IS DISTINCT FROM OLD.base_confirmada
    OR NEW.porcentaje_confirmado IS DISTINCT FROM OLD.porcentaje_confirmado
    OR NEW.comision_confirmada   IS DISTINCT FROM OLD.comision_confirmada
    OR NEW.periodo                IS DISTINCT FROM OLD.periodo
    OR NEW.comercial_id           IS DISTINCT FROM OLD.comercial_id THEN
      RAISE EXCEPTION 'La comision de % ya esta confirmada. No se puede reescribir: '
        'hay que registrar un ajuste.', OLD.periodo
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- El pago solo avanza: no se puede des-pagar en silencio.
  IF OLD.estado = 'PAGADA' AND NEW.estado <> 'PAGADA' THEN
    RAISE EXCEPTION 'Una comision pagada no vuelve a estar pendiente sin un ajuste audited.'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION com_comision_bloquea_confirmada() IS
  'Impide REESCRIBIR una comision confirmada. El descarte —vaciarlo todo y devolver el mes a revision— si se permite, y queda auditado.';
