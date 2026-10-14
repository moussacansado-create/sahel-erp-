/**
 * REPARTO
 *
 * La pantalla que abre el repartidor en el móvil, con el cliente delante de la
 * puerta. Tres ideas y ninguna más:
 *
 *   · LO QUE FALTA, arriba. Las entregas ya cerradas están abajo, plegadas.
 *   · UN BOTÓN GRANDE por parada. Va con una mano, con el pie en el escalón.
 *   · LA TARJETA. El repartidor no busca al cliente por su nombre en una lista
 *     de veinte: le enseña la tarjeta y lee lo que pone.
 *
 * ── LO QUE ESTA PANTALLA ES Y LO QUE NO ES ──────────────────────────────
 *
 * La lista la llevan los PEDIDOS pendientes, no los albaranes. Antes se
 * armaba sobre `albaranes`, con lo que para ver el trabajo del día había que
 * haber impreso antes: si el almacén no gastaba tinta, el repartidor no veía
 * una sola parada. El papel se había colado en el centro de la operación.
 *
 * Por eso aquí, en cada parada, hay TRES cosas y ninguna es obligatoria:
 *
 *   1. ENTREGAR POR TARJETA — lo único que registra la entrega. Es la tarjeta
 *      del cliente, no este botón de aquí. Se puede entrar a la tarjeta desde
 *      cualquier sitio, y desde la parada es un atajo.
 *   2. IMPRIMIR EL ALBARÁN — sacar el papel que se lleva y que firma el
 *      cliente. Imprimir no entrega nada.
 *   3. NO PUDE ENTREGAR — anotar el motivo, sin tocar ningún estado.
 *
 * Y lo que NO hay, a propósito, es un botón de «que firme el cliente» ni un
 * «confirmar entrega» que pase por el albarán. La firma del cliente es EN
 * PAPEL, y meterla en la aplicación no la convertía en digital: solo obligaba
 * al repartidor a abrir el pedido delante de la puerta con el cliente
 * esperando. Eran dos caminos para cerrar lo mismo, y por eso se descuadraban.
 */

import {
  el, panel, tabla, boton, estado, vacio, cargando, aviso, modal, campo,
} from '../ui.js'
import * as A from '../api.js'
import { abrirEscaner } from '../escaner.js'
import { abrirAlbaran } from './albaranes.js'
import { abrirCobro } from './cobros.js'

export async function paginaReparto(ctx) {
  const caja = el('div', { class: 'pila' })
  const contVivos = el('div')
  const contHechos = el('div')
  let reqTodas = false

  async function recargar() {
    contVivos.replaceChildren(cargando('Cargando la ruta…'))
    const sufijo = reqTodas ? '?todas=1' : ''
    const [ruta, resumen] = await Promise.all([
      A.api(`/reparto${sufijo}`),
      A.api(`/reparto/resumen${sufijo}`),
    ])
    // `?todas=1` añade las ya entregadas, para consultar el histórico de un día.
    // El estado que manda es el del PEDIDO. El del albarán es un dato del
    // papel, y no decide si esto está pendiente.
    const [abiertas, cerradas] = reqTodas
      ? [ruta.filter((f) => f.pedido_estado !== 'DELIVERED'),
         ruta.filter((f) => f.pedido_estado === 'DELIVERED')]
      : [ruta, []]

    contVivos.replaceChildren(panel(
      'Paradas de hoy',
      [
        boton(reqTodas ? 'Solo lo pendiente' : 'Ver también lo entregado',
          () => { reqTodas = !reqTodas; recargar() }, 'btn btn--mini'),
      ],
      el('div', { class: 'panel__cuerpo pila' }, [
        el('div', { class: 'ficha-cifras' }, [
          cifra('Paradas', resumen.total),
          cifra('En el camión', resumen.en_camion),
          cifra('A medias', resumen.por_cerrar),
          cifra('Con el cliente fuera', resumen.intentos_fallidos),
        ]),
        abiertas.length
          ? paradas(abiertas, { recargar })
          : vacio('No hay nada que repartir hoy.', '🚚'),
      ])))

    contHechos.replaceChildren(panel('Ya entregadas', [],
      cerradas.length
        ? el('details', { class: 'historial' }, [
          el('summary', { text: `Ver las entregadas (${cerradas.length})` }),
          paradas(cerradas, { recargar }),
        ])
        : vacio('Todavía no se ha entregado nada.')))
  }

  caja.append(el('p', { class: 'pista' }, [
    'Aquí están los pedidos pendientes de entregar. De cada parada puedes sacar el ',
    'albarán para que el cliente lo firme en papel —eso no registra nada— y ',
    'confirmar la entrega con la TARJETA del cliente, que es lo único que la ',
    'registra. El albarán es el papel del viaje, no un cuadrante de confirmación.',
  ]))
  caja.append(contVivos, el('div', { style: 'height:18px' }), contHechos)
  await recargar()
  return caja
}

