/**
 * ALBARÁN
 *
 * La lista de trabajo del almacén y, a la vez, el documento que se imprime.
 *
 * El albarán es un proceso, no un documento: CREAR → IMPRIMIR → FIRMAR →
 * ENTREGAR. Cada paso deja constancia y el paso siguiente no se puede saltar.
 * En el almacén se imprime un albarán mucho antes de que nadie lo firme, así
 * que imprimir NO es entregar.
 *
 * De la aplicación antigua se conserva SOLO cómo se ve —el membrete, la caja
 * del número, la tabla con PRESENTACIÓN, el pie— porque eso es lo que el
 * cliente espera recibir. No se copia ni su código ni sus datos.
 */

import {
  el, panel, tabla, modal, boton, estado, vacio, cargando, aviso, campo,
  fecha, fechaHora, num, entero,
} from '../ui.js'
import { lienzoFirma } from '../firma.js'
import * as A from '../api.js'

const TONO = { DRAFT: '', PRINTED: 'aviso', SIGNED: 'bien', DELIVERED: 'bien', VOID: 'peligro' }
const TEXTO = {
  DRAFT: 'Sin imprimir', PRINTED: 'Impreso', SIGNED: 'Firmado',
  DELIVERED: 'Entregado', VOID: 'Anulado',
}

// ═══════════════════════════════════════════════════════════════════════════
// La pantalla
// ═══════════════════════════════════════════════════════════════════════════

export async function paginaAlbaranes(ctx) {
  const caja = el('div', { class: 'pila' })
  const contVivos = el('div')
  const contHechos = el('div')
  let filtro = { estado: null }

  async function recargar() {
    contVivos.replaceChildren(cargando('Cargando albaranes…'))
    contHechos.replaceChildren(cargando())
    const [vivos, hechos] = await Promise.all([
      A.api('/albaranes'),
      A.api('/albaranes'),
    ])
    const vivosFiltrados = filtro.estado ? vivos.filter((a) => a.status === filtro.estado) : vivos
    const enCurso = ['DRAFT', 'PRINTED', 'SIGNED']
    contVivos.replaceChildren(panel(
      'Albaranes por entregar',
      [boton('+ Crear albarán', () => crearDesdePedido(recargar), 'btn btn--principal')],
      vivosFiltrados.filter((a) => enCurso.includes(a.status)).length
        ? tablaAlbaranes(vivosFiltrados.filter((a) => enCurso.includes(a.status)), { recargar })
        : vacio('Ningún albarán esperando firma o entrega. En el almacén se imprimen '
          + 'mucho antes de que la mercancía salga.', '📄')))

    contHechos.replaceChildren(panel('Histórico de albaranes', [],
      hechos.filter((a) => !enCurso.includes(a.status)).length
        ? el('details', { class: 'historial' }, [
          el('summary', { text: `Ver los ya cerrados (${hechos.filter((a) => !enCurso.includes(a.status)).length})` }),
          tablaAlbaranes(hechos.filter((a) => !enCurso.includes(a.status)), { recargar }),
        ])
        : vacio('Todavía no se ha cerrado ningún albarán.')))
  }

  caja.append(el('p', { class: 'pista' }, [
    'Un albarán va por pasos: se crea, se imprime, lo firma quien recibe y solo ',
    'entonces la entrega queda cerrada. Imprimir NO entrega nada: el almacén ',
    'imprime mucho antes de que la mercancía salga.',
  ]))
  caja.append(contVivos, el('div', { style: 'height:18px' }), contHechos)
  await recargar()
  return caja
}

