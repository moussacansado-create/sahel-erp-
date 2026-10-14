/**
 * Arnés de IMPRESIÓN REAL.
 *
 * La vista previa del navegador engaña: un documento puede verse entero en
 * pantalla y salir partido en dos hojas, o al revés. Aquí no se mira la
 * pantalla. Se genera el PDF de verdad con el motor de impresión de Chromium y
 * se mide lo que sale:
 *
 *   · cuántas páginas tiene el PDF de verdad (no cuántas cree tener),
 *   · de qué tamaño es cada página, en milímetros,
 *   · cuánto mide el marco de la tarjeta, en milímetros reales.
 *
 * Para eso hace falta una regla: en CSS 1in son 96px SIEMPRE, así que
 * 1mm = 96/25,4 px. Midiendo en píxeles y dividiendo por eso, sale el milímetro
 * de papel, no una estimación.
 *
 * El PDF se guarda en `salida/` y se rasteriza con pdftoppm para poder ABRIRLO
 * y mirarlo. Un arnés que solo dice «4 páginas» sin dejar el papel a la vista
 * deja a medias la parte difícil: si algo se corta, hay que verlo cortado.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
/**
 * Espera a que la aplicación esté abierta, SIN escribir en el formulario.
 *
 * El token ya viene sembrado, así que la entrada ya está hecha: lo único que
 * hace falta es la MISMA señal que vigilaba `entrar` — que el menú exista y que
 * `#app` deje de estar oculta — porque esa señal es la que dice que la sesión
 * se ha recuperado y el arranque ha terminado. Dormir tres segundos y rezar no
 * es un arnés: es un temporizador con buena prensa.
 */
async function appLista(p, B) {
  await p.goto(B + '/', { waitUntil: 'networkidle2', timeout: 45000 })
  await p.waitForFunction(
    () => { const a = document.getElementById('app'); return a && !a.classList.contains('oculto') },
    { timeout: 25000 },
  )
  await p.waitForSelector('a[data-ruta=\'caja\']', { visible: true, timeout: 15000 })
  return true
}

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer')

const PX_POR_MM = 96 / 25.4
const A_PULG = process.env.BASE || 'http://127.0.0.1:10000'
const SALIDA = new URL('../../../salida-impresion/', import.meta.url).pathname

/** Páginas y tamaño real del PDF, leídos del propio fichero. */
export function medirPdf(ruta) {
  const info = execFileSync('pdfinfo', [ruta], { encoding: 'utf8' })
  const paginas = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] || 0)
  const tam = /Page size:\s+([\d.]+) x ([\d.]+) pts(?: \(([^)]*)\))?/.exec(info)
  return {
    paginas,
    anchoMm: tam ? +(Number(tam[1]) * 25.4 / 72).toFixed(2) : null,
    altoMm: tam ? +(Number(tam[2]) * 25.4 / 72).toFixed(2) : null,
    etiqueta: tam?.[3] || null,
  }
}

/**
 * Texto que el PDF tiene DENTRO de verdad, y cuantas páginas.
 *
 * Contar páginas no basta: un albarán de diez productos puede salir de UNA
 * página impecable y sin un solo producto, porque la tabla se aplastó por
 * debajo de su contenido. Eso pasó, y no se ve en la vista previa: se ve
 *y solo se ve en el papel. Aqui se lee el PDF con pdftotext y se cuenta.
 */
export function textoPdf(ruta) {
  return execFileSync('pdftotext', [ruta, '-'], { encoding: 'utf8', maxBuffer: 8 << 20 })
}

export function paginasPdf(ruta) {
  return medirPdf(ruta).paginas
}

/** Deja el PDF en PNG para poder mirarlo. */
export function ver(ruta, prefijo, ppp = 150) {
  execFileSync('pdftoppm', ['-png', '-r', String(ppp), ruta, prefijo])
}

const mm = (px) => +(px / PX_POR_MM).toFixed(2)

/**
 * Abre el documento en el navegador, mide lo que el motor de impresión va a
 * dibujar y genera el PDF.
 *
 * @param {import('puppeteer').Page} p
 * @param {string} modulo      ruta del módulo del frontend
 * @param {string} funcion     nombre de la función que abre el documento
 * @param {number} id          identificador del documento
 * @param {string} sel         selector del elemento que se mide
 */
