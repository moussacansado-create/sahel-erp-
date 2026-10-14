-- ══════════════════════════════════════════════════════════════════════════════
-- 055 · ETIQUETAS ADHESIVAS PARA CADA ENTRADA DE ALMACÉN
--
-- Una entrada de almacén es un LOTE (`lots`). Es lo que ya existe, ya tiene
-- cantidad, ya se consume en producción y ya se traza. No se ha creado un
-- módulo de entradas nuevo: la etiqueta es una VISTA de un lote que ya está.
--
-- ── LAS TRES COSAS QUE NO SE CONFUNDEN ───────────────────────────────────────
--
-- La pegatina lleva TRES identificadores distintos y mezclarlos es el error que
-- más caro sale, porque un lote equivocado en producción no se detecta hasta
-- que el producto está mal:
--
--   1. `entrada_no`         NÚMERO DE ENTRADA. Correlativo GLOBAL, único y sin
--                           reutilizar. Es lo que escanea el QR. Cuando se
--                           imprime un albarán con nueve líneas, son nueve
--                           entradas distintas con nueve números, aunque el
--                           albarán sea el mismo.
--
--   2. `lots.code`          LOTE INTERNO DE RECEPCIÓN. Lo asigna Sahel al
--                          收到的 material y es el que se consume en producción
--                           (`stock_movements.lot_id`). Ya existía; no se toca.
--
--   3. `supplier_lot_code`  LOTE DEL FABRICANTE. Lo pone el proveedor. Va en la
--                           etiqueta cuando existe, y a menudo NO existe.
--
-- La etiqueta NUNCA rellena un hueco: si no hay lote de fabricante, no escribe
-- nada. Un «—» o un número inventado sería peor que un campo vacío, porque
-- parece un dato.
--
-- ── EL TOKEN ─────────────────────────────────────────────────────────────────
--
-- `etiqueta_token` es un valor aleatorio, sin datos personales ni de negocio.
-- El QR lleva el token y NADA MÁS: ni el nombre del proveedor, ni el precio,
-- ni el nombre comercial del material. Quien tenga el token ve la ficha, y la
-- ficha depende de los permisos de quien mira. Se puede rotar (`rotar_token`)
-- sin tocar el lote: el material sigue siendo el mismo, cambia la pegatina.
-- ══════════════════════════════════════════════════════════════════════════════

-- Correlativo global de entradas. Una secuencia, para todos los tipos de
-- artículo: una botella y una caja de cartón no pueden compartir número.
CREATE SEQUENCE IF NOT EXISTS entradas_numero_seq START 1001;

ALTER TABLE lots ADD COLUMN IF NOT EXISTS entrada_no integer;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS etiqueta_token text;

-- Se rellenan los lotes que ya existían, por orden, y a cada uno el que le
-- toca. Los que ya tenían número se quedan con el suyo.
UPDATE lots SET entrada_no = nextval('entradas_numero_seq')
 WHERE entrada_no IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_lots_entrada_no ON lots(entrada_no);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lots_etiqueta_token ON lots(etiqueta_token);

COMMENT ON COLUMN lots.entrada_no IS
  'Número de entrada de almacén, único y sin reutilizar. NO es el lote interno '
  '(lots.code) ni el lote del fabricante (supplier_lot_code): son tres cosas.';
COMMENT ON COLUMN lots.etiqueta_token IS
  'Token opaco de la etiqueta. Sin PII. Rotarlo invalida las pegatas viejas '
  'sin tocar el lote ni su stock.';

-- ── BITÁCORA DE IMPRESIONES ─────────────────────────────────────────────────
--
-- Reimprimir NO crea entradas, NO mueve stock y NO toca costes. Lo único que
-- deja rastro es que alguien imprimió algo: quién, cuándo, de qué entrada y en
-- qué formato. Sin esto no se puede responder «¿cuántas pegatas se gastaron?».
--
-- Se APOSTA, no se borra: una impresión es un hecho, como un movimiento.
-- La secuencia va ANTES de la tabla. En un `CREATE TABLE`, el DEFAULT se
-- evalúa en el momento de crearla: si la secuencia no existe todavía, la
-- sentencia falla y la migración entera se va atrás.
CREATE SEQUENCE IF NOT EXISTS lot_etiquetas_id_seq;

CREATE TABLE IF NOT EXISTS lot_etiquetas (
  id            integer PRIMARY KEY DEFAULT nextval('lot_etiquetas_id_seq'),
  lote_id       integer NOT NULL REFERENCES lots(id),
  entrada_no    integer NOT NULL,
  formato       text NOT NULL CHECK (formato IN ('50x30','60x40','100x50')),
  copias        integer NOT NULL DEFAULT 1 CHECK (copias > 0),
  reimpresion   boolean NOT NULL DEFAULT false,
  usuario_id    integer REFERENCES users(id),
  creado_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lot_etiquetas_lote ON lot_etiquetas(lote_id, creado_at DESC);
CREATE INDEX IF NOT EXISTS idx_lot_etiquetas_entrada ON lot_etiquetas(entrada_no);

COMMENT ON TABLE lot_etiquetas IS
  'Bitácora de impresiones de etiqueta. Es un REGISTRO, no un efecto: imprimir '
  'nunca cambia existencias, costes ni movimientos.';

-- El TOKEN NO SE GENERA AQUÍ, A PROPÓSITO.
--
-- La función que lo hacía usaba `gen_random_bytes`, que viene de pgcrypto. PGlite
-- no lo trae, y el token es un identificador, no una función de base de datos: se
-- genera en Node con `crypto.randomBytes`, que además es más fuerte. Aquí solo
-- se abre la columna; los lotes antiguos la reciben cuando alguien pide su
-- etiqueta por primera vez.
COMMENT ON COLUMN lots.etiqueta_token IS
  'Token opaco de la etiqueta, generado en el servidor con crypto. Sin PII. '
  'Rotarlo invalida las pegatas viejas sin tocar el lote ni su stock.';
