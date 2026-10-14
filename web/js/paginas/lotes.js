import { el, panel, num, vacio, estado, fecha, fechaHora, campo } from '../ui.js'
import * as A from '../api.js'

const LOT = { RAW_MATERIAL: 'Materia prima', PACKAGING: 'Envase', FINISHED_GOOD: 'Producto terminado' }
const ORIGEN = {
  MANUAL_RECEPTION: 'Recepción manual', PURCHASE: 'Compra',
  PRODUCTION: 'Producción', RETURN: 'Devolución',
}
const ESTADOS = {
  ACTIVE: ['Activo', 'bien'], QUARANTINE: ['En cuarentena', 'aviso'],
  BLOCKED: ['Bloqueado', 'peligro'], RETIRED: ['Retirado', ''], EXPIRED: ['Caducado', 'peligro'],
}

/**
 * Lotes.
 *
 * La lista de TODOS los lotes del sistema, con su origen y su saldo. Esta es la
 * pantalla donde se comprueba que hay un solo sistema de lotes: si un lote no
 * sale de aquí, es que no existe, lo haya creado quien lo haya creado.
 */
export async function paginaLotes({ params = [] } = {}) {
  const caja = el('div')
  const [items, movimientos] = await Promise.all([
    A.api('/items?activos=true'),
    A.api('/inventory/movimientos?limite=500'),
  ])
  const porId = new Map(items.map((i) => [i.id, i]))

  const buscador = el('input', { type: 'search', placeholder: 'Buscar por código de lote…', style: 'max-width:260px' })
  const filtroOrigen = el('select', {}, [el('option', { value: '', text: 'Todo origen' }),
    ...Object.entries(ORIGEN).map(([k, v]) => el('option', { value: k, text: v }))])
  const cuerpo = el('div')

  async function pintar() {
    const q = buscador.value.trim().toLowerCase()
    const o = filtroOrigen.value
    const visibles = movimientos.filter((m) => {
      if (o && m.origin_type !== o) return false
      if (!q) return true
      return m.lot_code.toLowerCase().includes(q)
        || String(m.sku).toLowerCase().includes(q)
        || String(m.item_name).toLowerCase().includes(q)
    })
    // Un lote, una fila: el movimiento más reciente es el que deja el saldo.
    const unicos = [...new Map(visibles.map((m) => [m.lot_id, m])).values()]

    cuerpo.replaceChildren(unicos.length
      ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Lote' }), el('th', { text: 'Artículo' }), el('th', { text: 'Origen' }),
            el('th', { class: 'num', text: 'Saldo' }), el('th', { text: 'Caducidad' }),
            el('th', { text: 'Estado' }), el('th', { class: 'centro', text: '' }),
          ])]),
          el('tbody', {}, unicos.map((m) => {
            const item = porId.get(m.item_id) || {}
            const saldo = Number(m.balance_after)
            const est = ESTADOS[m.status] || [m.status, '']
            return el('tr', {}, [
              el('td', { class: 'mono', text: m.lot_code }),
              el('td', {}, [
                el('div', { text: m.item_name }),
                el('div', { class: 'pequeno tenue' }, [
                  el('span', { class: 'mono', text: m.sku }),
                  el('span', { text: ' · ' + (LOT[item.category_kind] || '') }),
                ]),
              ]),
              el('td', { class: 'pequeno' }, [estado(ORIGEN[m.origin_type] || m.origin_type || '—',
                m.origin_type === 'PRODUCTION' ? 'marca' : '')]),
              el('td', { class: 'num' }, [saldo > 0 ? num(saldo) : el('span', { class: 'tenue', text: 'agotado' })]),
              el('td', { class: 'pequeno tenue', text: m.expiry_date ? fecha(m.expiry_date) : '—' }),
              el('td', {}, [estado(est[0], est[1])]),
              el('td', { class: 'centro' }, [boton('Trazabilidad', () => verLote(m.lot_id), 'btn btn--mini')]),
            ])
          })),
        ])])
      : vacio('Ningún lote con esos criterios', '📦'))
  }

  buscador.addEventListener('input', () => setTimeout(pintar, 250))
  filtroOrigen.addEventListener('change', pintar)
  caja.append(panel(`Lotes (${new Set(movimientos.map((m) => m.lot_id)).size})`, [buscador, filtroOrigen], cuerpo, true))
  await pintar()

  if (params[0]) await verLote(params[0])
  return caja
}

/**
 * Trazabilidad de un lote, en las dos direcciones.
 *
 * Hacia delante: de qué lotes de materia prima se fabricó.
 * Hacia atrás: en qué entregas ha salido.
 */
