-- ═══════════════════════════════════════════════════════════════════════════
-- 010 · Alcance completo: identidad de lote por producto, albarán como
--      proceso, firma con almacenamiento propio y blindaje de la reserva.
--
-- Estos cuatro puntos no son adornos. Son las reglas que el negocio escribe a
-- mano y que la base de datos tiene que hacer cumplir por su cuenta, para que
-- ningún camino de código pueda saltárselas por descuido.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1 · Lote de producto terminado numerado POR PRODUCTO ────────────────────
-- El formato pedido es PT-DES-00001, PT-DES-00002… y PT-LAV-00001 para otro
-- producto. El contador es independiente por producto y no vuelve atrás.
--
-- Cada producto lleva su propio prefijo corto, editable. Si no se rellena, se
-- deduce del SKU: «PT-LIM-1L» → «LIM».
ALTER TABLE items ADD COLUMN IF NOT EXISTS lot_prefix TEXT;

UPDATE items
   SET lot_prefix = upper(regexp_replace(split_part(sku, '-', 2), '[^A-Za-z0-9]', '', 'g'))
 WHERE lot_prefix IS NULL
   AND category_kind = 'FINISHED_GOOD';

ALTER TABLE items ADD CONSTRAINT items_lot_prefix_formato
  CHECK (lot_prefix IS NULL OR lot_prefix ~ '^[A-Z0-9]{2,6}$');

-- Contadores reales. Antes el número se sacaba con MAX(code) sobre la tabla,
-- lo que sólo protege mientras nadie borre un lote: al borrar, el contador
-- retrocede y el siguiente lote choca contra uno existente. Aquí el número vive
-- en su propia fila y nunca se recalcula desde el histórico.
CREATE TABLE IF NOT EXISTS code_counters (
  scope      TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE code_counters IS
  'Contadores de numeración. La fila se bloquea con ON CONFLICT DO UPDATE, de modo que dos producciones simultáneas del mismo producto no obtienen el mismo número.';

-- Punto de partida: se empareja con el número más alto que YA existe de cada
-- prefijo, para que cambiar de formato no reutilice un código retirado.
INSERT INTO code_counters (scope, last_value)
SELECT 'LOTE:' || i.lot_prefix,
       COALESCE(MAX((regexp_match(l.code, '-(\d+)$'))[1]::int), 0)
  FROM items i
  LEFT JOIN lots l ON l.code LIKE 'PT-' || i.lot_prefix || '-%'
 WHERE i.lot_prefix IS NOT NULL
 GROUP BY i.lot_prefix
ON CONFLICT (scope) DO NOTHING;

-- ─── 2 · La reserva no puede duplicarse ─────────────────────────────────────
-- Dos formas de estropear un pedido, y ninguna depende ya del código:
--
--   a) Apartar dos veces la misma cantidad de la misma línea. Se bloquea con
--      un índice único parcial sobre (línea, lote) mientras siga viva.
--   b) Apartar más de lo pedido repartido entre varios lotes, que es legal por
--      separado pero no en conjunto. Eso lo vigila el disparador de abajo,
--      porque un índice no puede sumar filas.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reserva_linea_lote
  ON order_reservations (order_line_id, lot_id)
  WHERE sales_order_id IS NOT NULL
    AND status IN ('ACTIVE','ASSIGNED');

CREATE OR REPLACE FUNCTION fn_reserva_no_supera_pedido() RETURNS TRIGGER AS $$
DECLARE
  pedido   NUMERIC;
  ya_apartado NUMERIC;
  nueva    NUMERIC;
