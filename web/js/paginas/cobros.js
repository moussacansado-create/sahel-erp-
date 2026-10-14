/**
 * COBRO EN LA PUERTA DEL CLIENTE
 *
 * Lo único que hay aquí, y no hay más:
 *
 *   · el pedido
 *   · lo que hay que cobrar
 *   · el método
 *   · el botón
 *
 * ── POR QUÉ NO HAY UN CAMPO PARA EL IMPORTE ────────────────────────────────
 *
 * Porque la pantalla no es quien sabe la cifra. La sabe el pedido, y el pedido
 * lo sabe la base. Un campo de importe aquí sería una segunda fuente de la
 * verdad, y ya hemos tenido bastante de esas.
 *
 * Y no es una decisión puramente estética: si el campo existe, alguien lo
 * escribe. El repartidor está de pie, con el cliente delante, con el sol en la
 * cara y el teléfono en la otra mano. Ese es exactamente el contexto en el que
 * teclear 1210 en lugar de 210, y en el que nadie mira dos veces el número
 * que ha puesto.
 *
 * ── EL MÉTODO, Y POR QUÉ EL MÓVIL PIDE COMPROBANTE ─────────────────────────
 *
 * Un Orange Money o un móvil es una promesa de pago hasta que alguien mira el
 * comprobante. Por eso el método móvil abre una casilla de referencia y los
 * demás no: escribirla siempre sería un trámite falso, y no escribirla nunca
 * sería una puerta abierta. Que la casilla aparezca sola según el método es la
 * versión honesta de «depende».
 */

import {
  el, boton, aviso, modal, panel,
} from '../ui.js'
import * as A from '../api.js'

/**
 * Abrir el cobro de un pedido.
 *
 * @param {object} pedido  lo que devuelve `resolverQr()`: código, importe y moneda
 * @param {function} alTerminar  se llama con `true` si se cobró
 */
export async function abrirCobro(pedido, alTerminar) {
  const metodos = await A.api('/payments/metodos')

  const sel = el('select', { class: 'input' })
  for (const m of metodos) {
    sel.append(el('option', { value: m.code, text: m.label || m.code }))
  }

  const ref = el('input', {
    class: 'input', type: 'text', placeholder: 'Nº de operación o de transferencia',
  })
  const cajaRef = el('div', { class: 'pila' }, [
    el('label', { class: 'etiqueta', text: 'Comprobante (obligatorio)' }),
    ref,
  ])

  // El método manda sobre el formulario. No se escribe el método a mano y se
  // espera a ver qué pasa: se elige y el formulario se acomoda.
  const alCambiarMetodo = () => {
    const m = metodos.find((x) => x.code === sel.value)
    const haceFalta = m && (m.requires_reference === true
      || m.requires_reference === 'true' || m.requires_reference === 1)
    cajaRef.style.display = haceFalta ? '' : 'none'
  }
  sel.addEventListener('change', alCambiarMetodo)
  alCambiarMetodo()

  const cuerpo = el('div', { class: 'pila' }, [
    el('div', { class: 'ficha-datos' }, [
      el('div', {}, [el('b', { text: pedido.order_code })]),
      el('div', { class: 'pequeno tenue', text: pedido.que_lleva || '' }),
    ]),
    el('div', { class: 'cobro-cifra cobro-cifra--grande' }, [
      el('span', { class: 'cobro-cifra__etiqueta', text: 'Hay que cobrar' }),
      el('span', { class: 'cobro-cifra__valor', text: importe(pedido.pendiente_de_cobro, pedido.moneda) }),
    ]),
    aviso(
      'El importe lo pone el pedido. Si el cliente paga otra cosa, se anota como '
      + 'cobro rechazado y se revisa después; aquí no se ajusta a mano.', ''),
    el('div', { class: 'pila' }, [
      el('label', { class: 'etiqueta', text: 'Cómo paga' }),
      sel,
    ]),
    cajaRef,
  ])

  const capa = modal(`Cobrar ${pedido.order_code}`, cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Cobrar', async () => {
      try {
        await A.api('/payments', {
          metodo: 'POST',
          // OJO: aquí no va `amount`. Ni el valor, ni una constante, ni un
          // `Number(algo)`. El backend lo calcula y, si aparece un importe en
          // este objeto, lo rechaza.
          cuerpo: {
            pedidoId: pedido.order_id,
            metodo: sel.value,
            referencia: ref.value.trim() || null,
          },
        })
        capa.remove()
        await alTerminar?.(true)
      } catch (e) {
        window.alert(e.message)
        await alTerminar?.(false)
      }
    }, 'btn btn--principal'),
  ])
  return capa
}

function importe(v, moneda) {
  const n = Number(v ?? 0)
  const dec = moneda === 'EUR' ? 2 : 0
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  }) + ' ' + (moneda === 'EUR' ? 'EUR' : 'FCFA')
}
