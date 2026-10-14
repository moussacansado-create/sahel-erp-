/**
 * ESCÁNER DE TARJETAS
 *
 * Apunta la cámara a la tarjeta y el cliente aparece. Es el momento donde la
 * cadena se cierra: la tarjeta que el cliente enseña es lo que abre su ficha
 * y sus pedidos pendientes.
 *
 * Decisiones que importan más de lo que parecen:
 *
 * · Se usa `getUserMedia` y NO `BarcodeDetector`. La API nativa existe en
 *   Chrome de escritorio, pero NO en iOS Safari ni en Firefox, y el repartidor
 *   lleva el móvil en la mano. jsQR funciona en todas partes y pesa poco.
 *
 * · `touch-action: none` en el vídeo. Sin eso, el gesto de «deslizar para
 *   hacer scroll» se come el arrastre del encuadre y la cámara «se queda
 *   pegada» mientras el repartidor la mueve.
 *
 * · El fotograma se analiza con `requestAnimationFrame` y NO con un
 *   `setInterval`. Los temporizadores siguen corriendo con la pestaña en
 *   segundo plano y se comen la batería del móvil justo cuando más hace
 *   falta: un reparto entero con el teléfono al 3 %.
 *
 * · SIEMPRE HAY UNA VIA MANUAL. En un almacén con la cámara del móvil tapada
 *   por una funda, sin luz o con la tarjeta sucia, el repartidor tiene que
 *   poder escribir el código. Un escáner que no tiene plan B no es un
 *   escáner, es un adorno que falla el día que hace falta.
 */

import { el, boton, aviso, cargando, modal } from './ui.js'

/**
 * Un importe, con los decimales que le tocan a SU moneda.
 *
 * XOF no lleva decimales: son frascos y no se codecs. Poner «1.210,00 FCFA» es
 * ruido que hace dudar de si son mil doscientos diez o mil doscientos diez
 * con algo. Y EUR sí lleva dos, porque un céntimo de euro ahí significa algo.
 *
 * Misma regla que en la base (`redondearPara`): se decide UNA vez, y es
 *según la moneda, no de la pantalla.
 */
function dinero(v, moneda) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '—'
  const dec = moneda === 'EUR' ? 2 : 0
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  }) + ' ' + (moneda === 'EUR' ? 'EUR' : 'FCFA')
}
import * as A from './api.js'

/** Cuántos píxeles de lado tiene el fotograma que se analiza. */
const LADO_ANALISIS = 480

/**
 * Lector de QR con la cámara.
 *
 * @param {object}   opciones
 * @param {Function} opciones.alLeer   recibe el texto leído del QR
 * @param {Function} opciones.alCerrar
 * @returns {{nodo: HTMLElement, parar: Function}}
 */
export function escanerQr({ alLeer, alCerrar, instruccion = 'Encuadra el QR de la tarjeta' } = {}) {
  const video = el('video', { class: 'escaner__video', playsinline: true, muted: true })
  const marco = el('div', { class: 'escaner__marco' }, [
    video,
    el('div', { class: 'escaner__guia' }),
  ])
  const estado = el('div', { class: 'escaner__estado' }, [cargando('Abriendo la cámara…')])
  const manual = el('input', {
    class: 'escaner__manual',
    placeholder: 'O escribe el código: CS-…',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  })

  let flujo = null
  let animacion = 0
  let lienzo = null
  let contexto = null
  // Un QR se lee muchísimas veces seguidas mientras está delante de la cámara.
  // Sin este margen de gracia, se dispara `alLeer` treinta veces por segundo
  // y la pantalla parpadea.
  let ultimaLectura = ''
  let leidoHace = 0

  const lienzoAnalisis = () => {
    if (!lienzo) {
      lienzo = document.createElement('canvas')
      lienzo.width = LADO_ANALISIS
      lienzo.height = LADO_ANALISIS
      contexto = lienzo.getContext('2d', { willReadFrequently: true })
    }
    return { lienzo, contexto }
  }

  function analizar() {
    if (!video.videoWidth || !estado.dataset.error) {
      const w = video.videoWidth
      const h = video.videoHeight
      if (w) {
        const lado = Math.min(w, h)
        const x = (w - lado) / 2
        const y = (h - lado) / 2
        const { lienzo: c, contexto: ctx } = lienzoAnalisis()
        ctx.drawImage(video, x, y, lado, lado, 0, 0, LADO_ANALISIS, LADO_ANALISIS)
        try {
          const imagen = ctx.getImageData(0, 0, LADO_ANALISIS, LADO_ANALISIS)
          // `inversionAttempts: 'dontInvert'` porque la cámara de un móvil en
          // interiores suele dar un fotograma apagado, y el QR es oscuro sobre
          // claro: invertirlo no ayuda y cuesta el doble de tiempo.
          const r = window.jsQR(imagen.data, LADO_ANALISIS, LADO_ANALISIS, {
            inversionAttempts: 'dontInvert',
          })
          if (r && r.data) {
            const ahora = Date.now()
            if (r.data !== ultimaLectura || ahora - leidoHace > 3000) {
              ultimaLectura = r.data
              leidoHace = ahora
              navigator.vibrate?.(60)
              alLeer?.(r.data)
            }
          }
        } catch {
          // `getImageData` lanza si la imagen se tacha por seguridad. Se
          // ignora: el siguiente fotograma volverá a intentarlo.
        }
      }
    }
    animacion = requestAnimationFrame(analizar)
  }

  async function arrancar() {
    if (!navigator.mediaDevices?.getUserMedia) {
      estado.replaceChildren(aviso(
        'Este navegador no puede abrir la cámara. Escribe el código a mano.', 'aviso'))
      return
    }
    try {
      // `facingMode: 'environment'` es la cámara TRASERA: con la frontal se
      // escanea el propio reflejo, y hay que dar la vuelta al móvil.
      flujo = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      })
      video.srcObject = flujo
      await video.play()
      estado.replaceChildren(el('span', { text: instruccion }))
      animacion = requestAnimationFrame(analizar)
    } catch (e) {
      const permiso = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      estado.dataset.error = '1'
      estado.replaceChildren(aviso(permiso
        ? 'Cámara denegada. Escribe el código a mano y todo lo demás sigue igual.'
        : `No se pudo abrir la cámara (${e.name || 'error'}). Escribe el código a mano.`,
      'aviso'))
    }
  }

  function parar() {
    cancelAnimationFrame(animacion)
    animacion = 0
    flujo?.getTracks().forEach((t) => t.stop())
    flujo = null
    video.srcObject = null
  }

  const nodo = el('div', { class: 'escaner' }, [
    marco, estado,
    el('div', { class: 'escaner__pie' }, [
      manual,
      boton('Buscar', () => {
        const v = manual.value.trim()
        if (v) { parar(); alLeer?.(v) }
      }, 'btn'),
    ]),
  ])

  arrancar()
  return { nodo, parar }
}