BEGIN
  -- Solo interesan las reservas de pedido, y solo mientras están vivas.
  IF NEW.sales_order_id IS NULL OR NEW.status NOT IN ('ACTIVE','ASSIGNED') THEN
    RETURN NEW;
  END IF;

  SELECT l.qty INTO pedido
    FROM sales_order_lines l WHERE l.id = NEW.order_line_id;
  IF pedido IS NULL THEN RETURN NEW; END IF;

  -- Suma del resto de reservas vivas de esa misma línea, más la que entra.
  SELECT COALESCE(SUM(r.qty), 0) INTO ya_apartado
    FROM order_reservations r
   WHERE r.order_line_id = NEW.order_line_id
     AND r.sales_order_id IS NOT NULL
     AND r.status IN ('ACTIVE','ASSIGNED')
     AND r.id <> NEW.id;
  nueva := ya_apartado + NEW.qty;

  IF nueva > pedido + 0.0001 THEN
    RAISE EXCEPTION
      'RESERVA_EXCEDE_PEDIDO: la línea % ya tiene % apartado y se intentan añadir % (pedido %).',
      NEW.order_line_id, ya_apartado, NEW.qty, pedido
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reserva_no_supera_pedido ON order_reservations;
CREATE TRIGGER trg_reserva_no_supera_pedido
  BEFORE INSERT OR UPDATE ON order_reservations
  FOR EACH ROW EXECUTE FUNCTION fn_reserva_no_supera_pedido();

