-- ══════════════════════════════════════════════════════════════════════════════
-- 053 · LAS REGLAS QUE YA EXISTÍAN NO EMPIEZAN HOY
--
-- La 052 añadió `vigente_desde date NOT NULL DEFAULT CURRENT_DATE`. Para una
-- regla NUEVA ese valor es lo correcto: empieza a contar hoy. Para las cuatro
-- reglas que ya llevaban meses puntuando es un falsehood: las dejó contando
-- desde hoy, así que las seis visitas existentes —de fechas anteriores— dejaron
-- de contar y el ranking general pasó a cero sin decir por qué.
--
-- Esto NO es un bug de las reglas: es un bug de la fecha por defecto.
--
-- Para el motor, `vigente_desde` a NULL significa «manda desde que existe», que
-- es lo que Wanted decir «sin límite inferior». Se DECLARE nullable, y las
-- reglas heredadas se dejan en NULL. Su historia se conserva entera, que es lo
-- único razonable: nadie ha hecho nada malo en septiembre.
--
-- Las reglas CREADAS a partir de ahora sí llevan fecha, porque una regla que
-- se crea hoy no debe pagar puntos por lo que pasó antes de existir.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE com_reglas_puntos ALTER COLUMN vigente_desde DROP NOT NULL;

-- Las cuatro heredadas: sin límite inferior.
UPDATE com_reglas_puntos SET vigente_desde = NULL
 WHERE code IN ('por_visita','por_pedido','por_cliente','cumple_objetivo')
   AND created_at < now();

COMMENT ON COLUMN com_reglas_puntos.vigente_desde IS
  'NULL = la regla manda desde que existe (reglas heredadas). Con fecha = solo '
  'puntúa hechos posteriores. Editar una regla NUNCA reescribe lo ya concedido.';
