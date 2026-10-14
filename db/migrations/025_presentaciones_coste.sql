-- ═══════════════════════════════════════════════════════════════════════════
-- 025 · PRESENTACIONES, COSTE REAL Y MARGEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tres cosas que el circuito necesitaba y no tenía, y que son la diferencia
-- entre «un ERP que guarda números» y «un ERP que se puede comprobar».
--
-- El ORDEN de este fichero importa: `fn_coste_produccion_detalle` usa
-- `lots.cost_per_base_unit`, así que la columna tiene que existir ANTES. La
-- primera versión tenía las funciones antes del `ALTER TABLE` y PostgreSQL
-- aceptaba la función —el cuerpo no se mira al crearla— y reventaba la primera
-- vez que alguien la llamaba. Un fallo que solo aparece en el segundo uso.
--


-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · LA CAJA DE VENTA, Y QUE NO ES SIEMPRE DE DOCE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Un producto se vende por unidades o por cajas, y una caja no siempre lleva
-- doce. Producto A, cajas de 12. Producto B, de 6. Producto C, de 11.
--
-- ── LA REGLA QUE LO SOSTIENE ──────────────────────────────────────────────
--
-- `qty` EN LAS LÍNEAS ES SIEMPRE EN UNIDADES. SIEMPRE.
--
-- La caja no es una cantidad: es una FORMA de pedir 24 unidades. Si se guardara
-- «2 cajas» en el `qty` y se tradujera al descontar stock, el mismo número
-- significaría dos cosas según dónde se mirara, y cualquier recálculo de
-- meses después se encontraría con las dos. No hay ni un solo `qty` que
-- pueda ser cajas.
--
-- El error cuesta plata, y de forma rara. Un pedido de 2 cajas de 12 guardado
-- como `qty = 2` parece un pedido de 2 unidades y descuenta 2 del stock: se
-- venden 2 cajas y se entrega producto de más. O al revés, un pedido de 36
-- unidades guardado como 36 cajas, que no se puede entregar nunca. Ninguno de
-- los dos da error; los dos dan beneficio falso.
--
-- ── Y POR QUÉ EN UNA TABLA PROPIA, Y NO UNA COLUMNA EN `items` ────────────
--
-- Porque un producto puede venderse en más de una presentación, y porque
-- `pack_qty` es del PRODUCTO, no del artículo. Ponerlo en `items` obligaría a
-- los productos que no se venden en cajas a tener un `pack_qty` de mentira.
--
-- No hay palés. Un palé es otro problema —no cabe en un almacén, tiene su
-- propia logística y su propia unidad de compra— y meterlo aquí sería medio
-- hacerlo y deshacerlo después.

CREATE TABLE item_packs (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL CHECK (length(trim(name)) >= 2),
  -- Cuántas unidades de venta lleva una. UN NÚMERO, no un supuesto.
  pack_qty   NUMERIC(18,4) NOT NULL CHECK (pack_qty > 0),
  -- Si este producto SOLO se vende así. Un producto que es siempre de cajas no
  -- debería poder pedirse de a uno, porque la caja es la unidad de venta y una
  -- botella suelta no tiene precio.
  only_pack  BOOLEAN NOT NULL DEFAULT FALSE,
  sale_price NUMERIC(18,4) CHECK (sale_price IS NULL OR sale_price >= 0),
  currency_code TEXT REFERENCES currencies(code),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id),
  CONSTRAINT uniq_pack_por_nombre UNIQUE (item_id, name)
);

COMMENT ON TABLE item_packs IS
  'Presentaciones de venta: «caja de 12», «caja de 6»… La cantidad NO es fija '
  'y no está en items. Al pedir, la línea guarda SIEMPRE unidades y además '
  'cuál presentación se usó, para que el papel diga «2 cajas» sin que el número '
  'que descuenta stock deje de ser 24. Un producto puede tener varias.';

CREATE INDEX idx_packs_item ON item_packs(item_id) WHERE is_active;

-- Las líneas de pedido guardan la PRESENTACIÓN además de la cantidad.
ALTER TABLE sales_order_lines
  ADD COLUMN pack_id      INTEGER REFERENCES item_packs(id) ON DELETE RESTRICT,
  ADD COLUMN presentation TEXT NOT NULL DEFAULT 'UNIDAD'
                CHECK (presentation IN ('UNIDAD','CAJA'));

