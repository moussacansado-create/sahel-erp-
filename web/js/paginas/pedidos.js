import {
  el, panel, aviso, num, vacio, estado, campo, fecha, cargando, tabla, pintarFilas, modal, boton,
  historico, buscador,
} from '../ui.js'
import * as A from '../api.js'
import { estadoPedido } from './clientes.js'
import { abrirEscaner } from '../escaner.js'
import { abrirAlbaran } from './albaranes.js'

/**
 * Pedidos.
 *
 * Aquí se ve la regla del sistema entera, y se enseña con los números delante:
 *
 *   CONFIRMAR → aparta. El stock NO baja.
 *   PREPARAR → el pedido va al almacén, tampoco baja.
 *   ENTREGAR  → el stock baja. UNA sola vez.
 *   ANULAR    → se libera lo apartado. El stock no se "devuelve", porque no se movió.
 *
 * Por eso el botón de confirmar está preceded del plan: se ve de qué lotes
 * saldría antes de comprometerlos. Igual que antes de fabricar.
 */

export async function paginaPedidos() {
  const puedeCrear = A.puede('sales', 'create')
  const puedeGestionar = A.puede('sales', 'edit')
  const puedeAnular = A.puede('sales', 'approve')
  const caja = el('div', { class: 'pila' })
  const zona = el('div')
  const filtro = el('select', {}, [
    el('option', { value: '', text: 'Todos los estados' }),
    ...['DRAFT', 'RESERVED', 'PREPARED', 'IN_ROUTE', 'DELIVERED', 'CANCELLED']
      .map((s) => el('option', { value: s, text: estadoPedido(s).textContent })),
  ])

  async function pintar() {
    // Solo lo que hay que hacer. Un pedido entregado o anulado sale a su
    // histórico, no a la lista de trabajo.
    const qs = new URLSearchParams({ vivas: '1' })
    if (filtro.value) qs.set('estado', filtro.value)
    const pedidos = await A.api(`/orders?${qs}`)
    const cuerpo = el('tbody')
    pintarFilas(cuerpo, pedidos, [
      { titulo: 'Código', render: (p) => el('code', { text: p.order_code }) },
      { titulo: 'Fecha', render: (p) => fecha(p.order_date) },
      { titulo: 'Cliente', render: (p) => el('div', {}, [
        el('b', { text: p.customer_name }),
        el('div', { class: 'pequeno', text: p.customer_code }),
      ]) },
      { titulo: 'Estado', render: (p) => estadoPedido(p.status) },
      { titulo: 'Progreso', render: (p) => progreso(p) },
      { titulo: 'Total', render: (p) => num(p.total, 2) },
      { titulo: '', render: (p) => el('div', { class: 'fila-botones' }, [
        el('button', {
          class: 'btn btn--mini', text: 'Abrir',
          onclick: () => detalle(p.order_id, pintar, { puedeGestionar, puedeAnular }),
        }),
      ]) },
    ], 'No hay pedidos con ese filtro.')
    zona.replaceChildren(tabla(
      ['Código', 'Fecha', 'Cliente', 'Estado', 'Progreso', 'Total', ''], cuerpo))

    const todas = await A.api('/orders')
    const hechos = todas.filter((p) => !pedidos.some((v) => v.order_id === p.order_id))
    if (hechos.length) {
      const c2 = el('tbody')
      pintarFilas(c2, hechos, [
        { titulo: 'Código', render: (p) => el('code', { text: p.order_code }) },
        { titulo: 'Fecha', render: (p) => fecha(p.order_date) },
        { titulo: 'Cliente', render: (p) => p.customer_name },
        { titulo: 'Estado', render: (p) => estadoPedido(p.status) },
        { titulo: 'Total', render: (p) => num(p.total, 2) },
      ], '')
      zona.append(historico('Pedidos entregados o anulados', hechos.length,
        tabla(['Código', 'Fecha', 'Cliente', 'Estado', 'Total'], c2)))
    }
  }
  filtro.addEventListener('change', () => pintar().catch((e) => zona.replaceChildren(aviso(e.message, 'error'))))

  caja.append(el('p', { class: 'pista' }, [
    'Esta lista es lo que hay que hacer. Lo entregado o anulado se guarda abajo.',
  ]))
    caja.append(panel('Pedidos de venta', [
      // El escáner va AQUÍ, y no dentro de la ficha de cada cliente, porque es
      // lo que hace el repartidor en la puerta: no tiene un cliente en mente
      // todavía, tiene una tarjeta en la mano.
      // El escáner SÍ entrega. Antes solo enseñaba la información del cliente y
      // sus pedidos, sin ninguna acción: se escaneaba la tarjeta, se veía qué
      // había, y no se podía hacer nada con ello.
      // AQUÍ SE ENTREGA. El repartidor ha dejado la mercancía, el cliente ha
      // firmado en papel, y con este toque queda registrado. No hay albarán de
      // por medio ni ningún paso más.
      boton('📷 Escanear cliente', () => abrirEscaner({
        alEntregar: alEntregarConTarjeta(pintar),
      }), 'btn'),
      puedeCrear ? boton('+ Nuevo pedido', () => nuevoPedido(pintar), 'btn btn--principal') : null,
    ],
    el('div', { class: 'panel__cuerpo pila' }, [
      el('div', { class: 'fila-filtros' }, [el('label', { class: 'pequeno', text: 'Estado' }), filtro]),
      zona,
    ])))
  try { await pintar() } catch (e) { zona.replaceChildren(aviso(e.message, 'error')) }
  return caja
}

