-- ═══════════════════════════════════════════════════════════════════════════
-- 013 · EL ALBARÁN LLEVA LO QUE LLEVA ESE VIAJE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── EL PROBLEMA ───────────────────────────────────────────────────────────
--
-- El albarán se imprimía con las líneas del PEDIDO entero, y al entregarlo se
-- servía todo lo servible. Eso no permite entregas parciales por línea.
--
-- Peor: había DOS maneras de entregar el mismo pedido.
--
--   · POST /api/albaranes/:id/entregar  → cierra el albarán Y el pedido. Bien.
--   · POST /api/deliveries              → cerraba el pedido y se dejaba el
--                                         albarán en DRAFT para siempre.
--
-- Con la segunda, un pedido podía estar ENTREGADO mientras su albarán seguía
-- en la lista de «por entregar». Dos verdades sobre la misma entrega, y la que
-- se ve primero es la equivocada.
--
-- ── LA SOLUCIÓN ───────────────────────────────────────────────────────────
--
-- El albarán pasa a llevar SUS PROPIAS LÍNEAS: lo que ese viaje lleva. Con eso
--
--   · una entrega parcial por línea sigue siendo posible, y queda IMPRESA en
--     el documento, que es lo que el cliente firma;
--   · todo lo que cierra una entrega pasa por el albarán, porque el albarán
--     es lo que tiene la firma;
--   · el estado del pedido se deriva de lo servido, y el albarán y el pedido
--     dejan de poder discrepar.
--
-- `qty` es lo que se lleva el cliente en ESTE viaje. Lo pendiente del pedido
-- sigue en `sales_order_lines.qty - qty_delivered`.

CREATE TABLE IF NOT EXISTS albaran_lines (
  id            BIGSERIAL PRIMARY KEY,
  albaran_id    INTEGER NOT NULL REFERENCES albaranes(id) ON DELETE CASCADE,
  order_line_id INTEGER NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  qty           NUMERIC(18,4) NOT NULL CHECK (qty > 0),
  unit_id       INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT albaran_lines_unica UNIQUE (albaran_id, order_line_id)
);

COMMENT ON TABLE albaran_lines IS
  'Lo que lleva ESTE viaje. Un albarán por viaje, no por pedido.';

-- La búsqueda de la ruta: por albarán, una fila por línea.
CREATE INDEX IF NOT EXISTS idx_albaran_lines_albaran ON albaran_lines (albaran_id);
CREATE INDEX IF NOT EXISTS idx_albaran_lines_pedido  ON albaran_lines (order_line_id);

-- No se puede llevar más de lo que queda pendiente de esa línea.
--
-- Se comprueba con un disparador, no con una comprobación en el código: entre
-- que se crea el albarán y que se entrega pueden pasar horas, y para entonces
-- otra entrega puede haberse llevado la misma mercancía. Que lo impida la base
-- y no dependa de que nadie se acuerde de mirar.
CREATE OR REPLACE FUNCTION fn_albaran_linea_no_supera_pendiente() RETURNS TRIGGER AS $$
DECLARE
  pedido     INTEGER;
  pedido_linea NUMERIC(18,4);
  ya_servido NUMERIC(18,4);
  otros     NUMERIC(18,4);
BEGIN
  SELECT l.sales_order_id, l.qty, l.qty_delivered
    INTO pedido, pedido_linea, ya_servido
    FROM sales_order_lines l WHERE l.id = NEW.order_line_id;

  -- Lo que OTROS albaranes ya estén comprometidos para esa misma línea, sin
  -- contar este. Si dos albaranes se montan a la vez sobre las mismas 10
  -- unidades, los dos dirían que las llevan.
  SELECT COALESCE(SUM(al.qty), 0) INTO otros
    FROM albaran_lines al
    JOIN albaranes a ON a.id = al.albaran_id
   WHERE al.order_line_id = NEW.order_line_id
     AND al.id <> NEW.albaran_id
     AND a.status IN ('DRAFT','PRINTED','SIGNED');

  IF NEW.qty > (pedido_linea - ya_servido - otros) + 0.0001 THEN
    RAISE EXCEPTION
      'ALBARAN_SUPERA_PENDIENTE: el albarán pide % unidades de la línea %, pero solo quedan % por servir (ya en otros albaranes: %).',
      NEW.qty, NEW.order_line_id, pedido_linea - ya_servido, otros
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_albaran_linea_no_supera_pendiente
  BEFORE INSERT OR UPDATE ON albaran_lines
  FOR EACH ROW EXECUTE FUNCTION fn_albaran_linea_no_supera_pendiente();
