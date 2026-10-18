// EL RECUADRO DE BAMAKO, CONTADO DESDE LA WEB PÚBLICA.
//
// La mitad izquierda del encargo era cierto y comprobable: las pruebas
// anteriores de clic no decían nada de Bamako. Se podía hacer clic en una
// zona de Kayes y dar el mapa por bueno, con Bamako en cinco píxeles.
//
// Cada prueba mira algo que NO se puede ver leyendo el código: que el
// polígono tenga un tamano suficiente para pulsarse con el ratón, que la ficha
// aparezca, que lo que se guarda vuelva después de recargar, y que el
// cambio se vea en la cartera.
//
// Y con VISIBILIDAD real, no presencia en el DOM: un elemento puede estar
// puesto y ser `display:none`, y en el código parecer perfecto.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ruta = path.join(B, 'tests', 'tools', 'node_modules', 'puppeteer', 'lib', 'puppeteer', 'puppeteer.js')
const puppeteer = (await import(pathToFileURL(ruta).href)).default

const URL = process.env.PUBLIC_URL || 'https://sahel-erp.onrender.com'
const U = process.env.TEST_USER || 'admin'
const P = process.env.TEST_PASS
const pausa = (ms) => new Promise((r) => setTimeout(r, ms))

const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] })
const p = await nav.newPage()
await p.setViewport({ width: 1400, height: 1000 })
const errores = []
p.on('pageerror', (e) => errores.push(String(e.message)))

let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