function cifra(t, n) {
  return el('div', { class: 'cifra' }, [
    el('div', { class: 'cifra__n', text: String(n) }),
    el('div', { class: 'cifra__t', text: t }),
  ])
}

/** Una parada. En el móvil es una ficha; en el escritorio, una fila. */
function paradas(lista, { recargar }) {
  const cuerpo = el('tbody')
  for (const f of lista) {
    const e = ESTADO[f.pedido_estado] || { texto: f.pedido_estado, tono: '' }
    cuerpo.append(el('tr', { class: 'fila-pulsable' }, [
      el('td', {}, [
        el('b', { text: f.cliente_name }),
        f.company_name && f.company_name !== f.cliente_name
          ? el('div', { class: 'pequeno tenue', text: f.company_name }) : null,
        f.address ? el('div', { class: 'pequeno', text: f.address }) : null,
        Number(f.intentos_fallidos) > 0
          ? el('div', { class: 'pequeno', style: 'color:#b00',
            text: `Ya se llamó ${f.intentos_fallidos}× sin éxito: ${f.ultimo_motivo || ''}` })
          : null,
      ].filter(Boolean)),
      el('td', { class: 'pequeno col-fecha' }, [
        el('code', { text: f.pedido_code }),
        el('div', { class: 'tenue', text: `${f.unidades_pendientes} uds por servir` }),
        f.zona ? el('div', { class: 'tenue', text: f.zona }) : null,
      ].filter(Boolean)),
      el('td', {}, [estado(e.texto, e.tono)]),
      el('td', { class: 'pequeno tenue' }, [
        // El albarán es un dato del PAPEL. Puede no haberlo, y la parada sigue
        // ahí: se puede repartir sin haber impreso nada.
        f.albaran_code
          ? el('div', {}, [el('code', { text: f.albaran_code }),
            el('div', { class: 'tenue', text: PAPEL[f.albaran_status] || f.albaran_status })])
          : el('span', { class: 'tenue', text: 'sin albarán impreso' }),
      ]),
      el('td', { class: 'centro' }, [
        f.pedido_estado === 'DELIVERED'
          ? el('span', { class: 'estado estado--bien', text: 'Entregado ✓' })
          : boton('Abrir', () => abrirParada(f, recargar), 'btn btn--mini'),
      ]),
    ].filter(Boolean)))
  }
  return tabla(['Cliente', 'Pedido', 'Estado', 'Albarán', ''], cuerpo)
}

// El estado del PEDIDO manda. El del albarán es un dato del papel.
const ESTADO = {
  DRAFT: { texto: 'Borrador', tono: '' },
  CONFIRMED: { texto: 'Confirmado', tono: '' },
  RESERVED: { texto: 'Apartado', tono: '' },
  PREPARED: { texto: 'Preparado', tono: 'aviso' },
  IN_ROUTE: { texto: 'A medias', tono: 'aviso' },
  DELIVERED: { texto: 'Entregado', tono: 'bien' },
  CANCELLED: { texto: 'Anulado', tono: 'peligro' },
}

// Lo que está pasando con el PAPEL..Info, no una puerta de confirmación.
const PAPEL = {
  DRAFT: 'sin imprimir',
  PRINTED: 'en el camión',
  SIGNED: 'firmado en papel',
  DELIVERED: 'entregado',
  VOID: 'anulado',
}

/**
 * UNA PARADA ABIERTA.
 *
 * Tres botones, y ninguno es un paso obligatorio para los otros dos:
 *
 *   · ENTREGAR CON LA TARJETA — abre el escáner con este cliente. Es la entrega
 *     de verdad: aquí se registra quién, cuándo y por qué vía.
 *   · IMPRIMIR EL ALBARÁN — saca el papel del viaje. Si no hay albarán, lo crea.
 *     Imprimir NO registra la entrega, ni antes ni después.
 *   · NO PUDE ENTREGAR — anota el motivo y no cambia absolutamente nada.
 *
 * NO hay «que firme el cliente» ni «confirmar entrega». La firma es en papel y
 * se queda en papel; meterla en la aplicación obligaba al repartidor a
 *abrir el pedido delante del cliente, y dejaba dos caminos para
 * cerrar la misma entrega.
 */
