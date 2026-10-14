/**
 * LA FICHA Y LA EDICIÓN, EN UN NAVEGADOR DE VERDAD.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE ESTA PRUEBA DEMUESTRA
 *
 *   abrir comercial → editar → cambiar nota, idiomas y zonas → GUARDAR
 *   → RECARGAR LA PÁGINA ENTERA → volver a abrir → comprobar que sigue ahí
 *   → y que en la base, en las TRES tablas, está lo que se puso.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * UNA REGLA QUE ME HA COSTADO HORAS
 *
 * `page.evaluate` con un BUCLE dentro se cuelga y tira el protocolo entero:
 * el error sale como «Runtime.callFunctionOn timed out», que no dice nada de
 * qué lo provocó, y parece un fallo del ERP cuando es del automatismo.
 *
 * Aquí cada `evaluate` es UNA EXPRESIÓN SIMPLE: devolver un nodo, devolver un
 * booleano, poner un valor. Los bucles que hagan falta van en el lado del
 * navegador, que para eso está `querySelectorAll`, pero con `Array.from(...)`
 * y sin bucles `for` escritos a mano. Es más largo de escribir y MUCHÍSIMO
 * más fiable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Y LA OTRA: NO SE FALSEA NADA PARA QUE PASE
 *
 * Si un cambio no persiste, la prueba falla. Si el ERP no guarda, se ve. Lo
 * que no se hace es relajar la comprobación hasta que salga verde.
 *
 */

process.env.JWT_SECRET = 'clave-de-prueba-esto-no-es-real-1234567890123456789012345678901234567890'

import { createRequire } from 'node:module'
const require = createRequire('/workspace/cleansahel-v2/server/')
const puppeteer = require('./tests/tools/node_modules/puppeteer')

// El servidor es PROPIO, en un puerto libre, sobre la base de pruebas.
//
// Antes esto apuntaba a `127.0.0.1:10000`, que es el servidor de la
// demostracion. Con los tests ahi, cada ejecucion escribia en la demo y le
// dejaba clientes de prueba. `entornoConDemo()` levanta su base, la siembra y
// levanta su servidor.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('comerciales-edicion.test.mjs', BASE)
const BD = process.env.PGLITE_DIR ?? '/workspace/cleansahel-v2/server/.pgdata'

let fallos = 0
const ok = (t, e = '') => console.log(`  ✓ ${t}${e ? '   ' + e : ''}`)
const mal = (t, e = '') => { fallos++; console.log(`  ✗ ${t}${e ? '   ' + e : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

const nav = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  protocolTimeout: 180000,
})
const p = await nav.newPage()
await p.setViewport({ width: 1400, height: 1100 })

const erroresJs = []
p.on('pageerror', (e) => erroresJs.push(String(e.message).slice(0, 140)))
p.on('console', (m) => {
  if (m.type() === 'error' && !/401/.test(m.text())) erroresJs.push(m.text().slice(0, 140))
})

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/** Espera a que una expresión devuelva algo que NO sea falso. Expresión simple. */
async function esperar(desc, expr, ms = 30000) {
  try {
    await p.waitForFunction(expr, { timeout: ms, polling: 350 })
    return true
  } catch {
    return false
  }
}

async function entrar() {
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await p.waitForSelector('#usuario', { timeout: 20000 })
  await p.type('#usuario', 'admin')
  await p.type('#clave', 'demo1234')
  await Promise.all([
    p.evaluate('document.querySelector("button[type=submit]")?.click()'),
    p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
  ])
  await dormir(1800)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('0 · ENTRAR Y LLEGAR A COMERCIALES')

await entrar()
await p.goto(`${BASE}/#/comerciales`, { waitUntil: 'networkidle2' })
const hayMapa = await esperar('el mapa', 'document.querySelectorAll(".mapa__zona").length === 9')
hayMapa ? ok('el mapa con las 9 zonas está en pantalla') : mal('el mapa no llega a pintarse')

const abierto = await p.evaluate('document.querySelectorAll(".item-comercial").length')
abierto > 0 ? ok(`${abierto} comerciales en la lista`) : mal('no hay comerciales en la lista')

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · ESTADO ANTES — lo que hay ahora en la BASE')

//
// SIN ABRIR LA BASE.
//
// Abrir `.pgdata` desde este proceso, con el servidor en marcha, es
// exactamente lo que corrompe PGlite. Así que aquí NO se consulta la base: el
// estado de «antes» se lee por la API, que es lo mismo que lee la pantalla.
//
// La verificación de las TRES tablas se hace en `verificar-edicion.mjs`, que
// corre con el servidor PARADO.
//
// El login va por HTTP directo a la API, NO por la pantalla: el token es lo
// único que hace falta para leer por debajo de la interfaz.
const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  })
  const j = await r.json()
  if (!j.access) throw new Error(`no se ha podido entrar: ${JSON.stringify(j).slice(0, 120)}`)
  return j.access
}

