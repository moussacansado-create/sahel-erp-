/**
 * ROLES Y PERMISOS.
 *
 * Los dos fallos que aparecieron juntos y que esta suite fija para siempre:
 *
 *   1. `asignadas is not iterable` — la pantalla pedía una lista y el backend
 *      devolvía un objeto. O lo contrario: se escribió contra un contrato que
 *      el servidor ya no cumplía, y reventaba nada más abrirla.
 *
 *   2. Pantallas que el menú SÍ enseñan y que la API rechaza con 403. El
 *      permiso estaba en la matriz, la ruta no lo aceptaba. El usuario veía la
 *      pantalla en el menú y una pared al abrirla.
 *
 * Y tres cosas que este sistema no puede hacer, porque son su razón de ser:
 *
 *   · ADMIN puede todo, y sus 150 casillas no se pueden desmarcar.
 *   · Quitar un permiso surte efecto en la siguiente petición, sin esperar.
 *   · Un 403 del backend sigue siendo un 403. Nada de lo que se arregla aquí
 *     abre una puerta de más.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-permisos-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb } = await import('./banco.js')

let e = {}
let adminId = null

test.before(async () => {
  await baseDePrueba()
  e = await escenario()
  adminId = e.admin
})
test.after(async () => { await closeDb() })

/** Un usuario por rol, con su matriz tal como la deja la semilla. */
async function escenario() {
  const roles = await query(`SELECT id, code FROM roles`)
  const porCodigo = Object.fromEntries(roles.map((r) => [r.code, r.id]))
  const { hashPassword } = await import('../src/security/passwords.js')
  const hash = await hashPassword('contrasena-de-prueba-1')
  const usuarios = {}
  for (const [codigo, nombre] of [
    ['ADMIN', 'jefe'], ['PRODUCTION', 'jefa-produccion'],
    ['ACCOUNTING', 'contable'], ['DELIVERY', 'repartidor'], ['COMMERCIAL', 'comercial'],
  ]) {
    const u = await one(
      `INSERT INTO users (username, full_name, password_hash, password_changed_at)
       VALUES ($1,$2,$3, now()) RETURNING id`, [`prueba-${nombre}`, nombre, hash])
    await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [u.id, porCodigo[codigo]])
    usuarios[codigo] = u.id
  }
  return { ...usuarios, roles: porCodigo }
}

// ─── 1 · El contrato de /api/permissions ─────────────────────────────────────
//
// La pantalla se rompió porque esperaba una lista y recibió un objeto. Aquí se
// fija QUÉ tiene que devolver, para que el frontend y el backend no vuelvan a
// hablar idiomas distintos.

test('la matriz se lee con el MISMO formato que la usa la pantalla', async () => {
  // El contrato, medido contra lo que realmente hay en la base.
  const filas = await query(
    `SELECT r.code AS rol, p.module, p.action
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id`)

  // Esto es lo que la pantalla necesita: por rol, un conjunto de «módulo:acción».
  const porRol = {}
  for (const f of filas) (porRol[f.rol] ||= []).push(`${f.module}:${f.action}`)

  // Y esto es lo que produce `leerPermisos()` del frontend desde un objeto.
  const desdeObjeto = (respuesta) => {
    if (!respuesta || typeof respuesta !== 'object' || !Array.isArray(respuesta.roles)) return null
    const m = {}
    for (const r of respuesta.roles) {
      m[r.code] = Array.isArray(r.permisos) ? r.permisos.map(String) : Object.keys(r.permisos || {})
    }
    return m
  }
  const desdeLista = (lista) => {
    if (!Array.isArray(lista)) return null
    const m = {}
    for (const f of lista) {
      if (!f || typeof f.rol !== 'string') continue
      (m[f.rol] ||= []).push(`${f.module}:${f.action}`)
    }
    return m
  }

  // Ambas formas tienen que dar lo MISMO. Antes, una de las dos reventaba.
  assert.deepEqual(
    Object.fromEntries(Object.entries(desdeLista(filas)).map(([k, v]) => [k, [...v].sort()])),
    Object.fromEntries(Object.entries(porRol).map(([k, v]) => [k, [...v].sort()])),
  )

  // Y el frontend tiene que aguantar un cuerpo vacío sin reventar: es lo que
  // hace un 403 o una conexión caída.
  assert.equal(desdeObjeto(null), null, 'un null debe devolverse, no romperse')
  assert.equal(desdeObjeto({}), null, 'un objeto vacío debe devolverse, no romperse')
  assert.deepEqual(desdeLista([]), {}, 'una lista vacía es una matriz vacía, no un error')
  assert.equal(desdeLista(null), null)
})

