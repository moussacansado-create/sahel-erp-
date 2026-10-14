-- 009 · Trazabilidad utilizable desde la interfaz
--
-- MOTIVO
-- ------
-- `v_trace_backward` existía desde la Fase 0, pero se escribieron sus columnas
-- pensando en el esquema, no en pintarlas. Le faltan tres cosas que cualquier
-- pantalla necesita:
--
--   · finished_lot_id  — para filtrar «este lote». Sin el id solo había un
--                        código, y filtrar por texto es frágil.
--   · source_lot_id    — para poder saltar desde un lote de MP al producto.
--   · delivery_code y delivered_at — para saber CUÁNDO y en QUÉ entrega salió.
--
-- Ahora la pantalla de trazabilidad recibe 500 al pedir el recorrido inverso.
-- No es un fallo de lógica: es que la vista no tenía lo que se le pedía.
--
-- Es una migración sobre una VISTA, que no guarda datos: se tira y se vuelve a
-- levantar. No se puede usar CREATE OR REPLACE porque PostgreSQL solo permite
-- AÑADIR columnas al final, nunca reordenarlas ni renombrarlas.
--
-- No toca ni una fila de ninguna tabla.

BEGIN;

DROP VIEW IF EXISTS v_trace_backward;

CREATE VIEW v_trace_backward AS
SELECT DISTINCT
  dl.lot_id                        AS finished_lot_id,
  pt_lot.code                      AS finished_lot_code,
  i_pt.sku                         AS product_sku,
  i_pt.name                        AS product_name,
  p.code                           AS production_code,
  p.id                             AS production_id,
  d.id                             AS delivery_id,
  d.code                           AS delivery_code,
  d.delivered_at,
  d.rep_id,
  d.signature_url,
  so.code                          AS order_code,
  so.id                            AS order_id,
  c.name                           AS customer_name,
  c.code                           AS customer_code,
  z.name                           AS zone_name,
  mp_lot.id                        AS source_lot_id,
  mp_lot.code                      AS material_lot_code,
  i_mp.sku                         AS material_sku,
  i_mp.name                        AS material_name,
  sup.name                         AS supplier_name,
  sup.country                      AS supplier_country,
  mp_lot.invoice_ref,
  pm.actual_qty                    AS qty_consumed,
  dl.qty_delivered,
  mp_lot.unit_id
FROM delivery_lines dl
JOIN deliveries d      ON d.id = dl.delivery_id
JOIN sales_orders so   ON so.id = d.sales_order_id
JOIN customers c       ON c.id = so.customer_id
LEFT JOIN zones z      ON z.id = c.zone_id
JOIN lots pt_lot       ON pt_lot.id = dl.lot_id
JOIN items i_pt        ON i_pt.id = pt_lot.item_id
LEFT JOIN productions p ON p.id = pt_lot.production_id
LEFT JOIN production_materials pm ON pm.production_id = p.id
LEFT JOIN lots mp_lot  ON mp_lot.id = pm.lot_id
LEFT JOIN items i_mp   ON i_mp.id = mp_lot.item_id
LEFT JOIN suppliers sup ON sup.id = mp_lot.supplier_id;

COMMENT ON VIEW v_trace_backward IS
  'De una entrega hacia atrás: qué lote se entregó, de qué producción salió, y qué lotes de materia prima se consumieron en esa producción.';

-- Índices: la pantalla filtra por lote en cada sentido.
CREATE INDEX IF NOT EXISTS idx_delivery_lines_lot ON delivery_lines(lot_id);
CREATE INDEX IF NOT EXISTS idx_production_materials_lot ON production_materials(lot_id);
CREATE INDEX IF NOT EXISTS idx_production_materials_prod ON production_materials(production_id);

COMMIT;
