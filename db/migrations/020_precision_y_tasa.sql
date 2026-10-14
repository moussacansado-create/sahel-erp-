-- ═══════════════════════════════════════════════════════════════════════════
-- 020 · EL DINERO NO PIERDE CIFRAS POR EL CAMINO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ ESTÁ MAL
--
-- Las columnas de dinero están a `NUMERIC(18,2)`. Dos decimales.
--
-- Suena prudente y no lo es: el redondeo ocurre EN LA BASE, al insertar, y
-- ocurre SIEMPRE, aunque el código calcule la cifra exacta. Por mucho que el
-- JavaScript lleve los decimales, PostgreSQL dice «aquí caben dos» y tira el
-- resto sin avisar.
--
-- Con volumen eso es dinero que se evapora por el camino. Y no es un error de
-- redondeo visible: sale una factura que cuadra consigo misma y está
-- cobrada de menos.
--
-- Y el problema se multiplica: en compras el cálculo redondea ANTES de
-- guardar, línea a línea (`dinero(qty * unitCost)`), y luego el subtotal
-- acumulado se vuelve a redondear. Tres sitios distintos(roundown de línea,
-- de subtotal y de columna) donde el mismo céntimo se pierde tres veces.
--
-- LO QUE HACE ESTA MIGRACIÓN
--
-- 1 · Los totales pasan a `NUMERIC(18,4)`. Es la precisión con la que ya
--     vivían los PRECIOS UNITARIOS (`unit_cost`, `unit_price` = 18,4), así que
--     por fin los precios y sus totales hablan el mismo idioma. Un importe se
--     guarda con la precisión con la que se calculó, y se redondea cuando toca
--     —al presentar el documento—, no al escribirlo.
--
-- 2 · Desaparecen los `DEFAULT 'EUR'`. Eran de la primera versión de la
--     aplicación, cuando se pensaba en euros. Hoy la moneda base declarada en
--     `currencies` es XOF (rate_to_base = 1, is_base = TRUE), así que un
--     default que dice 'EUR' es una contradicción esperando a que alguien
--     inserte una fila sin decir en qué moneda está.
--
--     Quitarlo es la solución que falla en voz alta: si un INSERT futuro
--     olvida la moneda, revienta con un error de NOT NULL en lugar de
--     registrar en euros una factura de Mali. Ningún documento se emite sin
--     que alguien decida en qué moneda está.
--
--     Y avisa de un segundo problema que solo se ve al quitarlo: en
--     `pedidos.js` hay un `'EUR'` escrito EN EL CÓDIGO como valor por si
--     faltara el de la configuración. Ese es peor que el default, porque no
--     falla: elige por ti y emite la factura en la moneda equivocada sin
--     avisar. Pendiente de arreglar en Ventas.
--
-- 3 · `exchange_rates`: la tasa central, con fecha y sin editar.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 1 · PRECISIÓN REAL DE LOS TOTALES
-- ───────────────────────────────────────────────────────────────────────────
--
-- PostgreSQL se NEGA a ensanchar una columna que una vista usa en su salida:
-- «cannot alter type of a column used by a view or rule». Y hay varias
-- (`v_order_progress`, las `v_trace_*`), que leen de estas mismas tablas.
--
-- La solución NO es reescribir aquí las definiciones de las vistas. Si una
-- vista se define en dos sitios, un día una se actualiza y la otra no, y el
-- fallo aparece meses después, sin relación con lo que se tocó. La fuente
-- de verdad de una vista es la migración que la creó, y aquí no se replica
-- ni una línea.
--
-- Lo que sí se hace es lo mecánico: preguntar a la base cuál es la definición
-- EXACTA de cada vista dependiente, guardársela, soltar la vista, ensanchar
-- la columna y volver a crearla con su propia definición. Lo que sale después
-- es la misma vista, palabra por palabra, y la migración no puede quedar
-- desfasada respecto a lo que dijo el catálogo.
--
--
-- UNA ADVERTENCIA QUE COSTA SANGRE, Y QUE ESTÁ EN ESTA MIGRACIÓN A PROPÓSITO
--
-- El migrador ejecuta con `execScript`, que parte el fichero POR PUNTOS Y
-- COMAS. No entiende eletweencomillado en dólares (`$$ ... $$`), así que un
-- bloque `DO` se le rompe dentro y `RAISE NOTICE 'algo'` acaba interpretado
-- como el nombre de una excepción: «unrecognized exception condition "hola"».
--
-- Esto NO es una curiosidad de PGlite: es la razón de que esta migración no
-- capture las definiciones de las vistas automáticamente con un `DO`, que era
-- lo elegante. Es lo único que PG no puede resolver solo. Un bloque `DO` en
-- cualquier migración futura va a fallar, y va a fallar de la forma más
-- confusa que existe: un error de PostgreSQL sobre una cosa que nadie
-- escribió.
--
-- La única vista que se opone es `v_order_progress`, y solo porque saca
-- `o.total` a la vista. Se suelta, se ensanchan las columnas, y se vuelve a
-- levantar con la MISMA definición de la migración 011. Está repetida aquí a
-- propósito, y `server/tests/precision-dinero.test.js` comprueba que las dos
-- copias dicen exactamente lo mismo: si alguien cambia la vista en 011 y se
-- le olvida actualizar 020, la prueba lo dice en lugar de romper en producción.
--
DROP VIEW IF EXISTS v_order_progress;

