-- ══════════════════════════════════════════════════════════════════════════════
-- 044 · CLIENTE → ZONA → COMERCIAL, CONTADO DESDE LA BASE
--
-- La cadena que hacia falta para que el mapa y el ranking no dependan de
-- números escritos a mano:
--
--     comercial  ──< com_perfil_zonas >──  zona  <──  cliente  >──  comercial
--
-- ── POR QUÉ UNA TABLA NUEVA Y NO REUSAR `com_perfiles.home_zona_id` ──────────
--
-- `home_zona_id` es UN solo identificador. Un comercial que trabaja en cuatro
-- zonas no cabe en una columna, y el día que haga falta, la única forma de
-- meter la segunda es duplicar el perfil. `com_perfil_zonas` es un conjunto, y
-- `home_zona_id` se queda como lo que es: dónde está basedado.
--
-- ── POR QUÉ `customers.zone_id` Y `comercial_id` SIGUEN SIENDO OPCIONALES ─────
--
-- Porque hoy los catorce clientes están sin zona, y trece además sin comercial.
-- Ponerlos obligatorios ahora sería mentir sobre el estado real: o se inventa
-- una relación que nadie ha decidido, o la migración falla. Así que la
-- obligatoriedad se activa cuando estén asignados de verdad, y mientras tanto
-- los clientes sin asignar se VEN como tales —con su propio contador— en lugar
-- de repartirse entre los comerciales para que las cifras cuadren.
--
-- ── CONTADORES ───────────────────────────────────────────────────────────────
--
-- `com_zonas.clientes_potenciales` es un número que alguien escribe a mano. Un
-- contador que se escribe no es un contador: se queda viejo sin que nadie se
-- entere, y un ranking construido sobre eso no vale. Las vistas de aquí lo
-- cuentan con `COUNT` sobre las filas de verdad, y por eso no se pueden
-- falsear desde la aplicación.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Las zonas que un comercial tiene autorizadas ─────────────────────────────
CREATE TABLE IF NOT EXISTS com_perfil_zonas (
  perfil_id   INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  zona_id     INTEGER NOT NULL REFERENCES com_zonas(id) ON DELETE RESTRICT,
  es_base     BOOLEAN NOT NULL DEFAULT FALSE,
  asignado_por INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (perfil_id, zona_id)
);

CREATE INDEX IF NOT EXISTS idx_perfil_zonas_zona ON com_perfil_zonas (zona_id);

-- Una zona no puede estar en la lista de dos comerciales a la vez mientras
--  siga siendo «el responsable». Esto NO obliga a que la haya: un comercial
-- puede tener cero zonas y quedarse sin clientes, que es la situacion honesta
-- de un perfil recien creado. El responsable unico por zona se decide en la
-- migracion siguiente, cuando haya zonas que repartir de verdad.
--
-- (Nota: la restriccion de unicidad por zona se anade DESPUES de repartir, para
--  no tener que deshacerla si dos responsables coinciden en la misma zona.)

-- ── Un comercial, sus zonas, y cuantos clientes tiene en cada una ───────────
CREATE OR REPLACE VIEW v_comercial_zona AS
SELECT
  p.id                AS perfil_id,
  p.user_id,
  u.username,
  u.full_name,
  u.email,
  COALESCE(pz.zona_id, p.home_zona_id) AS zona_id,
  z.code              AS zona_code,
  z.name              AS zona_name,
  z.kind              AS zona_kind,
  z.nivel             AS zona_nivel,
  z.latitude,
  z.longitude,
  (pz.perfil_id IS NOT NULL) AS zona_autorizada,
  COALESCE(cc.clientes, 0)   AS clientes_en_zona
FROM com_perfiles p
JOIN users u ON u.id = p.user_id
LEFT JOIN com_perfil_zonas pz ON pz.perfil_id = p.id
LEFT JOIN com_zonas z ON z.id = COALESCE(pz.zona_id, p.home_zona_id)
LEFT JOIN (
  SELECT comercial_id, zone_id, count(*)::int AS clientes
    FROM customers
   WHERE comercial_id IS NOT NULL AND is_active
   GROUP BY comercial_id, zone_id
) cc ON cc.comercial_id = p.id AND cc.zone_id = COALESCE(pz.zona_id, p.home_zona_id);

-- ── Zonas de la estructura, con lo que de verdad tienen encima ──────────────
CREATE OR REPLACE VIEW v_mapa_zona AS
SELECT
  z.id,
  z.code,
  z.name,
  z.kind,
  z.nivel,
  z.parent_id,
  z.latitude,
  z.longitude,
  z.is_active,
  COALESCE(cc.clientes, 0)      AS clientes,
  COALESCE(cc.con_comercial, 0)  AS clientes_con_comercial,
  pz.perfil_id                   AS responsable_id,
  pz.u_username                  AS responsable_usuario,
  pz.u_nombre                    AS responsable_nombre,
  pz.u_email                     AS responsable_email
FROM com_zonas z
LEFT JOIN (
  SELECT zone_id, count(*)::int AS clientes, count(comercial_id)::int AS con_comercial
    FROM customers WHERE is_active AND zone_id IS NOT NULL GROUP BY zone_id
) cc ON cc.zone_id = z.id
LEFT JOIN (
  SELECT pz.zona_id, p.id AS perfil_id, u.username AS u_username,
         u.full_name AS u_nombre, u.email AS u_email
    FROM com_perfil_zonas pz
    JOIN com_perfiles p ON p.id = pz.perfil_id AND p.is_active
    JOIN users u ON u.id = p.user_id
) pz ON pz.zona_id = z.id;

-- ── El reparto de carteras, con los sin asignar aparte ──────────────────────
-- Un comercial no puede quedarse clientes que no son suyos, y los que no
-- tienen dueño no pueden sumar a nadie. Por eso «sin asignar» es una fila más
-- del informe y no un cero escondido en la última cartera.
CREATE OR REPLACE VIEW v_cartera_comercial AS
SELECT
  COALESCE(c.comercial_id, 0)   AS comercial_id,
  COALESCE(u.username, '(sin asignar)')  AS username,
  COALESCE(u.full_name, 'Clientes sin comercial asignado')    AS nombre,
  (c.comercial_id IS NULL)      AS sin_asignar,
  count(*)::int                  AS clientes,
  count(*) FILTER (WHERE c.is_active)::int AS clientes_activos
FROM customers c
LEFT JOIN com_perfiles p ON p.id = c.comercial_id
LEFT JOIN users u ON u.id = p.user_id
GROUP BY c.comercial_id, u.username, u.full_name;
