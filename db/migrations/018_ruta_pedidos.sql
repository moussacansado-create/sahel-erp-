-- ─────────────────────────────────────────────────────────────────────────────
-- LA HOJA DE RUTA SON PEDIDOS, NO ALBARANES.
--
-- ANTES
--
-- La hoja de reparto se armaba sobre `albaranes`:
--
--     FROM albaranes a JOIN sales_orders o ON o.id = a.sales_order_id
--
-- Y de ahí salía todo lo que parecía una regla:
--
--   · el albarán tenía que estar en PRINTED o SIGNED para que la parada
--     apareciera en la ruta;
--   · «en el camión» contaba albaranes IMPRESOS;
--   · «por cerrar» contaba albaranes FIRMADOS;
--   · para anotar que no se pudo entregar hacía falta un albarán.
--
-- O sea: para poder REPARTIR había que IMPRIMIR antes. El documento se había
-- colado en el centro de la operación, que es justo lo que no debe pasar: el
-- albarán es el papel que se lleva el repartidor y que firma el cliente, no la
-- llave que abre la ruta.
--
-- AHORA
--
-- La ruta la llevan los PEDIDOS que quedan por servir, estén o no impresos:
--
--   PREPARED   → preparado, pendiente entero
--   IN_ROUTE   → entregado a medias, queda resto
--
-- El albarán se pega a la fila como lo que es —el papel de ese viaje— con un
-- LEFT JOIN. Si no hay albarán, la fila sale igual, con `albaran_id` a NULL, y
-- el repartidor puede entregar desde la tarjeta y imprimir después.
--
-- LO QUE NO CAMBIA
--
--   · `EN_CAMINO` sigue siendo la lista de estados en los que un albarán está
--     en la calle: impreso o firmado.
--   · El albarán sigue siendo de una sola página y puede llevar varias copias.
--   · Imprimir o firmar un albarán NO sigue tocando `sales_orders`.
--   · La entrega la confirma la tarjeta, y solo ella.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Notas de la ruta ────────────────────────────────────────────────────────
--
-- «No pude entregar: el cliente no estaba».
--
-- Se guardaban en `albaran_events`, que cuelga de un albarán con
-- `albaran_id NOT NULL`. O sea: solo se podía anotar el motivo si además
-- existía el papel, cuando lo que pasó en la puerta no tiene nada que ver con
-- si se llegó a imprimir.
--
-- Estas notas cuelgan de la PARADA, que es el sitio donde ocurrió el hecho: el
-- pedido y el motivo. Si además hay un albarán, se anota también en su
-- historial, porque el papel que vuelve sin firmar es una pista más.
CREATE TABLE IF NOT EXISTS route_notes (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  motivo      TEXT    NOT NULL CHECK (length(btrim(motivo)) >= 3),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_notes_pedido ON route_notes (order_id, created_at DESC);

COMMENT ON TABLE route_notes IS
  'Motivos por los que no se pudo entregar. NO cambian el estado del pedido ni '
  'mueven stock: la mercancía sigue siendo de la fábrica y la entrega sigue sin '
  'hacerse. Solo se guarda el porqué, para no ir tres días seguidos a la misma '
  'puerta sin saber qué pasa.';

COMMENT ON COLUMN route_notes.motivo IS
  'Por qué no se pudo entregar. Lo escribe el repartidor, en el móvil, en la puerta.';
