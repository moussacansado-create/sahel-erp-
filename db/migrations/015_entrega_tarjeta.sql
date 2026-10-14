-- ═══════════════════════════════════════════════════════════════════════════
-- 015 · LA ENTREGA SE CONFIRMA DESDE LA TARJETA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── POR QUÉ ────────────────────────────────────────────────────────────────
--
-- El reparto funciona así, sobre el terreno:
--
--   1. El pedido está preparado y se ha impreso el albarán.
--   2. El repartidor se lleva la mercancía y el papel.
--   3. El cliente recibe, FIRMA EN PAPEL y se queda su copia.
--   4. El repartidor escanea la TARJETA del cliente y pulsa «Entregar».
--   5. El sistema registra la entrega.
--
-- El albarán es el documento que acompaña la mercancía y donde queda la firma
-- física. No es el interruptor digital de la entrega, y atarlo a él obligaba al
-- repartidor a tener el cliente delante y el pedido abierto para cerrar algo que
-- en la calle ya estaba hecho.
--
-- ── QUÉ CAMBIA ─────────────────────────────────────────────────────────────
--
-- La entrega deja de exigir una IMAGEN de firma y pasa a exigir una
-- CONFIRMACIÓN: quién la hizo, cuándo y por qué vía. Es una prueba distinta y
-- más útil para un reparto: la firma en papel no está en el sistema, pero sí
-- está la persona que lo confirmó.
--
-- La firma en imagen NO se borra: si existe (por ejemplo, si algún día se
-- fotografía el papel firmado), se sigue guardando y sigue valiendo. Solo deja
-- de ser obligatoria.

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS confirmed_via  TEXT
    CHECK (confirmed_via IS NULL OR confirmed_via IN ('TARJETA_QR','ALBARAN','MANUAL')),
  ADD COLUMN IF NOT EXISTS confirmed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS albaran_id    INTEGER REFERENCES albaranes(id) ON DELETE SET NULL;

COMMENT ON COLUMN deliveries.confirmed_via IS
  'TARJETA_QR: el repartidor lo confirmó escaneando la tarjeta del cliente. Es el camino normal.';
COMMENT ON COLUMN deliveries.confirmed_by IS
  'Quién confirmó la entrega. Antes solo constaba la firma; ahora consta la persona, que es lo que se pregunta cuando un cliente dice que no recibió nada.';
COMMENT ON COLUMN deliveries.albaran_id IS
  'Albarán que acompaña este viaje. Puede ser NULL: puede que el papel no llegara a imprimirse, o que se haya perdido.';

-- El albarán es una REFERENCIA, no un requisito: la entrega se puede confirmar
-- aunque no se llegara a imprimir el papel.
CREATE INDEX IF NOT EXISTS idx_deliveries_albaran ON deliveries (albaran_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_confirm ON deliveries (confirmed_by, confirmed_at);

-- ── La firma deja de ser obligatoria ────────────────────────────────────────
--
-- El disparador `fn_entrega_exige_firma` exigía `signature_id` para poder dejar
-- una entrega en DELIVERED. Se sustituye por una exigencia que describe lo que
-- REALMENTE va a pasar: o hay firma, o hay una confirmación de una persona
-- identificada. Nunca las dos cosas a cero.

ALTER TABLE deliveries ALTER COLUMN signature_id DROP NOT NULL;

DROP TRIGGER IF EXISTS trg_entrega_exige_firma ON deliveries;
DROP FUNCTION IF EXISTS fn_entrega_exige_firma();

CREATE OR REPLACE FUNCTION fn_entrega_exige_confirmacion() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'DELIVERED' THEN
    IF NEW.signature_id IS NULL
       AND (NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL) THEN
      RAISE EXCEPTION
        'ENTREGA_SIN_CONFIRMACION: no se puede cerrar la entrega % sin saber quién la confirmó y cuándo.',
        COALESCE(NEW.code, NEW.id::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entrega_exige_confirmacion
  BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION fn_entrega_exige_confirmacion();

COMMENT ON FUNCTION fn_entrega_exige_confirmacion() IS
  'Una entrega necesita una firma O una confirmación con autor y fecha. Lo que no puede es cerrarse sin dejar rastro de quién lo hizo.';

-- ── Un pedido, una entrega ─────────────────────────────────────────────────
--
-- Refuerza que el mismo pedido no se entregue dos veces por dos caminos. El
-- motor ya lo comprueba, pero aquí se cierra también por debajo, para que un
-- INSERT directo por SQL no lo esquive.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_entrega_por_pedido_confirmada
  ON deliveries (sales_order_id)
  WHERE status = 'DELIVERED' AND confirmed_at IS NOT NULL;

COMMENT ON INDEX uniq_entrega_por_pedido_confirmada IS
  'Un pedido no puede tener dos entregas confirmadas, aunque alguien escriba por SQL saltándose la API.';

