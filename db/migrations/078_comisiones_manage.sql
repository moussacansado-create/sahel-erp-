-- ═══════════════════════════════════════════════════════════════════════════
-- 078 · EL PERMISO DE GESTIÓN DE COMISIONES, EN UN SOLO LUGAR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL POR QUÉ
--
-- El backend usa cuatro permisos finos: `view` (ver), `create` (configurar
-- porcentajes), `approve` (confirmar) y `edit` (registrar pagos). Eso es lo
-- correcto para el SERVIDOR: cada acción se comprueba por separado y no se
-- abre de más ninguna puerta.
--
-- Pero la INTERFAZ necesita una sola pregunta: «¿esta pantalla es de
-- administrar o de consultar?». Preguntar con cuatro permisos significa que
-- la interfaz dice una cosa y el servidor otra, y el día que uno se
-- desincronice aparece el botón que no funciona o el botón que no está.
--
-- `commissions:manage` es la respuesta a esa pregunta, y SOLO para la
-- interfaz. El servidor sigue exigiendo los finos: tener `manage` no
-- permite confirmar un mes si no se tiene `approve`.
--
-- ── LA LISTA DE ACCIONES ─────────────────────────────────────────────────
--
-- `permissions.action` tenía una lista cerrada: view, create, edit, delete,
-- approve, export. Se amplía con `manage`, que significa «administra este
-- módulo» y solo se usa como llave de INTERFAZ.
--
-- La lista se amplía, no se sustituye: las seis acciones de siempre siguen
-- valiendo igual, y los permisos que ya existían no se tocan. Una
-- migración aplicada es inmutable; esto es una migración NUEVA que cambia
-- una restricción, no una que la reescribe.
--
-- El comercial NO recibe `manage`: ve su estimación, que es otra cosa.
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_action_check;
ALTER TABLE permissions ADD CONSTRAINT permissions_action_check
  CHECK (action IN ('view','create','edit','delete','approve','export','manage'));

INSERT INTO permissions (module, action) VALUES
  ('commissions','manage')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'ADMIN' AND p.module = 'commissions' AND p.action = 'manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMENT ON TABLE permissions IS
  'commissions:manage es la llave de INTERFAZ para el panel de comisiones. El servidor sigue exigiendo los permisos finos (create, approve, edit): tener manage no abre ninguna puerta.';
