import {
  el, panel, aviso, num, entero, vacio, estado, campo, protegido, fecha, fechaHora, tabla,
  historico, boton,
} from '../ui.js'
import * as A from '../api.js'

const MODULO = { RAW_MATERIAL: 'raw_materials', PACKAGING: 'packaging', FINISHED_GOOD: 'products' }

/**
 * Stock: existencias, ajustes y reservas.
 *
 * Aquí se ve de un vistazo por qué el sistema tiene tres números y no uno:
 * físico, apartado y disponible. Confundirlos era exactamente el bug que
 * hacía imposible cuadrar la aplicación antigua.
 */
export async function paginaStock() {
  const caja = el('div')
  // /inventory devuelve una fila por artículo CON su nombre, su SKU, su mínimo y
  // sus precios. No hace falta cruzarlo con /items: una sola consulta, una sola
  // fuente, y ninguna posibilidad de que las dos digan cosas distintas.
  const stock = await A.api('/inventory')
  const puedeAjustar = A.puede('inventory', 'edit')

  const soloConStock = el('input', { type: 'search', placeholder: 'Filtrar por nombre o SKU…', style: 'max-width:280px' })
  const soloVacias = el('input', { type: 'checkbox', id: 'solo-con-stock' })
  const etiquetaVacias = el('label', { class: 'pequeno', style: 'display:flex;align-items:center;gap:6px;cursor:pointer' }, [
    soloVacias, el('span', { text: 'Solo con existencias' }),
  ])

  const cuerpo = el('div')

  async function pintar() {
    const q = soloConStock.value.trim().toLowerCase()
    const filas = stock
      .filter((i) => !q || String(i.name).toLowerCase().includes(q) || String(i.sku).toLowerCase().includes(q))
      .filter((i) => !soloVacias.checked || Number(i.qty_on_hand || 0) > 0)

    cuerpo.replaceChildren(filas.length
      ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Artículo' }), el('th', { text: 'Tipo' }),
            el('th', { class: 'num', text: 'Físico' }),
            el('th', { class: 'num', text: 'Apartado' }),
            el('th', { class: 'num', text: 'Disponible' }),
            el('th', { class: 'num', text: 'Mínimo' }),
            el('th', { text: 'Situación' }),
            el('th', { class: 'centro', text: '' }),
          ])]),
          el('tbody', {}, filas.map((i) => fila(i, { puedeAjustar, recargar: pintar }))),
        ])])
      : vacio('Ningún artículo coincide', '🔍'))
  }

  soloConStock.addEventListener('input', () => setTimeout(pintar, 200))
  soloVacias.addEventListener('change', pintar)
  await pintar()

  caja.append(panel(`Stock (${stock.length} artículos)`, [soloConStock, etiquetaVacias], cuerpo, true))

    // ── Apartado: lo que está vivo y lo que ya no ─────────────────────────
    //
    // Antes esta lista traía TODO: apartados, liberados y consumidos en la
    // misma tabla. Un apartado liberado seguía delante del operario como si
    // estuviera pendiente. Ahora la lista de trabajo trae solo lo vivo, y lo
    // hecho se guarda abajo, con su cuenta, sin perderse.
    if (A.puede('inventory', 'view')) {
      const [vivas, todas] = await Promise.all([
        A.api('/inventory/reservas?vivas=1'),
        A.api('/inventory/reservas'),
      ])
      caja.append(panel(
        `Apartado (${vivas.length} pendiente${vivas.length === 1 ? '' : 's'})`, null,
        vivas.length
          ? tablaApartado(vivas, { puedeEditar: A.puede('inventory', 'edit'), recargar: pintar })
          : vacio('Nada apartado. No hay nada comprometido a nadie.', '✓'),
        true))
      if (todas.length > vivas.length) {
        caja.append(historico(
          'Apartado ya liberado o entregado',
          todas.length - vivas.length,
          tablaApartado(todas.filter((r) => !vivas.some((v) => v.id === r.id)),
            { puedeEditar: false, recargar: pintar })))
      }
    }

  caja.append(el('p', { class: 'pista' },
    'Físico = lo que hay en el almacén. Apartado = comprometido a alguien, sigue estando en el almacén. Disponible = físico − apartado. Solo lo disponible se puede gastar.'))

  return caja
}

function fila(s, { puedeAjustar, recargar }) {
  const item = { id: s.item_id, name: s.name, sku: s.sku, category_kind: s.category_kind }
  const fisico = Number(s.qty_on_hand || 0)
  const apartado = Number(s.qty_reserved || 0)
  const disponible = Number(s.qty_available || 0)
  const minimo = Number(s.min_stock || 0)
  const pendiente = ['qty_quarantined', 'qty_blocked', 'qty_retired']
    .filter((k) => Number(s[k] || 0) > 0).length

  let situacion
  if (disponible <= 0 && fisico <= 0) situacion = estado('Agotado', 'peligro')
  else if (pendiente) situacion = estado(`${pendiente} lote(s) apartado(s)`, 'aviso')
  else if (disponible <= 0) situacion = estado('Todo apartado', 'aviso')
  else if (disponible < minimo) situacion = estado('Bajo mínimo', 'peligro')
  else if (apartado > 0) situacion = estado(`Apartado ${num(apartado)}`, 'aviso')
  else situacion = estado('Correcto', 'bien')

  return el('tr', {}, [
    el('td', {}, [el('div', { text: item.name }), el('div', { class: 'mono tenue', text: item.sku })]),
    el('td', { class: 'pequeno' }, [estado(KIND[item.category_kind] || item.category_kind, TONO[item.category_kind] || '')]),
    el('td', { class: 'num' }, [num(fisico)]),
    el('td', { class: 'num' }, [apartado ? el('span', { class: 'estado estado--aviso', text: num(apartado) }) : el('span', { class: 'tenue', text: '0,00' })]),
    el('td', { class: 'num' }, [el('b', { text: num(disponible) })]),
    el('td', { class: 'num tenue' }, [num(minimo, 0)]),
    el('td', {}, [situacion]),
    el('td', { class: 'centro' }, [puedeAjustar && disponible !== 0
      ? boton('Ajustar', () => dialogoAjuste(item, recargar), 'btn btn--mini') : null]),
  ])
}

