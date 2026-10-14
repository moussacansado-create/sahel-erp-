-- ═══════════════════════════════════════════════════════════════════════════
-- CleanSahel ERP · Migración 007 · Vistas
-- ═══════════════════════════════════════════════════════════════════════════
-- Aquí vive la "única fuente de verdad" en forma consultable.
--
-- El stock NO se calcula en el código de la aplicación: se calcula UNA vez,
-- aquí, y todas las pantallas leen la misma vista. Si dos pantallas
-- necesitasen cifras distintas, saldrían de la misma definición.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Existencias por artículo ───────────────────────────────────────────────
-- El stock es la suma de los lotes utilizables. Ni una columna más.

CREATE VIEW v_item_stock AS
SELECT
  i.id                                            AS item_id,
  i.sku,
  i.name,
  i.category_kind,
  i.min_stock,
  i.purchase_cost,
  i.sale_price,
  COALESCE(SUM(l.qty_available) FILTER (
      WHERE l.status = 'ACTIVE'
        AND (l.expiry_date IS NULL OR l.expiry_date > now())
    ), 0)                                          AS qty_on_hand,
  COALESCE(SUM(l.qty_available) FILTER (
      WHERE l.status = 'QUARANTINE'
    ), 0)                                          AS qty_quarantined,
  COALESCE(SUM(l.qty_available) FILTER (
      WHERE l.status = 'BLOCKED'
    ), 0)                                          AS qty_blocked,
  COALESCE(SUM(l.qty_available) FILTER (
      WHERE l.status = 'RETIRED'
    ), 0)                                          AS qty_retired,
  COALESCE(SUM(l.qty_available) FILTER (
      WHERE l.status = 'ACTIVE'
        AND l.expiry_date IS NOT NULL AND l.expiry_date <= now()
    ), 0)                                          AS qty_expired,
  COUNT(*) FILTER (WHERE l.status = 'ACTIVE' AND l.qty_available > 0) AS active_lots
FROM items i
LEFT JOIN lots l ON l.item_id = i.id
WHERE i.is_active
GROUP BY i.id, i.sku, i.name, i.category_kind, i.min_stock, i.purchase_cost, i.sale_price;

COMMENT ON VIEW v_item_stock IS
  'Existencias por artículo. Esta es LA definición de stock del sistema.';

-- ─── Existencias netas de un artículo ───────────────────────────────────────

CREATE VIEW v_item_available AS
SELECT
  s.*,
  COALESCE(r.qty_reserved, 0)  AS qty_reserved,
  GREATEST(s.qty_on_hand - COALESCE(r.qty_reserved, 0), 0) AS qty_available,
  (s.qty_on_hand < s.min_stock) AS is_below_min
FROM v_item_stock s
LEFT JOIN (
  SELECT item_id, SUM(qty) AS qty_reserved
  FROM order_reservations
  WHERE status IN ('ACTIVE','ASSIGNED')
  GROUP BY item_id
) r ON r.item_id = s.item_id;

-- ─── Valorización ───────────────────────────────────────────────────────────

CREATE VIEW v_inventory_value AS
SELECT
  i.category_kind,
  COUNT(DISTINCT i.id)                                    AS items,
  COALESCE(SUM(s.qty_on_hand), 0)                          AS total_qty,
  COALESCE(SUM(s.qty_on_hand * i.purchase_cost), 0)        AS value_at_cost,
  COALESCE(SUM(s.qty_on_hand * i.sale_price), 0)           AS value_at_sale
FROM v_item_stock s
JOIN items i ON i.id = s.item_id
GROUP BY ROLLUP(i.category_kind);

-- ─── FEFO ───────────────────────────────────────────────────────────────────
-- Los lotes que deben consumirse antes, con el motivo explícito para que el
-- operario pueda entender la decisión. La app muestra esto antes de fabricar.

CREATE VIEW v_fefo_candidates AS
SELECT
  l.id AS lot_id,
  l.code,
  l.item_id,
  i.sku,
  i.name AS item_name,
  l.qty_available,
  l.unit_id,
  l.expiry_date,
  l.received_at,
  l.status,
  ROW_NUMBER() OVER (PARTITION BY l.item_id ORDER BY l.expiry_date NULLS LAST, l.received_at) AS priority,
  CASE
    WHEN l.expiry_date IS NULL THEN 'Sin caducidad'
    WHEN l.expiry_date <= now() THEN 'CADUCADO'
    WHEN l.expiry_date <= now() + interval '30 days' THEN 'Caduca en menos de 30 días'
    WHEN l.expiry_date <= now() + interval '90 days' THEN 'Caduca en menos de 90 días'
    ELSE 'Caduca más adelante'
  END AS expiry_reason
