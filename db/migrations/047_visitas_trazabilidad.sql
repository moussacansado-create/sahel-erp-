-- ══════════════════════════════════════════════════════════════════════════════
-- 047 · TRAZABILIDAD DE LAS VISITAS: QUIÉN, QUIÉN Y PARA QUIÉN
--
-- ── EL PROBLEMA ─────────────────────────────────────────────────────────────
--
-- `com_visitas` tiene UN campo, `comercial_id`, y ese campo está haciendo dos
-- trabajos a la vez:
--
--   · QUIÉN REALIZÓ la visita  (un `com_perfiles.id`)
--   · y, sin que nadie lo dijera, quién se suponía responsable del cliente.
--
-- Con eso no se puede contestar la pregunta que más importa cuando se revisa
-- una visita: «¿quién fue, quién la escribió, y de quién era el cliente?».
-- Hoy las tres cosas son el mismo número.
--
-- ── LOS TRES ROLES, SEPARADOS ───────────────────────────────────────────────
--
--   registrado_por  · QUIÉN LA ESCRIBIÓ.  `users.id`. Lo pone el SERVIDOR, a
--                    partir de la sesión. Nunca viene del navegador: si viniera,
--                    cualquiera podría escribir «la registré yo» en la visita de
--                    otro.
--
--   comercial_id    · QUIÉN LA HIZO, cuando es un comercial. Se conserva tal
--                    cual, con sus seis visitas históricas intactas. Es la
--                    referencia que ya usan el índice y el código.
--
--   realizada_por   · QUIÉN LA HIZO cuando NO es un comercial: el administrador
--                    que acompaña a uno a la tienda, o quien registra una visita
--                    en una cartera que no es suya. NULL significa «la hizo el
--                    comercial de `comercial_id`», que es el caso de las seis
--                    visitas que ya existen.
--
--   responsable_id  · DE QUIÉN ES el cliente, tal como estaba en el momento de
--                    la visita. Es una FOTO, no un enlace vivo: si mañana el
--                    cliente cambia de comercial, la visita antigua sigue
--                    diciendo de quién era cuando ocurrió.
--
-- ── LOS DATOS QUE NO SE PUEDEN INVENTAR ──────────────────────────────────────
--
-- Las seis visitas ya existen y no se puede saber quién las escribió: el
-- sistema no guardaba esa información. `registrado_por` se queda NULL en esas
-- seis, y NULL significa «no consta», no «nadie». Ponerles un autor supuesto
-- sería fabricar una firma comercial retroactiva, que es justo lo que un
-- registro de visitas no debe tener.
--
-- `responsable_id` sí se puede rellenar: se toma del comercial que tiene el
-- cliente HOY. Para las cuatro visitas con cliente es el que había; para las
-- dos que no tienen cliente se queda NULL, porque un cliente sin identificar no
-- tiene responsable que fotografiar. Queda documentado con un COMMENT.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1 · Quién la escribió ───────────────────────────────────────────────────
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS registrado_por INTEGER REFERENCES users(id) ON DELETE RESTRICT;

-- ── 2 · Quién la hizo, cuando no es el comercial de la fila ─────────────────
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS realizada_por INTEGER REFERENCES users(id) ON DELETE RESTRICT;

-- ── 3 · De quién era el cliente en ese momento ──────────────────────────────
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS responsable_id INTEGER REFERENCES com_perfiles(id) ON DELETE SET NULL;

-- ── 4 · Lo que faltaba de la visita en sí ───────────────────────────────────
-- El tipo NO lleva valores inventados: los cinco cubren lo que un comercial
-- hace de verdad en una ruta. `problemas` es texto libre a propósito — un
-- checklist fijo obligaría a encajar en casillas lo que pasó en la calle.
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS tipo_visita TEXT;
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS hubo_pedido BOOLEAN;
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL;
ALTER TABLE com_visitas ADD COLUMN IF NOT EXISTS problemas TEXT;

ALTER TABLE com_visitas DROP CONSTRAINT IF EXISTS com_visitas_tipo;
ALTER TABLE com_visitas ADD CONSTRAINT com_visitas_tipo CHECK (
  tipo_visita IS NULL OR tipo_visita IN
  ('PRIMERA', 'SEGUIMIENTO', 'REVISION', 'RECLAMACION', 'ENTREGA')
);

-- Si hubo pedido, tiene que haber un pedido. Al revés no: se puede haber hecho
-- un pedido sin.IDEA
ALTER TABLE com_visitas DROP CONSTRAINT IF EXISTS com_visitas_pedido_coherente;
ALTER TABLE com_visitas ADD CONSTRAINT com_visitas_pedido_coherente CHECK (
  pedido_id IS NULL OR hubo_pedido IS NOT FALSE
);

COMMENT ON COLUMN com_visitas.registrado_por IS
  'Usuario que INTRODUJO la visita. Lo determina el servidor desde la sesion. '
  'NULL en las visitas anteriores a esta migracion: no consta quien las escribio '
  'y no se puede saber. No se rellena con un autor supuesto.';
COMMENT ON COLUMN com_visitas.realizada_por IS
  'Usuario que HIZO la visita cuando no es el comercial de la fila (por ejemplo '
  'un administrador que acompana a un comercial). NULL = la hizo comercial_id.';
COMMENT ON COLUMN com_visitas.responsable_id IS
  'FOTO del comercial responsable del cliente en el momento de la visita. No es '
  'un enlace vivo: si el cliente cambia de comercial, esta visita sigue '
  'diciendo de quien era cuando ocurrio.';
COMMENT ON COLUMN com_visitas.comercial_id IS
  'Comercial que realizo la visita. Se conserva sin cambios: las seis visitas '
  'historicas siguen apuntando aqui.';

-- ── 5 · Rellenar lo que SÍ se puede rellenar ────────────────────────────────
-- `responsable_id` se deduce del comercial que tiene el cliente HOY. Para las
-- visitas sin cliente se queda NULL. No es una atribucion inventada: es el
-- unico dato que existe, y NULL donde no existe dato.
UPDATE com_visitas v
   SET responsable_id = c.comercial_id
  FROM customers c
 WHERE c.id = v.customer_id
   AND c.comercial_id IS NOT NULL
   AND v.responsable_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_com_visitas_registrado
  ON com_visitas (registrado_por, visita_fecha);
CREATE INDEX IF NOT EXISTS idx_com_visitas_responsable
  ON com_visitas (responsable_id, visita_fecha);
