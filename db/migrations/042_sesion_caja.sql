-- ══════════════════════════════════════════════════════════════════════════
-- 042 · SESIÓN DE CAJA: APERTURA, MOVIMIENTOS, ARQUEO Y CIERRE
-- ══════════════════════════════════════════════════════════════════════════
--
-- LO QUE YA HABÍA
--
-- `cash_handoffs` es el TRASPASO: el repartidor lleva el dinero y alguien de
-- caja lo recoge. Eso está bien hecho y sigue igual.
--
-- Pero un traspaso no es una caja. Una caja tiene un día, se abre con un
-- fondo, van entrando y saliendo cosas, y al final del día alguien cuenta el
-- dinero de verdad y lo compara con lo que el sistema dice que debería haber.
-- Eso no existía.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ UNA SESIÓN Y NO UN SALDO EN LA TABLA
--
-- Porque el arqueo necesita saber QUÉ HAYÍA cuando empezó la jornada. Sin un
-- punto de partida, «faltan 20.000» no significa nada: puede que faltaran al
-- empezar el día o que se gastaran. La sesión es ese punto de partida, y es
-- lo que hace que la diferencia sea una diferencia y no un número suelto.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- UNA SOLO ABIERTA A LA VEZ
--
-- Por usuario y por moneda. La comprobación está en la BASE, con un índice
-- parcial único, no en el código: dos cajas abiertas a la vez no es un caso
-- que deba saltarse una petición, es un estado que no se debe poder alcanzar ni
-- por accidente.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LOS MOVIMIENTOS NO SE EDITAN NI SE BORRAN
--
-- Un movimiento de caja es un hecho. Si se ha equivocado, se corrige con otro
-- movimiento que lo diga, no borrando el primero: si el día cuadra porque
-- alguien quitó un movimiento, no cuadra, aparenta cuadrar.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE ESTÁ SIN DEFINIR Y SE HA DEJADO SIN DECIDIR
--
-- Qué pasa si el contado NO cuadra con lo esperado. Aquí NO se bloquea el
-- cierre: se registra la diferencia y se anota, y se puede cerrar igualmente.
-- La razón es que bloquear el cierre deja a alguien con dinero contable y sin
-- poder salir de la jornada, y eso se arregla llamándonos, no con una
-- constraint. Si algún día tiene que bloquear, se cambia aquí y se dice.

-- ═══ La sesión ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cash_sessions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  moneda          TEXT    NOT NULL,
  abierta_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lo que había contado al abrir. Se guarda como se contó, sin redondear:
  -- un fondo inicial de 20.005,25 son 20.005,25, no 20.005.
  fondo_contado   NUMERIC(14,2) NOT NULL CHECK (fondo_contado >= 0),
  fondo_notas     TEXT,
  cerrada_at      TIMESTAMPTZ,
  -- Lo contado al arquear. Lo escribe la persona, no el sistema.
  arqueo_contado  NUMERIC(14,2) CHECK (arqueo_contado IS NULL OR arqueo_contado >= 0),
  arqueo_notas    TEXT,
  cerrada_por     INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT caja_abierta_abierta    CHECK (cerrada_at IS NULL OR arqueo_contado IS NOT NULL),
  CONSTRAINT caja_cerrada_con_fecha  CHECK ((cerrada_at IS NULL) = (cerrada_por IS NULL)),
  CONSTRAINT caja_no_altera_abierta  CHECK (cerrada_at IS NULL OR cerrada_at >= abierta_at)
);

-- Una sola sesión ABIERTA por usuario y moneda.
--
-- Índice PARCIAL: solo mira las abiertas. Cerrar la caja de ayer no impide
-- abrir la de hoy, que es justo lo que tiene que pasar.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_caja_abierta
  ON cash_sessions (user_id, moneda)
  WHERE cerrada_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_caja_usuario_fecha ON cash_sessions (user_id, moneda, abierta_at DESC);
CREATE INDEX IF NOT EXISTS idx_caja_cerrada       ON cash_sessions (cerrada_at) WHERE cerrada_at IS NOT NULL;

-- ═══ Los movimientos ══════════════════════════════════════════════════════
--
-- Solo puede haber movimientos en una sesión ABIERTA. Se comprueba en la base
-- con un disparador, no confiando en que el código se acuerde.

