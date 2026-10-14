-- Quién archivó cada cliente, cuándo y por qué. Sin estas tres columnas, la
-- pregunta «¿por qué este cliente no sale?» no tiene respuesta dentro de seis
-- meses, y es la primera que se hace.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at     timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_by     integer REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archive_reason  text;

-- Un cliente archivado no puede recibir pedidos nuevos. Esto NO es una
-- costumbre de la aplicación: es una regla de la base, y así no se puede
-- saltarse por la puerta de atrás, desde un script o desde una ruta nueva.
CREATE OR REPLACE FUNCTION fn_cliente_archivado_no_pide() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  activo boolean;
BEGIN
  SELECT is_active INTO activo FROM customers WHERE id = NEW.customer_id;
  IF activo IS FALSE THEN
    RAISE EXCEPTION 'El cliente % está archivado: no admite pedidos nuevos',
      (SELECT code FROM customers WHERE id = NEW.customer_id)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cliente_archivado ON sales_orders;
CREATE TRIGGER trg_cliente_archivado BEFORE INSERT ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION fn_cliente_archivado_no_pide();

-- Y tampoco vale lo mismo para las líneas: un pedido con una línea de un
-- cliente vivo y otra de uno archivado es un pedido mal formado.
--
-- Se escribe con EXISTS y SIN variables. La versión anterior con `cid integer`
-- y `SELECT ... INTO` fallaba al aplicar con un error de tipos de plpgsql que
-- no dice nada útil, y —peor que el error— dejaba el servidor sin arrancar
-- entero, porque un fallo al crear el disparador tumba la migración.
CREATE OR REPLACE FUNCTION fn_linea_cliente_archivado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sales_order_lines l
      JOIN sales_orders o ON o.id = l.sales_order_id
      JOIN customers c   ON c.id = o.customer_id
     WHERE l.sales_order_id = NEW.sales_order_id
       AND c.is_active = false
  ) THEN
    RAISE EXCEPTION
      'No se pueden añadir líneas a un pedido de un cliente archivado'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_linea_cliente_archivado ON sales_order_lines;
CREATE TRIGGER trg_linea_cliente_archivado BEFORE INSERT ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION fn_linea_cliente_archivado();
