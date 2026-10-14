/**
 * COMPRAS.
 *
 * Tres ideas, y el orden importa:
 *
 *   1. LO QUE FALTA ARRIBA. Las órdenes en curso primero; las cerradas, abajo
 *      y plegadas. Una lista de trabajo, no un archivo.
 *   2. PEDIR NO ES TENER. Una orden en borrador no ha tocado el almacén. Se
 *      convierte en compromiso al enviarla, y en mercancía al RECIBIRLA.
 *   3. RECIBIR ES LO QUE HABLA CON EL ALMACÉN. Cada línea recibida genera su
 *      lote con el código del proveedor, su caducidad y lo que se pagó de
 *      verdad. El almacén sube, la trazabilidad se escribe sola y no hay un
 *      camino de stock paralelo.
 */

import { el, panel, tabla, boton, vacio, cargando, aviso, modal, campo, estado, num } from '../ui.js'
import * as A from '../api.js'
import { buscador } from '../ui.js'

const ESTADOS = {
  DRAFT: { texto: 'Borrador', tono: '' },
  ORDERED: { texto: 'Pedida', tono: 'aviso' },
  PARTIALLY_RECEIVED: { texto: 'A medias', tono: 'aviso' },
  RECEIVED: { texto: 'Recibida', tono: 'bien' },
  CLOSED: { texto: 'Cerrada', tono: 'bien' },
  CANCELLED: { texto: 'Anulada', tono: 'peligro' },
}

export async function paginaCompras() {
  const caja = el('div', { class: 'pila' })
  const lista = el('div')
  const contHechos = el('div')
  let verTodas = false

  async function recargar() {
    lista.replaceChildren(cargando('Cargando órdenes…'))
    const [r, res] = await Promise.all([A.api('/purchases'), A.api('/purchases/resumen')])
    const vivas = r.filter((o) => !['RECEIVED', 'CLOSED', 'CANCELLED'].includes(o.status))
    const hechas = r.filter((o) => ['RECEIVED', 'CLOSED', 'CANCELLED'].includes(o.status))

    lista.replaceChildren(panel(
      'Órdenes en curso',
      [boton(verTodas ? 'Solo las de trabajo' : `Ver también las cerradas (${hechas.length})`,
        () => { verTodas = !verTodas; recargar() }, 'btn btn--mini')],
      el('div', { class: 'panel__cuerpo pila' }, [
        el('div', { class: 'ficha-cifras' }, [
          cifra('En curso', res.en_curso),
          cifra('Borradores', res.en_borrador),
          cifra('A medias', res.a_medias),
          cifra('Recibidas', res.recibidas),
        ]),
        vivas.length
          ? tablaOrdenes(vivas, recargar)
          : vacio('No hay ninguna orden en curso.', '📋'),
      ]),
    ))

    contHechos.replaceChildren(hechas.length
      ? panel('Cerradas', [], el('details', { class: 'historial' }, [
        el('summary', { text: `Ver las cerradas (${hechas.length})` }),
        tablaOrdenes(hechas, recargar),
      ]))
      : el('div'))
  }

  caja.append(el('p', { class: 'pista' }, [
    'Crear una orden no mueve el almacén: es una intención. Al enviarla se convierte en ',
    'compromiso con el proveedor. Al recibir, ahí sí: cada línea entra como un lote con ',
    'su código de proveedor y su caducidad, y el almacén sube.',
  ]))
  caja.append(panel('Nueva orden de compra',
    [boton('+ Nueva orden', () => nuevaOrden(recargar), 'btn btn--principal')],
    el('p', { class: 'pista', text: 'Elige proveedor y líneas. Puedes guardarla como borrador y enviarla cuando quieras.' }),
    true))
  caja.append(lista, el('div', { style: 'height:18px' }), contHechos)
  await recargar()
  return caja
}

/**
 * Cantidad legible. `qty_pending` llega de PostgreSQL como «50.0000» —NUMERIC
 * con la escala de la columna— y ponerlo tal cual en pantalla hace que el
 * usuario dude de si son 50 o 50,0001. Redondea a tres decimales y quita los
 * ceros de más.
 */
function cant(v) {
  const n = Number(v || 0)
  const r = Math.round(n * 1000) / 1000
  return String(r)
}

/** ISO → «04/10/2026». A la vista, no como la base. */
function dia(v) {
  const s = String(v || '').slice(0, 10)
  const [a, m, d] = s.split('-')
  return (d && m && a) ? `${d}/${m}/${a}` : (s || '—')
}