function progreso(p) {
  const total = Number(p.qty_ordered) || 0
  const servido = Number(p.qty_delivered) || 0
  const pct = total > 0 ? Math.round((servido / total) * 100) : 0
  return el('div', { style: 'min-width:110px' }, [
    el('div', { class: 'pequeno', text: `${num(servido, 0)} de ${num(total, 0)}` }),
    el('div', { class: 'barra-progreso' }, [el('div', { class: 'barra-progreso__relleno', style: `width:${pct}%` })]),
  ])
}

async function nuevoPedido(recargar) {
  const [clientes, items] = await Promise.all([
    A.api('/customers'),
    A.api('/items?limit=200'),
  ])
  const vendibles = items.filter((i) => i.category_kind === 'FINISHED_GOOD' && i.is_active)
  // Los formatos se cargan una vez y se consultan por id mientras se escribe
  // el pedido. Así el total de la pantalla se puede calcular sin ir a pedir
  // cada precio al servidor en cada tecla.
  const formatosCargados = new Map()
  try {
    for (const f of await A.api('/config/formatos')) formatosCargados.set(String(f.id), f)
  } catch { /* sin cajas configuradas, el pedido va de unidades sueltas */ }
  if (!clientes.length) {
    window.alert('Primero hay que dar de alta un cliente.')
    return
  }
  if (!vendibles.length) {
    window.alert('No hay productos terminados en el catálogo.')
    return
  }

  const f = {
    // Escribir «C» y ver «Costa» en vez de recorrer un desplegable entero.
    cliente: buscador({
      opciones: clientes.map((c) => ({ value: c.id, text: c.name, sub: c.code })),
      placeholder: 'Escribe el nombre del cliente…',
    }),
    entrega: el('input', { type: 'date' }),
    notas: el('input', { placeholder: 'Observaciones del pedido' }),
  }
  const cuerpoLineas = el('tbody')
  const total = el('b', { text: '0,00' })
  const nOpciones = vendibles.map(
    (i) => ({ value: i.id, text: `${i.name} · ${i.sku}`, sub: `${num(i.sale_price, 2)}` }))

  function addLinea() {
    const b = buscador({
      opciones: nOpciones, placeholder: 'Escribe el producto…',
      onChange: cargarFormatosDe,
    })
    const cant = el('input', { type: 'number', min: '1', step: '1', value: '1' })
    // Formato de venta: vacío = unidades sueltas. En cuanto se elige una
    // caja, la cantidad pasa a contar CAJAS y se enseña cuántas botellas
    // son, para que nadie tenga que multiplicar de cabeza.
    const selFormato = el('select', { class: 'selector-formato' })
    selFormato.append(el('option', { value: '', text: 'Unidades sueltas' }))
    const avisoCaja = el('span', { class: 'tenue' })

    const fila = el('tr', {}, [
      el('td', {}, [b]),
      el('td', {}, [selFormato]),
      el('td', { class: 'num' }, [cant, el('div', {}, [avisoCaja])]),
      el('td', {}, [boton('Quitar', () => { fila.remove(); recalcular() }, 'btn btn--mini')]),
    ])

    selFormato.addEventListener('change', recalcular)

    // Cuando cambia el producto se recargan sus cajas. Los formatos son por
    // producto: dejar las del anterior pondría una caja de jabón en una línea
    // de lavavajillas, y el servidor la rechazaría.
    async function cargarFormatosDe(id) {
      selFormato.replaceChildren(el('option', { value: '', text: 'Unidades sueltas' }))
      avisoCaja.textContent = ''
      if (!id) { recalcular(); return }
      const opciones = [...formatosCargados.values()]
        .filter((f) => String(f.item_id) === String(id) && f.is_active)
      for (const f of opciones) {
        selFormato.append(el('option', {
          value: f.id,
          text: `${f.name} · ${f.units_per_format} uds · ${f.price == null ? 'precio ficha' : f.price}`,
        }))
      }
      recalcular()
    }

    cuerpoLineas.append(fila)
    cant.addEventListener('input', recalcular)
    recalcular()
    return { fila, b, cant, selFormato, avisoCaja }
  }

  /** Lo que cuesta una línea tal como está escrita ahora mismo. */
  function precioDeLinea(tr) {
    const b = tr.querySelector('.buscador')
    const sel = tr.querySelector('.selector-formato')
    const c = Number(tr.children[2].children[0].value) || 0
    const item = vendibles.find((i) => String(i.id) === String(b ? b.value() : ''))
    if (!item) return { total: 0, formato: null, unidades: c }
    const f = formatosDe(tr)
    if (f) {
      const precio = f.price != null ? Number(f.price) : Number(item.sale_price)
      return { total: precio * c, formato: f, unidades: c * Number(f.units_per_format) }
    }
    return { total: Number(item.sale_price) * c, formato: null, unidades: c }
  }

  /** El formato elegido en esta línea, mirando en los datos cargados. */
  function formatosDe(tr) {
    const b = tr.querySelector('.buscador')
    const sel = tr.querySelector('.selector-formato')
    if (!sel || !sel.value) return null
    return formatosCargados.get(String(sel.value)) || null
  }

  function recalcular() {
    let s = 0
    for (const tr of cuerpoLineas.children) {
      const { total: t, formato, unidades } = precioDeLinea(tr)
      const aviso = tr.children[2].children[1]
      // Solo se avisa de las equivalencias; el resto ya se ve en la tabla.
      aviso.textContent = formato
        ? `${unidades} uds en total`
        : ''
      s += t
    }
    total.textContent = num(s, 2)
  }

  addLinea()
  const capa = modal('Nuevo pedido', el('div', { class: 'pila' }, [
    campo('Cliente', f.cliente, true),
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Fecha prometida', f.entrega), campo('Observaciones', f.notas),
    ]),
    el('div', { class: 'fila-titulo' }, [
      el('h3', { text: 'Líneas' }),
      boton('+ Añadir línea', addLinea, 'btn btn--mini'),
    ]),
    tabla(['Producto', 'Formato', 'Cantidad', ''], cuerpoLineas),
    el('div', { class: 'fila-total' }, [
      el('span', { text: 'Total sin impuestos' }), total,
    ]),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Crear pedido', async () => {
      const lineas = []
      for (const tr of cuerpoLineas.children) {
        const b = tr.querySelector('.buscador')
        const sel = tr.querySelector('.selector-formato')
        const cant = Number(tr.children[2].children[0].value)
        const id = b ? b.value() : ''
        if (!id) { window.alert('Hay una línea sin producto elegido.'); return }
        // En caja va el número de CAJAS; el servidor lo traduce a botellas
        // con el formato que el propio usuario ha elegido. Aquí no se
        // multiplica nada: si se multiplicara, el día que una caja pase a
        // tener 13 uds habría deux Websites distintos diciendo 24.
        if (sel && sel.value) lineas.push({ itemId: Number(id), saleFormatId: Number(sel.value), formatsQty: cant })
        else lineas.push({ itemId: Number(id), qty: cant })
      }
      try {
        await A.api('/orders', { metodo: 'POST', cuerpo: {
          customerId: Number(f.cliente.value()),
          promisedDate: f.entrega.value || null,
          notas: f.notas.value.trim() || null,
          lineas,
        } })
        capa.remove()
        await recargar()
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
}

// ═══ Detalle ═══════════════════════════════════════════════════════════════

async function detalle(orderId, recargar, { puedeGestionar, puedeAnular }) {
  const capa = modal('Pedido', cargando())
  try {
    const p = await A.api(`/orders/${orderId}`)
    const dlg = capa.querySelector('.capa__dialogo')

    const acciones = [boton('Cerrar', () => capa.remove())]
    if (puedeGestionar && p.status === 'DRAFT') {
      acciones.unshift(boton('Ver qué se apartaría', () => verPlan(p.id, recargar), 'btn'))
      acciones.unshift(boton('Confirmar y apartar', () => confirmar(p.id, recargar), 'btn btn--principal'))
    }
    if (puedeGestionar && p.status === 'RESERVED') {
      acciones.unshift(boton('Marcar preparado', () => accion(p.id, 'preparar', recargar), 'btn btn--principal'))
    }
    if (puedeGestionar && ['RESERVED', 'PREPARED', 'IN_ROUTE'].includes(p.status)) {
        // NO hay un botón de «Entregar» aquí.
        //
        // Había uno, y abría el albarán para imprimir, firmar en la pantalla y
        // luego cerrar. Eso era el SEGUNDO camino para confirmar una entrega, y
        // el que obligaba al repartidor a hacer el papeleo en el móvil delante
        // de la puerta con el cliente esperando. La entrega se confirma con la
        // TARJETA del cliente, y desde aquí lo único que se ofrece es llevarla
        // hasta allí.
        acciones.unshift(boton('📷 Entregar con la tarjeta', () => {
          dlg.remove()
          abrirEscaner({ alEntregar: alEntregarConTarjeta(recargar) })
        }, 'btn btn--principal'))
    }
    if (puedeAnular && !['DELIVERED', 'CANCELLED'].includes(p.status)) {
      acciones.unshift(boton('Anular', () => anular(p.id, recargar), 'btn btn--peligro'))
    }

    dlg.replaceChildren(
      el('div', { class: 'panel__cabecera' }, [
        el('h2', { text: `Pedido ${p.code}` }), estadoPedido(p.status),
      ]),
      el('div', { class: 'panel__cuerpo pila' }, [
        resumenPedido(p),
        seccionLineas(p),
        seccionReservas(p),
        seccionEntregas(p),
        seccionProducciones(p),
        seccionAlbaranes(p),
      ]),
      el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' },
        acciones),
    )
  } catch (e) {
    capa.querySelector('.capa__dialogo').replaceChildren(
      el('div', { class: 'panel__cuerpo' }, [aviso(e.message, 'error')]))
  }
  return capa
}

function resumenPedido(p) {
  return el('div', { class: 'rejilla rejilla--3' }, [
    metrica('Cliente', p.cliente_name, p.cliente_code),
    metrica('Fecha', fecha(p.order_date)),
    metrica('Total', num(p.total, 2), p.currency_code),
    metrica('Pedido', num(p.resumen.pedido, 0), 'unidades'),
    metrica('Servido', num(p.resumen.entregado, 0), 'unidades'),
    metrica('Pendiente', num(p.resumen.pendiente, 0), 'unidades'),
  ])
}

function metrica(k, v, nota) {
  return el('div', { class: 'metrica' }, [
    el('div', { class: 'pequeno', text: k }),
    el('div', { class: 'metrica__valor', text: v }),
    nota ? el('div', { class: 'pequeno', text: nota }) : null,
  ])
}

function seccionLineas(p) {
  const tbody = el('tbody')
  pintarFilas(tbody, p.lineas, [
    { titulo: 'Producto', render: (l) => el('div', {}, [
      el('b', { text: l.item_name }), el('div', { class: 'pequeno', text: l.sku }),
    ]) },
    { titulo: 'Pedido', clase: 'num', render: (l) => `${num(l.qty, 0)} ${l.unit_code}` },
    { titulo: 'Servido', clase: 'num', render: (l) => num(l.qty_delivered, 0) },
    { titulo: 'Pendiente', clase: 'num', render: (l) => num(Number(l.qty) - Number(l.qty_delivered), 0) },
    { titulo: 'Precio', clase: 'num', render: (l) => num(l.unit_price, 2) },
    { titulo: 'Importe', clase: 'num', render: (l) => num(l.line_total, 2) },
  ])
  return bloque('Productos pedidos', tabla(['Producto', 'Pedido', 'Servido', 'Pendiente', 'Precio', 'Importe'], tbody))
}

function seccionReservas(p) {
  if (!p.reservas.length) {
    return bloque('Stock apartado', el('p', { class: 'pista' }, [
      'Nada apartado todavía. Un pedido confirmado aparta su mercancía sin sacarla ',
      'del almacén; mientras esté en borrador no compromete nada.',
    ]))
  }
  const tbody = el('tbody')
  pintarFilas(tbody, p.reservas, [
    { titulo: 'Lote', render: (r) => el('code', { text: r.lote_code }) },
    { titulo: 'Apartado', clase: 'num', render: (r) => num(r.qty, 0) },
    { titulo: 'Servido', clase: 'num', render: (r) => num(r.qty_consumed, 0) },
    { titulo: 'Vivo', clase: 'num', render: (r) => el('b', { text: num(r.qty_viva, 0) }) },
    { titulo: 'Caduca', render: (r) => fecha(r.expiry_date) },
    { titulo: 'Estado', render: (r) => estado(r.status, r.status === 'ACTIVE' ? 'marca' : 'bien') },
  ], 'Nada apartado.')
  return bloque('Stock apartado (sigue en el almacén)',
    el('p', { class: 'pista' }, ['Apartado no es entregado. Esta mercancía sigue físicamente aquí.']),
    tabla(['Lote', 'Apartado', 'Servido', 'Vivo', 'Caduca', 'Estado'], tbody))
}

function seccionEntregas(p) {
  const tbody = el('tbody')
  pintarFilas(tbody, p.entregas, [
    { titulo: 'Entrega', render: (d) => el('code', { text: d.code }) },
    { titulo: 'Repartidor', render: (d) => d.repartidor || '—' },
    { titulo: 'Fecha', render: (d) => fecha(d.delivered_at) },
    { titulo: 'Estado', render: (d) => estado(d.status, 'bien') },
  ], 'Todavía no se ha entregado nada.')
  return bloque('Entregas', tabla(['Entrega', 'Repartidor', 'Fecha', 'Estado'], tbody))
}

function seccionProducciones(p) {
  if (!p.producciones.length) return null
  const tbody = el('tbody')
  pintarFilas(tbody, p.producciones, [
    { titulo: 'Producción', render: (x) => el('code', { text: x.code }) },
    { titulo: 'Lote PT', render: (x) => x.lote_pt ? el('code', { text: x.lote_pt }) : '—' },
    { titulo: 'Fabricado', clase: 'num', render: (x) => num(x.actual_qty, 0) },
    { titulo: 'Fecha', render: (x) => fecha(x.finished_at) },
  ])
  return bloque('Fabricado para este pedido', tabla(['Producción', 'Lote PT', 'Fabricado', 'Fecha'], tbody))
}

function seccionAlbaranes(p) {
  if (!p.albaranes.length) return null
  const tbody = el('tbody')
  pintarFilas(tbody, p.albaranes, [
    { titulo: 'Albarán', render: (a) => el('code', { text: a.code }) },
    { titulo: 'Estado', render: (a) => estado(a.status, a.status === 'DELIVERED' ? 'bien' : 'aviso') },
    { titulo: 'Impreso', render: (a) => fecha(a.printed_at) },
    { titulo: 'Firmado', render: (a) => fecha(a.signed_at) },
    { titulo: 'Entregado', render: (a) => fecha(a.delivered_at) },
  ])
  const vivos = p.albaranes.filter((a) => ['DRAFT', 'PRINTED', 'SIGNED'].includes(a.status))
  return bloque('Albaranes', tabla(
    ['Albarán', 'Estado', 'Impreso', 'Firmado', 'Entregado', ''], tbody,
  ), vivos.length
    ? boton(`Abrir ${vivos[vivos.length - 1].code}`, () => abrirAlbaran(vivos[vivos.length - 1].id, { recargar }), 'btn btn--mini')
    : (p.status === 'DELIVERED' ? null : boton('Crear albarán', () => crearAlbaranPara(p.id, recargar), 'btn btn--mini')))
}

const bloque = (titulo, ...cuerpo) => el('div', { class: 'bloque' }, [
  el('h3', { text: titulo }), ...cuerpo.filter(Boolean),
])

// ═══ Acciones ══════════════════════════════════════════════════════════════

async function verPlan(orderId, recargar) {
  const capa = modal('Qué se apartaría al confirmar', cargando())
  try {
    const plan = await A.api(`/orders/${orderId}/plan`)
    const cuerpo = el('tbody')
    pintarFilas(cuerpo, plan.lineas, [
      { titulo: 'Producto', render: (l) => l.nombre },
      { titulo: 'Pide', clase: 'num', render: (l) => num(l.pide, 0) },
      { titulo: 'De qué lotes', render: (l) => l.reparto.length
        ? el('div', {}, l.reparto.map((r) => el('div', { class: 'pequeno' }, [
          el('code', { text: r.code }), ` — ${num(r.qty, 0)} uds`,
          r.caducidad ? ` · caduca ${fecha(r.caducidad)}` : '',
        ])))
        : el('span', { class: 'estado estado--peligro', text: 'sin stock' }) },
      { titulo: 'Falta', clase: 'num', render: (l) => (l.suficiente
        ? el('span', { class: 'estado estado--bien', text: '—' })
        : el('span', { class: 'estado estado--peligro', text: num(l.falta, 0) })) },
    ])
    capa.querySelector('.capa__dialogo').replaceChildren(
      el('div', { class: 'panel__cabecera' }, [el('h2', { text: 'Qué se apartaría al confirmar' })]),
      el('div', { class: 'panel__cuerpo pila' }, [
        el('p', { class: 'pista' }, [
          'Apartar compromete la mercancía para este pedido, pero NO la saca del ',
          'almacén. El stock solo bajará cuando se entregue.',
        ]),
        tabla(['Producto', 'Pide', 'De qué lotes', 'Falta'], cuerpo),
        plan.se_puede_confirmar
          ? aviso('Se puede confirmar.')
          : aviso('No hay stock suficiente. Hay que fabricar antes de confirmar.', 'error'),
      ]),
      el('div', { class: 'panel__cuerpo pila pila--fin' }, [boton('Cerrar', () => capa.remove())]),
    )
  } catch (e) {
    capa.querySelector('.capa__dialogo').replaceChildren(
      el('div', { class: 'panel__cuerpo' }, [aviso(e.message, 'error')]))
  }
}

async function confirmar(orderId, recargar) {
  if (!window.confirm(
    '¿Confirmar el pedido?\n\n'
    + 'Se APARTA su mercancía: queda comprometida para este pedido, pero sigue '
    + 'en el almacén. El stock no baja hasta que se entregue.',
  )) return
  try {
    const r = await A.api(`/orders/${orderId}/confirmar`, { metodo: 'POST' })
    await recargar()
    window.alert(`Apartadas ${num(r.apartado, 0)} unidades. El stock del almacén no ha cambiado.`)
  } catch (e) { window.alert(e.message) }
}

async function preparar(orderId, recargar) { await accion(orderId, 'preparar', recargar) }

async function accion(orderId, verbo, recargar) {
  try {
    await A.api(`/orders/${orderId}/${verbo}`, { metodo: 'POST' })
    await recargar()
  } catch (e) { window.alert(e.message) }
}

async function anular(orderId, recargar) {
  const motivo = window.prompt(
    '¿Por qué se anula?\n\nSe liberará lo apartado. El stock no se "devuelve" porque nunca salió del almacén.')
  if (!motivo) return
  try {
    const r = await A.api(`/orders/${orderId}/anular`, { metodo: 'POST', cuerpo: { motivo } })
    await recargar()
    window.alert(`Pedido anulado. Se liberaron ${r.liberadas} reservas (${num(r.unidades_liberadas, 0)} unidades).`)
  } catch (e) { window.alert(e.message) }
}

/**
 * Registrar entrega.
 *
 * La firma es obligatoria. No es un adorno: la base de datos no deja cerrar una
 * entrega sin ella. Aquí, mientras la Fase 5 no tenga la pantalla de albarán, se
 * pide el nombre de quien recibe y la app genera un sello de firma con la hora.
 * En la Fase 5 esto será el dedo del cliente sobre el pantalla.
 */
/**
 * Crea el albarán de este pedido y lo abre.
 *
 * Esto NO entrega nada: saca el papel del viaje, el que se lleva el repartidor y
 * que firma el cliente. Sirve con lo que quede por servir, que es lo que se
 * lleva el camión.
 *
 * Crear el papel es opcional. Se puede entregar desde la tarjeta sin haber
 * impreso nada, y queda igual de bien registrado.
 */
async function crearAlbaranPara(orderId, recargar) {
  try {
    const plan = await A.api(`/deliveries/plan/${orderId}`)
    const servibles = plan.lineas.filter((l) => Number(l.servible) > 0)
    if (!servibles.length) {
      return modal('Nada que llevar', aviso(
        'No queda mercancía apartada de este pedido. Revisa el stock antes de '
        + 'sacar el albarán.', 'aviso'))
    }
    const creado = await A.api('/albaranes', {
      metodo: 'POST',
      cuerpo: {
        pedidoId: orderId,
        lineas: servibles.map((l) => ({ orderLineId: l.lineaId, qty: Number(l.servible) })),
      },
    })
    await recargar()
    await abrirAlbaran(creado.id, { recargar })
  } catch (e) { window.alert(e.message) }
}

/**
 * El camino ÚNICO para entregar: LA TARJETA.
 *
 * Antes esta función se llamaba `viaAlbaran()` y hacía justo lo contrario de lo
 * que dice su nombre: abría el albarán, exigía imprimir y FIRMAR EN LA
 * PANTALLA, y solo después cerraba la entrega. El cliente acababa de firmar en
 * papel delante del repartidor, y el repartidor tenía que volver a dibujarlo
 * con el dedo en el móvil.
 *
 * Ahora solo confirma. Y lo hace con la misma ruta que el escáner, para que
 * haya exactamente una puerta.
 */
function alEntregarConTarjeta(recargar) {
  return async (orderId, orderCode, clienteId) => {
    try {
      const r = await A.api(`/reparto/pedido/${orderId}/entregar`, {
        metodo: 'POST', cuerpo: { clienteId: clienteId || null },
      })
      await recargar()
      window.alert(
        `${orderCode || r.pedido_codigo} entregado.\n\n`
        + `Cliente: ${r.cliente_nombre}\n`
        + `Servido: ${r.lineas_servidas} uds\n`
        + `Registrado: ${new Date(r.confirmed_at).toLocaleString('es-ES')}`)
      return true
    } catch (e) { window.alert(e.message); return false }
  }
}

