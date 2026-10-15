-- 073 · LIMPIEZA DE LOS DATOS DE DEMOSTRACIÓN
--
-- Este DELETE lo autoriza el usuario de forma expresa, por escrito, después
-- de ver el inventario: 115 clientes y 373 pedidos, 373 entregas y 130 pagos
-- generados por scripts de prueba, con la copia de seguridad ya hecha y
-- verificada (`respaldos-nube/nube-20261015-225713.json`).
--
-- ── LO QUE NO SE TOCA, Y POR QUÉ ────────────────────────────────────────
--
--   · `users`, `roles`, `permissions`, `role_permissions` — las personas.
--   · `audit_log` — el rastro. Una limpieza que se lleva el historial deja
--     la base sin explicación de por qué está como está.
--   · `com_zonas`, `com_perfiles`, `com_comercial_zonas` — el equipo y el
--     territorio, que son reales aunque los comercial sean de prueba.
--   · `app_config`, `config_series`, `currencies` — la configuración.
--   · `items` y `lots` — el catálogo y el stock NO se borran aquí; se
--     desactivan más abajo, porque un producto que estuvo en un lote tiene
--     que seguir existiendo para que el lote siga diciendo la verdad.
--
-- ── EL ORDEN IMPORTA ─────────────────────────────────────────────────────
--
-- Las claves foráneas están en `ON DELETE RESTRICT` o `CASCADE` según la
-- tabla, y mezclar el orden da un error a mitad de la operación. Se va de la
-- hoja más colgante a la raíz: pagos, líneas de entrega, entregas, reservas,
-- líneas de pedido, pedidos y por último clientes. Todo en una sola
-- transacción: o sale entero o no sale nada.
--
-- Se usan `CASCADE` explícitos donde la tabla tiene hijos, para que si
-- aparece una tabla nueva que dependa de estas, se borre también en vez de
-- dejar un cascado a medias que corte la operación por la mitad.

BEGIN;

-- 1 · Cobros. Primero: son los que cuelgan de la entrega y del pedido.
DELETE FROM payments WHERE sales_order_id IN (SELECT id FROM sales_orders);

-- 2 · Líneas de entrega, y luego las entregas.
DELETE FROM delivery_lines WHERE delivery_id IN (SELECT id FROM deliveries);
DELETE FROM deliveries;

-- 3 · Reservas de stock. Se sueltan antes de borrar los pedidos: si no,
--    el almacén se queda con existencias apartadas por pedidos que ya no
--    existen, y ese stock no vuelve nunca a estar disponible sin que alguien
--    lo note.
DELETE FROM order_reservations WHERE sales_order_id IN (SELECT id FROM sales_orders);

-- 4 · Las líneas del pedido y el pedido.
DELETE FROM sales_order_lines WHERE sales_order_id IN (SELECT id FROM sales_orders);
DELETE FROM sales_orders;

-- 5 · Movimientos de stock de las entregas, si los hubiera.
DELETE FROM stock_movements WHERE delivery_id IS NOT NULL
   AND delivery_id NOT IN (SELECT id FROM deliveries);

-- 6 · Por último, los clientes. Cuando se llega aquí ya no tienen pedidos,
--    entregas ni cobros colgando: es la prueba de que el orden era el
--    correcto, y por eso va el último y no antes.
DELETE FROM customers;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CATÁLOGO: lo que se queda activo
-- ═════════════════════════════════════════════════════════════════════════
--
-- Se DESACTIVA, no se borra. Motivo: hay 120 lotes que apuntan a estos
-- artículos, y un lote sin artículo es un lote que no dice qué contiene.
-- Desactivados, no se pueden elegir en una producción nueva —que es lo que
-- se pidió— pero el histórico sigue siendo legible.
--
-- Se conservan activos los tres que se usan para las pruebas:
--   · PT-LAVAV  Lavavajillas Sahel 500 ml
-- y se crearán aparte «Desengrasante Sahel» y «Fregasuelos Sahel».

UPDATE items SET is_active = FALSE, updated_at = now()
 WHERE sku IN ('PT-JABON', 'PT-DESIN', 'PT-GEL', 'PT-CLORO', 'PT-LIMPI');

-- Comprobación, a la vista: si esto no cuadra, la limpieza no ha hecho lo
-- que decía hacer y es mejor que se note aquí y no en producción.
DO $$
DECLARE
  c INT; o INT; p INT; d INT; a INT;
BEGIN
  SELECT count(*) INTO c FROM customers;
  SELECT count(*) INTO o FROM sales_orders;
  SELECT count(*) INTO p FROM payments;
  SELECT count(*) INTO d FROM deliveries;
  SELECT count(*) INTO a FROM items WHERE is_active;
  RAISE NOTICE 'limpieza: clientes=% pedidos=% pagos=% entregas=% items_activos=%', c, o, p, d, a;
  -- El lote es el que dice qué se fabricó. Si un lote se queda sin artículo,
  -- el histórico se rompe y no hay forma de saber qué se vendió en su día.
  IF EXISTS (SELECT 1 FROM lots l WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.id = l.item_id)) THEN
    RAISE EXCEPTION 'Hay lotes sin artículo: la limpieza ha roto el histórico';
  END IF;
END;
$$;
