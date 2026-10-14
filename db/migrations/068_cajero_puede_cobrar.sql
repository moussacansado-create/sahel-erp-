-- ─────────────────────────────────────────────────────────────────────────────
--  068 · EL CAJERO PUEDE COBRAR
-- ─────────────────────────────────────────────────────────────────────────────
--
--  El rol CAJAJERO se creó con permiso de `view` en todos los módulos y nada
--  más. Abierta la caja, el cajero podía mirarla pero no hacer nada con ella:
--  ni abrir sesión, ni registrar un movimiento, ni recibir un traspaso. La
--  pantalla le dejaba ver el dinero y el sistema le devolvía 403 al tocarlo.
--
--  Un rol llamado CAJAJERO que no puede cobrar no es un rol restrictivo: es un
--  rol roto. Y no es que el sistema se protegiera de más —es que le faltaba lo
--  suyo—, porque la autenticación y el control de sesión sí funcionan, y la
--  caja se le abre y se le lee.
--
--  Se le da `create` SOLO en caja, que es lo que le corresponde por nombre. No
--  se toca ningún otro rol, no se le da `edit` ni `delete`, y no se le abre
--  nada que antes no tuviera. Un cajero cobra y registra cobros; no crea
--  clientes, ni pedidos, ni series, ni borra nada. Eso lo decide el nombre del
--  rol, y por eso el cambio es de una línea por permiso.
--
--  INSERT… SELECT y no una lista escrita a mano, para que si mañana aparece un
--  permiso nuevo de caja lo repase lo que ya está dado sin tocar este fichero.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.code = 'CAJAJERO'
   AND p.module = 'cash'
   AND p.action = 'create'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Lo mismo para el resto de roles de caja, por si la empresa usa un rol
-- distinto con otro nombre. Se localizan por lo que hacen, no por cómo se
-- llaman: cualquier rol que tenga `cash` para ver y NO tenga `cash` para crear
-- está en la misma situación y merece lo mismo.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p2.id
  FROM role_permissions rp
  JOIN permissions p1  ON p1.id = rp.permission_id
  JOIN permissions p2  ON p2.module = 'cash' AND p2.action = 'create'
 WHERE p1.module = 'cash' AND p1.action = 'view'
ON CONFLICT (role_id, permission_id) DO NOTHING;
