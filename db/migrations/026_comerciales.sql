-- ═════════════════════════════════════════════════════════════════════════════
-- 026 · COMERCIALES QUE SIRVEN PARA ALGO
--
-- En la base ya había tres cajas: `zones`, `visits` y `commercial_targets`.
-- Tres tablas sin una sola línea de código que las usara: ni alta de
-- comerciales, ni API, ni pantalla, ni un ranking. Estaban puestas desde la
-- fase 0 y nunca se habían terminado.
--
-- Esto no las sustituye: las llena. Y añade lo que faltaba de verdad para que
-- un comercial se pueda seguir, evaluar y motivational — que es lo único que
-- sirve de un ranking.
--
-- LO QUE NO SE HACE AQUÍ, Y POR QUÉ:
--
-- · El ranking NO ordena por euros. Ordena por cumplimiento de objetivo. Dos
--   razones, y las dos son de negocio: una zona pequeña no tiene por qué
--   salir por debajo de una grande, y un comercial al que se le pone un número
--   de ventas encima compite con el número, no con el cliente. El primero
--   produce dos cosas: en vez de repartir, se guarda el pedido fácil.
--
-- · Los puntos NO se escriben a mano. Salen de REGLAS que están en la base, y
--   la función que los calcula es la misma que los ve la pantalla. Un punto
--   tecleado por alguien es un punto que se puede negociar; uno que sale de
--   una regla repetible, no.
--
-- · Los objetivos no se borran ni se editan en el pasado. Un objetivo es la
--   medida con la que se juzgó a alguien: si se pudiera cambiar después de
--   ver el resultado, la medida no valdría para nada.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1 · EL COMERCIAL COMO PERSONA ────────────────────────────────────────────
--
-- `users` dice que existe y con qué rol entra. No dice qué idioma habla, desde
-- cuándo está, ni si está de alta. Eso va aquí.
--
CREATE TABLE commercial_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  languages     TEXT[] NOT NULL DEFAULT '{}',
  home_zone_id  INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  hired_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un comercial sin idioma no se puede emparejar con nadie. Se deja vacío y
  -- se avisa, en vez de poner 'es' por defecto: un idioma inventado empareja
  -- mal a una persona real.
  CONSTRAINT comercial_tiene_idioma CHECK (array_length(languages, 1) IS NOT NULL),
  -- No se puede contratar a alguien con fecha de mañana. Parece tonto; evita
  -- el «¿desde cuándo era comercial?» de quien pide el histórico.
  CONSTRAINT hired_on_no_futuro CHECK (hired_on <= CURRENT_DATE)
);

CREATE INDEX idx_commerciales_zona ON commercial_profiles(home_zone_id);
CREATE INDEX idx_comerciales_activos ON commercial_profiles(is_active);

-- ─── 2 · IDIOMAS POR ZONA ─────────────────────────────────────────────────────
--
-- La afinidad no se inventa en el momento de asignar: se declara por zona, que
-- es donde se sabe. Una zona con mucha población francófona tiene sus
-- comerciales hablantes; la de al lado, no. Y es un dato revisable, no un
-- criterio escondido en el código.
--
CREATE TABLE zone_languages (
  zone_id    INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  language   TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  weight     INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 100),
  PRIMARY KEY (zone_id, language)
);

CREATE INDEX idx_idiomas_zona ON zone_languages(zone_id);

-- ─── 3 · OBJETIVOS QUE ALSO SABEN CONTAR UNIDADES ──────────────────────────────
--
-- `commercial_targets` solo sabe de importes. Un comercial que factura mucho
-- con una sola venta grande no es lo mismo que uno que coloca veinte cajas, y
-- para el negocio las dos cosas cuentan. Se amplía la tabla que ya existe en
-- vez de crear otra: los importes que ya estaban siguen ahí, con su histórico.
--
ALTER TABLE commercial_targets
  ADD COLUMN target_units NUMERIC(18,2) CHECK (target_units IS NULL OR target_units >= 0),
  ADD COLUMN target_orders INTEGER CHECK (target_orders IS NULL OR target_orders >= 0),
  ADD COLUMN target_visits INTEGER CHECK (target_visits IS NULL OR target_visits >= 0),
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN notes TEXT;