function cifra(t, n) {
  return el('div', { class: 'cifra' }, [
    el('div', { class: 'cifra__n', text: String(n) }),
    el('div', { class: 'cifra__t', text: t }),
  ])
}

function tablaOrdenes(ls, recargar) {
  const cuerpo = el('tbody')
  for (const o of ls) {
    const e = ESTADOS[o.status] || { texto: o.status, tono: '' }
    const ped = Number(o.uds_pedidas || 0)
    const rec = Number(o.uds_recibidas || 0)
    cuerpo.append(el('tr', { class: 'fila-pulsable' }, [
      el('td', {}, [
        el('code', { text: o.code }),
        el('div', { class: 'pequeno', text: o.supplier_name }),
      ]),
      el('td', { class: 'centro' }, [estado(e.texto, e.tono)]),
      el('td', { class: 'pequeno' }, [
        el('div', { text: `${o.lineas} línea(s)` }),
        ped > 0
          ? el('div', { class: 'tenue', text: `${cant(rec)} de ${cant(ped)} uds recibidas` })
          : null,
      ].filter(Boolean)),
      el('td', { class: 'col-fecha pequeno' }, [
        el('div', { text: o.expected_date || '—' }),
        o.expected_date && o.status === 'ORDERED'
          ? el('div', { class: 'tenue', text: 'esperada' }) : null,
      ].filter(Boolean)),
      el('td', { class: 'num' }, [num(o.total, 0)]),
      el('td', { class: 'centro' }, [
        boton('Abrir', () => abrirOrden(o.id, recargar), 'btn btn--mini'),
      ]),
    ]))
  }
  return tabla(
    ['Orden', 'Estado', 'Líneas', 'Esperada', 'Total', ''], cuerpo, 'franco')
}

// ═════════════════════════════════════════════════════════════════════════════
// UNA ORDEN ABIERTA
// ═════════════════════════════════════════════════════════════════════════════

