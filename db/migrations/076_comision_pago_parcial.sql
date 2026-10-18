-- ═══════════════════════════════════════════════════════════════════════════
-- 076 · UN PAGO PARCIAL NO ES UN ERROR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- La 075 puso esta restricción:
--
--   estado = 'PAGADA'  →  pagado_importe, pagado_en y pagado_por puestos
--   estado <> 'PAGADA' →  pagado_importe y pagado_en a NULL
--
-- Y eso PROHÍBE el pago parcial. Un comercial al que se le pagan 30.000 de
-- una comisión de 50.000 queda en «confirmada, pendiente de pago» con
-- 30.000 pagados: la segunda mitad de la restricción dice que `pagado_importe`
-- tiene que ser NULL, y no lo es. La base rechaza el pago con un 500 mudo.
--
-- La idea que había detrás no era mala: «no se está pagado sin fecha». Pero
-- confundió dos cosas que son distintas:
--
--   · el ESTADO   → si la comisión está pagada o pendiente
--   · lo PAGADO   → cuánto se le ha entregado ya, y cuándo fue la última vez
--
-- Un pago parcial es lo pagado > 0 con el estado todavía pendiente. No es un
-- estado imposible: es un estado NORMAL, y hasta lo más corriente, porque
-- las comisiones se pagan a plazos.
--
-- LA RESTRICCIÓN CORRECTA
--
--   · 'PAGADA'                     → hay importe, fecha y responsable
--   · 'CONFIRMADA_PENDIENTE_PAGO'  → lo pagado puede ser 0 o una parte; si
--                                    es 0, no hay ni fecha ni responsable
--   · lo pagado nunca supera lo confirmado
--
-- Y el dinero: lo que se ha pagado son los pagos SUMADOS, no un campo que
-- alguien pueda escribir a mano. Por eso el total se recalcula desde
-- `com_comision_pagos` en cada pago, y la fila guarda la última fecha.
--
-- La 075 NO se toca. Las migraciones aplicadas son inmutables: esto es una
-- migración nueva que corrige la restricción.
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE com_comisiones DROP CONSTRAINT IF EXISTS com_comision_pago_completo;

ALTER TABLE com_comisiones ADD CONSTRAINT com_comision_pago_completo CHECK (
  (
    estado = 'PAGADA'
    AND pagado_importe IS NOT NULL AND pagado_en IS NOT NULL AND pagado_por IS NOT NULL
  )
  OR
  (
    estado <> 'PAGADA'
    AND (pagado_importe IS NULL OR (pagado_en IS NOT NULL AND pagado_por IS NOT NULL))
  )
);

COMMENT ON CONSTRAINT com_comision_pago_completo ON com_comisiones IS
  'Pagada exige importe, fecha y responsable. Pendiente de pago admite importes parciales: si se ha pagado algo, tiene fecha y responsable. Un pago parcial NO es un estado invalido.';

-- Y el dinero pagado no puede pasar de lo confirmado.
ALTER TABLE com_comisiones DROP CONSTRAINT IF EXISTS com_comision_no_paga_de_mas;
ALTER TABLE com_comisiones ADD CONSTRAINT com_comision_no_paga_de_mas CHECK (
  comision_confirmada IS NULL
  OR pagado_importe IS NULL
  OR pagado_importe <= comision_confirmada + 0.001
);

COMMENT ON CONSTRAINT com_comision_no_paga_de_mas ON com_comisiones IS
  'Lo pagado no puede superar lo confirmado. La comision es una cantidad, no una bolsa sin fondo.';
