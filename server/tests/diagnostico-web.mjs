/**
 * POR QUÉ NO CARGA EL JAVASCRIPT
 *
 * Abre la web en un navegador de verdad y SE IMPRIME EL ERROR que da el
 * navegador, en lugar de deducirlo.
 *
 * `node --check` dice que todos los ficheros están bien, y aun así no carga
 * nada. Porque un módulo que importa un nombre que no existe no es un error de
 * sintaxis: es un error de ENLACE, y lo da el navegador al resolver el
 * grafo, no Node al leer el fichero.
 *
 * Y este caso concreto —una página nueva, con un import que nadie había
 * cargado todavía— es justo el que no lo cazan las pruebas de navegador que ya
 * había: estas usan la aplicación completa con una base de datos de pruebas, y
 * el fallo aparece al abrir LA URL, en el móvil, con la caja de JavaScript
 * puesta.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const aqui = path.dirname(fileURLToPath(import.meta.url))
const puppeteer = require(path.join(aqui, 'tools', 'node_modules', 'puppeteer'))

const url = process.argv[2]
if (!url) {
  console.log('  Falta la URL.')
  process.exit(1)
}

const navegador = await puppeteer.launch({
  headless: 'new',
  //
  // El certificado del túnel no está en la lista de confianza de ESTE sandbox,
  // así que Chromium se niega a entrar. El del móvil sí lo está, y por eso el
  // usuario ve la página y este script no. No es un problema del túnel: es que
  // aquí nadie confió en Cloudflare.
  //
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
})
const fallos = []
try {
  const p = await navegador.newPage()
  p.on('console', (m) => {
    if (m.type() === 'error') fallos.push('consola: ' + m.text())
  })
  p.on('pageerror', (e) => fallos.push('pageerror: ' + e.message))
  p.on('requestfailed', (r) =>
    fallos.push(`petición fallida: ${r.url()} — ${r.failure()?.errorText}`))
  p.on('response', (r) => {
    if (r.status() >= 400) fallos.push(`HTTP ${r.status()}: ${r.url()}`)
  })

  await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 2500))

  // ¿Ha pintado algo el JavaScript?
  const estado = await p.evaluate(() => ({
    // Un FORMULARIO que existe pero con la app muerta: el botón no hace nada.
    hayBoton: !!document.querySelector('button'),
    // El aviso de «el JavaScript no ha podido cargarse» lo pone la propia app
    // al no encontrar su arranque. Si está, ya sabemos que la app arrancó.
    avisoJs: document.body.innerText.includes('JavaScript no ha podido'),
    // Y esto es lo que de verdad dice si la app vive.
    tieneMarcador: !!document.querySelector('#app, [data-app], main, .app'),
    cuerpo: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
  }))

  console.log(`  URL abierta: ${url}`)
  console.log(`  botón «Entrar» presente: ${estado.hayBoton}`)
  console.log(`  aviso de JS roto: ${estado.avisoJs}`)
  console.log(`  contenedor de la app: ${estado.tieneMarcador}`)
  console.log('')
  if (fallos.length) {
    console.log('  FALLOS:')
    for (const f of [...new Set(fallos)].slice(0, 12)) console.log('   · ' + f.slice(0, 300))
  } else {
    console.log('  Ningún error de consola. La app carga.')
  }
} finally {
  await navegador.close()
}
