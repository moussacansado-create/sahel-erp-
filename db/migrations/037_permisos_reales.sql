-- ═══════════════════════════════════════════════════════════════════════════
-- 037 · PERMISOS REALES: EL COMERCIAL DEJA DE SER ADMINISTRADOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL AGUJERO
--
-- En `db/semillas.js` había una función que se llamaba `pv` —permisos
-- «vista»— y devolvía LAS SEIS ACCIONES sobre el módulo. Se usaba así:
--
--     COMMERCIAL: [ ...pv('commercial'), ...pv('zones'), ...pv('customers'), … ]
--
-- Traducido: un comercial tenía permiso para CREAR, EDITAR y BORRAR a otros
-- comerciales; para crear y borrar zonas; para borrar clientes. Y como
-- `conceder puntos` se protege con `commercial:edit`, podía concederse
-- puntos a sí mismo.
--
-- El código se leía bien, que es por lo que nadie lo pilló. Lo raro era el
-- comportamiento, y lo raro es lo que no se mira dos veces.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- LO QUE CAMBIA
--
--   · `pv()` pasa a devolver solo `view`. Quien quiera algo más lo escribe.
--
--   · El comercial se queda con: consultar clientes, pedidos, ventas,
--     comerciales, zonas, productos, panel, historial y alertas; registrar
--     actividad; crear y editar clientes; exportar tarifa.
--
--   · El comercial PIERDE: commercial:create / edit / delete / approve,
--     CUALQUIER acción sobre `zones`, y los puntos.
--
--   · Aparece JEFE_COMERCIAL, con la gestión comercial completa y sin nada
--     de usuarios, permisos, ajustes, caja ni producción.
--
-- ───────────────────────────────────────────────────────────────────────────
--
-- POR QUÉ NO SE TOCA `pv()` EN ESTA MIGRACIÓN
--
-- Porque el fichero ya está corregido, y lo que hace falta es BAJARLO A LA
-- BASE. Este `DELETE` limpia los permisos que se le habían dado por error.
-- Volver a sembrar desde cero tiraría datos de trabajo; esto solo quita lo
-- que sobraba.
--
-- ADMIN no se toca: lo puede todo, y tiene que poder.

-- ─── 1 · El rol nuevo ───────────────────────────────────────────────────────

INSERT INTO roles (code, name, is_system)
VALUES ('JEFE_COMERCIAL', 'Jefe comercial', TRUE)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- ─── 2 · Lo que el comercial se QUEDA ───────────────────────────────────────
--
-- Se concede con `ON CONFLICT DO NOTHING` para que aplicarla dos veces no
-- rompa nada, y para que no dependa de cuántas veces se ejecutó antes.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'COMMERCIAL' AND p.action = 'view'
   AND p.module IN ('customers','orders','sales','commercial','dashboard',
                    'history','alerts','zones','products')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'COMMERCIAL'
   AND (p.module, p.action) IN (
     ('products','export'), ('sales','export'),
     ('customers','create'), ('customers','edit')
   )
ON CONFLICT DO NOTHING;

-- ─── 3 · Lo que el comercial se QUITA ───────────────────────────────────────
--
-- Se borra por LISTA, no con un «todo menos lo que puede». Un «todo menos X»
-- esconde dentro el próximo permiso que se invente; una lista de lo que NO
-- puede es corta y se lee entera.

DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE code = 'COMMERCIAL')
   AND (
     -- Niadministration: ni_othercommercial ni zonas
        (permission_id IN (SELECT id FROM permissions
                            WHERE module IN ('commercial','zones') AND action <> 'view'))
     -- Puntos: ni concederse ni modificar reglas
     OR (permission_id IN (SELECT id FROM permissions
                            WHERE module = 'commercial' AND action IN ('edit','approve')))
     -- Y nada de administrar la casa
     OR (permission_id IN (SELECT id FROM permissions
                            WHERE module IN ('users','permissions','settings','reports')))
     -- Ni tocar el resto de la operación
     OR (permission_id IN (SELECT id FROM permissions
                            WHERE module IN ('orders','sales','inventory','lots','cash',
                                             'production','recipes','purchases','expenses',
                                             'recalls','traceability','deliveries')
                              AND action <> 'view'))
   );

-- ─── 4 · El jefe comercial ──────────────────────────────────────────────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'JEFE_COMERCIAL'
   AND (
        -- La gestión comercial, entera
        (p.module IN ('commercial','zones','alerts'))
        -- Los clientes de su equipo
     OR (p.module = 'customers' AND p.action IN ('view','create','edit','export','approve'))
        -- Y lo que necesita para vender de verdad
     OR (p.module IN ('orders','sales','products','inventory','lots',
                      'raw_materials','packaging','dashboard','history','reports')
         AND p.action IN ('view','export','approve'))
   )
ON CONFLICT DO NOTHING;

-- ─── 5 · Comprobación ───────────────────────────────────────────────────────
--
-- Lo que un comercial NO debe poder hacer, comprobado en la BASE y no en el
-- papel. Si esto no cuadra, la migración se para aquí.

DO $$
DECLARE
  prohibidos int;
  restantes int;
  jefe_ok int;
BEGIN
  SELECT count(*) INTO prohibidos FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.code = 'COMMERCIAL'
     AND ( (p.module IN ('commercial','zones') AND p.action <> 'view')
        OR (p.module = 'commercial' AND p.action IN ('edit','approve'))
        OR (p.module IN ('users','permissions','settings','reports')) );

  IF prohibidos > 0 THEN
    RAISE EXCEPTION 'Al comercial le quedan % permisos prohibidos. La migración se para.', prohibidos;
  END IF;

  -- Y que no se le hayan ido los que sí necesita
  SELECT count(*) INTO restantes FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r.code = 'COMMERCIAL' AND p.action = 'view'
     AND p.module IN ('customers','orders','sales','commercial','dashboard',
                      'history','alerts','zones','products');

  -- 9 módulos de lectura: customers, orders, sales, commercial, dashboard,
  -- history, alerts, zones y products. Ni uno más ni uno menos.
  IF restantes <> 9 THEN
    RAISE EXCEPTION 'Al comercial le quedan % permisos de lectura; se esperaban exactamente 9.', restantes;
  END IF;

  -- Y que el jefe tenga lo suyo
  SELECT count(*) INTO jefe_ok FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.code = 'JEFE_COMERCIAL';

  IF jefe_ok < 20 THEN
    RAISE EXCEPTION 'JEFE_COMERCIAL tiene solo % permisos; se esperaban 20 o mas.', jefe_ok;
  END IF;

  RAISE NOTICE 'Comercial: % permisos de lectura, ninguno prohibido. Jefe comercial: % permisos.', restantes, jefe_ok;
END $$;