async function abrirOrden(id, recargar) {
  const o = await A.api(`/purchases/${id}`)
  const cuerpo = el('div', { class: 'pila' }, [
    el('div', { class: 'ficha-datos' }, [
      el('h3', { text: `${o.code} · ${o.supplier_name}` }),
      el('div', {
        class: 'pequeno',
        // `order_date` llega como fecha con hora y zona. Imprimirla tal cual
        // pone «2026-10-04T00:00:00.000Z» en medio de la pantalla, que no es un
        // formato de fecha, es el de una base de datos.
        text: `Pedida el ${dia(o.order_date)}${o.expected_date ? ` · esperada el ${dia(o.expected_date)}` : ''}`,
      }),
      o.notes ? el('div', { class: 'pequeno tenue', text: o.notes }) : null,
    ].filter(Boolean)),
    el('h4', { text: 'Líneas' }),
    tabla(
      ['Artículo', 'Pedido', 'Recibido', 'Pendiente', 'Coste', 'Lote proveedor', 'Caducidad'],
      el('tbody', {}, o.lineas.map((l) => el('tr', {}, [
        el('td', {}, [
          el('div', { text: l.item_name }),
          el('div', { class: 'mono tenue', text: l.sku }),
        ]),
        el('td', { class: 'num' }, [cant(l.qty_ordered)]),
        el('td', { class: 'num' }, [cant(l.qty_received)]),
        el('td', { class: 'num' }, [cant(l.qty_pending)]),
        el('td', { class: 'num' }, [num(l.unit_cost, 0)]),
        el('td', { class: 'pequeno mono' }, [l.supplier_lot_code || '—']),
        el('td', { class: 'pequeno' }, [dia(l.expiry_date)]),
      ]))),
      'franco'),
    // ── De dónde salió lo ya recibido. Sin esto, el almacén tiene mercancía
    //    pero nadie sabe de qué orden vino ni cuánto se pagó por ella.
    o.recepciones?.length
      ? el('div', {}, [
        el('h4', { text: 'Mercancía recibida' }),
        tabla(['Lote', 'Fecha', 'Cantidad', 'Coste real', 'Factura'],
          el('tbody', {}, o.recepciones.map((r) => el('tr', {}, [
            el('td', {}, [
              el('code', { text: r.lote_codigo }),
              r.supplier_lot_code
                ? el('div', { class: 'pequeno tenue', text: `del proveedor: ${r.supplier_lot_code}` })
                : null,
            ].filter(Boolean)),
            el('td', { class: 'pequeno' }, [(r.occurred_at || '').slice(0, 10)]),
            el('td', { class: 'num' }, [cant(r.cantidad)]),
            el('td', { class: 'num' }, [num(r.coste_real, 0)]),
            el('td', { class: 'pequeno mono' }, [r.invoice_ref || '—']),
          ]))), 'franco'),
      ])
      : null,
    el('div', { class: 'ficha-datos' }, [
      el('div', { class: 'centro' }, [
        el('b', { text: num(o.total, 0) }),
        el('div', { class: 'pequeno tenue', text: `${o.currency_code} · con IVA ${num(o.tax_amount, 0)}` }),
      ]),
    ]),
  ].filter(Boolean))

  const capas = [boton('Cerrar', () => capa.remove())]

  if (o.status === 'DRAFT') {
    capas.unshift(boton('Enviar al proveedor', async (ev) => {
      const b = ev.currentTarget
      b.disabled = true; b.textContent = 'Enviando…'
      try {
        await A.api(`/purchases/${o.id}/enviar`, { metodo: 'POST' })
        capa.remove(); await recargar()
      } catch (e) { window.alert(e.message); b.disabled = false; b.textContent = 'Enviar al proveedor' }
    }, 'btn btn--principal'))
    capas.push(boton('Anular', () => { capa.remove(); anular(o, recargar) }, 'btn btn--peligro'))
  }

  if (['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status)) {
    // ESTE es el botón que mete la mercancía en el almacén. Pide la cantidad
    // REAL de cada línea, porque un proveedor entrega 47 de 50 y eso hay que
    // poder decirlo.
    capas.unshift(boton('Recibir mercancía', () => {
      capa.remove()
      abrirRecepcion(o, recargar)
    }, 'btn btn--principal'))
    capas.push(boton('Anular', () => { capa.remove(); anular(o, recargar) }, 'btn btn--peligro'))
  }

  const capa = modal(`Orden ${o.code}`, cuerpo, capas)
  return capa
}

/** La pantalla de recepción: qué llega, cuánto y con qué datos de lote. */
function abrirRecepcion(o, recargar) {
  const pendientes = o.lineas.filter((l) => Number(l.qty_pending) > 0)
  const factura = el('input', { type: 'text', placeholder: 'FAC-2026-001' })
  const campos = new Map()
  for (const l of pendientes) {
    const qty = el('input', {
      type: 'number', min: 0, max: Number(l.qty_pending), step: 'any',
      value: Number(l.qty_pending),
    })
    const lote = el('input', {
      type: 'text', placeholder: 'código del proveedor',
      value: l.supplier_lot_code || '',
    })
    const cad = el('input', {
      type: 'date', value: (l.expiry_date || '').slice(0, 10) || '',
    })
    const coste = el('input', {
      type: 'number', min: 0, step: 'any', value: Number(l.unit_cost),
    })
    campos.set(l.id, { qty, lote, cad, coste, linea: l })
  }

  const cuerpo = el('div', { class: 'pila' }, [
    aviso(
      'Lo que escribas aquí ENTRA EN EL ALMACÉN. Cada línea crea un lote con su '
      + 'código de proveedor, su caducidad y lo que se pagó de verdad. Deja en 0 '
      + 'la línea que no haya llegado. Todo o nada: si algo falla, no entra nada.',
      'aviso'),
    campo('Número de factura del proveedor', factura),
    el('h4', { text: 'Qué llega' }),
    ...[...campos.values()].map(({ qty, lote, cad, coste, linea }) => el('div', {
      class: 'panel panel--plano', style: 'margin-bottom:10px',
    }, [
      el('div', { class: 'panel__cuerpo pila' }, [
        el('b', { text: linea.item_name }),
        el('div', { class: 'pequeno tenue', text: `${linea.sku} · quedan ${cant(linea.qty_pending)} por recibir` }),
        el('div', { class: 'fila-campos' }, [
          campo('Cantidad', qty), campo('Lote del proveedor', lote),
          campo('Caducidad', cad), campo('Coste unitario real', coste),
        ]),
      ]),
    ])),
  ])

  const capa = modal(`Recibir ${o.code}`, cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Recibir y entrar en almacén', async (ev) => {
      const b = ev.currentTarget
      const lineas = []
      for (const [id, c] of campos) {
        const q = Number(c.qty.value || 0)
        if (q > 0) {
          lineas.push({
            lineId: id, qty: q,
            supplierLotCode: c.lote.value.trim() || null,
            expiryDate: c.cad.value || null,
            unitCost: c.coste.value === '' ? null : Number(c.coste.value),
          })
        }
      }
      if (!lineas.length) { window.alert('No hay ninguna cantidad que recibir.'); return }
      b.disabled = true; b.textContent = 'Entrando en almacén…'
      try {
        const r = await A.api(`/purchases/${o.id}/recibir`, {
          metodo: 'POST',
          cuerpo: {
            lineas, invoiceRef: factura.value.trim() || null,
            // Llave de idempotencia: un doble toque en «Recibir» no duplica la
            // mercancía. En un móvil, el doble toque es lo normal.
            token: `UI-${o.id}-${Date.now()}`,
          },
        })
        capa.remove()
        await recargar()
        window.alert(
          `${o.code}: recibida.\n\n`
          + r.receivable.map((x) => `· ${x.item}: ${x.qty} → ${x.lote_codigo}`).join('\n'))
      } catch (e) {
        window.alert(e.message)
        b.disabled = false; b.textContent = 'Recibir y entrar en almacén'
      }
    }, 'btn btn--principal'),
  ])
  return capa
}

