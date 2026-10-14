-- 070 · FORMATOS DE VENTA (cajas)
--
-- Qué resuelve esto, y por qué NO toca el almacén.
--
-- El problema: en la tienda se vende «Caja de 12» a 1.200 FCFA, pero en el
-- almacén lo que existe son 12 botellas sueltas. Si el pedido contara cajas,
-- el inventario soltaría 2 unidades y dejaría 10 botellas fantasma en el
-- almacén. Si el pedido contara botellas, el comercial tendría que calcular
-- «2 cajas = 24 botellas» a mano cada vez, y el albarán mostraría 24 en vez
-- de 2 cajas.
--
-- La solución: LA CANTIDAD EN PEDIDOS SIGUE SIENDO EN UNIDADES BASE.
-- Una caja es solo una FORMA de venderla. `sales_order_lines.qty` sigue siendo
-- botellas —24, no 2— porque todo lo que ya funciona (reservas, entregas,
-- consumo de lotes, trazabilidad) lee esa columna y cuenta en unidades base.
-- Lo nuevo es cómo se CALCULA esa cantidad y cómo se MUESTRA.
--
-- Por eso esta migración NO toca `lots`, ni `order_reservations`, ni
-- `deliveries`. Si el stock sigue en botellas, esas tres tablas no tienen
-- ni una línea que cambiar. Es la diferencia entre adapting el sistema y
-- duplicarlo.
--
-- `formats_qty` es el número de cajas que pidió el cliente (2), y `qty` las
-- botellas que eso significa (24). Los dos datos conviven: uno es el hecho
-- físico, el otro elmercial.

-- ─────────────────────────────────────────────────────────────────────────────
-- Los formatos se configuran en Ajustes, no se inventan al vuelo en el pedido.
-- Una caja es un dato del producto: si dependiera de quien la teclea, dos
-- personas venderían la misma caja a precios distintos.
CREATE TABLE sale_formats (
  id              SERIAL PRIMARY KEY,

  -- El formato pertenece a UN producto. Una caja de 12 de Lavavajillas no es
  -- una caja de 12 de Jabón: el precio y hasta el IVA pueden diferir.
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,

  -- «Caja de 12», «Pack de 6»… Lo escribe el usuario y es lo que sale
  -- impreso en el albarán, así que se guarda tal cual.
  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0),

  -- Cuántas unidades base contiene UNA caja. Cualquier número entero
  -- positivo: 2, 6, 12, 13, 30. No hay lista cerrada en ninguna parte.
  units_per_format NUMERIC(18,4) NOT NULL CHECK (units_per_format > 0),

  -- Precio de UNA caja, en la moneda del pedido. Null significa «usar el
  -- precio que tenga la ficha del producto», que es lo que se hacía antes.
  price           NUMERIC(18,4) CHECK (price IS NULL OR price >= 0),

  -- El IVA del formato. Null = hereda el de la ficha del producto. Permite
  -- que una caja tenga un tipo impositivo distinto al de la botella suelta
  -- sin tocar el producto entero.
  tax_rate        NUMERIC(9,6) CHECK (tax_rate IS NULL OR tax_rate >= 0),

  -- Desactivar, no borrar. Un formato que estuvo en un pedido debe seguir
  -- existiendo para siempre: si se borrara, el albarán de hace seis meses
  -- perdería el nombre que imprimió. Los pedidos llevan su propia copia
  -- (ver abajo), pero el formato tiene que continuar siendo real.
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ,

  -- Dos formatos con el mismo nombre para el mismo producto no tienen
  -- sentido: el comercial no podría distinguirlos al elegir.
  CONSTRAINT sale_formats_nombre_unico UNIQUE (item_id, name)
);

CREATE INDEX idx_sale_formats_item ON sale_formats(item_id) WHERE is_active;

