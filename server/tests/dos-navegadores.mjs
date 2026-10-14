// DOS NAVEGADORES DE VERDAD, DOS SESIONES INDEPENDIENTES.
//
// Esta es la prueba que de verdad importa, y la que ninguna otra sustituye.
// Todo lo anterior habla con la API; aquí hay dos navegadores, dos cookieeras
// y dos personas. Si el canal funciona, lo que hace el primero aparece en la
// pantalla del segundo SIN QUE NADIE RECARGUE.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let puppeteer
try {
  // El paquete se importa por su  declarado en package.json, no por una
  // ruta adivinada dentro de : esa ruta cambia entre versiones y el
  // fallo sale como «módulo no encontrado» cuando lo que pasa es que puppeteer
  // SÍ está instalado.
  const { createRequire } = await import('node:module')
  const exigir = createRequire(import.meta.url)
  puppeteer = exigir(path.join(B, 'tests/tools/node_modules/puppeteer'))
} catch {
  console.log('  ⚠  SALTADA: puppeteer no está en server/tests/tools/node_modules')
  process.exit(0)
}

const URL = process.env.BASE || 'http://127.0.0.1:10000'

// Dos usuarios, como dos trabajadores. Se crean UNA vez con la cuenta de
// administración; si ya existen, se usan tal cual.
const SUFIJO = Date.now().toString().slice(-6)
// El nombre de usuario solo admite minúsculas: la base lo exige con un CHECK
// (^[a-z0-9._-]{3,40}$). Mayúscula y la aplicación dice «regla vulnerada»
// sin decir cuál, que es una forma de perder media hora.
const USUARIO_A = `nava${SUFIJO}`
const USUARIO_B = `navb${SUFIJO}`
const CLAVE = 'PruebaNav-2026'

