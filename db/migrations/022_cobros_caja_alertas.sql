-- ═══════════════════════════════════════════════════════════════════════════
-- 022 · COBROS, CAJA Y ALERTAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El circuito estaba entero del eslabón 1 al 7 y se cortaba en el 8: no había
-- ninguna tabla de pago ni de caja. Esta migración construye el 8 y el 9, y de
-- paso las alertas, que eran una sección entera del plan original sin construir.
--
-- TRES COSAS QUE ESTA MIGRACIÓN DICE Y QUE IMPORTAN
--
-- 1 · EL COBRO PERTENECE A UN PEDIDO Y A UNA ENTREGA. A los dos. Si pertenece
--     solo al pedido, el repartidor podría cobrar un pedido que no entregó. Si
--     pertenece solo a la entrega, no se puede saber qué factura de proveedor se
--     liquida. Los dos, con clave foránea y sin nulos.
--
-- 2 · EL SALDO DEL REPARTIDOR NO SE GUARDA, SE DERIVA. Hay una vista
--     (`v_deuda_repartidor`) que lo calcula con una resta. Un saldo guardado es
--     un saldo que algún día se desincroniza del cobro que lo originó, y
--     encontrar esa diferencia a mano es exactamente el trabajo que este
--     proyecto existe para evitar.
--
-- 3 · UN COMPROBANTE NO ES UN PAGO. La regla que pidió el negocio, escrita como
--     un CHECK de la base y no como una intención del código. Una promesa en el
--     código se rompe el día que alguien aprieta; una restricción en la base, no.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 1 · COBROS
-- ───────────────────────────────────────────────────────────────────────────
--
-- `amount` es una COPIA del importe pendiente del pedido en el momento del cobro.
-- No se recalcula nunca, y la base lo comprueba: si alguien intenta cobrar de
-- más o de menos que lo que el pedido dice, no se puede guardar.
--
-- La regla se implementa con un disparador, porque el importe pendiente depende
-- de otros cobros y de las entregas, y un CHECK no puede mirar otras tablas.
--
CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  -- El cobro es de UN pedido. No nullable nunca: un cobro sin pedido no se sabe
  -- de dónde es, y un cobro sin saber de dónde es no sirve para nada.
  sales_order_id  BIGINT      NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  -- Y de UNA entrega concreta. Es lo que impide cobrar de más: un segundo paso
  -- por la misma puerta no puede cobrar otra vez lo que ya está entregado.
  delivery_id     BIGINT      REFERENCES deliveries(id) ON DELETE RESTRICT,
  customer_id     BIGINT      NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  -- Quién cobró. Normalmente el repartidor que entregó, pero no está limitado a
  -- él: cobra también quien recibe el pago en la puerta de la tienda.
  collected_by    INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  method          TEXT        NOT NULL
                   CHECK (method IN ('CASH','ORANGE_MONEY','MOBILE_MONEY','BANK_TRANSFER','OTHER')),
  amount          NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency_code   TEXT        NOT NULL REFERENCES currencies(code),
  -- La tasa con la que se cobró, congelada. El cobro es un hecho económico en una
  -- moneda concreta; mañana el euro puede valer otra cosa y este cobro sigue
  -- siendo el que fue.
  exchange_rate   NUMERIC(20,8),
  reference       TEXT,      -- referencia de Orange Money, del banco o del móvil

  -- ── Estado ──────────────────────────────────────────────────────────────
  --
  -- PENDING   : el dinero está en manos del repartidor, sin verificar.
  -- VERIFIED  : alguien con permiso lo ha comprobado. Solo aquí es un pago.
  -- REJECTED  : se ha rechazado. Se conserva, no se borra.
  --
  -- La diferencia entre los dos primeros es la que pidió el negocio: un
  -- comprobante de Orange Money subido por el repartidor es evidencia, no una
  -- confirmación. Sin `verified_by` y `verified_at`, un pago con evidencia
  -- externa NO puede estar confirmado. Y eso lo decide la base.
  --
  status         TEXT        NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  verified_by    INTEGER     REFERENCES users(id) ON DELETE RESTRICT,
  verified_at    TIMESTAMPTZ,
  rejection_note TEXT,

  -- Evidencia: el comprobante. Un PDF o una foto. NO es un pago.
  evidence_url   TEXT,
  evidence_note  TEXT,

  notes          TEXT,
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INTEGER     REFERENCES users(id) ON DELETE RESTRICT
);