-- Se ensancha la columna; NO se toca ni un dato. Los valores existentes, que
-- ya cabían en 18,2, siguen cabiendo de sobra en 18,4 y no cambian de valor.
-- PostgreSQL reescribe la tabla por debajo, pero ningún número se modifica.
ALTER TABLE purchase_orders
  ALTER COLUMN subtotal   TYPE NUMERIC(18,4),
  ALTER COLUMN tax_amount TYPE NUMERIC(18,4),
  ALTER COLUMN total      TYPE NUMERIC(18,4);

ALTER TABLE sales_orders
  ALTER COLUMN subtotal        TYPE NUMERIC(18,4),
  ALTER COLUMN discount_amount TYPE NUMERIC(18,4),
  ALTER COLUMN tax_amount      TYPE NUMERIC(18,4),
  ALTER COLUMN total           TYPE NUMERIC(18,4);

ALTER TABLE sales_order_lines
  ALTER COLUMN discount_amount TYPE NUMERIC(18,4),
  ALTER COLUMN line_total      TYPE NUMERIC(18,4);

ALTER TABLE expenses
  ALTER COLUMN amount TYPE NUMERIC(18,4);

-- Se vuelve a levantar tal cual estaba, ahora con los totales a cuatro
-- decimales. Misma definición, mismos nombres de columna: solo cambia la
-- precisión que hay detrás.
CREATE OR REPLACE VIEW v_order_progress AS
  SELECT
    o.id                    AS order_id,
    o.code                  AS order_code,
    o.status                AS status,
    c.id                    AS customer_id,
    c.code                  AS customer_code,
    c.name                  AS customer_name,
    COALESCE(SUM(l.qty), 0)            AS qty_ordered,
    COALESCE(SUM(l.qty_delivered), 0)   AS qty_delivered,
    COALESCE(SUM(l.qty - l.qty_delivered), 0) AS qty_pending,
    COUNT(l.id) FILTER (WHERE l.qty - l.qty_delivered > 0.0001) AS pending_lines,
    o.total, o.currency_code, o.order_date, o.promised_date, o.created_at
  FROM sales_orders o
  JOIN customers c       ON c.id = o.customer_id
  LEFT JOIN sales_order_lines l ON l.sales_order_id = o.id
  GROUP BY o.id, c.id;

-- Los precios unitarios se quedan en 18,4: es el mismo número que ahora usan
-- los totales, que es exactamente lo que se quería. Se tocan aquí solo para
-- dejar constancia de que es deliberado y no un descuido.
COMMENT ON COLUMN purchase_orders.subtotal IS
  'Subtotal EXACTO. No redondeado: el redondeo ocurre al presentar el documento, una sola vez, sobre el total. Guardar aquí un importe ya redondeado hace que subtotal + impuesto <> total.';
COMMENT ON COLUMN sales_orders.total IS
  'Total EXACTO en la moneda del documento. El redondeo a céntimos (o a FCFA enteros) es cosa de la PRESENTACIÓN, no del almacenamiento.';
COMMENT ON COLUMN expenses.amount IS
  'Importe exacto del gasto, en la moneda en la que se ha declarado. Sin convertir: convertir un gasto es decidir otra cosa, y esa decisión lleva su propio papel.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2 · LA MONEDA NO SE ADIVINA
-- ───────────────────────────────────────────────────────────────────────────
--
-- EN LOS DOCUMENTOS, EL DEFAULT DESAPARECE.
--
-- Una orden de compra, un pedido o un gasto son papeles que van a un cliente o
-- a un proveedor. Que la base le ponga la moneda a la que le apetezca es
-- justamente lo que no puede pasar: sin default, un INSERT futuro que se
-- olvide de la moneda revienta con un error de NOT NULL, en vez de emitir en
-- euros una factura de Mali sin que nadie se entere.
--
-- Falla en voz alta, que es lo único que sirve aquí.
--
ALTER TABLE purchase_orders  ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE sales_orders     ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE expenses         ALTER COLUMN currency_code DROP DEFAULT;