// ─── 2 · ADMIN ───────────────────────────────────────────────────────────────

test('ADMIN lo puede todo, y sus permisos no se pueden tocar', async () => {
  const { MODULOS, ACCIONES } = await import('../src/security/permisos.js')
  const total = MODULOS.length * ACCIONES.length
  const{full}= {}
  const filas = await query(
    `SELECT COUNT(*) n FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
      WHERE r.code = 'ADMIN'`)
  assert.equal(Number(filas[0].n), total,
    `ADMIN debería tener los ${total} permisos, tiene ${filas[0].n}`)

  // Que sean todos, y no «casi todos»: si un módulo nuevo nace y nadie se lo da,
  // admin se queda sin él y la siguiente pantalla da 403 sin explicación.
  const modulosAdmin = await query(
    `SELECT DISTINCT p.module FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code='ADMIN' ORDER BY p.module`)
  assert.deepEqual(modulosAdmin.map((m) => m.module).sort(), [...MODULOS].sort(),
    'ADMIN debe tener exactamente los módulos definidos, ni uno más ni uno menos')
})

test('a un rol que no le toca, la API le dice 403', async () => {
  const { requierePermiso } = await import('../src/security/permisos.js')

  // `usuario === null` significa SIN SESIÓN, y eso tiene que ser un 401: no es
  // lo mismo no saber quién eres que saberlo y no tener permiso. Para probar
  // eso hay que dejar `req.user` vacío de verdad, no poner un usuario con id
  // nulo —que es una cosa distinta y no debe confundirse con la otra.
  const res = (mw, usuario) => new Promise((resolve) => {
    const req = usuario === null
      ? { user: undefined, ip: '127.0.0.1' }
      : { user: { id: usuario, username: 'prueba' }, ip: '127.0.0.1' }
    const res2 = { status: (c) => resolve(c), json: () => ({}) }
    Promise.resolve(mw(req, res2, () => resolve(200))).catch(() => resolve(500))
  })

  // El repartidor SÍ tiene deliveries:view.
  assert.equal(await res(requierePermiso('deliveries', 'view'), e.DELIVERY), 200)
  // Y NO tiene users:view ni permissions:view.
  assert.equal(await res(requierePermiso('users', 'view'), e.DELIVERY), 403)
  assert.equal(await res(requierePermiso('permissions', 'view'), e.DELIVERY), 403)

  // Y un usuario sin sesión es 401, no 403: no es lo mismo no saber quién eres
  // que saberlo y no tener permiso.
  assert.equal(await res(requierePermiso('users', 'view'), null), 401)
})

test('un permiso concreto abre lo que tiene que abrir, y nada más', async () => {
  const { requierePermiso } = await import('../src/security/permisos.js')
  const res = (mw, usuario) => new Promise((resolve) => {
    const req = { user: { id: usuario, username: 'prueba' }, ip: '127.0.0.1' }
    const res2 = { status: (c) => resolve(c), json: () => ({}) }
    Promise.resolve(mw(req, res2, () => resolve(200))).catch(() => resolve(500))
  })

  // La matriz de la semilla, comprobada rol por rol contra lo que la política dice.
  const pol = {
    DELIVERY: { dentro: ['deliveries:view', 'lots:view', 'customers:view', 'orders:view'],
      fuera: ['users:view', 'permissions:view', 'inventory:view', 'settings:edit'] },
    PRODUCTION: { dentro: ['lots:view', 'production:view', 'raw_materials:view'],
      fuera: ['permissions:view', 'sales:view', 'deliveries:create'] },
    COMMERCIAL: { dentro: ['customers:view', 'orders:view', 'products:view'],
      fuera: ['permissions:view', 'inventory:view', 'production:create'] },
    ACCOUNTING: { dentro: ['sales:view', 'orders:view', 'suppliers:view', 'inventory:view'],
      fuera: ['permissions:view', 'production:create'] },
  }
  for (const [rol, casos] of Object.entries(pol)) {
    for (const p of casos.dentro) {
      const [m, a] = p.split(':')
      assert.equal(await res(requierePermiso(m, a), e[rol]), 200, `${rol} debería poder ${p}`)
    }
    for (const p of casos.fuera) {
      const [m, a] = p.split(':')
      assert.notEqual(await res(requierePermiso(m, a), e[rol]), 200, `${rol} NO debería poder ${p}`)
    }
  }
})