--
-- UN COBRO, UNA VEZ, POR ENTREGA Y MÉTODO.
--
-- Sin esto, un doble toque —que en la calle es lo normal, con la pantalla mojada
-- y las prisas— cobra dos veces lo mismo. La entrega es la llave, y una entrega
-- solo se cobra una vez por método.
--
-- Se pone el `UNIQUE` en la BASE, no en el botón. El botón desaparece con la
-- red; la restricción no.
--
CREATE UNIQUE INDEX uniq_payment_por_entrega_metodo
  ON payments (delivery_id, method) WHERE delivery_id IS NOT NULL;

--
-- Y un cobro sin entrega solo puede existir UNA VEZ por pedido y método, que es
-- el caso de quien cobra en la tienda en vez de en la calle.
--
CREATE UNIQUE INDEX uniq_payment_por_pedido_metodo
  ON payments (sales_order_id, method) WHERE delivery_id IS NULL;

CREATE INDEX idx_payments_pedido  ON payments (sales_order_id);
CREATE INDEX idx_payments_cobrador ON payments (collected_by);
CREATE INDEX idx_payments_estado  ON payments (status);

-- ───────────────────────────────────────────────────────────────────────────
-- 2 · LA REGLA DEL COMPROBANTE
-- ───────────────────────────────────────────────────────────────────────────
--
-- «Comprobante recibido ≠ pago confirmado. Quedaría pendiente de verificación
-- hasta que una persona autorizada confirme la operación.»
--
-- Escrita como restricción, no como una buena intención.
--
-- Tres cosas tienen que ser verdad a la vez para que un cobro esté VERIFIED:
--
--   1 · Que alguien lo haya verificado (verified_by, no nulo)
--   2 · CUÁNDO lo verificó (verified_at, no nulo)
--   3 · Que el método lo justifique: si es efectivo, verificado por definición
--       (el dinero está en la mano); si es un móvil, no basta: o hay evidencia,
--       o está pendiente.
--
ALTER TABLE payments ADD CONSTRAINT chk_payment_verificado
  CHECK (
    status <> 'VERIFIED'
    OR (
      verified_by IS NOT NULL
      AND verified_at IS NOT NULL
      AND (
        method = 'CASH'
        OR evidence_url IS NOT NULL
        OR reference IS NOT NULL
      )
    )
  );

-- Y un pago RECHAZADO tiene que decir por qué, o nadie sabe qué hacer después.
ALTER TABLE payments ADD CONSTRAINT chk_payment_rechazado
  CHECK (status <> 'REJECTED' OR (rejection_note IS NOT NULL AND length(trim(rejection_note)) >= 3));

