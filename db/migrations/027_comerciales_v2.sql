-- ═════════════════════════════════════════════════════════════════════════════
-- 027 · COMERCIALES, REHECHO Y AISLADO
--
-- La 026 queda aplicada pero sin usar. Esta es la migración oficial.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- AISLAMIENTO. ESTO NO ES COSMÉTICO.
--
-- El módulo tiene que poder romperse entero sin que el ERP se entere. Eso se
-- consigue con una regla y una sola regla: ESTA MIGRACIÓN NO TOCA NADA DEL ERP.
--
-- Ni una `ALTER TABLE`, ni una `DROP`, ni una vista que lea `items` o
-- `sales_orders`. Ni una clave foránea que apunte fuera. Todo lo que se crea
-- aquí empieza por `com_` y se queda dentro.
--
-- Ni siquiera las dos cosas que el módulo necesita del exterior —un comercial
-- es un `users.id` y una visita es un `customers.id`— llevan clave foránea. Se
-- guardan como números. La razón es concreta: una clave foránea hace que el
-- ERP espere al módulo. Si un comercial se da de baja, un `DELETE` podría
-- bloquearse esperando, o un `TRUNCATE` del ERP podría fallar. El módulo es
-- lo opcional; el ERP es lo que no puede romperse.
--
-- El precio de no tener esas claves es que el módulo tiene que comprobar él
-- mismo que el usuario existe. Eso es trabajo, y se hace.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- UNA DECISIÓN DEL USUARIO, Y POR QUÉ ESTÁ ESCRITA ASÍ
--
-- Un comercial SIN objetivo no es un comercial con un cero.
--
-- Antes se leía `importe / 0` y salía `NULL`, y `NULL` en una columna
-- numérica al ordenarlo no es «al final»: es una regla que depende del
-- collation y del tipo. Aquí se hace explícito y a dos niveles:
--
--   · `tiene_objetivo` es un booleano, no se deduce. Una fila con objetivo y
--     una sin objetivo son cosas distintas y se ven distintas.
--
--   · El ranking ordena con `tiene_objetivo DESC` PRIMERO. Así el que no tiene
--     objetivo va detrás SIEMPRE, antes de mirar cualquier otro número. No
--     depende del valor: no hay ningún valor con el que compita.
--
--   · El cumplimiento es `NULL` cuando no hay objetivo, y `NULL` significa
--     «no lo sé», no «cero». En la pantalla sale un guion.
--
-- Regla del módulo, en una frase: ningún comercial sin objetivo entra en
-- ningún cálculo como si tuviera un objetivo de cero.
--
-- ═════════════════════════════════════════════════════════════════════════════


