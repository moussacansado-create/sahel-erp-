// ═══════════════════════════════════════════════════════════════════════════
// LAS DOS PANTALLAS DE COMISIONES, EN UN NAVEGADOR DE VERDAD
// ═══════════════════════════════════════════════════════════════════════════
//
// Se abre la aplicación PÚBLICA con un navegador real, se entra con una
// sesión de COMERCIAL y otra de ADMINISTRADOR, y se mira lo que hay en
// pantalla.
//
// Y se mira de dos maneras, porque las dos importan:
//
//   · lo que EXISTE en el DOM    → que el dato está
//   · lo que se VE               → que está a la vista y no es `display:none`
//
// Un elemento puede estar puesto, tener su texto correcto y ser invisible.
// En el código parece perfecto; en la pantalla no hay nada. Por eso la
// comprobación de visibilidad va con cada dato que se mira.
//
// Lo que se comprueba:
//
//   EL COMERCIAL (democ_akeita)
//     1  · su pantalla de ventas y comisiones se abre
//     2  · ve la comisión estimada del mes y el porcentaje aplicado
//     3  · ve el desglose de pedidos y cobros que componen la base
//     4  · lo pendiente de verificar va SEPARADO de lo verificado
//     5  · ve el estado del periodo
//     6  · ve el historial de meses anteriores
//     7  · NO ve controles de administración
//     8  · NO puede ver la comisión de otro comercial
//
//   EL ADMINISTRADOR
//     9  · su panel se abre con selector de comercial y de mes
//     10 · ve base, porcentaje, cálculo y detalle de los cobros
//     11 · ve el historial y la auditoría
//     12 · puede configurar el porcentaje
//     13 · sin errores de JavaScript en ninguna de las dos
//
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ruta = path.join(B, 'tests', 'tools', 'node_modules', 'puppeteer', 'lib', 'puppeteer', 'puppeteer.js')
const puppeteer = (await import(pathToFileURL(ruta).href)).default

const URL = process.env.PUBLIC_URL || 'https://sahel-erp.onrender.com'
const ADMIN = process.env.TEST_USER || 'admin'
const COMERCIAL = process.env.TEST_COMERCIAL || 'democ_akeita'
const P = process.env.TEST_PASS
const pausa = (ms) => new Promise((r) => setTimeout(r, ms))

let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] })