function anular(o, recargar) {
  const motivo = el('textarea', { rows: 3, placeholder: 'Por qué se anula esta orden…' })
  const capa = modal('Anular orden', el('div', { class: 'pila' }, [
    aviso(
      'Solo se anula si no ha entrado nada. Una orden con mercancía recibida '
      + 'dentro deja lotes sin origen, y la trazabilidad se rompe aquí.',
      'aviso'),
    campo('Motivo (obligatorio)', motivo, true),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Anular orden', async () => {
      if (motivo.value.trim().length < 3) { window.alert('Hay que decir por qué.'); return }
      try {
        await A.api(`/purchases/${o.id}/anular`, {
          metodo: 'POST', cuerpo: { motivo: motivo.value.trim() },
        })
        capa.remove(); await recargar()
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--peligro'),
  ])
  return capa
}

// ═════════════════════════════════════════════════════════════════════════════
// PROVEEDORES
//
// El maestro vive en el catálogo y no se duplica aquí. Esta pantalla es la
// VISTA DE COMPRAS de un proveedor: qué nos ha traído, cuánto, a qué precio y
// con qué caducidades. Que la ficha viva en compras y no en catálogo es a
// propósito: el catálogo dice QUÉ ES el proveedor, esto dice QUÉ NOS HA
// TRAÍDO.
// ═════════════════════════════════════════════════════════════════════════════

export async function paginaProveedores() {
  const caja = el('div', { class: 'pila' })
  const lista = el('div')
  let busqueda = ''

  async function recargar() {
    lista.replaceChildren(cargando('Cargando proveedores…'))
    const ps = await A.api('/suppliers/compras')
    const filtrados = busqueda
      ? ps.filter((p) => `${p.name} ${p.code} ${p.contact_name || ''} ${p.phone || ''}`
        .toLowerCase().includes(busqueda))
      : ps
    lista.replaceChildren(panel(
      `Proveedores (${filtrados.length})`, [],
      filtrados.length
        ? tabla(
          ['Proveedor', 'Contacto', 'Teléfono', 'Órdenes', 'Abiertas', 'Comprado', 'Desviación', ''],
          el('tbody', {}, filtrados.map((p) => el('tr', { class: 'fila-pulsable' }, [
            el('td', {}, [
              el('b', { text: p.name }),
              el('div', { class: 'mono pequeno tenue', text: p.code }),
            ]),
            el('td', { class: 'pequeno' }, [p.contact_name || '—']),
            el('td', { class: 'pequeno' }, [p.phone || '—']),
            el('td', { class: 'num' }, [String(p.ordenes)]),
            el('td', { class: 'num' }, [p.abiertas > 0
              ? el('span', { class: 'estado estado--aviso', text: String(p.abiertas) })
              : '—']),
            el('td', { class: 'num' }, [num(p.importe_comprado, 0)]),
            // La desviación se ve aquí, en la lista, no solo dentro de la ficha:
            // es el número que hace falta para elegir a quién no comprarle.
            el('td', { class: 'num' }, [desviacionCelda(Number(p.desviacion))]),
            el('td', { class: 'centro' }, [
              boton('Ficha', () => abrirProveedor(p.id, recargar), 'btn btn--mini'),
            ]),
          ]))), 'franco')
        : vacio(busqueda ? 'Ningún proveedor con ese nombre.' : 'No hay proveedores.'),
    ))
  }

  const buscadorP = el('input', { type: 'search', placeholder: 'Buscar proveedor, código o teléfono…' })
  buscadorP.addEventListener('input', () => {
    busqueda = buscadorP.value.trim().toLowerCase()
    clearTimeout(buscadorP._t)
    buscadorP._t = setTimeout(recargar, 250)
  })

  caja.append(panel('Proveedores',
    [buscadorP, boton('+ Nuevo proveedor', () => nuevoProveedor(recargar), 'btn btn--principal')],
    el('p', { class: 'pista', text: 'Alta y edición en el catálogo. Aquí se ve lo que cada uno te ha traído.' }),
    true))
  caja.append(lista)
  await recargar()
  return caja
}

/** La desviación solo se pinta en rojo cuando el proveedor cobra de MÁS. */
function desviacionCelda(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.01) {
    return el('span', { class: 'tenue', text: '—' })
  }
  const pct = (v * 100).toFixed(1)
  return el('span', {
    class: 'estado estado--' + (v > 0 ? 'peligro' : 'bien'),
    text: `${v > 0 ? '+' : ''}${pct} %`,
  })
}

/** La ficha: todo lo que se sabe de este proveedor. */
async function abrirProveedor(id, recargar) {
  const p = await A.api(`/suppliers/compras/${id}`)
  const t = p.totales
  const d = p.desviacion ?? p.precios

  const cuerpo = el('div', { class: 'pila' }, [
    // ── Quién es ───────────────────────────────────────────────────────
    el('div', { class: 'ficha-datos' }, [
      el('div', {}, [
        el('h3', { text: p.name }),
        el('div', { class: 'mono pequeno tenue', text: p.code }),
      ]),
      el('div', { class: 'pequeno' }, [
        p.contact_name ? `Contacto: ${p.contact_name}` : null,
        p.phone ? ` · ${p.phone}` : null,
        p.email ? ` · ${p.email}` : null,
      ].filter(Boolean).join('')),
      el('div', { class: 'pequeno' }, [
        `Paga a ${p.payment_terms_days || 0} días`,
        p.tax_id ? ` · NIF ${p.tax_id}` : null,
        p.zone_name ? ` · ${p.zone_name}` : null,
      ].filter(Boolean).join('')),
    ].filter(Boolean)),

    // ── Los números ─────────────────────────────────────────────────────
    el('div', { class: 'ficha-cifras' }, [
      cifra('Órdenes', t.ordenes),
      cifra('Abiertas', t.abiertas),
      cifra('Lotes', t.lotes),
      cifra('Facturas', t.facturas),
    ]),

    // ── Lo pedido contra lo pagado. ESTE es el número que importa ───────
    d && Number(d.lineas_recibidas) > 0
      ? aviso(
        `De ${d.lineas_recibidas} línea(s) recibidas: se pidieron por ${num(d.coste_pedido, 0)} `
        + `y se pagaron por ${num(d.coste_pagado, 0)}. `
        + (Number(d.desviacion_pct) > 0.5
          ? `El proveedor está cobrando un ${d.desviacion_pct} % más de lo pedido.`
          : Number(d.desviacion_pct) < -0.5
            ? `Nos está haciendo un ${Math.abs(d.desviacion_pct)} % de descuento.`
            : 'El precio se ha respetado.'),
        Number(d.desviacion_pct) > 5 ? 'error' : 'aviso')
      : null,

    // ── Órdenes ─────────────────────────────────────────────────────────
    el('h4', { text: 'Órdenes de compra' }),
    p.ordenes.length
      ? tabla(['Orden', 'Fecha', 'Estado', 'Recibido', 'Total'], el('tbody', {},
        p.ordenes.slice(0, 25).map((o) => el('tr', {}, [
          el('td', {}, [el('code', { text: o.code })]),
          el('td', { class: 'pequeno' }, [dia(o.order_date)]),
          el('td', { class: 'pequeno' }, [estado(
            (ESTADOS[o.status] || { texto: o.status, tono: '' }).texto,
            (ESTADOS[o.status] || { tono: '' }).tono)]),
          el('td', { class: 'pequeno num' }, [
            `${cant(o.uds_recibidas)} / ${cant(o.uds_pedidas)}`,
          ]),
          el('td', { class: 'num' }, [num(o.total, 0)]),
        ]))), 'franco')
      : vacio('Todavía no le hemos comprado nada.'),

    // ── Recepciones con factura, lote y caducidad ───────────────────────
    p.recepciones.length
      ? el('div', {}, [
        el('h4', { text: 'Mercancía recibida' }),
        el('p', { class: 'pista', text: 'Cada fila es un lote que este proveedor nos trajo.' }),
        tabla(['Fecha', 'Artículo', 'Lote', 'Del proveedor', 'Caduca', 'Cantidad', 'Coste', 'Factura'],
          el('tbody', {}, p.recepciones.slice(0, 40).map((r) => el('tr', {}, [
            el('td', { class: 'pequeno' }, [String(r.occurred_at || '').slice(0, 10)]),
            el('td', {}, [
              el('div', { text: r.item_name }),
              el('div', { class: 'mono tenue pequeno', text: r.sku }),
            ]),
            el('td', {}, [el('code', { text: r.lote_codigo })]),
            el('td', { class: 'mono pequeno' }, [r.supplier_lot_code || '—']),
            // Las caducidades que ya han pasado se marcan. Un lote vencido en
            // el almacén es un problema, y esconderlo en una tabla no ayuda.
            el('td', { class: 'pequeno' }, [caduca(r.expiry_date)]),
            el('td', { class: 'num' }, [cant(r.cantidad)]),
            el('td', { class: 'num' }, [num(r.coste, 0)]),
            el('td', { class: 'pequeno mono' }, [r.invoice_ref || '—']),
          ]))), 'franco'),
        p.recepciones.length > 40
          ? el('p', { class: 'pista', text: `Y ${p.recepciones.length - 40} más.` })
          : null,
      ])
      : null,
  ].filter(Boolean))

  const capas = [boton('Cerrar', () => capa.remove())]
  //
  // Se ofrece «pedirle mercancía» mientras NO haya un borrador abierto.
  //
  // La condición iba al revés —«si ya tiene un borrador, déjame pedirle otro»— y
  // con eso un proveedor recién creado no tenía forma de pedirle nada desde su
  // propia ficha: no tenía ningún borrador, luego no salía el botón. Justo los
  // proveedores que más lo necesitan eran los que no lo tenían.
  //
  // Ahora el botón aparece siempre que no haya ya una orden a medio hacer, que
  // es cuando de verdad tiene sentido abrir otra.
  //
  const yaHayBorrador = p.ordenes.some((o) => o.status === 'DRAFT')
  if (!yaHayBorrador) {
    capas.unshift(boton('+ Pedirle mercancía', () => {
      capa.remove()
      nuevaOrden(recargar, p.id)
    }, 'btn btn--principal'))
  } else {
    capas.unshift(el('span', {
      class: 'pista',
      text: 'Tiene una orden en borrador. Termínala o anúlala antes de abrir otra.',
    }))
  }
  capas.unshift(boton('✎ Editar', () => {
    capa.remove()
    editarProveedor(p, recargar)
  }))
  const capa = modal(`Proveedor · ${p.name}`, cuerpo, capas)
  return capa
}

/**
 * Editar un proveedor. Es el MISMO formulario que el alta, con una diferencia:
 * aquí no se escribe el código, porque el código ya existe y cambiarlo rompe
 * las referencias antiguas.
 *
 * Un proveedor no se duplica ni se sustituye: se corrige. Por eso el alta y la
 * edición comparten casi todo el formulario en vez de ser dos pantallas que
 * acaban divergiendo sin que nadie se dé cuenta.
 */
function editarProveedor(p, recargar) {
  const nombre = el('input', { type: 'text', value: p.name })
  const contacto = el('input', { type: 'text', value: p.contact_name || '' })
  const tel = el('input', { type: 'tel', value: p.phone || '' })
  const mail = el('input', { type: 'email', value: p.email || '' })
  const nif = el('input', { type: 'text', value: p.tax_id || '' })
  const dias = el('input', { type: 'number', min: 0, max: 365, value: p.payment_terms_days ?? 0 })

  const cuerpo = el('div', { class: 'pila' }, [
    el('div', { class: 'fila-filtros' }, [
      el('code', { class: 'mono', text: p.code }),
      el('span', {
        class: 'tenue pequeno',
        text: 'El código no se cambia: ya sale impreso en facturas y albaranes.',
      }),
    ]),
    campo('Nombre', nombre, true),
    campo('Persona de contacto', contacto),
    campo('Teléfono', tel),
    campo('Correo', mail),
    campo('NIF / Identificación fiscal', nif),
    campo('Días de pago acordados', dias),
  ])

  const capa = modal(`Editar · ${p.name}`, cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Guardar cambios', async (ev) => {
      if (nombre.value.trim().length < 2) { window.alert('El nombre es obligatorio.'); return }
      const b = ev.currentTarget
      b.disabled = true
      try {
        await A.api(`/suppliers/${p.id}`, {
          metodo: 'PUT',
          cuerpo: {
            name: nombre.value.trim(),
            contact_name: contacto.value.trim() || null,
            phone: tel.value.trim() || null,
            email: mail.value.trim() || null,
            tax_id: nif.value.trim() || null,
            payment_terms_days: Number(dias.value || 0),
          },
        })
        capa.remove()
        await recargar()
      } catch (e) { window.alert(e.message); b.disabled = false }
    }, 'btn btn--principal'),
  ])
  return capa
}