function tablaAlbaranes(lista, { recargar }) {
  const cuerpo = el('tbody')
  for (const a of lista) {
    cuerpo.append(el('tr', {
      class: 'fila-pulsable',
      onclick: () => abrirAlbaran(a.id, { recargar }),
    }, [
      el('td', {}, [el('code', { text: a.code })]),
      el('td', {}, [
        el('b', { text: a.cliente_name }),
        el('div', { class: 'pequeno tenue', text: a.pedido_code }),
      ]),
      el('td', { class: 'col-fecha pequeno tenue', text: fechaHora(a.created_at) }),
      el('td', {}, [estado(TEXTO[a.status] || a.status, TONO[a.status] || '')]),
      el('td', { class: 'centro' }, [
        a.tiene_firma
          ? el('span', { class: 'estado estado--bien', text: 'Firmado ✓' })
          : el('span', { class: 'tenue pequeno', text: '—' }),
      ]),
      el('td', { class: 'centro' }, [boton('Ver', () => abrirAlbaran(a.id, { recargar }), 'btn btn--mini')]),
    ]))
  }
  return tabla(['Albarán', 'Cliente', 'Creado', 'Estado', 'Firma', ''], cuerpo)
}

// ═══════════════════════════════════════════════════════════════════════════
// Crear desde un pedido
// ═══════════════════════════════════════════════════════════════════════════