--
-- Un pago por MÓVIL tiene que entrar con algo que lo identifique: una referencia
-- de Orange Money o un comprobante. Sin eso, «cobré por Orange Money» es una
-- frase, no un hecho, y un cajero que lo recibe no tiene nada contra lo que
-- comparar.
--
-- El efectivo no lo necesita: el dinero está en la mano de quien cobra, y eso
-- es la prueba.
--
ALTER TABLE payments ADD CONSTRAINT chk_pago_movil_necesita_identificacion
  CHECK (
    method = 'CASH'
    OR evidence_url IS NOT NULL
    OR reference IS NOT NULL
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 3 · EL IMPORTE VIENE DEL PEDIDO. SIEMPRE.
-- ───────────────────────────────────────────────────────────────────────────
--
-- No es una convención del código: es un disparador. Si mañana alguien escribe
-- un endpoint nuevo que cobra mal, la base le para los pies.
--
-- El importe pendiente de un pedido es su `total` menos lo ya cobrado. Y como el
-- cobro se registra en el MISMO instante que la entrega, ese pendiente es el
-- total entero. Si un pedido se cobra a partes en varias entregas, cada cobro
-- lleva su parte, y esto lo comprueba contra el total pendiente en ese momento.
--
CREATE OR REPLACE FUNCTION fn_cobro_no_inventa_importe() RETURNS trigger AS $$
DECLARE
  pendiente NUMERIC(18,4);
  moneda_pedido TEXT;
BEGIN
  --
  -- `pendiente` es LO QUE FALTA, no el total del pedido.
  --
  -- Estaba puesto a `o.total`, y eso no parece ni halfway un error: el total
  -- del pedido es, sin duda, lo que hay. El problema es que la tarjeta enseña
  -- `total − ya cobrado`, y el banco comparaba contra `total`. Un pedido ya
  -- pagado de 1210 seguía teniendo «1210 pendientes» para la base, así que
  -- aceptaba otro cobro de 1210, y otro, y otro, mientras la tarjeta decía
  -- «0 que cobrar».
  --
  -- Es exactamente la desincronización entre lo que ve el repartidor y lo que
  -- acepta el sistema que la fase 1 tenía que cerrar. Y la encontró una
  -- prueba: la tarjeta y el cobro tienen que leer la MISMA cuenta, no dos
  -- parecidas.
  --
  SELECT o.currency_code,
         COALESCE(o.total, 0) - COALESCE(
           (SELECT SUM(p.amount) FROM payments p
             WHERE p.sales_order_id = o.id
               AND p.status <> 'REJECTED'
               -- El propio cobro que se está insertando todavía no está en la
               -- tabla (esto es un BEFORE INSERT), así que no se cuenta a sí
               -- mismo. Si se contara, un segundo cobro del mismo importe
               -- vería un pendiente ya reducido y pasaría justo por donde
               -- tiene que pasar.
           ), 0)
    INTO moneda_pedido, pendiente
    FROM sales_orders o WHERE o.id = NEW.sales_order_id;

  IF pendiente IS NULL THEN
    RAISE EXCEPTION 'El pedido % no existe', NEW.sales_order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- La moneda del cobro es la del pedido. Cobrar un pedido en francos y
  -- registrarlo en euros sería inventar una conversión, y es exactamente la
  -- cuenta paralela que este circuito no admite.
  IF NEW.currency_code <> moneda_pedido THEN
    RAISE EXCEPTION
      'El cobro está en % pero el pedido % está en %. Un cobro no convierte: convierte el documento, y eso es otra operación con su propio papel.',
      NEW.currency_code, NEW.sales_order_id, moneda_pedido
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- NINGÚN COBRO PUEDE PASARSE DE LO QUE SE DEBE. NI CON ENTREGA NI SIN ELLA.
  --
  -- Aquí estaba la comprobación metida dentro de «si tiene entrega», con la
  -- idea de que sin entrega es alguien cobrando en la puerta de la tienda y
  -- que ahí una seña o un pago parcial es legítimo. La idea es buena; el
  -- límite estaba mal puesto. Con la condición, un cobro SIN entrega se saltaba
  -- la comprobación entera y podía ser de lo que fuera: 500 000 FCFA sobre un
  -- pedido de 1210, sin que nadie se enterara.
  --
  -- Una seña es un pago PARCIAL, y un pago parcial es menor que el total. No
  -- hace falta una excepción: la misma regla cubre los dos casos.
  --
  IF NEW.amount > pendiente + 0.0001 THEN
    RAISE EXCEPTION
      'Al pedido % le quedan % por pagar y el cobro es de %. El importe sale del pedido, no de la pantalla de cobro: no se puede cobrar más de lo que el cliente debe.',
      NEW.sales_order_id, pendiente, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_cobro_importe_del_pedido
  BEFORE INSERT OR UPDATE OF amount, sales_order_id, currency_code, delivery_id
  ON payments FOR EACH ROW EXECUTE FUNCTION fn_cobro_no_inventa_importe();

-- ───────────────────────────────────────────────────────────────────────────
-- 4 · CAJA
-- ───────────────────────────────────────────────────────────────────────────
--
-- No es un saldo guardado. Es un RASTREGO de entregas de dinero entre el
-- repartidor que lo llevaba y el cajero que lo recibió.
--
-- Se llama `cash_handoffs` y no `cash_sessions` a propósito: una sesión de caja
-- (abrir, operar, cerrar, contar) es otra cosa, y va en su propia tabla. Aquí
-- solo se deja constancia de un traspaso, que es lo que hace falta para poder
-- decir «este hombre me debía tanto y me dio tanto».
--
CREATE TABLE cash_handoffs (
  id              BIGSERIAL PRIMARY KEY,
  -- Quién llevaba el dinero. Puede haber más de uno en un mismo traspaso.
  handed_by       INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Quién lo recibió. Persona concreta, con su usuario, no una caja genérica.
  received_by     INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  handed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at     TIMESTAMPTZ,
  currency_code   TEXT        NOT NULL REFERENCES currencies(code),
  -- `expected` NO SE ESCRIBE A MANO.
  --
  -- Es la suma de los cobros de ese repartidor que aún no se habían handed over.
  -- Se rellena por disparador, porque es un hecho que se deduce de los cobros,
  -- no una cifra que alguien pueda equivocar.
  expected_amount NUMERIC(18,4) NOT NULL CHECK (expected_amount >= 0),
  -- Y este SÍ lo escribe la persona. Es la realidad, y puede no coincidir.
  received_amount NUMERIC(18,4) CHECK (received_amount >= 0),
  -- La diferencia, si la hay. calculada, no tecleada.
  difference      NUMERIC(18,4),
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','RECONCILED','DISCREPANCY')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER     REFERENCES users(id) ON DELETE RESTRICT,

  -- Si no cuadra, queda registrado para su revisión. No se arregla, se explica.
  CONSTRAINT chk_handoff_recibido CHECK (status = 'PENDING' OR received_amount IS NOT NULL),
  CONSTRAINT chk_handoff_discrepancy CHECK (
    status <> 'DISCREPANCY' OR (note IS NOT NULL AND length(trim(note)) >= 3)
  )
);

--
-- `expected_amount` LO CALCULA LA BASE. SIEMPRE.
--
-- La primera versión lo dejó como un NOT NULL normal, y se podía escribir a
-- mano: un `expected_amount = 999` pasaba sin que nadie se enterara. La columna
-- estaba documentada como derivada y no había disparador que la derivara, que
-- es la forma más silenciosa de tener un campo que miente.
--
-- La cuenta es: todo lo que ese repartidor ha cobrado y que todavía no ha
-- entregado a nadie. No es un saldo guardado —es una suma de hechos— y por eso
-- no se puede desincronizar de los cobros que la justifican.
--
  --
  -- (Esta cuenta vive ahora dentro de `fn_traspaso_calcula_importes`, junto a la
  --  diferencia, porque separadas se ejecutaban en orden alfabético y la
  --  diferencia salía antes. Estuvo este disparador Y aquél, y el primero
  --  tapaba al segundo por casualidad: la suite pasaba verde con el fallo
  --  dentro, porque quien llegaba primero ya había derivado la cifra. Dos
  --  disparadores que se tapan el uno al otro son dos disparadores que nadie
  --  va a leer bien dentro de seis meses.)

--
--
-- `difference` TAMBIÉN LA CALCULA LA BASE, Y EN EL ORDEN CORRECTO.
--
-- Recibido menos esperado. Ni un número más ni un número menos, y sobre todo no
-- tecleado: si alguien escribe a mano la diferencia y se equivoca de signo, el
-- cajero ve «faltan 110» cuando de verdad sobran 110, y la conciliación dice lo
-- contrario de lo que pasó.
--
-- Y aquí estaba el segundo fallo de los dos: las dos cifras las calculaban
-- DOS DISPARADORES, `..._esperado` y `..._diferencia`. PostgreSQL los ejecuta
-- en ORDEN ALFABÉTICO por nombre, no en el que se crearon, y «diferencia» va
-- antes que «esperado».
--
-- Así que la diferencia se restaba sobre el importe que había ESCRITO el
-- cajero, no sobre el que la base acababa de derivar. Con 605 tecleados y 500
-- recibidos, la caja veía un faltante de 105 contra una cifra que nadie había
-- verificado. Una conciliación que cuadra contra lo que escribiste.
--
-- Ahora es un disparador, y en este orden: primero lo esperado, y después la
-- diferencia sobre lo recién derivado. Si alguien escribe el importe
-- esperado, se le avisa con un WARNING: esa columna no es suya.
--
CREATE OR REPLACE FUNCTION fn_traspaso_calcula_importes() RETURNS trigger AS $$
BEGIN
  IF NEW.expected_amount IS NOT NULL AND NEW.expected_amount <> 0 THEN
    RAISE WARNING
      'El importe esperado se recalcula a partir de los cobros sin entregar; el que has escrito no se ha usado.';
  END IF;

  NEW.expected_amount := COALESCE((
    SELECT SUM(p.amount)
      FROM payments p
     WHERE p.collected_by = NEW.handed_by
       AND p.status <> 'REJECTED'
       AND p.currency_code = NEW.currency_code
       AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = p.id)
  ), 0);

  -- Y la diferencia, DESPUÉS, sobre el número recién derivado.
  NEW.difference := NEW.received_amount - NEW.expected_amount;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_traspaso_importes_calculados
  BEFORE INSERT OR UPDATE OF received_amount, expected_amount ON cash_handoffs
  FOR EACH ROW EXECUTE FUNCTION fn_traspaso_calcula_importes();

