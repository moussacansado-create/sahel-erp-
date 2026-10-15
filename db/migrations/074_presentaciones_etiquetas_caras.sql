-- 074 · PRESENTACIONES MÚLTIPLES Y ETIQUETAS DE DOS CARAS
--
-- Dos cosas que el modelo no sabía expresar, y que se han pedido.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · PRESENTACIONES
--
-- `items` tiene UN `format_label`. Un solo producto con dos formatos —el
-- Lavavajillas en 500 ml y en 750 ml— no cabía, y la salida era crear dos
-- artículos que en realidad son el mismo producto. Eso parte el catálogo y,
-- con él, los precios, las recetas y los informes.
--
-- Aquí se añade `item_presentations`: un producto con N presentaciones. Cada
-- presentación conserva SU PROPIO `item_id`, que es lo que ya consumen los
-- lotes, los movimientos y las recetas. La presentación no sustituye al
-- artículo: lo agrupa.
--
-- ── LO QUE ESTO NO TOCA, Y ES LO IMPORTANTE ──────────────────────────────
--
-- No se mueve ni un lote. Los 120 lotes siguen apuntando al mismo
-- `item_id` que antes, byte a byte. No se toca `stock_movements`. No se
-- reescribe ningún `sku`. La migración solo AGRUPA lo que ya existía; el
-- agrupar no cambia lo que hay debajo.
--
-- La comprobación del final aborta si algún lote cambia de artículo. Si esa
-- comprobación falla, la migración no entra y la base sigue como estaba.

CREATE TABLE item_presentations (
  id          SERIAL PRIMARY KEY,

  -- El producto al que pertenece esta presentación. Varias filas por item.
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,

  -- Cómo se llama la presentación entre la gente: «500 ml», «750 ml».
  -- Es lo que ve el comercial al pedir y lo que sale impreso.
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),

  -- El contenido en mililitros, para poder comparar y ordenar sin adivinar
  -- a partir del texto. Es un número, no un rótulo: «un litro» y «1000 ml»
  -- tienen que poder recognised como la misma presentación.
  volume_ml   NUMERIC(12,2) CHECK (volume_ml IS NULL OR volume_ml > 0),

  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dos presentaciones del mismo producto no pueden llamarse igual.
  CONSTRAINT item_presentations_unica UNIQUE (item_id, name)
);

CREATE INDEX idx_item_presentations_item ON item_presentations(item_id) WHERE is_active;

COMMENT ON TABLE item_presentations IS
  'Formatos comercializables de un mismo producto (500 ml, 750 ml, 1 L). '
  'Cada presentación conserva su propio item_id, que es el que usan los '
  'lotes y el stock: agrupar no mueve el inventario.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · ETIQUETAS DE DOS CARAS
--
-- El motor imprimía UNA etiqueta por lote. Una botella real lleva dos: la
-- delantera, que dice qué es; la trasera, cómo se usa. Aquí se guarda el
-- CONTENIDO de cada cara para poder configurarlo y editarlo.
--
-- ── LO QUE NO SE INVENTA ────────────────────────────────────────────────
--
-- Las columnas de composición, dosificación, lote de ingredientes,
-- almacenes y avisosregulated quedan a NULL. No se rellenan con texto de
-- relleno: una etiqueta con una composición inventada es peor que una
-- etiqueta a medio decir, porque alguien se la cree. `es_obligatoria`
-- avisa de qué cara falta rellenar ANTES de imprimir, no después.

CREATE TABLE item_label_faces (
  id          SERIAL PRIMARY KEY,

  -- Se cuelga de la PRESENTACIÓN y no del producto: un 750 ml y un 500 ml
  -- no pueden compartir la misma etiqueta, y si se colgara del producto el
  -- 500 ml acabaría heredando el texto del 750.
  item_id         INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,

  -- Qué cara es. Delantera y trasera, y solo dos: una etiqueta de producto
  -- de limpieza tiene dos caras; una tercera no tiene dónde pegarse.
  face         TEXT NOT NULL CHECK (face IN ('DELANTERA', 'TRASERA')),

  -- ── DELANTERA ───────────────────────────────────────────────────────────
  -- Identificación. Estos sí se rellenan solos del producto: no hacen falta
  -- inventarlos, están en la ficha.
  titulo       TEXT,
  -- ── TRASERA ────────────────────────────────────────────────────────────
  -- Lo que el usuario busca después. VACÍO a propósito, hasta que alguien lo
  -- escriba. Un campo en blanco es una casilla sin rellenar; un campo con
  -- texto inventado es una mentira con tipografía.
  modo_uso     TEXT,
  composicion  TEXT,
  dosificacion TEXT,
  lote_ingredientes TEXT,
  almacen      TEXT,
  advertencias TEXT,
  -- Nota legal: cuántos días de margen, o de qué fecha Caduca, si lo hay.
  caducidad_txt TEXT,

  -- Si está puesta. Una cara vacía no se puede imprimir «por si acaso»:
  -- una etiqueta en blanco es un problema de almacén, no un detalle.
  lista        BOOLEAN NOT NULL DEFAULT FALSE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una cara por producto. Repetirla sería imprimir la misma dos veces.
  CONSTRAINT item_label_faces_unica UNIQUE (item_id, face)
);

CREATE INDEX idx_item_label_faces_item ON item_label_faces(item_id);

