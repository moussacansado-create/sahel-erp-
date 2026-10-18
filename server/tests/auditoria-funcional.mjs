// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA FUNCIONAL DE LA APLICACIÓN PÚBLICA
// ═══════════════════════════════════════════════════════════════════════════
//
// SOLO LECTURA. Esta auditoría NO escribe nada: no crea pedidos, ni
// clientes, ni cobros, ni movimientos. Se abre cada pantalla con un usuario
// real y se anota:
//
//   · qué pantallas ve ese usuario en el menú
//   · si la pantalla carga, y qué dice
//   · qué errores de JavaScript hay
//   · qué peticiones a la API fallan
//   · qué mensajes de «aún no hay datos» enseña
//
// El límite: el login es el único punto que escribe (una sesión). Se hace
// UN login por usuario y en un contexto de navegador aparte, para no
// disparar ningún limitador.
//
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ruta = path.join(B, 'tests', 'tools', 'node_modules', 'puppeteer', 'lib', 'puppeteer', 'puppeteer.js')
const puppeteer = (await import(pathToFileURL(ruta).href)).default

const URL = process.env.PUBLIC_URL || 'https://sahel-erp.onrender.com'
const P = process.env.TEST_PASS
const pausa = (ms) => new Promise((r) => setTimeout(r, ms))

const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] })

async function auditar(usuario, etiqueta) {
  const ctx = await nav.createBrowserContext()
  const p = await ctx.newPage()
  await p.setViewport({ width: 1440, height: 1000 })
  const errores = []
  const fallos = []
  p.on('pageerror', (e) => errores.push(String(e.message).slice(0, 120)))
  p.on('response', async (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) {
      fallos.push(`${r.status()} ${r.url().replace(/^.*\/api/, '/api').slice(0, 60)}`)
    }
  })

  await p.goto(`${URL}/#/login`, { waitUntil: 'networkidle2', timeout: 60000 })
  await p.waitForFunction(() => document.querySelectorAll('input').length >= 2
    && document.querySelector('input[type=password]'), { timeout: 45000 })
  await pausa(1200)
  const entro = await p.evaluate((u, pw) => {
    const i = [...document.querySelectorAll('input')]
    const set = (e, v) => {
      Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set.call(e, v)
      e.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(i.find((x) => /user|usuario|login/i.test(x.name + x.id))
      || i.find((x) => x.type !== 'password'), u)
    set(i.find((x) => x.type === 'password'), pw)
    document.querySelector('form button')?.click()
    return true
  }, usuario, P)
  await pausa(6000)

  const sesion = await p.evaluate(() => ({
    dentro: !!document.querySelector('#menu'),
    nombre: (document.querySelector('.lateral__pie')?.textContent || '').trim().slice(0, 40),
    menu: [...document.querySelectorAll('#menu .lateral__enlace')]
      .map((a) => ({ ruta: a.getAttribute('data-ruta'), texto: a.querySelector('span')?.textContent?.trim() })),
    grupos: [...document.querySelectorAll('#menu .lateral__grupo')].map((g) => g.textContent.trim()),
  }))

  const pantallas = []
  for (const item of sesion.menu) {
    errores.length = 0; fallos.length = 0
    await p.goto(`${URL}/#/${item.ruta}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await pausa(3500)
    const info = await p.evaluate(() => {
      const v = document.querySelector('#vista') || document.body
      const texto = (v.innerText || '').trim()
      const vacios = [...document.querySelectorAll('.vacio')].map((n) => n.innerText.trim().slice(0, 90))
      const avisos = [...document.querySelectorAll('.aviso')].map((n) => n.innerText.trim().slice(0, 90))
      const tablas = document.querySelectorAll('#vista table').length
      const filas = document.querySelectorAll('#vista table tbody tr').length
      const botones = [...document.querySelectorAll('#vista button')]
        .map((b) => b.textContent.trim()).filter(Boolean).slice(0, 14)
      return {
        texto: texto.slice(0, 260), vacios, avisos, tablas, filas, botones,
        visible: texto.length > 0,
      }
    })
    pantallas.push({ ...item, ...info, errores: [...errores], fallos: [...fallos] })
    await pausa(400)
  }
  await ctx.close()
  return { usuario, etiqueta, sesion, pantallas }
}

const USUARIOS = [
  ['admin', 'Administrador'],
  ['democ_akeita', 'Comercial'],
]

const resultado = []
for (const [u, e] of USUARIOS) {
  const r = await auditar(u, e)
  resultado.push(r)
  console.log(`\n═══ ${e.toUpperCase()} · ${u} ═══`)
  console.log(`  grupos: ${r.sesion.grupos.join(' | ')}`)
  console.log(`  pantallas en el menú (${r.sesion.menu.length}): ${r.sesion.menu.map((m) => m.ruta).join(', ')}`)
  for (const p of r.pantallas) {
    const marcas = [
      p.visible ? '' : 'VACIA',
      p.errores.length ? `JS(${p.errores.length})` : '',
      p.fallos.length ? `API(${p.fallos.slice(0, 2).join(' ')})` : '',
    ].filter(Boolean).join(' ')
    console.log(`   · ${p.ruta.padEnd(16)} filas=${String(p.filas).padStart(3)} tablas=${p.tablas} ${marcas}`)
    for (const v of p.vacios.slice(0, 2)) console.log(`       vacio: ${v.slice(0, 78)}`)
    for (const a of p.avisos.slice(0, 2)) console.log(`       aviso: ${a.slice(0, 78)}`)
    for (const er of p.errores.slice(0, 2)) console.log(`       JS: ${er}`)
    for (const f of p.fallos.slice(0, 2)) console.log(`       API: ${f}`)
  }
}

// RESUMEN PARA EL INFORME
console.log('\n═══ RESUMEN ═══')
for (const r of resultado) {
  const conFallo = r.pantallas.filter((p) => p.errores.length || p.fallos.length)
  const vacias = r.pantallas.filter((p) => !p.visible)
  console.log(`  ${r.etiqueta}: ${r.pantallas.length} pantallas · ${conFallo.length} con errores · ${vacias.length} vacías`)
  for (const p of vacias) console.log(`     vacía: ${p.ruta}`)
}

await nav.close()
