-- ══════════════════════════════════════════════════════════════════════════════
-- 058 · LAS SERIES DE PRODUCTO ARRANCAN EN 1; LA DE ENTRADAS, NO
--
-- La 057 sembró las series de producto con el contador viejo (`LOTE:DES` = 5,
-- `LOTE:LAV` = 12) y `anio` a NULL. Al primer uso la función vio que el año no
-- era 2026 y debería haber reiniciado… pero la fila ya tenía `anio = 2026` de
-- las pruebas de la 056, así que no reinició y el primer lote de la serie
-- nueva salió `LAV-2026-000013`.
--
-- Eso está mal, y no por el formato: esos 12 belonged a la época en que el
-- código NO llevaba año (`PT-LAV-00012`). `LAV-2026` es una serie NUEVA, y una
-- serie nueva empieza en 000001. Si empezara en 13, el inventario tendría un
-- hueco del 1 al 12 que nunca existió, y nadie sabría si se perdieron lotes o
-- nunca se hicieron.
--
-- ── POR QUÉ ENTRADAS NO ─────────────────────────────────────────────────────
--
-- Porque `entrada_no` SÍ está en uso: va del 1001 al 1166 y tiene índice
-- ÚNICO. Poner el contador a cero haría que la siguiente entrada repitiera un
-- número que ya identifica a un lote existente, que es justo lo que el
-- ejercicio pide que no pase («los números ya utilizados nunca se reasignan»).
--
-- Así que ENTRADAS sigue desde 1166, y se le fija el año para que no reinicie.
--
-- Las series de DOCUMENTO (`PED`, `ALB`, `FAB`) no se tocan: llevan año desde
-- siempre y sus números están en uso de verdad.
-- ══════════════════════════════════════════════════════════════════════════════

-- Productos: serie nueva de este ejercicio, desde el principio.
UPDATE config_series SET ultimo_valor = 0, anio = NULL
 WHERE clase = 'PRODUCTO';

-- Entradas: el contador NO baja, pero se ancla al año en curso para que la
-- serie no se reinicie sola al cambiar de ejercicio.
UPDATE config_series
   SET anio = COALESCE((SELECT (value #>> '{}')::integer FROM app_config
                         WHERE key = 'numeracion.anio_activo'),
                       EXTRACT(YEAR FROM CURRENT_DATE)::integer)
 WHERE clase = 'ENTRADA'
   AND ultimo_valor > 0;

-- El histórico de ejercicio de esas dos clases era de las pruebas anteriores.
DELETE FROM config_series_ejercicio
 WHERE serie IN (SELECT codigo FROM config_series WHERE clase IN ('PRODUCTO', 'ENTRADA'));
