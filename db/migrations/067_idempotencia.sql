-- Una clave por operación importante. Si la misma clave vuelve, la operación
-- NO se repite: se devuelve lo que se devolvió la primera vez.
CREATE TABLE IF NOT EXISTS idempotencia (
  clave       text PRIMARY KEY,
  operacion   text        NOT NULL,
  usuario_id  integer,
  status      integer     NOT NULL DEFAULT 200,
  respuesta   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Crece sola. Una clave de hace tres meses no va a volver a llegar, y guardarla
-- es guardarse basura.
CREATE OR REPLACE FUNCTION fn_purgar_idempotencia() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM idempotencia WHERE created_at < now() - interval '24 hours';
END $$;
