-- ══════════════════════════════════════════════════════════════════════════════
-- 043 · LA RETIRADA DE DINERO DE LA CAJA
--
-- El hueco que faltaba: una caja que abre y cierra sabe cuánto PRODUCJO ese día,
-- pero no sabía a dónde fue ese dinero físicamente. Al día siguiente el cajón
-- empieza con lo que se cuenta a mano, no con lo que quedó ayer, y el dinero de
-- ayer no tenía ninguna anotación: desaparecía del relato.
--
-- ── POR QUÉ ESTO NO ES UN `cash_movements.kind = 'OUT'` ──────────────────────
--
-- Porque el dinero no se ha gastado: ha cambiado de manos. Es de la empresa
-- antes y después. Si se anotara como salida, el resultado de la jornada bajaría
-- a cero y se perdería la única cifra que importa: cuánto ha gestionado la caja
-- ese día. Un gasto reduce el resultado; una retirada no.
--
--     50.000 fondo + 150.000 entradas − 20.000 salidas = 180.000  ← el día
--     180.000 → Responsable + 180.000 → Banco                      ← el destino
--
-- Las dos filas son verdaderas a la vez y no se restan entre sí.
--
-- ── CUÁNDO SE PUEDE RETIRAR ─────────────────────────────────────────────────
--
-- Solo con la caja YA CERRADA. El cierre dice cuánto dinero físico había al
-- terminar la jornada; hasta ese momento, cuánto hay no está cerrado y una
-- retirada sería una estimación, no un hecho.
--
-- ── CUÁNTO SE PUEDE RETIRAR ─────────────────────────────────────────────────
--
-- Nunca más de lo que se contó al cerrar. Varias retiradas parciales sí se
-- permiten, pero su suma no pasa del contado. Se comprueba en el DISPARADOR, no
-- en el código: dos cajas, dos caminos a la misma tabla, y el que se olvide de
-- la comprobación también tiene que ser rechazado por la base.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cash_withdrawals (
  id           SERIAL PRIMARY KEY,

  -- De dónde sale el dinero. Obligatorio: una retirada sin caja de la que salir
  -- sería dinero que aparece de la nada.
  session_id   INTEGER NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,

  -- Lo que se lleva. > 0: una retirada de cero no es una retirada.
  importe      NUMERIC(14,2) NOT NULL CHECK (importe > 0),
  moneda       TEXT NOT NULL,

  -- A dónde va. Sin esto, «dinero que salió de la caja» no es un hecho
  -- auditable: es una salida sin destinatario.
  destino      TEXT NOT NULL
               CHECK (destino IN ('BANCO', 'RESPONSABLE', 'CAJA_MATRIZ')),

  -- Quién lo recibe. Texto y no `users(id)`: el receptor suele ser alguien de
  -- fuera del sistema —un banco, un transportista— y una FK lo dejaría fuera
  -- justo cuando más falta hace nombrarlo.
  destinatario TEXT,

  -- Quién lo registra. Esto sí es siempre alguien del sistema: cada anotación
  -- tiene un autor.
  retirado_por INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  retirado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notas        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── El dinero ya contado, por caja. Sirve para el «pendiente de retirar». ────
CREATE OR REPLACE FUNCTION fn_caja_retirado(p_session_id INT)
RETURNS TABLE (
  contado     NUMERIC,
  retirado    NUMERIC,
  pendiente   NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    s.arqueo_contado,
    COALESCE(w.retirado, 0),
    s.arqueo_contado - COALESCE(w.retirado, 0)
  FROM cash_sessions s
  LEFT JOIN (
    SELECT session_id, SUM(importe) AS retirado
      FROM cash_withdrawals WHERE session_id = p_session_id GROUP BY session_id
  ) w ON w.session_id = s.id
 WHERE s.id = p_session_id;
$$;

-- ── Lo que se ha Ya retirado sale rápido; es la cuenta de cada día. ──────────
CREATE INDEX IF NOT EXISTS idx_retirada_sesion
  ON cash_withdrawals (session_id, retirado_at);

CREATE INDEX IF NOT EXISTS idx_retirada_destino
  ON cash_withdrawals (destino, retirado_at);

-- ── Solo con la caja cerrada ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_retirada_caja_cerrada()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  cerrada BOOLEAN;
  contado NUMERIC;
  ya      NUMERIC;
BEGIN
  SELECT (cerrada_at IS NOT NULL), arqueo_contado
    INTO cerrada, contado
    FROM cash_sessions WHERE id = NEW.session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja % no existe.', NEW.session_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF cerrada IS FALSE THEN
    RAISE EXCEPTION
      'La caja % está abierta. Primero se cierra: hasta el cierre no se sabe '
      'cuánto dinero físico hay, y retirar antes sería estimar, no registrar.',
      NEW.session_id USING ERRCODE = 'restrict_violation';
  END IF;

  -- El límite va AQUÍ y no en el código. La suma de retiradas de una sesión
  -- nunca pasa de lo que se contó al cerrar. Varias parciales sí; el total, no.
  IF contado IS NULL THEN
    RAISE EXCEPTION 'La caja % se cerró sin contar. No se puede retirar de ella.',
      NEW.session_id USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT COALESCE(SUM(importe), 0) INTO ya
    FROM cash_withdrawals WHERE session_id = NEW.session_id;

  IF ya + NEW.importe > contado THEN
    RAISE EXCEPTION
      'No queda tanto dinero. La caja % se cerró en % y ya se han retirado %; '
      'faltan por retirar %. No se pueden retirar %.',
      NEW.session_id, contado, ya, contado - ya, NEW.importe
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER retirada_solo_caja_cerrada
  BEFORE INSERT ON cash_withdrawals
  FOR EACH ROW EXECUTE FUNCTION trg_retirada_caja_cerrada();

-- ── Una retirada escrita no se toca: ni se cambia ni se borra ───────────────
CREATE OR REPLACE FUNCTION trg_retirada_inmutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Una retirada de caja no se modifica ni se borra (id %). Si está equivocada, '
    'se registra la que falte o la que sobra. Borrarla dejaría el dinero sin '
    'destino, que es justo lo que esta tabla existe para evitar.', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER retirada_no_se_toca
  BEFORE UPDATE OR DELETE ON cash_withdrawals
  FOR EACH ROW EXECUTE FUNCTION trg_retirada_inmutable();
