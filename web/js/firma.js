/**
 * FIRMA EN PANTALLA
 *
 * Un lienzo donde quien recibe firma con el dedo o con el ratón. Sirve para dos
 * cosas: dejar la firma en el albarán y poder mirar después quién recibió.
 *
 * Decisiones que no son obvias:
 *
 * · Se dibuja con `pointer*` y no con `touch*` ni `mouse*`. Así funciona con
 *   dedo, con ratón y con lápiz sin escribir tres juegos de código. Además se
 *   pone `touch-action: none`: sin esto, el navegador se queda con el gesto y
 *   la línea sale cortada al deslizar.
 *
 * · `getCoalescedEvents()` agrupa los puntos intermedios. Un dedo rápido genera
 *   muchos más eventos que píxeles, y saltarse los intermedios deja la firma
 *   como una poligonal de lados rectos en vez de una curva.
 *
 * · El trazo se suaviza con curvas cuadráticas por el punto medio, no con
 *   líneas rectas entre puntos. Es lo que separa un garabato de una raya.
 */

import { el } from './ui.js'

/**
 * Crea un lienzo de firma.
 *
 * @param {object}   opciones
 * @param {string}   [opciones.alto]        Alto en píxeles CSS.
 * @param {boolean}  [opciones.multiple]    Permite más de un trazo.
 * @param {Function} [opciones.alCambiar]   Se llama cuando hay algo firmado o
 *                                          cuando se borra todo.
 * @returns {{nodo: HTMLElement, vacio: () => boolean, limpiar: Function,
 *            png: Function, ancho: number, alto: number}}
 */
export function lienzoFirma({
  alto = 180, multiple = true, alCambiar = null, etiqueta = 'Firma',
} = {}) {
  const DPR = Math.min(window.devicePixelRatio || 1, 2)

  const canvas = el('canvas', { class: 'firma__lienzo' })
  const ctx = canvas.getContext('2d')

  // Se fija el tamaño ANTES de dibujar. Cambiar `width`/`height` de un canvas
  // borra su contenido: si se hiciera al vuelo, la firma se borraría sola al
  // girar el móvil o al cambiar el tamaño de la ventana.
  const ancho = 640
  canvas.width = ancho * DPR
  canvas.height = alto * DPR
  canvas.style.width = '100%'
  canvas.style.height = `${alto}px`

  let trazos = 0
  let puntos = null
  let anterior = null
  let ultimoP = null

  function pintar() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, ancho, alto)
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#10151c'

    if (!puntos || puntos.length < 2) {
      if (anterior) {
        // Un toque sin arrastrar es un punto, no nada. La gente hace «puntos»
        // al final de la firma y, sin esto, desaparecen.
        ctx.beginPath()
        ctx.arc(anterior.x, anterior.y, 1.3, 0, Math.PI * 2)
        ctx.fillStyle = '#10151c'
        ctx.fill()
      }
      return
    }
    ctx.beginPath()
    ctx.moveTo(puntos[0].x, puntos[0].y)
    for (let i = 1; i < puntos.length - 1; i++) {
      const medio = { x: (puntos[i].x + puntos[i + 1].x) / 2, y: (puntos[i].y + puntos[i + 1].y) / 2 }
      ctx.quadraticCurveTo(puntos[i].x, puntos[i].y, medio.x, medio.y)
    }
    ctx.lineTo(puntos[puntos.length - 1].x, puntos[puntos.length - 1].y)
    ctx.stroke()
  }

  function avisar() {
    if (alCambiar) alCambiar(trazos > 0)
  }

  function coordenada(ev) {
    const r = canvas.getBoundingClientRect()
    // El ancho visual no es el del lienzo: en un móvil el canvas se estira al
    // 100% del contenedor. Sin esta división, la firma saldría comprimida a la
    // izquierda.
    return {
      x: (ev.clientX - r.left) * (ancho / r.width),
      y: (ev.clientY - r.top) * (alto / r.height),
    }
  }

  function empezar(ev) {
    if (!multiple && trazos > 0) return
    ev.preventDefault()
    canvas.setPointerCapture?.(ev.pointerId)
    if (!puntos) { puntos = []; anterior = null }
    puntos = []
    const p = coordenada(ev)
    anterior = p
    puntos.push(p)
    ultimoP = p
    trazos++
    pintar()
    avisar()
  }

  function mover(ev) {
    if (!puntos) return
    ev.preventDefault()
    // En un trazo rápido el navegador agrupa los eventos. Sin leer los
    // intermedios la línea sale como una poligonal.
    const eventos = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev]
    for (const e of (eventos.length ? eventos : [ev])) {
      const p = coordenada(e)
      if (ultimoP) puntos.push(p)
      ultimoP = p
    }
    pintar()
  }

  function terminar(ev) {
    if (!puntos) return
    ev.preventDefault?.()
    puntos = null
    anterior = ultimoP
    canvas.releasePointerCapture?.(ev.pointerId)
  }

  canvas.addEventListener('pointerdown', empezar)
  canvas.addEventListener('pointermove', mover)
  canvas.addEventListener('pointerup', terminar)
  canvas.addEventListener('pointercancel', terminar)
  canvas.addEventListener('pointerleave', terminar)

  function limpiar() {
    trazos = 0
    puntos = null
    anterior = null
    ultimoP = null
    pintar()
    avisar()
  }

  /** La firma como PNG en base64, que es lo que espera la API. */
  function png() {
    if (trazos === 0) return null
    // Se devuelve sin el `data:` inicial: la API lo acepta igual, pero así el
    // tamaño que se registra es el de la imagen de verdad.
    return canvas.toDataURL('image/png').split(',')[1]
  }

  const nodo = el('div', { class: 'firma' }, [
    el('div', { class: 'firma__marco' }, [canvas]),
    el('div', { class: 'firma__pie' }, [
      el('span', { class: 'pista', text: etiqueta }),
      el('button', {
        class: 'btn btn--mini', text: 'Borrar', type: 'button', onclick: limpiar,
      }),
    ]),
  ])

  return { nodo, vacio: () => trazos === 0, limpiar, png, ancho, alto }
}
