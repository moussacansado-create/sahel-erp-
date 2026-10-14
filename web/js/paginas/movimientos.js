import { el, panel, vacio, num, estado, fechaHora } from '../ui.js'
import * as A from '../api.js'

/**
 * Movimientos: el libro mayor, tal cual.
 *
 * Esta pantalla no calcula nada. Cada fila es una fila de `stock_movements`, y
 * el saldo que muestra es el que dejó esa operación en su lote. Si algo no
 * cuadra, la culpa es de una operación concreta, y aquí se ve cuál.
 */
export async function paginaMovimientos() {
  const caja = el('div')
  const [items, movimientos] = await Promise.all([
    A.api('/items'),
    A.api('/inventory/movimientos?limite=300'),
  ])

  const fItem = el('select', {}, [el('option', { value: '', text: 'Todos los artículos' }),
    ...items.map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}` }))])
  const fTipo = el('select', {}, [el('option', { value: '', text: 'Todos los tipos' }),
    ...[...new Set(movimientos.map((m) => m.movement_type))].map((t) =>
      el('option', { value: t, text: NOMBRE[t] || t }))])
  const fLote = el('input', { type: 'search', placeholder: 'Código de lote…', style: 'max-width:220px' })
  const resumen = el('p', { class: 'pista' })

  const cuerpo = el('div')

  function pintar() {
    const qLote = fLote.value.trim().toLowerCase()
    const filas = movimientos.filter((m) =>
      (!fItem.value || m.item_id === Number(fItem.value)) &&
      (!fTipo.value || m.movement_type === fTipo.value) &&
      (!qLote || m.lot_code.toLowerCase().includes(qLote)))

    resumen.textContent = `${filas.length} movimiento(s). Se muestran los más recientes; el saldo es el de cada lote después de esa operación.`
    cuerpo.replaceChildren(filas.length
      ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Fecha' }), el('th', { text: 'Tipo' }), el('th', { text: 'Lote' }),
            el('th', { text: 'Artículo' }), el('th', { class: 'num', text: 'Cantidad' }),
            el('th', { class: 'num', text: 'Saldo del lote' }),
            el('th', { text: 'Motivo' }), el('th', { text: 'Quién' }),
          ])]),
          el('tbody', {}, filas.map((m) => el('tr', {}, [
            el('td', { class: 'pequeno tenue', text: fechaHora(m.occurred_at) }),
            el('td', {}, [estado(NOMBRE[m.movement_type] || m.movement_type, TONO[m.movement_type] || '')]),
            el('td', { class: 'mono', text: m.lot_code }),
            el('td', {}, [el('div', { class: 'pequeno', text: m.item_name }), el('div', { class: 'mono tenue', text: m.sku })]),
            el('td', { class: 'num' }, [
              el('span', { class: `mono ${Number(m.qty) < 0 ? 'estado--peligro' : 'estado--bien'}`, text: (Number(m.qty) > 0 ? '+' : '') + num(m.qty) }),
            ]),
            el('td', { class: 'num tenue' }, [num(m.balance_after)]),
            el('td', { class: 'pequeno tenue', text: m.reason || '—' }),
            el('td', { class: 'pequeno', text: m.user_name || '—' }),
          ]))),
        ])])
      : vacio('Ningún movimiento con esos filtros', '🔍'))
  }

  fItem.addEventListener('change', pintar)
  fTipo.addEventListener('change', pintar)
  fLote.addEventListener('input', () => setTimeout(pintar, 200))

  caja.append(panel('Libro mayor de stock', [fItem, fTipo, fLote], [cuerpo, resumen], true))
  caja.append(el('p', { class: 'pista' },
    'Ni el artículo ni el lote guardan «stock»: lo guardan estos movimientos y el saldo que deja cada uno. Si una cifra no cuadra, este es el sitio donde se ve por qué.'))

  pintar()
  return caja
}

const NOMBRE = {
  RECEPTION: 'Entrada', PURCHASE_RECEPTION: 'Entrada (compra)',
  ADJUSTMENT_IN: 'Ajuste +', ADJUSTMENT_OUT: 'Ajuste −',
  PRODUCTION_OUTPUT: 'Producción', PRODUCTION_CONSUMPTION: 'Consumo (producción)', WASTE: 'Merma', DELIVERY_REVERSAL: 'Devolución de entrega',
  DELIVERY: 'Entrega', RETURN: 'Devolución', SCRAP: 'Merma',
}
const TONO = {
  RECEPTION: 'bien', PURCHASE_RECEPTION: 'bien', ADJUSTMENT_IN: 'marca',
  ADJUSTMENT_OUT: 'aviso', PRODUCTION_OUTPUT: 'marca', CONSUMPTION: 'aviso',
  DELIVERY: 'aviso', RETURN: 'marca', SCRAP: 'peligro',
}
