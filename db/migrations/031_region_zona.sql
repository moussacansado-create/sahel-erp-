-- ═════════════════════════════════════════════════════════════════════════════
-- 031 · EL NIVEL QUE FALTA: REGIÓN → ZONA
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LO QUE ESTA MIGRACIÓN NO HACE, Y ES LO MÁS IMPORTANTE
--
-- No crea ninguna zona. No inventa nombres. No toca los nueve polígonos, ni el
-- mapa, ni el ranking, ni las ventas, ni las visitas, ni el stock.
--
-- Añade la ESTRUCTURA para que un cliente pueda acabar en «Kayes ciudad» y no
-- solo en «Kayes», y nada más. Las zonas las crea quien lleva el negocio,
-- porque los nombres de las zonas de un sitio los sabe quien está en el
-- sitio, no quien escribe la migración.
--
-- Es lo mismo que con la población: un hueco vale más que un cero inventado.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ UNA COLUMNA Y NO OTRA TABLA
--
-- Porque `com_zonas` YA tiene `parent_id` apuntándose a sí misma. La
-- jerarquía siempre estuvo permitida en el esquema; lo que no había eran filas
-- hijas. Una tabla nueva habría significado dos sitios donde vive lo mismo,
-- y hoy ya sabemos lo que cuesta eso: el día que las dos no coincidan, el
-- mapa enseña una cosa y el ranking otra.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- SOLO DOS NIVELES, Y ES A PROPÓSITO
--
-- Región → Zona. Ni una más.
--
-- Con tres niveles habría que decidir qué cuenta como «zona» en el mapa, y qué
-- comercial responde de qué. Con dos, la pregunta no existe: una zona cuelga
-- de una región y hay un comercial responsable por zona. Cuando haga falta un
-- tercer nivel —un distrito dentro de la ciudad— se decide con datos reales,
-- no ahora con un dibujo en un papel.
--
-- La regla se pone en la BASE y no en el código: si algún día un script se
-- pasa de creativo y cuelga una zona de otra zona, la base le dice que no, que
-- en JavaScript se lo permitiría sin avisar.
--
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1 · QUÉ NIVEL ES CADA ZONA ──────────────────────────────────────────────
--
-- `nivel` es una columna DICE, no se deduce de si tiene padre. Con una fila sin
-- padre puede pasar de ser «la única zona de esta región» a ser «una región
-- más» —un cambio de negocio— y eso tiene que verse, no deducirse.
--
ALTER TABLE com_zonas
  ADD COLUMN IF NOT EXISTS nivel TEXT NOT NULL DEFAULT 'REGION';

ALTER TABLE com_zonas
  ADD CONSTRAINT com_zona_nivel_valido
  CHECK (nivel IN ('REGION', 'ZONA'));

-- Los nueve que ya existían son regiones. Se dice EXPLÍCITAMENTE, y no se deja
-- que el DEFAULT haga el trabajo en silencio: dentro de un año nadie sabrá si
-- aquello fue una decisión o un olvido.
UPDATE com_zonas
   SET nivel = CASE WHEN parent_id IS NULL THEN 'REGION' ELSE 'ZONA' END
 WHERE nivel IS DISTINCT FROM CASE WHEN parent_id IS NULL THEN 'REGION' ELSE 'ZONA' END;

-- Una ZONA cuelga de una región. Una REGIÓN, de nada. Lo contrario no tiene
-- sentido en un sistema de dos niveles, y dejarlo pasar convierte el mapa en
-- un árbol sin raíz.
ALTER TABLE com_zonas
  ADD CONSTRAINT com_zona_nivel_coherente CHECK (
    (nivel = 'REGION' AND parent_id IS NULL)
 OR (nivel = 'ZONA'   AND parent_id IS NOT NULL)
  );

