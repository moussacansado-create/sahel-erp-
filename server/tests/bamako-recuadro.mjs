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
  await pausa(3000)
  await p.evaluate((u, pw) => {
    const i = [...document.querySelectorAll('input')]
    const set = (e, v) => {
      Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set.call(e, v)
      e.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(i.find((x) => /user|usuario|login/i.test(x.name + x.id)) || i[0], u)
    set(i.find((x) => /pass|clave/i.test(x.name + x.id)), pw)
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
      etiquetas: [...svg.querySelectorAll('text.mapa__etiqueta')].map((t) => ({
        t: t.textContent.trim(), y: Math.round(+t.getAttribute('y')),
        h: Math.round(t.getBoundingClientRect().height) })),
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
  const solapes = []
  for (let i = 0; i < rec.etiquetas.length; i++) {
    for (let j = i + 1; j < rec.etiquetas.length; j++) {
      const a = rec.etiquetas[i], b = rec.etiquetas[j]
      if (Math.abs(a.y - b.y) < 8) solapes.push(`${a.t}/${b.t}`)
    }
  }
  chk(solapes.length === 0, `R3 · las etiquetas del recuadro no se solapan${solapes.length ? ' (' + solapes.join(', ') + ')' : ''}`)

  // ── 4 · SE PULSA UNA SUBAZONA Y SE ABRE SU FICHA ─────────────────────────
  const z = grandes.find((x) => /Centro/i.test(x.nombre)) || grandes[0]
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
  const guardado = await p.evaluate(async () => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    if (!sel) return { ok: false, motivo: 'no hay selector' }
    const antes = sel.value
    const otro = [...sel.options].find((o) => o.value && o.value !== antes)
    if (!otro) return { ok: false, motivo: 'solo hay una opcion' }
    const s = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value').set
    s.call(sel, otro.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const b = [...pn.querySelectorAll('button')].find((x) => /guardar|asignar|aplicar/i.test(x.textContent))
    if (!b) return { ok: false, motivo: 'no hay boton guardar' }
    b.click()
    return { ok: true, de: antes, a: otro.value, nombre: otro.textContent.trim() }
  })
  chk(guardado.ok, `R5 · se asigna un comercial y se guarda (${guardado.nombre || guardado.motivo || ''})`)
  await pausa(4000)

  // ── 6 · TRAS RECARGAR, LA ASIGNACIÓN SIGUE AHÍ ──────────────────────────
  await p.reload({ waitUntil: 'networkidle2' })
  await pausa(7000)
  // Tras recargar NO hay zona seleccionada: el panel sale vacio y no se puede
  // mirar nada. Se vuelve a pulsar la zona, que es lo que haria una persona, y
  // solo entonces se comprueba si lo guardado sigue ahi.
  await p.evaluate((nom) => {
    const b = [...document.querySelectorAll('.zonas__rejilla button')]
      .find((x) => x.textContent.includes(nom))
    if (b) b.click()
  }, 'Bamako Centro')
  await pausa(3500)
  const persistido = await p.evaluate((id) => {
    const pn = document.querySelector('.panel-zona, #panel-zona, [data-panel-zona]')
    const sel = pn?.querySelector('select')
    return { valor: sel ? sel.value : null, esperado: id }
  }, guardado.a)
  chk(persistido.valor === guardado.a,
    `R6 · tras recargar la asignacion sigue guardada (${persistido.valor === guardado.a ? 'si' : persistido.valor + ' != ' + guardado.a})`)

  // ── 7 · SE VE EN LA CARTERA ─────────────────────────────────────────────
  const cartera = await p.evaluate((nom) => {
    const t = document.body.innerText
    return { existe: !!nom && t.includes(nom), largo: t.length }
  }, guardado.nombre)
  chk(cartera.existe, `R7 · el comercial asignado aparece en la pantalla (${guardado.nombre})`)

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
