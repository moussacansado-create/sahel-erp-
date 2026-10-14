/**
 * PROBAR LA PANTALLA DE CLIENTES CON UN NAVEGADOR DE VERDAD.
 *
 * Leer el código y decir «esto funciona» no es probarlo. Aquí se abre la web,
 * se rellena el formulario a mano y se pulsa el botón, y se mira qué pasa
 * después: qué dice la red, qué contesta el servidor y qué queda guardado.
 *
 * Porque el síntoma que hay que explicar es este: la pantalla da la impresión
 * de que el cliente se ha creado, y luego no existe. Eso solo pasa de una de
 * estas tres maneras:
 *
 *   1. la petición no sale del navegador (error de JavaScript antes del clic)
 *   2. sale y el servidor la rechaza, y la interfaz se come el error
 *   3. sale, el servidor la acepta… y no la guarda
 *
 * Y cada una se arregla de una manera distinta. Sin saber cuál es, arreglar es
 * adivinar.
 */

// El servidor es PROPIO, en un puerto libre, sobre la base de pruebas.
//
// Antes esto apuntaba a `127.0.0.1:10000`, que es el servidor de la
// demostracion. Con los tests ahi, cada ejecucion escribia en la demo y le
// dejaba clientes de prueba. `entornoConDemo()` levanta su base, la siembra y
// levanta su servidor.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('clientes-pantalla.test.mjs', BASE)
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const puppeteer = require('./tools/node_modules/puppeteer')

const MARCA = 'MOUSSA-' + Date.now().toString(36).toUpperCase()

const navegador = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const pagina = await navegador.newPage()

// TODO lo que pasa por la red, y TODOS los errores de consola. Si algo falla
// en silencio, aquí está.
const red = []
const consola = []
pagina.on('request', (rq) => {
  if (rq.url().includes('/api/')) red.push({ tipo: 'petición', metodo: rq.method(), url: rq.url().replace(BASE, ''), cuerpo: rq.postData() })
})
pagina.on('response', async (rs) => {
  if (!rs.url().includes('/api/')) return
  let cuerpo = ''
  try { cuerpo = (await rs.text()).slice(0, 200) } catch { cuerpo = '(sin cuerpo)' }
  red.push({ tipo: 'respuesta', estado: rs.status(), url: rs.url().replace(BASE, ''), cuerpo })
})
pagina.on('console', (m) => consola.push(`${m.type()}: ${m.text()}`.slice(0, 180)))
pagina.on('pageerror', (e) => consola.push(`EXCEPCIÓN: ${String(e.message).slice(0, 180)}`))

const c = (s, n = 40) => String(s).padEnd(n)
let fallos = 0
const mal = (t, x = '') => { fallos++; console.log(`  ✗ ${t}${x ? '   ' + x : ''}`) }
const ok = (t) => console.log(`  ✓ ${t}`)

console.log('\n' + '═'.repeat(74))
console.log('  PROBAR LA PANTALLA DE CLIENTES, EN UN NAVEGADOR DE VERDAD')
console.log('═'.repeat(74))

// ─── Entrar ────────────────────────────────────────────────────────
await pagina.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
await pagina.waitForSelector('#usuario, input[name=usuario], #login-usuario', { timeout: 15000 })
  .catch(() => { throw new Error('no aparece el formulario de acceso') })

const campos = await pagina.$$eval('input', (els) => els.map((e) => ({ id: e.id, name: e.name, type: e.type, ph: e.placeholder })))
console.log(`  campos del formulario de acceso: ${campos.map((x) => x.name || x.id).join(', ')}`)

const escribir = async (sel, valor) => {
  const el = await pagina.$(sel)
  if (!el) return false
  await el.click({ clickCount: 3 })
  await el.type(valor, { delay: 5 })
  return true
}

await escribir('#usuario', 'admin')
await escribir('#clave', 'demo1234')
await Promise.all([
  pagina.click('button[type=submit]'),
  pagina.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
])
await new Promise((r) => setTimeout(r, 1500))

const dentro = await pagina.$eval('body', (b) => b.innerText.slice(0, 400))
if (/acceso|iniciar sesión|contraseña/i.test(dentro) && !/panel|pedido|cliente/i.test(dentro)) {
  mal('no se ha podido entrar en la web')
  console.log(`     se ve: ${dentro.replace(/\n/g, ' ').slice(0, 120)}`)
} else ok('sesión iniciada en la web')

// ─── Ir a Clientes ─────────────────────────────────────────────────
await pagina.goto(`${BASE}/#/clientes`, { waitUntil: 'networkidle2', timeout: 20000 })
  .catch(() => {})