async function crearTrabajadores() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  })
  const d = await r.json().catch(() => ({}))
  if (!d.access) throw new Error('no se pudo entrar como admin: ' + JSON.stringify(d).slice(0, 90))
  for (const u of [USUARIO_A, USUARIO_B]) {
    const c = await fetch(`${URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.access}` },
      body: JSON.stringify({
        username: u, fullName: `Trabajador ${u}`, email: `${u}@prueba.local`,
        password: CLAVE, roles: ['ADMIN'],
      }),
    })
    if (![200, 201].includes(c.status)) {
      const t = await c.text().catch(() => '')
      throw new Error(`no se pudo crear ${u}: HTTP ${c.status} ${t.slice(0, 80)}`)
    }
  }
  return d.access
}
let fallos = 0
const L = (ok, msg) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${msg}`); if (!ok) fallos++ }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

// Un formulario se rellena con eventos de verdad, no escribiendo el valor por
// debajo. Si se escribiera el DOM a mano, la prueba pasaría con una aplicación
// que no recibe teclado, que es justo lo que no se quiere comprobar.
async function teclear(pag, selector, texto) {
  await pag.waitForSelector(selector, { timeout: 15000 })
  await pag.click(selector, { clickCount: 3 })
  await pag.type(selector, texto, { delay: 12 })
}

async function entrar(pag, etiqueta, usuario, clave) {
  await pag.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 })
  await pag.waitForSelector('#usuario, input[name="usuario"]', { timeout: 20000 })
  await teclear(pag, '#usuario', usuario)
  await teclear(pag, '#clave, input[type="password"]', clave)
  await pag.click('button[type="submit"]')
  await pag.waitForFunction(() => !!document.querySelector('#vista'), { timeout: 25000 })
  await esperar(900)
  console.log(`    · ${etiqueta} ha entrado`)
}

// Lo que se mira es la PANTALLA, no la API. La prueba no necesita leer datos
// por la vía interna: necesita que el nombre aparezca en la página, que es lo
// que ve el trabajador.
//
// Y el token de acceso NO se puede leer desde fuera: vive en una variable del
// módulo `api.js`, no en localStorage. Leerlo de ahí no es un detalle, es que
// no existe. Por eso quien «crea» en la prueba habla con la API desde node,
// como si fuera el móvil del trabajador A, y el navegador B solo mira.
async function textoDe(pag) {
  return pag.evaluate(() => document.querySelector('#vista')?.innerText || '')
}

async function irAClientes(pag) {
  await pag.evaluate(() => { window.location.hash = '#/clientes' })
  await esperar(2200)
  // A veces hace falta un segundo intento: la pantalla carga datos y el
  // re-render llega después del hash. Un solo intento da falsos negativos.
  for (let i = 0; i < 3; i++) {
    const t = await textoDe(pag)
    if (t && t.length > 30) return t
    await esperar(1200)
  }
  return await textoDe(pag)
}

async function main() {
  console.log('\n  ══ DOS NAVEGADORES, DOS SESIONES ══\n')
  const tokenAdmin = await crearTrabajadores()
  const navegador = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    // Dos contextos separados = dos cookiejaras = dos personas. Si comparten
    // contexto, comparten sesión y la prueba no prueba nada.
    const ctxA = await navegador.createBrowserContext()
    const ctxB = await navegador.createBrowserContext()
    const A = await ctxA.newPage()
    const B = await ctxB.newPage()
    // Si la página lanza un error al cargar, hay que verlo: si no, la prueba
    // falla «en silencio» esperando datos que nunca llegan porque la pantalla
    // está en blanco, y no queda claro por qué.
    for (const [p_, n] of [[A, 'A'], [B, 'B']]) {
      p_.on('pageerror', (e) => console.log(`    [error ${n}] ${String(e.message).slice(0, 150)}`))
      p_.on('console', (m) => {
        if (m.type() === 'error') console.log(`    [consola ${n}] ${m.text().slice(0, 130)}`)
      })
      p_.on('requestfailed', (r) => console.log(`    [fallo ${n}] ${r.url().slice(0, 90)}`))
    }

    await entrar(A, 'NAVEGADOR A', USUARIO_A, CLAVE)
    await entrar(B, 'NAVEGADOR B', USUARIO_B, CLAVE)

    // ¿Está el canal abierto de verdad?
    const canalA = await A.evaluate(() => window.__sahelSync || false)
    L(canalA === true, 'el navegador A ha abierto el canal de sincronización al entrar')
    const canalB = await B.evaluate(() => window.__sahelSync || false)
    L(canalB === true, 'el navegador B también')

    // ── B mira la lista de clientes ───────────────────────────────────────
    console.log('\n  1 · UN TRABAJADOR CREA, EL OTRO LO VE EN PANTALLA')
    const marca = `NAV-${Date.now().toString().slice(-6)}`
    const pantallaAntes = await irAClientes(B)
    L(pantallaAntes.length > 20, `B está en la lista de clientes (${pantallaAntes.length} caracteres)`)
    L(!pantallaAntes.includes(marca), 'el cliente de prueba todavía NO aparece')

    // El «móvil A» habla con la API, como lo haría el suyo. Se reutiliza el
    // token de administración que ya se obtuvo al crear los trabajadores: pedir
    // OTRO login con el mismo usuario dentro de los quince minutos de la
    // ventana del limitador es jugarse un 429 por nada.
    const sesion = { access: tokenAdmin }
    const creado = await fetch(`${URL}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.access}` },
      body: JSON.stringify({ name: marca, phone: '+223 70123456' }),
    })
    console.log('    · creado: HTTP ' + creado.status)

    // Y aquí no se toca B. Solo se espera a que el canal haga lo suyo.
    let aparece = false
    for (let i = 0; i < 16; i++) {
      await esperar(1200)
      if ((await textoDe(B)).includes(marca)) { aparece = true; break }
    }
    L(aparece, aparece
      ? `B lo ve EN PANTALLA, sin recargar: ${marca}`
      : 'B NO lo ve tras 19 segundos de espera')

    // ── El formulario a medio rellenar NO se pisa ─────────────────────────
    console.log('\n  2 · UN FORMULARIO A MEDIO RELLENAR NO SE PIERDE')
    await irAClientes(A)
    await A.evaluate(() => {
      const f = document.createElement('form')
      f.id = 'formulario-de-prueba'
      f.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:#fff'
      f.innerHTML = '<input id="campo-protegido" value="escrito a medias">'
      document.body.prepend(f)
    })
    // Alguien más escribe algo, y A tiene el formulario abierto.
    await fetch(`${URL}/api/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.access}` },
      body: JSON.stringify({ name: `${marca}-otro`, phone: '+223 70987654' }),
    })
    await esperar(6000)
    const conserva = await A.evaluate(() => document.querySelector('#campo-protegido')?.value || 'DESAPARECIDO')
    L(conserva === 'escrito a medias',
      `lo que A tenía a medias NO se ha perdido: "${conserva}"`)

    // ── Y la escritura de verdad sigue funcionando ────────────────────────
    console.log('\n  3 · ESCRIBIR DESDE EL NAVEGADOR SIGUE FUNCIONANDO')
    await A.evaluate(async (nombre) => {
      const f = document.querySelector('#formulario-de-prueba')
      if (f) f.remove()
      // Se usa la misma API que la aplicación: el token lo tiene el módulo.
      const mod = await import('/js/api.js')
      await mod.api('/customers', { metodo: 'POST', cuerpo: { name: nombre, phone: '+223 70707070' } })
    }, `${marca}-teclado`)
    await esperar(900)
    const escrito = await A.evaluate(() => document.querySelector('#avisos')?.innerText || '')
    L(!/error/i.test(escrito), `escribir desde el navegador no da error: "${escrito.slice(0, 60) || 'sin aviso'}"`)
  } finally {
    await navegador.close()
  }
  console.log(`\n  ${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`}\n`)
  process.exit(fallos ? 1 : 0)
}
main()