CREATE TABLE IF NOT EXISTS cash_movements (
  id          SERIAL PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  kind        TEXT    NOT NULL CHECK (kind IN ('IN', 'OUT')),
  concepto    TEXT    NOT NULL,
  -- El importe va SIEMPRE en positivo. El `kind` dice de qué lado está. Un
  -- negativo en un OUT parece más listo y luego rompe cualquier suma, porque
  -- `-100` en una columna `CHECK (>= 0)` no pasa y en una que no lo tiene,
  -- duplica el signo al moverlo.
  importe     NUMERIC(14,2) NOT NULL CHECK (importe >= 0),
  moneda      TEXT    NOT NULL,
  -- De dónde viene: un cobro, un traspaso, un arqueo... NULL significa que no
  -- viene de nada, y eso se ve y se puede preguntar.
  ref_tipo    TEXT,
  ref_id      TEXT,
  usuario_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notas       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT movimiento_con_ref CHECK ((ref_tipo IS NULL) = (ref_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_mov_caja_sesion ON cash_movements (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mov_caja_fecha   ON cash_movements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mov_caja_ref     ON cash_movements (ref_tipo, ref_id) WHERE ref_tipo IS NOT NULL;

-- El dinero no se toca una vez escrito.
CREATE OR REPLACE FUNCTION trg_movimiento_inmutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Un movimiento de caja no se modifica ni se borra (id %).
    Si está equivocado, se corrige con otro movimiento que lo diga.
    Borrarlo haría cuadrar el día sin que el día cuadre.', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER movimiento_no_se_toca
  BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movimiento_inmutable();

-- Nada entra ni sale de una caja que ya está cerrada.
CREATE OR REPLACE FUNCTION trg_movimiento_caja_abierta()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE abierta BOOLEAN;
BEGIN
  SELECT (cerrada_at IS NULL) INTO abierta FROM cash_sessions WHERE id = NEW.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La sesión de caja % no existe.', NEW.session_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF abierta IS FALSE THEN
    RAISE EXCEPTION 'La caja está cerrada: no se pueden añadir movimientos a la sesión %.',
      NEW.session_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER movimiento_solo_caja_abierta
  BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movimiento_caja_abierta();

-- ═══ El esperado, en SQL ══════════════════════════════════════════════════
--
-- Fondo + entradas − salidas. Está en la base y no en JavaScript por lo que ya
-- está escrito en el proyecto: si el arqueo lo calculara la pantalla y el
-- resumen lo calculara el servidor, los dos números serían ciertos y los dos
-- mentirían.
--
-- Devuelve las tres cifras a la vez — esperado, contado y diferencia— porque
-- separarlas obligaría a recalcular en algún sitio y ahí es donde empiezan a
-- dejar de cuadrar.

CREATE OR REPLACE FUNCTION fn_caja_esperado(p_session_id INT)
RETURNS TABLE (
  fondo        NUMERIC,
  entradas     NUMERIC,
  salidas      NUMERIC,
  esperado     NUMERIC,
  contado      NUMERIC,
  diferencia   NUMERIC,
  abierta      BOOLEAN,
  abierta_at   TIMESTAMPTZ,
  cerrada_at   TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT
    s.fondo_contado,
    COALESCE(f.entradas, 0),
    COALESCE(f.salidas, 0),
    s.fondo_contado + COALESCE(f.entradas, 0) - COALESCE(f.salidas, 0),
    s.arqueo_contado,
    s.arqueo_contado - (s.fondo_contado + COALESCE(f.entradas, 0) - COALESCE(f.salidas, 0)),
    s.cerrada_at IS NULL,
    s.abierta_at,
    s.cerrada_at
  FROM cash_sessions s
  LEFT JOIN (
    SELECT session_id,
           SUM(importe) FILTER (WHERE kind = 'IN')  AS entradas,
           SUM(importe) FILTER (WHERE kind = 'OUT') AS salidas
      FROM cash_movements
     WHERE session_id = p_session_id
     GROUP BY session_id
  ) f ON f.session_id = s.id
 WHERE s.id = p_session_id
$$;

-- ─── Comprobación ──────────────────────────────────────────────────────────
--
-- La sesión se prueba aparte, en `tests/caja-sesion.test.js`, contra la base
-- de pruebas. Aquí no va: una migración que monta su propia caja de prueba
-- necesita deshacerla después, y deshacerla choca con el disparador de
-- «los movimientos no se borran». Es mejor una prueba de verdad, que se puede
-- leer y volver a ejecutar, que un self-test que se deshace solo y nadie ve.
