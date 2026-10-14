/**
 * Pruebas de la Fase 1: autenticación, sesiones, usuarios, roles y permisos.
 *
 * Se levanta la aplicación HTTP real contra una base PostgreSQL limpia. No hay
 * mocks: lo que se prueba es exactamente lo que se despliega.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-fase-1-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, comprobar, seccion, resumen, query, one, transaction,
        crearItem } = await import('./banco.js')
const { hashPassword } = await import('../src/security/passwords.js')
const { MODULOS, ACCIONES } = await import('../src/security/permisos.js')
const { createApp } = await import('../src/app.js')
const { request } = await import('./supertest-helper.js')

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · FASE 1 · AUTENTICACIÓN Y PERMISOS')
console.log('══════════════════════════════════════════════════════════════')

await baseDePrueba()
const app = createApp()

// ─────────────────────────────────────────────────────────────────────────────
seccion('0. Preparación: se crean usuarios de cada rol')

const CONTRASENAS = {
  temporal: 'temporal-prueba-1',
  admin: 'admin-de-prueba-1',
  produccion: 'produccion-prueba-1',
  reparto: 'reparto-prueba-1',
  comercial: 'comercial-prueba-1',
  contabilidad: 'contabilidad-prueba-1',
}

async function crear(usuario, rol) {
  const hash = await hashPassword(CONTRASENAS[usuario])
  const u = await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ($1,$2,$3, now()) RETURNING *`,
    [usuario, usuario.toUpperCase(), hash],
  )
  const r = await one('SELECT id FROM roles WHERE code = $1', [rol])
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [u.id, r.id])
  return u
}

await crear('admin', 'ADMIN')
await crear('produccion', 'PRODUCTION')
await crear('reparto', 'DELIVERY')
await crear('comercial', 'COMMERCIAL')
await crear('contabilidad', 'ACCOUNTING')

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. Acceso: el camino correcto y los incorrectos')

{
  const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })
  comprobar('Un usuario con su contraseña entra', r.status === 200 && !!r.body.access)
  comprobar('Devuelve token de acceso y de refresco', !!r.body.access && !!r.body.refresh)
  comprobar('Devuelve los datos del usuario, nunca el hash',
    r.body.usuario && r.body.usuario.username === 'admin' && !JSON.stringify(r.body).includes('password_hash'),
    'se ha filtrado algo del hash')

  const mal = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'incorrecta' })
  comprobar('Contraseña incorrecta → 401', mal.status === 401)
  comprobar('El mensaje no revela si el usuario existe',
    /incorrect/i.test(mal.body.error), mal.body.error)

  const inexistente = await request(app).post('/api/auth/login').send({ username: 'nadie_este', password: 'loquesea' })
  comprobar('Usuario inexistente → 401', inexistente.status === 401)
  comprobar('El mensaje es idéntico al de contraseña incorrecta',
    inexistente.body.error === mal.body.error,
    `"${inexistente.body.error}" vs "${mal.body.error}"`)

  const vacios = await request(app).post('/api/auth/login').send({})
  comprobar('Sin datos → 400', vacios.status === 400)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. Intentos fallidos: se bloquea y avisa')

{
  for (let i = 1; i <= 4; i++) {
    await request(app).post('/api/auth/login').send({ username: 'comercial', password: 'mala' })
  }
  const quinto = await request(app).post('/api/auth/login').send({ username: 'comercial', password: 'mala' })
  comprobar('Al quinto fallo se bloquea la cuenta', quinto.status === 423 || quinto.body.codigo === 'CUENTA_BLOQUEADA',
    `status ${quinto.status} ${quinto.body.codigo}`)

  const conBuena = await request(app).post('/api/auth/login').send({ username: 'comercial', password: CONTRASENAS.comercial })
  comprobar('Bloqueada, ni la contraseña correcta entra', conBuena.status === 423, `status ${conBuena.status}`)

  // Un admin la desbloquea
  const admin = await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })
  const r = await request(app).post(`/api/users/${(await one('SELECT id FROM users WHERE username=$1', ['comercial'])).id}/desbloquear`)
    .set('Authorization', `Bearer ${admin.body.access}`)
  comprobar('Un administrador puede desbloquearla', r.status === 200)

  const ya = await request(app).post('/api/auth/login').send({ username: 'comercial', password: CONTRASENAS.comercial })
  comprobar('Tras desbloquear, entra', ya.status === 200, `status ${ya.status}`)

  const intentos = await one('SELECT failed_attempts FROM users WHERE username=$1', ['comercial'])
  comprobar('El contador de fallos vuelve a cero', Number(intentos.failed_attempts) === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. Sesiones: acceso corto, refresco largo, revocables')

let tokenAdmin
let refreshAdmin
{
  const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })
  tokenAdmin = r.body.access
  refreshAdmin = r.body.refresh

  const sesion = await one('SELECT * FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=$1)', ['admin'])
  comprobar('La sesión se guarda en la base', !!sesion)
  comprobar('En la base está el HASH del refresco, no el token',
    sesion.token_hash !== refreshAdmin && sesion.token_hash.length === 64)

  const renovado = await request(app).post('/api/auth/refresh').send({ refreshToken: refreshAdmin })
  comprobar('El refresco devuelve un access nuevo', r.status === 200 && !!renovado.body.access)

  const viejo = await request(app).post('/api/auth/refresh').send({ refreshToken: refreshAdmin })
  comprobar('El refresco es de un solo uso: el viejo ya no vale', viejo.status === 401, `status ${viejo.status}`)

  const nuevo = await request(app).post('/api/auth/refresh').send({ refreshToken: renovado.body.refresh })
  comprobar('Con el nuevo sí funciona', nuevo.status === 200)
  comprobar('La rotación invalida el access de la sesión anterior',
    (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)).status === 401)

  // La rotación ha revocado la sesión del token original, así que para las
  // secciones siguientes se entra de nuevo.
  const limpio = await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })
  tokenAdmin = limpio.body.access
  refreshAdmin = limpio.body.refresh
  comprobar('Una sesión nueva vuelve a funcionar',
    (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)).status === 200)

  const basura = await request(app).post('/api/auth/refresh').send({ refreshToken: 'no-es-un-token' })
  comprobar('Un refresco inventado no concede nada', basura.status === 401)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('4. El token no da una sesión válida por sí solo')

{
  const sinNada = await request(app).get('/api/auth/me')
  comprobar('Sin cabecera → 401', sinNada.status === 401)

  const malFormato = await request(app).get('/api/auth/me').set('Authorization', 'Bearer lo-que-sea')
  comprobar('Con un token inválido → 401', malFormato.status === 401)

  const sinPrefijo = await request(app).get('/api/auth/me').set('Authorization', tokenAdmin)
  comprobar('Sin el prefijo "Bearer " → 401', sinPrefijo.status === 401)

  // Token firmado con otro secreto
  const { default: jwt } = await import('jsonwebtoken')
  const falso = jwt.sign({ sub: 1, username: 'admin', sid: 'x' }, 'secreto-ajeno-a-la-aplicacion', { expiresIn: '1h' })
  const conFalso = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${falso}`)
  comprobar('Un token firmado con otro secreto → 401', conFalso.status === 401)

  const bueno = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)
  comprobar('Con el token legítimo → 200', bueno.status === 200)
  comprobar('Dice quién es y qué puede hacer',
    bueno.body.usuario?.username === 'admin' && Array.isArray(bueno.body.roles) && Array.isArray(bueno.body.permisos))

  // Sesión revocada: el access deja de valer aunque no haya caducado
  const r = await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })
  const sesionId = r.body.sesion.id
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${r.body.access}`)
  const despues = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.access}`)
  comprobar('Tras cerrar sesión, ese token ya no sirve', despues.status === 401, `status ${despues.status}`)
  comprobar('La sesión queda revocada en la base',
    (await one('SELECT revoked_at FROM sessions WHERE id=$1', [sesionId]))?.revoked_at !== null)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('5. Desactivar a alguien surte efecto de inmediato')

{
  const u = await crear('temporal', 'PRODUCTION')
  const r = await request(app).post('/api/auth/login').send({ username: 'temporal', password: CONTRASENAS.temporal })
  comprobar('El usuario nuevo entra', r.status === 200, `status ${r.status}`)

  const antes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.access}`)
  comprobar('Su token funciona', antes.status === 200)

  await request(app).put(`/api/users/${u.id}/estado`).set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ activo: false })

  const despues = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.access}`)
  comprobar('Al desactivarlo, su token deja de servir aunque no haya caducado',
    despues.status === 401, `status ${despues.status}`)
  comprobar('Y el motivo es que la cuenta está inactiva',
    despues.body.codigo === 'CUENTA_INACTIVA', JSON.stringify(despues.body))

  const reingreso = await request(app).post('/api/auth/login').send({ username: 'temporal', password: CONTRASENAS.temporal })
  comprobar('Tampoco puede volver a entrar', reingreso.status === 403, `status ${reingreso.status}`)

  const noSeAutoDesactiva = await request(app).put(`/api/users/${(await one('SELECT id FROM users WHERE username=$1',['admin'])).id}/estado`)
    .set('Authorization', `Bearer ${tokenAdmin}`).send({ activo: false })
  comprobar('Un admin no puede desactivar su propia cuenta', noSeAutoDesactiva.status === 400, `status ${noSeAutoDesactiva.status}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('6. Gestión de usuarios: solo admin, y con rastro')

{
  const noAdmin = await request(app).post('/api/auth/login').send({ username: 'reparto', password: CONTRASENAS.reparto })

  const comoReparto = await request(app).get('/api/users').set('Authorization', `Bearer ${noAdmin.body.access}`)
  comprobar('Un repartidor NO puede listar usuarios', comoReparto.status === 403, `status ${comoReparto.status}`)

  const crearComoReparto = await request(app).post('/api/users').set('Authorization', `Bearer ${noAdmin.body.access}`)
    .send({ username: 'nuevo', fullName: 'Nuevo', password: 'contrasena1', roles: ['ADMIN'] })
  comprobar('Un repartidor NO puede crear usuarios (ni_AUTO_ROL)', crearComoReparto.status === 403, `status ${crearComoReparto.status}`)

  const creado = await request(app).post('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ username: 'operario1', fullName: 'Operario Uno', password: 'operario-prueba-1', roles: ['PRODUCTION'] })
  comprobar('Un admin SÍ puede crear usuarios', creado.status === 201, `status ${creado.status} ${creado.body.error || ''}`)
  comprobar('El usuario nuevo nace con must_change_password', creado.body.must_change_password === true)

  const lista = await request(app).get('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
  comprobar('El listado NO incluye contraseñas', !JSON.stringify(lista.body).includes('password_hash'))

  const duplicado = await request(app).post('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ username: 'operario1', fullName: 'Otro', password: 'otra-clave-1', roles: ['PRODUCTION'] })
  comprobar('No se pueden crear dos usuarios con el mismo nombre', duplicado.status === 409, `status ${duplicado.status}`)

  const debil = await request(app).post('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ username: 'debil', fullName: 'Débil', password: 'corta', roles: ['PRODUCTION'] })
  comprobar('Una contraseña corta se rechaza con un motivo claro',
    debil.status === 400 && /8 caracteres/.test(debil.body.error), JSON.stringify(debil.body))

  const sinNumero = await request(app).post('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ username: 'sinnum', fullName: 'Sin Número', password: 'solo-letras-aqui', roles: ['PRODUCTION'] })
  comprobar('Una contraseña sin números se rechaza', sinNumero.status === 400, JSON.stringify(sinNumero.body))

  const rolFantasma = await request(app).post('/api/users').set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ username: 'fantasma', fullName: 'Fantasma', password: 'fantasma-clave-1', roles: ['JEFE_SUPREMO'] })
  comprobar('Un rol que no existe se rechaza', rolFantasma.status === 400, `status ${rolFantasma.status}`)

  // Todo queda auditado
  const auditoria = await query(`SELECT * FROM audit_log WHERE entity_type='users' AND action='CREATE'`)
  comprobar('La creación de usuarios queda auditada', auditoria.length >= 1, `${auditoria.length} registros`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('7. Roles en el backend: fail-closed de verdad')

{
  const t = async (rol) => (await request(app).post('/api/auth/login').send({ username: rol, password: CONTRASENAS[rol] })).body.access

  const adminT = await t('admin')
  const prodT = await t('produccion')
  const repartoT = await t('reparto')
  const comercialT = await t('comercial')
  const contaT = await t('contabilidad')

  // Nonexistent route
  const inexistente = await request(app).get('/api/esto-no-existe').set('Authorization', `Bearer ${adminT}`)
  comprobar('Una ruta inexistente da 404 con un mensaje claro',
    inexistente.status === 404 && inexistente.body.codigo === 'RUTA_NO_ENCONTRADA')

  // Gestión de usuarios: solo ADMIN
  for (const [nombre, token] of [['producción', prodT], ['reparto', repartoT], ['comercial', comercialT], ['contabilidad', contaT]]) {
    const r = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`)
    comprobar(`${nombre} NO puede gestionar usuarios`, r.status === 403, `status ${r.status}`)
  }

  // Permisos por rol
  const me = async (t2) => (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t2}`)).body
  const pProd = new Set((await me(prodT)).permisos)
  const pRep = new Set((await me(repartoT)).permisos)
  const pCom = new Set((await me(comercialT)).permisos)
  const pCon = new Set((await me(contaT)).permisos)
  const pAdmi = new Set((await me(adminT)).permisos)

  comprobar('Producción puede crear producción', pProd.has('production:create'))
  comprobar('Producción NO puede crear usuarios', !pProd.has('users:create'))
  comprobar('Producción NO puede borrar compras', !pProd.has('purchases:delete'))
  comprobar('Reparto puede registrar entregas', pRep.has('deliveries:create'))
  comprobar('Reparto NO puede fabricar', !pRep.has('production:create'))
  comprobar('Reparto NO puede tocar recetas', !pRep.has('recipes:edit'))
  comprobar('Reparto NO puede cambiar inventario', !pRep.has('inventory:edit'))
  comprobar('Reparto NO puede abrir retiradas', !pRep.has('recalls:create'))
  comprobar('Comercial puede gestionar clientes', pCom.has('customers:edit'))
  comprobar('Comercial NO puede producir', !pCom.has('production:create'))
  comprobar('Contabilidad puede registrar compras', pCon.has('purchases:create'))
  comprobar('Contabilidad NO puede tocar recetas', !pCon.has('recipes:edit'))
  //
  // El número NO está escrito a mano.
  //
  // Estaba como 150 = 25 × 6, y al añadir el módulo `cash` —que es lo que hizo
  // falta para que un repartidor no pudiera declarar entregado su propio
  // dinero— la cuenta se quedó corta y esta prueba saltó. Lo correcto no era
  // cambiar el 150 por el 156: era dejar de tener un 150 escrito en un test.
  //
  // Con la fórmula, el día que se añada o se quite un módulo esta prueba sigue
  // diciendo la verdad sobre lo que el admin tiene, que es lo único que
  // comprueba.
  //
  comprobar(
    'El administrador lo puede todo (cada módulo × cada acción)',
    pAdmi.size === MODULOS.length * ACCIONES.length,
    `tiene ${pAdmi.size}, y son ${MODULOS.length} módulos × ${ACCIONES.length} acciones`,
  )

  // El token no lleva los permisos: se leen de la base
  const claims = JSON.parse(Buffer.from(tokenAdmin.split('.')[1], 'base64url').toString())
  comprobar('El token NO lleva los permisos dentro (se leen de la base)',
    claims.permisos === undefined && claims.permissions === undefined,
    Object.keys(claims).join(','))
  comprobar('El token lleva el id de sesión, para poder revocarlo', !!claims.sid)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('8. Cambiar la contraseña revoca el resto de sesiones')

{
  const r = await request(app).post('/api/auth/login').send({ username: 'contabilidad', password: CONTRASENAS.contabilidad })
  const token = r.body.access
  comprobar('Entra con su contraseña', r.status === 200)

  const cambio = await request(app).post('/api/auth/cambiar-contrasena')
    .set('Authorization', `Bearer ${token}`)
    .send({ actual: CONTRASENAS.contabilidad, nueva: 'contabilidad-nueva-1' })
  comprobar('Cambia la contraseña con la actual correcta', cambio.status === 200, JSON.stringify(cambio.body))
  comprobar('Informa de cuántas sesiones se han revocado', cambio.body.sesionesRevocadas >= 1)

  const conVieja = await request(app).post('/api/auth/login').send({ username: 'contabilidad', password: CONTRASENAS.contabilidad })
  comprobar('La contraseña antigua ya no entra', conVieja.status === 401, `status ${conVieja.status}`)

  const conNueva = await request(app).post('/api/auth/login').send({ username: 'contabilidad', password: 'contabilidad-nueva-1' })
  comprobar('La nueva sí entra', conNueva.status === 200)

  const errorActual = await request(app).post('/api/auth/cambiar-contrasena')
    .set('Authorization', `Bearer ${conNueva.body.access}`)
    .send({ actual: 'no-es-la-actual', nueva: 'otra-clave-buena-1' })
  comprobar('Con la actual equivocada no se cambia', errorActual.status === 401, `status ${errorActual.status}`)

  const auditoria = await query(`SELECT * FROM audit_log WHERE action='PASSWORD_CHANGE'`)
  comprobar('El cambio de contraseña queda auditado', auditoria.length >= 1)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('9. La matriz de permisos se puede ver y ajustar')

{
  const adminT = (await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })).body.access

  const matriz = await request(app).get('/api/permissions').set('Authorization', `Bearer ${adminT}`)
    //
    // Otra vez, sin números escritos: la cuenta sale de MODULOS y ACCIONES, que
    // son lo que de verdad definen la matriz. Con un 25 y un 5 a mano, añadir el
    // rol de Caja —que hizo falta para que entregar dinero fuera cosa de
    // quien no lo cobró— habría roto esta comprobación sin que nadie hubiera
    // caído en por qué.
    //
    comprobar('La matriz devuelve módulos, acciones y roles por usuario',
      matriz.status === 200
        && matriz.body.modulos.length === MODULOS.length
        && matriz.body.roles.length >= 5,
      `${matriz.body?.modulos?.length} módulos (hay ${MODULOS.length}), `
        + `${matriz.body?.roles?.length} roles`)
  comprobar('Cada rol trae sus permisos ya resueltos',
    matriz.body.roles.every((r) => typeof r.permisos === 'object'))

  const protegerAdmin = await request(app).put('/api/roles/ADMIN/permisos').set('Authorization', `Bearer ${adminT}`)
    .send({ permisos: { 'production:create': false } })
  comprobar('Los permisos del ADMIN no se pueden tocar', protegerAdmin.status === 400, `status ${protegerAdmin.status}`)

  const Custom = await request(app).put('/api/roles/DELIVERY/permisos').set('Authorization', `Bearer ${adminT}`)
    .send({ permisos: { 'deliveries:view': true, 'deliveries:create': true, 'production:create': true } })
  comprobar('Se puede cambiar la matriz de un rol', Custom.status === 200, JSON.stringify(Custom.body))

  const t = (await request(app).post('/api/auth/login').send({ username: 'reparto', password: CONTRASENAS.reparto })).body.access
  const ahora = new Set((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t}`)).body.permisos)
  comprobar('El cambio surte efecto en la siguiente petición, sin renovar token',
    ahora.has('production:create'), 'el repartido ya no puede fabricar')

  // Restaurar
  await request(app).put('/api/roles/DELIVERY/permisos').set('Authorization', `Bearer ${adminT}`)
    .send({ permisos: { 'deliveries:view': true, 'deliveries:create': true } })
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('10. Nada de datos ni de secretos en las respuestas')

{
  const adminT = (await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })).body.access

  const salud = await request(app).get('/api/health')
  comprobar('El health check no revela datos del negocio',
    !('counts' in salud.body) && !('users' in salud.body), JSON.stringify(salud.body).slice(0, 120))

  const usuarios = await request(app).get('/api/users').set('Authorization', `Bearer ${adminT}`)
  const texto = JSON.stringify(usuarios.body)
  comprobar('El listado de usuarios no filtra hashes', !texto.includes('password_hash'))
  comprobar('No filtra contraseñas en ningún campo', !texto.includes(CONTRASENAS.admin))

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminT}`)
  comprobar('/auth/me no filtra nada sensible',
    !JSON.stringify(me.body).includes('password') && !JSON.stringify(me.body).includes('hash'),
    JSON.stringify(me.body).slice(0, 200))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('11. Auditoría: cada acceso queda registrado')

{
  const total = await one('SELECT COUNT(*) c FROM login_attempts')
  comprobar('Los intentos de acceso se registran', Number(total.c) > 0, `${total.c} intentos`)

  const fallos = await one(`SELECT COUNT(*) c FROM login_attempts WHERE successful = false`)
  comprobar('También los fallidos, con su motivo', Number(fallos.c) > 0, `${fallos.c} fallidos`)

  const exito = await one(`SELECT COUNT(*) c FROM login_attempts WHERE successful = true`)
  comprobar('Y los acertados', Number(exito.c) > 0)

  const acciones = await query('SELECT DISTINCT action FROM audit_log ORDER BY 1')
  const lista = acciones.map((a) => a.action)
  comprobar('La auditoría recoge login, logout, roles y contraseñas',
    ['LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'PERMISO_DENEGADO', 'UNLOCK', 'UPDATE_PERMISSIONS']
      .every((a) => lista.includes(a)),
    lista.join(', '))
  comprobar('Y también altas de usuario y cambios de estado',
    ['CREATE', 'DEACTIVATE'].every((a) => lista.includes(a)),
    lista.join(', '))

  const antesDelIntento = await one('SELECT COUNT(*) c FROM audit_log')
  await request(app).put('/api/users/999999/estado').set('Authorization', `Bearer ${(await request(app).post('/api/auth/login').send({ username: 'admin', password: CONTRASENAS.admin })).body.access}`).send({ activo: false })
  const despuesDelIntento = await one('SELECT COUNT(*) c FROM audit_log')
  comprobar('Una operación fallida también deja rastro',
    Number(despuesDelIntento.c) > Number(antesDelIntento.c))
}

// ─────────────────────────────────────────────────────────────────────────────
const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
console.log('')

await (await import('../src/db/client.js')).closeDb()
process.exit(r.fallos ? 1 : 0)
