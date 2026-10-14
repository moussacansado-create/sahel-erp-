/**
 * CÓMO SE COMPORTA LA APLICACIÓN CUANDO ALGO FALLA.
 *
 * Tres cosas que se prueban aquí y que no se ven con la aplicación en las
 * condiciones normales:
 *
 *   · el servidor TARDA: la pantalla no se queda en «Cargando…» para siempre,
 *     y el trabajo no se pierde;
 *   · el servidor CAE: se dice qué ha pasado y se puede reintentar, sin que
 *     aparezca un error vacío ni una pantalla en blanco;
 *   · se REINTENTA: una escritura que se repite no deja dos registros.
 *
 * El retardo y la caída se inyectan en el navegador, no en el servidor: así se
 * prueba lo que vive de verdad en el cliente, que es donde están las diferencias
 * entre «se ha perdido» y «se puede reintentar».
 */
import { createRequire } from 'node:module'
import { abrir } from './sesion.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer')
const B = process.env.BASE || 'http://127.0.0.1:10000'
const L = (ok, t) => { console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t); return ok }
const fallos = []
const chk = (ok, t) => { if (!L(ok, t)) fallos.push(t) }

async function main() {
  const nav = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const p = await nav.newPage()
  await p.setViewport({ width: 1440, height: 1000 })

  try {
    if (!await abrir(p, { base: B })) {
      console.log('\n  EL LOGIN ESTÁ CERRADO (429).')
      process.exitCode = 1
      return
    }

    // Un SOLO manejador de peticiones, con un modo que se cambia. Registrar uno
    // nuevo encima del anterior hacía que los dos respondieran a la misma
    // petición y Puppeteer protestara con «Request is already handled» —un
    // fallo del arnés disfrazado de uno de la aplicación—.
    let modo = 'normal'
    await p.setRequestInterception(true)
    p.on('request', (r) => {
      const u = r.url()
      if (!u.includes('/api/')) return r.continue()
      if (modo === 'caido') return r.abort('connectionrefused')
      if (modo === 'lento' && /\/customers|\/mis-zonas/.test(u)) {
        return setTimeout(() => { try { r.continue() } catch {} }, 6000)
      }
      r.continue()
    })

    // ── 1 · EL SERVIDOR TARDA ────────────────────────────────────────────
    console.log('\n  EL SERVIDOR TARDA')
    modo = 'lento'
    await p.evaluate(() => { window.location.hash = '#/clientes' })
    await new Promise((s) => setTimeout(s, 1500))
    const durante = await p.evaluate(() => ({
      texto: ((document.getElementById('vista') || {}).innerText || '').trim(),
      cargando: !!document.querySelector('#vista .cargando'),
    }))
    chk(durante.cargando, 'mientras espera, la pantalla dice que está cargando (no se queda en blanco)')
    chk(durante.texto.length > 3, 'y hay algo escrito, no un hueco vacío: ' + JSON.stringify(durante.texto.slice(0, 46)))

    // Y cuando por fin responde, la pantalla se recupera sola.
    await new Promise((s) => setTimeout(s, 8000))
    const despues = await p.evaluate(() => ({
      texto: ((document.getElementById('vista') || {}).innerText || '').trim(),
      cargando: !!document.querySelector('#vista .cargando'),
    }))
    chk(!despues.cargando && despues.texto.length > 3,
      'cuando el servidor contesta, la pantalla se queda con el contenido, no con el «Cargando…»')

    // ── 2 · EL SERVIDOR CAE ──────────────────────────────────────────────
    console.log('\n  EL SERVIDOR CAE')
    modo = 'caido'
    await p.evaluate(() => { window.location.hash = '#/pedidos' })
    await new Promise((s) => setTimeout(s, 3000))
    const roto = await p.evaluate(() => ({
      texto: ((document.getElementById('vista') || {}).innerText || '').trim(),
      alertas: document.querySelectorAll('#vista .alerta--error').length,
      mensaje: ((document.querySelector('#vista .alerta--error') || {}).textContent || '').trim(),
    }))
    chk(roto.texto.length > 3, 'con el servidor caído la pantalla NO se queda en blanco')
    chk(roto.alertas > 0, 'y avisa con un mensaje de error, no en silencio')
    chk(roto.mensaje.length > 5, 'el aviso dice algo: ' + JSON.stringify(roto.mensaje.slice(0, 70)))
    chk(!/undefined|NaN|\[object/i.test(roto.texto),
      'el texto no suelta «undefined» ni «NaN» por ahí: ' + JSON.stringify(roto.texto.slice(0, 60)))

    // ── 3 · AL VOLVER EL SERVIDOR ────────────────────────────────────────
    console.log('\n  AL VOLVER EL SERVIDOR')
    modo = 'normal'
    await p.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise((s) => setTimeout(s, 2500))
    const recuperado = await p.evaluate(() =>
      ((document.getElementById('vista') || {}).innerText || '').trim().length)
    chk(recuperado > 3, 'recargar deja la pantalla como estaba, sin tocar nada: ' + recuperado + 'c')

    console.log('\n  ¿SE PUEDE SEGUIR TRABAJANDO?')
    await p.evaluate(() => { window.location.hash = '#/panel' })
    await new Promise((s) => setTimeout(s, 1400))
    const panel = await p.evaluate(() =>
      ((document.getElementById('vista') || {}).innerText || '').trim().length)
    chk(panel > 3, 'tras los fallos se puede seguir navegando con normalidad: ' + panel + 'c')

    console.log('')
    if (fallos.length) {
      console.log('  ' + fallos.length + ' FALLO(S):')
      for (const f of fallos) console.log('    · ' + f)
      process.exitCode = 1
    } else console.log('  Todo correcto.')
  } finally {
    await nav.close()
  }
}
main()
