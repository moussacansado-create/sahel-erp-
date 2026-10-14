-- ─────────────────────────────────────────────────────────────────────────────
-- UNA ENTREGA NO ES SIEMPRE EL CIERRE DEL PEDIDO.
--
-- La migración 015 creó este índice:
--
--   uniq_entrega_por_pedido_confirmada
--     ON deliveries (sales_order_id)
--     WHERE status = 'DELIVERED' AND confirmed_at IS NOT NULL
--
-- La intención era buena: que un pedido no se cerrara dos veces. La herramienta
-- era mala.
--
-- `deliveries.status` dice si ESTA entrega se hizo, no si el PEDIDO se terminó.
-- Cuando el repartidor sirve la mitad y quedan mercaderías para otro día, esa
-- entrega está hecha y muy bien, y su fila vale DELIVERED. El pedido es el que
-- pasa a IN_ROUTE.
--
-- Con el índice, la segunda parada del reparto reventaba con «duplicate key»:
-- el cliente con tres cajas y el repartidor con tres visitas no podía
-- registrar la segunda. Una regla de integridad convertida en una avería.
--
-- QUÉ GARANTIZA QUE NO SE CIERRE DOS VECES, EN REALIDAD:
--
--   · `sales_order_lines.qty_delivered` no puede pasar de `qty`. Es el libro
--     mayor, y no admite más mercancía de la que se pidió.
--   · `fn_pedido_estado_coherente` rechaza un pedido DELIVERED con líneas
--     pendientes. Si al cerrar faltara una línea por sumar, la base lo dice.
--   · `confirmarDesdeTarjeta` rechaza un pedido ya entregado.
--
-- Tres capas, y la de arriba es la que se equivoca con un ORDER BY, no con un
-- índice único sobre la columna equivocada.
--
-- Lo que sí se conserva: `deliveries.sales_order_id` sigue indexado para poder
-- listar el historial de un pedido.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS uniq_entrega_por_pedido_confirmada;

CREATE INDEX IF NOT EXISTS idx_deliveries_pedido ON deliveries (sales_order_id);
