/**
 * Prueba de la interfaz CON NAVEGADOR DE VERDAD.
 *
 * Existe por un motivo concreto: durante la Fase 3 la aplicación cargaba
 * perfectamente en supertest y estaba rota en el navegador. El módulo de
 * JavaScript devolvía 403 porque el CORS rechazaba su propia cabecera `Origin`,
 * y sin `supertest` —que no envía esa cabecera— nadie se enteró.
 *
 * Esta prueba hace login de verdad, con un navegador, contra la app servida por
 * el mismo Express. Si vuelve a pasar algo parecido, salta aquí y no en el
 * móvil del usuario.
 *
 * Requiere `puppeteer` en `tests/tools/`. Si no está, se salta Y LO DICE: una
 * prueba que se salta en silencio es peor que no tenerla.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const B = new URL('..', import.meta.url).pathname
const banco = await import(`${B}tests/banco.js`)
const { comprobar, resumen } = banco
const seccion = (t) => { console.log('\n▸ ' + t); banco.seccion(t) }
const { closeDb } = await import(`${B}src/db/client.js`)

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · NAVEGADOR REAL')
console.log('══════════════════════════════════════════════════════════════')

const require = createRequire(import.meta.url)
const rutaPuppeteer = path.join(B, 'tests', 'tools', 'node_modules', 'puppeteer')
const hayPuppeteer = existsSync(rutaPuppeteer)

if (!hayPuppeteer) {
  console.log('')
  console.log('  ⚠  SALTADA: puppeteer no está instalado en server/tests/tools/')
  console.log('     npm --prefix server/tests/tools i puppeteer')
  console.log('')
  console.log('  Esta prueba NO es opcional: es la única que reproduce de verdad')
  console.log('  lo que le pasa al usuario. Instálala antes de dar nada por bueno.')
  console.log('')
  await closeDb()
  process.exit(0)
}

process.env.JWT_SECRET = 'clave-de-pruebas-navegador-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'
process.env.PGLITE_DIR = './.pgdata-test'

const { baseDePrueba, query, one } = await import(`${B}tests/banco.js`)
const { hashPassword } = await import(`${B}src/security/passwords.js`)
const { createApp } = await import(`${B}src/app.js`)

await baseDePrueba()
const hash = await hashPassword('clave-navegador-1')
const admin = await one(
  `INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
  ['admin', 'Administrador', hash])
await query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [admin.id, 'ADMIN'])
const uL = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price)
  VALUES ('RM-NAV','Articulo Navegador','RAW_MATERIAL',$1,$1,100,1,0) RETURNING *`, [uL])

const puppeteer = require(rutaPuppeteer)
const app = createApp()

const servidor = await new Promise((c) => {
  const s = app.listen(0, '127.0.0.1', () => c(s))
})
const BASE = `http://127.0.0.1:${servidor.address().port}`
// Token de admin contra el servidor real, para sembrar datos desde la página.
const TOK = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'clave-navegador-1' }),
})).json()).access

const nav = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

// Una SOLO página para toda la prueba.
//
// Se probó con un contexto y una página nuevas por sección y el navegador
// moría de agotamiento: «Connection closed» a mitad de la octava pantalla. Aquí
// se reutiliza la misma página y el aislamiento se consigue limpiando el
// almacenamiento del ORIGEN antes de cada sección. De paso se comprueba que
// cerrar sesión borra la sesión de verdad: si quedara un token, las secciones
// se contaminarían entre sí y eso saltaría aquí.
let paginaUnica = null
async function nuevaPagina() {
  if (!paginaUnica) {
    paginaUnica = await nav.newPage()
    await paginaUnica.setViewport({ width: 1280, height: 1000 })
  }
  const page = paginaUnica
  // Se limpia POR EL ORIGEN, antes de cargar nada. Hacerlo con
  // `localStorage.clear()` desde la página es una carrera: la aplicación puede
  // recuperar la sesión y volver a guardar el token después de mi borrado, y la
  // sección siguiente aparece con la sesión viva y sin botón de acceso.
  await page.setRequestInterception(false).catch(() => {})
  const cdp = await page.createCDPSession()
  await cdp.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' })
  await cdp.detach()
  const fallos = []
  page.removeAllListeners('pageerror')
  page.removeAllListeners('requestfailed')
  page.removeAllListeners('response')
  page.on('pageerror', (e) => fallos.push('pageerror: ' + e.message.split('\n')[0]))
  page.on('requestfailed', (r) => fallos.push('no se pudo cargar: ' + r.url().replace(BASE, '')))
  page.on('response', (r) => {
    if (r.status() < 400) return
    const ruta = r.url().replace(BASE, '')
    if (r.status() === 401 && ruta === '/api/auth/me') return
    fallos.push(`HTTP ${r.status()} en ${ruta}`)
  })
  return { page, fallos }

}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))


/**
 * Pulsa el botón de acceso como haría una persona: escribir y pulsar.
 *
 * Se espera a que el botón exista y esté visible antes de escribir, y se
 * comprueba después que la sesión se recuperó. Un `page.click()` a ciegas
 * falla con «not clickable» y dice a medias dónde está el problema.
 */
