-- ═════════════════════════════════════════════════════════════════════════════
-- 030 · LOCALIDADES: EL NIVEL QUE FALTA ENTRE LA ZONA Y EL COMERCIAL
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LO QUE NO HACE, Y ES LO MÁS IMPORTANTE
--
-- No toca `com_zonas`, ni `com_perfiles`, ni `com_comercial_zonas`, ni
-- `com_objetivos`, ni nada del ERP. Solo AÑADE dos tablas y una vista.
--
-- La cadena sigue siendo:
--
--     REGIÓN → ZONA → COMERCIAL
--
-- y por debajo, sin romperla:
--
--     REGIÓN → ZONA → LOCALIDAD → COMERCIAL
--
-- Una localidad CUELGA de una zona, no la sustituye. Un comercial que cubre
-- una zona sigue cubriéndola, y ahora además puede tener repartidos los pueblos
-- de dentro entre los varios que la cubren.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LOS DATOS
--
-- 18.073 localidades de OpenStreetMap (ODbL, descarga del 7 de octubre de 2026),
-- con nombre, tipo, población y coordenadas. De 29.382 nodos:
--
--   · 10.887 NO tienen nombre → se descartan. Una localidad sin nombre no se
--     puede identificar ni repartir entre comerciales, y una fila que no se
--     puede leer no sirve para gestionar.
--   · 422 caen FUERA de los nueve polígonos regionales → se cargan CON
--     `region_id = NULL`, NO se reparten a ojo. Están para revisarlas.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ LAS 422 NO SE ASIGNAN
--
-- Un punto cae fuera del polígono porque la frontera de Natural Earth y la de
-- OSM no casan —Mali tiene fronteras en litigio— o porque el polígono está
-- simplificado. Colocarlas «en la región más cercana» sería inventar la
-- pertenencia de un pueblo de verdad, y una localidad mal metida en la región
-- equivocada se lleva por delante a los comerciales que la cubren.
--
-- Se guardan, se ven, y se revisan a mano.
--
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1 · LAS LOCALIDADES ────────────────────────────────────────────────────