COMMENT ON TABLE sale_formats IS
  'Formatos de venta (cajas) por producto. Ajustes → Formatos de venta. '
  'El formato NO existe en el almacén: el stock sigue en unidades base.';

COMMENT ON COLUMN sale_formats.units_per_format IS
  'Botellas por caja. 2, 6, 12, 13, 30… cualquier entero positivo.';

-- Desactivar es lo normal, no borrar. La baja física se controla aquí para
-- que nadie confunda «la caja ya no se vende» con «la caja nunca existió».
CREATE OR REPLACE FUNCTION fn_sale_format_no_se_borra()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'El formato «%» se desactiva, no se borra: está en pedidos ya emitidos. '
    'Fíjate en is_active.', OLD.name
    USING HINT = 'DESACTIVAR_FORMATO';
END;
$$;

CREATE TRIGGER trg_sale_format_no_borra
  BEFORE DELETE ON sale_formats
  FOR EACH ROW EXECUTE FUNCTION fn_sale_format_no_se_borra();

-- ─────────────────────────────────────────────────────────────────────────────
-- La línea del pedido guarda la FOTO del formato en el momento de pedirlo.
--
-- Esto es lo que cumple «los pedidos históricos conservan sus precios aunque
-- se modifiquen los formatos en Ajustes». Si la línea guardara solo
-- `sale_format_id`, cambiar el precio de «Caja de 12» de 1.200 a 1.350 FCFA
-- reescribiría, sin querer, todos los pedidos viejos al reimprimir su
-- albarán. Con nombre, unidades y precio copiados, el albarán de 2024
-- seguirá diciendo 1.200 aunque la caja hoy cueste 1.350. Es el mismo motivo
-- por el que se guarda `unit_price` en la línea y no se lee del producto.
ALTER TABLE sales_order_lines
  ADD COLUMN sale_format_id INTEGER REFERENCES sale_formats(id) ON DELETE SET NULL,
  ADD COLUMN formats_qty      NUMERIC(18,4) CHECK (formats_qty IS NULL OR formats_qty > 0),
  ADD COLUMN format_name      TEXT,
  ADD COLUMN format_units     NUMERIC(18,4) CHECK (format_units IS NULL OR format_units > 0),
  ADD COLUMN format_price     NUMERIC(18,4) CHECK (format_price IS NULL OR format_price >= 0);

COMMENT ON COLUMN sales_order_lines.formats_qty IS
  'Cajas pedidas (comercial). qty sigue siendo las botellas: 2 cajas de 12 = qty 24.';

COMMENT ON COLUMN sales_order_lines.format_name IS
  'Copia del nombre en el momento del pedido. Los albaranes antiguos no cambian.';

COMMENT ON COLUMN sales_order_lines.format_price IS
  'Precio de UNA caja cuando se pidió. Si se cambia el formato en Ajustes, '
  'los pedidos ya emitidos conservan el suyo.';

-- Una línea con formato tiene las tres cosas; una línea normal, ninguna.
-- Medio formato no es un formato, es un pedido mal formado.
ALTER TABLE sales_order_lines
  ADD CONSTRAINT sales_order_lines_formato_completo CHECK (
    (sale_format_id IS NULL AND formats_qty IS NULL AND format_name IS NULL
     AND format_units IS NULL AND format_price IS NULL)
    OR
    (sale_format_id IS NOT NULL AND formats_qty IS NOT NULL AND formats_qty > 0
     AND format_name IS NOT NULL AND length(btrim(format_name)) > 0
     AND format_units IS NOT NULL AND format_units > 0
     AND format_price IS NOT NULL AND format_price >= 0)
  );

-- Que el IVA nunca se invente: con formato, el impuesto sale del formato o de
-- la ficha del producto, nunca de lo que envíe el cliente.
ALTER TABLE sales_order_lines
  ADD CONSTRAINT sales_order_lines_iva_no_inventado CHECK (
    tax_rate IS NULL OR tax_rate >= 0
  );