-- ─── 2 · UNA ZONA CUELGA DE UNA REGIÓN, NO DE OTRA ZONA ─────────────────────
--
-- Se comprueba con una condición que PostgreSQL pueda evaluar, porque el
-- `parent_id` apunta a otra fila de la MISMA tabla y el CHECK no puede mirar
-- hacia dentro. Lo que sí puede es decidir con lo que ya trae.
--
-- La regla fuerte —«la zona de una zona tiene que ser REGION»— se comprueba
-- en `fn_region_de()`, que sí puede mirar la fila padre. Aquí se pone la
-- parte que se puede: una zona tiene padre, y no se puede colgar de sí misma
-- (que ya estaba, pero se repite para que quede a la vista).
--
ALTER TABLE com_zonas
  ADD CONSTRAINT com_zona_no_es_una_zona CHECK (
    nivel <> 'ZONA' OR parent_id <> id
  );

-- Índice para cuando se pregunte «qué zonas tiene esta región», que es la
-- pregunta más frecuente de toda la pantalla y sin índice es un recorrido.
CREATE INDEX IF NOT EXISTS idx_com_zonas_padre_nivel
  ON com_zonas(parent_id, nivel) WHERE nivel = 'ZONA';

-- ─── 3 · DE QUÉ REGIÓN ES ESTA ZONA ──────────────────────────────────────────
--
-- Una zona cuelga de una región. Y una región… es una región. Nunca hay que
-- subir más de un nivel, y por eso esta función no tiene bucle: dos saltos y
-- fuera. Si algún día el esquema admite tres niveles, esta función empezaría a
-- mentir y habría que reescribirla; que no lo haga hoy es parte del contrato.
--
CREATE OR REPLACE FUNCTION fn_region_de(p_zona_id INT)
RETURNS INT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_nivel   TEXT;
  v_padre   INT;
BEGIN
  IF p_zona_id IS NULL THEN RETURN NULL; END IF;

  SELECT nivel, parent_id INTO v_nivel, v_padre
    FROM com_zonas WHERE id = p_zona_id;

  -- Una zona inexistente no es una región: se devuelve NULL y quien llama lo
  -- comprueba. Devolver la propia zona «por si acaso» escondería el fallo.
  IF v_nivel IS NULL THEN RETURN NULL; END IF;

  IF v_nivel = 'REGION' THEN RETURN p_zona_id; END IF;

  RETURN v_padre;
END;
$$;

COMMENT ON FUNCTION fn_region_de(INTEGER) IS
  'Región a la que pertenece una zona. Si es una región, ella misma. NULL si no existe.';