async function documento(p, opts) {
  const { modulo, funcion, id, sel, pdf, papel } = opts
  // Se cierra cualquier modal anterior ANTES de abrir el siguiente.
  //
  // En la aplicación real solo hay un documento abierto a la vez, así que esto
  // no puede pasar. En el arnés sí, y era una falta de método: el albarán se
  // quedaba en el DOM con sus 271 mm de alto, y la tarjeta salía 397 mm más
  // abajo, empujada por un documento ajeno. Peor todavía: al seguir abierto el
  // albarán,  era cierto y sus reglas de impresión se
  // aplicaban a la tarjeta. Un fallo del arnés que parecía un fallo de CSS.
  await p.evaluate(() => { for (const c of document.querySelectorAll('.capa')) c.remove() })

  await p.evaluate(async (m, f, i) => {
    const mod = await import(m)
    await mod[f](i, { recargar: async () => {} })
  }, modulo, funcion, id)

  // Filas extra, si este caso las pide. Se clonan con la ventana YA en el ancho
  // de papel, nunca después: cambiar el viewport después de abrir el documento
  // hace que la aplicación se vuelva a dibujar en modo móvil y rehaga el DOM,
  // y entonces el PDF sale con la aplicación entera detrás del albarán. Un
  // fallo del arnés que parecía un fallo de las reglas de impresión.
  if (opts.filas && opts.filas > 1) {
    await p.evaluate((cuantas) => {
      const tb = document.querySelector('.albaran__tabla tbody')
      if (!tb) return
      const base = tb.querySelector('tr')
      if (!base) return
      [...tb.querySelectorAll('tr')].forEach((r) => { if (r !== base) r.remove() })
      for (let i = 1; i < cuantas; i++) tb.append(base.cloneNode(true))
      // Y la clase de densidad, que en la aplicación la pone el numero REAL de
      // lineas antes de pintar. Aqui hay que replicarla a mano.
      const c = document.querySelector('.albaran__copia')
      c.classList.remove('albaran__copia--denso', 'albaran__copia--muy-denso')
      if (cuantas >= 18) c.classList.add('albaran__copia--muy-denso')
      else if (cuantas >= 9) c.classList.add('albaran__copia--denso')
    }, opts.filas)
  }

  await p.waitForSelector(sel, { visible: true, timeout: 20000 })
  // La imagen del QR se pide con cabecera de sesión: hay que esperar a que haya
  // painted de verdad, o el PDF sale con un hueco donde iba el cuadradito.
  await p.waitForFunction(
    (s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect().width > 1 },
    { timeout: 15000 }, sel,
  )
  await new Promise((r) => setTimeout(r, 450))

  // MEDIR EN MODO IMPRESIÓN, SOBRE UN VIEWPORT DE PAPEL.
  //
  // Esto era el fallo del arnés, y de los gordos. Con emulateMediaType('print')
  // se aplican las reglas de impresión, pero el LAYOUT sigue midiéndose sobre
  // el ancho de la ventana del navegador: 1400 px, o 370,4 mm. Por eso el
  // albarán «medía» 370 mm de ancho y la tarjeta «a 317 mm de arriba». No eran
  // medidas del documento, eran medidas de la ventana con los estilos de papel.
  //
  // El viewport se pone al TAMAÑO IMPRIMIBLE del papel (A4 menos los márgenes
  // de @page). A partir de ahí, un píxel del DOM es un píxel de papel.
  if (papel) await p.setViewport({
    width: Math.round(papel.anchoMm * PX_POR_MM),
    height: Math.round(papel.altoMm * PX_POR_MM),
  })
  await p.emulateMediaType('print')
  await new Promise((r) => setTimeout(r, 320))

  // Lo que el motor de impresión va a poner sobre el papel, medido en mm.
  const medidas = await p.evaluate((s) => {
    const e = document.querySelector(s)
    const r = e.getBoundingClientRect()
    return {
      w: r.width, h: r.height, top: r.top, left: r.left,
      // El alto de TODO el cuerpo, no solo del documento. Es lo que decide si
      // el papel lleva algo más debajo, y se mide AQUÍ, en modo impresión:
      // después de restaurar la pantalla, el modal queda centrado en la ventana
      // y da una cifra que no es la del papel.
      cuerpo: Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height),
      // Y qué se sale del documento por un lado. Esto solo tiene sentido
      //midiendo en modo impresión: en pantalla la aplicación ocupa la ventana
      // entera, y «más ancho que la tarjeta» lo es todo.
      cosas: (() => {
        const fuera = []
        for (const e of document.querySelectorAll('body *')) {
          if (e.closest(s)) continue
          const cs = getComputedStyle(e)
          if (cs.display === 'none' || cs.visibility === 'hidden') continue
          const rr = e.getBoundingClientRect()
          if (rr.width < 1 || rr.height < 1) continue
          // Solo cuentan los bloques que PINTA algo. Un contenedor
          // transparente del ancho de la hoja no imprime nada, y no sale del papel.
          // que no se ve sale del papel.
          const fondo = cs.backgroundColor
          const pinta = (fondo && fondo !== 'rgba(0, 0, 0, 0)' && fondo !== 'transparent')
            || parseFloat(cs.borderTopWidth) > 0
            || parseFloat(cs.borderBottomWidth) > 0
            || parseFloat(cs.borderLeftWidth) > 0
            || parseFloat(cs.borderRightWidth) > 0
            || cs.boxShadow !== 'none'
          if (!pinta) continue
          if (rr.right > r.right + 7 || rr.bottom > r.bottom + 7) {
            fuera.push({ quien: e.tagName + '.' + String(e.className || '').slice(0, 28), px: rr.width, py: rr.height })
          }
        }
        return fuera.slice(0, 6)
      })(),
    }
  }, sel)

  mkdirSync(SALIDA, { recursive: true })
  const ruta = SALIDA + pdf
  // `preferCSSPageSize` hace que Chromium respete el `@page { size }`. Sin esto
  // sale SIEMPRE en Letter y la comprobación del tamaño de página no vale nada.
  await p.pdf({ path: ruta, printBackground: true, preferCSSPageSize: true })
  // Con DIAG se queda en modo impresión: el diagnóstico tiene que mirar la
  // maquetación de PAPEL. Restaurar pantalla aquí hacía que imprimiese el
  // estado de la pantalla — con la tarjeta centrada en el modal a 138 mm — y
  // parecía un fallo del CSS de impresión que no existía.
  if (!process.env.DIAG) {
    await p.emulateMediaType('screen')
    await p.setViewport({ width: 1400, height: 1000 })
  }

  return {
    ruta,
    caja: { anchoMm: mm(medidas.w), altoMm: mm(medidas.h) },
    cuerpoAltoMm: mm(medidas.cuerpo),
    cosas: medidas.cosas,
    arribaMm: mm(medidas.top),
    izquierdaMm: mm(medidas.left),
  }
}
const L = (ok, t) => console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t)