CREATE TABLE com_localidades (
  id          SERIAL PRIMARY KEY,
  -- El identificador de OpenStreetMap. Es UNIQUE porque un pueblo es un sitio,
  -- no dos: si se cargara dos veces, un comercial podría tener asignado el
  -- mismo pueblo en dos filas y el reparto contaría de más.
  osm_id      BIGINT NOT NULL UNIQUE,

  nombre      TEXT NOT NULL CHECK (length(btrim(nombre)) >= 2),
  -- 'national_capital' | 'city' | 'town' | 'village' | 'hamlet' |
  -- 'locality' | 'suburb' | 'county' | 'region' | 'farm'
  tipo        TEXT NOT NULL,
  poblacion   INTEGER NOT NULL DEFAULT 0 CHECK (poblacion >= 0),

  latitude    NUMERIC(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   NUMERIC(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),

  -- La REGIÓN a la que pertenece. NULL significa «no se ha podido determinar»,
  -- que es un dato real y distinto de «pertenece a la región X».
  --
  -- Y no lleva clave foránea a propósito: la región se deduce GEOMÉTRICAMENTE
  -- (el punto cae dentro del polígono), y eso no lo puede comprobar una
  -- foreign key. Además, si mañana se corrige un polígono, la localidad se
  -- recalcula sola; si estuviera atada, habría que revisar 18.073 filas a mano.
  region_id   INTEGER REFERENCES com_zonas(id) ON DELETE SET NULL,

  -- La ZONA concreta dentro de la región. También deducida, no escrita a ojo.
  zona_id     INTEGER REFERENCES com_zonas(id) ON DELETE SET NULL,

  -- Por si algún día hay que corregir a mano una que cayó mal.
  revisado    BOOLEAN NOT NULL DEFAULT FALSE,

  fuente      TEXT NOT NULL DEFAULT 'OpenStreetMap ODbL',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_com_localidades_region ON com_localidades(region_id);
CREATE INDEX idx_com_localidades_zona   ON com_localidades(zona_id);
CREATE INDEX idx_com_localidades_tipo   ON com_localidades(tipo);

-- Para el mapa: las que están sin asignar, que es lo que hay que repartir.
CREATE INDEX idx_com_localidades_sin_asignar
  ON com_localidades(id) WHERE region_id IS NULL;

-- ─── 2 · LA ASIGNACIÓN: LOCALIDAD → COMERCIAL ───────────────────────────────
--
-- Muchos a muchos, como `com_comercial_zonas` pero un nivel más abajo. Un
-- comercial puede llevar veinte pueblos y una zona puede estar repartida
-- entre tres comerciales.
--
-- `es_principal` quiere decir «este pueblo es SUCLIENTE principal». Un pueblo
-- puede estar en el territorio de varios —porque queda cerca de la frontera de
-- dos zonas— pero solo uno lo tiene como principal, que es el que lo visita.
--
CREATE TABLE com_localidad_comercial (
  id            SERIAL PRIMARY KEY,
  localidad_id  INTEGER NOT NULL REFERENCES com_localidades(id) ON DELETE CASCADE,
  comercial_id  INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  es_principal  BOOLEAN NOT NULL DEFAULT FALSE,
  -- El reparto de ese pueblo. Varios comerciales lo cubren con la parte que
  -- les toca; 100 con uno solo es el caso normal.
  porcentaje    NUMERIC(5,2) CHECK (porcentaje IS NULL OR porcentaje BETWEEN 0 AND 100),
  desde         DATE NOT NULL DEFAULT CURRENT_DATE,
  hasta         DATE,
  notas         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_lc_periodo_valido CHECK (hasta IS NULL OR hasta >= desde),
  -- El mismo pueblo no puede estar asignado dos veces al mismo comercial en la
  -- misma etapa. Un duplicado aquí hace que el reparto cuente ese pueblo dos
  -- veces, y la suma deja de cuadrar sin que se note por dónde.
  CONSTRAINT uniq_localidad_comercial UNIQUE (localidad_id, comercial_id, desde)
);

CREATE INDEX idx_com_lc_comercial ON com_localidad_comercial(comercial_id);
CREATE INDEX idx_com_lc_localidad  ON com_localidad_comercial(localidad_id);

-- Un pueblo tiene UN comercial principal, y cada comercial UN pueblo principal.
-- Los índices parciales son lo que lo impiden, no el código.
CREATE UNIQUE INDEX uniq_localidad_principal
  ON com_localidad_comercial(localidad_id) WHERE es_principal;

CREATE UNIQUE INDEX uniq_comercial_localidad_principal
  ON com_localidad_comercial(comercial_id) WHERE es_principal;

-- ─── 3 · LO QUE SE VE ───────────────────────────────────────────────────────
--
-- Una fila por localidad, con su comercial asignado y con el de la zona. Que
-- es lo que la pantalla necesita para pintar el mapa por colores sin tener que
-- preguntar tres veces.
--
CREATE OR REPLACE VIEW com_mapa_territorio AS
SELECT
  l.id                AS localidad_id,
  l.nombre,
  l.tipo,
  l.poblacion,
  l.latitude,
  l.longitude,
  l.region_id,
  l.revisado,
  rz.name             AS region,
  l.zona_id,
  z.name              AS zona,
  -- El comercial PRINCIPAL de ese pueblo, si lo hay.
  pc.id               AS comercial_principal_id,
  pu.full_name        AS comercial_principal,
  -- Todos los que lo cubren, no solo el principal: un pueblo en la frontera
  -- de dos zonas lo cubren dos, y verlo solo de uno sería mentir.
  (SELECT COALESCE(json_agg(json_build_object(
              'id', cu.id, 'nombre', uu.full_name,
              'porcentaje', lc.porcentaje, 'es_principal', lc.es_principal
            ) ORDER BY lc.es_principal DESC, uu.full_name), '[]'::json)
     FROM com_localidad_comercial lc
     JOIN com_perfiles cu ON cu.id = lc.comercial_id
     JOIN users uu ON uu.id = cu.user_id
    WHERE lc.localidad_id = l.id AND lc.hasta IS NULL) AS comerciales,
  -- Si no hay nadie, `true`. Y es lo que la pantalla usa para dizer «sin
  -- asignar» de un vistazo, sin tener que comparar listas en el navegador.
  NOT EXISTS (SELECT 1 FROM com_localidad_comercial lc
               WHERE lc.localidad_id = l.id AND lc.hasta IS NULL) AS sin_asignar
FROM com_localidades l
LEFT JOIN com_zonas z  ON z.id = l.zona_id
LEFT JOIN com_zonas rz ON rz.id = l.region_id
LEFT JOIN com_localidad_comercial lc
       ON lc.localidad_id = l.id AND lc.es_principal AND lc.hasta IS NULL
LEFT JOIN com_perfiles pc ON pc.id = lc.comercial_id
LEFT JOIN users pu ON pu.id = pc.user_id;

-- ─── 4 · QUE ESTO NO ROMPE NADA ─────────────────────────────────────────────
--
-- Las tres comprobaciones que importan: las nueve regiones siguen ahí, las
-- zonas siguen siendo zonas y los comerciales siguen siendo comerciales. Si
-- una migración deruviese algo de eso, saldría al crear las vistas, que es
-- donde PostgreSQL resuelve todas las dependencias.
--
DO $$
DECLARE
  v_regiones INT;
  v_zonas    INT;
  v_comerciales INT;
BEGIN
  SELECT count(*) INTO v_regiones   FROM com_zonas WHERE nivel = 'REGION';
  SELECT count(*) INTO v_zonas      FROM com_zonas;
  SELECT count(*) INTO v_comerciales FROM com_perfiles;

  IF v_regiones <> 9 THEN
    RAISE EXCEPTION 'hay % regiones y deberían ser 9. No se continúa.', v_regiones;
  END IF;

  RAISE NOTICE '030 aplicada: % regiones, % zonas, % comerciales. Las dos tablas nuevas están vacías; los datos se cargan aparte.',
    v_regiones, v_zonas, v_comerciales;
END $$;