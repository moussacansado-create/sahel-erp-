-- ─────────────────────────────────────────────────────────────────────────────
--  065 · SINCRONIZACIÓN ENTRE DISPOSITIVOS
-- ─────────────────────────────────────────────────────────────────────────────
--
--  Dos cosas, y las dos son estructura, no datos:
--
--  1. UN REGISTRO DE CAMBIOS (`cambios`). Un disparador en cada tabla de
--     negocio escribe una fila por cada escritura. No guarda QUÉ se escribió:
--     guarda que ALGO se escribió. Eso es deliberado —lo que viaja al otro
--     dispositivo es una señal, y los datos vuelve a pedirlos cada quien con
--     su sesión y sus permisos, que es lo único que garantiza que un comercial
--     no vea por el canal de sincronización lo que no puede ver por la API—.
--
--  2. UN NÚMERO DE VERSIÓN en las tablas que se pueden editar. Con eso, dos
--     personas que editan el mismo cliente a la vez: la segunda que llega con
--     la versión antigua recibe un 409 en vez de pisar a la primera sin
--     enterarse. Es lo que se llama bloqueo optimista, y es lo correcto aquí:
--     un almacén no es un sistema distribuido, es una oficina con cuatro
--     móviles.
--
--  POR QUÉ DISPARADORES Y NO CÓDIGO DE APLICACIÓN
--
--  Porque un disparador no se olvida. Si mañana alguien añade una escritura
--  desde una ruta nueva y no se acuerda de avisar, con disparadores el otro
--  móvil se entera igual. Con código, se entera de los que el programador
-- CAE EN RECORDAR. Los datos de la aplicación antiguamouse no.

CREATE TABLE IF NOT EXISTS cambios (
  id         bigserial PRIMARY KEY,
  tabla      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cambios_id ON cambios (id);

-- El registro crece sin parar si nadie lo limpia. Se conserva una ventana:
-- bastante para que un dispositivo que estuvo horas sin conexión alcance a
-- ver lo que se ha perdido, y no tanto como para que la tabla se vuelva un
-- problema por sí misma.
CREATE OR REPLACE FUNCTION fn_purgar_cambios() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cambios WHERE id < (SELECT max(id) - 2000 FROM cambios);
END $$;

-- ── El disparador, el mismo para todas ──────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_anotar_cambio() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t text := TG_TABLE_NAME;
BEGIN
  INSERT INTO cambios (tabla) VALUES (t);
  RETURN NULL;   -- AFTER: el valor de retorno se ignora
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'customers', 'sales_orders', 'sales_order_lines', 'items', 'lots',
      'stock_movements', 'productions', 'production_materials', 'recipes',
      'recipe_lines', 'cash_sessions', 'cash_movements', 'payments',
      'albaranes', 'deliveries', 'com_visitas', 'com_incidencias',
      'com_seguimientos', 'com_puntos', 'users', 'app_config'
    ])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_cambio ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_cambio AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION fn_anotar_cambio()', t);
  END LOOP;
END $$;

-- ── Versiones, para el control de conflictos ────────────────────────────────
-- La función va ANTES del bucle que la usa. Escrita al revés, el primer
-- `CREATE TRIGGER` falla con «function does not exist» y la migración se
-- queda a medias, con las columnas puestas y los disparadores no.
CREATE OR REPLACE FUNCTION fn_subir_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Solo sube si el cliente NO la ha cambiado a propósito. Si la ha cambiado,
  -- es el servidor quien la puso: la ha comprobado y ha rechazado por conflicto.
  IF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION fn_subir_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Solo sube si el cliente NO la ha cambiado a propósito. Si la ha cambiado,
  -- el servidor la ha puesto: la ha comprobado y ha rechazado por conflicto.
  IF NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;


-- Solo en lo que se EDITA desde la aplicación. `lots` y `stock_movements` se
-- escriben por movimiento de inventario, no por edición, y no necesitan reloj.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['customers','sales_orders','items','users','app_config'])
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_version ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_version BEFORE UPDATE ON %I
       FOR EACH ROW WHEN (NEW.version = OLD.version)
       EXECUTE FUNCTION fn_subir_version()', t);
  END LOOP;
END $$;
