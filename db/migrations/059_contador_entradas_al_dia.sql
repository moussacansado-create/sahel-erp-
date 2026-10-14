-- ══════════════════════════════════════════════════════════════════════════════
-- 059 · EL CONTADOR DE ENTRADAS NO PUEDE QUEDAR POR DEBAJO DE LO EMITIDO
--
-- La 058 dejó la serie `ENT` en 1 cuando ya se habían emitido entradas hasta
-- la 1166. La siguiente habría recibido la 2: un número que no existe, pero
-- que deja un hueco del 1001 al 1166 en el numerario, y sobre todo rompe la
-- garantía de que «los números ya utilizados nunca se reasignan».
--
-- La garantía aquí no es teórica: `lots.entrada_no` tiene índice ÚNICO, así que
-- el día que la serie alcance la 1001 la entrada sería RECHAZADA por la base y
-- la recepción fallaría. Un fallo de numeración que solo aparece mil receipts
-- después es exactamente el tipo de cosa que hay que arreglar antes.
--
-- Aquí se pone el contador donde le toca. A partir de aquí la serie `ENT` solo
-- SUBE, y `app_config.numeracion.anio_activo` es lo único que puede reiniciar
-- una serie, con su cambio de año explícito y auditado.
-- ══════════════════════════════════════════════════════════════════════════════
UPDATE config_series
   SET ultimo_valor = GREATEST(
         ultimo_valor,
         COALESCE((SELECT MAX(entrada_no) FROM lots WHERE entrada_no IS NOT NULL), 0))
 WHERE codigo = 'ENT';
