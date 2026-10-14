-- ═════════════════════════════════════════════════════════════════════════════
-- 029 · LA CLAVE QUE LE FALTA A com_comercial_zonas
--
-- Migration independiente. No toca la 028 ni ninguna de las verificadas.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EL PROBLEMA
--
-- `com_comercial_zonas` se creó en la 028 como tabla de enlace, con clave
-- compuesta `PRIMARY KEY (comercial_id, zona_id, desde)`. Un enlace N a M de
-- verdad no necesita una columna `id` propia: la pareja ya es única.
--
-- El problema es que TODO lo demás espera una:
--
--   · `confirmarGuardado()`, que relee lo que una operación dice haber
--     guardado, busca por `WHERE id = $1`;
--
--   · `com_puntos`, que es exactamente la misma forma de tabla, SÍ lleva id;
--
--   · y `audit_log.entity_id`, que es una única columna de texto y no tiene
--     por qué coincidir con nada.
--
-- Resultado: al dar de alta un comercial en una zona, la escritura se hacía
-- bien y la COMPROBACIÓN de que se había hecho bien fallaba con
-- «column "id" does not exist». El sistema se negaba a confirmar un alta que
-- ya estaba en la base.
--
-- ─────────────────────────────────────────────────────────────────────────────
--
-- LA DECISIÓN
--
-- Añadir un `id`generated` en vez de cambiar las claves. Y es la decisión que
-- menos rompe:
--
--   · `PRIMARY KEY (comercial_id, zona_id, desde)` SE QUITA, y el `id` pasa a
--     ser la clave primaria. El índice único `uniq_comercial_zona` que impide
--     la zona repetida **se queda igual**, con la misma firma. Los dos índices
--     parciales `uniq_comercial_zona_principal` y `uniq_zona_responsable`
--     **no se tocan**: son los que garantizan un responsable por zona y una
--     principal por comercial, y quedan exactamente igual de fuertes.
--
--   · Lo que se pierde es poder更新 la fila por su clave natural. No lo usa
--     nadie: `com_comercial_zonas` se lee por `(comercial_id, zona_id)`.
--
-- El `GENERATED ALWAYS AS IDENTITY` hace que el id lo ponga la base y no
-- pueda haber dos filas con el mismo. Un `SERIAL` también valdría, pero
-- deja que alguien escriba un id a mano, y eso es una puerta que no hace
-- falta abrir.
--
-- ───────────────────────────────────────────────────────────────────────────────

ALTER TABLE com_comercial_zonas
  ADD COLUMN IF NOT EXISTS id INTEGER GENERATED ALWAYS AS IDENTITY;

-- El `id` pasa a ser la clave primaria. Para ello tiene que ser NOT NULL, y
-- una columna IDENTITY ya lo es, pero se dice explícitamente para que el
-- `ADD COLUMN` no dependa de esa Implementación de PostgreSQL.
ALTER TABLE com_comercial_zonas
  ALTER COLUMN id SET NOT NULL;

--
-- La clave compuesta que había en la 028 NO se llamaba «pkey» sino
-- «uniq_comercial_zona», porque se declaró como UNIQUE y no como PRIMARY KEY.
-- Se suelta con un bloque DO que la busca por su DEFINICIÓN y no por su
-- nombre: si se equivoca el nombre, `DROP CONSTRAINT` dice «does not exist» y
-- no dice quéconstraintqttaba buscando.
--
DO $$
DECLARE v_nombre TEXT;
BEGIN
  SELECT conname INTO v_nombre
    FROM pg_constraint
   WHERE conrelid = 'com_comercial_zonas'::regclass
     AND contype = 'u'
     AND conkey = ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'com_comercial_zonas'::regclass AND attname = 'comercial_id'),
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'com_comercial_zonas'::regclass AND attname = 'zona_id'),
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'com_comercial_zonas'::regclass AND attname = 'desde')
     ]::smallint[];

  IF v_nombre IS NULL THEN
    RAISE EXCEPTION
      'No encuentro la clave (comercial_id, zona_id, desde) en com_comercial_zonas. '
      'La 029 da por hecho que existe; si el esquema ha cambiado, hay que revisar.';
  END IF;

  EXECUTE format('ALTER TABLE com_comercial_zonas DROP CONSTRAINT %I', v_nombre);
  RAISE NOTICE 'suelta la clave compuesta %', v_nombre;
END $$;

-- Con ella suelta, el `id` puede ser la clave primaria. La regla de «un
-- comercial no lleva dos veces la misma zona» la pone el índice único de
-- abajo, con EXACTAMENTE la misma firma que tenía antes.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comercial_zona
  ON com_comercial_zonas(comercial_id, zona_id, desde);

ALTER TABLE com_comercial_zonas ADD PRIMARY KEY (id);

-- Buscar por id es lo que hace `confirmarGuardado()` en cada alta. Sin este
-- índice, cada comprobación es un recorrido de la tabla.
CREATE INDEX IF NOT EXISTS idx_com_comercial_zonas_id ON com_comercial_zonas(id);

-- Y las tres reglas queVINieron en la 028 siguen intactas, ahora con la
--Comprobación de que se han conservado.
DO $$
DECLARE
  v_principal_com INT;
  v_responsable INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_comercial_zona_principal') THEN
    RAISE EXCEPTION 'se ha perdido uniq_comercial_zona_principal: una zona podría tener dos responsables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_zona_responsable') THEN
    RAISE EXCEPTION 'se ha perdido uniq_zona_responsable: un comercial podría tener dos principales';
  END IF;
  -- `uniq_comercial_zona` ahora es un ÍNDICE, no una restricción: `CREATE UNIQUE
  -- INDEX` y `ADD CONSTRAINT UNIQUE` crean cosas distintas en el catálogo, y
  -- la comprobación tenía que mirar en `pg_indexes`, no en `pg_constraint`.
  -- Las dos sirven para el mismo propósito; lo que se comprueba aquí es que la
  -- regla siga puesta, no dónde vive.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE tablename = 'com_comercial_zonas'
                    AND indexname = 'uniq_comercial_zona'
                    AND indexdef LIKE '%UNIQUE%') THEN
    RAISE EXCEPTION
      'se ha perdido uniq_comercial_zona: un comercial podría llevar dos veces la misma zona';
  END IF;

  RAISE NOTICE 'com_comercial_zonas: id añadida, las tres reglas de la 028 siguen puestas';
END $$;