FROM lots l
JOIN items i ON i.id = l.item_id
WHERE l.status = 'ACTIVE' AND l.qty_available > 0;

-- ─── Contadores de lotes ────────────────────────────────────────────────────
-- Calculados desde los datos, nunca inventados. Si creo un lote, aparece; si
-- recargo, sigue ahí; si reinicio, también.

CREATE VIEW v_lot_counters AS
SELECT
  l.lot_kind,
  COUNT(*)                                                     AS total,
  COUNT(*) FILTER (WHERE l.status = 'ACTIVE')                  AS active,
  COUNT(*) FILTER (WHERE l.status = 'BLOCKED')                 AS blocked,
  COUNT(*) FILTER (WHERE l.status = 'QUARANTINE')              AS quarantine,
  COUNT(*) FILTER (WHERE l.status = 'EXHAUSTED')               AS exhausted,
  COUNT(*) FILTER (WHERE l.status = 'RETIRED')                 AS retired,
  COUNT(*) FILTER (WHERE l.status = 'EXPIRED')                 AS expired,
  COUNT(*) FILTER (WHERE l.status = 'ACTIVE'
                     AND l.expiry_date IS NOT NULL
                     AND l.expiry_date <= now() + interval '30 days') AS expiring_soon,
  COALESCE(SUM(l.qty_available), 0)                            AS total_qty
FROM lots l
GROUP BY l.lot_kind;

-- ─── Trazabilidad hacia delante: lote de MP → … → clientes ─────────────────
-- Responde "¿dónde acabó esto?" recorriendo la cadena real.

CREATE VIEW v_trace_forward AS
SELECT DISTINCT
  mp_lot.code                      AS source_lot_code,
  pm.lot_id                        AS source_lot_id,
  i_src.sku                        AS source_sku,
  i_src.name                       AS source_name,
  p.code                           AS production_code,
  pt_lot.code                      AS finished_lot_code,
  pt_lot.id                        AS finished_lot_id,
  i_pt.sku                         AS finished_sku,
  i_pt.name                        AS finished_name,
  so.code                          AS order_code,
  so.id                            AS order_id,
  c.name                           AS customer_name,
  d.code                           AS delivery_code,
  d.delivered_at,
  dl.qty_delivered
FROM production_materials pm
JOIN lots mp_lot      ON mp_lot.id = pm.lot_id
JOIN items i_src      ON i_src.id = mp_lot.item_id
JOIN productions p    ON p.id = pm.production_id
JOIN lots pt_lot      ON pt_lot.production_id = p.id AND pt_lot.lot_kind = 'FINISHED_GOOD'
JOIN items i_pt       ON i_pt.id = pt_lot.item_id
LEFT JOIN delivery_lines dl ON dl.lot_id = pt_lot.id
LEFT JOIN deliveries d     ON d.id = dl.delivery_id
LEFT JOIN sales_orders so  ON so.id = d.sales_order_id
LEFT JOIN customers c      ON c.id = so.customer_id;

-- ─── Trazabilidad hacia atrás: pedido → … → proveedores ─────────────────────
-- Responde "¿de qué se hizo esto?" recorriendo la cadena real.

CREATE VIEW v_trace_backward AS
SELECT DISTINCT
  so.code            AS order_code,
  so.id              AS order_id,
  c.name             AS customer_name,
  z.name             AS zone_name,
  i_pt.sku           AS product_sku,
  i_pt.name          AS product_name,
  pt_lot.code        AS finished_lot_code,
  p.code             AS production_code,
  i_mp.sku           AS material_sku,
  i_mp.name          AS material_name,
  mp_lot.code        AS material_lot_code,
  sup.name           AS supplier_name,
  sup.country        AS supplier_country,
  mp_lot.invoice_ref,
  pm.actual_qty      AS qty_consumed,
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

-- ─── Producción con su coste real ───────────────────────────────────────────

CREATE VIEW v_production_cost AS
SELECT
  p.id AS production_id,
  p.code,
  i.sku, i.name,
  p.planned_qty, p.actual_qty, p.waste_qty, p.unit_id,
  p.waste_qty / NULLIF(p.planned_qty, 0)              AS waste_ratio,
  COALESCE(SUM(pm.actual_qty * it.purchase_cost), 0)   AS material_cost,
  COALESCE(SUM(pm.actual_qty * it.purchase_cost), 0)
    / NULLIF(p.actual_qty, 0)                         AS cost_per_unit
FROM productions p
JOIN items i ON i.id = p.product_id
LEFT JOIN production_materials pm ON pm.production_id = p.id
LEFT JOIN items it ON it.id = pm.item_id
WHERE p.status = 'COMPLETED'
GROUP BY p.id, p.code, i.sku, i.name, p.planned_qty, p.actual_qty, p.waste_qty, p.unit_id;
