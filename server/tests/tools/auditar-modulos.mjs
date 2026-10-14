/**
 * AUDITORÍA DE ESTABILIDAD POR MÓDULOS.
 *
 * Recorre TODAS las pantallas de la aplicación y, en cada una, hace lo mismo
 * que una persona: entrar por el menú, mirar, recargar, volver a entrar por
 * URL directa y quedarse dentro. Y mide lo que de verdad se rompe:
 *
 *   · la pantalla en BLANCO (no un error visible, sino nada pintado),
 *   · errores de JavaScript en la consola,
 *   · peticiones que fallan o que devuelven algo que no es JSON,
 *   · lo que aparece escrito en pantalla cuando algo falla.
 *
 * Un módulo que «carga» en la red puede estar pintando un error, y un módulo
 * que no da error de consola puede estar en blanco. Por eso se mira lo pintado,
 * no solo la consola.
 *
 * Uso: node server/tests/tools/auditar-modulos.mjs [ruta ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { abrir } from './sesion.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer')
const B = process.env.BASE || 'http://127.0.0.1:10000'
const SALIDA = new URL('../../../salida-estabilidad/', import.meta.url).pathname

// Las 21 pantallas del menú, tal como están declaradas en app.js.
const RUTAS = [
  'panel', 'materias-primas', 'envases', 'productos', 'recetas', 'produccion',
  'compras', 'proveedores', 'lotes', 'entradas', 'stock', 'movimientos',
  'clientes', 'pedidos', 'albaranes', 'reparto', 'entregas', 'caja',
  'comerciales', 'usuarios', 'permisos', 'configuracion',
]

/** Vacía los acumuladores de error de una página. */
function limpiar(p) {
  p.__errores = []
  p.__fallos = []
  p.__malTipo = []
  p.on('pageerror', (e) => p.__errores.push(String(e.message).split('\n')[0]))
  p.on('response', async (r) => {
    const u = r.url()
    if (!u.includes('/api/')) return
    if (r.status() >= 400) {
      p.__fallos.push(`${r.status()} ${u.replace(/^.*\/api/, '/api').slice(0, 60)}`)
      return
    }
    // Un 200 que no es JSON es un 200 que no son datos. Pasa con
    // `text/html` cuando el enrutado del cliente se ha comido la ruta.
    const ct = r.headers()['content-type'] || ''
    if (!/json/.test(ct) && r.request().method() === 'GET') {
      p.__malTipo.push(`${r.status()} ${ct.split(';')[0]} ${u.replace(/^.*\/api/, '/api').slice(0, 50)}`)
    }
  })
}

/** Lo que hay PINTADO en la zona principal: texto, y si está en blanco. */
const pintado = (p) => p.evaluate(() => {
  const v = document.getElementById('vista') || document.querySelector('.contenido')
  if (!v) return { vacio: true, largo: 0, texto: '', alertas: 0, titulo: '' }
  const t = (v.innerText || '').trim()
  return {
    vacio: t.length < 3,
    largo: t.length,
    texto: t.slice(0, 200),
    alertas: v.querySelectorAll('.alerta--error').length,
    titulo: (v.querySelector('h1,h2') || {}).textContent || '',
  }
})

async function irA(p, ruta) {
  await p.evaluate((r) => { window.location.hash = '#/' + r }, ruta)
  await new Promise((s) => setTimeout(s, 1200))
}

async function main() {
  mkdirSync(SALIDA, { recursive: true })
  const nav = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const p = await nav.newPage()
  await p.setViewport({ width: 1440, height: 1000 })
  const problemas = []

  try {
    if (!await abrir(p, { base: B })) {
      console.log('\n  EL LOGIN ESTÁ CERRADO (429). Límite de 10 intentos cada 15 min.')
      process.exitCode = 1
      return
    }
    limpiar(p)

    const solo = process.argv.slice(2)
    const rutas = solo.length ? solo : RUTAS

    console.log('\n  ENTRADA POR EL MENÚ, RECARGA Y URL DIRECTA')
    console.log('  ' + 'módulo'.padEnd(18) + 'menú · recarga · URL · pintado · errores')
    for (const r of rutas) {
      p.__errores = []; p.__fallos = []; p.__malTipo = []

      // 1 · por el menú
      const hayEnlace = await p.evaluate((x) => {
        const a = document.querySelector('a[data-ruta="' + x + '"]')
        if (!a) return false
        a.click()
        return true
      }, r)
      await new Promise((s) => setTimeout(s, 1400))
      const desdeMenu = await pintado(p)

      // 2 · recarga (el F5 de la vida real)
      p.__errores = []; p.__fallos = []; p.__malTipo = []
      await p.reload({ waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((s) => setTimeout(s, 1200))
      const trasRecarga = await pintado(p)

      // 3 · entrada directa por URL, sin haber pasado por el menú
      p.__errores = []; p.__fallos = []; p.__malTipo = []
      await p.goto(B + '/#/' + r, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((s) => setTimeout(s, 1400))
      const porUrl = await pintado(p)

      const ok = {
        menu: hayEnlace && !desdeMenu.vacio,
        recarga: !trasRecarga.vacio,
        url: !porUrl.vacio,
        sinError: p.__errores.length === 0,
        sinFallo: p.__fallos.length === 0,
        sinHtml: p.__malTipo.length === 0,
      }
      const marca = (b) => (b ? '·' : 'X')
      const linea = `  ${r.padEnd(18)} ${marca(ok.menu)}     ${marca(ok.recarga)}      ${marca(ok.url)}    `
        + `  ${String(porUrl.largo).padStart(5)}c  ${p.__errores.length ? 'X' + p.__errores.length : '·'}`
      console.log(linea)

      for (const [k, v] of Object.entries(ok)) {
        if (!v) {
          const por = k === 'menu' ? 'por el menú'
            : k === 'recarga' ? 'tras recargar'
              : k === 'url' ? 'entrada directa por URL'
                : k === 'sinError' ? 'error de JavaScript'
                  : k === 'sinFallo' ? 'petición fallida' : 'respuesta que no es JSON'
          problemas.push(`${r}: ${por}`)
        }
      }
      for (const e of p.__errores.slice(0, 2)) problemas.push(`${r}: JS «${e.slice(0, 80)}»`)
      for (const f of p.__fallos.slice(0, 3)) problemas.push(`${r}: petición ${f}`)
      for (const m of p.__malTipo.slice(0, 2)) problemas.push(`${r}: ${m}`)

      // Lo que la pantalla DICE cuando algo va mal, que es la mitad del
      // problema cuando el usuario ve «no se han podido cargar» sin saber más.
      if (porUrl.alertas > 0) {
        const txt = await p.evaluate(() =>
          [...document.querySelectorAll('#vista .alerta--error, .contenido .alerta--error')]
            .map((x) => x.textContent.trim().slice(0, 110)).join(' | '))
        if (txt) problemas.push(`${r}: aviso EN PANTALLA «${txt}»`)
      }
      await p.screenshot({ path: SALIDA + r + '.png' }).catch(() => {})
    }

    console.log('')
    if (problemas.length) {
      console.log('  ' + problemas.length + ' PROBLEMA(S):')
      for (const x of problemas) console.log('    · ' + x)
    } else {
      console.log('  Ningún módulo falla por menú, recarga ni URL directa.')
    }
    writeFileSync(SALIDA + 'problemas.txt', problemas.join('\n') || 'ninguno')
    if (problemas.length) process.exitCode = 1
  } finally {
    await nav.close()
  }
}
main()
