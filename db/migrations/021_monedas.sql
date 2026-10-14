-- ═══════════════════════════════════════════════════════════════════════════
-- 021 · LAS MONEDAS SON CONFIGURACIÓN, NO CONTENIDO DE DEMOSTRACIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ ESTÁ MAL
--
-- La tabla `currencies` —que declara cuál es la moneda base y cuánto vale
-- cada una— se llenaba desde `server/src/db/semillas.js`, que es el archivo de
-- DATOS DE DEMOSTRACIÓN.
--
-- Se llevaba puesto de serie lo que se le echaba, y pasaba lo que tenía que pasar:
-- en una instalación de verdad, sin datos de prueba, la tabla `currencies`
-- estaba VACÍA. Sin moneda base declarada, sin el catálogo de monedas, y sin
-- una tasa con la que emitir un documento.
--
-- No es un detalle: es que el sistema no puede funcionar sin decidir en qué
-- moneda está. Un euro, un franco y un color de botón no son lo mismo, aunque
-- los dos primeros se guarden en tablas parecidas.
--
-- LA DIFERENCIA QUE IMPORTA
--
--   datos de demostración → lo que hay en el ordenador de quien demuestra
--   configuración          → lo que la empresa necesita para funcionar
--
-- Sahel's monedas y su moneda base son lo segundo. Los artículos de ejemplo, el
-- cliente de prueba y la contraseña `demo1234` son lo primero.
--
-- ───────────────────────────────────────────────────────────────────────────
-- EL CATÁLOGO
-- ───────────────────────────────────────────────────────────────────────────
--
-- Solo se añaden las dos con las que se trabaja. Se pueden añadir más después
-- sin más que INSERT: la tabla está hecha para crecer, y el CHECK del código
-- ISO no obliga a pasar por una migración para cada moneda nueva.
--
INSERT INTO currencies (code, name, symbol, rate_to_base, is_base) VALUES
  ('XOF', 'Franco CFA (BCEAO)',  'FCFA', 1.000000, TRUE),
  ('EUR', 'Euro',                '€',    655.957000, FALSE)
ON CONFLICT (code) DO NOTHING;

-- La moneda base es UNA, y el índice único `uniq_currency_base` ya lo impide
-- por la vía dura. Aquí solo se deja constancia de cuál es, por si algún día
-- se cambia: se desmarca la anterior y se marca esta, en ese orden, que es el
-- único en que se puede hacer.
UPDATE currencies SET is_base = (code = 'XOF');

-- ───────────────────────────────────────────────────────────────────────────
-- LA TASA DE PARTIDA
-- ───────────────────────────────────────────────────────────────────────────
--
-- La migración 020 intentó copiar aquí la tasa que ya traía `currencies`, y se
-- quedó sin copiar NADA: en ese momento la tabla estaba vacía, y una sentencia
-- `INSERT ... SELECT` sobre una tabla vacía no falla. Falla en silencio, que es
-- la peor forma: la migración se aplicaba «bien» y no dejaba ninguna tasa.
--
-- Por eso va aquí, después de que las monedas existan.
--
INSERT INTO exchange_rates (from_code, to_code, rate, effective_from, source, note)
SELECT 'EUR', 'XOF', rate_to_base, CURRENT_DATE, 'CATALOGO',
       'Tasa de partida: la de currencies.rate_to_base en el momento del despliegue.'
  FROM currencies
 WHERE code = 'EUR'
   AND NOT EXISTS (SELECT 1 FROM exchange_rates
                    WHERE from_code = 'EUR' AND to_code = 'XOF');

-- ───────────────────────────────────────────────────────────────────────────
-- LO QUE ESTO HACE QUE NO SE PUEDA EVADIR
-- ───────────────────────────────────────────────────────────────────────────
--
-- El bloqueo de verdad lo pone `tasaEn()`, en `core/dinero.js`: si un
-- documento se emite en una fecha sin tasa, la emisión falla en vez de
-- inventarse una cifra. Y `currencies` ahora sale de una migración, no de un
-- archivo de demostración, así que una instalación real llega aquí con sus dos
-- monedas y su tasa de partida.
--
-- Que la primera línea de la migración 020 no llegara a insertar nada fue
-- justo el aviso: un `INSERT ... SELECT` sobre una tabla vacía no da error,
-- se limita a no hacer nada, y la migración «pasa». Lo que falla en silencio
-- no se arregla con un `RAISE`, sino glmponiendo el dato donde tiene que estar
-- antes de necesitarlo.
