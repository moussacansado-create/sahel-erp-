-- ═════════════════════════════════════════════════════════════════════════════
-- 030 · QUE LA FICHA DE ZONA MIRE EL PERÍODO QUE SE LE PIDE
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EL PROBLEMA, Y POR QUÉ NO SE VÍA CUANDO HAY UN SOLO OBJETIVO
--
-- `com_ficha_zona` enlaza el objetivo con `CURRENT_DATE BETWEEN period_start
-- AND period_end`: el objetivo «de hoy». Pero la ficha se pide con un período
-- —un trimestre, un año, un tramo a medida— y el objetivo que le encaja es el
-- de ESE período, no el de hoy.
--
-- Con un solo objetivo puesto, las dos cosas coinciden y no se nota. En cuanto
-- hay un objetivo para el mes que viene, la ficha pedida por «octubre» enseña
-- el de noviembre o ninguno: se ve un guion donde debería haber un 62,5 %.
--
-- Y el caso aún más claro: un comercial que pregunta «¿cómo va el trimestre?» y
-- le sale el objetivo del mes. No es un número mentira, es el número de otro
-- período, y por eso es peor que un cero.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LA MANERA
--
-- `com_ficha_zona` pasa a ser una FUNCIÓN con el período como parámetro, en
-- lugar de una vista que usa la fecha de hoy. Se llama igual que antes —con
-- dos argumentos— y quien la use sin argumentos recibe el mes en curso, que es
-- lo que hacía.
--
-- No se añade una vista nueva con otro nombre: sería tener dos maneras de
-- pedir lo mismo y acabarían discrepando.
--
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION com_ficha_zona(p_desde DATE DEFAULT NULL, p_hasta DATE DEFAULT NULL)
RETURNS TABLE (
  zona_id INT, code TEXT, name TEXT, kind TEXT,
  latitude NUMERIC, longitude NUMERIC,
  potencial_pendiente BOOLEAN,
  poblacion INT, comercios_estimados INT, clientes_potenciales INT, dificultad INT,
  tiene_objetivo BOOLEAN, target_amount NUMERIC, target_units NUMERIC,
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  clientes_activos BIGINT, clientes_totales BIGINT,
  visitas BIGINT, nuevos_clientes BIGINT,
  cumplimiento_pct NUMERIC,
  comerciales_asignados BIGINT, comerciales JSONB
)
LANGUAGE sql STABLE AS $$
  -- Sin fechas, el mes en curso. Es lo que se veía antes y lo que quiere
  -- quien abre Comerciales sin tocar ningún filtro.
  WITH per AS (
      SELECT
        COALESCE(p_desde, date_trunc('month', CURRENT_DATE)::date) AS desde,
        COALESCE(p_hasta, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date) AS hasta
    )
  SELECT
    z.id, z.code, z.name, z.kind, z.latitude, z.longitude,
    (z.poblacion IS NULL OR z.clientes_potenciales IS NULL
     OR z.comercios_estimados IS NULL OR z.dificultad IS NULL),
    z.poblacion, z.comercios_estimados, z.clientes_potenciales, z.dificultad,
    (o.id IS NOT NULL),
    o.target_amount, o.target_units,
    h.importe, h.pedidos, h.unidades,
    h.clientes_activos, h.clientes_totales, h.visitas, h.nuevos_clientes,
    CASE WHEN o.id IS NOT NULL AND o.target_amount > 0
         THEN ROUND(h.importe / o.target_amount * 100, 1) END,
    (SELECT count(*) FROM com_comercial_zonas cz
      WHERE cz.zona_id = z.id AND cz.hasta IS NULL),
    (SELECT COALESCE(json_agg(json_build_object(
                'comercial_id', cz.comercial_id, 'nombre', u.full_name,
                'porcentaje', cz.porcentaje, 'es_principal', cz.es_principal)
              ORDER BY cz.es_principal DESC, u.full_name), '[]'::json)
       FROM com_comercial_zonas cz
       JOIN com_perfiles cp ON cp.id = cz.comercial_id
       JOIN users u ON u.id = cp.user_id
      WHERE cz.zona_id = z.id AND cz.hasta IS NULL)
  FROM com_zonas z
  CROSS JOIN per
  --
  -- AQUÍ ESTÁ EL ARREGLO. El objetivo se busca POR PERÍODO, y la venta se
  -- cuenta por el mismo. Antes los dos iban por «hoy».
  --
  LEFT JOIN com_objetivos_zona o
    ON o.zona_id = z.id AND o.is_active
   AND o.period_start <= per.hasta AND o.period_end >= per.desde
  CROSS JOIN LATERAL com_hechos_zona(
    z.id, per.desde, per.hasta) h
  WHERE z.latitude IS NOT NULL;
$$;


-- Y el ranking de zonas, que se apoyaba en la vista. Se recrea con la misma
-- firma de siempre más el período, para que tampoco mire «hoy».
CREATE OR REPLACE FUNCTION com_ranking_zonas(p_desde DATE DEFAULT NULL, p_hasta DATE DEFAULT NULL)
RETURNS TABLE (
  puesto BIGINT, zonas_en_lista BIGINT, cumplimiento_texto TEXT, crecimiento_pct NUMERIC,
  zona_id INT, code TEXT, name TEXT, kind TEXT,
  latitude NUMERIC, longitude NUMERIC,
  potencial_pendiente BOOLEAN,
  poblacion INT, comercios_estimados INT, clientes_potenciales INT, dificultad INT,
  tiene_objetivo BOOLEAN, target_amount NUMERIC, target_units NUMERIC,
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  clientes_activos BIGINT, clientes_totales BIGINT,
  visitas BIGINT, nuevos_clientes BIGINT,
  cumplimiento_pct NUMERIC,
  comerciales_asignados BIGINT, comerciales JSONB
)
LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT f.* FROM com_ficha_zona(p_desde, p_hasta) f
  )
  SELECT
    DENSE_RANK() OVER (
      ORDER BY b.tiene_objetivo DESC,
               COALESCE(b.cumplimiento_pct, -1) DESC,
               b.importe DESC
    ),
    COUNT(*) OVER (),
    CASE WHEN NOT b.tiene_objetivo OR b.cumplimiento_pct IS NULL THEN '—'
         WHEN b.cumplimiento_pct = trunc(b.cumplimiento_pct)
              THEN b.cumplimiento_pct::bigint || ' %'
         ELSE b.cumplimiento_pct::text || ' %'
    END,
    NULL::NUMERIC,
    b.zona_id, b.code, b.name, b.kind, b.latitude, b.longitude,
    b.potencial_pendiente, b.poblacion, b.comercios_estimados,
    b.clientes_potenciales, b.dificultad, b.tiene_objetivo,
    b.target_amount, b.target_units, b.importe, b.pedidos, b.unidades,
    b.clientes_activos, b.clientes_totales, b.visitas, b.nuevos_clientes,
    b.cumplimiento_pct, b.comerciales_asignados, b.comerciales
  FROM base b;
$$;

DROP VIEW IF EXISTS com_ranking_zonas;
DROP VIEW IF EXISTS com_ficha_zona;