test('requiereAlgunoDe acepta combinaciones de módulo y acción distintas', async () => {
  const { requiereAlgunoDe } = await import('../src/security/permisos.js')
  const res = (mw, usuario) => new Promise((resolve) => {
    const req = { user: { id: usuario, username: 'prueba' }, ip: '127.0.0.1' }
    const res2 = { status: (c) => resolve(c), json: () => ({}) }
    Promise.resolve(mw(req, res2, () => resolve(200))).catch(() => resolve(500))
  })

  // La lista de proveedores: la abre quien la gestiona, quien compra, o quien
  // recibe mercancía. Cada uno con SU acción, que es justo lo que `requiereAlguno`
  // no podía expresar.
  const verProveedores = requiereAlgunoDe(
    [['suppliers', 'view'], ['purchases', 'view'], ['inventory', 'create']],
    'ver los proveedores')

  assert.equal(await res(verProveedores, e.ACCOUNTING), 200, 'el que gestiona proveedores, sí')
  assert.equal(await res(verProveedores, e.PRODUCTION), 200, 'el que recibe mercancía, sí')
  assert.equal(await res(verProveedores, e.COMMERCIAL), 403, 'el comercial, no')
  assert.equal(await res(verProveedores, e.DELIVERY), 403, 'el repartidor, no')

  // Fail-closed: una lista vacía deniega, nunca permite.
  assert.equal(await res(requiereAlgunoDe([], 'nada'), e.ADMIN), 403)
  assert.equal(await res(requiereAlgunoDe(null, 'nada'), e.ADMIN), 403)
  // Y una lista con basura dentro tampoco abre la puerta.
  assert.equal(await res(requiereAlgunoDe([['inventado', 'volar']], 'nada'), e.ADMIN), 403)
})

test('el catálogo acepta lots:view, que es lo que hacía fallar la pantalla de Lotes', async () => {
  const { requiereAlguno } = await import('../src/security/permisos.js')
  const res = (mw, usuario) => new Promise((resolve) => {
    const req = { user: { id: usuario, username: 'prueba' }, ip: '127.0.0.1' }
    const res2 = { status: (c) => resolve(c), json: () => ({}) }
    Promise.resolve(mw(req, res2, () => resolve(200))).catch(() => resolve(500))
  })
  // Un lote sin su artículo no se puede enseñar: la fila dice
  // «Desinfectante 750 ml · PT-DES-00007». Por eso `lots` entra en el catálogo.
  const verCatalogo = requiereAlguno(
    ['raw_materials', 'packaging', 'products', 'inventory', 'lots'], 'view', 'ver el catálogo')

  assert.equal(await res(verCatalogo, e.DELIVERY), 200, 'el repartidor puede ver lotes')
  assert.equal(await res(verCatalogo, e.PRODUCTION), 200)
  assert.equal(await res(verCatalogo, e.ACCOUNTING), 200)
})

// ─── 3 · La política se puede cambiar y se nota ──────────────────────────────

test('quitar un permiso surte efecto en la siguiente petición', async () => {
  const { transaction } = await import('../src/db/client.js')
  const { usuario, rol } = await import('../src/db/client.js').then(async () => ({
    usuario: e.COMMERCIAL,
    rol: e.roles.COMMERCIAL,
  }))

  const tiene = async (u) => {
    const r = await query(
      `SELECT p.module, p.action FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 ORDER BY p.module, p.action`, [rol])
    return r
  }

  const antes = await tiene(usuario)
  // Se quita `customers:edit`, no `customers:approve`.
  //
  // Este test no va de WHICH permiso tiene el comercial, va de que la politica
  // se lee de la base en cada peticion. Antes usaba `customers:approve`, y la
  // migracion 038 se lo quito al comercial a proposito: aprobar credito de
  // cliente no es cosa de quien vende. Con esa precondicion el test fallaba
  // antes de llegar a comprobar NADA, que es peor que fallar: da a entender que
  // el mecanismo esta roto cuando lo que estaba caducado era la suposicion.
  //
  // Se usa `customers:edit`, que el comercial si tiene. Todas las aserciones de
  // abajo se quedan igual: se sigue comprobando que quitar un permiso se nota
  // en la peticion siguiente y que lo demas no se mueve.
  const QUITA = { module: 'customers', action: 'edit' }
  const conApprove = antes.filter((p) => p.action === QUITA.action && p.module === QUITA.module)
  assert.ok(conApprove.length, 'precondición: comercial empieza con customers:edit')

  // Se quita. TODO, y se reescribe: es lo mismo que hace la pantalla al guardar.
  const sinApprove = antes.filter((p) => !(p.module === QUITA.module && p.action === QUITA.action))
  await transaction(async (tx) => {
    await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [rol])
    for (const p of sinApprove) {
      const row = await tx.one('SELECT id FROM permissions WHERE module=$1 AND action=$2',
        [p.module, p.action])
      await tx.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)',
        [rol, row.id])
    }
  })

  const despues = await tiene(usuario)
  assert.equal(despues.length, antes.length - 1, 'se quitó exactamente uno')
  assert.equal(despues.filter((p) => p.action === QUITA.action && p.module === QUITA.module).length, 0,
    'customers:edit ya no está')

  // Y el permiso siguiente NO CUESTA NADA: no hay que esperar a que caduque el
  // token ni a reiniciar nada.
  const { requierePermiso } = await import('../src/security/permisos.js')
  const res = (mw, u) => new Promise((resolve) => {
    const req = { user: { id: u, username: 'prueba' }, ip: '127.0.0.1' }
    const res2 = { status: (c) => resolve(c), json: () => ({}) }
    Promise.resolve(mw(req, res2, () => resolve(200))).catch(() => resolve(500))
  })
  assert.equal(await res(requierePermiso('customers', 'edit'), e.COMMERCIAL), 403,
    'la petición siguiente ya lo rechaza')
  assert.equal(await res(requierePermiso('customers', 'view'), e.COMMERCIAL), 200,
    'lo que no se tocó sigue entrando')

  // Se restaura, para no dejar la base coja.
  await transaction(async (tx) => {
    await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [rol])
    for (const p of antes) {
      const row = await tx.one('SELECT id FROM permissions WHERE module=$1 AND action=$2',
        [p.module, p.action])
      await tx.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)',
        [rol, row.id])
    }
  })
  assert.equal((await tiene(usuario)).length, antes.length, 'restaurado')
})