await new Promise((r) => setTimeout(r, 2000))

const hayBotonNuevo = await pagina.evaluate(() =>
  [...document.querySelectorAll('button')].some((b) => /nuevo cliente/i.test(b.textContent)))
if (!hayBotonNuevo) {
  mal('no aparece el botón «+ Nuevo cliente»')
  console.log(`     botones: ${await pagina.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 24)).join(' | ').slice(0, 200))}`)
} else ok('el botón «+ Nuevo cliente» está')

// ─── Rellenar y crear ──────────────────────────────────────────────
red.length = 0
await pagina.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /nuevo cliente/i.test(x.textContent))
  b.click()
})
await new Promise((r) => setTimeout(r, 800))

const inputs = await pagina.$$eval('.modal input, [role=dialog] input, .capa input', (els) =>
  els.map((e, i) => ({ i, ph: e.placeholder, type: e.type })))
console.log(`  campos del formulario de alta: ${inputs.map((x) => x.ph ?? x.type).join(' | ').slice(0, 160)}`)

const rellenarPorPlaceholder = async (ph, valor) => {
  const okhecho = await pagina.evaluate((ph, valor) => {
    const e = [...document.querySelectorAll('input, textarea')].find((x) => (x.placeholder ?? '').toLowerCase().includes(ph.toLowerCase()))
    if (!e) return false
    e.value = valor
    e.dispatchEvent(new Event('input', { bubbles: true }))
    e.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, ph, valor)
  return okhecho
}

await rellenarPorPlaceholder('Nombre del cliente', 'Moussa Prueba Navegador')
await rellenarPorPlaceholder('Empresa', 'Sahel')
await rellenarPorPlaceholder('Teléfono', '+22370000123')

console.log(`  se va a crear: «Moussa Prueba Navegador» / empresa «Sahel»  [marca ${MARCA}]`)

await pagina.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^crear$/i.test(x.textContent.trim()))
  if (b) b.click()
})
await new Promise((r) => setTimeout(r, 3000))

// ─── Qué ha pasado por la red ──────────────────────────────────────
console.log('')
console.log('  ── Lo que ha pasado por la red al pulsar «Crear»:')
const posted = red.filter((x) => x.tipo === 'petición' && x.metodo === 'POST')
if (!posted.length) {
  mal('NO ha salido ninguna petición POST. El botón no ha hecho nada.')
} else {
  for (const p of posted) console.log(`     → ${p.metodo} ${p.url}`)
  console.log(`     cuerpo: ${(posted[0].cuerpo ?? '(vacío)').slice(0, 160)}`)
}
for (const r of red.filter((x) => x.tipo === 'respuesta' && x.estado >= 400)) {
  mal(`el servidor ha contestado ${r.estado} en ${r.metodo} ${r.url}`, `→ ${r.cuerpo.slice(0, 120)}`)
}
const okPost = red.filter((x) => x.tipo === 'respuesta' && x.estado < 400 && x.url.includes('/customers'))
if (okPost.length) ok(`el servidor ha contestado ${okPost[okPost.length - 1].estado}: ${okPost[okPost.length - 1].cuerpo.slice(0, 90)}`)

if (consola.length) {
  console.log('')
  console.log('  ── Lo que dijo el navegador:')
  for (const m of consola.slice(0, 6)) console.log(`     ${m}`)
}

// ─── ¿Está en la base? ─────────────────────────────────────────────
console.log('')
const busqueda = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
}).then((r) => r.json())

const lista = await fetch(`${BASE}/api/customers`, {
  headers: { Authorization: `Bearer ${busqueda.access}` },
}).then((r) => r.json())

const encontrado = lista.find((x) => /Moussa Prueba Navegador/i.test(x.name))
if (encontrado) ok(`el cliente ESTÁ en la base: ${encontrado.code} · ${encontrado.name}`)
else mal('el cliente NO está en la base, aunque la pantalla haya dado el alta por buena')

// ─── Qué ve ahora la pantalla ──────────────────────────────────────
const textoPantalla = await pagina.evaluate(() => document.body.innerText)
if (/Moussa Prueba Navegador/i.test(textoPantalla)) ok('y además aparece en la pantalla')
else mal('y NO aparece en la lista de la pantalla')

console.log('\n' + '═'.repeat(74))
console.log(fallos === 0 ? '  LA PANTALLA SÍ DA DE ALTA' : `  HAY ${fallos} PROBLEMAS EN LA PANTALLA`)
console.log('═'.repeat(74) + '\n')

await navegador.close()
process.exit(fallos === 0 ? 0 : 1)