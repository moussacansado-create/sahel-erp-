-- ═══════════════════════════════════════════════════════════════════════════
-- 038 · AL COMERCIAL LE QUEDABON CUATRO MÓDULOS ENTEROS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ ESTA MIGRACIÓN EXISTE
--
-- La 037 quitó al comercial las acciones prohibidas sobre `commercial` y
-- `zones`, y le dejó las de lectura sobre las demás. Se le olvidó una cosa:
-- la lista de módulos de los que había que quitar todo menos `view` no
-- incluía `alerts`, ni `dashboard`, ni `history`, ni `customers`.
--
-- El resultado fue que el comercial conservaba seis acciones sobre cuatro
-- módulos, entre ellas `alerts:delete` y `customers:delete`.
--
-- La 037 ya está aplicada y no se reescribe. Esta la corrige.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LA REGLA, DENTRO DE LA BASE
--
-- Se escribe la lista de lo que el comercial PUEDE, y se quita todo lo demás
-- de los módulos que son solo de lectura. Al revés de lo que hizo la 037, que
-- escribía la lista de lo que no puede.
--
-- Por qué: una lista de lo que no puede tiene dentro el próximo permiso que
-- alguien se invente y no se acuerde de añadir. Una lista de lo que puede es
-- corta, se lee entera, y no admite olvidos: lo que no está, no lo tiene.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE NO SE TOCA
--
-- ADMIN, JEFE_COMERCIAL, CAJAJERO, ACCOUNTING, DELIVERY y PRODUCTION. Aquí
-- solo se toca la fila de COMMERCIAL.

DO $$
DECLARE
  sobrantes int;
  lectura     int;
BEGIN
  -- 1 · Los módulos que son SOLO de consulta se quedan en `view`. Y nada más.
  DELETE FROM role_permissions
   WHERE role_id = (SELECT id FROM roles WHERE code = 'COMMERCIAL')
     AND permission_id IN (
       SELECT id FROM permissions
        WHERE action <> 'view'
          AND module IN ('alerts', 'dashboard', 'history', 'orders', 'sales',
                         'inventory', 'lots', 'deliveries',
                         'raw_materials', 'packaging', 'production', 'recipes',
                         'purchases', 'cash', 'expenses', 'recalls',
                         'traceability', 'reports', 'settings', 'users',
                         'permissions')
     );

  -- 2 · `products` también es distinto: el comercial exporta la tarifa para
  --     poder vender. Se queda con `view` y `export`, y nada más.

  DELETE FROM role_permissions
   WHERE role_id = (SELECT id FROM roles WHERE code = 'COMMERCIAL')
     AND permission_id IN (
       SELECT id FROM permissions
        WHERE module = 'products' AND action NOT IN ('view', 'export')
     );

  -- 3 · `customers` también es distinto: se puede crear y editar, porque es
  --     el trabajo del comercial. Pero no borrar ni aprobar, que ya es gestión.
  DELETE FROM role_permissions
   WHERE role_id = (SELECT id FROM roles WHERE code = 'COMMERCIAL')
     AND permission_id IN (
       SELECT id FROM permissions
        WHERE module = 'customers' AND action IN ('delete', 'approve', 'export')
     );

  -- ─── Comprobación ─────────────────────────────────────────────────────────
  --
  -- La lista exacta de lo que le queda. Si mañana se añade un permiso, esta
  -- comprobación avisa en vez de dejar un agujero.

  SELECT count(*) INTO sobrantes FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.code = 'COMMERCIAL'
     AND NOT (
       (p.module = 'commercial' AND p.action = 'view')
    OR (p.module = 'zones'      AND p.action = 'view')
    OR (p.module IN ('orders','sales','dashboard','history','alerts')
        AND p.action = 'view')
    OR (p.module = 'products'  AND p.action IN ('view', 'export'))
    OR (p.module = 'customers' AND p.action IN ('view', 'create', 'edit'))
    );

  IF sobrantes > 0 THEN
    RAISE EXCEPTION 'Al comercial le quedan % permisos fuera de lo permitido.', sobrantes;
  END IF;

  SELECT count(*) INTO lectura FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.code = 'COMMERCIAL';

  -- 9 módulos de lectura + 1 export de products + 2 de customers = 12
  IF lectura <> 12 THEN
    RAISE EXCEPTION 'El comercial tiene % permisos; se esperaban 12.', lectura;
  END IF;

  RAISE NOTICE 'COMMERCIAL queda con % permisos: ver y trabajar los suyos, nada mas.', lectura;
END $$;
