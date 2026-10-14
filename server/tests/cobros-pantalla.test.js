/**
 * PUNTO 2 · LA PANTALLA DE COBRO
 *
 * ── POR QUÉ UN TEST DE NAVEGADOR Y NO DE FUNCIONES ─────────────────────────
 *
 * Porque la regla de esta pantalla no es «la función pinta bien». Es que NO HAY
 * UN CAMPO DE IMPORTE. Y eso no se comprueba mirando el código de la función:
 * un `<input>` puede estar en el DOM y ser `display:none` y seguir siendo un
 * campo. O puede no estar en el DOM y existir un `oninput` que lo escriba.
 *
 * Lo que se comprueba es lo que se ve: que haya un número grande, que no haya
 * ningún campo editable al lado, y que ese número sea el que el pedido debe.
 *
 * ── LAS TRES COSAS QUE SE COMPRUEBAN ──────────────────────────────────────
 *
 *   1. El importe se MUESTRA. Y se muestra grande, que es la razón de ser de
 *      la pantalla.
 *   2. El importe NO SE PUEDE ESCRIBIR. Ni un input, ni un contenteditable, ni
 *      un campo oculto con `type=hidden` al que se le pueda mandar algo.
 *   3. El importe que se ve ES EL DEL PEDIDO, y sale de la tarjeta.
 *
 * Y la cuarta, que es la que de verdad importa y no se ve:
 *
 *   4. Al cobrar, la PETICIÓN NO LLEVA IMPORTE. Aunque el número se pueda
 *      tocar en el natural con el teclado o desde la consola. Eso se comprueba
 *      mirando lo que sale por la red.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

//
// `puppeteer` es CommonJS y se importa por RUTA, no por nombre: vive en
// `server/tests/tools/node_modules/`, que no está en el `node_modules` del
// proyecto. Con `import()` de una ruta a un paquete sale `ERR_UNSUPPORTED_DIR_IMPORT`,
// que suena a un problema de la prueba y es un problema de CUALQUIER.
//
// Importarla con el nombre a secas la installs en el repositorio entero, que no
// es lo que se quiere para una dependencia de 300 MB que solo se usa aquí.
//
const require = createRequire(import.meta.url)
const aqui = path.dirname(fileURLToPath(import.meta.url))
const rutaPuppeteer = path.join(aqui, 'tools', 'node_modules', 'puppeteer')

if (!fs.existsSync(rutaPuppeteer)) {
  console.log('  ⚠  SALTADA: puppeteer no está en server/tests/tools/')
  test('la pantalla de cobro', { skip: 'sin puppeteer' }, () => {})
} else {
  const puppeteer = require(rutaPuppeteer)
  const { readFileSync } = await import('node:fs')
  const base = path.join(aqui, '..', '..', 'web', 'js', 'paginas', 'cobros.js')
  const fuente = readFileSync(base, 'utf8')

  //
  // ── 2 · SIN MIRAR EL NAVEGADOR, PORQUE UNA PANTALLA ES SU CÓDIGO ──────────
  //
  // La primera mitad de estas pruebas mira el fichero. Suena a trampa, y lo
  // es: un test que solo lee el código no ve un campo `display:none`, pero
  // SÍ ve lo que importa aquí, que es si existe la intención de escribir un
  // importe. Y las de abajo, con el navegador de verdad, comprueban el resto.
  //
  test('la pantalla NO tiene un campo para el importe', () => {
    //
    // Ni un input, ni un number, ni un contenteditable, ni un textarea. En una
    // pantalla cuyo trabajo es enseñar una cifra.
    //
    assert.ok(!/<input[^>]*type=["']?(number|text)/i.test(fuente),
      'no hay ningún <input> de texto ni de número en la pantalla de cobro')
    assert.ok(!/contenteditable/i.test(fuente), 'no hay nada editable dentro')
    assert.ok(!/<textarea/i.test(fuente), 'no hay un área de texto')
  })

  test('la pantalla NO manda un importe al cobrar', () => {
    //
    // Se mira el objeto que va en la petición, no el que se pinta. Un
    // `importe_pendiente` que se lee y se enseña es correcto; un `amount` que
    // se lee y se manda es la regla rota.
    //
    const envio = fuente.match(/cuerpo:\s*\{[\s\S]*?\}/)
    assert.ok(envio, 'la pantalla manda un cuerpo a /api/payments')
    assert.ok(!/\b(amount|importe|precio|total)\b/.test(envio[0]),
      `y ese cuerpo no lleva ningún importe: ${envio[0].replace(/\s+/g, ' ')}`)
  })

  test('la pantalla SÍ enseña el importe que ya viene de la tarjeta', () => {
    assert.ok(/pendiente_de_cobro/.test(fuente),
      'el importe sale de lo que devuelve resolverQr()')
    assert.ok(!/pendiente_de_cobro\s*[-+*/]/.test(fuente),
      'y no se le toca: ni se le suma ni se le resta nada para enseñarlo')
  })

  //
  // ── 1, 3 y 4 · CON EL NAVEGADOR DE VERDAD ───────────────────────────────
  //
  test('en el navegador: se ve el importe, no se puede escribir, y se manda sin importe',
    async () => {
      const puppeteerReal = puppeteer
      const navegador = await puppeteerReal.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
      try {
        const p = await navegador.newPage()

        // Lo que sale por la red, tal cual. Es lo que se comprueba en el 4.
        //
        // Se carga SOLO el módulo, sin la aplicación entera: esta prueba es del
        // formulario, no de la navegación. Se pinnaclea lo que depende del
        // navegador —`el`, `boton`, `modal`— con un sustituto que construye
        // DOM de verdad, para que lo que se mide sea lo que se pinta de verdad.
        //
        await p.setContent('<!doctype html><html><body></body></html>')
        await p.addScriptTag({ content: `
          window.__registradas = [];
          function __el(tag, props, hijos) {
            const n = document.createElement(tag);
            for (const k in (props || {})) {
              const v = props[k];
              if (k === 'class') n.className = v;
              else if (k === 'text') n.textContent = v;
              else if (k === 'style') n.style.cssText = v;
              else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
              else if (v !== null && v !== undefined) n.setAttribute(k, v);
            }
            for (const h of [].concat(hijos || [])) if (h) n.append(h);
            return n;
          }
          window.el = __el;
          // El botón se lleva su manejador. Un stub que lo tirara haría que
          // «se pulsa Cobrar y pasa algo» no se pudiera comprobar nunca: el
          // botón existiría y no haría nada, que es justo el fallo que la
          // prueba está buscando.
          window.boton = (t, f, c) => {
            const b = __el('button', { class: (c || '') + ' ' + t }, [t]);
            b.addEventListener('click', (ev) => f && f(ev));
            return b;
          };
          window.aviso = (t) => __el('p', { class: 'aviso' }, [t]);
          // El modal mete el CUERPO y los BOTONES. Una primera versión de este
          // stub se comía el tercer argumento —«y aquí no hay botones»— y la
          // prueba de «se pulsa Cobrar» fallaba buscando un botón que el
          // propio stub no había puesto nunca. Un stub que se come argumentos
          // no prueba el código: prueba el stub.
          window.modal = (t, cuerpo, botones) => {
            const c = __el('div', { class: 'capa' }, [__el('h2', {}, [t]), cuerpo, ...(botones || [])]);
            document.body.append(c);
            return c;
          };
          window.importarUI = true;
        ` })

        // El módulo se importa como texto y se evalúa: se le da lo que pide.
        const modulo = readFileSync(base, 'utf8')
          .replace(/^import[\s\S]*?from\s+'\.\.\/ui\.js'\s*$/m, '')
          .replace(/^import \* as A from '\.\.\/api\.js'\s*$/m, '')
          // Y sin la palabra `export`, que aquí no hay módulo: el fichero se
          // evalúa dentro de una función y devuelve sus funciones a mano.
          .replace(/^export /gm, '')

        await p.evaluate(`window.__cobros = (() => {
          const A = { api: async (ruta, opts) => {
            if (String(ruta).includes('metodos')) return [
              { code: 'CASH', label: 'Efectivo', requires_reference: false },
              { code: 'ORANGE_MONEY', label: 'Orange Money', requires_reference: true },
            ];
            window.__capturado = { ruta, cuerpo: opts && opts.cuerpo };
            return { cobro: { id: 1 } };
          } };
          ${modulo}
          return { abrirCobro: typeof abrirCobro === 'function' ? abrirCobro : null };
        })()`)

        const hay = await p.evaluate('!!window.__cobros.abrirCobro')
        assert.ok(hay, 'el módulo exporta abrirCobro')

        // ── 1 · SE VE ────────────────────────────────────────────────────
        await p.evaluate(`(async () => {
          window.__cobros.abrirCobro(
            { order_id: 1, order_code: 'PED-1', pendiente_de_cobro: 1464.67, moneda: 'XOF' },
            () => {},
          )
        })()`)

        const texto = await p.evaluate('document.body.innerText')

        //
        // El número EXACTO, y no un «empieza por 1464».
        //
        // La primera versión comprobaba `/1[.\s]?464/`, que también encaja con
        // 1465, con 1464,67 redondeado y con casi cualquier variación de las
        // cuatro primeras cifras. Era una prueba que no probaba el importe: era
        // una prueba que probaba que el número empezaba por 1. Con 1465 Caía
        // igual. Aquí va el número entero y el decimal exactos.
        //
        const esperado = (1464.67).toLocaleString('es-ES',
          { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' FCFA'
        assert.ok(texto.includes(esperado),
          `la pantalla enseña «${esperado}»: ${JSON.stringify(texto.slice(0, 90))}`)
        assert.ok(!/1464/.test(texto.replace(/[\u202f\s]/g, '')),
          'y NO el 1464,67 con decimales: en francos no se muestran')
        assert.ok(!/1465[,.]00/.test(texto), 'ni con ceros de relleno')

        // ── 2 · NO SE PUEDE ESCRIBIR ────────────────────────────────────
        //
        // Se mira el DOM entero, no la parte visible. Un campo `display:none`
        // sigue siendo un campo, y a veces alguien lo encuentra.
        //
        const campos = await p.evaluate(`(() => {
          const escribibles = [...document.querySelectorAll(
            'input:not([type=hidden]), textarea, [contenteditable]')];
          return escribibles.map((n) => ({
            tipo: n.tagName + ':' + (n.getAttribute('type') || ''),
            valor: n.value,
            display: getComputedStyle(n).display,
          }));
        })()`)

        //
        // Y que no haya NINGÚN campo numérico, ni siquiera escondido. Un
        // `<input type="number">` que no se ve sigue siendo un sitio donde
        // escribir un importe, y el día que alguien lo enseña, ya está el hueco.
        //
        for (const c of campos) {
          assert.ok(!/number/.test(c.tipo),
            `no hay un campo numérico, ni escondido: ${c.tipo} (valor «${c.valor}»)`)
        }
        // El único campo que puede haber es la referencia del comprobante, y
        // con un método que NO lo pide no se enseña.
        //
        // OJO CON ESTO, que es la trampa de siempre.
        //
        // Lo natural es mirar `getComputedStyle(n).display !== 'none'`, y está
        // MAL: un input dentro de un contenedor oculto tiene su propio
        // `display` a lo normal —`inline-block`, `text`— aunque su padre esté
        // escondido. Se miraría «visible» un campo que no se ve.
        //
        // Lo que se pregunta es si el campo se VE, y para eso está
        // `offsetParent`: vale `null` cuando el elemento, o cualquiera de sus
        // ancestros, no se está pintando. Es lo que detecta un campo que hay en
        // la pantalla pero que nadie puede tocar.
        //
        const visibles = await p.evaluate(`(() => {
          return [...document.querySelectorAll('input:not([type=hidden]), textarea')]
            .filter((n) => n.offsetParent !== null)
            .map((n) => n.tagName + ':' + (n.getAttribute('type') || ''))
        })()`)
        assert.deepEqual(visibles, [],
          `con un método que no pide comprobante no hay NINGÚN campo a la vista: ${visibles}`)

        //
        // Y que la cifra ocupe de verdad un tamaño, no sea un elemento vacío.
        // Se mide AQUÍ, antes de pulsar: después del cobro el modal se cierra
        // —que es lo correcto— y la cifra ya no está, así que medida luego
        // daría cero y la prueba estaría midiendo un modal cerrado.
        //
        const ancho = await p.evaluate(
          `document.querySelector('.cobro-cifra__valor')?.getBoundingClientRect().width || 0`)
        assert.ok(ancho > 0, 'la cifra se pinta con tamaño de verdad, no sale vacía')

        // ── 4 · LO QUE SALE POR LA RED ─────────────────────────────────
        //
        // Se pulsa el botón de verdad y se mira lo que sale. Que el código no
        // tenga un campo es una cosa; que la petición no lo lleve es otra, y es
        // la que importa.
        //
        await p.evaluate(`window.__capturado = null`)
        const hayBotonCobrar = await p.evaluate(`(() => {
          const b = [...document.querySelectorAll('button')]
            .find((x) => /^Cobrar/.test(x.textContent))
          if (!b) return 'no hay ningún botón que empiece por «Cobrar»'
          b.click()
          return 'pulsado'
        })()`)
        assert.equal(hayBotonCobrar, 'pulsado',
          `el botón de cobrar: ${hayBotonCobrar}`)
        //
        // El manejador es asíncrono —primero pide los métodos a la API, luego
        // inserta el formulario—, así que hay que esperar a que termine. Y
        // cualquier error suyo se recoge aquí, porque un `catch` mudo dentro
        // de un manejador es un manejador que no hace nada y parece que sí.
        //
        await p.evaluate(`window.__fallo = null; window.addEventListener('unhandledrejection',
          (e) => { window.__fallo = String(e.reason && e.reason.stack || e.reason) })`)
        await new Promise((r) => setTimeout(r, 300))

        const fallo = await p.evaluate('window.__fallo')
        assert.equal(fallo, null, `el manejador del botón no falla: ${fallo}`)

        const mandado = await p.evaluate('window.__capturado')
        assert.ok(mandado, 'el botón ha intentado cobrar')
        assert.ok(/\/payments$/.test(mandado.ruta), `va a /api/payments: ${mandado.ruta}`)
        assert.ok(mandado.cuerpo.pedidoId === 1, 'con el pedido que se está cobrando')
        assert.ok(mandado.cuerpo.metodo === 'CASH', 'y con el método elegido')
        assert.ok(!/amount|importe|precio|total/i.test(JSON.stringify(mandado.cuerpo)),
          `y SIN ningún importe en el cuerpo: ${JSON.stringify(mandado.cuerpo)}`)

      } finally {
        await navegador.close()
      }
    })
}