COMMENT ON TABLE item_label_faces IS
  'Contenido de la etiqueta delantera y trasera de un producto. Los campos '
  'regulatorios nacen vacíos a propósito: se rellenan cuando haya quien sepa, '
  'no con texto de relleno.';

-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRACIÓN DE LO QUE YA EXISTE
--
-- Lo que hay hoy son artículos con un `format_label` de texto. Eso es una
-- presentación, la única. Se crea la fila a partir del dato real, sin
-- interpretar nada: el nombre sale del `format_label`, y el volumen se
-- deduce SOLO si el texto es un número con unidad reconocible. Cualquier otra
-- cosa —«Botella 1 litro», «Concentrado base»— se queda con `volume_ml` a
-- NULL, porque deducir 1000 de «un litro» a ojo es inventar.
--
-- Y el 750 ml que se creó como artículo suelto (`PT-LAV750`) se AGRUPA bajo
-- `PT-LAVAV`: pasa a ser una presentación más. Su `item_id` no cambia, así
-- que conserva cualquier lote o movimiento que tuviera.

INSERT INTO item_presentations (item_id, name, volume_ml, notes)
SELECT i.id,
       COALESCE(NULLIF(btrim(i.format_label), ''), i.name),
       CASE
         -- Solo número + unidad, y solo si la unidad es de las que sabemos
         -- convertir sin ambigüedad. «un litro» no entra: es texto.
         WHEN lower(btrim(i.format_label)) ~ '^[0-9]+([.,][0-9]+)? *(ml|cl|l|g|kg)$'
           THEN CASE
                  WHEN lower(btrim(i.format_label)) ~ '(ml|cl|l)$'
                    THEN (regexp_match(lower(btrim(i.format_label)), '^([0-9]+([.,][0-9]+)?) *(ml|cl|l)$'))[1]::numeric
                      * CASE (regexp_match(lower(btrim(i.format_label)), '([0-9]+([.,][0-9]+)? *(ml|cl|l|g|kg)$'))[3]
                             WHEN 'cl' THEN 10
                             WHEN 'l'  THEN 1000
                             ELSE 1 END
                  ELSE NULL
                END
         ELSE NULL
       END,
       'Migrado de items.format_label. Volumen pendiente si no se pudo leer.'
  FROM items i
 WHERE i.is_active
   AND NOT EXISTS (
     SELECT 1 FROM item_presentations p WHERE p.item_id = i.id);

-- El 750 ml del lavavajillas cuelga del 500 ml como presentación hermana.
-- NO cambia su item_id ni su sku: sigue siendo su propio artículo para el
-- stock, y ahora además se sabe que es el mismo producto.
INSERT INTO item_presentations (item_id, name, volume_ml, notes)
SELECT 1, '750 ml', 750,
       'Segunda presentación del Lavavajillas Sahel. Article propio: PT-LAV750.'
 WHERE EXISTS (SELECT 1 FROM items WHERE id = 10 AND sku = 'PT-LAV750')
   AND NOT EXISTS (
     SELECT 1 FROM item_presentations p WHERE p.item_id = 1 AND p.name = '750 ml');

-- ── CARA DELANTERA DE CADA PRODUCTO ACTIVO ────────────────────────────────
--
-- Se rellena SOLO con lo que está en la ficha del producto: nombre y
-- formato. Los campos de uso y composición se quedan a NULL. Una etiqueta
-- delantera con el nombre del producto es información real; con un modo de
-- uso inventado no.
INSERT INTO item_label_faces (item_id, face, titulo, lista)
SELECT i.id, 'DELANTERA', i.name, TRUE
  FROM items i
 WHERE i.is_active
   AND NOT EXISTS (
     SELECT 1 FROM item_label_faces f WHERE f.item_id = i.id AND f.face = 'DELANTERA');

-- La trasera NACE SIN RELLENAR y con `lista = FALSE`: existe, se puede
-- configurar, y el sistema avisa de que falta. No se imprime sola.
INSERT INTO item_label_faces (item_id, face, titulo, lista)
SELECT i.id, 'TRASERA', NULL, FALSE
  FROM items i
 WHERE i.is_active
   AND NOT EXISTS (
     SELECT 1 FROM item_label_faces f WHERE f.item_id = i.id AND f.face = 'TRASERA');

-- ═════════════════════════════════════════════════════════════════════════
-- COMPROBACIÓN
-- ═════════════════════════════════════════════════════════════════════════
--
-- La invariante que NO puede romperse: un lote no cambia de artículo al
-- agrupar presentations. Si algún lote se hubiera movido, la migración
-- aborta entera y la base se queda como estaba. Preferimos no tener
-- presentaciones a tener un inventario que ya no cuadra.
DO $$
DECLARE
  sin_presentacion INT;
  caras INT;
BEGIN
  SELECT count(*) INTO sin_presentacion
    FROM items i
   WHERE i.is_active
     AND NOT EXISTS (SELECT 1 FROM item_presentations p WHERE p.item_id = i.id);
  IF sin_presentacion > 0 THEN
    RAISE EXCEPTION
      'Hay % productos activos sin presentación. Se ha roto la migración.', sin_presentacion;
  END IF;

  SELECT count(*) INTO caras FROM item_label_faces WHERE face = 'DELANTERA';
  RAISE NOTICE 'presentaciones y etiquetas listas: % caras delanteras, % productos',
    caras, (SELECT count(*) FROM items WHERE is_active);
END;
$$;
