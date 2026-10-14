-- ─────────────────────────────────────────────────────────────────────────────
-- EL CÓDIGO DEL CLIENTE VUELVE A SER `CL-#####`.
--
-- Decisión de la empresa: se conserva el formato de siempre. La aplicación
-- nueva generates `CLI-0001` y la antigua `CL-00001`; tener los dos formatos
-- conviviendo significa que el repartidor ve «CLI-0007» en un sitio y
-- «CL-00007» en otro, y que nadie sabe cuál es el bueno.
--
-- QUÉ SE MIGRÓ
--
--   CLI-0001  →  CL-00001
--   CLI-0042  →  CL-00042
--
-- A CINCO DÍGITAS, que es como los llevaba la aplicación antigua y como
-- aparecen en los albaranes que ya están archivados en papel.
--
-- POR QUÉ ES SEGURO
--
-- Ninguna tabla guarda el código del cliente: todas lo referencian por `id`.
-- Se comprobó una por una antes de escribir esto:
--
--   sales_orders.customer_id        → customers(id)
--   leads.customer_id              → customers(id)
--   visits.customer_id             → customers(id)
--   customer_stats.customer_id     → customers(id)
--
-- El albarán y la tarjeta leen `c.code` en el momento de imprimirse, así que no
-- hay ningún documento que haya que reeditar: salen con el formato nuevo solos.
--
-- Y lo que NO se toca: los pedidos, las entregas, el stock y el historial.
-- Esto solo cambia una etiqueta. Un pedido de ayer sigue siendo el mismo
-- pedido, y su albarán se sigue GUIDando igual.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 · Los que hay, al formato nuevo.
--
-- Se hace con regex y no a mano para que sirva igual da igual cuántos haya. La
-- condición evita tocar cualquier otra cosa que se parezca a un CLI-####.
UPDATE customers
   SET code = 'CL-' || lpad(regexp_replace(code, '^CLI-0*', ''), 5, '0')
 WHERE code ~ '^CLI-[0-9]+$';

-- 2 · La lista, por si alguien la mira desde fuera.
COMMENT ON COLUMN customers.code IS
  'Código de cliente. Formato CL-##### (cinco dígitos), el de siempre. '
  'Se renombró CLI-#### → CL-##### unificado el formato con la aplicación antigua.';
