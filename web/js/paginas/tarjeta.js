/**
 * TARJETA DE CLIENTE
 *
 * Un trozo de plástico con el nombre de una persona y un cuadradito. Es la
 * pieza que cierra el circuito: el cliente la enseña, el repartidor la escanea,
 * y la aplicación sabe a quién y qué le hay que entregar.
 *
 * Lo que NO lleva el QR, y por qué:
 *
 *   · Ninguna DIRECCIÓN. Si el QR fuera una URL, el dominio quedaría grabado
 *     en el plástico y el día que se cambie de servidor todas las tarjetas
 *     repartidas dejarían de servir. Lleva solo el token, que es opaco.
 *
 *   · Ningún DATO PERSONAL. Ciento noventa y dos bits de entropía. Ni una
 *     letra del nombre ni un dígito del teléfono. El nombre SÍ va impreso en la
 *     tarjeta, que es un documento que el cliente enseña a propósito; el QR es
 *     un token que la aplicación resuelve. Son cosas distintas.
 *
 *   · El nivel de corrección es ALTO (H). Estas tarjetas se plastifican, se
 *     manchan y se leen a contraluz. Con el nivel por defecto se leerían en el
 *     despacho y fallarían en la calle, que es donde de verdad se usan.
 */

import { el, panel, boton, modal, aviso, cargando } from '../ui.js'
import * as A from '../api.js'

/** El código del cliente tal como se imprime, sin el código del país. */
function lineaTelefono(tel) {
  return (tel || '').replace(/^\+/, '')
}

/**
 * La tarjeta, tal como sale del plástico.
 *
 * @param {object} t  lo que devuelve `GET /api/customers/:id/tarjeta`
 * @param {number} clienteId  para la imagen del QR
 */
export function tarjetaCliente(t, clienteId, urlQr = null) {
  // El marco NO es decoración: es la guía de corte. Mide lo mismo que la
  // tarjeta — 85,6 × 54 mm clavados — porque un rectángulo «un poco más
  // grande» sirve para adivinar por dónde cortar, y una tarjeta recortada
  // torcida no entra en la funda de plástico.
  //
  // Por eso el marco va por fuera y la tarjeta ocupa el 100 % de dentro: así el
  // TAMAÑO FÍSICO lo fija el marco, y no el relleno ni el borde que se le
  // añada a la tarjeta dentro.
  const tarjeta = el('article', { class: 'tarjeta' }, [
    t.empresa.telefono
      ? el('div', { class: 'tarjeta__tel', text: lineaTelefono(t.empresa.telefono) })
      : null,

    el('div', { class: 'tarjeta__izq' }, [
      el('div', { class: 'tarjeta__marca', text: t.empresa.nombre }),
      el('div', { class: 'tarjeta__descriptor', text: t.empresa.descriptor }),
      el('div', { class: 'tarjeta__linea' }),
      el('div', { class: 'tarjeta__nombre', text: t.nombre }),
      t.titular ? el('div', { class: 'tarjeta__titular', text: t.titular }) : null,
      el('div', { class: 'tarjeta__codigo', text: t.codigo }),
    ].filter(Boolean)),

    el('div', { class: 'tarjeta__der' }, [
      // La imagen se pide con `A.imagen()` y no con un `src` normal: un
      // `<img src="/api/…">` no lleva la cabecera de sesión y salía en 401.
      urlQr
        ? el('img', { class: 'tarjeta__qr', src: urlQr, alt: 'Código de la tarjeta' })
        : el('div', { class: 'tarjeta__qr' }),
      el('div', { class: 'tarjeta__pie-qr', text: 'Escanear para entrega' }),
    ]),
  ])

  return el('div', { class: 'tarjeta-marco' }, [tarjeta])
}

/**
 * Las instrucciones de arriba. NO se imprimen: son para quien prepara las
 * tarjetas, no para el plástico.
 */