CREATE INDEX idx_handoffs_por_repartidor ON cash_handoffs (handed_by, status);
CREATE INDEX idx_handoffs_por_cajero      ON cash_handoffs (received_by, received_at);

-- Los cobros que se han tenido que entregar a caja. Sin columna en `payments`:
-- es una relación, no un estado. Un cobro no «está en caja», está entregado.
CREATE TABLE payment_handoffs (
  payment_id  BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  handoff_id  BIGINT NOT NULL REFERENCES cash_handoffs(id) ON DELETE RESTRICT,
  PRIMARY KEY (payment_id, handoff_id)
);

-- Un traspaso recibido no se puede volver a marcar como recibido.
CREATE OR REPLACE FUNCTION fn_handoff_no_se_recibe_dos_veces() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'RECONCILED' AND NEW.status = 'RECONCILED' AND NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION
      'El traspaso % ya estaba conciliado el %. No se puede volver a cerrar.',
      OLD.id, OLD.received_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_handoff_una_vez
  BEFORE UPDATE ON cash_handoffs
  FOR EACH ROW EXECUTE FUNCTION fn_handoff_no_se_recibe_dos_veces();

-- ───────────────────────────────────────────────────────────────────────────
-- 5 · LA VISTA DEL SALDO DEL REPARTIDOR
-- ───────────────────────────────────────────────────────────────────────────
--
-- «No quiero un campo manual de saldo del repartidor que pueda
-- desincronizarse. Como propones, el saldo se deriva de los cobros reales.»
--
-- Aquí está la cuenta entera, en una vista, y es una resta. No hay ningún sitio
-- donde alguien pueda escribir un saldo y que separe de los cobros que lo
-- justifican, porque no hay tal sitio.
--
CREATE OR REPLACE VIEW v_deuda_repartidor AS
SELECT
  p.collected_by                                   AS user_id,
  p.currency_code,
  COALESCE(SUM(p.amount), 0)                       AS cobrado,
  COALESCE(SUM(p.amount) FILTER (WHERE ph.handoff_id IS NOT NULL), 0) AS entregado,
  -- Lo que queda en su poder AHORA MISMO. Si esto no cuadra, no hay campo que
  -- corregir: hay que mirar los cobros.
  COALESCE(SUM(p.amount), 0)
    - COALESCE(SUM(p.amount) FILTER (WHERE ph.handoff_id IS NOT NULL), 0)
                                                    AS en_su_poder
