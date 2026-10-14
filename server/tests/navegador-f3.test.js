/**
 * FASE 3 en el navegador: recetas, producción y trazabilidad.
 *
 * Va en un fichero aparte, y no por capricho. shares navegador con la prueba
 * general, que agota los recursos de Chromium en este entorno y muere con
 * «Connection closed» a mitad de la octava pantalla. Separadas, cada una
 * arranca un navegador limpio.
 *
 * Lo que se comprueba aquí es lo que NO se puede ver desde supertest: que el
 * operario ve el plan ANTES de fabricar, que el botón se activa cuando hay
 * materia prima, y que la trazabilidad se enseña.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-navegador-f3-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const B = new URL('..', import.meta.url).pathname
const banco = await import(`${B}/tests/banco.js`)
const { comprobar, seccion, resumen, one } = banco
const { closeDb, getDb } = await import(`${B}src/db/client.js`)
const { hashPassword } = await import(`${B}src/security/passwords.js`)
const { createApp } = await import(`${B}src/app.js`)
const { createRequire } = await import('node:module')
const path = await import('node:path')
const { existsSync } = await import('node:fs')

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · FASE 3 · EN EL NAVEGADOR')
console.log('══════════════════════════════════════════════════════════════')

const require = createRequire(import.meta.url)
const rutaPuppeteer = path.join(B, 'tests', 'tools', 'node_modules', 'puppeteer')
if (!existsSync(rutaPuppeteer)) {
  console.log('')
  console.log('  ⚠  SALTADA: falta puppeteer en server/tests/tools/')
  console.log('')
  await closeDb()
  process.exit(0)
}

await banco.baseDePrueba()
const hash = await hashPassword('clave-f3-navegador-1')
const admin = await one('INSERT INTO users (username,full_name,password_hash) VALUES ($1,$2,$3) RETURNING *',
  ['admin', 'Administrador', hash])
await banco.query('INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code=$2',
  [admin.id, 'ADMIN'])

const app = createApp()
const servidor = await new Promise((c) => { const s = app.listen(0, '127.0.0.1', () => c(s)) })
const BASE = `http://127.0.0.1:${servidor.address().port}`
const TOK = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'clave-f3-navegador-1' }),
})).json()).access

const puppeteer = require(rutaPuppeteer)
const nav = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await nav.newPage()
await page.setViewport({ width: 1280, height: 1000 })
const fallos = []
page.on('pageerror', (e) => fallos.push('pageerror: ' + e.message.split('\n')[0]))
page.on('requestfailed', (r) => fallos.push('no se pudo cargar: ' + r.url().replace(BASE, '')))
page.on('response', (r) => {
  if (r.status() < 400) return
  const ruta = r.url().replace(BASE, '')
  if (r.status() === 401 && ruta === '/api/auth/me') return
  fallos.push(`HTTP ${r.status()} en ${ruta}`)
})
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const irA = async (ruta) => { await page.evaluate((x) => { window.location.hash = '#/' + x }, ruta); await espera(2200) }

seccion('Fase 3: recetas, producción y trazabilidad, en el navegador')

{
  // Datos: producto, materia prima y proveedor de la receta.
  const uL = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
  const uUD = (await one('SELECT id FROM units WHERE code=$1', ['UD'])).id
  const mp = await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price,shelf_life_days)
    VALUES ('RM-NAV-A','Agua de prueba','RAW_MATERIAL',$1,$1,10000,0.10,0,365) RETURNING *`, [uL])
  const pt = await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price,shelf_life_days)
    VALUES ('PT-NAV-B','Producto de prueba','FINISHED_GOOD',$1,$1,1000,0,3.50,365) RETURNING *`, [uUD])


  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await page.waitForSelector('#form-acceso button[type=submit]', { visible: true, timeout: 20000 })
  await page.type('#usuario', 'admin')
  await page.type('#clave', 'clave-f3-navegador-1')
  await page.click('#form-acceso button[type=submit]')
  await espera(2500)
  const antes = fallos.length

  // ── Menú ──
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll('.lateral__enlace')].map((a) => a.dataset.ruta))
  comprobar('El menú tiene Recetas, Producción y Lotes',
    menu.includes('recetas') && menu.includes('produccion') && menu.includes('lotes'),
    menu.join(', '))

  // ── Entrada por la API, para tener con qué producir ──
  await page.evaluate(async (base, token, item) => {
    await fetch(base + '/api/inventory/recepciones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ itemId: item, cantidad: 5000, numeroAlbaran: 'ALB-NAV' }),
    })
  }, BASE, TOK, mp.id)

  // ── Crear receta desde la pantalla ──
  await page.evaluate(() => { window.location.hash = '#/recetas' })
  await espera(1200)
  const hayRecetas = await page.evaluate(() => document.getElementById('titulo').textContent)
  comprobar('La pantalla de recetas se abre', hayRecetas === 'Recetas', hayRecetas)

  await page.evaluate(async (base, token, cuerpo) => {
    await fetch(base + '/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(cuerpo),
    })
  }, BASE, TOK, {
    product_id: pt.id, base_qty: 1000,
    lineas: [{ item_id: mp.id, qty_per_batch: 0.5, unit_id: uL }],
  })
  await page.evaluate(() => { window.location.hash = '#/panel' })
  await espera(600)
  await page.evaluate(() => { window.location.hash = '#/recetas' })
  await espera(1500)

  const recetaVisible = await page.evaluate(() =>
    document.getElementById('vista').textContent.includes('Producto de prueba'))
  comprobar('La receta recién creada aparece en la lista', recetaVisible)

  // ── Producción: el plan antes de fabricar ──
  await page.evaluate(() => { window.location.hash = '#/produccion' })
  await espera(2500)

  // El producto se elige escribiendo y tocando la sugerencia. Antes de elegir
  // NADA no puede haber plan ni botón: si los hubiera, el operario podría
  // fabricar sin haber mirado qué lotes se van a usar.
  const sinElegir = await page.evaluate(() => {
    const t = document.getElementById('vista').textContent
    return {
      plan: t.includes('Se pueden fabricar') || t.includes('No se puede fabricar'),
      boton: !document.querySelector('#vista button.btn--principal')?.disabled,
    }
  })
  comprobar('Sin elegir producto, no hay plan ni botón activo',
    !sinElegir.plan && !sinElegir.boton,
    `plan=${sinElegir.plan} botón=${sinElegir.boton}`)

  // Y el buscador FILTRA: se escribe un trozo y salen menos que sin escribir.
  await page.click('#vista .buscador input[type="search"]')
  await espera(400)
  const todas = await page.evaluate(
    () => document.querySelectorAll('#vista .buscador__opcion').length)
  await page.type('#vista .buscador input[type="search"]', 'prueba')
  await espera(900)
  const filtradas = await page.evaluate(
    () => document.querySelectorAll('#vista .buscador__opcion').length)
  comprobar('El buscador muestra opciones al abrirse', todas > 0, `${todas} opciones`)
  // Escribir un trozo debe dejar la lista con lo que coincide. Que sean MENOS
  // que todas solo se puede comprobar si había más de una: con una sola, el
  // filtro no tiene nada que descartar y la comprobación sería falsa por
  // casualidad.
  comprobar('Y al escribir un trozo se queda con lo que coincide', filtradas > 0,
    `«prueba» → ${filtradas} de ${todas}`)
  if (todas > 1) {
    comprobar('Y descarta las que no coinciden', filtradas < todas,
      `«prueba» → ${filtradas} de ${todas}`)
  }

  await page.evaluate(() => document.querySelector('#vista .buscador__opcion').click())
  await espera(2200)

  const planVisible = await page.evaluate(() => {
    const t = document.getElementById('vista').textContent
    return {
      muestraPlan: t.includes('Se pueden fabricar') || t.includes('No se puede fabricar'),
      muestraLote: t.includes('MP-'),
      botonActivo: !document.querySelector('#vista button.btn--principal')?.disabled,
    }
  })
  comprobar('La pantalla de producción enseña el PLAN antes de fabricar', planVisible.muestraPlan)
  comprobar('Y el plan dice de qué lotes sale', planVisible.muestraLote)
  comprobar('Y el botón se activa cuando hay existencias', planVisible.botonActivo)

  // ── Fabricar de verdad ──
  const pulsado = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#vista button')]
      .find((x) => x.textContent.includes('Confirmar producción'))
    if (!b) return 'no está el botón'
    b.click()
    return b.textContent
  })
  comprobar('Se encuentra el botón «Confirmar producción»', pulsado !== 'no está el botón', pulsado)
  await espera(4000)
  const producido = await page.evaluate(() => {
    const t = document.getElementById('vista').textContent
    return { tieneHistorial: t.includes('FAB-'), tieneLotePT: (t.match(/PT-[A-Z0-9]{2,6}-\d{5}/g) || []) }
  })
  comprobar('Tras fabricar, aparece en el historial con su código FAB-', producido.tieneHistorial)
  comprobar('Y con el lote de producto terminado, numerado por producto',
    producido.tieneLotePT.length > 0, JSON.stringify(producido.tieneLotePT))

  // ── Lotes: aparece el lote de producción ──
  await page.evaluate(() => { window.location.hash = '#/lotes' })
  await espera(2000)
  const listaLotes = await page.evaluate(() => {
    const t = document.getElementById('vista').textContent
    return { tienePT: (t.match(/PT-[A-Z0-9]{2,6}-\d{5}/g) || []), tieneMP: t.includes('MP-'), origen: t.includes('Producción') }
  })
  comprobar('La pantalla de Lotes muestra los MP y los PT', listaLotes.tienePT && listaLotes.tieneMP)
  comprobar('Y dice de dónde viene cada uno', listaLotes.origen)

  // ── Trazabilidad ──
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#vista button')].find((x) => x.textContent.includes('Trazabilidad'))
    if (b) b.click()
  })
  await espera(2500)
  const traz = await page.evaluate(() => {
    const d = document.querySelector('.capa')
    if (!d) return { abierta: false }
    const t = d.textContent
    return { abierta: true, muestraOrigen: t.includes('De dónde viene'), muestraSaldo: t.includes('Disponible ahora') }
  })
  comprobar('Se abre la trazabilidad del lote', traz.abierta)
  comprobar('Y explica de dónde viene', traz.muestraOrigen)
  comprobar('Y cuánto queda', traz.muestraSaldo)

  const nuevos = fallos.slice(antes)
  comprobar('Ninguna de estas pantallas dio error', nuevos.length === 0, nuevos.join('; '))
}

// ─────────────────────────────────────────────────────────────────────────────

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
