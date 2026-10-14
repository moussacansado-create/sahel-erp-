-- ══════════════════════════════════════════════════════════════════════════
-- 040 · LAS FUNCIONES DE HECHOS, CON LA COLUMNA BUENA
-- ══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 039 renombró `sales_orders.commercial_id` a `sales_orders.comercial_id`.
-- Las dos funciones que leen esa columna quedaron mirando una columna que ya
-- no existe: el ranking devolvía 500.
--
-- ──────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ NO SE TOCAN LAS MIGRACIONES 026 Y 027
--
-- Porque están aplicadas. Una migración aplicada es historia: se corrige con
-- otra, no editándola. Quien monte la base desde cero aplica 026, 027… y 040,
-- y queda bien. Quien resucite una base de la 035, también: le faltan la 039
-- y la 040 y las aplica en orden.
--
-- ──────────────────────────────────────────────────────────────────────────
--
-- LAS DOS FUNCIONES NO SON LO MISMO, Y POR ESO NO SE MEZCLAN
--
--   fn_hechos_comercial()  la VIEJA, de la 026. Cuenta en `visits`.
--   com_hechos()           la NUEVA, de la 027. Cuenta en `com_visitas`.
--
-- Cada una sigue contando en su tabla. Meter las dos en una sería contar dos
-- veces lo mismo en cuanto la vieja tuviera filas, que es justo lo que no se
-- quiere. Aquí cada función se arregla y nada más.

CREATE OR REPLACE FUNCTION fn_hechos_comercial(
  p_comercial_id INT,
  p_desde        DATE,
  p_hasta        DATE
)
RETURNS TABLE (
  importe        NUMERIC,
  pedidos        BIGINT,
  unidades       NUMERIC,
  visitas        BIGINT,
  clientes_activos BIGINT,
  dias_activos   BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    -- El importe de lo VENDIDO, no lo facturado ni lo cobrado. Cobrar es un
    -- hecho de Caja; vender es un hecho comercial. Mezclarlos hace que el
    -- ranking premie a quien cobra fácil, que no es lo mismo que vender.
    COALESCE((
      SELECT SUM(so.total) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT SUM(v.qty_ordered) FROM v_order_progress v
        JOIN sales_orders so ON so.id = v.order_id
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM visits vi
       WHERE vi.commercial_id = p_comercial_id
         AND vi.visit_date >= p_desde AND vi.visit_date <= p_hasta
    ), 0),
    -- Clientes DISTINTOS con los que ha trabajado. Es lo que distingue a
    -- alguien que visita veinte veces al mismo cliente de uno que abre veinte
    -- puertas.
    COALESCE((
      SELECT COUNT(DISTINCT so.customer_id) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT vi.visit_date) FROM visits vi
       WHERE vi.commercial_id = p_comercial_id
         AND vi.visit_date >= p_desde AND vi.visit_date <= p_hasta
    ), 0);
$$;

CREATE OR REPLACE FUNCTION com_hechos(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS TABLE (
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  visitas BIGINT, clientes_distintos BIGINT, dias_activos BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((
      SELECT SUM(so.total) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT SUM(l.qty) FROM sales_order_lines l
        JOIN sales_orders so ON so.id = l.sales_order_id
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM com_visitas v
       WHERE v.comercial_id = p_comercial_id
         AND v.visita_fecha BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT so.customer_id) FROM sales_orders so
       WHERE so.comercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT v.visita_fecha) FROM com_visitas v
       WHERE v.comercial_id = p_comercial_id
         AND v.visita_fecha BETWEEN p_desde AND p_hasta
    ), 0);
$$;

-- ─── Comprobación ─────────────────────────────────────────────────────────
--
-- Se LLAMAN las dos. Una función `LANGUAGE sql` se analiza al crearla, así que
-- «se ha creado» ya dice mucho; pero lo que de verdad importa es que la
-- llamada devuelva filas, porque ahí es cuando se ejecuta de verdad el plan.

DO $$
DECLARE
  h record;
  p integer;
BEGIN
  SELECT id INTO p FROM com_perfiles ORDER BY id LIMIT 1;

  IF p IS NULL THEN
    RAISE NOTICE 'No hay comerciales todavia; nada que contar.';
  ELSE
    SELECT * INTO h FROM com_hechos(p, CURRENT_DATE - 90, CURRENT_DATE);
    RAISE NOTICE 'com_hechos: % pedidos, % visitas, % importe.',
      h.pedidos, h.visitas, h.importe;

    SELECT * INTO h FROM fn_hechos_comercial(p, CURRENT_DATE - 90, CURRENT_DATE);
    RAISE NOTICE 'fn_hechos_comercial: % pedidos, % visitas.', h.pedidos, h.visitas;
  END IF;
END $$;