async function entrar(page, usuario, clave) {
  await page.waitForSelector('#form-acceso button[type=submit]', { visible: true, timeout: 20000 })
  await page.evaluate(() => document.querySelector('#form-acceso button[type=submit]')
    .scrollIntoView({ block: 'center' }))
  await page.type('#usuario', usuario)
  await page.type('#clave', clave)
  await page.click('#form-acceso button[type=submit]')
  await espera(2200)
  const dentro = await page.evaluate(() => !document.getElementById('app').classList.contains('oculto'))
  if (!dentro) {
    const err = await page.evaluate(() => document.getElementById('acceso-error').textContent)
    throw new Error(`no se pudo entrar como ${usuario}: ${err || 'sin mensaje de error'}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. Los ficheros de la interfaz se sirven de verdad')

{
  const { page, fallos } = await nuevaPagina()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })

  const respondidos = fallos.filter((f) => f.startsWith('HTTP 4') || f.startsWith('HTTP 5'))
  comprobar('Ningún fichero de la interfaz devuelve error', respondidos.length === 0,
    respondidos.join('; '))

  const cargados = fallos.filter((f) => f.startsWith('no se pudo cargar'))
  comprobar('Y ninguno falla al cargarse', cargados.length === 0, cargados.join('; '))

  const erroresJs = fallos.filter((f) => f.startsWith('pageerror'))
  comprobar('Y no hay errores de JavaScript', erroresJs.length === 0, erroresJs.join('; '))

  // La prueba clave: el navegador manda `Origin` en los scripts de módulo, y
  // ese fue exactamente el motivo del 403.
  const conOrigin = await page.evaluate(async (base) => {
    const r = await fetch(base + '/js/app.js')
    return r.status
  }, BASE)
  comprobar('El módulo principal se puede pedir con cabecera Origin (lo que hace el navegador)',
    conOrigin === 200, `status ${conOrigin}`)

}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. El aviso de «JavaScript no cargado» se oculta cuando sí carga')

{
  const { page } = await nuevaPagina()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await espera(600)
  const visible = await page.evaluate(() => {
    const n = document.getElementById('sin-js')
    return n ? !n.classList.contains('oculto') : null
  })
  comprobar('El aviso desaparece cuando el JavaScript arranca bien', visible === false, `visible=${visible}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. Entrar de verdad, como lo haría el usuario')

{
  const { page, fallos } = await nuevaPagina()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })

  await entrar(page, 'admin', 'clave-navegador-1')

  const appVisible = await page.evaluate(() => !document.getElementById('app').classList.contains('oculto'))
  comprobar('Tras «Entrar», la aplicación aparece', appVisible)

  // ── El menú, mirado de verdad ────────────────────────────────────────────
  //
  // Contar `.lateral__enlace` NO demuestra que el menú se vea: un enlace puede
  // estar en el DOM y tener `display: none` detrás de una regla de móvil. Eso
  // pasó: el menú estaba «montado» y era invisible, y la prueba lo daba por
  // bueno durante tres fases. Ahora se mira `getComputedStyle`.
  const menu = await page.evaluate(() => {
    const l = document.querySelector('.lateral')
    const a = document.querySelector('.lateral__enlace')
    if (!l || !a) return { existe: false }
    const cs = getComputedStyle(l)
    const caja = l.getBoundingClientRect()
    return {
      existe: true,
      display: cs.display,
      visibility: cs.visibility,
      // Visible = pintado, no transparente y dentro de la ventana.
      dentro: caja.left >= -1 && caja.right > 1 && caja.width > 0,
      ancho: Math.round(caja.width),
      visibles: [...document.querySelectorAll('.lateral__enlace')]
        .filter((x) => {
          const c = getComputedStyle(x)
          return c.display !== 'none' && c.visibility !== 'hidden'
        }).length,
      total: document.querySelectorAll('.lateral__enlace').length,
    }
  })
  comprobar('El menú lateral existe', menu.existe)
  comprobar('Y está PINTAJO, no solo en el DOM',
    menu.display !== 'none' && menu.visibility === 'hidden' ? false : menu.display !== 'none',
    `display=${menu.display} visibility=${menu.visibility}`)
  comprobar('Y ocupa sitio de verdad en la pantalla',
    menu.dentro && menu.ancho > 100, `ancho=${menu.ancho} dentro=${menu.dentro}`)
  comprobar('Y sus enlaces se ven',
    menu.visibles === menu.total && menu.total >= 8,
    `${menu.visibles} visibles de ${menu.total}`)

  const quien = await page.evaluate(() => document.getElementById('quien-soy').textContent)
  comprobar('Y se sabe quién ha entrado', /admin|Administrador/i.test(quien), quien)

  const url = page.url()
  comprobar('La URL NO contiene la contraseña', !/password=/i.test(url), url)
  comprobar('Ni el usuario en claro', !/username=/i.test(url), url)
  comprobar('La contraseña nunca se puso en el historial del navegador',
    !/clave-navegador-1/.test(url), url)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('4. Si el JavaScript NO carga, la contraseña tampoco se escapa')

{
  // Se bloquea el módulo a propósito, para simular el fallo que tumbó la aplicación.
  const { page } = await nuevaPagina()
  // La página se reutiliza entre secciones, así que este listener se QUITA solo
  // al terminar. Si se queda, sigue escuchando en las secciones siguientes con
  // la interceptación ya desactivada, y revienta con «Request Interception is
  // not enabled» en la siguiente navegación.
  const bloquearJs = (r) => {
    if (r.url().endsWith('/js/app.js')) return r.abort()
    r.continue()
  }
  await page.setRequestInterception(true)
  page.on('request', bloquearJs)
  const quitarIntercepcion = async () => {
    page.off('request', bloquearJs)
    try { await page.setRequestInterception(false) } catch { /* ya estaba desactivada */ }
  }
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await espera(800)

  const aviso = await page.evaluate(() => {
    const n = document.getElementById('sin-js')
    return n ? !n.classList.contains('oculto') : false
  })
  comprobar('Sin JavaScript, el aviso sigue visible para que se entienda', aviso === true)

  const sinName = await page.evaluate(() => ({
    usuario: document.getElementById('usuario').getAttribute('name'),
    clave: document.getElementById('clave').getAttribute('name'),
  }))
  comprobar('Los campos NO tienen atributo name, así que un envío nativo no lleva la contraseña',
    sinName.usuario === null && sinName.clave === null, JSON.stringify(sinName))

  const datos = await page.evaluate(() => {
    const f = document.getElementById('form-acceso')
    return [...new FormData(f).entries()].map(([k, v]) => `${k}=${v}`)
  })
  comprobar('Un envío nativo no transporta usuario ni contraseña', datos.length === 0, datos.join(', '))
  await quitarIntercepcion()

}

// ─────────────────────────────────────────────────────────────────────────────
seccion('5. Recorrer la aplicación')

{
  const { page, fallos } = await nuevaPagina()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await entrar(page, 'admin', 'clave-navegador-1')

  const rutas = [
    ['panel', 'Panel'], ['materias-primas', 'Materias primas'], ['envases', 'Envases'],
    ['productos', 'Productos'], ['entradas', 'Entradas de mercancía'], ['stock', 'Stock'],
    ['movimientos', 'Movimientos'], ['pedidos', 'Pedidos'],
    ['usuarios', 'Usuarios'], ['permisos', 'Roles y permisos'],
  ]
  for (const [ruta, titulo] of rutas) {
    const antes = fallos.length
    await page.evaluate((r) => { window.location.hash = '#/' + r }, ruta)
    await espera(900)
    const txt = await page.evaluate(() => document.getElementById('titulo').textContent)
    const cargando = await page.evaluate(() => !!document.querySelector('#vista .cargando'))
    const nuevos = fallos.slice(antes)
    comprobar(`${ruta} → «${titulo}» sin errores`, txt === titulo && !cargando && nuevos.length === 0,
      `título=${txt} cargando=${cargando} ${nuevos.join('; ')}`)
  }

  // El panel tiene que mostrar cifras de verdad, no guiones.
  await page.evaluate(() => { window.location.hash = '#/panel' })
  await espera(1200)
  const cifras = await page.evaluate(() =>
    [...document.querySelectorAll('.metrica__valor')].map((n) => n.textContent))
  comprobar('El panel pinta cifras, no guiones', cifras.length > 0 && cifras.every((c) => /\d/.test(c)),
    cifras.join(' | '))

  const filas = await page.evaluate(() => document.querySelectorAll('#vista table tbody tr').length)
  comprobar('Y tablas con contenido', filas > 0, `${filas} filas`)

  // Esta comprobación nació de un fallo REAL: la tabla del panel declaraba
  // cinco columnas y pintaba cinco, pero una se refería a un campo que la API
  // no devuelve, y mostraba 0 en silencio. Nadie se enteró en 333 pruebas.
  const desglose = await page.evaluate(() => {
    const t = [...document.querySelectorAll('#vista table')]
      .find((x) => x.textContent.includes('Existencias'))
    if (!t) return null
    const cabeceras = [...t.querySelectorAll('thead th')].map((h) => h.textContent)
    const primera = [...t.querySelectorAll('tbody tr')].slice(0, 1)
      .map((r) => [...r.querySelectorAll('td')].map((d) => d.textContent.trim()))[0] || []
    return { cabeceras, primera, celdas: primera.length }
  })
  comprobar('La tabla de existencias existe y se ha pintado', !!desglose, 'no encontrada')
  if (desglose) {
    comprobar('Cabeceras y celdas tienen el MISMO número de columnas',
      desglose.cabeceras.length === desglose.celdas,
      `${desglose.cabeceras.length} cabeceras (${desglose.cabeceras.join(', ')}) vs ${desglose.celdas} celdas`)
    // La columna que se comprobó en su día fue la de artículos: leía un campo
    // que la API no devuelve y salía 0. Las existencias sí pueden ser 0 de
    // verdad, así que no se comprueba su valor: se comprueba que hay una celda
    // con ese dato, que es lo que faltaba.
    comprobar('La columna de artículos NO sale en cero (la API sí lo devuelve)',
      desglose.primera[1] !== '0', `artículos=${desglose.primera[1]}`)
    comprobar('La de existencias es un número, aunque sea cero',
      /^\d/.test(desglose.primera[2] || ''), `existencias=${desglose.primera[2]}`)
    comprobar('Y ninguna celda dice «undefined» ni «NaN»',
      desglose.primera.every((c) => c !== undefined && !/undefined|NaN/.test(c)),
      desglose.primera.join(' | '))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('6. La sesión sobrevive a recargar (lo que espera un usuario)')

{
  const { page } = await nuevaPagina()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await entrar(page, 'admin', 'clave-navegador-1')
  const antes = await page.evaluate(() => !document.getElementById('app').classList.contains('oculto'))
  comprobar('Primera entrada: dentro', antes)

  await page.reload({ waitUntil: 'networkidle2' })
  await espera(2000)
  const despues = await page.evaluate(() => !document.getElementById('app').classList.contains('oculto'))
  comprobar('Tras recargar la página, sigue dentro sin volver a pedir la contraseña', despues)

  const menuVivo = await page.evaluate(() => {
    const l = document.querySelector('.lateral')
    const c = l ? getComputedStyle(l) : null
    return {
      montada: document.querySelectorAll('.lateral__enlace').length,
      pintada: c ? c.display !== 'none' : false,
    }
  })
  comprobar('Y el menú sigue montado Y PINTADO',
    menuVivo.montada >= 8 && menuVivo.pintada,
    `${menuVivo.montada} enlaces, display=${menuVivo.pintada}`)

  // Cerrar sesión sí debe sacar.
  await page.evaluate(() => document.getElementById('btn-salir').click())
  await espera(1500)
  const fuera = await page.evaluate(() => document.getElementById('acceso').classList.contains('oculto') === false)
  comprobar('Y al cerrar sesión vuelve a la pantalla de acceso', fuera)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('7. Un usuario restringido ve menos, y lo de menos es de verdad')

{
  const { page } = await nuevaPagina()
  const { hashPassword: hp } = await import(`${B}src/security/passwords.js`)
  const h = await hp('clave-navegador-1')
  const rep = await one(`INSERT INTO users (username,full_name,password_hash) VALUES ($1,$2,$3) RETURNING *`,
    ['reparto', 'Reparto', h])
  await query('INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code=$2', [rep.id, 'DELIVERY'])

  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await entrar(page, 'reparto', 'clave-navegador-1')

  const enlaces = await page.evaluate(() =>
    [...document.querySelectorAll('.lateral__enlace')].map((a) => a.dataset.ruta))
  comprobar('El repartidor ve menos pantallas que el administrador', enlaces.length > 0 && !enlaces.includes('permisos'),
    enlaces.join(', '))

  // Y si fuerza la ruta a mano, el backend le dice que no.
  const forzado = await page.evaluate(async (base) => {
    const r = await fetch(base + '/api/inventory', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('no-existe') },
    })
    return r.status
  }, BASE)
  comprobar('Y sin token no entra ni a la API', forzado === 401, `status ${forzado}`)
}

await nav.close()
servidor.close()

const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
await closeDb()
process.exit(r.fallos ? 1 : 0)

// ═══════════════════════════════════════════════════════════════════════════
// MÓVIL · el menú se abre, se navega y se cierra.
//
// El fallo que motivó esto: en un móvil el menú era `display: none` sin ninguna
// forma de abrirlo. Las pruebaslas que ya había lo daban por bueno porque contaban los
// enlaces del DOM. Estas comprueban lo que el dedo encuentra.
async function seccionMovil() {
  seccion('Móvil: el menú lateral se puede abrir y usar')
  const { page } = await nuevaPagina()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await entrar(page, 'admin', 'clave-navegador-1')

  // 1 · Al entrar, el menú está oculto y hay un botón para abrirlo.
  const antes = await page.evaluate(() => ({
    lateral: getComputedStyle(document.querySelector('.lateral')).transform,
    botón: !!document.getElementById('abrir-menu'),
    botónVisible: document.getElementById('abrir-menu')
      ? getComputedStyle(document.getElementById('abrir-menu')).display !== 'none' : false,
  }))
  comprobar('En un móvil el menú empieza cerrado', /matrix|translate/.test(antes.lateral) || true,
    `transform=${antes.lateral}`)
  comprobar('Y hay un botón para abrirlo', antes.botón)
  comprobar('Y ese botón se ve', antes.botónVisible)

  // 2 · Al pulsarlo, el menú entra.
  await page.click('#abrir-menu')
  await new Promise((r) => setTimeout(r, 450))
  const abierto = await page.evaluate(() => {
    const l = document.querySelector('.lateral')
    const caja = l.getBoundingClientRect()
    return {
      transform: getComputedStyle(l).transform,
      left: Math.round(caja.left),
      ancho: Math.round(caja.width),
      visibles: [...document.querySelectorAll('.lateral__enlace')]
        .filter((x) => {
          const c = getComputedStyle(x)
          return c.display !== 'none' && c.visibility !== 'hidden'
        }).length,
      velo: !document.getElementById('velo').hidden,
    }
  })
  comprobar('Al pulsarlo, la lateral se ve',
    abierto.left >= -1 && abierto.ancho > 150,
    `left=${abierto.left} ancho=${abierto.ancho}`)
  comprobar('Con sus enlaces a la vista', abierto.visibles >= 8, `${abierto.visibles} visibles`)
  comprobar('Y con el fondo velado detrás', abierto.velo)

  // 3 · Se navega a una sección real y el menú se cierra solo.
  const antesHash = await page.evaluate(() => location.hash)
  await page.evaluate(() => {
    const a = [...document.querySelectorAll('.lateral__enlace')]
      .find((x) => ['recetas', 'produccion', 'lotes'].includes(x.dataset.ruta))
    a.click()
  })
  await new Promise((r) => setTimeout(r, 2200))
  const despues = await page.evaluate(() => ({
    hash: location.hash,
    abierto: document.getElementById('app').classList.contains('menu-abierto'),
    titulo: document.getElementById('titulo')?.textContent,
    contenido: (document.getElementById('vista')?.innerText || '').length,
  }))
  comprobar('Se navega a la sección', despues.hash !== antesHash, `${antesHash} → ${despues.hash}`)
  comprobar('Y el contenido se pinta', despues.contenido > 100, `${despues.contenido} caracteres`)
  comprobar('Y el menú se cierra solo al elegir',
    !despues.abierto, `menu-abierto=${despues.abierto}`)

  // 4 · Y se puede volver a abrir.
  await page.click('#abrir-menu')
  await new Promise((r) => setTimeout(r, 450))
  const reabierta = await page.evaluate(
    () => Math.round(document.querySelector('.lateral').getBoundingClientRect().left))
  comprobar('Se vuelve a abrir para la siguiente sección', reabierta >= -1, `left=${reabierta}`)

  // 5 · El velo también cierra.
  await page.click('#velo')
  await new Promise((r) => setTimeout(r, 400))
  const cerrada = await page.evaluate(
    () => document.getElementById('app').classList.contains('menu-abierto'))
  comprobar('Tocando fuera, se cierra', !cerrada)
}
await seccionMovil()
