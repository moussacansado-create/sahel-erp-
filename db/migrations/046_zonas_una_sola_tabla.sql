-- ══════════════════════════════════════════════════════════════════════════════
-- 046 · UNA SOLA TABLA DE ZONAS POR COMERCIAL
--
-- ── EL ERROR ────────────────────────────────────────────────────────────────
--
-- La 044 creó `com_perfil_zonas` para guardar «qué zonas lleva un comercial».
-- ESA TABLA YA EXISTÍA: `com_comercial_zonas`, desde la 028, con doce filas de
-- datos de verdad, y el mapa de la pantalla de Comerciales ya la leía. Creé una
-- segunda en lugar de usar la primera, que es justo lo que no había que hacer.
--
-- No se ha perdido nada porque `com_perfil_zonas` estaba vacía. Pero habería
-- bastado con un momento de mirar antes de escribir.
--
-- ── LA CORRECCIÓN ───────────────────────────────────────────────────────────
--
-- Se abandona `com_perfil_zonas` y todo vuelve a `com_comercial_zonas`, que es
-- la que tiene la información de más: `es_principal`, `porcentaje`, `desde` y
-- `hasta`. Lo que aporta mi tabla —`es_base`— ya está ahí como `es_principal`.
--
-- ── LOS DUPLICADOS ──────────────────────────────────────────────────────────
--
-- Salieron al mirar los datos: el comercial 1 tenía Bamako cuatro veces. La
-- clave única es `(comercial_id, zona_id, desde)`, así que la MISMA pareja
-- podía repetirse en días distintos. Cuatro filas, un comercial, una zona.
--
-- Para un ranking, cuatro filas son cuatro zonas, o una zona cuatro veces,
-- según la consulta que las dos están mal y las dos cosas están mal. Aquí se conserva
-- solo la más antigua de cada pareja, que es la que se puso, y se avisa.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1 · Las vistas que se apoyan en la tabla mala. Se caen antes que ella: ──
-- ── tirar una tabla que una vista usa deja la vista colgada sin avisar. ──────
DROP VIEW IF EXISTS v_comercial_zona;
DROP VIEW IF EXISTS v_mapa_zona;

-- ── 2 · La tabla que no debía existir. Estaba vacía: no se copia nada. ───────
DROP TABLE IF EXISTS com_perfil_zonas;

-- ── 3 · Duplicados: una fila por pareja comercial↔zona mientras siga abierta ─
-- Se dice CUALES se quitan, en voz alta, antes de quitarlas.
DO $$
DECLARE sobra int;
BEGIN
  SELECT count(*) INTO sobra FROM (
    SELECT comercial_id, zona_id
      FROM com_comercial_zonas
     WHERE hasta IS NULL
     GROUP BY comercial_id, zona_id HAVING count(*) > 1
  ) t;

  IF sobra > 0 THEN
    RAISE NOTICE 'Hay % zona(s) repetidas; se queda la mas antigua de cada una.', sobra;
  END IF;

  DELETE FROM com_comercial_zonas a
   USING com_comercial_zonas b
   WHERE a.comercial_id = b.comercial_id
     AND a.zona_id = b.zona_id
     AND a.hasta IS NULL AND b.hasta IS NULL
     AND (a.id > b.id);
END $$;

-- ── 4 · Que no vuelva a pasar ───────────────────────────────────────────────
-- Índice único sobre las ASIGNACIONES VIVAS. Uno puede tener la misma zona
-- repartida en dos periodos distintos (la de enero y la de marzo), pero no dos
-- vivas a la vez: eso no es un histórico, es un fallo de dedo.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comercial_zona_viva
  ON com_comercial_zonas (comercial_id, zona_id)
  WHERE hasta IS NULL;

-- ── 5 · Las vistas, otra vez, pero sobre la tabla buena ────────────────────
CREATE OR REPLACE VIEW v_comercial_zona AS
SELECT
  p.id AS perfil_id, p.user_id, u.username, u.full_name, u.email, p.phone,
  c.zona_id,
  z.code AS zona_code, z.name AS zona_name, z.kind AS zona_kind, z.nivel AS zona_nivel,
  z.latitude, z.longitude,
  c.es_principal AS zona_principal,
  (c.hasta IS NULL) AS zona_activa,
  COALESCE(cc.clientes, 0) AS clientes_en_zona
FROM com_comercial_zonas c
JOIN com_perfiles p ON p.id = c.comercial_id
JOIN users u ON u.id = p.user_id
JOIN com_zonas z ON z.id = c.zona_id
LEFT JOIN (
  SELECT comercial_id, zone_id, count(*)::int AS clientes
    FROM customers WHERE comercial_id IS NOT NULL AND is_active
   GROUP BY comercial_id, zone_id
) cc ON cc.comercial_id = c.comercial_id AND cc.zone_id = c.zona_id
WHERE c.hasta IS NULL;

CREATE OR REPLACE VIEW v_mapa_zona AS
SELECT
  z.id, z.code, z.name, z.kind, z.nivel, z.parent_id,
  z.latitude, z.longitude, z.is_active,
  COALESCE(cc.clientes, 0) AS clientes,
  COALESCE(cc.con_comercial, 0) AS clientes_con_comercial,
  pz.perfil_id AS responsable_id,
  pz.u_username AS responsable_usuario,
  pz.u_nombre AS responsable_nombre,
  pz.u_email AS responsable_email
FROM com_zonas z
LEFT JOIN (
  SELECT zone_id, count(*)::int AS clientes, count(comercial_id)::int AS con_comercial
    FROM customers WHERE is_active AND zone_id IS NOT NULL GROUP BY zone_id
) cc ON cc.zone_id = z.id
LEFT JOIN (
  SELECT c.zona_id, p.id AS perfil_id, u.username AS u_username,
         u.full_name AS u_nombre, u.email AS u_email
    FROM com_comercial_zonas c
    JOIN com_perfiles p ON p.id = c.comercial_id AND p.is_active
    JOIN users u ON u.id = p.user_id
   WHERE c.hasta IS NULL
     AND c.es_principal
     AND NOT EXISTS (
       SELECT 1 FROM com_comercial_zonas o
        WHERE o.zona_id = c.zona_id AND o.hasta IS NULL AND o.id < c.id)
) pz ON pz.zona_id = z.id;