/** La caducidad de un lote, en rojo si ya pasó. */
function caduca(v) {
  const s = String(v || '').slice(0, 10)
  if (!s) return '—'
  const pasado = s < new Date().toISOString().slice(0, 10)
  return el('span', {
    class: pasado ? 'estado estado--peligro' : '',
    text: dia(v) + (pasado ? ' ⚠' : ''),
  })
}

/** Alta de proveedor. El alta va al catálogo; esta pantalla solo llama. */
async function nuevoProveedor(recargar) {
  const nombre = el('input', { type: 'text', placeholder: 'Química del Sahel S.A.' })
  const contacto = el('input', { type: 'text', placeholder: 'Quién llama' })
  const tel = el('input', { type: 'tel', placeholder: '+223 76 00 00 00' })
  const mail = el('input', { type: 'email', placeholder: 'compras@proveedor.ml' })
  const nif = el('input', { type: 'text', placeholder: 'Opcional' })
  const dias = el('input', { type: 'number', min: 0, max: 365, value: 30 })
  const cuerpo = el('div', { class: 'pila' }, [
    aviso('El alta la guarda el catálogo de proveedores. Aquí no se duplica nada.', 'aviso'),
    campo('Nombre', nombre, true),
    campo('Persona de contacto', contacto),
    campo('Teléfono', tel),
    campo('Correo', mail),
    campo('NIF / Identificación fiscal', nif),
    campo('Días de pago acordados', dias),
  ])
  const capa = modal('Nuevo proveedor', cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Guardar', async (ev) => {
      if (nombre.value.trim().length < 2) { window.alert('El nombre es obligatorio.'); return }
      const b = ev.currentTarget
      b.disabled = true
      try {
        await A.api('/suppliers', {
          metodo: 'POST',
          cuerpo: {
            name: nombre.value.trim(),
            contact_name: contacto.value.trim() || null,
            phone: tel.value.trim() || null,
            email: mail.value.trim() || null,
            tax_id: nif.value.trim() || null,
            payment_terms_days: Number(dias.value || 0),
          },
        })
        capa.remove()
        await recargar()
      } catch (e) { window.alert(e.message); b.disabled = false }
    }, 'btn btn--principal'),
  ])
  return capa
}