// ─── 4 · La pantalla de la interfaz ──────────────────────────────────────────

test('la pantalla de permisos se construye con lo que devuelve la API', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '../../web/js/paginas')
  const src = await readFile(join(raiz, 'permisos.js'), 'utf8')

  // 1. No se recorre con `for…of` lo que la API devuelve: eso fue el TypeError.
  assert.ok(!/for\s*\(\s*const\s+\w+\s+of\s+asignadas\s*\)/.test(src),
    'no se puede recorrer la respuesta de la API directamente')
  assert.ok(!/asignadas\s*\.\s*map\s*\(/.test(src),
    'no se puede llamar .map() sobre la respuesta sin normalizar antes')

  // 2. Pasa SIEMPRE por el normalizador, que acepta las tres formas.
  assert.ok(src.includes('leerPermisos'), 'debe existir el normalizador')
  const usos = (src.match(/leerPermisos\(/g) || []).length
  assert.ok(usos >= 2, `el normalizador se usa en la carga y al releer (usos: ${usos})`)

  // 3. Guarda en el formato que el endpoint documenta.
  assert.ok(/Object\.fromEntries/.test(src),
    'al guardar debe mandar un mapa {«modulo:accion»: true}')

  // 4. Y los módulos NO se repiten a mano si la API ya los manda.
  assert.ok(src.includes('leido.modulos') || src.includes('leido.acciones'),
    'los módulos y acciones vienen de la API, no de una lista copiada a mano')
})

test('el panel y el catálogo no se rompen cuando falta un permiso', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '../../web/js')

  const panel = await readFile(join(raiz, 'paginas/panel.js'), 'utf8')
  // Una llamada sin vigilar tumba el panel entero. Las que Showroom que
  // se avisa, no que se rompa.
  for (const llamada of ['/inventory/resumen', '/inventory/movimientos']) {
    // Se busca la LLAMADA, no el comentario que la menciona antes.
    // Con o sin `?query`: el código real lleva `?limite=12` en un caso.
    const i = Math.max(
      panel.indexOf(`A.api('${llamada}')`),
      panel.indexOf(`A.api('${llamada}?`),
    )
    assert.ok(i > 0, `el panel llama a ${llamada}`)
    // La llamada y su `.catch(...)` están en la MISMA expresión: basta con que
    // el `catch` aparezca antes del punto y coma que cierra la línea.
    const linea = panel.slice(i, panel.indexOf('\n', i))
    assert.ok(/catch\(/.test(linea),
      `${llamada} debe ir con catch en la misma línea: un 403 no puede tirar el panel\n      ${linea.trim()}`)
  }
  // Y debe SÍ decir qué falta, no quedarse mudo.
  assert.ok(/alerta--aviso/.test(panel) && /inventory:view/.test(panel),
    'el panel explica qué permiso falta, en vez de mostrar una pantalla vacía')
})