function dialogoAjuste(item, recargar) {
  const cantidad = el('input', { type: 'number', step: 'any', placeholder: '+10 o -20' })
  const motivo = el('input', { placeholder: 'Motivo obligatorio (recuento, merma…)' })
  const avisoError = el('p', { class: 'alerta alerta--error oculto' })
  const prevision = el('p', { class: 'pista' })

  async function actualizarPrevision() {
    const n = Number(cantidad.value)
    if (!Number.isFinite(n) || n === 0) { prevision.textContent = ''; return }
    try {
      const p = await A.api(`/inventory/${item.id}/plan?cantidad=${Math.abs(n)}`)
      const texto = p.plan?.length
        ? `Se tocaría: ${p.plan.map((x) => `${x.code} (${num(x.qty, 0)})`).join(', ')}`
        : 'No hay lotes utilizables para esa cantidad.'
      prevision.textContent = texto + (p.suficiente ? '' : ` — FALTAN ${num(p.faltante)}`)
    } catch { prevision.textContent = '' }
  }
  cantidad.addEventListener('input', actualizarPrevision)

  const capa = el('div', { class: 'capa' }, [el('div', { class: 'capa__dialogo panel', style: 'max-width:460px' }, [
    el('div', { class: 'panel__cabecera' }, [el('h2', { text: `Ajuste de stock · ${item.sku}` })]),
    el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'rejilla' }, [campo('Cantidad (+ o −)', cantidad), campo('Motivo', motivo)]),
      prevision,
      avisoError,
      el('p', { class: 'pista' }, ['Un ajuste se reparte entre los lotes por orden de caducidad (FEFO) y deja un movimiento por lote.']),
    ]),
    el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' }, [
      boton('Cancelar', () => capa.remove()),
      boton('Aplicar', protegido(async () => {
        avisoError.classList.add('oculto')
        try {
          const r = await A.api('/inventory/ajustes', {
            metodo: 'POST',
            cuerpo: { itemId: item.id, cantidad: Number(cantidad.value), motivo: motivo.value.trim() },
          })
          aviso(r.mensaje)
          capa.remove(); recargar()
        } catch (e) { avisoError.textContent = e.message; avisoError.classList.remove('oculto') }
      }), 'btn btn--principal'),
    ]),
  ])])
  document.body.append(capa)
  cantidad.focus()
}

const KIND = { RAW_MATERIAL: 'Materia prima', PACKAGING: 'Envase', FINISHED_GOOD: 'Producto' }
const TONO = { RAW_MATERIAL: 'marca', PACKAGING: 'aviso', FINISHED_GOOD: 'bien' }

/** Tabla de apartados. La usan el panel de pendientes y el de histórico. */
function tablaApartado(reservas, { puedeEditar, recargar }) {
  const cuerpo = el('tbody')
  for (const r of reservas) {
    cuerpo.append(el('tr', {}, [
      el('td', { class: 'pequeno tenue', text: fechaHora(r.created_at) }),
      el('td', {}, [
        el('div', { text: r.item_name }),
        el('div', { class: 'mono tenue', text: r.sku }),
      ]),
      el('td', {}, [estado(
        r.es_retencion_interna ? (r.hold_type || 'INTERNA') : (r.order_code || 'PEDIDO'),
        r.es_retencion_interna ? 'marca' : '',
      )]),
      el('td', {
        class: 'pequeno',
        text: r.hold_reason || (r.es_retencion_interna ? '—' : 'Reserva de pedido'),
      }),
      el('td', { class: 'num', text: num(r.qty) }),
      el('td', {}, [estado(r.status, r.status === 'ACTIVE' ? 'aviso' : 'bien')]),
      el('td', { class: 'centro' }, [
        (r.status === 'ACTIVE' && puedeEditar)
          ? boton('Liberar', protegido(async () => {
              const motivo = prompt('¿Por qué se libera?', 'Anulado')
              if (motivo === null) return
              const x = await A.api(`/inventory/reservas/${r.id}/liberar`, {
                metodo: 'POST', cuerpo: { motivo },
              })
              aviso(x.mensaje)
              await recargar()
            }), 'btn btn--mini')
          : null,
      ]),
    ]))
  }
  return tabla(['Fecha', 'Artículo', 'Tipo', 'Motivo', 'Cantidad', 'Estado', ''], cuerpo)
}