export async function verLote(lotId) {
  const capa = el('div', { class: 'capa' })
  document.body.append(capa)
  const caja = el('div', { class: 'capa__dialogo panel' })
  capa.append(caja)
  caja.replaceChildren(el('div', { class: 'panel__cuerpo' }, [el('div', { class: 'cargando', text: 'Leyendo la trazabilidad…' })]))

  try {
    const [lote, movs, haciaAdelante, haciaAtras] = await Promise.all([
      A.api(`/lots/${lotId}`),
      A.api(`/lots/${lotId}/movimientos`),
      A.api(`/trazabilidad/lote/${lotId}/adelante`).catch(() => []),
      A.api(`/trazabilidad/lote/${lotId}/atras`).catch(() => []),
    ])
    const est = ESTADOS[lote.status] || [lote.status, '']
    const listaMovs = Array.isArray(movs?.movimientos) ? movs.movimientos : []
    const adiante = Array.isArray(haciaAdelante) ? haciaAdelante : []
    const atras = Array.isArray(haciaAtras) ? haciaAtras : []

    caja.replaceChildren(
      el('div', { class: 'panel__cabecera' }, [
        el('div', {}, [
          el('h2', { class: 'mono', text: lote.code }),
          el('div', { class: 'pila', style: 'margin-top:4px' }, [
            estado(est[0], est[1]),
            el('span', { class: 'pequeno tenue', text: ORIGEN[lote.origin_type] || lote.origin_type || '' }),
          ]),
        ]),
        boton('Cerrar', () => capa.remove()),
      ]),
      el('div', { class: 'panel__cuerpo' }, [
        el('div', { class: 'rejilla rejilla--3' }, [
          campo('Artículo', `${lote.item_name} (${lote.sku})`),
          campo('Cantidad inicial', num(lote.initial_qty)),
          campo('Disponible ahora', num(lote.qty_available)),
          campo('Ya consumida', num(lote.qty_consumed)),
          campo('Recibido', fechaHora(lote.received_at)),
          campo('Caduca', lote.expiry_date ? fecha(lote.expiry_date) : 'sin caducidad'),
        ]),

        el('div', { class: 'separador' }),
        el('h3', { class: 'pequeno tenue' }, ['De dónde viene']),
        adiante.length
          ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Lote de origen' }), el('th', { text: 'Materia prima' }),
                el('th', { text: 'Producción' }), el('th', { class: 'num', text: 'Consumido' }),
              ])]),
              el('tbody', {}, adiante.map((f) => el('tr', {}, [
                el('td', { class: 'mono', text: f.source_lot_code }),
                el('td', {}, [el('div', { text: f.source_name }), el('div', { class: 'mono tenue', text: f.source_sku })]),
                el('td', { class: 'mono', text: f.production_code }),
                el('td', { class: 'num', text: num(f.qty_consumed, 4) }),
              ]))),
            ])])
          : el('p', { class: 'pista' },
              lote.origin_type === 'PRODUCTION'
                ? 'Este lote se fabricó, pero no consta qué lotes de materia prima se consumieron.'
                : 'Este lote no se fabricó: es una recepción de mercancía.'),

        el('div', { class: 'separador' }),
        el('h3', { class: 'pequeno tenue' }, ['A dónde ha ido']),
        atras.length
          ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Entrega' }), el('th', { text: 'Pedido' }),
                el('th', { text: 'Cliente' }), el('th', { class: 'num', text: 'Entregado' }),
                el('th', { text: 'Fecha' }),
              ])]),
              el('tbody', {}, atras.map((f) => el('tr', {}, [
                el('td', { class: 'mono', text: f.delivery_code || '—' }),
                el('td', { class: 'mono', text: f.order_code || '—' }),
                el('td', { text: f.customer_name || '—' }),
                el('td', { class: 'num', text: num(f.qty_delivered, 0) }),
                el('td', { class: 'pequeno tenue', text: fechaHora(f.delivered_at) }),
              ]))),
            ])])
          : el('p', { class: 'pista' }, 'Este lote todavía no ha salido en ninguna entrega. (Las entregas llegan en la Fase 5.)'),

        el('div', { class: 'separador' }),
        el('h3', { class: 'pequeno tenue' }, ['Movimientos del lote']),
        el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Fecha' }), el('th', { text: 'Tipo' }),
            el('th', { class: 'num', text: 'Cantidad' }), el('th', { class: 'num', text: 'Saldo' }),
            el('th', { text: 'Motivo' }),
          ])]),
          el('tbody', {}, listaMovs.map((m) => el('tr', {}, [
            el('td', { class: 'pequeno tenue', text: fechaHora(m.occurred_at) }),
            el('td', { class: 'pequeno', text: m.movement_type }),
            el('td', { class: 'num' }, [num(m.qty, 0)]),
            el('td', { class: 'num tenue' }, [num(m.balance_after)]),
            el('td', { class: 'pequeno tenue', text: m.reason || '—' }),
          ]))),
        ])]),
      ]),
    )
  } catch (e) {
    caja.replaceChildren(el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'alerta alerta--error', text: e.message }),
      el('div', { class: 'pila pila--fin', style: 'margin-top:12px' }, [boton('Cerrar', () => capa.remove())]),
    ]))
  }
  capa.addEventListener('click', (ev) => { if (ev.target === capa) capa.remove() })
}

function boton(t, onclick, clase = 'btn') { return el('button', { class: clase, text: t, onclick }) }
