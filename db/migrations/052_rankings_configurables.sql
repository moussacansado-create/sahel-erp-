-- ══════════════════════════════════════════════════════════════════════════════
-- 052 · RANKINGS Y REGLAS CONFIGURABLES DESDE LA APLICACIÓN
--
-- Hasta ahora los puntos eran cuatro reglas FIJAS en el código: por visita, por
-- pedido, por cliente y por objetivo. Cambiar un punto exigía pedir un cambio y
-- esperar un despliegue. Eso no es configurable: es esculpido.
--
-- Aquí una COMPETICIÓN (`com_rankings`) es un contenedor de reglas con su propio
-- nombre, propósito, fechas y estado. Cada regla dice qué EVENTO da puntos,
-- cuántos, si es por unidad o al alcanzar un umbral, y en qué periodo.
--
-- ── LO QUE NO SE TOCA ────────────────────────────────────────────────────────
-- · Las cuatro reglas que ya existen NO se borran ni se reescriben. Se les
--   cuelga una competición «General» y siguen dando exactamente los mismos
--   puntos que hasta ahora. Cambiar de sitio no es cambiar de valor.
-- · `com_puntos` conserva sus 5 filas. Desactivar una regla es ponerla a
--   descansar, no borrar lo ya ganado: quien consiguió 17 puntos sigue
--   teniendo 17 aunque luego la regla se apague.
-- · No se recalcula ni un punto antiguo al editar una regla. Los puntos ya
--   concedidos son hechos, no opiniones. Si una regla cambia, vale desde su
--   `vigente_desde` y solo para lo que venga después.
-- · El índice `uniq_com_puntos_evento` sigue siendo el que impide que un mismo
--   evento puntee dos veces. No se afloja ni un punto.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS com_rankings_id_seq;