COMMENT ON COLUMN sales_order_lines.qty IS
  'SIEMPRE en unidades de venta del producto, NUNCA en cajas. «2 cajas de 12» '
  'son qty = 24 y pack_id = el de la caja. Esta columna es la que descuenta '
  'stock, y por eso no puede significar dos cosas según de dónde se mire.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · EL COSTE REAL, Y LA UNIDAD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── EL FALLO QUE ESTO ARREGLA ─────────────────────────────────────────────
--
-- `v_production_cost` hacía `SUM(pm.actual_qty * it.purchase_cost)`.
--
-- Cantidad por coste, sin mirar de qué unidad es cada uno. Y el sistema TIENE
-- unidades que no son lo mismo: el concentrado se compra en LITROS y se gasta
-- en MILILITROS.
--
-- 9.000 ml × 3,69 €/L son 9 L y 33,21 €. La cuenta de arriba da 9.000 × 3,69 =
-- 33.210 €. Mil veces más, sin dar ningún error: da un número, y el número es
-- un beneficio.
--
-- ── EL LOTE, QUE ES DONDE VIVE EL COSTE DE VERDAD ─────────────────────────
--
-- `lots.cost_per_base_unit` es lo que costó UNA UNIDAD BASE de ese lote, el día
-- que entró. Se rellena al entrar la mercancía y NO se vuelve a tocar.
--
-- Por qué en el lote y no en `items.purchase_cost`: porque el precio de compra
-- es el de HOY, y el lote es una foto de AQUEL DÍA.
--
-- El concentrado sube de 3,69 a 4,10 €/L. Las cajas se produjeron con lo que
-- había, y su beneficio es el de entonces. Con el precio de catálogo, el
-- beneficio de enero cambia en cuanto se toca el precio de mañana, y los
-- informes de meses pasados dejan de cuadrar con los cobros de meses pasados.
--
-- Un beneficio que cambia solo, cada vez que alguien actualiza un precio, no
-- mide el beneficio: mide la última actualización de precios.
--
-- Y el lote PRODUCIDO hereda el coste de lo que se consumió de verdad, no lo
-- que decía la receta: si faltó una etiqueta y se packaging con la mano, el
-- lote sale con lo que se puso de verdad.
--
ALTER TABLE lots
  ADD COLUMN cost_per_base_unit NUMERIC(18,8)
    CHECK (cost_per_base_unit IS NULL OR cost_per_base_unit >= 0),
  ADD COLUMN cost_source TEXT
    CHECK (cost_source IS NULL OR cost_source IN ('PURCHASE','PRODUCTION','MANUAL','OPENING'));

COMMENT ON COLUMN lots.cost_per_base_unit IS
  'Coste por unidad BASE del lote, el día que entró. Es una FOTO: no cambia '
  'aunque el precio del artículo cambie después. El beneficio de una venta se '
  'mide con el coste de SU lote, no con el precio de hoy.';

COMMENT ON COLUMN lots.cost_source IS
  'De dónde sale ese coste: lo que se pagó al comprar (PURCHASE), lo que costó '
  'fabricar (PRODUCTION), o si alguien lo puso a mano (MANUAL). Un lote sin '
  'origen conocido no es gratis: es desconocido, que es distinto.';


-- ── LA UNIDAD DE COMPRA ES UN DATO, NO UNA SUPOSICIÓN ──────────────────────
--
-- El coste de un artículo va con su `unit_id`, y por eso la cuenta necesita
-- los dos: cuánto se gastó, y en qué unidad. `units.base_factor` convierte
-- dentro de una dimensión (ml → L es 0,001; kg → t es 1000).
--
-- Y entre dimensiones NO SE PUEDE. Kilogramos a litros no es una conversión,
-- es una invención. Convertirlo en silencio, dividiendo por lo que toque, es
-- el tipo de número que sale bien un día y mal otro sin que nadie sepa por
-- qué. Aquí falla en voz alta y con el motivo escrito.
--
CREATE OR REPLACE FUNCTION fn_convertir(
  p_cantidad NUMERIC,
  p_de      INTEGER,
  p_a       INTEGER
) RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  d_de   units%ROWTYPE;
  d_a    units%ROWTYPE;
  factor NUMERIC(18,9);