// ═════════════════════════════════════════════════════════════════════════════
// ALTA DE ORDEN
// ═════════════════════════════════════════════════════════════════════════════

async function nuevaOrden(recargar, proveedorId = null) {
  const [provs, items] = await Promise.all([
    A.api('/suppliers'), A.api('/items?activos=true'),
  ])
  const comprables = items.filter((i) => ['RAW_MATERIAL', 'PACKAGING', 'FINISHED_GOOD']
    .includes(i.category_kind))

  const selProv = el('select', {}, [el('option', { value: '', text: 'Elige proveedor…' }),
    ...provs.map((p) => el('option', { value: p.id, text: `${p.name} (${p.code})` }))])
  // Si se abre desde la ficha del proveedor, ya está elegido. Pedirle algo a
  // otro por error es un error de dos clics, no de cinco.
  if (proveedorId) selProv.value = String(proveedorId)
  const fecha = el('input', { type: 'date' })
  const tbody = el('tbody')
  const lineas = []

  // ── Los totales, ANTES de la primera línea ──────────────────────────────
  //
  // `añadir()` se llama de entrada para que el formulario no salga vacío, y esa
  // llamada termina en `recalcular()`. Si `recalcular` se declara después con
  // `const`, JavaScript lo tiene en la zona muerta temporal y revienta con
  // «Cannot access 'recalcular' before initialization»: el botón de Nueva orden
  // no hace absolutamente nada, sin error visible en pantalla.
  const total = el('b', { text: '0' })
  const iva = el('b', { text: '0' })
  const recalcular = () => {
    let s = 0
    for (const { fila } of lineas) {
      s += Number(fila.qty.value || 0) * (Number(fila.coste.value || 0))
    }
    const t = Math.round(s * 100) / 100
    total.textContent = String(t)
    iva.textContent = String(Math.round(t * 0.21 * 100) / 100)
  }

  const añadir = (item = null) => {
    const sel = el('select', {}, comprables.map((i) => el('option', {
      value: i.id, text: `${i.name} · ${i.sku}`,
    })))
    const qty = el('input', { type: 'number', min: '0.001', step: 'any', value: 1 })
    const coste = el('input', { type: 'number', min: 0, step: 'any', value: '' })
    coste.placeholder = 'último coste'
    const quitar = boton('✕', () => {
      const i = lineas.findIndex((l) => l.fila === tr)
      if (i >= 0) lineas.splice(i, 1)
      tr.remove(); recalcular()
    }, 'btn btn--peligro btn--mini')
    const fila = { sel, qty, coste }
    const tr = el('tr', {}, [
      el('td', {}, [sel]), el('td', { class: 'centro' }, [qty]),
      el('td', { class: 'centro' }, [coste]), el('td', { class: 'centro' }, [quitar]),
    ])
    // Si no se dice el precio, se usa el último coste del artículo. Comprar lo
    // de siempre no debería obligar a teclear el precio cada vez.
    //
    // Y se rellena AL AÑADIR la línea, no solo al cambiar el artículo. El
    // `select` ya viene con el primero marcado, así que si esperásemos al
    // `change` la primera línea saldría con el precio en blanco y un subtotal
    // de 0, que parece una pantalla rota.
    const costeDe = () => {
      const art = comprables.find((i) => String(i.id) === sel.value)
      if (art && coste.value === '') coste.value = Number(art.purchase_cost || 0)
    }
    costeDe()
    sel.addEventListener('change', () => { costeDe(); recalcular() })
    qty.addEventListener('input', recalcular)
    coste.addEventListener('input', recalcular)
    lineas.push({ fila, tr })
    tbody.append(tr)
    recalcular()
  }
  añadir()


  const cuerpo = el('div', { class: 'pila' }, [
    campo('Proveedor', selProv, true),
    campo('Fecha esperada de entrega', fecha),
    el('h4', { text: 'Líneas' }),
    tabla(['Artículo', 'Cantidad', 'Coste unitario', ''], tbody, 'franco'),
    el('div', { class: 'pila' }, [
      boton('+ Añadir línea', () => añadir(), 'btn btn--mini'),
    ]),
    el('div', { class: 'ficha-datos' }, [
      el('div', { class: 'centro' }, [el('b', { text: 'Subtotal ' }), total]),
      el('div', { class: 'centro' }, [el('span', { class: 'tenue', text: 'IVA ' }), iva]),
    ]),
    aviso('Guardar una orden NO mueve el almacén. Solo es una intención; la '
      + 'mercancía entra cuando la recibas.', 'aviso'),
  ])

  const capa = modal('Nueva orden de compra', cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Guardar borrador', async (ev) => {
      const b = ev.currentTarget
      if (!selProv.value) { window.alert('Hay que elegir proveedor.'); return }
      const ls = lineas
        .map(({ fila }) => ({
          itemId: Number(fila.sel.value),
          qtyOrdered: Number(fila.qty.value || 0),
          unitCost: fila.coste.value === '' ? null : Number(fila.coste.value),
        }))
        .filter((l) => l.itemId && l.qtyOrdered > 0)
      if (!ls.length) { window.alert('Pon al menos una línea con cantidad.'); return }
      b.disabled = true
      try {
        const o = await A.api('/purchases', {
          metodo: 'POST',
          cuerpo: {
            supplierId: Number(selProv.value),
            expectedDate: fecha.value || null,
            lineas: ls,
          },
        })
        capa.remove(); await recargar()
        window.alert(`${o.code} guardada en borrador. Revísala y envíala al proveedor.`)
      } catch (e) {
        window.alert(e.message)
        b.disabled = false
      }
    }, 'btn btn--principal'),
  ])
  return capa
}