function instrucciones(t, alRotar) {
  return el('div', { class: 'tarjeta-instrucciones' }, [
    el('h3', { text: 'Instrucciones' }),
    el('ol', {}, [
      el('li', {}, ['El código de este cliente es ', el('code', { text: t.codigo }), '.']),
      el('li', {}, ['Imprimir en papel grueso (85,6 mm × 54 mm) y plastificar.']),
      el('li', {}, [
        'El cliente conserva siempre la misma tarjeta: el QR es ',
        el('b', { text: 'permanente' }),
        ' mientras la tenga encima.',
      ]),
      el('li', {}, [
        'Si se pierde, se rota desde la ficha del cliente: la tarjeta vieja deja ',
        'de servir en el mismo instante y se le imprime una nueva. ',
        alRotar ? el('span', { class: 'tenue', text: '(ya ha sido rotada)' }) : null,
      ].filter(Boolean)),
      el('li', {}, ['El repartidor escanea el QR desde ', el('b', { text: 'Pedidos → Escanear cliente' }), '.']),
    ]),
  ])
}

/**
 * Abre la tarjeta de un cliente, lista para imprimir.
 */
export async function abrirTarjeta(clienteId, cliente = null) {
  const cuerpo = el('div', { class: 'tarjeta-lienzo' }, [cargando('Preparando la tarjeta…')])
  const capa = modal(cliente ? `Tarjeta · ${cliente.name}` : 'Tarjeta de cliente', cuerpo, [
    boton('Cerrar', () => capa.remove()),
    boton('🖨 Imprimir tarjeta', () => window.print(), 'btn btn--principal'),
  ])

  try {
    const [t, urlQr] = await Promise.all([
      A.api(`/customers/${clienteId}/tarjeta`),
      A.imagen(`/customers/${clienteId}/qr.png`),
    ])
    cuerpo.replaceChildren(
      instrucciones(t),
      tarjetaCliente(t, clienteId, urlQr),
    )
  } catch (e) {
    cuerpo.replaceChildren(aviso(e.message, 'error'))
  }
  return capa
}

/**
 * Varias tarjetas en una hoja, para imprimir un lote.
 *
 * Se imprime de N en N: con el ancho de una tarjeta (85,6 mm) caben tres en
 * un A4 horizontal, y quien las prepara quiere la mesa llena, no una a una.
 */
export async function abrirLoteTarjetas(ids, nombres = {}) {
  const cuerpo = el('div', { class: 'tarjeta-lienzo' }, [cargando('Preparando las tarjetas…')])
  const capas = [boton('Cerrar', () => capa.remove())]
  if (ids.length > 1) {
    capas.unshift(boton(`🖨 Imprimir ${ids.length}`, () => window.print(), 'btn btn--principal'))
  }

  const capa = modal(`Tarjetas (${ids.length})`, cuerpo, capas)
  try {
    const documentos = await Promise.all(ids.map(async (id) => {
      const [ficha, urlQr] = await Promise.all([
        A.api(`/customers/${id}/tarjeta`),
        A.imagen(`/customers/${id}/qr.png`),
      ])
      return { ficha, id, urlQr }
    }))
    cuerpo.replaceChildren(
      el('p', { class: 'pista' }, [
        'Cada tarjeta va en su propia tira de papel grueso. Con tres caben en un ',
        'A4 en horizontal, así que se imprime de tres en tres.',
      ]),
      el('div', { class: 'tarjeta-lote' }, documentos.map(({ ficha, id, urlQr }) => {
        // `tarjetaCliente` ya devuelve el marco con la tarjeta dentro; en el
        // lote lo que se separa son los MARCOS, que son los que se recortan.
        const marco = tarjetaCliente(ficha, id, urlQr)
        marco.classList.add('tarjeta--suelta')
        return marco
      })),
    )
  } catch (e) {
    cuerpo.replaceChildren(aviso(e.message, 'error'))
  }
  return capa
}