BEGIN
  IF p_de = p_a THEN RETURN p_cantidad; END IF;

  SELECT * INTO d_de FROM units WHERE id = p_de;
  SELECT * INTO d_a  FROM units WHERE id = p_a;

  IF d_de.dimension <> d_a.dimension THEN
    RAISE EXCEPTION
      'No se puede convertir % (%s) en % (%s): son magnitudes distintas. Un kilo no es un litro, y este sistema no inventa la equivalencia que separa al producto de lo que lo contiene.',
      COALESCE(d_de.name, p_de), COALESCE(d_de.symbol, '?'),
      COALESCE(d_a.name, p_a), COALESCE(d_a.symbol, '?')
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- EL FACTOR, QUE ESTÁ DEL REVÉS Y ES EL NÚMERO MÁS IMPORTANTE DEL BLOQUE.
  --
  -- `base_factor` dice cuántos unidades BASE hay en UNA unidad: 1 L son 1
  -- unidad base, y 1 ml son 0,001.
  --
  --   De A a B:  (cantidad × factor_de_A) ÷ factor_de_B
  --
  --   9.000 ml → L :  9.000 × 0,001 ÷ 1        =  9 L        ✓
  --   40 L → ml     :  40 × 1 ÷ 0,001            =  40.000 ml  ✓
  --
  -- La primera versión puso `(1 / factor_de) * factor_a`, que es el factor
  -- DEL REVÉS, y daba 0,04 ml para 40 L: mil veces menos. Un concentrate en el
  -- almacén de 20 L se decía que eran 0,02 ml, la receta pedía 9.000, y la
  -- fábrica se paraba con el almacén lleno.
  --
  -- Y lo más malo: no daba ningún error. Daba 0,02, que es un número, y el
  -- número no se discute.
  --
  factor := d_de.base_factor / d_a.base_factor;
  RETURN p_cantidad * factor;
END;
$$;

COMMENT ON FUNCTION fn_convertir(numeric, integer, integer) IS
  'Convierte una cantidad de una unidad a otra DENTRO de la misma dimensión. '
  'Entre dimensiones falla en voz alta: no existe conversión entre un kilo y un '
  'litro, y devolver algo en ese caso sería inventar un precio.';


