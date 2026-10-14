-- ═══════════════════════════════════════════════════════════════════════════
-- 039 · UN SOLO SIGNIFICADO, Y UN SOLO NOMBRE, PARA EL COMERCIAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL LÍO, QUE ERAN DOS
--
-- Dos espacios de identificadores para lo mismo:
--
--     users.id           el usuario que entra con contraseña
--     com_perfiles.id    el perfil comercial
--
-- Y `comercial_id` significaba una cosa u otra según dónde:
--
--     com_visitas.comercial_id          → com_perfiles.id   ✓
--     com_puntos.comercial_id          → com_perfiles.id   ✓
--     com_comercial_zonas.comercial_id → com_perfiles.id   ✓
--     customers.commercial_id          → users.id          ✗
--     sales_orders.commercial_id       → users.id          ✗
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- Y NO ERA SOLO EL SIGNIFICADO: TAMBIÉN EL NOMBRE
--
--     com_visitas.comercial_id     una «m»
--     customers.commercial_id      dos «m»
--
-- La columna inglesa y la española se parecían mucho y no eran la misma. Y
-- eso tiene consecuencias que no son de estilo: una comprobación como
-- `WHERE attname LIKE '%comercial_id'` —que es como se comprueba que todas las
-- columnas de comercial apuntan al sitio correcto— no encuentra la inglesa, y
-- da por bueno un esquema donde media tabla cuelga de otra.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE HACE
--
--   1 · `commercial_id` → `comercial_id` en clientes y pedidos.
--   2 · Las dos columnas pasan a apuntar a `com_perfiles.id`.
--
-- `users.id` se queda donde sí tiene sentido: en `created_by`,
-- `updated_by` y compañía, que preguntan por la persona que TECLEÓ, no por el
-- comercial. Eso no se toca.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ NO SE MUEVE NI UNA FILA
--
-- Las dos columnas están a cero. Se sueltan las claves foráneas, se cambia el
-- nombre, se re-apuntan. Antes de tocar nada se comprueba que están vacías; si
-- algún día tuvieran datos, esto se para y lo dice, en vez de convertir un
-- repartidor en comercial sin que nadie lo pidiera.

DO $$
DECLARE
  clientes_con_comercial int;
  pedidos_con_comercial  int;
BEGIN
  SELECT count(*) INTO clientes_con_comercial FROM customers  WHERE commercial_id IS NOT NULL;
  SELECT count(*) INTO pedidos_con_comercial  FROM sales_orders WHERE commercial_id IS NOT NULL;

  IF clientes_con_comercial > 0 OR pedidos_con_comercial > 0 THEN
    RAISE EXCEPTION
      'Hay % clientes y % pedidos con comercial. Hay que traducirlos antes; esta migracion solo renombra.', clientes_con_comercial, pedidos_con_comercial;
  END IF;

  -- ─── 1 · Renombrar ──────────────────────────────────────────────────────

  ALTER TABLE customers   RENAME COLUMN commercial_id TO comercial_id;
  ALTER TABLE sales_orders RENAME COLUMN commercial_id TO comercial_id;

  -- ─── 2 · Apuntar al perfil, no al usuario ───────────────────────────────
  --
  -- Con esto, un cliente no puede llevar «al comercial» el id de un cajero o
  -- de un repartidor: la clave foránea no lo permite. Y un comercial al que
  -- se le da de baja se queda sin comercial, no con un cliente colgando.

  ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_commercial_id_fkey;
  ALTER TABLE customers ADD CONSTRAINT customers_comercial_id_fkey
    FOREIGN KEY (comercial_id) REFERENCES com_perfiles(id) ON DELETE SET NULL;

  ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_commercial_id_fkey;
  ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_comercial_id_fkey
    FOREIGN KEY (comercial_id) REFERENCES com_perfiles(id) ON DELETE SET NULL;

  -- Y el índice que acompaña a la columna, para que buscar «los clientes de
  -- este comercial» no sea recorrer la tabla entera.
  CREATE INDEX IF NOT EXISTS idx_customers_comercial ON customers (comercial_id);
  CREATE INDEX IF NOT EXISTS idx_sales_orders_comercial ON sales_orders (comercial_id);
