/**
 * ARRANQUE DE LA APLICACIÓN Y DIAGNÓSTICO DE FALLOS.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────
 *
 * `index.html` se entrega con el aviso «el JavaScript no ha podido cargarse»
 * VISIBLE, y `app.js` lo esconde en cuanto arranca. Es un buen truco para que
 * un fallo de arranque no se parezca a una página normal, pero tenía un
 * defecto: si el módulo fallaba, el usuario veía un texto que decía
 * «recarga la página» y nada más.
 *
 * Recargar da el mismo fallo. El mensaje no decía NI QUÉ falló ni POR QUÉ, y
 * quien lo recibía no tenía forma de helping más que mirar la pantalla y
 * esperar a que se arreglar solo.
 *
 * Este script hace tres cosas, y ninguna es «que la aplicación funcione»:
 *
 *   1. Escucha los errores de verdad —de módulo, de red, de promesa— y guarda
 *      el último con su origen.
 *   2. Comprueba que `app.js` ha arrancó. Si en 6 segundos no ha levantado la
 *      bandera, deduce por QUÉ no ha podido: si los ficheros de `js/` no
 *      cargan, es red o caché; si cargan y aun así no arranca, es un error de
 *      código.
 *   3. Escribe ese diagnóstico en pantalla y ofrece reintentar.
 *
 * ── POR QUÉ ES UN SCRIPT CLÁSICO Y NO UN MÓDULO ──────────────────────────────
 *
 * Porque tiene que ejecutarse ANTES que los módulos, incluso si los módulos
 * fallan al descargarse. Un `type="module"` posterior no se ejecuta si el
 * anterior falla, que es justo el caso que hay que cubrir.
 *
 * Y NO lleva script en línea: la CSP es `script-src 'self'` y los atributos
 * `onclick` están prohibidos por `script-src-attr 'none'`. Por eso el botón
 * de reintentar engancha su manejador desde aquí y no desde el HTML.
 */
(function () {
  'use strict'

  var MARGEN = 6 * 1000            // 6 s: de sobra para un móvil con 3G floja
  var fallos = []
  var appArranco = false

  // `window.__sahelArranque` se CREA aquí, no se supone. Este script es
  // diagnóstico: si se cuelga él mismo por leer algo que no existe, deja la
  // aplicación rota y encima afirma que la aplicación está rota. Un vigilante
  // que tira la casa abajo no vigila nada.
  window.__sahelArranque = window.__sahelArranque || { appArranco: false, fallos: [] }
  window.__sahelArranque.fallos = fallos

  // ── 1 · ESCUCHAR ───────────────────────────────────────────────────────────
  // `error` con `target` es un recurso que no cargó (script o link). `error` sin
  // `target` es código que reventó. `unhandledrejection` es un await que no se
  // Izzy. Los tres son fallos de arranque distintos y merecen distinto consejo.

  window.addEventListener('error', function (ev) {
    var el = ev.target
    if (el && el !== window && el.tagName) {
      fallos.push({
        tipo: 'recurso',
        que: el.tagName.toLowerCase() + (el.src ? ' ' + el.src : ''),
        detalle: 'No se ha podido cargar. Suele ser la conexión o una copia antigua en caché.',
      })
    } else if (ev.message) {
      fallos.push({ tipo: 'codigo', que: ev.message, detalle: (ev.filename || '') + ':' + (ev.lineno || '?') })
    }
    pintar()
  }, true)   // `true` = fase de captura: los fallos de carga de recursos no se propagan

  window.addEventListener('unhandledrejection', function (ev) {
    var m = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason)
    fallos.push({ tipo: 'promesa', que: m, detalle: 'Una operación quedó sin resolver.' })
    pintar()
  })

  // ── 2 · EL BOTÓN DE REINTENTAR ─────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('sin-js-reintentar')
    if (!b) return
    b.addEventListener('click', function (ev) {
      ev.preventDefault()
      // Recargar con la caché saltada solo tiene sentido si el problema es la
      // caché. Con `reload` a secas, Safari puede volver a servir los mismos
      // ficheros viejos y el fallo se repite idéntico.
      location.reload()
    })
  })

  // ── 3 · PINTAR EL DIAGNÓSTICO ──────────────────────────────────────────────
  var pintado = false
  function pintar() {
    var caja = document.getElementById('sin-js-detalle')
    if (!caja || pintado) return
    if (!fallos.length) return
    pintado = true
    var ultimo = fallos[fallos.length - 1]
    caja.textContent = 'Motivo: ' + (ultimo.que || 'desconocido') +
      (ultimo.detalle ? ' — ' + ultimo.detalle : '') +
      (fallos.length > 1 ? ` (${fallos.length} avisos en total)` : '')
  }

  // ── 4 · EL VELADOR ─────────────────────────────────────────────────────────
  // Si `app.js` no levanta la bandera, el módulo no arrancó. Se escribe POR
  // QUÉ: con los recursos cargados ya se sabe que no es la red.
  setTimeout(function () {
    // `|| {}` y no el nombre tal cual: si este mismo script no llegó a
    // ejecutarse, leer la bandera sería REVENTAR LA APLICACIÓN y dejar el
    // aviso de «no ha podido arrancar» que este fichero intenta evitar.
    var E = window.__sahelArranque || {}
    if (appArranco || E.appArranco) return
    var caja = document.getElementById('sin-js-detalle')
    var sinCss = false
    try {
      // Si el CSS no aplicó, el aviso se ve sin su propio estilo. No es un
      // diagnóstico, es una forma de saber que la hoja no llegó.
      sinCss = !getComputedStyle(document.getElementById('sin-js') || document.body).maxWidth
    } catch (e) { /* getComputedStyle no disponible: se ignora */ }
    if (caja && !pintado) {
      pintado = true
      caja.textContent = sinCss
        ? 'Las hojas de estilo no han cargado: la página se ve sin diseño. Es un problema de conexión, no de la aplicación.'
        : 'Los ficheros de JavaScript se han descargado pero el programa no ha podido ejecutarse. Suele ser una copia antigua en caché de una versión anterior.'
    }
  }, MARGEN)
}())
