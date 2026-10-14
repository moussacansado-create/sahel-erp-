/**
 * ENTRAR POR LA WEB, DE VERDAD
 *
 * Hay una diferencia entre «la API responde» y «se puede entrar». La API
 * responde a `curl` con el token puesto a mano; entrar es teclear un usuario en
 * un formulario, que el JavaScript tiene que leer, y pulsar un botón que
 * depende de un módulo entero haber cargado bien.
 *
 * Y esa diferencia no es teórica. La persona abrió esta misma URL, vio el
 * formulario —pintado, porque es HTML— y no pudo entrar: el módulo de escaneo
 * importaba un nombre que `ui.js` no exporta, y eso tumba TODOS los módulos, no
 * uno. `node --check` daba «correcto» en los veinte ficheros.
 *
 * Así que aquí se hace lo que hace una persona: abrir, escribir, pulsar, y
 * mirar qué se ve.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const aqui = path.dirname(fileURLToPath(import.meta.url))
const puppeteer = require(path.join(aqui, 'tools', 'node_modules', 'puppeteer'))

// Servidor PROPIO sobre la base de pruebas.
//
// Antes apuntaba a `127.0.0.1:10000`, o sea el servidor de la demostracion.
// Con un navegador de pruebas ahi, cada ejecucion dejaba rastro en la demo.
// `entornoConDemo()` levanta su base, la siembra y levanta su servidor en un
// puerto libre.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: URL_BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('entrar-web.test.js', URL_BASE)
const CONTRA = 'demo1234'

async function navegador() {
  return puppeteer.launch({
    headless: 'new',
    // El certificado del túnel no está en la lista de este sandbox. El del
    // móvil sí, y por eso allí se ve la página y aquí no sin esta opción.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  })
}

/** Teclear, pulsar y esperar a que la app cambie de pantalla. */
async function entrar(p, usuario, contra) {
  await p.waitForSelector('input', { timeout: 20000 })
  const campos = await p.$$('input')
  await campos[0].type(usuario)
  await campos[1].type(contra)

  //
  // Se busca POR TEXTO y no por posición.
  //
  // Pulsar «el primer botón» funcionaba hasta que la pantalla de acceso wieku
  // un botón más, y entonces pulsaba otro. Un selector por posición es un
  // selector que depende de que nadie añada nada.
  //
  const textos = await Promise.all(
    (await p.$$('button')).map((b) => b.evaluate((n) => n.textContent)))
  const i = textos.findIndex((t) => /entrar/i.test(t || ''))
  assert.ok(i >= 0, `hay un botón «Entrar»: ${JSON.stringify(textos)}`)
  await (await p.$$('button'))[i].click()
  return p
}

test('la web carga su JavaScript', async () => {
  const b = await navegador()
  try {
    const p = await b.newPage()
    const errores = []
    p.on('pageerror', (e) => errores.push(e.message))
    await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
    await new Promise((r) => setTimeout(r, 2000))
    const texto = await p.evaluate(() => document.body.innerText)
    assert.ok(!texto.includes('JavaScript no ha podido'),
      'sin el aviso de «el JavaScript no ha podido cargarse»')
    assert.ok(!errores.length, `sin errores de JS: ${errores.join(' | ')}`)
  } finally {
    await b.close()
  }
})

for (const [nombre, usuario] of [
  ['la administradora', 'admin'],
  ['la caja', 'caja'],
  ['un repartidor', 'reparto'],
]) {
  test(`${nombre} puede entrar con su usuario`, async () => {
    const b = await navegador()
    try {
      const p = await b.newPage()
      await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
      await entrar(p, usuario, CONTRA)
      await new Promise((r) => setTimeout(r, 2500))

      const texto = await p.evaluate(() => document.body.innerText)
      assert.ok(!/incorrect/i.test(texto),
        `«${usuario}» entra: la pantalla no dice que las credenciales sean incorrectas`)
      assert.ok(!/JavaScript no ha podido/.test(texto), 'y el JavaScript está bien')

      // Alguien que ha entrado ya no ve el formulario de acceso.
      assert.ok(!/^Entrar$/m.test(texto.trim()) || texto.includes('Caja') || texto.includes('Panel'),
        'y la aplicación ha pasado del login a la aplicación')
    } finally {
      await b.close()
    }
  })
}