END $$;

-- ─── Comprobación ───────────────────────────────────────────────────────────
--
-- Que TODA columna de comercial de toda la base apunte a `com_perfiles`.
--
-- Se pregunta a `pg_constraint` y NO a `information_schema`: este último lee
-- de una instantánea de estadísticas que se refresca cada cierto tiempo, y
-- acabamos de cambiar el esquema. Preguntarle por lo recién creado es
-- preguntarle a una foto anterior a la foto.
--
-- Y se buscan las DOS grafías, `comercial_id` y `commercial_id`, precisamente
-- porque esta comprobación es la que tiene quepillar ese descuido la próxima
-- vez. Si busca solo una, no sirve para nada.

DO $$
DECLARE
  malos  int;
  buena  int;
  viejas int;
BEGIN
  SELECT count(*) INTO buena
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_class     d ON d.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f'
     AND (a.attname = 'comercial_id' OR a.attname = 'commercial_id')
     AND d.relname = 'com_perfiles';

  -- Se excluyen a propósito las tres tablas VIEJAS. Sus columnas siguen
  -- apuntando a `users`, y eso se decide más adelante: no se tocan porque
  -- estén vacías, sino cuando se compruebe que ninguna parte de la aplicación
  -- las usa. While tanto, se cuentan aparte y se avisa, para que no desaparezcan
  -- de la lista.
  --
  -- Si mañana apareciera una CUARTA columna mal puesta, esta cuenta la ve:
  -- lo que no está en la lista de viejas, tiene que estar bien.
  SELECT count(*) INTO malos
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_class     d ON d.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f'
     AND (a.attname = 'comercial_id' OR a.attname = 'commercial_id')
     AND d.relname <> 'com_perfiles'
     AND t.relname NOT IN ('visits', 'commercial_targets', 'commercial_points');

  IF malos > 0 THEN
    RAISE EXCEPTION 'Hay % claves de comercial que NO apuntan a com_perfiles. Repartidas en dos mundos otra vez.', malos;
  END IF;

  SELECT count(*) INTO viejas FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_class     d ON d.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f'
     AND (a.attname = 'comercial_id' OR a.attname = 'commercial_id')
     AND d.relname <> 'com_perfiles'
     AND t.relname IN ('visits', 'commercial_targets', 'commercial_points');

  -- com_comercial_idiomas, com_comercial_zonas, com_objetivos, com_puntos,
  -- com_visitas, customers y sales_orders.
  IF buena <> 7 THEN
    RAISE EXCEPTION 'Solo % columnas de comercial apuntan a com_perfiles; se esperaban 7.', buena;
  END IF;

  -- Y que no quede ninguna COLUMNA con la grafía antigua, salvo en las tres
  -- tablas viejas, que se quedan como están hasta que se decida su futuro.
  -- Se mira `table_type = 'BASE TABLE'` a propósito: hay dos vistas viejas
  -- más que exponen la columna antigua, y una vista no es un sitio donde se
  -- guarde nada. Si mañana aparece una CUARTA columna, esta la ve.
  IF EXISTS (SELECT 1
               FROM information_schema.columns c
               JOIN information_schema.tables t
                 ON t.table_schema = c.table_schema AND t.table_name = c.table_name
              WHERE c.table_schema = 'public' AND c.column_name = 'commercial_id'
                AND t.table_type = 'BASE TABLE'
                AND c.table_name NOT IN ('visits','commercial_targets','commercial_points')) THEN
    RAISE EXCEPTION 'Queda alguna COLUMNA con la grafía antigua commercial_id fuera de las tablas viejas.';
  END IF;

  IF viejas <> 3 THEN
    RAISE NOTICE 'Atencion: quedan % columnas viejas (vacias) apuntando a users, en vez de las 3 previstas.', viejas;
  END IF;

  RAISE NOTICE '% columnas de comercial a com_perfiles. % viejas y vacias, apartadas a la espera. Ni una con la grafía antigua.', buena, viejas;
END $$;
