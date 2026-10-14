/**
 * Arnés del SKU AUTOMÁTICO.
 *
 * Comprueba en un navegador de verdad lo que se ve al teclear un nombre en el
 * formulario de alta: que el código aparece solo, que se puede rectificar, y
 * que avisa cuando el material ya existe.
 *
 * Por pantalla y no contra la API, porque lo que se prueba es el FORMULARIO: un
 * endpoint que responde bien no dice nada de si el campo se rellena solo.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer')
const B = process.env.BASE || 'http://127.0.0.1:10000'
const L = (ok, t) => console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t)

/** Abre el formulario de alta de un catálogo del menú. */
async function abrirAlta(p, ruta) {
  await p.evaluate((r) => {
    const a = document.querySelector('a[data-ruta="' + r + '"]')
    if (!a) throw new Error('no hay enlace de menú para ' + r)
    a.click()
  }, ruta)
  // Se espera AL botón de alta y no a «un botón»: la pantalla tiene siempre
  // otros («Cerrar sesión», «Entrar»), y esperar a cualquiera de ellos da una
  // falsa señal de que la página está lista cuando lo que aún no ha llegado es
  // la tabla del catálogo.
  await p.waitForFunction(
    () => [...document.querySelectorAll('button')]
      .some((b) => b.textContent.includes('Nuevo') && b.getBoundingClientRect().width > 0),
    { timeout: 20000 },
  )
  await p.evaluate(() => {
    [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Nuevo')).click()
  })
  await p.waitForSelector('.capa__dialogo label.campo', { visible: true, timeout: 20000 })
  await new Promise((r) => setTimeout(r, 400))
}

/**
 * El control de un campo, buscado por su ETIQUETA.
 *
 * `campo()` pinta un <label> con un <span> que es la etiqueta y el control
 * detrás. Los índices fijos («el segundo input») se rompen en cuanto se añade
 * un campo al formulario, y un arnés que se rompe al ampliar el formulario
 * acaba dando greens falsos.
 */
async function controlDe(p, etiqueta) {
  await p.waitForFunction((t) => {
    const d = document.querySelector('.capa__dialogo')
    return d && [...d.querySelectorAll('label.campo')]
      .some((x) => (x.querySelector('span') || {}).textContent === t)
  }, { timeout: 15000 }, etiqueta)
  const h = await p.evaluateHandle((t) => {
    const d = document.querySelector('.capa__dialogo')
    const l = [...d.querySelectorAll('label.campo')]
      .find((x) => (x.querySelector('span') || {}).textContent === t)
    return l.querySelector('input, select, textarea')
  }, etiqueta)
  return h.asElement()
}

const leerCampo = (p, etiqueta) => p.evaluate((t) => {
  const d = document.querySelector('.capa__dialogo')
  const l = [...d.querySelectorAll('label.campo')]
    .find((x) => (x.querySelector('span') || {}).textContent === t)
  return l.querySelector('input') ? l.querySelector('input').value : null
}, etiqueta)

const leerPista = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.capa__dialogo p.pequeno')]
    .map((x) => x.textContent).join(' | ').trim())

const cerrar = (p) => p.evaluate(() => {
  const c = document.querySelector('.capa')
  if (c) c.remove()
})

async function teclearNombre(p, texto) {
  const nombre = await controlDe(p, 'Nombre')
  await nombre.click()
  // `click({clickCount:3})` no selecciona de forma fiable un input ya relleno:
  // deja el cursor al final y lo tecleado se pega detrás. Con el propio DOM,
  // que es lo que hace el navegador al entrar, no hay sorpresas.
  await nombre.evaluate((x) => x.select())
  await nombre.type(texto, { delay: 12 })
  await new Promise((r) => setTimeout(r, 1000)) // la deducción va con retardo
  return { sku: await leerCampo(p, 'SKU'), pista: await leerPista(p) }
}

/**
 * Entra y deja la aplicación abierta, sin escribir en el formulario.
 *
 * El login va con un límite de 10 intentos cada 15 minutos, por IP y usuario.
 * Un arnés que teclee la contraseña se come ese presupuesto con sus propias
 * pasadas, y a partir de la décima se queda esperando a una aplicación que no
 * arranca nunca. Con un login por `fetch` y el token de refresco sembrado en
 * `localStorage`, la aplicación se recupera sola —`app.js` llama a
 * `A.recuperar()` al arrancar— y el arnés aguanta muchas más pasadas.
 */
async function sesionDePrueba() {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  })
  if (r.status === 429) return null
  if (!r.ok) throw new Error('el login devolvió ' + r.status)
  return (await r.json()).refresh
}