FROM payments p
LEFT JOIN payment_handoffs ph ON ph.payment_id = p.id
WHERE p.status <> 'REJECTED'
GROUP BY p.collected_by, p.currency_code;

-- ───────────────────────────────────────────────────────────────────────────
-- 6 · ALERTAS
-- ───────────────────────────────────────────────────────────────────────────
--
-- Sección 16 del plan original: «alertas reales para stock mínimo, caducidad,
-- falta de materias primas, incidencias, pedidos pendientes».
--
-- La tabla ya existía desde la Fase 0. Lo que no existía eran las REGLAS: nadie
-- miraba los mínimos ni las fechas de caducidad. Un lote que caducaba y nadie lo
-- recordaba en silencio, que es justo lo contrario de lo que se pidió.
--
CREATE OR REPLACE VIEW v_stock_bajo_minimo AS
SELECT
  i.id AS item_id, i.sku, i.name, i.category_kind,
  i.min_stock, i.max_stock,
  COALESCE(a.qty_available, 0) AS disponible,
  i.min_stock - COALESCE(a.qty_available, 0) AS falta
FROM items i
LEFT JOIN v_item_available a ON a.item_id = i.id
WHERE i.is_active
  AND i.min_stock IS NOT NULL
  AND COALESCE(a.qty_available, 0) < i.min_stock;

CREATE OR REPLACE VIEW v_lotes_caducando AS
SELECT
  l.id AS lot_id, l.code, l.item_id, i.sku, i.name, i.category_kind,
  l.expiry_date, l.qty_available,
  -- El CAST a `date` es obligatorio y no es cosmético.
  --
  -- `lots.expiry_date` es TIMESTAMPTZ, no DATE. Restarlo a `CURRENT_DATE` da un
  -- INTERVAL, y un intervalo no es un número de días: PostgreSQL contesta
  -- «cannot cast type interval to integer» y la migración se para.
  --
  -- La diferencia son horas. Un lote que caduca a las 18:00 de un día da -1 día
  -- a las 09:00 del siguiente, y eso es exactamente el día en que caducó.
  --
  CAST(l.expiry_date AS date) - CURRENT_DATE AS dias
