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
-- administrar o de consultar?». Y preguntar con cuatro permisos significa
-- que la interfaz dice una cosa y el servidor otra, y el día que uno se
-- desincronice aparece el botón que no funciona o el botón que no está.
--
-- `commissions:manage` es la respuesta a esa pregunta, y SOLO para la
-- interfaz. El servidor sigue exigiendo los finos: tener `manage` no
-- permite confirmar un mes si no se tiene `approve`.
--
-- Por eso esto NO amplía nada: `manage` no se comprueba en ninguna ruta. Es
-- una llave de lectura para la pantalla, no una llave de puerta.
--
-- El comercial NO lo recibe: ve su estimation, que es otra cosa.
--
INSERT INTO permissions (module, action) VALUES
  ('commissions','manage')
ON CONFLICT (module, action) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'ADMIN' AND p.module = 'commissions' AND p.action = 'manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMENT ON TABLE permissions IS
  'commissions:manage es la llave de INTERFAZ para el panel de comisiones. El servidor sigue exigiendo los permisos finos (create, approve, edit): tener manage no abre ninguna puerta.';