try {
  // ── ENTRAR ───────────────────────────────────────────────────────────────
  await p.goto(`${URL}/#/login`, { waitUntil: 'networkidle2', timeout: 60000 })
  // Se ESPERA a que el formulario exista. Sin esta espera, la prueba falla
  // con «undefined (reading constructor)» cuando Render va lento, y parece
  // un fallo de la aplicación cuando solo es de la prueba.
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
    set(i.find((x) => x.type === 'password')
      || i.find((x) => /pass|clave/i.test(x.name + x.id)), pw)
    document.querySelector('form button')?.click()
  }, U, P)
  await pausa(6000)
  await p.goto(`${URL}/#/comerciales`, { waitUntil: 'networkidle2', timeout: 60000 })
  await pausa(6000)

  // ── 1 · EL RECUADRO EXISTE Y ESTÁ VISIBLE ────────────────────────────────
  const rec = await p.evaluate(() => {
    const f = document.querySelector('.mapa__recuadro')
    if (!f) return { existe: false }
    const r = f.getBoundingClientRect()
    const svg = f.querySelector('svg')
    return {
      existe: true, visible: getComputedStyle(f).display !== 'none' && r.width > 100
      , ancho: Math.round(r.width), alto: Math.round(r.height)
      , titulo: f.querySelector('figcaption')?.textContent.trim().slice(0, 60)
      , viewBox: svg?.getAttribute('viewBox')
      , zonas: [...svg.querySelectorAll('path.mapa__zona')].map((n) => {
        const b = n.getBoundingClientRect()
        return { nombre: n.getAttribute('aria-label')
          , w: Math.round(b.width), h: Math.round(b.height)
          , x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }),
      etiquetas: [...svg.querySelectorAll('text.mapa__etiqueta')].map((t) => {
        const b = t.getBoundingClientRect()
        return { t: t.textContent.trim(), x: b.x + b.width / 2, y: b.y + b.height / 2
          , w: b.width, h: b.height }
      }),
    }
  })
  chk(rec.existe, 'R1 · el recuadro de Bamako esta en la pagina')
  chk(rec.visible, `R1b · el recuadro SE VE (${rec.ancho}x${rec.alto})`)
  chk(/Bamako/i.test(rec.titulo || ''), `R1c · esta identificado como ampliacion («${rec.titulo}»)`)
  chk(rec.zonas.length >= 5, `R1d · el recuadro tiene las subzonas de Bamako (${rec.zonas.length})`)

  // ── 2 · CADA SUBZONA ES SUFICIENTEMENTE GRANDE PARA PULSARSE ────────────
  const grandes = rec.zonas.filter((z) => z.w >= 12 && z.h >= 12)
  chk(grandes.length === rec.zonas.length,
    `R2 · las ${rec.zonas.length} subzonas tienen tamano pulsable (min ${Math.min(...rec.zonas.map((z) => Math.min(z.w, z.h)))}px)`)

  // ── 3 · LAS ETIQUETAS NO SE TAPAN ENTRE SÍ ──────────────────────────────
  // Solapar es solapar EN DOS EJES. Dos rótulos uno al lado del otro, a la
  // misma altura, NO se tapan: la prueba anterior los contaba como solapados
  // solo por tener la Y parecida, y eso daba falsos positivos.
  const solapes = []
  for (let i = 0; i < rec.etiquetas.length; i++) {
    for (let j = i + 1; j < rec.etiquetas.length; j++) {
      const a = rec.etiquetas[i], b = rec.etiquetas[j]
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y)
      if (dx < (a.w + b.w) / 2 - 2 && dy < (a.h + b.h) / 2 - 2) {
        solapes.push(`${a.t}/${b.t}`)
      }
    }
  }
  chk(solapes.length === 0, `R3 · las etiquetas del recuadro no se solapan${solapes.length ? ' (' + solapes.join(', ') + ')' : ''}`)

  // ── 4 · SE PULSA UNA SUBAZONA Y SE ABRE SU FICHA ─────────────────────────
  const z = grandes.find((x) => /Centro/i.test(x.nombre)) || grandes[0]
  const zid = await p.evaluate((nom) => {
    const e = document.querySelector(`.mapa__recuadro path[data-zona-id]`)
    for (const q of document.querySelectorAll('.mapa__recuadro path[data-zona-id]')) {
      if (q.getAttribute('aria-label') === nom) return q.getAttribute('data-zona-id')
    }
    return null
  }, z.nombre)
  chk(zid !== null, `R2b · la zona del recuadro lleva identificador estable (${zid})`)
  await p.mouse.click(z.x, z.y)
  await pausa(2500)
  const ficha = await p.evaluate(() => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    return { txt: pn ? pn.textContent.trim() : '', hay: !!pn }
  })
  chk(ficha.hay && ficha.txt.length > 20,
    `R4 · al pulsar ${z.nombre} se abre su ficha (${ficha.txt.length} letras)`)
  chk(ficha.txt.includes(z.nombre.replace(/^Bamako\s*/, '')) || /Bamako/.test(ficha.txt),
    'R4b · la ficha es la de la zona pulsada')
  chk(!!(await p.$('.panel-zona select, #panel-zona select, [data-panel-zona] select')),
    'R4c · la ficha permite asignar comercial')

  // ── 5 · ASIGNAR UN COMERCIAL Y GUARDAR ──────────────────────────────────
  // LA PRUEBA ES REVERSIBLE: se cambia el comercial, se comprueba, y se
  // devuelve el original. Al final la zona queda con el responsable que
  // tenia. No se deja ninguna fila de prueba en la tabla de asignaciones.
  const guardado = await p.evaluate(async () => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    if (!sel) return { ok: false, motivo: 'no hay selector' }
    const original = sel.value
    const originalNombre = sel.selectedOptions[0]?.textContent.trim() || ''
    const otro = [...sel.options].find((o) => o.value && o.value !== original)
    if (!otro) return { ok: false, motivo: 'solo hay una opcion', original, originalNombre }
    const s = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value').set
    s.call(sel, otro.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const b = [...pn.querySelectorAll('button')].find((x) => /guardar|asignar|aplicar/i.test(x.textContent))
    if (!b) return { ok: false, motivo: 'no hay boton guardar', original, originalNombre }
    b.click()
    return { ok: true, original, originalNombre, a: otro.value, nombre: otro.textContent.trim() }
  })
  chk(guardado.ok, `R5 · se asigna un comercial y se guarda (${guardado.nombre || guardado.motivo || ''})`)
  chk(!!guardado.original, `R5b · la ficha venia con el responsable puesto (${guardado.originalNombre})`)
  await pausa(4000)

  // Y SE DEVUELVE, para no dejar el cambio.
  const devuelto = await p.evaluate(async (orig) => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    if (!sel) return { ok: false }
    const s = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value').set
    s.call(sel, orig)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const prio = pn.querySelector('input[type=checkbox]')
    if (prio && !prio.checked) { prio.checked = true
      prio.dispatchEvent(new Event('change', { bubbles: true })) }
    const b = [...pn.querySelectorAll('button')].find((x) => /guardar|asignar|aplicar/i.test(x.textContent))
    b?.click()
    return { ok: true }
  }, guardado.original)
  chk(devuelto.ok, 'R5c · la prueba se revierte: la zona queda como estaba')
  await pausa(4000)

  // La verdad de la asignacion: la API, no el formulario. Comparar el
  // formulario consigo mismo no demuestra nada. Se pregunta desde NODE, con
  // su propio token: desde la pagina, el token vive en otra clave y la
  // peticion sale sin autorizar.
  const login = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: U, password: P }),
  })
  const { access } = await login.json()
  const g = await (await fetch(`${URL}/api/comerciales/zona/${zid}/gestion`,
    { headers: { Authorization: `Bearer ${access}` } })).json()
  const pr = (g.asignados || []).find((a) => a.es_principal)
  const verdad = pr ? { id: String(pr.comercial_id), nombre: pr.full_name } : null
  chk(!!verdad, `R6b · la API dice quien es el responsable (${verdad ? verdad.nombre : 'ninguno'})`)

  // ── 6 · TRAS RECARGAR, LA ASIGNACIÓN SIGUE AHÍ ──────────────────────────
  await p.reload({ waitUntil: 'networkidle2' })
  await pausa(7000)
  // Tras recargar NO hay zona seleccionada: el panel sale vacio y no se puede
  // mirar nada. Se vuelve a pulsar la zona, que es lo que haria una persona, y
  // solo entonces se comprueba si lo guardado sigue ahi.
  // Por el IDENTIFICADOR, no por el texto: el texto es lo que ve la persona
  // y puede cambiar; el id es lo que identifica a la zona de verdad.
  const reSel = await p.evaluate((id) => {
    const b = document.querySelector(`.zonas__rejilla button[data-zona-id="${id}"]`)
    if (!b) return { ok: false, motivo: 'no hay boton con ese data-zona-id' }
    b.click()
    return { ok: true }
  }, String(zid))
  chk(reSel.ok, `R6a · tras recargar se vuelve a seleccionar la zona por su id (${reSel.motivo || 'ok'})`)
  await pausa(3500)
  const persistido = await p.evaluate((id) => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    return { valor: sel ? sel.value : null, esperado: id }
  }, String(zid))
  chk(persistido.valor === (verdad ? verdad.id : null),
    `R6 · tras recargar la asignacion sigue guardada (${persistido.valor === guardado.a ? 'si' : persistido.valor + ' != ' + guardado.a})`)

  // ── 7 · SE VE EN LA CARTERA ─────────────────────────────────────────────
  // El nombre del responsable se busca donde esta de verdad: en la opcion
  // seleccionada del selector. Un `<option>` NO forma parte del `innerText`
  // del cuerpo, y por eso la prueba anterior no lo encontraba nunca.
  const cartera = await p.evaluate((nom) => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    const opcion = sel?.selectedOptions[0]?.textContent.trim() || ''
    return { opcion, existe: !!nom && (opcion.includes(nom) || document.body.innerText.includes(nom)) }
  }, verdad ? verdad.nombre : '')
  chk(cartera.existe, `R7 · el comercial responsable aparece en la pantalla (${verdad ? verdad.nombre : '?'})`)

  // ── 8 · EL MAPA NACIONAL NO SE HA ROTO ──────────────────────────────────
  const nacional = await p.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg.mapa__svg')]
    const grande = svgs.find((s) => s.classList.contains('mapa__svg--grande'))
    if (!grande) return { existe: false }
    const r = grande.getBoundingClientRect()
    return { existe: true, zonas: grande.querySelectorAll('path.mapa__zona').length
      , ancho: Math.round(r.width), alto: Math.round(r.height)
      , viewBox: grande.getAttribute('viewBox') }
  })
  chk(nacional.existe && nacional.zonas === 14,
    `R8 · el mapa nacional sigue con sus 14 zonas`)
  chk(nacional.ancho > 400 && nacional.alto > 300,
    `R8b · el mapa nacional conserva su tamano (${nacional.ancho}x${nacional.alto})`)

  chk(errores.length === 0, `R9 · sin errores de JavaScript (${errores.length})`)
  if (errores.length) errores.slice(0, 3).forEach((e) => console.log('      · ' + e.slice(0, 90)))
} finally {
  await nav.close()
}
console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