-- ── COMPETICIONES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS com_rankings (
  id            integer PRIMARY KEY DEFAULT nextval('com_rankings_id_seq'),
  code          text NOT NULL UNIQUE,
  nombre        text NOT NULL,
  -- Para qué sirve, en lenguaje llano: lo lee el jefe comercial, no el
  -- programador. «Premiar a quien abre puertas nuevas», no «incentivar
  -- captación».
  proposito     text,
  descripcion   text,
  -- Qué se premia. Es lo que la pantalla enseña arriba del todo.
  que_premia    text,
  vigente_desde date NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = abierta. Con fecha de fin es una campaña; sin ella, el ranking de
  -- siempre.
  vigente_hasta date,
  -- ACTIVA se usa; PAUSADA se explica sola (deja de contar pero no desaparece);
  -- DESACTIVADA es el cierre histórico.
  estado        text NOT NULL DEFAULT 'ACTIVA'
                  CHECK (estado IN ('ACTIVA','PAUSADA','DESACTIVADA')),
  creado_por    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  actualizado_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE com_rankings IS
  'Competiciones comerciales. Cada una agrupa sus propias reglas y no comparte '
  'configuración con las demás: cambiar una no toca la otra.';

-- ── REGLAS: LO QUE FALTA PARA PODERLAS CONFIGURAR ───────────────────────────
-- Se AÑADEN columnas. No se altera ninguna de las que ya estaban, para que las
-- cuatro reglas existentes se sigan leyendo exactamente igual.
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS ranking_id   integer REFERENCES com_rankings(id);
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS tipo_regla   text NOT NULL DEFAULT 'UNIDAD';
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS cantidad     numeric;
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS periodo      text NOT NULL DEFAULT 'NINGUNO';
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS acumulativo  boolean NOT NULL DEFAULT true;
-- Desde cuándo vale ESTA configuración. Editar una regla no reescribe el pasado:
-- lo de antes se queda con los puntos que se le dieron entonces.
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS vigente_desde date NOT NULL DEFAULT CURRENT_DATE;
-- PAUSADA no es lo mismo que DESACTIVADA. Pausada deja de contar y se puede
-- seguir; el estado heredado `is_active` es la vista binaria de las dos.
ALTER TABLE com_reglas_puntos ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'ACTIVA'
  CHECK (estado IN ('ACTIVA','PAUSADA','DESACTIVADA'));

ALTER TABLE com_reglas_puntos DROP CONSTRAINT IF EXISTS chk_regla_tipo;
ALTER TABLE com_reglas_puntos ADD CONSTRAINT chk_regla_tipo CHECK (tipo_regla IN ('UNIDAD','UMBRAL'));
ALTER TABLE com_reglas_puntos DROP CONSTRAINT IF EXISTS chk_regla_periodo;
ALTER TABLE com_reglas_puntos ADD CONSTRAINT chk_regla_periodo
  CHECK (periodo IN ('NINGUNO','MENSUAL','TRIMESTRAL','ANUAL'));

CREATE INDEX IF NOT EXISTS idx_com_reglas_ranking ON com_reglas_puntos(ranking_id);
CREATE INDEX IF NOT EXISTS idx_com_reglas_estado  ON com_reglas_puntos(estado, is_active);

COMMENT ON COLUMN com_reglas_puntos.tipo_regla IS
  'UNIDAD = puntos por cada evento. UMBRAL = puntos una vez al alcanzar `cantidad`.';
COMMENT ON COLUMN com_reglas_puntos.periodo IS
  'Ventana de cálculo. NINGUNO = desde siempre. El resto recalcula por periodo.';
COMMENT ON COLUMN com_reglas_puntos.estado IS
  'ACTIVA cuenta; PAUSADA no cuenta pero se puede reanimar; DESACTIVADA es archivo. '
  'Cambiar de estado NUNCA borra los puntos ya registrados.';

-- ── COMPETICIÓN GENERAL ─────────────────────────────────────────────────────
-- Las cuatro reglas que ya existían no belonged a ninguna competición. Se
-- crean igualmente: una pantalla que liste reglas sin saber de qué
-- competición son no es una pantalla, es una lista.
INSERT INTO com_rankings (code, nombre, proposito, descripcion, que_premia, estado)
VALUES ('general', 'Clasificación general',
        'La competición de siempre: el rendimiento global del equipo.',
        'Recoge las reglas que ya existían antes de que las stringify, para que '
        'el ranking general siga contando exactamente los mismos puntos que hasta ahora.',
        'El trabajo diario del comercial: visitas, pedidos, clientes y objetivos.',
        'ACTIVA')
ON CONFLICT (code) DO NOTHING;

UPDATE com_reglas_puntos
   SET ranking_id = (SELECT id FROM com_rankings WHERE code = 'general')
 WHERE ranking_id IS NULL;

-- Las reglas heredadas: se leen como unidades (2 por visita, 5 por pedido), que
-- es lo que han hecho siempre. No se cambia ni su valor ni su sentido.
UPDATE com_reglas_puntos SET tipo_regla = 'UNIDAD', periodo = 'NINGUNO', acumulativo = true
 WHERE code IN ('por_visita','por_pedido','por_cliente');

-- El objetivo no es por unidad: es al alcanzar el umbral del periodo. Es el
-- único que necesita fecha, y por eso su fila no se ancla a un evento sino al
-- periodo.
UPDATE com_reglas_puntos SET tipo_regla = 'UMBRAL', periodo = 'MENSUAL', umbral = 100, acumulativo = false
 WHERE code = 'cumple_objetivo';

-- ── PERMISOS ────────────────────────────────────────────────────────────────
-- `rankings:view`   — mirar la clasificación y la configuración
-- `rankings:edit`   — crear y modificar competiciones y reglas
-- Los actions son los del CHECK de `permissions`: view/create/edit/delete/
-- approve/export. En inglés, porque es como está el resto y cambiarlo sería
-- otra migración para no ganar nada.
--
-- El comercial NO recibe `edit`. Ocultar el botón no basta: la API lo
-- comprueba igual.
INSERT INTO permissions (module, action) VALUES
  ('rankings','view'), ('rankings','create'), ('rankings','edit'),
  ('rankings','delete'), ('rankings','approve')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.code IN ('ADMIN','JEFE_COMERCIAL')
   AND p.module = 'rankings'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- La lectura del ranking de equipo, que es de lo poco que un COMERCIAL puede
-- ver de los demás: su posición, no sus clientes.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'COMMERCIAL' AND p.module = 'rankings' AND p.action = 'view'
ON CONFLICT (role_id, permission_id) DO NOTHING;