test('un usuario que no existe NO entra, y se le dice por qué', async () => {
  const b = await navegador()
  try {
    const p = await b.newPage()
    await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
    await entrar(p, 'no-existe', 'tampoco')
    await new Promise((r) => setTimeout(r, 2000))
    const texto = await p.evaluate(() => document.body.innerText)
    assert.ok(/incorrect|inválid|no existe/i.test(texto),
      `un login malo dice algo: ${texto.slice(0, 120)}`)
  } finally {
    await b.close()
  }
})

//
// LA PANTALLA DE CAJA, VISTA DESDE DENTRO
//
// Que el login funcione no dice nada de que la página se pinte. Una pantalla
// puede fallar al pedir sus datos, al dibujar, o al recibir un campo que ya no
// existe —y entonces sale una caja en blanco con un «undefined» donde va el
// nombre, que es exactamente el tipo de cosa que solo se ve abriéndola.
//
test('la caja entra y ve QUIÉN LLEVA QUÉ', async () => {
  const b = await navegador()
  try {
    const p = await b.newPage()
    await p.setViewport({ width: 420, height: 900 })   // móvil
    await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
    await entrar(p, 'caja', CONTRA)
    await new Promise((r) => setTimeout(r, 2500))

    // A «Caja» por el menú, si hay; si no, por la URL, que es la misma app.
    let yendo = await p.evaluate(() => {
      const b = [...document.querySelectorAll('a,button')]
        .find((x) => /^\s*Caja\s*$/.test(x.textContent || ''))
      if (b) { b.click(); return 'menú' }
      return null
    })
    if (!yendo) {
      await p.goto(`${URL_BASE}/#/caja`, { waitUntil: 'networkidle2' })
      yendo = 'URL'
    }
    await new Promise((r) => setTimeout(r, 2500))

    const texto = await p.evaluate(() => document.body.innerText)
    assert.ok(/Caja/i.test(texto), `la pantalla de Caja se abre (${yendo})`)
    assert.ok(/Reparto|Diakité/.test(texto),
      `y hay alguien con dinero: ${texto.slice(0, 160).replace(/\s+/g, ' ')}`)
    assert.ok(/FCFA/.test(texto), 'con la cifra en su moneda')
    assert.ok(!/undefined/.test(texto), 'y NADA de «undefined» en pantalla')
    assert.ok(!/NaN/.test(texto), 'ni de «NaN»')
  } finally {
    await b.close()
  }
})

test('un repartidor NO ve la pantalla de caja', async () => {
  const b = await navegador()
  try {
    const p = await b.newPage()
    await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
    await entrar(p, 'reparto', CONTRA)
    await new Promise((r) => setTimeout(r, 2000))
    const menu = await p.evaluate(() =>
      [...document.querySelectorAll('a,button')].map((x) => x.textContent || '').join(' | '))
    assert.ok(!/^\s*Caja\s*$/m.test(menu),
      `el menú de un repartidor no ofrece Caja: ${menu.slice(0, 160)}`)
  } finally {
    await b.close()
  }
})