-- ── EL COSTE DE UNA PRODUCCIÓN, MATERIAL A MATERIAL ───────────────────────
--
-- No un total: un DESGLOSE. Una fila por material, con lo que se gastó, en
-- qué unidad, cuánto costaba ese lote, y el coste en euros.
--
-- Porque «el producto cuesta 0,83 €» no sirve para decidir nada. Lo que sirve
-- es ver que de esos 83 céntimos, 41 son concentrado, 27 la botella, 10 las
-- etiquetas y 5 la caja — y que si el concentrado sube, el margen baja por ahí
-- y no por un misterio.
--
--
-- LA UNIDAD BASE DE UNA DIMENSIÓN.
--
-- No hay columna `is_base` en `units`: la base es la unidad cuyo
-- `base_factor` es 1. Para el volumen es el litro; para la masa, el kilo.
--
CREATE OR REPLACE FUNCTION fn_unidad_base(p_unit_id INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  -- La dimensión es una columna de TEXTO ('VOLUME' | 'MASS' | 'COUNT'), no un
  -- id. `VOLUME` a secas sería el error clásico: convierte litros en kilos sin
  -- quejarse, porque para Postgres son dos palabras más.
  SELECT u.id
    FROM units u
   WHERE u.base_factor = 1
     AND u.dimension = (SELECT d.dimension FROM units d WHERE d.id = p_unit_id)
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_coste_produccion_detalle(p_produccion BIGINT)
RETURNS TABLE (
  item_id        INTEGER,
  sku            TEXT,
  nombre         TEXT,
  lote           TEXT,
  cantidad       NUMERIC(18,4),
  unidad_gasto   TEXT,
  unidad_coste   TEXT,
  coste_unitario NUMERIC(18,8),
  coste          NUMERIC(18,4),
  coste_conocido BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    pm.item_id,
    i.sku,
    i.name,
    lo.code,
    pm.actual_qty,
    ud.code,
    uc.code,
    lo.cost_per_base_unit,
    -- El coste se guarda POR UNIDAD BASE de la dimensión, así que la cantidad
    -- también se lleva a la unidad base antes de multiplicar.
    --
    -- Multiplicar 9.000 ml por 0,00369 €/ml está bien. Multiplicar 9 L (la
    -- unidad del artículo) por 0,00369 €/ml no lo está: son 0,0332 €, mil
    -- veces menos de lo que vale el concentrado, y sale un número, que es
    -- justo lo que hace que el fallo pase desapercibido.
    --
    -- La receta pide en ml, el artículo se guarda en L y el coste está en ml.
    -- Cada uno habla su idioma y hay que traducir antes de sumar.
    CASE WHEN lo.cost_per_base_unit IS NULL THEN NULL
         ELSE fn_convertir(pm.actual_qty, pm.unit_id, COALESCE(fn_unidad_base(i.unit_id), i.unit_id)) * lo.cost_per_base_unit
    END,
    lo.cost_per_base_unit IS NOT NULL
  FROM production_materials pm
  JOIN lots lo  ON lo.id = pm.lot_id
  JOIN items i  ON i.id = pm.item_id
  JOIN units ud ON ud.id = pm.unit_id
  JOIN units uc ON uc.id = i.unit_id
  WHERE pm.production_id = p_produccion
  ORDER BY i.sku
$$;

COMMENT ON FUNCTION fn_coste_produccion_detalle(bigint) IS
  'Coste de una producción, material a material, con la conversión de unidad a '
  'la vista. Lo que cuesta un producto solo sirve si se sabe de dónde sale.';


-- ── EL TOTAL DE ESA PRODUCCIÓN ─────────────────────────────────────────────
--
-- La suma del desglose, y SI EL DESGLOSE ESTÁ COMPLETO. Un coste calculado
-- sobre materiales de los que no se sabe lo que costaron no es un coste: es
-- una parte, y hay que poder decir que lo es.
--
CREATE OR REPLACE FUNCTION fn_costo_produccion(p_produccion BIGINT)
RETURNS TABLE (
  coste_total    NUMERIC(18,4),
  coste_unitario NUMERIC(18,8),
  unidades       NUMERIC(18,4),
  completa       BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(d.coste), 0),
    CASE WHEN p.actual_qty > 0
         THEN COALESCE(SUM(d.coste), 0) / p.actual_qty
         ELSE 0 END,
    COALESCE(p.actual_qty, 0) AS cantidad,
    bool_and(COALESCE(d.coste_conocido, false))
  FROM productions p
  LEFT JOIN fn_coste_produccion_detalle(p.id) d ON true
  WHERE p.id = p_produccion
  GROUP BY p.actual_qty
$$;

COMMENT ON FUNCTION fn_costo_produccion(bigint) IS
  'Coste REAL de fabricar: lo que se consumió, a lo que costó su lote, con la '
  'unidad convertida. Y si el coste está COMPLETO, porque un coste sobre '
  'materiales de precio desconocido no es un coste: es una parte.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3 · COSTE, PRECIO Y MARGEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El margen se calcula en UN sitio. No en la web, no en la ficha del producto,
-- no en el informe de ventas: en la base, con una función que todo el mundo
-- llama.
--
-- ── EL COSTE, DE DÓNDE SE SACA ────────────────────────────────────────────
--
-- El del ÚLTIMO LOTE que se produjo de este producto. Es el coste que se está
-- pagando ahora mismo por hacer una unidad más, y es el único que sirve para
-- decidir si vale la pena vender.
--
-- No es el de `items.purchase_cost`, que para un producto terminado es un 0
-- que nadie ha rellenado. No es el de la receta, que es una estimación de lo
-- que costaría si todo saliera bien. Es el del lote: lo que se consumió.
--
-- ── POR QUÉ «MARGEN» Y NO «BENEFICIO» ─────────────────────────────────────
--
-- El margen es la diferencia entre precio y coste. El beneficio, además, tiene
-- que pagar los gastos de la empresa, que aquí no están. Un 35 % de margen no
-- es un 35 % de beneficio, y decirlo sería empezar a mentir en la línea de al
-- lado de la que acaba de salir bien.
--
CREATE OR REPLACE FUNCTION fn_coste_unitario_actual(p_item INTEGER)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      -- Lo último que se fabricó de este producto, y lo que costó.
      SELECT lo.cost_per_base_unit
        FROM lots lo
       WHERE lo.item_id = p_item
         AND lo.cost_source = 'PRODUCTION'
         AND lo.cost_per_base_unit IS NOT NULL
       ORDER BY lo.received_at DESC, lo.id DESC
       LIMIT 1
    ),
    (
      -- Si no se ha fabricado nunca, lo que costó la última compra.
      SELECT lo.cost_per_base_unit
        FROM lots lo
       WHERE lo.item_id = p_item
         AND lo.cost_source = 'PURCHASE'
         AND lo.cost_per_base_unit IS NOT NULL
       ORDER BY lo.received_at DESC, lo.id DESC
       LIMIT 1
    ),
    0)