FROM lots l
JOIN items i ON i.id = l.item_id
WHERE l.qty_available > 0
  AND l.expiry_date IS NOT NULL
  -- 30 días es el margen que se avisa: menos de un mes para reponer, quitar
  -- del lineal o etiquetar. Pasado el día, esto ya es un lote caducado.
  AND l.expiry_date <= CURRENT_DATE + 30
ORDER BY l.expiry_date;

-- Las alertas de la tabla `alerts` se rellenan desde aquí. La tabla no se
-- reescribe en cada consulta: las alertas son un REGISTRO de lo que pasó, y se
-- marcan una vez. Lo que se recalcula cada vez son las dos vistas de arriba,
-- que son el estado de ahora.
CREATE OR REPLACE VIEW v_alertas_activas AS
SELECT
  'STOCK_MINIMO'::TEXT AS kind,
  v.item_id             AS entity_id,
  ('items/' || v.item_id)::TEXT AS entity_ref,
  v.sku                 AS label,
  -- `severity` es un NIVEL (1 AVISO, 2 IMPORTANTE, 3 CRÍTICO), no una cantidad.
  --
  -- Antes esta columna devolvía `v.falta`, que es lo que FALTA: 4 850, 150,
  -- 20… Un nivel de severidad que vale «4850.0000» no es un nivel, y una
  -- pantalla que ordene por severidad ordenaría por unidades equivocadas.
  -- Además «faltan 20 unidades» y «no hay nada» son cosas distintas, y con un
  -- número no se distinguen.
  CASE
    WHEN v.disponible <= 0 THEN 3                                  -- no hay nada
    WHEN v.disponible < v.min_stock / 2 THEN 2                    -- por debajo de la mitad
    ELSE 1                                              -- por debajo del mínimo
  END                 AS severity,
  format('Quedan %s de %s (mínimo %s)',
         v.disponible::int, v.sku, v.min_stock::int) AS detail
FROM v_stock_bajo_minimo v
UNION ALL
SELECT
  'CADUCIDAD'::TEXT,
  v.lot_id,
  ('lots/' || v.lot_id)::TEXT,
  v.code,
  CASE WHEN v.dias < 0 THEN 3 WHEN v.dias <= 7 THEN 2 ELSE 1 END,
  CASE WHEN v.dias < 0
       THEN 'CADUCADO hace ' || abs(v.dias)::int || ' día(s) y todavía hay ' || v.qty_available::int
       ELSE 'Caduca en ' || v.dias::int || ' día(s). Quedan ' || v.qty_available::int
  END
FROM v_lotes_caducando v;

-- ───────────────────────────────────────────────────────────────────────────
-- 7 · GASTOS: SE MATA EL `paid` PARALELO
-- ───────────────────────────────────────────────────────────────────────────
--
-- `expenses` traía `amount` Y `paid`, y ningún código los tocaba. Un interruptor
-- de «pagado» dentro de un gasto es un sistema paralelo: nadie lo mantiene, y
-- un día un gasto dirá que está pagado y el cobro no existirá.
--
-- Se borra la columna. Un gasto se PAGA con un pago, y el pago se registra en
-- `payments`. Si algún día hace falta pagar un gasto, tendrá su propia tabla de
-- pagos, con su propio circuito —y no un booleano.
--
ALTER TABLE expenses DROP COLUMN paid;

ALTER TABLE expenses ADD CONSTRAINT chk_expense_no_negativo CHECK (amount > 0);

COMMENT ON TABLE expenses IS
  'Gasto declarado. NO tiene columna de pagado a propósito: un gasto se paga con un pago real, en la tabla `payments`, y un interruptor «pagado» aquí sería un segundo sistema que nadie mantiene y que un día contradice al primero.';
COMMENT ON TABLE payments IS
  'Cobro. SIEMPRE ligado a un pedido y a un cliente, y su importe sale del pedido — un disparador lo impide inventar otro. Un cobro PENDING con evidencia externa no puede pasar a VERIFIED sin que alguien lo verifique.';
COMMENT ON VIEW v_deuda_repartidor IS
  'Lo que cada repartidor tiene en su poder AHORA, derivado de los cobros. No es un campo guardado: es una resta. Un saldo guardado se desincroniza; una resta, no.';
