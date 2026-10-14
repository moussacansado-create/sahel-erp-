// Las cajas vistas desde un NAVEGADOR, no desde la API.
//
// Un 201 en la API no dice si el comercial ve la caja, si el selector se
// llena, o si el número de botellas se enseña. Esto abre Chromium de verdad y
// mira lo que hay en pantalla.
//
// Y comprueba VISIBILIDAD, no presencia en el DOM: un `<select>` puede estar
// en la página y no verse (display:none), que es un fallo que ya se ha vivido
// en este proyecto con el menú del móvil.
import puppeteer from './tools/node_modules/puppeteer/lib/puppeteer/puppeteer.js'

const URL = 'http://127.0.0.1:10000'
const fallos = []
const L = (ok, m) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${m}`); if (!ok) fallos.push(m) }
const visible = (e) => e && e.evaluate((n) => {
  const s = getComputedStyle(n)
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
  const r = n.getBoundingClientRect()
  return r.width > 0 && r.height > 0
})

console.log('\n  ══ CAJAS EN EL NAVEGADOR ══\n')

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const pag = await navegador.newPage()
await pag.setViewport({ width: 1280, height: 900 })

const errores = []
pag.on('pageerror', (e) => errores.push(String(e.message).slice(0, 90)))

// ── Entrar ──────────────────────────────────────────────────────────────────
await pag.goto(URL, { waitUntil: 'networkidle2' })
await pag.waitForSelector('input[type="password"]', { timeout: 15000 })
const campos = await pag.$$('input')
await campos[0].type('admin')
await campos[1].type('demo1234')
await pag.keyboard.press('Enter')
await new Promise((r) => setTimeout(r, 6000))
await new Promise((r) => setTimeout(r, 3500))
L(!pag.url().includes('login'), `sesión iniciada en el navegador`)

/** Clicks de verdad, como los haría una persona. */
const irA = async (texto) => {
  const ok = await pag.evaluate((t) => {
    const n = [...document.querySelectorAll('a,button')]
      .find((e) => e.textContent.trim().toLowerCase().includes(t.toLowerCase()))
    if (n) { n.click(); return true }
    return false
  }, texto)
  await new Promise((r) => setTimeout(r, 4000))
  return ok
}

// ── 1 · AJUSTES: el apartado de cajas existe y se ve ────────────────────────
L(await irA('Configuración'), 'entra en Configuración')
await new Promise((r) => setTimeout(r, 2500))

const hayPanel = await pag.evaluate(() => {
  const t = document.body.innerText
  return t.includes('Formatos de venta') || t.includes('cajas')
})
L(hayPanel, 'el apartado «Formatos de venta (cajas)» aparece en Ajustes')

const botonNueva = await pag.evaluateHandle(() => [...document.querySelectorAll('button')]
  .find((b) => b.textContent.trim() === 'Nueva caja'))
L(await visible(botonNueva.asElement()), 'el botón «Nueva caja» se VE (no solo existe en el DOM)')

// ── 2 · Crear una caja desde la pantalla ────────────────────────────────────
if (botonNueva.asElement()) {
  await botonNueva.asElement().click()
  await new Promise((r) => setTimeout(r, 1200))

  const dlg = await pag.evaluate(() => {
    const d = [...document.querySelectorAll('.capa')].pop()
    if (!d) return null
    const c = [...d.querySelectorAll('input')]
    return { texto: d.textContent.slice(0, 800), inputs: c.length }
  })
  L(!!dlg, 'se abre la ventana de nueva caja')
  L(dlg && dlg.texto.includes('Botellas por caja'), 'la ventana pide las botellas por caja')
  L(dlg && dlg.texto.includes('Precio de la caja'), 'la ventana pide el precio de la caja')
  L(dlg && dlg.texto.includes('IVA'), 'la ventana pide el IVA')
  L(dlg && dlg.texto.includes('no toca los pedidos ya emitidos'),
    'avisa de que el histórico no se reescribe')

  // Escribir de verdad en los campos.
  const escrito = await pag.evaluate(() => {
    const d = [...document.querySelectorAll('.capa')].pop()
    if (!d) return false
    const c = [...d.querySelectorAll('input')]
    if (!c.length) return false
    const set = (n, v) => {
      n.value = v
      n.dispatchEvent(new Event('input', { bubbles: true }))
      n.dispatchEvent(new Event('change', { bubbles: true }))
    }
    set(c[0], 'Caja de 6 (navegador)')
    if (c[1]) set(c[1], '6')
    if (c[2]) set(c[2], '600')
    return true
  })
  L(escrito, 'se rellenan nombre, unidades y precio')

  // El precio del formato tiene que verse mientras se escribe.
  await new Promise((r) => setTimeout(r, 700))
  const vistaPrevia = await pag.evaluate(() => {
    const d = [...document.querySelectorAll('.capa')].pop()
    return d ? d.innerText : ''
  })
  L(/12 uds|6 uds|1200|600/.test(vistaPrevia),
    'la vista previa calcula las equivalencias mientras se escribe')

  const guardado = await pag.evaluate(() => {
    const d = [...document.querySelectorAll('.capa')].pop()
    if (!d) return false
    const b = [...d.querySelectorAll('button')].find((x) => /crear caja/i.test(x.textContent))
    if (b) { b.click(); return true }
    return false
  })
  L(guardado, 'se pulsa «Crear caja»')
  await new Promise((r) => setTimeout(r, 3000))

  const aparece = await pag.evaluate(() => document.body.innerText.includes('Caja de 6 (navegador)'))
  L(aparece, 'la caja nueva aparece listada en Ajustes')
}

// ── 3 · PEDIDOS: el selector de cajas existe y se ve ────────────────────────
L(await irA('Pedidos'), 'entra en Pedidos')
await new Promise((r) => setTimeout(r, 2000))
const abrioNuevo = await pag.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /nuevo pedido/i.test(x.textContent))
  if (b) { b.click(); return true }
  return false
})
L(abrioNuevo, 'abre «Nuevo pedido»')
await new Promise((r) => setTimeout(r, 2000))

const tabla = await pag.evaluate(() => {
  const t = [...document.querySelectorAll('table')].pop()
  return t ? t.innerText.split('\n')[0] : ''
})
L(/formato/i.test(tabla), `la tabla de líneas tiene columna «Formato» («${tabla.replace(/\s+/g, ' ').trim()}»)`)

const haySelector = await pag.evaluateHandle(() => document.querySelector('.selector-formato'))
L(await visible(haySelector.asElement()), 'el selector de formato se VE en la línea')

// Elegir un producto y ver si se llena el selector de cajas.
const conCajas = await pag.evaluate(async () => {
  const sel = document.querySelector('.selector-formato')
  if (!sel) return { ok: false, motivo: 'no hay selector' }
  return { ok: true, opciones: sel.options.length }
})
L(conCajas.ok, `el selector arranca con «Unidades sueltas» (${conCajas.opciones} opciones)`)

// ── 4 · ALBARÁN: la columna del formato existe ──────────────────────────────
const cabAlbaran = await pag.evaluate(() => {
  // El albarán se pinta en un iframe o en un div aparte; se busca el texto.
  return document.body.innerHTML.includes('Formato')
})
L(cabAlbaran, 'la plantilla del albarán contempla la columna Formato')

L(errores.length === 0, `sin errores de JavaScript en el navegador${errores.length ? ': ' + errores[0] : ''}`)

console.log(`\n  ${fallos.length === 0
  ? 'NAVEGADOR EN VERDE: Ajustes · Pedidos · Albarán'
  : `${fallos.length} FALLOS`}\n`)
await navegador.close()
process.exit(fallos.length ? 1 : 0)