-- ─── 1 · ZONAS ───────────────────────────────────────────────────────────────
--
-- Zonas propias del módulo. No se tocan las `zones` del ERP: esas las usa el
-- reparto para agrupar rutas, y estas son de gestión comercial. Son cosas
-- distintas y mezclarlas sería empezar por el error.
--
CREATE TABLE com_zonas (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE
                 CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  name         TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  parent_id    INTEGER REFERENCES com_zonas(id) ON DELETE SET NULL,

  -- 'URBANA' | 'RURAL' | 'PUNTO_VENTA' | 'MAYORISTA'
  kind         TEXT NOT NULL CHECK (kind IN
                 ('URBANA','RURAL','PUNTO_VENTA','MAYORISTA','CORREDURIA')),

  -- Un comercial al que no se le asigna ninguna zona NO es un error: puede
  -- llevar la cartera completa. Por eso `home_zone_id` es NULL y no NOT NULL.
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT zona_no_es_misma CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX idx_com_zonas_padre ON com_zonas(parent_id);
CREATE INDEX idx_com_zonas_activas ON com_zonas(is_active);

-- ─── 2 · IDIOMAS ─────────────────────────────────────────────────────────────
--
-- Una zona puede hablar tres y un comercial dos. Por eso son dos tablas y no
-- una columna de texto con comas: una lista metida en un texto no se puede
-- consultar («¿quién habla francés?») sin desmenuzarla en cada consulta.
--
CREATE TABLE com_idiomas (
  code      TEXT PRIMARY KEY CHECK (code ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  nombre    TEXT NOT NULL,
  activo    BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO com_idiomas (code, nombre) VALUES
  ('fr', 'Francés'), ('en', 'Inglés'), ('es', 'Español'), ('pt', 'Portugués'),
  ('ar', 'Árabe'), ('bm', 'Bambara'), ('wo', 'Woloof'), ('ff', 'Pular');

-- Los idiomas que hay en una zona, con el peso de cada uno.
CREATE TABLE com_zona_idiomas (
  zona_id     INTEGER NOT NULL REFERENCES com_zonas(id) ON DELETE CASCADE,
  idioma_code TEXT NOT NULL REFERENCES com_idiomas(code) ON DELETE RESTRICT,
  peso        INTEGER NOT NULL DEFAULT 100 CHECK (peso BETWEEN 0 AND 100),
  PRIMARY KEY (zona_id, idioma_code)
);

-- Los idiomas que habla un comercial. La tabla de la zona y la del comercial
-- son distintas a propósito: se comparan, no son lo mismo.

-- ─── 3 · EL COMERCIAL ────────────────────────────────────────────────────────
--
-- `user_id` es un entero SIN clave foránea, a propósito: ver la cabecera de
-- este fichero. El módulo comprueba que el usuario existe; no deja que la base
-- lo decida por él.
--
CREATE TABLE com_perfiles (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL UNIQUE,
  home_zona_id INTEGER REFERENCES com_zonas(id) ON DELETE SET NULL,
  hired_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  -- NULL significa «no se ha dicho», no «no habla ninguno».
  --
  -- Se distingue de un comercial al que se le exige un idioma, que no es lo
  -- mismo: uno es un dato que falta y el otro es un commercial que aún no
  -- tiene perfil. Mezclarlos en un `''` hace que la consulta de afinidades
  -- devuelva cosas raras en lugar de devolver «no lo sé».
  languages_note TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT hired_on_no_futuro CHECK (hired_on <= CURRENT_DATE)
);

CREATE INDEX idx_com_perfiles_zona ON com_perfiles(home_zona_id);
CREATE INDEX idx_com_perfiles_activos ON com_perfiles(is_active);

-- Se inserta aquí la tabla de idiomas del comercial, DESPUÉS de que exista
-- `com_perfiles`. En el módulo anterior estaba declarada antes y la migración
-- fallaba por eso.
CREATE TABLE com_comercial_idiomas (
  comercial_id INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  idioma_code  TEXT NOT NULL REFERENCES com_idiomas(code) ON DELETE RESTRICT,
  nativo       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (comercial_id, idioma_code)
);

-- ─── 4 · OBJETIVOS ───────────────────────────────────────────────────────────
--
-- Todos los amounts son NULLABLE, y aquí está el motivo: puede que a alguien
-- se le pida un objetivo de unidades y no de dinero. Con `NOT NULL` y un 0 de
-- relleno, un objetivo de «20 cajas» se convierte en «0 FCFA y 20 cajas», y
-- el primer número compite en el ranking con los que sí tienen import.
--
CREATE TABLE com_objetivos (
  id             SERIAL PRIMARY KEY,
  comercial_id   INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  target_amount  NUMERIC(18,2) CHECK (target_amount IS NULL OR target_amount >= 0),
  target_units   NUMERIC(18,2) CHECK (target_units  IS NULL OR target_units  >= 0),
  target_orders  INTEGER      CHECK (target_orders IS NULL OR target_orders >= 0),
  target_visits  INTEGER      CHECK (target_visits IS NULL OR target_visits >= 0),
  notes          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_periodo_valido CHECK (period_end >= period_start),
  CONSTRAINT com_objetivo_no_vacio CHECK (
    target_amount IS NOT NULL OR target_units IS NOT NULL
    OR target_orders IS NOT NULL OR target_visits IS NOT NULL
  )
);

-- Un comercial, un objetivo por periodo. Lo que hace la regla de arriba: si se
-- pueden dar de alta con dos, luego no se sabe cuál cuenta.
CREATE UNIQUE INDEX uniq_com_objetivo_periodo
  ON com_objetivos(comercial_id, period_start);

CREATE INDEX idx_com_objetivos_periodo ON com_objetivos(period_start, period_end);

-- ─── 5 · VISITAS ─────────────────────────────────────────────────────────────
--
-- `customer_id` es un entero sin clave foránea. Una visita a un cliente que
-- luego se da de baja tiene que seguir existiendo: el histórico de visitas es
-- la prueba de que el comercial estuvo ahí, y no se borra porque el cliente
-- se haya ido.
--
CREATE TABLE com_visitas (
  id               SERIAL PRIMARY KEY,
  comercial_id     INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  customer_id      INTEGER,
  visita_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  visita_fecha     DATE NOT NULL DEFAULT CURRENT_DATE,
  resultado        TEXT NOT NULL CHECK (resultado IN
                     ('PRODUCT_SHOWN','ORDER_TAKEN','FOLLOW_UP_NEEDED',
                      'NO_INTEREST','VISITED_NO_CLIENT','CLOSED')),
  notas            TEXT,
  next_action      TEXT,
  next_action_date DATE,
  lat              NUMERIC(10,7) CHECK (lat BETWEEN -90 AND 90),
  lng              NUMERIC(10,7) CHECK (lng BETWEEN -180 AND 180),
  creado_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_com_visitas_comercial ON com_visitas(comercial_id, visita_fecha DESC);
CREATE INDEX idx_com_visitas_cliente   ON com_visitas(customer_id, visita_fecha DESC);

-- ─── 6 · REGLAS Y PUNTOS ─────────────────────────────────────────────────────
--
-- Los puntos se CALCULAN con reglas que están aquí. Nadie escribe un número.
--
CREATE TABLE com_reglas_puntos (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  descripcion   TEXT,
  metrica       TEXT NOT NULL CHECK (metrica IN
                  ('TARGET_ACHIEVEMENT','ORDERS','UNITS','VISITS','DISTINCT_CUSTOMERS')),
  puntos        NUMERIC(18,2) NOT NULL CHECK (puntos >= 0),
  umbral        NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (umbral >= 0),
  tope          NUMERIC(18,2) CHECK (tope IS NULL OR tope > 0),
  orden         INTEGER NOT NULL DEFAULT 100,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_com_reglas_activas ON com_reglas_puntos(is_active, orden);

-- Lo que cada uno sacó en cada periodo. NO es la verdad: es un resultado
-- calculado. La verdad son las reglas más los hechos. Se guarda para poder
-- decir «octubre: 320 puntos» sin recalcular, y para que un bono ya pagado
-- siga ahí aunque luego cambien las reglas.
CREATE TABLE com_puntos (
  id            SERIAL PRIMARY KEY,
  comercial_id  INTEGER NOT NULL REFERENCES com_perfiles(id) ON DELETE CASCADE,
  regla_id      INTEGER REFERENCES com_reglas_puntos(id) ON DELETE SET NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  puntos        NUMERIC(18,2) NOT NULL CHECK (puntos >= 0),
  motivo        TEXT NOT NULL,
  awarded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT com_puntos_periodo_valido CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX uniq_com_puntos_regla_periodo
  ON com_puntos(comercial_id, regla_id, period_start) WHERE regla_id IS NOT NULL;
CREATE INDEX idx_com_puntos_comercial ON com_puntos(comercial_id, period_start DESC);

INSERT INTO com_reglas_puntos (code, nombre, descripcion, metrica, puntos, umbral, tope, orden) VALUES
  ('cumple_objetivo', 'Cumplir el objetivo',
   'Un punto por cada punto porcentual que se alcance del objetivo del periodo.',
   'TARGET_ACHIEVEMENT', 1.00, 100, NULL, 10),
  ('por_pedido', 'Pedidos cerrados',
   'Puntos por pedido cerrado. Recompensa la constancia, no la magnitud.',
   'ORDERS', 5.00, 1, 200, 20),
  ('por_visita', 'Visitas hechas',
   'Puntos por visita. Sin esto, el mejor comercial es el que no hace nada y espera a que le llamen.',
   'VISITS', 2.00, 1, 300, 30),
  ('por_cliente', 'Clientes distintos',
   'Puntos por cliente DISTINTO. Separa a quien visita veinte veces al mismo de quien abre veinte puertas.',
   'DISTINCT_CUSTOMERS', 10.00, 1, 400, 40);


-- ─── 7 · LO QUE HA HECHO CADA UNO ────────────────────────────────────────────
--
-- Una función, y no una vista con treinta `LEFT JOIN`. Va en SQL porque el
-- ranking, los objetivos y los puntos tienen que decir LO MISMO. Si cada uno
-- se calculara por su lado, el ranking puede decir que alguien cumple su
-- objetivo mientras los puntos dicen que no: los dos números serían ciertos y
-- los dos mentirían.
--
-- `sales_orders` se lee POR ID y sin clave foránea desde este lado, que es lo
-- único que el módulo le pide al ERP: contarlo. No lo modifica nunca.
--
CREATE OR REPLACE FUNCTION com_hechos(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS TABLE (
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  visitas BIGINT, clientes_distintos BIGINT, dias_activos BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((
      SELECT SUM(so.total) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT SUM(l.qty) FROM sales_order_lines l
        JOIN sales_orders so ON so.id = l.sales_order_id
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM com_visitas v
       WHERE v.comercial_id = p_comercial_id
         AND v.visita_fecha BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT so.customer_id) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date BETWEEN p_desde AND p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT v.visita_fecha) FROM com_visitas v
       WHERE v.comercial_id = p_comercial_id
         AND v.visita_fecha BETWEEN p_desde AND p_hasta
    ), 0);
$$;

-- ─── 8 · CÓMO VA CADA UNO ────────────────────────────────────────────────────
--
-- `tiene_objetivo` va como columna de verdad. El motivo está arriba: ordenar
-- por `NULL` al final depende del tipo de la columna y de cómo lo ordene el
-- planificador, y un ranking cuyo orden depende del planificador es un
-- ranking que un día cambia solo.
--
CREATE OR REPLACE VIEW com_progreso AS
SELECT
  cp.id AS comercial_id,
  cp.user_id,
  u.username,
  u.full_name,
  cp.is_active,
  cp.home_zona_id,
  z.name AS zona,
  o.period_start,
  o.period_end,
  --
  -- AQUÍ ESTÁ LA DECISIÓN DEL USUARIO.
  --
  -- `tiene_objetivo` NO se deduce de que los amounts sean 0: se dice. Un
  -- comercial con objetivo de 0 y un comercial sin objetivo son filas
  -- distintas, y en el ranking van a sitios distintos.
  --
  (o.id IS NOT NULL) AS tiene_objetivo,
  o.target_amount,
  o.target_units,
  o.target_visits,
  h.importe,
  h.pedidos,
  h.unidades,
  h.visitas,
  h.clientes_distintos,
  h.dias_activos,

  -- El cumplimiento es NULL sin objetivo. NULL aquí significa «no lo sé»,
  -- y en la pantalla es un guion. Ponerlo a cero sería inventar un suspenso.
  CASE WHEN o.id IS NOT NULL AND o.target_amount > 0
       THEN ROUND(h.importe / o.target_amount * 100, 1)
       ELSE NULL END AS cumplimiento_pct,
  CASE WHEN o.id IS NOT NULL AND o.target_units > 0
       THEN ROUND(h.unidades / o.target_units * 100, 1)
       ELSE NULL END AS cumplimiento_unidades_pct,
  CASE WHEN o.id IS NOT NULL AND o.target_visits > 0
       THEN ROUND(h.visitas / o.target_visits * 100, 1)
       ELSE NULL END AS cumplimiento_visitas_pct
FROM com_perfiles cp
JOIN users u ON u.id = cp.user_id
LEFT JOIN com_zonas z ON z.id = cp.home_zona_id
--
-- `LEFT JOIN`: un comercial SIN objetivo tiene que aparecer igualmente, con su
-- fila vacía. Si fuera `INNER`, desaparecería del ranking justo cuando más
-- falta verlo.
--
LEFT JOIN com_objetivos o
  ON o.comercial_id = cp.id
 AND o.is_active
 AND CURRENT_DATE BETWEEN o.period_start AND o.period_end
CROSS JOIN LATERAL com_hechos(cp.id, o.period_start, o.period_end) h;

-- Un comercial sin objetivo no tiene periodo, así que la función con fechas
-- NULL devolvería 0 en todo. Se sustituye por el mes en curso, que es lo que
-- de verdad se quiere ver de alguien que todavía no tiene meta puesta.
--
CREATE OR REPLACE FUNCTION com_hechos_seguro(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS TABLE (
  importe NUMERIC, pedidos BIGINT, unidades NUMERIC,
  visitas BIGINT, clientes_distintos BIGINT, dias_activos BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT * FROM com_hechos(
    p_comercial_id,
    COALESCE(p_desde, date_trunc('month', CURRENT_DATE)::date),
    COALESCE(p_hasta, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date)
  );
$$;

DROP VIEW IF EXISTS com_progreso;
CREATE VIEW com_progreso AS
SELECT
  cp.id AS comercial_id,
  cp.user_id,
  u.username,
  u.full_name,
  cp.is_active,
  cp.home_zona_id,
  z.name AS zona,
  COALESCE(o.period_start, date_trunc('month', CURRENT_DATE)::date)   AS period_start,
  COALESCE(o.period_end, date_trunc('month', CURRENT_DATE)::date
           + interval '1 month - 1 day')                              AS period_end,
  (o.id IS NOT NULL) AS tiene_objetivo,
  o.target_amount,
  o.target_units,
  o.target_visits,
  h.importe, h.pedidos, h.unidades, h.visitas,
  h.clientes_distintos, h.dias_activos,
  CASE WHEN o.id IS NOT NULL AND o.target_amount > 0
       THEN ROUND(h.importe / o.target_amount * 100, 1) END AS cumplimiento_pct,
  CASE WHEN o.id IS NOT NULL AND o.target_units > 0
       THEN ROUND(h.unidades / o.target_units * 100, 1) END AS cumplimiento_unidades_pct,
  CASE WHEN o.id IS NOT NULL AND o.target_visits > 0
       THEN ROUND(h.visitas / o.target_visits * 100, 1) END AS cumplimiento_visitas_pct
FROM com_perfiles cp
JOIN users u ON u.id = cp.user_id
LEFT JOIN com_zonas z ON z.id = cp.home_zona_id
LEFT JOIN com_objetivos o
  ON o.comercial_id = cp.id AND o.is_active
 AND CURRENT_DATE BETWEEN o.period_start AND o.period_end
CROSS JOIN LATERAL com_hechos_seguro(cp.id, o.period_start::date, o.period_end::date) h;

-- ─── 9 · LOS PUNTOS ──────────────────────────────────────────────────────────
--
-- La función que aplica las reglas. El tope se aplica POR REGLA y no al
-- final: si se aplicara al final, el tope de una regla taparía lo acumulado
-- por otra y el resultado dejaría de depender de las reglas y empezaría a
-- depender del orden en que se aplican.
--
CREATE OR REPLACE FUNCTION com_puntos_de(p_comercial_id INT, p_desde DATE, p_hasta DATE)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
  h          RECORD;
  v_objetivo NUMERIC := 0;
  v_total    NUMERIC := 0;
  v_logrado  NUMERIC;
  v_puntos   NUMERIC;
  r          RECORD;
BEGIN
  IF p_comercial_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO h FROM com_hechos(p_comercial_id, p_desde, p_hasta);

  -- El objetivo se busca POR COMERCIAL, no por periodo. Buscarlo por periodo
  -- hacía que el cumplimiento nunca saliera, porque `p_comercial_id` no es lo
  -- que se guarda en esa tabla.
  SELECT COALESCE(MAX(o.target_amount), 0) INTO v_objetivo
    FROM com_objetivos o
   WHERE o.comercial_id = p_comercial_id AND o.is_active
     AND CURRENT_DATE BETWEEN o.period_start AND o.period_end;

  FOR r IN SELECT * FROM com_reglas_puntos WHERE is_active ORDER BY orden, id
  LOOP
    v_logrado := CASE r.metrica
      WHEN 'TARGET_ACHIEVEMENT' THEN CASE WHEN v_objetivo > 0
             THEN h.importe / v_objetivo * 100 ELSE 0 END
      WHEN 'ORDERS'            THEN h.pedidos
      WHEN 'UNITS'             THEN h.unidades
      WHEN 'VISITS'            THEN h.visitas
      WHEN 'DISTINCT_CUSTOMERS' THEN h.clientes_distintos
      ELSE 0
    END;

    -- Sin objetivo, la regla de cumplimiento NO CUENTA. No es que saque 0
    -- puntos: es que no hay contra qué medirse.
    CONTINUE WHEN r.metrica = 'TARGET_ACHIEVEMENT' AND v_objetivo <= 0;
    CONTINUE WHEN v_logrado < r.umbral;

    v_puntos := (v_logrado - r.umbral) * r.puntos;
    v_puntos := CASE WHEN r.tope IS NOT NULL THEN LEAST(v_puntos, r.tope)
                     ELSE v_puntos END;
    v_total := v_total + v_puntos;
  END LOOP;

  RETURN ROUND(v_total, 2);
END;
$$;

-- ─── 10 · EL RANKING ─────────────────────────────────────────────────────────
--
-- Ordena por `tiene_objetivo` PRIMERO. No por el cumplimiento, ni por los
-- puntos, ni por el importe: por si tiene meta puesta. Con eso, el que no
-- tiene objetivo va detrás siempre y sin depender de ningún valor.
--
CREATE OR REPLACE VIEW com_ranking AS
WITH base AS (
  SELECT p.*, com_puntos_de(p.comercial_id, p.period_start::date, p.period_end::date) AS puntos
    FROM com_progreso p
)
SELECT
  b.*,
  -- `DENSE_RANK`, no `ROW_NUMBER`: dos comerciales al mismo 100 % tienen el
  -- mismo puesto. Con `ROW_NUMBER` el orden de esos dos depende del orden
  -- físico de la tabla, y a la semana pueden intercambiarse sin que haya
  -- cambiado nada. Un puesto que se mueve solo es peor que no tener puesto.
  DENSE_RANK() OVER (
    ORDER BY b.tiene_objetivo DESC,
             COALESCE(b.cumplimiento_pct, -1) DESC,
             COALESCE(b.cumplimiento_unidades_pct, -1) DESC,
             b.puntos DESC
  ) AS puesto,
  COUNT(*) OVER () AS comerciales_en_lista,
  -- Para la pantalla: el texto que va en la celda. Aquí, no en el JavaScript,
  -- porque es el MISMO dato y no puede que uno diga «—» y el otro «0 %».
  --
  -- El texto va AQUÍ, no en el JavaScript, porque es el mismo dato y no puede
  -- que uno diga «0 %» y el otro «0.0 %».
  --
  -- Se quita el `.0` cuando el número es entero: en pantalla «0.0 %» parece un
  -- decimal calculado cuando en realidad es un cero redondo, y quien lo lee
  -- se queda pensando que hay una precisión que no la hay.
  --
  CASE WHEN NOT b.tiene_objetivo OR b.cumplimiento_pct IS NULL THEN '—'
       WHEN b.cumplimiento_pct = trunc(b.cumplimiento_pct)
            THEN b.cumplimiento_pct::bigint || ' %'
       ELSE b.cumplimiento_pct::text || ' %'
  END AS cumplimiento_texto
FROM base b;

-- ─── 11 · LAS AFINIDADES ─────────────────────────────────────────────────────
--
-- Un comercial encaja con una zona si comparten idioma. No es un criterio que
-- se decida al asignar: es un dato que se consulta, y por eso se puede
-- corregir sin reasignar a nadie.
--
CREATE OR REPLACE VIEW com_afinidades AS
SELECT DISTINCT
  cp.id AS comercial_id,
  u.username,
  u.full_name,
  z.id AS zona_id,
  z.name AS zona,
  ci.idioma_code,
  i.nombre AS idioma,
  zi.peso AS peso_zona,
  ci.nativo
FROM com_perfiles cp
JOIN users u ON u.id = cp.user_id
--
-- `unnest(ARRAY(...))` devuelve UNA columna, la que se le nombre. No trae
-- `nativo` ni nada más: eso está en `com_comercial_idiomas`, y por eso hay
-- que unir esa tabla y no sacarlo del unnest.
--
JOIN com_comercial_idiomas mc ON mc.comercial_id = cp.id
CROSS JOIN LATERAL (SELECT mc.idioma_code, mc.nativo) AS ci(idioma_code, nativo)
JOIN com_idiomas i ON i.code = ci.idioma_code
JOIN com_zonas z ON z.is_active
JOIN com_zona_idiomas zi ON zi.zona_id = z.id AND zi.idioma_code = ci.idioma_code
WHERE cp.is_active AND u.is_active;

-- ─── 12 · AISLAMIENTO, DECLARADO ─────────────────────────────────────────────
--
-- Una tabla que deja constancia de qué toca este módulo y qué no. No es
-- adorno: es lo que permite responder «¿el problema es de Comerciales?» en un
-- minuto en vez de en una tarde.
--
CREATE TABLE com_superficie (
  id          SERIAL PRIMARY KEY,
  tabla       TEXT NOT NULL,
  toca_erp    BOOLEAN NOT NULL DEFAULT FALSE,
  que_toca    TEXT,
  creado_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO com_superficie (tabla, toca_erp, que_toca) VALUES
  ('com_zonas',            FALSE, 'Zonas propias. NO usa las \`zones\` del ERP.'),
  ('com_idiomas',          FALSE, 'Catálogo de idiomas.'),
  ('com_zona_idiomas',     FALSE, 'Idiomas por zona.'),
  ('com_perfiles',         FALSE, 'El comercial. user_id sin clave foránea.'),
  ('com_comercial_idiomas',FALSE, 'Idiomas del comercial.'),
  ('com_objetivos',        FALSE, 'Objetivos por periodo.'),
  ('com_visitas',          FALSE, 'Visitas. customer_id sin clave foránea.'),
  ('com_reglas_puntos',    FALSE, 'Reglas de puntuación.'),
  ('com_puntos',           FALSE, 'Puntos concedidos, ya calculados.'),
  ('sales_orders',         TRUE,  'SOLO LECTURA: para com_hechos(). Nunca se escribe.'),
  ('users',                TRUE,  'SOLO LECTURA: nombre del comercial. Nunca se escribe.');