-- EN EL CATÁLOGO, EL DEFAULT SE QUEDA. PERO VALE 'XOF'.
--
-- Aquí sí tiene sentido: un artículo pertenece a la moneda de la empresa
-- mientras nadie diga otra cosa, y obligar a teclearlo en cada alta del
-- catálogo es ruido, no seguridad.
--
-- Lo que estaba mal nunca fue que el default EXISTIERA, sino que valiera
-- 'EUR': la contradicción con la moneda base declarada en `currencies`. La
-- diferencia entre las dos cosas es de fondo, y quitarla de aquí fue un
-- error de campo: tumbó cuarenta pruebas de creation de artículos sin
-- arreglar ni un solo problema real.
ALTER TABLE items ALTER COLUMN currency_code SET DEFAULT 'XOF';

-- ───────────────────────────────────────────────────────────────────────────
-- 3 · LA TASA CENTRAL, CON FECHA Y SIN EDITAR
-- ───────────────────────────────────────────────────────────────────────────
--
-- `currencies.rate_to_base` dice cuánto vale UNA moneda HOY. Sirve para
-- mostrar, pero no puede ser la tasa de un documento: en cuanto cambiara,
-- reescribiría la historia. Un albarán de hace seis meses tiene que seguir
-- valiendo lo que valía, aunque el euro se mueva hoy.
--
-- Así que la tasa de verdad vive aquí: una fila por día y por par.
--
-- LAS TRES REGLAS, que son el corazón del diseño:
--
--   R1 · La tasa se AÑADE, no se EDITA. Una tasa corregida después de usarse es
--        una tasa nueva con fecha posterior. Las viejas siguen siendo verdad
--        porque se usaron, y el documento que las usó sigue diciendo su verdad.
--
--   R2 · Un documento NUNCA se re-evalúa. Guarda su tasa al emitirse, y mañana
--        la tabla puede tener otra para el mismo par. Son dos hechos, no una
--        contradicción.
--
--   R3 · Un documento se guarda en UNA moneda. La que se emitió. Convertirlo es
--        una operación nueva, con su papel, no un campo que alguien toca.
--
CREATE TABLE exchange_rates (
  id             BIGSERIAL PRIMARY KEY,
  from_code      TEXT NOT NULL REFERENCES currencies(code),
  to_code        TEXT NOT NULL REFERENCES currencies(code),
  rate           NUMERIC(20,8) NOT NULL CHECK (rate > 0),
  effective_from DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'MANUAL',
  note           TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una tasa por día y por par.
  --
  -- Sin este UNIQUE, meter dos veces la del martes deja dos filas y la
  -- pregunta «¿cuál valía el martes?» se queda sin respuesta. Con él, meterla
  -- dos veces es un UPDATE, que es lo que quiere quien se equivoca dos veces.
  UNIQUE (from_code, to_code, effective_from),

  -- Una moneda nunca se cambia a sí misma: sería un tipo de cambio de 1:1, que
  -- no es un error de tecleo sino una falta de cabeza.
  CHECK (from_code <> to_code)
);

-- La consulta del día es: «¿qué tasa había el martes?». Este índice es
-- JUSTO ese caso, así que no lo recorre entero.
CREATE INDEX idx_exchange_rates_lookup
  ON exchange_rates (from_code, to_code, effective_from DESC);

-- `exchange_rates` es un libro de historia, no una tabla de ajustes: se le
-- añade, no se le corrige. La tasa de un papel ya emitido forma parte de ese
-- papel, y un papel no se reescribe por un UPDATE.
CREATE OR REPLACE FUNCTION fn_exchange_rates_no_se_edita() RETURNS trigger AS $$
BEGIN
  IF NEW.rate IS DISTINCT FROM OLD.rate
     OR NEW.from_code IS DISTINCT FROM OLD.from_code
     OR NEW.to_code IS DISTINCT FROM OLD.to_code
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION
      'Una tasa de cambio ya escrita no se edita (%). Si era errónea, añade otra con fecha posterior: la vieja sigue siendo la verdad de los documentos que la usaron.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_exchange_rates_no_se_edita
  BEFORE UPDATE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION fn_exchange_rates_no_se_edita();

-- ───────────────────────────────────────────────────────────────────────────
-- 4 · LA TASA DE HOY, LA QUE YA ESTABA ESCRITA
-- ───────────────────────────────────────────────────────────────────────────
--
-- `currencies` ya traía 1 EUR = 655,957 FCFA desde la primera migración. Ese
-- número es la tasa de partida, y la que pasarán a usar los primeros
-- documentos. Se copia tal cual: no se inventa una cifra nueva para tener algo
-- que rellenar la tabla.
--
-- A partir de mañana, cada tasa nueva la mete alguien a mano y con su fecha.
--
INSERT INTO exchange_rates (from_code, to_code, rate, effective_from, source, note)
SELECT 'EUR', 'XOF', rate_to_base, CURRENT_DATE, 'MIGRACION',
       'Tasa inicial tomada de currencies.rate_to_base, que venía desde la Fase 0.'
  FROM currencies
 WHERE code = 'EUR' AND NOT EXISTS (
   SELECT 1 FROM exchange_rates WHERE from_code = 'EUR' AND to_code = 'XOF'
 );