/** Entra en la aplicación con una sesión real y espera a la pantalla. */
async function entrar(p, usuario, contrasena, hash) {
  await p.goto(`${URL}/#/login`, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForFunction(() => document.querySelectorAll('input').length >= 2
    && document.querySelector('input[type=password]'), { timeout: 45000 })
  await pausa(1200)
  await p.evaluate((u, pw) => {
    const i = [...document.querySelectorAll('input')]
    const set = (e, v) => {
      Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set.call(e, v)
      e.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(i.find((x) => /user|usuario|login|correo|email/i.test(x.name + x.id))
      || i.find((x) => x.type !== 'password'), u)
    set(i.find((x) => x.type === 'password'), pw)
    document.querySelector('form button')?.click()
  }, usuario, contrasena)
  await pausa(6000)
  await p.goto(`${URL}/${hash}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await pausa(6000)
}

/** El texto que se VE de verdad, no el que hay en el DOM. */
const textoVisible = (p, sel) => p.evaluate((s) => {
  const n = document.querySelector(s)
  if (!n) return ''
  const cs = getComputedStyle(n)
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return ''
  const r = n.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return ''
  return n.innerText || n.textContent || ''
}, sel)

const visible = (p, sel) => p.evaluate((s) => {
  const n = document.querySelector(s)
  if (!n) return false
  const cs = getComputedStyle(n)
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
  const r = n.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}, sel)

try {
  // ═══════════════════════════════════════════════════════════════════════
  // EL COMERCIAL
  // ═══════════════════════════════════════════════════════════════════════
  const p = await nav.newPage()
  await p.setViewport({ width: 1400, height: 1000 })
  const erroresCom = []
  p.on('pageerror', (e) => erroresCom.push(String(e.message)))
  // Lo que el servidor LE DA a esta sesion. No lo que la pantalla pinta:
  // el aislamiento se comprueba en el dato, antes de que se pinte.
  const respuestas = []
  p.on('response', async (r) => {
    const u = r.url()
    if (!/\/api\/comisiones/.test(u)) return
    try { respuestas.push({ url: u.replace(/\?.*/, ''), status: r.status(), cuerpo: await r.text() }) }
    catch { /* la respuesta se fue antes de poder leerla */ }
  })

  await entrar(p, COMERCIAL, P, '#/comisiones')

  const cuerpo = await textoVisible(p, '.comisiones')
  chk(cuerpo.length > 60, `C1 · la pantalla de ventas y comisiones se abre (${cuerpo.length} letras visibles)`)

  // La comisión estimada y el porcentaje.
  const metricas = await p.evaluate(() => [...document.querySelectorAll('.comisiones .metrica')]
    .map((m) => ({
      etiqueta: (m.querySelector('.metrica__etiqueta')?.textContent || '').trim(),
      valor: (m.querySelector('.metrica__valor')?.textContent || '').trim(),
      visible: getComputedStyle(m).display !== 'none'
        && m.getBoundingClientRect().width > 0,
    })))
  const etiquetas = metricas.map((m) => m.etiqueta)
  chk(etiquetas.some((e) => /base cobrada/i.test(e)),
    `C2 · ve la base cobrada del mes (${etiquetas.join(' | ').slice(0, 110)})`)
  chk(etiquetas.some((e) => /porcentaje/i.test(e)), 'C3 · ve el porcentaje aplicable')
  chk(etiquetas.some((e) => /comisi/i.test(e)), 'C4 · ve la comisión estimada')
  chk(metricas.every((m) => m.visible), 'C5 · todas las cifras se VEN, no solo existen en el DOM')

  // El desglose: cobros y pedidos.
  const filasCobros = await p.evaluate(() => document.querySelectorAll('.tabla--cobros tbody tr').length)
  const filasPedidos = await p.evaluate(() => document.querySelectorAll('.tabla--pedidos tbody tr').length)
  chk(filasCobros > 0, `C6 · ve el desglose de cobros (${filasCobros} filas)`)
  chk(filasPedidos > 0, `C7 · ve el desglose de pedidos (${filasPedidos} filas)`)

  // La separación de verificados y sin verificar.
  const clases = await p.evaluate(() => ({
    verificados: document.querySelectorAll('.tabla--cobros tr.cobro--cobrado').length,
    sinVerificar: document.querySelectorAll('.tabla--cobros tr.cobro--sinverificar').length,
    rechazados: document.querySelectorAll('.tabla--cobros tr.cobro--rechazado').length,
  }))
  chk(clases.sinVerificar > 0,
    `C8 · lo pendiente de verificar va SEPARADO de lo verificado (${clases.sinVerificar} sin verificar, ${clases.verificados} verificados)`)

  // El estado del periodo.
  const estados = await p.evaluate(() => [...document.querySelectorAll('.comisiones .estado')]
    .map((e) => e.textContent.trim()))
  chk(estados.length > 0, `C9 · ve el estado del periodo (${estados.join(' | ').slice(0, 90)})`)

  // El historial.
  const filasHistorial = await p.evaluate(() => document.querySelectorAll('.tabla--historial tbody tr').length)
  chk(filasHistorial > 0,
    `C10 · ve el historial de meses anteriores (${filasHistorial} meses; respuestas: ${respuestas.map((r) => r.url + '=' + r.status).join(', ')})`)

  // NO debe ver controles de administración.
  const textoAdmin = await p.evaluate(() => document.body.innerText)
  chk(!/Confirmar comisión|Descartar|Marcar como pagada|Preparar el mes/.test(textoAdmin),
    'C11 · el comercial NO ve controles de administración')
  chk(!/Guardar porcentaje/.test(textoAdmin), 'C12 · el comercial NO ve el formulario de porcentaje')

  // Y el servidor no le da datos de otro. Se mira la respuesta REAL de la
  // red: la que la aplicación recibió, no la que alguien pidió aparte.
  const lista = respuestas.find((r) => r.url.endsWith('/api/comisiones'))
  let codigos = []
  let estado = null
  if (lista) {
    estado = lista.status
    try {
      const d = JSON.parse(lista.cuerpo)
      codigos = (d.comisiones || []).map((c) => c.comercial_id)
    } catch { codigos = [] }
  }
  chk(!!lista, `C13 · la aplicacion pide las comisiones al servidor (${respuestas.length} respuestas)`)
  chk(codigos.length > 0 && codigos.every((c) => c === 4),
    `C13b · el servidor solo le da SUS comisiones (${JSON.stringify(codigos)})`)
  chk(estado === 200, `C13c · la peticion de su propio listado responde bien (${estado})`)

  chk(erroresCom.length === 0, `C14 · sin errores de JavaScript en la vista del comercial (${erroresCom.length})`)
  if (erroresCom.length) erroresCom.slice(0, 3).forEach((e) => console.log('      · ' + e.slice(0, 90)))
  await p.close()

  // ═══════════════════════════════════════════════════════════════════════
  // EL ADMINISTRADOR
  // ═══════════════════════════════════════════════════════════════════════
  const a = await nav.newPage()
  await a.setViewport({ width: 1500, height: 1100 })
  const erroresAdm = []
  a.on('pageerror', (e) => erroresAdm.push(String(e.message)))

  await entrar(a, ADMIN, P, '#/comisiones')
  const cuerpoAdm = await textoVisible(a, '.comisiones')
  chk(cuerpoAdm.length > 60, `A1 · el panel del administrador se abre (${cuerpoAdm.length} letras)`)

  const hayFiltros = await a.evaluate(() => ({
    comercial: !!document.querySelector('.comisiones select'),
    mes: !!document.querySelector('.comisiones input[type=month]'),
  }))
  chk(hayFiltros.comercial, 'A2 · hay selector de comercial')
  chk(hayFiltros.mes, 'A3 · hay selector de mes')

  // Elegir un comercial de verdad y ver qué sale.
  const elegido = await a.evaluate(async () => {
    const sel = document.querySelector('.comisiones select')
    const op = [...sel.options].find((o) => o.value)
    if (!op) return null
    const s = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value').set
    s.call(sel, op.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return op.value
  })
  chk(!!elegido, `A4 · se elige un comercial (${elegido})`)
  await pausa(5000)

  const panelAdm = await textoVisible(a, '.comisiones')
  chk(/base cobrada/i.test(panelAdm), 'A5 · el panel muestra la base cobrada')
  chk(/porcentaje/i.test(panelAdm), 'A6 · el panel muestra el porcentaje')
  chk(/comisi/i.test(panelAdm), 'A7 · el panel muestra la comisión')

  const detalleAdm = await a.evaluate(() => ({
    cobros: document.querySelectorAll('.tabla--cobros tbody tr').length,
    pedidos: document.querySelectorAll('.tabla--pedidos tbody tr').length,
    historial: document.querySelectorAll('.tabla--historial tbody tr').length,
    porcentajes: document.querySelectorAll('.tabla--porcentajes tbody tr').length,
    auditoria: document.querySelectorAll('.tabla--auditoria tbody tr').length,
  }))
  chk(detalleAdm.cobros > 0, `A8 · el panel muestra el detalle de los cobros (${detalleAdm.cobros})`)
  chk(detalleAdm.pedidos > 0, `A9 · el panel muestra los pedidos (${detalleAdm.pedidos})`)
  chk(detalleAdm.historial > 0, `A10 · el panel muestra el historial (${detalleAdm.historial} meses)`)
  chk(detalleAdm.porcentajes > 0, `A11 · el panel muestra el historial de porcentajes (${detalleAdm.porcentajes})`)
  chk(detalleAdm.auditoria > 0, `A12 · el panel muestra la auditoría (${detalleAdm.auditoria})`)

  const textoAcciones = await a.evaluate(() => document.body.innerText)
  chk(/Confirmar comisión|Preparar el mes|Descartar|Marcar como pagada|Revisión de/.test(textoAcciones),
    'A13 · el panel ofrece las acciones del periodo')

  chk(erroresAdm.length === 0, `A14 · sin errores de JavaScript en el panel (${erroresAdm.length})`)
  if (erroresAdm.length) erroresAdm.slice(0, 3).forEach((e) => console.log('      · ' + e.slice(0, 90)))
  await a.close()
} catch (e) {
  chk(false, `EXCEPCION · ${String(e.message).slice(0, 160)}`)
} finally {
  await nav.close()
}
console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