$$;

COMMENT ON FUNCTION fn_coste_unitario_actual(integer) IS
  'Coste por unidad del último lote: fabricado si se ha fabricado, comprado si '
  'no. Si devuelve 0 es que nadie ha dado coste a ese producto, y hay que '
  'decirlo en voz alta en vez de enseñar un margen del 100 %.';


-- ── PRECIO, COSTE Y MARGEN, PARA UNIDAD Y PARA CAJA ───────────────────────
--
-- `pack_qty` = NULL es la unidad suelta. Con una caja, el precio es el de la
-- caja si la tiene propio, y si no, el de la unidad por las unidades que
-- lleva. El coste se multiplica por las MISMAS unidades, o el margen de la
-- caja sería el de una botella con un precio de doce.
--
CREATE OR REPLACE FUNCTION fn_margen(
  p_item     INTEGER,
  p_pack_qty NUMERIC DEFAULT NULL
) RETURNS TABLE (
  unidades_por_presentacion NUMERIC(18,4),
  coste_unitario            NUMERIC(18,8),
  coste_presentacion        NUMERIC(18,4),
  precio_unitario           NUMERIC(18,4),
  precio_presentacion       NUMERIC(18,4),
  beneficio_unitario        NUMERIC(18,4),
  beneficio_presentacion    NUMERIC(18,4),
  margen_pct                NUMERIC(9,4),
  coste_conocido            BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      i.id,
      COALESCE(p.pack_qty, 1) AS uds,
      fn_coste_unitario_actual(i.id) AS coste,
      i.sale_price AS precio_ud,
      COALESCE(p.sale_price, i.sale_price * COALESCE(p.pack_qty, 1)) AS precio_p,
      CASE WHEN fn_coste_unitario_actual(i.id) > 0 THEN true ELSE false END AS coste_conocido
    FROM items i
    LEFT JOIN item_packs p ON p.item_id = i.id AND p.is_active
   WHERE i.id = p_item
  )
  SELECT
    b.uds,
    b.coste,
    b.coste * b.uds,
    b.precio_ud,
    b.precio_p,
    b.precio_ud - b.coste,
    b.precio_p - (b.coste * b.uds),
    CASE WHEN b.precio_ud > 0
         THEN (b.precio_ud - b.coste) / b.precio_ud * 100
         ELSE NULL END,
    b.coste_conocido
  FROM base b
$$;

COMMENT ON FUNCTION fn_margen(integer, numeric) IS
  'Coste, precio y margen de un producto, por unidad o por caja. El margen se '
  'mide contra el coste del ÚLTIMO LOTE, no contra el precio de catálogo: si '
  'alguien cambia el precio de un material, el margen de las ventas de ayer no '
  'se mueve solo.';


-- ── Y LA VISTA, QUE ES LO QUE LEEN LAS PANTALLAS ───────────────────────────
--
-- Una vista y nada más. La web, el informe y el móvil leen la misma, así que
-- no pueden discrepar: si mañana se añade un income, el margen sale igual de
-- allí que de aquí.
--
CREATE OR REPLACE VIEW v_item_margen AS
SELECT
  i.id AS item_id,
  i.sku,
  i.name,
  i.currency_code,
  i.sale_price                                        AS precio_unitario,
  fn_coste_unitario_actual(i.id)                      AS coste_unitario,
  (i.sale_price - fn_coste_unitario_actual(i.id))      AS beneficio_unitario,
  CASE WHEN i.sale_price > 0
       THEN (i.sale_price - fn_coste_unitario_actual(i.id)) / i.sale_price * 100
       ELSE NULL END                                    AS margen_pct,
  (fn_coste_unitario_actual(i.id) > 0)                 AS coste_conocido,
  (SELECT count(*) FROM item_packs p
    WHERE p.item_id = i.id AND p.is_active)            AS presentaciones,
  (SELECT p.pack_qty FROM item_packs p
    WHERE p.item_id = i.id AND p.is_active
    ORDER BY p.sort_order, p.id LIMIT 1)               AS caja_unidades
FROM items i
WHERE i.is_active AND i.archived_at IS NULL
  AND i.category_kind = 'FINISHED_GOOD';