async function crearDesdePedido(recargar) {
  const pedidos = await A.api('/orders').catch(() => [])
  // Solo los que se pueden entregar, y solo los que aún están vivos.
  //
  // Los estados NO son inventados: son los que acepta el CHECK de
  // `sales_orders`. `RESERVED` es el que devuelve «confirmar», y quitarlo de
  // la lista dejaba el formulario sin un solo pedido posible.
  const aptos = pedidos.filter((o) =>
    ['CONFIRMED', 'RESERVED', 'PREPARED', 'IN_ROUTE'].includes(o.status))

  if (!aptos.length) {
    return modal('Crear albarán', vacio(
      'No hay ningún pedido confirmado al que ponerle albarán. Confirma un pedido primero.', '📄'))
  }

  // OJO: `/orders` NO devuelve `id` ni `code`. Su vista renombra las columnas
  // para que no choquen con las de la línea, así que llegan `order_id` y
  // `order_code`. Escribirlos como `o.id` daba `Number(undefined)` → NaN, y el
  // albarán se creaba apuntando a un pedido inexistente.
  const sel = el('select', {}, aptos.map((o) => el('option', {
    value: o.order_id,
    text: `${o.order_code} · ${o.customer_name} · ${num(o.total, 0)} FCFA`,
  })))

  // Las líneas de ESTE viaje. Un albarán por viaje, no por pedido: si el
  // pedido va a medias, este documento lleva lo que se lleva AHORA, y el
  // siguiente viaje abre el suyo.
  const zonaLineas = el('div')
  async function pintarLineas() {
    zonaLineas.replaceChildren(cargando('Mirando qué queda por servir…'))
    const plan = await A.api(`/deliveries/plan/${sel.value}`).catch(() => null)
    if (!plan) { zonaLineas.replaceChildren(); return }
    planActual = plan.lineas
    const hay = plan.lineas.filter((l) => Number(l.servible) > 0)
    if (!hay.length) {
      zonaLineas.replaceChildren(aviso('Ese pedido no tiene mercancía apartada para entregar.', 'aviso'))
      return
    }
    const cuerpo = el('tbody')
    for (const l of hay) {
      const casilla = el('input', {
        type: 'checkbox', checked: true,
        onchange: (ev) => { l.elegido = ev.target.checked },
      })
      l.elegido = true
      cuerpo.append(el('tr', {}, [
        el('td', { class: 'centro' }, [casilla]),
        el('td', { text: l.nombre }),
        el('td', { class: 'num', text: `${num(l.servible, 2)} ${l.sku ? '' : ''}`.trim() }),
        el('td', { class: 'tenue pequeno', text: `pedido ${num(l.pedido, 0)} · servido ${num(l.entregado, 0)}` }),
      ]))
    }
    zonaLineas.replaceChildren(
      el('p', { class: 'pista', text: 'Qué lleva ESTE viaje. Lo que se imprima es lo que firme el cliente.' }),
      tabla(['', 'Producto', 'A servir', ''], cuerpo))
  }
  sel.addEventListener('change', () => pintarLineas())
  // Cuántas HOJAS se sacan de la impresora. El documento es una sola página:
  // imprimir dos significa sacar el mismo albarán dos veces de la impresora,
  // una para el cliente y otra para el archivo. No son dos documentos ni dos
  // entregas, y no tienen nada que ver con el estado «Entregado».
  const copias = el('input', { type: 'number', min: 1, max: 10, value: 2 })
  // Se leen del plan que se acaba de pintar, sin volver a preguntar a la API.
  let planActual = null
  const lineasElegidas = () => (planActual || [])
    .filter((l) => Number(l.servible) > 0 && l.elegido !== false)
    .map((l) => ({ orderLineId: l.lineaId, qty: Number(l.servible) }))
  const receptor = el('input', { placeholder: 'Quién recibe (si no es el cliente)' })
  const notas = el('input', { placeholder: 'Observaciones del albarán' })

  const capa = modal('Nuevo albarán', el('div', { class: 'pila' }, [
    el('p', { class: 'pista' }, [
      'Un albarán es un VIAJE, no un pedido. Lo que marques aquí es lo que se ',
      'imprime y lo que firma el cliente. Se crea en borrador y todavía no toca ',
      'el almacén: el stock baja cuando se confirme la entrega.',
    ]),
    campo('Pedido', sel, true),
    zonaLineas,
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Hojas a imprimir', copias), campo('Recibe', receptor)]),
    campo('Observaciones', notas, true),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Crear borrador', async () => {
      try {
        const a = await A.api('/albaranes', {
          metodo: 'POST',
          cuerpo: {
            pedidoId: Number(sel.value),
            copias: Number(copias.value) || 1,
            lineas: lineasElegidas(),
            recipientName: receptor.value.trim() || null,
            observations: notas.value.trim() || null,
          },
        })
        capa.remove()
        await recargar()
        abrirAlbaran(a.id, { recargar })
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
  return capa
}

// ═══════════════════════════════════════════════════════════════════════════
// El albarán abierto
// ═══════════════════════════════════════════════════════════════════════════

export async function abrirAlbaran(id, { recargar }) {
  const a = await A.api(`/albaranes/${id}`)
  const cuerpo = el('div', { class: 'pila' })

  cuerpo.append(el('div', { class: 'alerta alerta--' + (TONO[a.status] || 'bien') }, [
    estado(TEXTO[a.status] || a.status, TONO[a.status] || ''),
    el('span', { text: `  ${a.code}` }),
    el('span', { class: 'tenue', text: a.copies > 1 ? `  (${a.copies} hojas)` : '' }),
    a.tieneFirma ? el('span', { class: 'tenue', text: `  firmado por ${a.firma.signer_name || 'quien recibe'}` }) : null,
  ].filter(Boolean)))

  // La firma se pide con cabecera de sesión; un `<img src="/api/…">` salía en
  // 401 y el hueco de «Recibido conforme» se quedaba vacío.
  let urlFirma = null
  if (a.tieneFirma) {
    try { urlFirma = await A.imagen(`/albaranes/${a.id}/firma`) } catch { /* sin firma */ }
  }
  cuerpo.append(documentoAlbaran(a, urlFirma))

  if (a.eventos?.length) {
    cuerpo.append(el('details', { class: 'historial' }, [
      el('summary', { text: `Historial del documento (${a.eventos.length})` }),
      tabla(['Paso', 'Cuándo', 'Quién'],
        (() => {
          const tb = el('tbody')
          for (const ev of a.eventos) {
            tb.append(el('tr', {}, [
              el('td', { text: ev.event }),
              el('td', { text: fechaHora(ev.occurred_at) }),
              el('td', { text: ev.user_name || '—' }),
            ]))
          }
          return tb
        })()),
    ]))
  }

  const acciones = [boton('Cerrar', () => capa.remove())]
  if (a.status === 'DRAFT') {
    acciones.unshift(boton('🖨 Imprimir',
      () => imprimir(a.id, { recargar, capa }), 'btn btn--principal'))
  }
  // NO hay botón de «firmar» ni de «confirmar entrega» en el albarán.
  //
  // El albarán es PAPEL: el cliente lo firma a mano y se lo lleva. La entrega la
  // registra el repartidor escaneando la TARJETA del cliente. Poner un
  // «Confirmar entrega» aquí era el segundo camino para cerrar lo mismo.
  if (['DRAFT', 'PRINTED'].includes(a.status)) {
    acciones.unshift(boton('Anular', () => anular(a, { recargar, capa }), 'btn btn--peligro'))
  }

  const capa = modal(`Albarán ${a.code}`, cuerpo, acciones)
  return capa
}

/**
 * Imprimir, y dejar el documento al día.
 *
 * El albarán se vuelve a abrir con los datos frescos porque, después de
 * imprimir, aparece el botón de FIRMAR: si solo se refrescara la lista de
 * atrás, el documento seguiría mostrando «Imprimir» y nadie encontraría el
 * paso siguiente.
 */
function imprimir(id, { recargar, capa }) {
  return A.api(`/albaranes/${id}/imprimir`, { metodo: 'POST' })
    .then(async () => {
      await recargar()
      capa?.remove()
      // El diálogo de impresión se abre después de redibujar, no antes: si se
      // llama a `window.print()` sobre una capa a punto de desaparecer, el
      // navegador imprime el estado viejo.
      await new Promise((r) => setTimeout(r, 60))
      window.print()
      // Y se reabre, que es donde el operario hará el paso siguiente.
      await abrirAlbaran(id, { recargar })
    })
    .catch((e) => window.alert(e.message))
}

// ═══════════════════════════════════════════════════════════════════════════
// La firma
// ═══════════════════════════════════════════════════════════════════════════

function anular(a, { recargar, capa }) {
  const motivo = el('textarea', { rows: 3, placeholder: 'Por qué se anula este albarán' })
  return modal(`Anular ${a.code}`, el('div', { class: 'pila' }, [
    aviso('Anular un albarán no devuelve mercancía al almacén. Si ya había salido, '
      + 'eso es una entrega y se registra aparte.', 'aviso'),
    campo('Motivo (obligatorio)', motivo, true),
  ]), [
    boton('Cancelar', () => capaAnular.remove()),
    boton('Anular albarán', async () => {
      if (motivo.value.trim().length < 3) { window.alert('El motivo tiene que decir algo.'); return }
      try {
        await A.api(`/albaranes/${a.id}/anular`, { metodo: 'POST', cuerpo: { motivo: motivo.value.trim() } })
        capaAnular.remove()
        capa.remove()
        await recargar()
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--peligro'),
  ])
}

// ═══════════════════════════════════════════════════════════════════════════
// El documento
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El albarán tal como se imprime: UNA SOLA HOJA.
 *
 * Antes se generaban dos, una para el cliente y otra para el archivo, porque en
 * el almacén hacía falta tener las dos en papel. Ahora eso ya no lo decide la
 * aplicación: quien lo imprime tiene su propio diálogo de impresión, con sus
 * opciones de páginas y de número de copias. Lo que sale de aquí es
 * SIEMPRE un albarán, y son dos páginas si el operario decide sacar dos.
 *
 * `copies` sigue guardándose, pero ya no es lo que se imprime: es la nota de
 * cuántas hojas se sacaron de la impresora para el archivo.
 */
function documentoAlbaran(a, urlFirma = null) {
  const e = a.empresa || {}
  const cab = a.cabecera || {}
  const sim = e.simbolo || 'FCFA'
  return el('div', { class: 'albaran' }, [copiaAlbaran(a, e, cab, sim, urlFirma)])
}

function copiaAlbaran(a, e, cab, sim, urlFirma = null) {
  const lineas = a.lineas || []
  const imp = Number(cab.discount_amount || 0)
  const sub = Number(cab.subtotal || 0)
  const iva = Number(cab.tax_amount || 0)
  const total = Number(cab.total || 0)
  const tasa = Number(cab.tax_rate ?? e.iva ?? 0)

  // Cuántas filas caben en una A4 cambia el aire entre ellas, y eso no lo
  // puede decidir una hoja de estilos: el CSS no sabe cuántas líneas hay.
  // Los umbrales salen de MEDIR el PDF con 10, 20 y 30 filas, no deestimar a
  // ojo: con el relleno normal caben once productos, y un pedido de veinte se
  // iba a la segunda hoja.
  const clase = lineas.length >= 18 ? ' albaran__copia--muy-denso'
    : lineas.length >= 9 ? ' albaran__copia--denso' : ''

  return el('article', { class: 'albaran__copia' + clase }, [
    el('header', { class: 'albaran__cabecera' }, [
      el('div', { class: 'albaran__empresa' }, [
        // El LOGOTIPO de verdad, no la palabra SAHEL escrita a mano. El
        // logotipo es un bloque de marca (marco, gota, nombre y descriptor) y
        // poner el texto suelto al lado era duplicarlo a medias: salía un
        // «SAHEL» azul sin gota y sin marco, que no es el logotipo de nadie.
        //
        // Se mide en milímetros, no en píxeles, para que en el papel ocupe lo
        // mismo que en la pantalla.
        el('img', { class: 'albaran__logo', src: '/img/logo-sahel.svg', alt: e.nombre || 'SAHEL' }),
        e.descriptor ? el('div', { class: 'albaran__descriptor', text: e.descriptor }) : null,
        el('div', { class: 'albaran__contacto' }, [
          e.direccion ? el('div', { text: e.direccion }) : null,
          e.cif ? el('div', { text: `CIF ${e.cif}` }) : null,
          e.telefono ? el('div', { text: `Tel. ${e.telefono}` }) : null,
          e.email ? el('div', { text: e.email }) : null,
        ].filter(Boolean)),
      ].filter(Boolean)),
      el('div', { class: 'albaran__ident' }, [
        el('div', { class: 'albaran__titulo', text: 'ALBARÁN DE ENTREGA' }),
        el('div', { class: 'albaran__caja' }, [
          fila('N.º', a.code),
          fila('Fecha', fecha(a.created_at)),
          fila('Pedido', cab.pedido_code || '—'),
          fila('Entrega', a.recipient_name || cab.cliente_name || '—'),
        ]),
      ]),
    ]),

    el('section', { class: 'albaran__cliente' }, [
      el('h3', { text: 'DATOS DEL CLIENTE' }),
      el('div', { class: 'albaran__rejilla' }, [
        el('div', {}, [el('b', { text: cab.cliente_name || '—' })]),
        el('div', { text: cab.cliente_code ? `Código ${cab.cliente_code}` : '' }),
        el('div', { text: cab.address || '' }),
        el('div', { text: cab.phone ? `Tel. ${cab.phone}` : '' }),
      ]),
    ]),

    tabla(['N.º', 'Descripción', 'Presentación', 'Formato', 'Cantidad', 'Precio unitario', 'Importe'],
      (() => {
        const tb = el('tbody')
        lineas.forEach((l, i) => {
          tb.append(el('tr', {}, [
            el('td', { class: 'num', text: String(i + 1) }),
            el('td', {}, [el('div', { text: l.item_name }), l.notes ? el('div', { class: 'pequeno tenue', text: l.notes }) : null].filter(Boolean)),
            // PRESENTACIÓN sale de `items.format_label`: «750 ml», «1 L».
            el('td', { text: l.presentacion || '—' }),
            // LA CAJA. Se imprimen las DOS cifras y es lo correcto: el
            // cliente leyó «2 cajas» en el pedido y quien recibe tiene que
            // saber cuántas botellas hay que contar. Sale de la copia de la
            // línea (`format_*`), no del formato actual, así que un albarán
            // viejo enseña el precio de aquel día aunque la caja hoy valga
            // otra cosa.
            el('td', {}, l.format_name
              ? [
                el('div', { text: `${num(l.formats_qty, 2)} × ${l.format_name}` }),
                el('div', { class: 'pequeno tenue', text: `${num(l.format_units, 0)} uds por caja` }),
              ]
              : [el('span', { class: 'tenue', text: '—' })]),
            el('td', { class: 'num', text: `${num(l.qty, 2)} ${l.unit_code || ''}`.trim() }),
            el('td', { class: 'num', text: dinero(l.format_price != null ? l.format_price : l.unit_price, sim) }),
            el('td', { class: 'num', text: dinero(l.line_total, sim) }),
          ]))
        })
        if (!lineas.length) {
          tb.append(el('tr', {}, [el('td', { colspan: 7, class: 'tenue', text: 'Sin líneas' })]))
        }
        return tb
      })(), 'albaran__tabla'),

    el('section', { class: 'albaran__totales' }, [
      totalLine('Subtotal', dinero(sub, sim)),
      imp ? totalLine('Descuento', `− ${dinero(imp, sim)}`) : null,
      // El IVA se imprime con SU tasa, no con una rotulación fija. La
      // aplicación antigua rotulaba «21 %» y aplicaba 18 %: el papel no
      // cuadra con la cuenta, y eso acaba en una discusión con Hacienda.
      totalLine(`I.V.A. (${pct(tasa)})`, dinero(iva, sim)),
      totalLine('TOTAL GENERAL', dinero(total, sim), true),
    ].filter(Boolean)),

    el('section', { class: 'albaran__firmas' }, [
      el('div', { class: 'albaran__firma' }, [
        el('div', { class: 'firma__zona' + (a.tieneFirma ? '' : ' firma__zona--vacia') }, [
          urlFirma ? el('img', { src: urlFirma, alt: 'Firma' }) : null,
        ].filter(Boolean)),
        el('div', { class: 'albaran__firmante' }, [
          el('span', { text: a.tieneFirma ? (a.firma.signer_name || 'Recibido conforme') : 'Recibido conforme' }),
          a.tieneFirma ? el('span', { class: 'tenue', text: fechaHora(a.firma.signed_at) }) : null,
        ].filter(Boolean)),
      ]),
      el('div', { class: 'albaran__firma' }, [
        el('div', { class: 'firma__zona firma__zona--vacia' }),
        el('div', { class: 'albaran__firmante' }, [el('span', { text: 'Firma y sello del repartidor' })]),
      ]),
    ]),

    el('footer', { class: 'albaran__pie' }, [
      el('div', {}, [
        el('b', { text: 'CONDICIONES GENERALES' }),
        el('div', { text: `Forma de pago: ${e.ventanaPago || 'Contado'}.` }),
        e.ventanaReclamacion
          ? el('div', { text: `Reclamaciones por defecto en ${e.ventanaReclamacion} horas desde la entrega.` })
          : null,
      ].filter(Boolean)),
      el('div', { class: 'albaran__gracias', text: '¡GRACIAS POR SU CONFIANZA!' }),
    ]),
  ].filter(Boolean))
}

const fila = (k, v) => el('div', { class: 'albaran__fila' }, [
  el('span', { text: k }), el('b', { text: v }),
])
const totalLine = (k, v, grande = false) => el('div', {
  class: `albaran__total ${grande ? 'albaran__total--final' : ''}`,
}, [el('span', { text: k }), el('b', { text: v })])

function dinero(v, sim) {
  return `${Number(v || 0).toLocaleString('es-ES', { maximumFractionDigits: 0 })} ${sim}`
}
function pct(t) {
  const n = Number(t || 0) * 100
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} %`
}