-- ─── 3 · El albarán es un proceso con cuatro hechos separados ───────────────
--   CREAR → IMPRIMIR → FIRMAR → ENTREGAR
--
-- Imprimir NO entrega. Y eso no es una convención del código: son CHECK de
-- PostgreSQL. Para llegar a DELIVERED hacen falta las cuatro marcas, y para
-- llegar a SIGNED hace falta haber imprimido antes.
CREATE TABLE IF NOT EXISTS albaranes (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  delivery_id    INTEGER REFERENCES deliveries(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','PRINTED','SIGNED','DELIVERED','VOID')),
  copies         INTEGER NOT NULL DEFAULT 2 CHECK (copies >= 1),
  recipient_name TEXT,
  recipient_notes TEXT,
  observations   TEXT,
  printed_at     TIMESTAMPTZ,
  printed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signed_at      TIMESTAMPTZ,
  signed_by_name TEXT,
  delivered_at   TIMESTAMPTZ,
  delivered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- El orden de los hechos también lo vigila la base, no solo el estado final.
  CONSTRAINT albaran_imprimir_despues_crear
    CHECK (printed_at IS NULL OR printed_at >= created_at),
  CONSTRAINT albaran_firmar_despues_imprimir
    CHECK (signed_at IS NULL OR (printed_at IS NOT NULL AND signed_at >= printed_at)),
  CONSTRAINT albaran_entregar_despues_firmar
    CHECK (delivered_at IS NULL OR (signed_at IS NOT NULL AND delivered_at >= signed_at)),
  -- Y el estado no puede adelantarse a sus marcas.
  CONSTRAINT albaran_printed_exige_impresion
    CHECK (status <> 'PRINTED' OR printed_at IS NOT NULL),
  CONSTRAINT albaran_signed_exige_firma
    CHECK (status <> 'SIGNED' OR signed_at IS NOT NULL),
  -- ESTA es la regla que pediste: entregar exige evidencia de recepción.
  CONSTRAINT albaran_delivered_exige_firma_y_fecha
    CHECK (status <> 'DELIVERED' OR (signed_at IS NOT NULL AND delivered_at IS NOT NULL)),
  CONSTRAINT albaran_void_exige_motivo
    CHECK (status <> 'VOID' OR length(trim(COALESCE(void_reason,''))) >= 3)
);

CREATE TABLE IF NOT EXISTS albaran_events (
  id          BIGSERIAL PRIMARY KEY,
  albaran_id  INTEGER NOT NULL REFERENCES albaranes(id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('CREATED','PRINTED','SIGNED','DELIVERED','VOID')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name   TEXT,
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_albaran_events ON albaran_events (albaran_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_albaranes_pedido ON albaranes (sales_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_albaranes_estado ON albaranes (status, created_at DESC);

-- Un albarán por pedido y entrega: el reparto reparte, no duplica documentos.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_albaran_entrega
  ON albaranes (delivery_id) WHERE delivery_id IS NOT NULL AND status <> 'VOID';

-- El historial se escribe solo. Si alguien cambia el estado por SQL a mano, el
-- evento queda registrado igual.
CREATE OR REPLACE FUNCTION fn_albaran_registra_evento() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO albaran_events (albaran_id, event, user_id, user_name)
    VALUES (NEW.id, 'CREATED', NEW.created_by,
            (SELECT username FROM users WHERE id = NEW.created_by));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO albaran_events (albaran_id, event, user_id, user_name, detail)
    VALUES (NEW.id,
            CASE NEW.status WHEN 'PRINTED' THEN 'PRINTED' WHEN 'SIGNED' THEN 'SIGNED'
                            WHEN 'DELIVERED' THEN 'DELIVERED' WHEN 'VOID' THEN 'VOID'
                            ELSE 'CREATED' END,
            COALESCE(NEW.delivered_by, NEW.created_by, NEW.printed_by),
            (SELECT username FROM users WHERE id =
              COALESCE(NEW.delivered_by, NEW.created_by, NEW.printed_by)),
            jsonb_build_object('estado_anterior', OLD.status, 'estado_nuevo', NEW.status));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_albaran_evento ON albaranes;
CREATE TRIGGER trg_albaran_evento
  AFTER INSERT OR UPDATE ON albaranes
  FOR EACH ROW EXECUTE FUNCTION fn_albaran_registra_evento();

-- ─── 4 · La firma se guarda como imagen, no como una URL de adivinación ────
-- Un data-URL dentro de un TEXT es un desastre esperando: no se puede
-- verificar, ni indexar, ni recuperar sin parsear HTML a mano. Aquí la firma
-- es el binario, con su hash, y siempre cuelga de un albarán.
CREATE TABLE IF NOT EXISTS delivery_signatures (
  id                BIGSERIAL PRIMARY KEY,
  albaran_id        INTEGER NOT NULL UNIQUE REFERENCES albaranes(id) ON DELETE CASCADE,
  delivery_id       INTEGER REFERENCES deliveries(id) ON DELETE CASCADE,
  content_type      TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg')),
  image             BYTEA NOT NULL
                    CHECK (octet_length(image) BETWEEN 200 AND 262144),
  width             INTEGER CHECK (width IS NULL OR (width BETWEEN 1 AND 4000)),
  height            INTEGER CHECK (height IS NULL OR (height BETWEEN 1 AND 4000)),
  sha256            TEXT NOT NULL,
  signer_name       TEXT,
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS signature_id INTEGER
  REFERENCES delivery_signatures(id) ON DELETE SET NULL;

COMMENT ON TABLE delivery_signatures IS
  'Rótulo del cliente en el albarán. La entrega no queda confirmada sin esta evidencia.';

-- Evidencia de entrega: sin firma asociada no hay entrega cerrada.
CREATE OR REPLACE FUNCTION fn_entrega_exige_firma() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'DELIVERED' THEN
    IF NEW.signature_id IS NULL THEN
      RAISE EXCEPTION
        'ENTREGA_SIN_FIRMA: no se puede cerrar la entrega % sin la firma del cliente.',
        COALESCE(NEW.code, NEW.id::text)
        USING ERRCODE = '23514';
    END IF;
    IF NEW.delivered_at IS NULL THEN
      RAISE EXCEPTION 'ENTREGA_SIN_FECHA: la entrega % no tiene fecha de recepción.', NEW.code
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entrega_exige_firma ON deliveries;
CREATE TRIGGER trg_entrega_exige_firma
  BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION fn_entrega_exige_firma();

-- ─── 5 · La cadena inversa desde la materia prima ───────────────────────────
-- La vista v_trace_backward empieza por `delivery_lines`, porque responde a
-- «este producto entregado, de qué lotes de materia prima salió». Eso está
-- bien, pero deja un agujero: si todavía no se ha entregado nada, no hay forma
-- de mirar hacia atrás desde un lote de materia prima.
--
-- Esta vista cubre ese tramo, que es el que se necesita en la fábrica:
--   LOTE DE MP → PRODUCCIÓN → LOTE DE PT → (entregas, si las hay)
CREATE VIEW v_trace_from_material AS
SELECT
  mp_lot.id            AS material_lot_id,
  mp_lot.code          AS material_lot_code,
  i_mp.sku             AS material_sku,
  i_mp.name            AS material_name,
  pm.actual_qty        AS qty_consumed,
  pm.consumed_at       AS consumed_at,
  p.id                 AS production_id,
  p.code               AS production_code,
  p.status             AS production_status,
  p.finished_at,
  r.code               AS recipe_code,
  r.version            AS recipe_version,
  r.name               AS recipe_name,
  pt_lot.id            AS finished_lot_id,
  pt_lot.code          AS finished_lot_code,
  pt_lot.qty_available AS finished_qty_available,
  i_pt.sku             AS product_sku,
  i_pt.name            AS product_name,
  d.id                 AS delivery_id,
  d.code               AS delivery_code,
  d.delivered_at,
  d.status             AS delivery_status,
  so.code              AS order_code,
  c.name               AS customer_name,
  c.code               AS customer_code
FROM production_materials pm
JOIN lots mp_lot        ON mp_lot.id = pm.lot_id
JOIN items i_mp         ON i_mp.id = pm.item_id
JOIN productions p      ON p.id = pm.production_id
JOIN recipes r          ON r.id = p.recipe_id
JOIN lots pt_lot        ON pt_lot.production_id = p.id
JOIN items i_pt         ON i_pt.id = p.product_id
LEFT JOIN deliveries d  ON d.sales_order_id = p.sales_order_id
LEFT JOIN sales_orders so ON so.id = d.sales_order_id
LEFT JOIN customers c   ON c.id = so.customer_id;

COMMENT ON VIEW v_trace_from_material IS
  'Trazabilidad inversa completa desde materia prima: lote MP → producción → receta → lote de PT → entrega y cliente.';

-- El mismo tramo, pero hacia adelante desde el lote de producto terminado.
CREATE VIEW v_trace_to_material AS
SELECT
  pt_lot.id            AS finished_lot_id,
  pt_lot.code          AS finished_lot_code,
  pt_lot.created_at    AS manufactured_at,
  p.id                 AS production_id,
  p.code               AS production_code,
  r.code               AS recipe_code,
  r.version            AS recipe_version,
  i_pt.sku             AS product_sku,
  i_pt.name            AS product_name,
  mp_lot.id            AS material_lot_id,
  mp_lot.code          AS material_lot_code,
  i_mp.sku             AS material_sku,
  i_mp.name            AS material_name,
  pm.actual_qty        AS qty_consumed,
  mp_lot.received_at   AS material_received_at,
  sup.name             AS supplier_name,
  sup.country          AS supplier_country,
  mp_lot.invoice_ref,
  mp_lot.created_by    AS received_by,
  u.username           AS received_by_name
FROM lots pt_lot
JOIN productions p         ON p.id = pt_lot.production_id
JOIN recipes r             ON r.id = p.recipe_id
JOIN items i_pt            ON i_pt.id = p.product_id
JOIN production_materials pm ON pm.production_id = p.id
JOIN lots mp_lot           ON mp_lot.id = pm.lot_id
JOIN items i_mp            ON i_mp.id = pm.item_id
LEFT JOIN suppliers sup    ON sup.id = mp_lot.supplier_id
LEFT JOIN users u          ON u.id = mp_lot.created_by;

COMMENT ON VIEW v_trace_to_material IS
  'Lote de producto terminado → producción → receta → lotes de materia prima, con la recepción de cada uno y quién la hizo.';
