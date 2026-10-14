-- ══════════════════════════════════════════════════════════════════════════════
-- 048 · INCIDENCIAS COMERCIALES DE CLIENTES
--
-- ── POR QUÉ OTRA TABLA Y NO LA DE `incidents` ───────────────────────────────
--
-- `incidents` (migración 005) es del REPARTO: cuelga de `deliveries`, habla de
-- «destinatario ausente», «dirección equivocada», «rehusó el pago». No tiene
-- cliente, no tiene comercial y no tiene zona. Un problema comercial —«falta
-- mercancía», «el cliente reclama por la calidad»— no encaja en ninguno de sus
-- campos, y forzarlo ahí sería mezclar dos cosas que se resuelven de forma
-- distinta: un reparto lo resuelve quien va a la puerta, una incidencia la lleva
-- el comercial.
--
-- `incidents` no se toca. Ni sus datos, ni su lógica, ni sus índices.
--
-- ── LA MISMA TRAZABILIDAD QUE LAS VISITAS ───────────────────────────────────
--
--   registrada_por · QUIÉN LA ESCRIBE. El servidor, desde la sesión. Nunca del
--                    cuerpo de la petición.
--   comunicada_por · QUIÉN LA COMUNICA O LA DETECTA. Puede ser el mismo, pero
--                    no tiene por qué: un comercial puede abrir la incidencia
--                    que un cliente le ha contado, y entonces quien la cuenta
--                    es el cliente y quien la registra es el comercial.
--   comercial_id  · QUIÉN LA LLEVA. No es el dueño del cliente: es a quien hay
--                    que avisar, y puede ser otro si el dueño está de vacaciones.
--   responsable_id · DE QUIÉN ES EL CLIENTE al abrirla. FOTO, no enlace vivo,
--                    igual que en `com_visitas`.
--
-- ── RESOLVER NO BORRA ────────────────────────────────────────────────────────
--
-- Como el resto del sistema: `resolved_at` y `resolvida_por` se rellenan y la
-- fila se queda. Un historial donde «resolver» es «borrar» no es un historial.
-- Y como no se puede cambiar una incidencia ya resuelta, el disparador lo
-- impide en la base, no solo en el código.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS com_incidencias (
  id              SERIAL PRIMARY KEY,

  -- ── A QUIÉN AFECTA ─────────────────────────────────────────────────────────
  cliente_id      INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
  -- La incidencia puede no tener cliente: una avería general de la zona también
  -- es una incidencia. Por eso es NULL y no NOT NULL.
  comercial_id    INTEGER REFERENCES com_perfiles(id) ON DELETE RESTRICT,
  -- FOTO de quién era el dueño del cliente cuando se abrió.
  responsable_id  INTEGER REFERENCES com_perfiles(id) ON DELETE SET NULL,
  zona_id         INTEGER REFERENCES com_zonas(id) ON DELETE RESTRICT,

  -- ── QUIÉN ─────────────────────────────────────────────────────────────────
  registrada_por  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  comunicada_por  INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  resuelta_por    INTEGER REFERENCES users(id) ON DELETE RESTRICT,

  -- ── QUÉ ───────────────────────────────────────────────────────────────────
  -- Los tipos son los problemas que de verdad salen en una ruta comercial. Los
  -- de `incidents` (destinatario ausente, dirección mal) NO se copian: son de
  -- reparto y aquí no significan nada.
  tipo            TEXT NOT NULL CHECK (tipo IN (
                     'PEDIDO_NO_LLEGADO', 'FALTA_MERCANCIA', 'CALIDAD',
                     'PRECIO_O_FACTURA', 'SERVICIO', 'COMERCIAL', 'OTRO')),
  descripcion     TEXT NOT NULL CHECK (length(btrim(descripcion)) > 0),
  gravedad        TEXT NOT NULL DEFAULT 'NORMAL'
                    CHECK (gravedad IN ('BAJA', 'NORMAL', 'ALTA', 'URGENTE')),

  -- ── ESTADO ────────────────────────────────────────────────────────────────
  estado          TEXT NOT NULL DEFAULT 'ABIERTA'
                    CHECK (estado IN ('ABIERTA', 'EN_CURSO', 'ESPERA', 'RESUELTA')),

  -- ── SEGUIMIENTO Y CIERRE ──────────────────────────────────────────────────
  proxima_accion      TEXT,
  fecha_seguimiento   DATE,
  resolucion          TEXT,
  resuelta_at         TIMESTAMPTZ,

  -- ── TRAZA ─────────────────────────────────────────────────────────────────
  creado_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Resolver tiene que llevar la resolución y quién la hizo. Una incidencia
  -- marcada «resuelta» sin decir qué se hizo no sirve para nada después.
  CONSTRAINT com_incidencias_resolucion_completa CHECK (
    estado <> 'RESUELTA'
    OR (resolucion IS NOT NULL AND resuelta_at IS NOT NULL AND resuelta_por IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_com_incidencias_cliente  ON com_incidencias (cliente_id, estado);
CREATE INDEX IF NOT EXISTS idx_com_incidencias_estado    ON com_incidencias (estado, creado_at DESC);
CREATE INDEX IF NOT EXISTS idx_com_incidencias_comercial ON com_incidencias (comercial_id, estado);
-- Para el centro de alertas: solo las abiertas, y por orden de llegada.
CREATE INDEX IF NOT EXISTS idx_com_incidencias_abiertas
  ON com_incidencias (creado_at DESC) WHERE estado <> 'RESUELTA';

COMMENT ON TABLE com_incidencias IS
  'Incidencias COMERCIALES de clientes. Distinta de `incidents`, que es del '
  'reparto y no se toca.';
COMMENT ON COLUMN com_incidencias.responsable_id IS
  'FOTO del comercial responsable del cliente al abrirse. No es un enlace vivo.';
COMMENT ON COLUMN com_incidencias.registrada_por IS
  'Usuario que la introduce. Lo pone el servidor desde la sesion, nunca el cuerpo.';
COMMENT ON COLUMN com_incidencias.resolucion IS
  'Que se hizo. Una incidencia resuelta sin esto no se puede cerrar: lo impide un '
  'CHECK, no el codigo.';

-- ── Una incidencia abierta no se puede tocar a la ligera ────────────────────
-- Lo que NO se permite: borrar, ni pasar de RESUELTA a otra cosa, ni dejarla
-- resuelta sin resolución, ni cambiarle el cliente o la fecha de creación. Todo
-- eso se corrige abriendo otra incidencia o añadiendo el historial, no puliendo
-- la fila.
CREATE OR REPLACE FUNCTION trg_incidencia_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una incidencia comercial no se borra (id %). Se resuelve y se queda: es un registro, no un borrador.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.estado = 'RESUELTA' AND NEW.estado <> 'RESUELTA' THEN
    RAISE EXCEPTION 'La incidencia % ya esta resuelta y no se puede reabrir. Abre otra nueva.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
     OR NEW.creado_at IS DISTINCT FROM OLD.creado_at
     OR NEW.registrada_por IS DISTINCT FROM OLD.registrada_por THEN
    RAISE EXCEPTION 'En la incidencia % no se pueden cambiar el cliente, la fecha ni quien la registro. Esos tres son su identidad.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.actualizado_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER incidencia_no_se_borra
  BEFORE UPDATE OR DELETE ON com_incidencias
  FOR EACH ROW EXECUTE FUNCTION trg_incidencia_append_only();