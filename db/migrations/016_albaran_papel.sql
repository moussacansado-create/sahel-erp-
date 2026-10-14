-- ─────────────────────────────────────────────────────────────────────────────
-- EL ALBARÁN ES PAPEL. EL ESTADO LO LLEVA LA ENTREGA.
--
-- Dos restricciones de la tabla `albaranes` nacieron de un diseño que ya no
-- existe. Decían:
--
--   albaran_delivered_exige_firma_y_fecha  → para estar entregado, necesita firma
--   albaran_entregar_despues_firmar        → no se entrega sin estar firmado
--
-- Las dos vienen de cuando el albarán era el que cerraba la entrega, y había
-- que dibujar en la aplicación la firma de quien recibía.
--
-- AHORA EL REPARTO ES OTRO:
--
--   1. El repartidor lleva la mercancía y el albarán.
--   2. El cliente FIRMA EN PAPEL y se lleva su copia.
--   3. El repartidor escanea la TARJETA y pulsa «Entregar».
--   4. En ese momento, y solo en ese, queda registrada la entrega.
--
-- El papel está con el cliente. En el sistema no hay ninguna firma que
-- comprobar, y exigirla obligaría al repartidor a hacer en el móvil, delante de
-- la puerta, un dibujo que ya está en papel.
--
-- LO QUE NO CAMBIA: el albarán sigue sin decidir nada. Estas restricciones
-- hablan solo de `albaranes`. El estado del pedido lo escribe la entrega, y
-- solo la entrega. Imprimir el albarán NO cierra un pedido, ni antes ni después.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE albaranes DROP CONSTRAINT IF EXISTS albaran_delivered_exige_firma_y_fecha;
ALTER TABLE albaranes DROP CONSTRAINT IF EXISTS albaran_entregar_despues_firmar;

-- Lo único que se sigue exigiendo es que la fecha de entrega exista: un
-- albarán sin fecha no puede decir que volvió firmado.
ALTER TABLE albaranes ADD CONSTRAINT albaran_delivered_exige_fecha
  CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL);