async function abrirApp(p, refresh) {
  await p.evaluateOnNewDocument((r) => {
    try { localStorage.setItem('cs2.refresh', r) } catch {}
  }, refresh)
  await p.goto(B + '/', { waitUntil: 'networkidle2', timeout: 45000 })
  await p.waitForFunction(
    () => { const a = document.getElementById('app'); return a && !a.classList.contains('oculto') },
    { timeout: 25000 },
  )
  await p.waitForSelector('a[data-ruta="caja"]', { visible: true, timeout: 15000 })
}

async function main() {
  const nav = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const p = await nav.newPage()
  await p.setCacheEnabled(false)
  await p.setViewport({ width: 1400, height: 1000 })
  const fallos = []
  const check = (ok, t) => { L(ok, t); if (!ok) fallos.push(t) }

  try {
    const refresh = await sesionDePrueba()
    if (!refresh) {
      console.log('')
      console.log('  EL LOGIN ESTÁ CERRADO (429). Límite de 10 intentos cada 15 minutos.')
      process.exitCode = 1
      return
    }
    await abrirApp(p, refresh)

    console.log('\n  MATERIA PRIMA — el código sale solo')
    await abrirAlta(p, 'materias-primas')
    const a = await teclearNombre(p, 'Cera de abeja')
    check(/^RM-/.test(a.sku || ''), `«Cera de abeja» deja el SKU en ${a.sku || '(vacío)'}`)
    check(!a.pista.toLowerCase().includes('ya existe'), 'no avisa de duplicado en un catálogo vacío')
    check(a.pista.length > 0, `explica que es deducido: «${a.pista.slice(0, 58)}»`)

    console.log('\n  ¿SE PUEDE RECTIFICAR A MANO?')
    const sku = await controlDe(p, 'SKU')
    // `click({clickCount:3})` no selecciona reliably en un input con el valor
    // ya puesto: lo deja el cursor al final y lo tecleado se pega detrás. Se
    // selecciona con el propio DOM, que es lo que hace el navegador al entrar.
    await sku.click()
    await sku.evaluate((x) => x.select())
    await sku.type('RM-MIOCODIGO', { delay: 10 })
    const nombre2 = await controlDe(p, 'Nombre')
    await nombre2.type(' natural', { delay: 12 })
    await new Promise((r) => setTimeout(r, 1000))
    const b = await leerCampo(p, 'SKU')
    check(b === 'RM-MIOCODIGO', `un código escrito a mano no se pisa al seguir tecleando: ${b}`)
    await cerrar(p)

    console.log('\n  ENVASE')
    await abrirAlta(p, 'envases')
    const c = await teclearNombre(p, 'Botella 500 ml PET')
    check(/^ENV-/.test(c.sku || ''), `«Botella 500 ml PET» deja el SKU en ${c.sku || '(vacío)'}`)
    await cerrar(p)

    console.log('\n  PRODUCTO TERMINADO')
    await abrirAlta(p, 'productos')
    const d = await teclearNombre(p, 'Desinfectante 750 ml')
    check(/^PT-/.test(d.sku || ''), `«Desinfectante 750 ml» deja el SKU en ${d.sku || '(vacío)'}`)
    await cerrar(p)

    console.log('\n  CUANDO EL MATERIAL YA EXISTE — avisa antes de duplicarlo')
    // Con el catálogo ya dado de alta en la prueba anterior, «Agua desionizada»
    // ya está en la base. El formulario tiene que decirlo, no dejar pasar el
    // alta en silencio: dos artículos con el mismo material y códigos
    // distintos es el lío más caro de un catálogo.
    await abrirAlta(p, 'materias-primas')
    const e = await teclearNombre(p, 'Agua desionizada')
    check(e.pista.toLowerCase().includes('ya existe'),
      `avisa de que ya existe: «${e.pista.slice(0, 68)}»`)
    check(e.sku === 'RM-AGUA', `y propone el código que ya tenía: ${e.sku}`)

    console.log('\n  MATERIAL PARECIDO — NO lo funde con el otro')
    const f = await teclearNombre(p, 'Alcohol isopropílico 75%')
    check(f.sku === 'RM-ALCOH-75',
      `«Alcohol isopropílico 70 %» tiene su propio código: ${f.sku}`)
    check(!f.pista.toLowerCase().includes('ya existe'),
      'y no dice que ya existe, porque es otro material')
    await cerrar(p)

    console.log('')
    if (fallos.length) {
      console.log('  HAY ' + fallos.length + ' FALLO(S):')
      for (const f of fallos) console.log('    · ' + f)
      process.exitCode = 1
    } else console.log('  Todo correcto.')
  } finally {
    await nav.close()
  }
}
main()