//
// PULSAR, NO SOLO MIRAR
//
// ── POR QUÉ ESTO ESTÁ SEPARADO ─────────────────────────────────────────────
//
// Las pruebas de arriba miran que la pantalla se pinte. Esta mira que los
// BOTONES hagan lo que dicen. Y son cosas distintas, y la diferencia costó una
// tarde: la pantalla de Caja se abría, con el título, la cifra y el repartidor
// bien, y al pulsar «Abrir traspaso» salía un «Can't find variable: capa».
//
// El motivo: la función hacía `return modal(...)` sin guardar el resultado en
// ninguna variable, y los botones llamaban a `capa.remove()`. Como el modal se
// abre igual, todo lo que se ve está bien, y el fallo solo aparece al tocar.
//
// Una prueba que mira la pantalla no ve ese fallo. Una que pulsa, sí.
//
test('los botones de la caja hacen lo que dicen', async () => {
  const b = await navegador()
  try {
    const p = await b.newPage()
    await p.setViewport({ width: 420, height: 900 })
    const errores = []
    p.on('pageerror', (e) => errores.push(e.message))

    await p.goto(URL_BASE, { waitUntil: 'networkidle2', timeout: 45000 })
    await entrar(p, 'caja', CONTRA)
    await new Promise((r) => setTimeout(r, 3000))

    const pulsar = async (patron) => {
      const textos = await Promise.all(
        (await p.$$('button')).map((x) => x.evaluate((n) => n.textContent)))
      const i = textos.findIndex((t) => patron.test(t || ''))
      assert.ok(i >= 0, `hay un botón que coincide con ${patron}: ${JSON.stringify(textos.slice(0, 8))}`)
      await (await p.$$('button'))[i].click()
      await new Promise((r) => setTimeout(r, 1200))
    }

    // 1 · «Recibir» abre el traspaso SIN reventar.
    await pulsar(/^Recibir$/)
    assert.deepEqual(errores, [],
      `pulsar «Recibir» no da ningún error de JavaScript: ${errores.join(' | ')}`)
    let texto = await p.evaluate(() => document.body.innerText)
    assert.ok(/Recibir de/.test(texto), `se abre el traspaso: ${texto.slice(0, 90)}`)
    // Sin distinguir mayúsculas, y por un motivo concreto: `.cobro-cifra__etiqueta`
    // lleva `text-transform: uppercase`, y `innerText` DEVUELVE el texto ya
    // transformado. La primera versión buscaba «Debería entregar» en minúsculas y
    // fallaba con la pantalla completamente correcta delante.
    //
    // Un test que depende de una propagación de estilo es un test que se rompe
    // cuando se toca el CSS, y no cuando se rompe la pantalla.
    assert.ok(/deber[ií]a entregar/i.test(texto), 'con la cifra de lo que debería traer')
    assert.ok(/24\.000|18\.500/.test(texto), 'y la cifra en FCFA')

    // 2 · «Cancelar» lo cierra. Antes esto daba «Can't find variable: capa».
    await pulsar(/^Cancelar$/)
    assert.deepEqual(errores, [], `y «Cancelar» tampoco: ${errores.join(' | ')}`)
    texto = await p.evaluate(() => document.body.innerText)
    assert.ok(!/deber[ií]a entregar/i.test(texto), 'el modal se ha cerrado')

    // 3 · El segundo paso: contar el dinero.
    await pulsar(/^Recibir$/)
    await pulsar(/^Abrir traspaso$/)
    assert.deepEqual(errores, [], `y «Abrir traspaso» tampoco: ${errores.join(' | ')}`)
    texto = await p.evaluate(() => document.body.innerText)
    assert.ok(/Contar el dinero/.test(texto), 'llega a contar el dinero')
    assert.ok(/esperado/i.test(texto), 'con lo esperado a la vista')

    // 4 · La casilla de «por qué» aparece SOLA cuando no cuadra.
    const conNota = await p.evaluate(() => {
      const i = document.querySelector('input[type=number]')
      if (!i) return { falta: true }
      i.value = '1'
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return new Promise((r) => setTimeout(() => r({
        hayNota: /por qué/i.test(document.body.innerText),
      }), 400))
    })
    assert.ok(!conNota.falta, 'hay un campo para lo que hay en la mano')
    assert.ok(conNota.hayNota,
      'y al contar una cifra que no cuadra, aparece sola la casilla de «por qué»')

    assert.deepEqual(errores, [], `nada de errores en todo el recorrido: ${errores.join(' | ')}`)
  } finally {
    await b.close()
  }
})