async function abrirParada(f, recargar) {
  const cuerpo = el('div', { class: 'pila' }, [
    el('h3', { text: f.cliente_name }),
    f.company_name && f.company_name !== f.cliente_name
      ? el('p', { class: 'pista', text: f.company_name }) : null,
    f.address ? el('p', { class: 'pista', text: f.address }) : null,
    f.phone ? el('p', { class: 'pista', text: `Tel. ${f.phone}` }) : null,
    el('div', { class: 'ficha-datos' }, [
      el('div', {}, [el('b', { text: f.pedido_code })]),
      el('div', { class: 'pequeno', text: `${f.unidades_pendientes} uds por servir en ${f.lineas_pendientes} línea(s)` }),
      f.albaran_code
        ? el('div', { class: 'pequeno tenue', text: `Albarán ${f.albaran_code} · ${PAPEL[f.albaran_status] || f.albaran_status}` })
        : el('div', { class: 'pequeno tenue', text: 'Todavía sin albarán impreso' }),
    ]),
    Number(f.intentos_fallidos) > 0
      ? aviso(`Ya se intentó ${f.intentos_fallidos} vez(es) sin éxito. Último motivo: ${f.ultimo_motivo}`, 'aviso')
      : null,
  ].filter(Boolean))

  const capas = [boton('Cerrar', () => capa.remove())]

  // 1 · EL DE VERDAD. La tarjeta del cliente.
  capas.unshift(boton('✓ Entregar con la tarjeta', () => {
    capa.remove()
    abrirEscaner({
      alEntregar: async (orderId, orderCode, clienteId) => {
        try {
          await A.api(`/reparto/pedido/${orderId}/entregar`, {
            metodo: 'POST', cuerpo: { clienteId: clienteId || f.cliente_id },
          })
          await recargar()
          window.alert(`${orderCode} entregado.`)
          return true
        } catch (e) { window.alert(e.message); return false }
      },
    })
  }, 'btn btn--principal'))

  // 1b · COBRAR. Antes que el papel, porque es lo que el cliente viene a hacer.
  //
  // Abre el MISMO escáner y contra la MISMA tarjeta, con los mismos datos que
  // salen de `resolverQr()`. Cobrar y entregar son dos hechos distintos y van
  // en dos botones: se puede cobrar y no poder entregar —el cliente no está—
  // y se puede entregar sin cobrar, que es una entrega a crédito.
  capas.unshift(boton('💶 Cobrar', () => {
    capa.remove()
    abrirEscaner({
      alCobrar: async (orderId, orderCode, clienteId, pedido) => {
        const ok = await abrirCobro(pedido, async (cobrado) => {
          if (cobrado) { await recargar(); window.alert(`Cobrado ${orderCode}.`) }
        })
        return !!ok
      },
    })
  }, 'btn'))

  // 2 · EL PAPEL. Imprimir no registra nada.
  capas.push(boton('🖨 Albarán para el cliente', async () => {
    try {
      const a = f.albaran_id
        ? { id: f.albaran_id }
        : await A.api('/albaranes', {
          metodo: 'POST', cuerpo: { pedidoId: f.pedido_id, copies: 2 },
        })
      capa.remove()
      await abrirAlbaran(a.id, { recargar })
    } catch (e) { window.alert(e.message) }
  }, 'btn'))

  // 3 · NO PUDE ENTREGAR. No cambia nada.
  capas.push(boton('No pude entregar', () => { capa.remove(); fallar(f, recargar) },
    'btn btn--peligro'))

  const capa = modal(`Parada · ${f.cliente_name}`, cuerpo, capas)
  return capa
}

/**
 * «No he podido entregar».
 *
 * NO cambia el estado del albarán. Se queda impreso y sin firmar, para el día
 * siguiente, y solo se anota el porqué. Si esto marcara la entrega como
 * hecha, un cliente que no estaba habría recibido la mercancía en el sistema
 * sin haberla recibido en la realidad.
 */
function fallar(f, recargar) {
  const motivo = el('textarea', { rows: 3, placeholder: 'El cliente no estaba, el local estaba cerrado…' })
  return modal('No pude entregar', el('div', { class: 'pila' }, [
    aviso(
      `El albarán ${f.albaran_code} se queda como está, pendiente para el `
      + 'próximo día. La mercancía no vuelve al almacén ni se descuenta: solo se '
      + 'anota el motivo.', 'aviso'),
    campo('Motivo (obligatorio)', motivo, true),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Anotar', async () => {
      if (motivo.value.trim().length < 3) { window.alert('Hay que decir por qué.'); return }
      try {
        await A.api(`/reparto/pedido/${f.pedido_id}/no-entregado`, {
          metodo: 'POST', cuerpo: { motivo: motivo.value.trim() },
        })
        capa.remove()
        await recargar()
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
}