-- ─── 4 · LAS ZONAS DE UNA REGIÓN ─────────────────────────────────────────────
--
-- Lo que la pantalla necesita para llenar el segundo desplegable en cascada.
-- Se lee de la tabla, no se calcula: el desplegable tiene que enseñar lo que
-- hay, no lo que el código cree que debería haber.
--
CREATE OR REPLACE FUNCTION fn_zonas_de(p_region_id INT)
RETURNS TABLE (
  id INT, code TEXT, name TEXT, kind TEXT, nivel TEXT, parent_id INT,
  comerciales BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT z.id, z.code, z.name, z.kind, z.nivel, z.parent_id,
         (SELECT count(*) FROM com_comercial_zonas cz
           WHERE cz.zona_id = z.id AND cz.hasta IS NULL) AS comerciales
    FROM com_zonas z
   WHERE z.parent_id = p_region_id
     AND z.is_active
   ORDER BY z.name;
$$;

-- ─── 5 · LOS COMERCIALES DE UNA ZONA ─────────────────────────────────────────
--
-- El tercer desplegable de la cascada. Cuando el cliente no tenga todavía
-- ningún comercial asignado en esa zona, sale VACÍO — no la lista global.
--
-- Una lista global aquí es el fallo que el documento avisa: alguien asigna a un
-- cliente al comercial de otra zona sin darse cuenta, y tres meses después
-- nadie sabe por qué ese cliente no lo visitationa nadie.
--
CREATE OR REPLACE FUNCTION fn_comerciales_de(p_zona_id INT)
RETURNS TABLE (
  comercial_id INT, user_id INT, username TEXT, full_name TEXT,
  es_principal BOOLEAN, porcentaje NUMERIC, languages TEXT[]
)
LANGUAGE sql STABLE AS $$
  SELECT cp.id, u.id, u.username, u.full_name,
         cz.es_principal, cz.porcentaje,
         COALESCE((SELECT array_agg(m.idioma_code ORDER BY m.idioma_code)
                     FROM com_comercial_idiomas m
                    WHERE m.comercial_id = cp.id), '{}')
    FROM com_comercial_zonas cz
    JOIN com_perfiles cp ON cp.id = cz.comercial_id
    JOIN users u ON u.id = cp.user_id
   WHERE cz.zona_id = p_zona_id
     AND cz.hasta IS NULL
     AND cz.es_principal
     AND cp.is_active
     AND u.is_active
   ORDER BY u.full_name;
$$;

-- ─── 6 · LA ESTRUCTURA ENTERA, DE UNA VEZ ───────────────────────────────────
--
-- Región → Zona → Comercial. Para pintar un árbol sin hacer veinte consultas y
-- para poder comprobar de un vistazo que la estructura está como debe.
--
CREATE OR REPLACE VIEW com_estructura AS
SELECT
  r.id   AS region_id,
  r.code AS region_code,
  r.name AS region_name,
  r.latitude AS region_lat, r.longitude AS region_lng,
  r.poligono AS region_poligono,
  z.id   AS zona_id,
  z.code AS zona_code,
  z.name AS zona_name,
  z.kind AS zona_kind,
  cp.id  AS comercial_id,
  u.id   AS user_id,
  u.username,
  u.full_name,
  cz.es_principal,
  cz.porcentaje,
  -- Los clientes SOLO de esa zona y de ese comercial. Es la casilla del
  -- dibujo, y tiene que ser verdad: un cliente que no sale aquí es un cliente
  -- que no está asignado, no uno que el sistema olvidó contar.
  (SELECT count(*) FROM customers c
    WHERE c.is_active
      AND fn_region_de(c.zone_id) = r.id
      AND c.commercial_id = u.id) AS clientes
FROM com_zonas r
LEFT JOIN com_zonas z ON z.parent_id = r.id AND z.is_active
LEFT JOIN com_comercial_zonas cz ON cz.zona_id = z.id AND cz.hasta IS NULL
LEFT JOIN com_perfiles cp ON cp.id = cz.comercial_id AND cp.is_active
LEFT JOIN users u ON u.id = cp.user_id AND u.is_active
WHERE r.nivel = 'REGION' AND r.is_active
ORDER BY r.name, z.name, u.full_name;

-- ─── 7 · QUE LO QUE HAY SIGA SIENDO LO QUE ES ────────────────────────────────
--
-- Al final se comprueba que la migración no ha cambiado nada de lo que ya
-- funcionaba. Las nueve regiones siguen siendo regiones, con su polígono, y
-- las zonas nuevas cuelgan de una región —de una REGION, con su comprobación—.
--
DO $$
DECLARE
  v_regiones INT;
  v_con_poligono INT;
  v_zonas_huerfanas INT;
  v_zona_de_zona INT;
BEGIN
  SELECT count(*) INTO v_regiones FROM com_zonas WHERE nivel = 'REGION';
  SELECT count(*) INTO v_con_poligono FROM com_zonas WHERE poligono IS NOT NULL;

  -- Una zona colgada de algo que no es una región.
  SELECT count(*) INTO v_zonas_huerfanas
    FROM com_zonas z JOIN com_zonas p ON p.id = z.parent_id
   WHERE z.nivel = 'ZONA' AND p.nivel <> 'REGION';

  SELECT count(*) INTO v_zona_de_zona
    FROM com_zonas z JOIN com_zonas p ON p.id = z.parent_id
   WHERE z.nivel = 'ZONA' AND p.nivel = 'ZONA';

  IF v_regiones <> 9 THEN
    RAISE EXCEPTION 'han quedado % regiones y aveva 9. No se continúa.', v_regiones;
  END IF;

  IF v_zonas_huerfanas > 0 THEN
    RAISE EXCEPTION 'hay % zonas colgadas de algo que no es una región', v_zonas_huerfanas;
  END IF;

  IF v_zona_de_zona > 0 THEN
    RAISE EXCEPTION 'hay % zonas colgadas de otra zona. Solo dos niveles.', v_zona_de_zona;
  END IF;

  RAISE NOTICE 'com_zonas: % regiones con % polígonos, % zonas hijas',
    v_regiones, v_con_poligono,
    (SELECT count(*) FROM com_zonas WHERE nivel = 'ZONA');
END $$;