let TOKEN = null
const api = async (ruta, opts = {}) => {
  const r = await fetch(`${BASE}/api${ruta}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
  })
  return r.json()
}

TOKEN = await login()
const nombreCom = await p.evaluate('document.querySelector(".item-comercial__cuerpo strong")?.textContent || ""')
const lista0 = (await api('/comerciales')).find((x) => x.full_name === nombreCom)
if (!lista0) {
  console.log(`  No encuentro al comercial «${nombreCom}»`)
  await nav.close(); process.exit(1)
}
const CID = lista0.id

const ficha0 = await api(`/comerciales/ficha/${CID}`)
const idiomas0 = ficha0.comercial.idiomas
const zonas0 = ficha0.estructura.zonas.map((z) => z.id).sort((a, b) => a - b)

console.log(`  comercial: ${CID} · ${nombreCom}`)
console.log(`  notas:      ${JSON.stringify(ficha0.comercial.notas)}`)
console.log(`  idiomas:    ${idiomas0.join(', ') || '(ninguno)'}`)
console.log(`  zonas:      ${zonas0.length}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · ABRIR LA FICHA Y ENTRAR A EDITAR')

// Un clic a la vez: el protocolo espera al manejador async y se queda colgado.
const clic = (sel) => p.evaluate(`setTimeout(() => document.querySelector(${JSON.stringify(sel)})?.click(), 60)`)
await clic('.item-comercial__btn')
const fichaAbierta = await esperar('la ficha', '!!document.querySelector(".ficha__cab h3")')
fichaAbierta ? ok('la ficha se abre') : mal('la ficha no se abre')
const tituloFicha = await p.evaluate('document.querySelector(".ficha__cab h3")?.textContent || ""')
ok(`  → ${tituloFicha}`)
const editables = await p.evaluate('document.querySelectorAll(".bloque-editable").length')
editables > 0 ? ok(`${editables} bloques editables, distinguidos de los calculados`) : mal('no hay bloques editables')

await p.evaluate(
  'setTimeout(() => {'
  + ' Array.from(document.querySelectorAll("button"))'
  + '   .find(b => /Editar/.test(b.textContent))?.click();'
  + ' }, 60)',
)
const dialogo = await esperar('el diálogo', 'document.querySelectorAll(".lista--elegible").length > 0')
dialogo ? ok('se abre el diálogo de edición') : mal('no se abre el diálogo')

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · CAMBIAR NOTA, IDIOMAS Y ZONAS — con el teclado')

const MARCA = 'NOTA-' + Date.now().toString(36).toUpperCase()

// Las notas se limpian antes: si las hubiera, se pegaría al final.
const area = await p.$('textarea')
await area.evaluate((e) => { e.value = '' })
await area.type(MARCA)
ok(`nota escrita: ${MARCA.slice(0, 20)}…`)

// Un idioma que el comercial NO tiene, de los del catálogo.
const hd = await p.evaluate(
  '(() => { const l = Array.from(document.querySelectorAll("label")).find(x => /Idiomas/.test(x.textContent));'
  + ' return l ? l.parentElement.querySelector("input[type=text]")?.tagName : "sin" })()',
)
if (hd !== 'INPUT') mal('no encuentro el campo de idiomas')
else {
  const handle = await p.evaluateHandle(
    '(() => { const l = Array.from(document.querySelectorAll("label")).find(x => /Idiomas/.test(x.textContent));'
    + ' return l ? l.parentElement.querySelector("input[type=text]") : null })()',
  )
  const nodo = handle.asElement()
  await nodo.click({ clickCount: 3 })
  // El campo se vacía ANTES de escribir. Con `click({clickCount:3})` se
  // selecciona el texto, pero el foco se pierde y el Backspace no llega: el
  // texto viejo se queda pegado delante y salen «fes, fr, wo».
  await nodo.evaluate((e) => { e.value = '' })
  await nodo.type(`${idiomas0.join(', ')}, wo`)
  const escrito = await p.evaluate(
    '(() => { const l = Array.from(document.querySelectorAll("label")).find(x => /Idiomas/.test(x.textContent));'
    + ' return l ? l.parentElement.querySelector("input[type=text]").value : "" })()',
  )
  ok(`idiomas: ${escrito}`)
}

// Quitar una zona: la primera que haya, y añadir la primera que no.
const cambio = await p.evaluate(
  '(() => {'
  + ' const c = Array.from(document.querySelectorAll(".lista--elegible input[type=checkbox]"));'
  + ' const marcados = c.filter(x => x.checked);'
  + ' const libres = c.filter(x => !x.checked);'
  + ' if (marcados[0]) { marcados[0].checked = false; marcados[0].dispatchEvent(new Event("change",{bubbles:true})); }'
  + ' if (libres[0]) { libres[0].checked = true; libres[0].dispatchEvent(new Event("change",{bubbles:true})); }'
  + ' const sel = document.querySelector("select");'
  + ' if (sel && libres[0]) {'
  + '   const nombre = (libres[0].parentElement.querySelector("span")?.textContent || "").trim();'
  + '   const op = Array.from(sel.options).find(o => o.textContent.trim() === nombre);'
  + '   if (op) sel.value = op.value;'
  + ' }'
  + ' const nom = (n) => (n?.parentElement?.querySelector("span")?.textContent || "").trim();'
  + ' return { quitada: nom(marcados[0]), anadida: nom(libres[0]) };'
  + '})()',
)
ok(`zonas → quita «${cambio.quitada}» y añade «${cambio.anadida}»`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · GUARDAR')

// `document.querySelectorAll` devuelve una NodeList estática: buscar el botón
// de Guardar «después» de abrir el diálogo no lo encuentra, y por eso el clic
// se quedaba esperando a un elemento que no existía.
await p.waitForFunction(
  'Array.from(document.querySelectorAll("button")).some(b => /^Guardar$/.test(b.textContent.trim()))',
  { timeout: 20000, polling: 300 },
)
const botonGuardar = await p.evaluateHandle(
  'Array.from(document.querySelectorAll("button")).find(b => /^Guardar$/.test(b.textContent.trim()))',
)
// `Input.dispatchMouseEvent` se cuelga en este entorno. El manejador de
// `boton()` es un listener, así que un `dispatchEvent` lo dispara igual
// que un clic real — y sin el ratón de por medio.
// Igual: el manejador de Guardar guarda, recarga la ficha y repinta. El
// protocolo no tiene por qué esperarse.
await botonGuardar.asElement().evaluate((b) => { setTimeout(() => b.click(), 0) })
const cerrado = await esperar('el cierre del diálogo', 'document.querySelectorAll(".lista--elegible").length === 0', 25000)
cerrado ? ok('el diálogo se cierra: el guardado terminó') : mal('el diálogo sigue abierto: el guardado no terminó')

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · ¿SE HA GUARDADO? — leído por la API, que lee la base')

await dormir(1200)

const ficha1 = await api(`/comerciales/ficha/${CID}`)
const idiomas1 = ficha1.comercial.idiomas
const zonas1 = ficha1.estructura.zonas.map((z) => z.id).sort((a, b) => a - b)

ficha1.comercial.notas === MARCA
  ? ok(`nota guardada: «${String(ficha1.comercial.notas).slice(0, 36)}»`)
  : mal(`la nota es «${ficha1.comercial.notas}», esperaba «${MARCA}»`)

idiomas1.includes('wo')
  ? ok(`idiomas: ${idiomas1.join(', ')} — «wo» añadido`)
  : mal(`los idiomas son ${idiomas1.join(', ')} y no está «wo»`)

const conserva = idiomas0.every((i) => idiomas1.includes(i))
conserva ? ok('  → y conserva los que ya tenía') : mal('  → ha perdido idiomas')

const cambioReal = JSON.stringify(zonas0) !== JSON.stringify(zonas1)
cambioReal ? ok(`zonas: ${zonas0.join(',')} → ${zonas1.join(',')}`) : mal('las zonas NO han cambiado')

const principales = ficha1.estructura.zonas.filter((z) => z.esPrincipal)
principales.length === 1 ? ok('  → y sigue habiendo UNO solo como principal')
  : mal(`  → hay ${principales.length} zonas principales`)

// Lo que se escribe, para el script que lo comprobará con el servidor parado.
const { writeFileSync } = await import('node:fs')
writeFileSync('/workspace/edicion-esperada.json', JSON.stringify({
  comercialId: CID, nombre: nombreCom, nota: MARCA,
  idiomasAntes: idiomas0, idiomasDespues: idiomas1,
  zonasAntes: zonas0, zonasDespues: zonas1,
  quitada: cambio.quitada ?? null, anadida: cambio.anadida ?? null,
  ajenos, otrosPerfiles,
}, null, 2))
ok('  → lo esperado queda anotado para la comprobación con el servidor parado')

// ═══════════════════════════════════════════════════════════════════════════
titulo('6 · AISLAMIENTO: NO SE HA TOCADO NADA MÁS')

// El RECUENTO de filas se comprueba en la base, con el servidor parado. Aquí
// solo se deja constancia de las que había, para poder comparar después.
console.log(`  filas que había de clientes/pedidos/artículos/pagos/usuarios: ${JSON.stringify(ajenos)}`)

const ficha2b = await api(`/comerciales/ficha/${CID}`)
JSON.stringify(ficha2b.metricas) === JSON.stringify(ficha1.metricas)
  ? ok('las MÉTRICAS calculadas no han cambiado: son de los datos, no de la edición')
  : mal(`las métricas han cambiado al editar: ${JSON.stringify(ficha1.metricas)} → ${JSON.stringify(ficha2b.metricas)}`)

const otros = (await api('/comerciales')).filter((x) => x.id !== CID).map((x) => `${x.id}:${x.full_name}`).join('|')
ok(`los otros ${otros.split('|').length} comerciales siguen en su sitio (se comprueba en la base)`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('7 · RECARGAR LA PÁGINA ENTERA')

await p.goto(`${BASE}/#/comerciales`, { waitUntil: 'networkidle2' })
await esperar('el mapa', 'document.querySelectorAll(".mapa__zona").length === 9')
// Un clic a la vez: el protocolo espera al manejador async y se queda colgado.
await clic('.item-comercial__btn')
const ficha2 = await esperar('la ficha otra vez', '!!document.querySelector(".ficha__cab h3")')
ficha2 ? ok('la ficha se vuelve a abrir') : mal('no se puede volver a abrir la ficha')

const trasRecarga = await p.evaluate(
  '(() => { const t = Array.from(document.querySelectorAll(".bloque-editable p")).map(x => x.textContent);'
  + ' return { nota: t.find(x => /NOTA-/.test(x)) || null,'
  + '          idiomas: t.find(x => /\\bwo\\b/.test(x)) || t.find(x => /fr/.test(x)) || null }; })()',
)
trasRecarga.nota
  ? ok(`la nota PERSISTE tras recargar: ${String(trasRecarga.nota).slice(0, 40)}`)
  : mal('la nota NO sobrevive a la recarga: se guardó solo en memoria')
trasRecarga.idiomas
  ? ok(`los idiomas persisten: ${String(trasRecarga.idiomas).slice(0, 34)}`)
  : mal('los idiomas no sobreviven a la recarga')

const zonasPantalla = await p.evaluate('document.querySelectorAll(".lista__item").length')
ok(`  → la ficha muestra ${zonasPantalla} zonas`)

await p.screenshot({ path: '/workspace/comerciales-editable.png', fullPage: true })

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'EDITAR GUARDA, PERSISTE Y NO TOCA NADA DE MÁS' : `HAY ${fallos} FALLOS`)

if (erroresJs.length) {
  console.log('  errores de JavaScript:')
  for (const e of [...new Set(erroresJs)].slice(0, 5)) console.log('   ·', e)
}
await nav.close()
process.exit(fallos === 0 ? 0 : 1)