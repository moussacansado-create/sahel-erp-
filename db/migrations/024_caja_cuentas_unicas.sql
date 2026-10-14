-- ═══════════════════════════════════════════════════════════════════════════
-- 024 · LA CAJA NO TIENE DOS CUENTAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hay dos hechos sobre el mismo dinero:
--
--   1. `cash_handoffs`: la caja recibió X de un repartidor.
--   2. `payment_handoffs`: qué cobros concretos se dieron en ese traspaso.
--
-- Del segundo sale lo que el repartidor sigue debiendo. Y aquí es donde se
-- separaban, porque el enlace lo ponía el PROGRAMADOR, en el mismo `INSERT` o
-- en el siguiente, y nada obligaba a que estuviera.
--
-- ── LOS DOS AGUJEROS QUE ESTABAN ─────────────────────────────────────────
--
-- UNO. Un traspaso se podía marcar como recibido sin enlazar NINGÚN cobro.
-- La caja tenía el dinero en la mano, el traspaso decía «RECONCILED», y el
-- repartidor seguía debiendo el 121 para siempre. Sin error, sin aviso y sin
-- nada que se mirara: nadie abre la deuda de un repartidor por curiosidad.
--
-- DOS. `payment_handoffs` no comprobaba NADA del cruce. Se podía enlazar el
-- cobro de un repartidor al traspaso de otro, y saldar a uno con el dinero del
-- otro. Tampoco miraba la moneda, así que un traspaso en euros podía quedarse
-- saldado con cobros en francos.
--
-- Los dos{,} porque el enlace era un dato que el programa escribía cuando se
-- acordaba, y no una consecuencia de haber recibido el dinero.
--
-- ── LO QUE HACE ESTA MIGRACIÓN ───────────────────────────────────────────
--
-- · `fn_por_entregar()`: UNA función para lo que lleva el repartidor. La usan
--   la vista y el disparador, que tenían la fórmula copiada.
-- · El enlace pasa a ser una RESTRICCIÓN, no una costumbre: un cobro solo se
--   enlaza al traspaso de SU repartidor y en SU moneda.
-- · Un traspaso recibido TIENE QUE tener cobros detrás, comprobado al cerrar
--   la transacción, cuando ya se han escrito los enlaces.
--

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · LO QUE LLEVA EL REPARTIDOR, UNA SOLA VEZ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_pendiente_cobro()` hace lo mismo para un pedido. Esta es su hermana para
-- una persona, y por el mismo motivo: estaba escrita dos veces, una en la vista
-- y otra en el disparador, y dos copias de una cuenta que decide quién debe qué
-- son dos cuentas.

CREATE OR REPLACE FUNCTION fn_por_entregar(
  p_usuario INTEGER,
  p_moneda   TEXT
) RETURNS NUMERIC(18,4)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT SUM(p.amount)
      FROM payments p
     WHERE p.collected_by = p_usuario
       AND p.status <> 'REJECTED'
       AND p.currency_code = p_moneda
       AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = p.id)
  ), 0)
$$;

COMMENT ON FUNCTION fn_por_entregar(integer, text) IS
  'Lo que lleva encima un repartidor en una moneda: sus cobros, menos los ya '
  'entregados. Es un HECHO derivado de los cobros, no un saldo guardado. Es la '
  'ÚNICA cuenta de esto en el sistema.';


-- ── La vista pasa a usarla ─────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_deuda_repartidor AS
SELECT
  p.collected_by                                   AS user_id,
  p.currency_code,
  COALESCE(SUM(p.amount), 0)                       AS cobrado,
  COALESCE(SUM(p.amount) FILTER (WHERE ph.handoff_id IS NOT NULL), 0) AS entregado,
  -- Y lo que queda sale de LA FUNCIÓN, no de restar aquí otra vez. Esta columna
  -- y la que calcula el disparador del traspaso son ahora la misma cuenta, y no
  -- pueden dejar de estarlo.
  fn_por_entregar(p.collected_by, p.currency_code) AS en_su_poder
FROM payments p
LEFT JOIN payment_handoffs ph ON ph.payment_id = p.id
WHERE p.status <> 'REJECTED'
GROUP BY p.collected_by, p.currency_code;


-- ── Y el disparador del traspaso también ──────────────────────────────────

CREATE OR REPLACE FUNCTION fn_traspaso_calcula_importes() RETURNS trigger AS $$
BEGIN
  IF NEW.expected_amount IS NOT NULL AND NEW.expected_amount <> 0 THEN
    RAISE WARNING
      'El importe esperado se recalcula a partir de los cobros sin entregar; el que has escrito no se ha usado.';
  END IF;

  NEW.expected_amount := fn_por_entregar(NEW.handed_by, NEW.currency_code);
  NEW.difference := NEW.received_amount - NEW.expected_amount;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · UN COBRO SOLO SE ENLAZA AL TRASPASO DE SU PROPIO REPARTIDOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Esto no se puede poner como CHECK, porque los CHECK no pueden mirar otra
-- tabla. Va como disparador, y por eso va aquí y no en el CREATE TABLE.

CREATE OR REPLACE FUNCTION fn_enlace_no_mezcla_repartidores() RETURNS trigger AS $$
DECLARE
  el_pago     payments%ROWTYPE;
  el_traspaso cash_handoffs%ROWTYPE;
BEGIN
  SELECT * INTO el_pago     FROM payments      WHERE id = NEW.payment_id;
  SELECT * INTO el_traspaso FROM cash_handoffs WHERE id = NEW.handoff_id;

  IF el_pago IS NULL OR el_traspaso IS NULL THEN
    RAISE EXCEPTION 'El cobro % o el traspaso % no existen', NEW.payment_id, NEW.handoff_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  --
  -- El cruce. Un cobro de A no se entrega en el traspaso de B.
  --
  -- Antes esto se podía hacer sin que nada se enterara, y el resultado era que
  -- un repartidor quedaba saldado con el dinero de otro y el otro, sin
  -- explicación, se quedaba debiendo lo suyo. Dos cuentas que dicen cosas
  -- distintas, cada una con su cifra delante.
  --
  IF el_pago.collected_by <> el_traspaso.handed_by THEN
    RAISE EXCEPTION
      'El cobro % es del repartidor % y el traspaso % es del repartidor %. Un cobro se entrega en el traspaso de QUIEN LO COBRÓ, no en el de otro: si no, uno queda saldado con el dinero del otro.',
      NEW.payment_id, el_pago.collected_by, NEW.handoff_id, el_traspaso.handed_by
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- Y la moneda. Un traspaso en euros saldado con cobros en francos es una
  -- cuenta que cuadra en el papel y no cuadra en la realidad. Y aquí no se
  -- convierte: no se puede. Un cobro no cambia de moneda por el hecho de
  -- acabar en otro sitio.
  --
  IF el_pago.currency_code <> el_traspaso.currency_code THEN
    RAISE EXCEPTION
      'El cobro % está en % y el traspaso % está en %. Un traspaso se concilia en UNA moneda, y los cobros que lo saldan tienen que ser de esa misma.',
      NEW.payment_id, el_pago.currency_code, NEW.handoff_id, el_traspaso.currency_code
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- Y no se enlaza a un traspaso que aún no se ha recibido. Un traspaso
  -- PENDING es una promesa; enlazarle cobros daría por entregados unos cobros
  -- que nadie ha recibido todavía.
  --
  IF el_traspaso.status = 'PENDING' THEN
    RAISE EXCEPTION
      'El traspaso % todavía no se ha recibido. Enlazar cobros a un traspaso pendiente daría el dinero por entregado antes de recibirlo.',
      NEW.handoff_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_enlace_no_mezcla
  BEFORE INSERT OR UPDATE ON payment_handoffs
  FOR EACH ROW EXECUTE FUNCTION fn_enlace_no_mezcla_repartidores();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3 · UN TRASPASO RECIBIDO TIENE QUE TENER COBROS DETRÁS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El agujero uno, cerrado.
--
-- El problema de COMPROBARLO es que los enlaces se escriben DESPUÉS que el
-- traspaso, porque `payment_handoffs` apunta a `cash_handoffs`. Un disparador
-- normal de INSERT se dispara en el INSERT, cuando todavía no hay nada que
-- mirar, y daría por bueno un traspaso que tres líneas después queda huérfano.
--
-- Por eso esto es un CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED: se
-- dispara al CERRAR la transacción, cuando los enlaces ya están escritos. Es
-- el sitio correcto, y no es un truco: es literalmente el momento en que la
-- operación es REALMENTE un hecho, no a medio hacer.
--
-- Se comprueba en la moneda del traspaso, que es la única en la que tiene
-- sentido: dos monedas no se suman.

CREATE OR REPLACE FUNCTION fn_traspaso_recibido_tiene_cobros() RETURNS trigger AS $$
DECLARE
  lo_que_llevaba NUMERIC(18,4);
  lo_que_queda   NUMERIC(18,4);
  enlazados      NUMERIC(18,4);
BEGIN
  --
  -- Solo los recibdos. Un traspaso PENDING puede no tener nada detrás: es la
  -- promesa de que ese repartidor va a venir.
  --
  IF NEW.status = 'PENDING' THEN
    RETURN NULL;
  END IF;

  --
  -- Lo que llevaba, y es un dato que YA ESTÁ EN LA FILA.
  --
  -- `expected_amount` lo puso el disparador al abrir el traspaso, antes de que
  -- existiera un solo enlace. Y esto se comprueba al cerrar, cuando los enlaces
  -- ya están: para entonces, recalcular «lo que lleva sin entregar» da una
  -- cuenta distinta, porque los cobros de ESTE traspaso ya no cuentan como
  -- pendientes. Salía «llevaba 71» cuando llevaba 121, y el guard comparaba
  -- 50 contra 71 y se quejaba de una diferencia que no existía.
  --
  -- El número que hay que comparar es el que se guardó, que es el que vio la
  -- caja al abrir el traspaso. Si se recalcula al cerrar, la cuenta depende del
  -- orden en que se escribieron las cosas, y una cuenta que depende del orden
  -- es una cuenta que un día dará otra respuesta.
  --
  lo_que_llevaba := NEW.expected_amount;

  enlazados := COALESCE((
    SELECT SUM(p.amount) FROM payments p
      JOIN payment_handoffs ph ON ph.payment_id = p.id
     WHERE ph.handoff_id = NEW.id
       AND p.currency_code = NEW.currency_code
  ), 0);

  --
  -- Ni un céntimo enlazado, con cobros sin entregar, es el agujero.
  --
  IF enlazados = 0 AND lo_que_llevaba > 0 THEN
    RAISE EXCEPTION
      'El repartidor % entrega % en % y este traspaso no enlaza ni un cobro. Si el dinero se ha recibido, los cobros tienen que estar detrás: si no, seguirá debiendo un dinero que ya está en la caja.',
      NEW.handed_by, lo_que_llevaba, NEW.currency_code
      USING ERRCODE = 'check_violation';
  END IF;

  --
  -- Y los cobros tienen que ser TODOS los que llevaba, no los que la caja contó.
  --
  -- Aquí la primera versión comparaba los enlaces con `received_amount`, y
  -- estaba mal. Es el caso de siempre, pelo del revés: cuando la caja cuenta
  -- 500 de lo que el repartidor llevaba 900, el repartidor NO debe 400. Se los
  -- entregó todos —el dinero salió de su bolsillo— y los que faltan son de la
  -- caja, que los tiene que buscar ella.
  --
  -- Con la comparación por `received_amount` pasaba lo contrario: como solo se
  -- enlazaban 500, al repartidor le quedaban 400 pendientes. Una deuda FANTASMA
  -- sobre dinero que ya no está en ningún sitio, y nadie sabría de dónde salió.
  --
  -- Lo que se compara es contra `expected_amount`, que es lo que llevaba antes
  -- de entregar. Que la caja cuente otra cosa es una DISCREPANCY, y eso se
  -- guarda y se explica: no se arregla descuciendo del repartidor.
  --
  IF enlazados > 0 AND ABS(enlazados - lo_que_llevaba) > 0.0001 THEN
    RAISE EXCEPTION
      'El traspaso % respalda con cobros por % lo que su repartidor llevaba %. El repartidor entrega todo lo que lleva —o no entrega nada—, y lo que la caja cuenta después es una OTRA cosa: si no coincide, es una discrepancia y se anota con su explicación.',
      NEW.id, enlazados, lo_que_llevaba
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER tg_traspaso_con_cobros_detras
  AFTER INSERT OR UPDATE ON cash_handoffs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_traspaso_recibido_tiene_cobros();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4 · LA CAJA NO ES UNA CAJA, SON PERSONAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `cash_handoffs.received_by` YA es una persona concreta con su usuario, y
-- `handed_by` también. Eso es lo importante y ya estaba: el dinero que llega a
-- la caja lo recibe ALGUIEN, y sin nombre no hay a quién preguntarle.
--
-- Lo que faltaba era poder SER esa persona sin ser administrador, y poder
-- mirar sin poder tocar. Eso no es una migración: es política de la empresa, y
-- la política vive en `db/semillas.js` —el rol CAJAJERO y su matriz—, con los
-- otros cuatro.
--
-- Y el módulo `cash` va en `security/permisos.js`, no aquí.
--
-- La primera versión de esta migración insertaba un rol `CASHIER`, y al
-- arrives a casa de las semillas ya había un `CAJAJERO`: dos roles de caja
-- con permisos distintos, según por dónde se llegara. Un rol duplicado no
-- rompe nada de forma visible —todo sigue funcionando— y por eso es peor: es
-- el tipo de duplicado que aparece un día en un informe y nadie sabe por qué
-- hay dos.
--
-- Si alguna vez hay que cambiar lo que la caja puede hacer, se cambia en la
-- semilla, junto a los otros roles. Aquí no.
--

COMMENT ON TABLE cash_handoffs IS
  'Un traspaso de dinero de UNA persona a OTRA. received_by es una persona con '
  'usuario, no una caja genérica: el dinero que llega a la caja lo recibe '
  'alguien, y sin nombre no hay a quién preguntar. Y un traspaso recibido tiene '
  'que tener cobros detrás —lo garantiza tg_traspaso_con_cobros_detras al '
  'cerrar la transacción—, o el repartidor sigue debiendo un dinero que ya '
  'está en la caja.';