/**
 * Escanea una tarjeta y devuelve el cliente.
 *
 * @param {object} opciones
 * @param {Function} [opciones.alResolver]  recibe el cliente ya resuelto
 * @returns {{nodo: HTMLElement, parar: Function}}
 */
export function escanerTarjeta({ alResolver } = {}) {
  const cuerpo = el('div', { class: 'pila' })
  const resultado = el('div')

  async function resolver(texto) {
    resultado.replaceChildren(cargando('Buscando la tarjeta…'))
    try {
      const c = await A.api(`/qr/${encodeURIComponent(texto)}`)
      alResolver?.(c)
      return c
    } catch (e) {
      resultado.replaceChildren(aviso(e.message, 'error'))
      return null
    }
  }

  const escaner = escanerQr({
    alLeer: (texto) => resolver(texto),
    alCerrar: () => escaner.parar(),
    instruccion: 'Encuadra el QR de la tarjeta del cliente',
  })

  cuerpo.append(escaner.nodo, resultado)
  return { nodo: cuerpo, parar: escaner.parar, resolver }
}

/**
 * El escáner, tal como lo usa el repartidor en la puerta.
 *
 * Al leer una tarjeta NO se abre la ficha completa con el límite de crédito del
 * cliente delante de él. Se muestra lo único que necesita para entregar: quién
 * es, y qué le hay que llevar. El resto se mira en el despacho, no en la calle.
 */
/** 12.0000 → «12», 12.5 → «12,5». Sin ceros de relleno. */
function redondea(n) {
  const v = Number(n)
  return Number.isInteger(v) ? String(v) : String(v).replace(/0+$/, '').replace(/\.$/, '')
}

