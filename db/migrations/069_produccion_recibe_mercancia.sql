-- ─────────────────────────────────────────────────────────────────────────────
--  069 · PRODUCCIÓN PUEDE RECIBIR MERCANCÍA
-- ─────────────────────────────────────────────────────────────────────────────
--
--  El rol PRODUCTION se había quedado sin `inventory:create`. Sin él no puede
--  registrar una entrada de material, que es literalmente su primer acto del
--  día: el truck llega, la mercancía entra, y el sistema le responde 403.
--
--  Se le da UNA cosa y solo una: `inventory:create`, para registrar entradas.
--  No se le abre `purchases`, ni `suppliers`, ni `clients`, ni `orders`, ni
--  `edit`, ni `delete` en ningún sitio. Produce, recibe material y ve su
--  inventario; no compra, no vende y no toca clientes.
--
--  La decisión de qué puede hacer cada rol es del negocio, no de la aplicación.
--  Por eso esto es una migración separada y explícita, y no una regla que se
--  aplique sola a quien tenga «algo» de inventario: el día que haga falta otro
--  permiso, se añade aquí y se ve.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.code = 'PRODUCTION'
   AND p.module = 'inventory'
   AND p.action = 'create'
ON CONFLICT (role_id, permission_id) DO NOTHING;