/**
 * Entra y devuelve un token de refresco ya sembrado en el navegador.
 *
 * El arnés hace UN login por fetch y lo pasa a `localStorage` ANTES de abrir la
 * página. La aplicación, al arrancar, llama a `A.recuperar()`, que renueva el
 * token con ese refresh y entra sola. Antes se escribía el formulario con el
 * teclado, y eso tiene un coste: el login va con límite de 10 intentos cada 15
 * minutos, así que el arnés se comía la ventana con sus propias pasadas y a
 * partir de la décima se quedaba esperando a una aplicación que no arrancaba
 * nunca. Con una vuelta de.login por ejecución, el presupuesto da de sobra.
 *
 * @returns {string|null} el refresh, o null si ahora mismo el login está cerrado
 */
async function sesionDePrueba() {
  const r = await fetch(A_PULG + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  })
  if (r.status === 429) return null
  if (!r.ok) throw new Error('el login devolvió ' + r.status)
  return (await r.json()).refresh
}

async function main() {
  const nav = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  })
  const p = await nav.newPage()
  await p.setViewport({ width: 1400, height: 1000 })
  const fallos = []

  try {
    const refresh = await sesionDePrueba()
    if (!refresh) {
      console.log('')
      console.log('  EL LOGIN ESTÁ CERRADO AHORA MISMO (429). El límite son 10 intentos')
      console.log('  cada 15 minutos por IP y usuario: hay que esperar a que se abra.')
      process.exitCode = 1
      return
    }
    // Sembrado ANTES de la primera navegación: si se pusiera después, la
    // aplicación ya habría intentado arrancar sin sesión.
    await p.evaluateOnNewDocument((r) => {
      try { localStorage.setItem('cs2.refresh', r) } catch {}
    }, refresh)
    await appLista(p, A_PULG)

    // ── 1 · ALBARÁN ───────────────────────────────────────────────────────
    console.log('\n  ALBARÁN')
    const alb = await documento(p, {
      modulo: '/js/paginas/albaranes.js',
      funcion: 'abrirAlbaran',
      id: Number(process.env.ALBARAN || 1),
      sel: '.albaran__copia',
      pdf: 'albaran.pdf',
      papel: { anchoMm: 188, altoMm: 271 },
    })
    const ma = medirPdf(alb.ruta)
    ver(alb.ruta, SALIDA + 'albaran')

    L(ma.paginas === 1, `el PDF tiene ${ma.paginas} página(s) — debe tener UNA`)
    if (ma.paginas !== 1) fallos.push('albarán: ' + ma.paginas + ' páginas')
    const esA4 = Math.abs(ma.anchoMm - 210) <= 1.5 && Math.abs(ma.altoMm - 297) <= 1.5
    L(esA4, `la página mide ${ma.anchoMm} × ${ma.altoMm} mm (A4 = 210 × 297)`)
    if (!esA4) fallos.push(`albarán: página de ${ma.anchoMm}×${ma.altoMm} mm`)
    L(ma.altoMm > ma.anchoMm, `es VERTICAL: ${ma.altoMm} mm de alto por ${ma.anchoMm} de ancho`)
    L(alb.caja.anchoMm <= 190, `el documento mide ${alb.caja.anchoMm} mm de ancho: cabe en los 188 mm imprimibles de 12+11 mm de margen`)

    // Lo mismo para el albarán: nada puede sobresalir del documento.
    const cosasA = (alb.cosas || []).map((x) => x.quien + ' (' + mm(x.px) + '×' + mm(x.py) + ' mm)')
    L(cosasA.length === 0, 'nada sobresale del albarán por los bordes'
      + (cosasA.length ? ' → ' + cosasA.join(' | ') : ''))
    if (cosasA.length) fallos.push('albarán: algo sobresale del documento')

    // ¿Se sale el contenido por abajo? La caja no puede pasar de 273 mm
    // (297 − 12 − 12), que es lo que queda entre los márgenes.
    // El area imprimible son 273 mm (297 - 12 - 12). El documento tiene que
    // caber AHORA, no caber mas 12 mm de margen: el margen ya lo pone @page.
    L(alb.caja.altoMm <= 273, `el documento mide ${alb.caja.altoMm} mm de alto: cabe en los 273 mm imprimibles`)
    if (alb.caja.altoMm > 273) fallos.push(`albarán: desborda (${alb.caja.altoMm} mm)`)

    // ── 1b · ALBARÁN CARGADO ──────────────────────────────────────────────
    // Un albarán de tres productos no es el peor caso. El peor es un pedido
    // grande, y es el que rompe la A4. Se clonan filas EN EL DOM — sin tocar
    // la base ni inventar un pedido — solo para medir dónde deja de caber.
    console.log('\n  ALBARÁN CON CARGA (peor caso)')
    for (const n of [10, 20, 30]) {
      const c = await documento(p, {
        modulo: '/js/paginas/albaranes.js',
        funcion: 'abrirAlbaran',
        id: Number(process.env.ALBARAN || 1),
        sel: '.albaran__copia',
        pdf: `albaran-${n}.pdf`,
        papel: { anchoMm: 188, altoMm: 266 },
        filas: n,
      })
      const mc = medirPdf(c.ruta)
      // Se cuenta «Desinfectante», no «Desinfectante 750 ml»: con la columna
      // estrecha la descripción se parte en dos líneas y pdftotext no devuelve
      // la frase entera. Contar la frase completa daba CERO filas en un
      // documento que las tenía todas, y eso es un fallo del arnés, no del
      // albarán — de los que hacen perder una hora.
      const dentro = (textoPdf(c.ruta).match(/Desinfectante/g) || []).length
      const firmas = textoPdf(c.ruta).includes('Firma y sello del repartidor')
      L(mc.paginas === 1, `${String(n).padStart(2)} filas → ${mc.paginas} página(s)`)
      L(dentro === n, `   … y las ${n} filas están las ${n} en el papel`)
      L(firmas, '   … y la zona de firma también')
      if (mc.paginas !== 1) fallos.push(`albarán con ${n} filas: ${mc.paginas} páginas`)
      if (dentro !== n) fallos.push(`albarán con ${n} filas: solo salen ${dentro} filas`)
      if (!firmas) fallos.push(`albarán con ${n} filas: sin zona de firma`)
    }
    ver(SALIDA + 'albaran-30.pdf', SALIDA + 'albaran-30')

    // ── 2 · TARJETA ───────────────────────────────────────────────────────
    console.log('\n  TARJETA DE CLIENTE')
    const tar = await documento(p, {
      modulo: '/js/paginas/tarjeta.js',
      funcion: 'abrirTarjeta',
      id: Number(process.env.CLIENTE || 337),
      sel: '.tarjeta-marco',
      pdf: 'tarjeta.pdf',
      papel: { anchoMm: 200, altoMm: 287 },
    })
    const mt = medirPdf(tar.ruta)
    ver(tar.ruta, SALIDA + 'tarjeta')

    L(mt.paginas === 1, `el PDF tiene ${mt.paginas} página(s) — una sola hoja A4`)
    if (mt.paginas !== 1) fallos.push('tarjeta: ' + mt.paginas + ' páginas')
    const a4t = Math.abs(mt.anchoMm - 210) <= 1.5 && Math.abs(mt.altoMm - 297) <= 1.5
    L(a4t, `la hoja mide ${mt.anchoMm} × ${mt.altoMm} mm — es un A4, no un bolsillo de tarjeta`)
    if (!a4t) fallos.push(`tarjeta: hoja de ${mt.anchoMm}×${mt.altoMm} mm`)

    const anchoOk = Math.abs(tar.caja.anchoMm - 85.6) <= 0.6
    const altoOk = Math.abs(tar.caja.altoMm - 54) <= 0.6
    L(anchoOk, `la tarjeta mide ${tar.caja.anchoMm} mm de ancho (85,6 pedido)`)
    L(altoOk, `la tarjeta mide ${tar.caja.altoMm} mm de alto (54 pedido)`)
    if (!anchoOk) fallos.push(`tarjeta: ancho ${tar.caja.anchoMm} mm`)
    if (!altoOk) fallos.push(`tarjeta: alto ${tar.caja.altoMm} mm`)

    L(tar.arribaMm <= 12, `está ARRIBA del todo: a ${tar.arribaMm} mm del borde superior`)
    if (tar.arribaMm > 12) fallos.push(`tarjeta: a ${tar.arribaMm} mm de arriba, no está arriba`)

    // ¿El marco se ve entero? Se mide el hueco de la hoja que queda por debajo:
    // si el marco estuviera cortado por un margen, el PDF no lo dibujaría.
    const hueco = await p.evaluate(() => {
      const m = document.querySelector('.tarjeta-marco')
      if (!m) return null
      const r = m.getBoundingClientRect()
      const cs = getComputedStyle(m)
      return {
        w: r.width, h: r.height,
        borde: cs.borderTopWidth, estilo: cs.borderTopStyle, color: cs.borderTopColor,
      }
    })
    L(hueco && parseFloat(hueco.borde) >= 0.1, `el marco de recorte tiene grosor visible: ${hueco?.borde || 'sin borde'} (${hueco?.estilo})`)
    if (!hueco || parseFloat(hueco.borde) < 0.1) fallos.push('tarjeta: el marco de recorte no se ve')
    L(hueco && Math.abs(mm(hueco.w) - 85.6) <= 0.6, `el marco mide ${hueco ? mm(hueco.w) : '?'} mm: coincide con la tarjeta, no es una caja mayor`)

    // El QR: tiene que estar DENTRO del marco, y cuadrado.
    const qr = await p.evaluate(() => {
      const i = document.querySelector('.tarjeta__qr')
      if (!i) return null
      const r = i.getBoundingClientRect()
      const c = document.querySelector('.tarjeta-marco').getBoundingClientRect()
      return {
        w: r.width, h: r.height, natural: [i.naturalWidth, i.naturalHeight],
        dentro: r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5,
        completa: i.complete && i.naturalWidth > 0,
      }
    })
    L(!!qr?.completa, 'el QR se ha cargado de verdad (no es un hueco)')
    L(!!qr?.dentro, 'el QR cae DENTRO del marco, sin sobresalir')
    L(!!qr && Math.abs(qr.w - qr.h) < 0.6, `el QR es cuadrado: ${mm(qr?.w || 0)} × ${mm(qr?.h || 0)} mm`)
    if (!qr?.dentro) fallos.push('tarjeta: el QR se sale del marco')

    // NADA EN EL PAPEL MÁS ANCHO QUE LA TARJETA.
    //
    // La tarjeta mide 85,6 mm en un A4 de 210. Si algún bloque del diálogo se
    // queda con el ancho de la página entera, el papel puede llevar una línea
    // o un borde que sobresale a la derecha de la tarjeta — y no se ve en la
    // vista previa, solo al imprimir. Se busca quién es.
    const cosas = (tar.cosas || []).map((x) => x.quien + ' (' + mm(x.px) + '×' + mm(x.py) + ' mm)')
    L(cosas.length === 0,
      'no sale nada más ancho que la tarjeta a su derecha'
      + (cosas.length ? ' → ' + cosas.join(' | ') : ''))
    if (cosas.length) fallos.push('tarjeta: hay bloques más anchos que la tarjeta')

    // ── 3 · Lo que NO debe imprimirse ──────────────────────────────────────
    //
    // Menú, botones y barras: se comprueba LEYENDO EL PDF, no mirando la
    // pantalla. En pantalla la aplicación está a la vista, y eso no dice nada
    // sobre el papel. En el PDF no puede aparecer ni una palabra del armazón.
    const appAlb = textoPdf(alb.ruta)
    const appTar = textoPdf(tar.ruta)
    const ruido = ['SISTEMA', 'ARTÍCULOS', 'CON STOCK', 'Producción', 'Recetas', 'Comerciales']
    for (const [nombre, txt] of [['albarán', appAlb], ['tarjeta', appTar]]) {
      const colado = ruido.filter((x) => txt.includes(x))
      L(colado.length === 0, `el PDF de la ${nombre} no lleva nada del menú de la aplicación`
        + (colado.length ? ` (sale: ${colado.join(', ')})` : ''))
      if (colado.length) fallos.push(`${nombre}: se imprime el menú (${colado.join(', ')})`)
    }
    L(!appTar.includes('Instrucciones'),
      'la tarjeta no arrastra las instrucciones de quien la prepara')
    // Y el resto de la hoja tiene que estar en blanco: si el cuerpo mide más
    // alto que la tarjeta, hay algo más impresso debajo que ocupa papel.
    L(tar.cuerpoAltoMm <= 60,
      `la hoja mide lo que la tarjeta y nada más: ${tar.cuerpoAltoMm} mm de alto en el papel`)
    if (tar.cuerpoAltoMm > 60) fallos.push(`tarjeta: ${tar.cuerpoAltoMm} mm de alto en el papel`)

    console.log('\n  LIMPIEZA DE LA IMPRESIÓN')
    // Nada de mirar la pantalla: en pantalla la aplicación está a la vista y
    // eso no dice nada sobre el papel. Lo que cuenta es lo que sale DENTRO del
    // PDF, comprobado más arriba con `textoPdf`.
  } finally {
    await nav.close()
  }

  console.log('')
  if (fallos.length) {
    console.log('  HAY ' + fallos.length + ' FALLO(S):')
    for (const f of fallos) console.log('    · ' + f)
    process.exitCode = 1
  } else {
    console.log('  Todo correcto.')
  }
  console.log('  PDF y PNG en ' + SALIDA)
}

main()
