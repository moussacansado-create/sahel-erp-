-- ═══════════════════════════════════════════════════════════════════════════
-- 023 · EL PENDIENTE DE COBRO, UNA SOLA VEZ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hay UN dato que aparece en tres sitios:
--
--   1. La tarjeta del repartidor, que dice «cobra esto».
--   2. El cobro, que tiene que cobrar exactamente eso.
--   3. El disparador, que tiene que rechazar a quien cobre de más.
--
-- Y cada uno lo calculaba por su cuenta. El 1 y el 2 con la misma fórmula en
-- SQL, y el 3 con la misma fórmula dentro de plpgsql, y por eso la tarjeta y
-- la base se separaron: el punto 1 restaba lo cobrado, el 3 no.
--
-- Tres cuentas que quieren decir lo mismo son tres cuentas que acabarán
-- diciendo cosas distintas. Aquí no hay una cuenta: hay UNA función, y las tres
-- la llaman.
--
-- ── POR QUÉ EN LA BASE Y NO EN UN MÓDULO DE JS ────────────────────────────
--
-- Porque un módulo de JS se puede dejar de llamar. La base no. Si esta función
-- no está, el cobro no sale: no hay importe que registrar. Ese es el tipo de
-- garantía que sobrevive a que alguien lea el repositorio un martes con
-- prisas y piense «el importe ya lo trae el cliente, no hace falta calcularlo».
--
-- ── `PENDIENTE`, Y NO `TOTAL` ──────────────────────────────────────────────
--
-- El nombre importa. Una función que se llama `pendiente_de` y devuelve el
-- total se llama mal, y la próxima vez alguien la usa creyendo que devuelve
-- lo que falta y cobra de más.
--

CREATE OR REPLACE FUNCTION fn_pendiente_cobro(p_pedido bigint)
RETURNS NUMERIC(18,4)
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(COALESCE(o.total, 0) - COALESCE(
           (SELECT SUM(p.amount)
              FROM payments p
             WHERE p.sales_order_id = o.id
               AND p.status <> 'REJECTED'),
           0), 0)
    FROM sales_orders o
   WHERE o.id = p_pedido
$$;

COMMENT ON FUNCTION fn_pendiente_cobro(bigint) IS
  'Lo que le queda por pagar a un pedido: total menos lo cobrado, nunca menos '
  'de cero. Los cobros rechazados no cuentan, porque un cobro rechazado es un '
  'cobro que no ocurrió. Es la ÚNICA cuenta de pendiente del sistema: la usan '
  'la tarjeta, el cobro y el disparador.';


-- ── LA TARJETA PASA A USARLA ───────────────────────────────────────────────
--
-- La cuenta inline de `resolverQr()` disappearía en el punto 2, pero aquí solo
-- se deja la función. `clientes.js` la llama desde la vista.
--
-- Y el disparador también, para que no pueda volver a desincronizarse.
--
CREATE OR REPLACE FUNCTION fn_cobro_no_inventa_importe() RETURNS trigger AS $$
DECLARE
  pendiente NUMERIC(18,4);
  moneda_pedido TEXT;
BEGIN
  SELECT o.currency_code INTO moneda_pedido
    FROM sales_orders o WHERE o.id = NEW.sales_order_id;

  IF moneda_pedido IS NULL THEN
    RAISE EXCEPTION 'El pedido % no existe', NEW.sales_order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- La moneda del cobro es la del pedido. Cobrar un pedido en francos y
  -- registrarlo en euros sería inventar una conversión, y es exactamente la
  -- cuenta paralela que este circuito no admite.
  IF NEW.currency_code <> moneda_pedido THEN
    RAISE EXCEPTION
      'El cobro está en % pero el pedido % está en %. Un cobro no convierte: convierte el documento, que es otra cosa.',
      NEW.currency_code, NEW.sales_order_id, moneda_pedido
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- Y el importe se valida contra LA MISMA cuenta que enseña la tarjeta.
  --
  pendiente := fn_pendiente_cobro(NEW.sales_order_id);

  IF NEW.amount > pendiente + 0.0001 THEN
    RAISE EXCEPTION
      'Al pedido % le quedan % por pagar y el cobro es de %. El importe sale del pedido, no de la pantalla de cobro: no se puede cobrar más de lo que el cliente debe.',
      NEW.sales_order_id, pendiente, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- LOS MÉTODOS DE PAGO, EN DATOS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Estaba todo en un CHECK: `method IN ('CASH','ORANGE_MONEY',...)`. Eso es un
-- buen sitio para IMPEDIR un método inventado, y un sitio pésimo para
-- responder a la pregunta «¿qué métodos hay y cuál necesita comprobante?».
--
-- Con el CHECK solo, la pantalla tenía dos opciones, y las dos son malas:
-- escribir la lista en el JavaScript —y que se quede vieja el día que se añada
-- uno— o leerla de algún sitio que tampoco existe.
--
-- Aquí están los métodos, con su etiqueta y con si piden comprobante. La
-- garantía NO se mueve: el CHECK de `payments.method` se queda, y sigue siendo
-- la que para un método inexistente aunque alguien añada una fila aquí. Son dos
-- cosas distintas y por eso no estorban: una es la LISTA, la otra es la GARANTÍA.
--
CREATE TABLE IF NOT EXISTS payment_methods (
  code              TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  requires_reference BOOLEAN NOT NULL DEFAULT FALSE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INTEGER NOT NULL DEFAULT 100,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payment_methods IS
  'Métodos de pago que la aplicación ofrece. Es la LISTA, no la garantía: la '
  'garantía de que no se acepte un método raro sigue siendo el CHECK de '
  'payments.method en la base.';

INSERT INTO payment_methods (code, label, requires_reference, sort_order) VALUES
  ('CASH',         'Efectivo',              false, 10),
  ('ORANGE_MONEY', 'Orange Money',          true,  20),
  ('MOBILE_MONEY', 'Otro móvil / transferencia', true, 30),
  ('BANK_TRANSFER','Transferencia bancaria',true,  40)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      requires_reference = EXCLUDED.requires_reference,
      sort_order = EXCLUDED.sort_order;