export function abrirEscaner({ alEntregar, alCobrar } = {}) {
  const resultado = el('div')

  let capa = null
  const leida = el('div', { class: 'tarjeta-leida' })
  resultado.append(leida)

  async function pintarCliente(c) {
    const pedidos = c.pedidos_pendientes || []
    const noEntregables = c.pedidos_no_entregables || []
    //
    // OJO: `replaceChildren` es del navegador, NO es el `el()` de `ui.js`, y no
    // descarta los `null` como hace aquel. Si se le pasa un `null` tal cual, lo
    // pinta literalmente en la pantalla: la palabra «null» entre el cliente y
    // sus pedidos. Por eso el `.filter()` va AQUÍ y no dentro.
    leida.replaceChildren(...[
      // `/api/qr/:token` devuelve las columnas de `customers` tal cual: `name`
      // y `company_name`. Leer `c.nombre` pintaba «undefined» en la pantalla del
      // repartidor, justo el dato que necesita para saber a quién está
      // llamando.
      el('h3', { text: c.company_name || c.name || c.code }),
      el('div', { class: 'codigo', text: c.code }),
      noEntregables.length
        ? el('div', { class: 'tarjeta-leida__avisos' }, [
          el('b', { text: 'Otros pedidos de este cliente, todavía no entregables:' }),
          el('ul', {}, noEntregables.map((p) => el('li', {}, [
            el('code', { text: p.order_code }),
            el('span', { class: 'tenue', text: `  ${estadoTexto(p.status)}` }),
          ]))),
        ])
        : null,
      // Un botón POR PEDIDO, no uno genérico.
      //
      // Un cliente puede tener tres pedidos pendientes a la vez, y aquí están
      // en la misma pantalla. Un único botón de «Entregar» dejaría al
      // repartidor adivinar cuál, y equivocarse al cerrar una entrega no se
      // deshace: el stock ya bajó y el cliente ya firmó. Cada pedido lleva el
      // suyo, con su código a la vista.
      pedidos.length && (alEntregar || alCobrar)
        ? el('div', { class: 'tarjeta-leida__pedidos' }, [
          el('b', { text: alEntregar ? '¿Cuál acabas de entregar?' : '¿Qué vas a cobrar?' }),
          el('ul', {}, pedidos.map((p) => el('li', { class: 'fila-pedido-qr' }, [
            el('div', { class: 'fila-pedido-qr__datos' }, [
              el('code', { text: p.order_code }),
              el('span', { class: 'estado estado--' + (p.status === 'PREPARED' ? 'aviso' : ''), text: estadoTexto(p.status) }),
              // QUÉ LLEVA. Sin esto el repartidor tiene tres pedidos del mismo
              // cliente y ninguna manera de saber cuál es cuál.
              p.que_lleva ? el('div', { class: 'pequeno tenue', text: p.que_lleva }) : null,
              // Sin redondear. `qty_pending` viene de la base como NUMERIC y
              // sale «12.0000»: el repartidor no necesita cuatro decimales para
              // contar cajas, y le hacen dudar de si son 12 o 12,0001.
              Number(p.qty_pending)
                ? el('div', {
                  class: 'pequeno',
                  text: `${redondea(p.qty_pending)} uds por entregar`,
                })
                : null,
            ]),
            //
            // LO QUE HAY QUE COBRAR.
            //
            // Sale de `fn_pendiente_cobro()` en la base, que es la misma cuenta
            // que valida el cobro. No hay ningún campo para escribirlo, y a
            // propósito: un repartidor con el cliente delante es el peor sitio
            // del mundo para teclear una cifra, y un número tecleado es un
            // número que se puede teclear mal.
            //
            // Si no queda nada por cobrar, el pedido sigue en la lista —puede
            // quedar mercancía por entregar— pero el botón no aparece: no hay
            // nada que cobrar y ofrecer un «Cobrar» que va a fallar es peor que
            // no ofrecerlo.
            //
            p.pendiente_de_cobro != null && Number(p.pendiente_de_cobro) > 0
              ? el('div', { class: 'cobro-cifra' }, [
                el('span', { class: 'cobro-cifra__etiqueta', text: 'A cobrar' }),
                el('span', { class: 'cobro-cifra__valor', text: dinero(p.pendiente_de_cobro, p.moneda) }),
              ])
              : p.ya_cobrado
                ? el('div', { class: 'cobro-cifra cobro-cifra--pagado' },
                  el('span', { text: '✓ Pagado' }))
                : null,
            alEntregar
              ? boton('Entregar', async (ev) => {
                const b = ev.currentTarget
                b.disabled = true
                b.textContent = 'Registrando…'
                const ok = await alEntregar(p.order_id, p.order_code, c.id)
                if (!ok) { b.disabled = false; b.textContent = 'Entregar' }
              }, 'btn btn--principal')
              : null,
            alCobrar && Number(p.pendiente_de_cobro) > 0
              ? boton('Cobrar', async (ev) => {
                const b = ev.currentTarget
                b.disabled = true
                b.textContent = 'Cobrando…'
                const ok = await alCobrar(p.order_id, p.order_code, c.id, p)
                if (!ok) { b.disabled = false; b.textContent = 'Cobrar' }
              }, 'btn btn--principal')
              : null,
          ].filter(Boolean)))),
        ])
        : el('p', { class: 'pista', text: 'Aquí no hay nada que entregar de momento.' }),
    ].filter(Boolean))
  }

  const escaner = escanerTarjeta({ alResolver: (c) => { if (c) pintarCliente(c) } })

  const cuerpo = el('div', { class: 'pila' }, [
    escaner.nodo,
    resultado,
  ])
  capa = modal('Escanear cliente', cuerpo, [
    boton('Cerrar', () => { escaner.parar(); capa.remove() }),
  ])

  // Si el modal se cierra con Escape, la cámara tiene que apagarse también.
  // Una cámara encendida en segundo plano tiene el Led encendido con el móvil
  // bloqueado, y eso no lo hace nadie aposta.
  const parar = () => escaner.parar()
  window.addEventListener('beforeunload', parar, { once: true })
  return capa
}

function estadoTexto(s) {
  return {
    DRAFT: 'borrador', CONFIRMED: 'confirmado', RESERVED: 'apartado',
    PREPARED: 'preparado', IN_ROUTE: 'en reparto', DELIVERED: 'entregado',
    CANCELLED: 'anulado', RETURNED: 'devuelto',
  }[s] || String(s || '').toLowerCase()
}