-- Un objetivo para un comercial que no existe no puede medirse.
CREATE INDEX idx_objetivos_comercial ON commercial_targets(commercial_id, period_start DESC);

-- ─── 4 · REGLAS DE PUNTOS ─────────────────────────────────────────────────────
--
-- Lo que el usuario pidió: «un sistema de puntos según rendimiento» que sirva
-- «para bonos, premios, ventajas o reconocimiento».
--
-- Lo importante es que sea un SISTEMA, no un número. Las reglas viven aquí, se
-- cambian sin tocar código, y los puntos se calculan con `fn_puntos_comercial()`
-- — la misma función que lee la pantalla. Nadie teclea un punto.
--
CREATE TABLE point_rules (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Puntos por cada unidad de medida cumplida.
  points       NUMERIC(18,2) NOT NULL CHECK (points >= 0),
  -- Qué mide la regla. Es una lista cerrada a propósito: si se aceptara
  -- cualquier texto, un día alguien pondría 'lo que pida' y el sistema
  -- aceptaría puntos por no hacer nada.
  metric       TEXT NOT NULL CHECK (metric IN
                 ('TARGET_ACHIEVEMENT','ORDERS','UNITS','VISITS','ACTIVE_CUSTOMERS')),
  -- Umbral a partir del cual la regla empieza a contar. 0 = desde el primer
  -- euro. Sirve para «bonifica a partir del 80 % del objetivo» sin meter esa
  -- condición en el código.
  threshold    NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (threshold >= 0),
  -- Techo por periodo. Sin él, un comercial que venda diez veces su objetivo
  -- genera diez veces los puntos y el ranking deja de significar nada.
  cap_per_period NUMERIC(18,2) CHECK (cap_per_period IS NULL OR cap_per_period > 0),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reglas_activas ON point_rules(is_active, sort_order);

-- Lo que cada comercial ha sacado en cada periodo. NO es una fuente de verdad:
-- es un resultado. La verdad son las reglas más los hechos. La tabla existe
-- para poder mostrar «octubre: 320 puntos» sin recalcularlo cada vez, y para
-- que un bono ya entregado quede registrado aunque luego cambien las reglas.
CREATE TABLE commercial_points (
  id            SERIAL PRIMARY KEY,
  commercial_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id       INTEGER REFERENCES point_rules(id) ON DELETE SET NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  points        NUMERIC(18,2) NOT NULL CHECK (points >= 0),
  reason        TEXT NOT NULL,
  awarded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT puntos_periodo_valido CHECK (period_end >= period_start)
);

-- Un comercial y una regla no pueden contar dos veces en el mismo periodo.
CREATE UNIQUE INDEX uniq_puntos_comercial_regla_periodo
  ON commercial_points(commercial_id, rule_id, period_start)
  WHERE rule_id IS NOT NULL;

CREATE INDEX idx_puntos_comercial ON commercial_points(commercial_id, period_start DESC);

-- ─── 5 · LO QUE HA HECHO CADA COMERCIAL, EN UN PERIODO ────────────────────────
--
-- Una función, no una vista con treinta `LEFT JOIN`. Va en SQL porque el
-- ranking, los objetivos y los puntos tienen que decir LO MISMO: si cada uno
-- secalcula por su lado, el ranking puede decir que alguien cumpla su
-- objetivo mientras los puntos dicen que no. Y entonces los dos números son
-- ciertos y los dos mienten.
--
CREATE OR REPLACE FUNCTION fn_hechos_comercial(
  p_comercial_id INT,
  p_desde        DATE,
  p_hasta        DATE
)
RETURNS TABLE (
  importe        NUMERIC,
  pedidos        BIGINT,
  unidades       NUMERIC,
  visitas        BIGINT,
  clientes_activos BIGINT,
  dias_activos   BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    -- El importe de lo VENDIDO, no lo facturado ni lo cobrado. Cobrar es un
    -- hecho de Caja; vender es un hecho comercial. Mezclarlos hace que el
    -- ranking premie a quien cobra fácil, que no es lo mismo que vender.
    COALESCE((
      SELECT SUM(so.total) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT SUM(v.qty_ordered) FROM v_order_progress v
        JOIN sales_orders so ON so.id = v.order_id
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(*) FROM visits vi
       WHERE vi.commercial_id = p_comercial_id
         AND vi.visit_date >= p_desde AND vi.visit_date <= p_hasta
    ), 0),
    -- Clientes DISTINTOS con los que ha trabajado. Es lo que distingue a
    -- alguien que visita veinte veces al mismo cliente de uno que abre veinte
    -- puertas.
    COALESCE((
      SELECT COUNT(DISTINCT so.customer_id) FROM sales_orders so
       WHERE so.commercial_id = p_comercial_id
         AND so.status <> 'CANCELLED'
         AND so.order_date >= p_desde AND so.order_date <= p_hasta
    ), 0),
    COALESCE((
      SELECT COUNT(DISTINCT vi.visit_date) FROM visits vi
       WHERE vi.commercial_id = p_comercial_id
         AND vi.visit_date >= p_desde AND vi.visit_date <= p_hasta
    ), 0);
$$;

-- ─── 6 · CÓMO VA CADA UNO ─────────────────────────────────────────────────────
--
-- Esto es lo que ve el jefe, el comercial y el propio cliente.
--
-- El '%' de cumplimiento va en la MISMA tabla que el importe, y no en la
-- pantalla: para que sea imposible enseñar «el mejor» al que másFacturó
-- cuando el que más facturó no cumplió su objetivo.
--
CREATE OR REPLACE VIEW v_commercial_progress AS
WITH periodos AS (
  SELECT ct.commercial_id, ct.period_start, ct.period_end,
         ct.target_amount, ct.target_units, ct.target_visits, ct.notes
    FROM commercial_targets ct
   WHERE ct.is_active
)
SELECT
  p.commercial_id,
  u.username,
  u.full_name,
  cp.languages,
  cp.home_zone_id,
  z.name AS zona,
  p.period_start,
  p.period_end,
  p.target_amount,
  p.target_units,
  p.target_visits,
  h.importe,
  h.pedidos,
  h.unidades,
  h.visitas,
  h.clientes_activos,
  h.dias_activos,
  -- El cumplimiento va al lado del objetivo Y del importe, no en una pantalla
  -- aparte. Un ranking que enseña solo el puesto esconde con qué se juzgó; uno
  -- que enseña las tres columnas permite comprobar que el orden sale de la de
  -- al lado, y por eso no se puede maquillar sin que se note.
  CASE WHEN p.target_amount > 0
       THEN ROUND(h.importe / p.target_amount * 100, 1)
       ELSE NULL END AS cumplimiento_pct,
  CASE WHEN p.target_units > 0
       THEN ROUND(h.unidades / p.target_units * 100, 1)
       ELSE NULL END AS cumplimiento_unidades_pct,
  CASE WHEN p.target_visits > 0
       THEN ROUND(h.visitas / p.target_visits * 100, 1)
       ELSE NULL END AS cumplimiento_visitas_pct
FROM periodos p
JOIN users u ON u.id = p.commercial_id
LEFT JOIN commercial_profiles cp ON cp.user_id = p.commercial_id
LEFT JOIN zones z ON z.id = cp.home_zone_id
CROSS JOIN LATERAL fn_hechos_comercial(p.commercial_id, p.period_start, p.period_end) h;

-- ─── 7 · LOS PUNTOS, CALCULADOS ───────────────────────────────────────────────
--
-- La función que aplica las reglas. Vive aquí y no en JavaScript para que
-- nadie pueda awarding puntos desde fuera con una regla distinta.
--
-- El tope por periodo es lo que mantiene sano el ranking: sin él, quien venda
-- diez veces su objetivo tiene diez veces los puntos, y el sistema pasa a
-- medir sólo quién tiene la zona más grande.
--
CREATE OR REPLACE FUNCTION fn_puntos_comercial(
  p_comercial_id INT,
  p_desde        DATE,
  p_hasta        DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
  h           RECORD;
  v_objetivo  NUMERIC := 0;
  v_total     NUMERIC := 0;
  v_logrado   NUMERIC;
  v_puntos    NUMERIC;
  r           RECORD;
BEGIN
  IF p_comercial_id IS NULL OR p_desde IS NULL OR p_hasta IS NULL THEN
    RETURN 0;
  END IF;

  -- Un comercial sin objetivos no tiene puntos, y no es un error: se puede
  -- contratar a alguien antes de decidir qué se le pide.
  SELECT COALESCE(MAX(target_amount), 0) INTO v_objetivo
    FROM commercial_targets
   WHERE commercial_id = p_comercial_id
     AND period_start = p_desde
     AND is_active;

  SELECT * INTO h FROM fn_hechos_comercial(p_comercial_id, p_desde, p_hasta);

  FOR r IN
    SELECT pr.* FROM point_rules pr
     WHERE pr.is_active
     ORDER BY pr.sort_order, pr.id
  LOOP
    -- Qué mide esta regla, en la unidad que tiene sentido para ella.
    v_logrado := CASE r.metric
      WHEN 'TARGET_ACHIEVEMENT' THEN
        CASE WHEN v_objetivo > 0
             THEN h.importe / v_objetivo * 100
             ELSE 0 END
      WHEN 'ORDERS'           THEN h.pedidos
      WHEN 'UNITS'            THEN h.unidades
      WHEN 'VISITS'           THEN h.visitas
      WHEN 'ACTIVE_CUSTOMERS' THEN h.clientes_activos
      ELSE 0
    END;

    -- Por debajo del umbral, esta regla no cuenta. Se salta ENTERA, y no se
    -- «escala»: si nadie llega al 80 % del objetivo, no hay que repartir
    -- puntos a medias y dejar a medias el objetivo, que es como se juntan dos
    -- cosas que no van juntas.
    CONTINUE WHEN v_logrado < r.threshold;

    -- El umbral se DESCUENTA cuando es mayor que cero. «3 puntos por visita a
    -- partir de la primera» son 3 puntos; si el umbral fuera 10 y la regla
    -- dijera 3 por visita, contarían las 10 de ejemplo y no las de verdad.
    v_puntos := (v_logrado - r.threshold) * r.points;

    -- El tope se aplica A ESTA REGLA, antes de sumarla al total. Si se
    -- aplicara al final, el tope de una regla taparía lo acumulado por otra,
    -- y el resultado dejaría de depender de las reglas y del orden.
    v_puntos := CASE
      WHEN r.cap_per_period IS NOT NULL THEN LEAST(v_puntos, r.cap_per_period)
      ELSE v_puntos
    END;

    v_total := v_total + v_puntos;
  END LOOP;

  RETURN ROUND(v_total, 2);
END;
$$;

-- ─── 8 · EL RANKING ───────────────────────────────────────────────────────────
--
-- Ordena por CUMPLIMIENTO, no por importe. Se repiten las dos columnas porque
-- un ranking que enseña solo el puesto esconde la información con la que se
-- juzga: aquí se ve el porcentaje, el importe Y el objetivo, y se puede
-- comprobar que el orden sale de la columna de al lado.
--
CREATE OR REPLACE VIEW v_commercial_ranking AS
WITH base AS (
  SELECT vp.*,
         fn_puntos_comercial(vp.commercial_id, vp.period_start, vp.period_end) AS puntos
    FROM v_commercial_progress vp
)
SELECT
  b.*,
  -- `DENSE_RANK` y no `ROW_NUMBER`: dos comerciales con el mismo 100 % tienen
  -- el mismo puesto. Con `ROW_NUMBER` el orden de esos dos dependería del
  -- orden en que salieran de la consulta, que es el orden físico de la tabla,
  -- y a la semana siguiente podrían intercambiarse los puestos sin que haya
  -- cambiado nada.
  DENSE_RANK() OVER (
    ORDER BY COALESCE(b.cumplimiento_pct, 0) DESC,
             COALESCE(b.cumplimiento_unidades_pct, 0) DESC,
             b.puntos DESC
  ) AS puesto,
  COUNT(*) OVER () AS comerciales_en_lista
FROM base b
WHERE b.period_start IS NOT NULL;

-- ─── 9 · LAS AFINIDADES ───────────────────────────────────────────────────────
--
-- Un comercial encaja con una zona si comparte idioma. No es una decisión que
-- se tome al asignar: es un dato que se consulta, y por eso se puede cambiar
-- sin reasignar a nadie.
--
CREATE OR REPLACE VIEW v_commercial_afinidades AS
SELECT DISTINCT
  cp.user_id AS comercial_id,
  u.username,
  u.full_name,
  z.id AS zona_id,
  z.name AS zona,
  lang.language AS language,
  zl.weight
FROM commercial_profiles cp
JOIN users u ON u.id = cp.user_id
--
-- El `unnest` va al FINAL y con nombre de columna explícito.
--
-- Dos cosas que se pueden hacer mal aquí y las dos fallan de forma
-- desconcertante. Primera: `unnest(languages) AS lang` no renombra nada; la
-- columna se llama `unnest`, y escribir `lang.language` da un error que habla
-- de una columna que existe. Segunda, y peor: un CROSS JOIN no puede ir
-- entre dos JOIN normales. Postgres acepta el SQL y lo ejecuta en otro
-- orden, y el resultado es una tabla vacía sin decir por qué.
--
CROSS JOIN LATERAL unnest(cp.languages) AS lang(language)
JOIN zones z ON z.is_active
JOIN zone_languages zl ON zl.zone_id = z.id AND zl.language = lang.language
WHERE cp.is_active AND u.is_active;

-- ─── 10 · LAS REGLAS DE PUNTOS, DE SALIDA ─────────────────────────────────────
--
-- Las mismas que se escribieron, con un ejemplo de lo que daría cada una. Para
-- poder explicarle a alguien por qué tiene 40 puntos sin tener que leer SQL.
--
INSERT INTO point_rules (code, name, description, points, metric, threshold, cap_per_period, sort_order) VALUES
  ('cumple_objetivo', 'Cumplir el objetivo',
   'Puntos por cada punto porcentual que se alcance del objetivo del periodo.',
   1.00, 'TARGET_ACHIEVEMENT', 100, NULL, 10),

  ('por_pedido', 'Pedidos cerrados',
   'Puntos por cada pedido cerrado en el periodo. Recompensa la constancia, no la magnitud: un pedido pequeño cuenta igual que uno grande.',
   5.00, 'ORDERS', 1, 200, 20),

  ('por_visita', 'Visitas hechas',
   'Puntos por visita registrada. Es lo que hace que la gente visite: sin esto, el mejor comercial es el que no hace nada y espera a que le llamen.',
   2.00, 'VISITS', 1, 300, 30),

  ('por_cliente_nuevo', 'Clientes distintos',
   'Puntos por cada cliente DISTINTO con el que se ha trabajado en el periodo. Es lo que separa a quien visita veinte veces al mismo de quien abre veinte puertas.',
   10.00, 'ACTIVE_CUSTOMERS', 1, 400, 40);