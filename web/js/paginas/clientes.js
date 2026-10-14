import {
  el, panel, aviso, num, vacio, estado, campo, fecha, cargando, tabla, pintarFilas, modal, boton,
  historico, buscador,
} from '../ui.js'
import * as A from '../api.js'
import { abrirTarjeta, abrirLoteTarjetas } from './tarjeta.js'

/**
 * Clientes.
 *
 * La tarjeta con QR NO se dibuja aquí: eso es la Fase 6. Lo que sí existe es
 * el token, revocable desde esta misma pantalla, que es lo que hace útil esa
 * tarjeta cuando llegue.
 *
 * El token es opaco y no lleva ni el nombre ni el teléfono. Se enseña una vez,
 * al crearlo o al rotarlo, porque una tarjeta de cliente se pierde y hay que
 * poder anularla sin dar de alta a nadie.
 */

export async function paginaClientes() {
  const puedeEditar = A.puede('customers', 'edit')
  const caja = el('div', { class: 'pila' })
  const zona = el('div')

  async function pintar() {
    const clientes = await A.api('/customers')
    const cuerpo = el('tbody')
    pintarFilas(cuerpo, clientes, [
      { titulo: 'Código', render: (c) => el('code', { text: c.code }) },
      { titulo: 'Nombre', render: (c) => el('div', {}, [
        el('b', { text: c.name }),
        c.company_name ? el('div', { class: 'pequeno', text: c.company_name }) : null,
      ]) },
      { titulo: 'Contacto', render: (c) => el('div', { class: 'pequeno' }, [
        c.phone || '—', c.zone_name ? el('div', { text: c.zone_name }) : null,
      ]) },
      { titulo: 'Pendiente', render: (c) => el('span', {
        class: Number(c.qty_pending) > 0 ? 'estado estado--aviso' : 'estado',
        text: num(c.qty_pending, 0),
      }) },
      { titulo: 'Facturado', render: (c) => num(c.facturado, 2) },
      { titulo: '', render: (c) => el('div', { class: 'fila-botones' }, [
        el('button', {
          class: 'btn btn--mini', text: 'Ficha',
          onclick: () => ficha(c.id, pintar),
        }),
          // La tarjeta: un botón por cliente, porque es un objeto físico, uno
          // por persona. El lote se hace arriba, para cuando hay que imprimir
          // veinte de golpe.
          el('button', {
            class: 'btn btn--mini', text: 'Tarjeta',
            title: 'Ver e imprimir su tarjeta',
            onclick: () => abrirTarjeta(c.id, c),
          }),
          puedeEditar ? el('button', {
            class: 'btn btn--mini', text: 'Rotar QR',
            title: 'La tarjeta perdida deja de servir en el mismo instante',
            onclick: () => rotarQr(c),
          }) : null,
        ]) },
      ], 'No hay clientes dados de alta todavía.')

    zona.replaceChildren(tabla(
      ['Código', 'Nombre', 'Contacto', 'Pendiente', 'Facturado', ''], cuerpo))
  }

  caja.append(
      panel('Clientes', [
        puedeEditar
          ? boton('🖨 Tarjetas en lote', () => loteTarjetas(clientes), 'btn')
          : null,
        puedeEditar
          ? boton('+ Nuevo cliente', () => nuevoCliente(pintar), 'btn btn--principal')
          : null,
      ],
      el('div', { class: 'panel__cuerpo pila' }, [zona])),
  )

  try {
    await pintar()
  } catch (e) { zona.replaceChildren(aviso(e.message, 'error')) }
  return caja
}

async function nuevoCliente(recargar) {
  const f = {
    nombre: el('input', { placeholder: 'Nombre del cliente' }),
    empresa: el('input', { placeholder: 'Empresa (si es distinta)' }),
    tel: el('input', { placeholder: 'Teléfono', type: 'tel' }),
    email: el('input', { placeholder: 'correo@dominio.com', type: 'email' }),
    direccion: el('input', { placeholder: 'Dirección de entrega' }),
    notas: el('textarea', { rows: 2, placeholder: 'Cómo paga, cuándo entrega, quién recibe…' }),
  }
  // ── ZONA ──────────────────────────────────────────────────────────────────
  //
  // No se ofrece TODAS las zonas: se ofrecen las que esta persona puede usar,
  // según el backend. Un comercial sin zonas ve un desplegable vacío y un texto
  // que explica por qué, en vez de un desplegable lleno de opciones que al
  // guardar saltarían con un error.
  f.zona = el('select')
  let zonas = []
  let falloZonas = null
  try {
    zonas = await A.api('/mis-zonas')
  } catch (e) {
    falloZonas = e
    // Tres cosas MUY distintas se parecían a un mismo texto: que el servidor
    // estuviera caído, que este usuario no tenga permiso, o que la lista
    // simplemente viniera vacía. Con el mismo mensaje el que pierde tiempo es
    // el usuario, y el que decide sin saberlo es quien guarda un cliente sin
    // zona. Ahora cada caso dice el suyo.
    const sinPermiso = e.estado === 403
    const texto = sinPermiso
      ? 'No tienes permiso para ver las zonas'
      : e.estado === 0
        ? 'No se pudo contactar con el servidor'
        : 'No se han podido cargar las zonas'
    f.zona.replaceChildren(el('option', { value: '', text: texto }))
  }
  if (zonas.length) {
    f.zona.append(el('option', { value: '', text: '— elige zona —' }))
    for (const z of zonas) {
      f.zona.append(el('option', {
        value: String(z.id),
        text: `${z.name}${z.region ? ` · ${z.region}` : ''}`,
      }))
    }
  } else {
    f.zona.append(el('option', { value: '', text: '— sin zonas asignadas —' }))
  }

  const avisoZona = el('p', { class: 'pista' })
  if (!zonas.length) {
    avisoZona.textContent = 'No tienes ninguna zona asignada todavía, así que no '
      + 'puedes crear clientes. Pídele a un administrador que te asigne una zona.'
  }

  const capa = modal('Nuevo cliente', el('div', { class: 'pila' }, [
    campo('Nombre', f.nombre, true),
    campo('Zona', f.zona, true),
    avisoZona,
    campo('Empresa', f.empresa, true),
    el('div', { class: 'rejilla rejilla--2' }, [campo('Teléfono', f.tel), campo('Correo', f.email)]),
    campo('Dirección', f.direccion, true),
    campo('Notas', f.notas, true),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Crear', async () => {
      try {
        // Se comprueba aquí para que el error salga pegado al campo. El backend
        // lo vuelve a comprobar igual: esto es cortesía, no garantía.
        if (!f.zona.value) {
          // Distinguir por qué no hay zona es lo que evita que alguien se crea
          // que la empresa no tiene zonas cuando en realidad el servidor no
          // respondió. Sin este matiz, quien espera un cliente con prisa quita
          // la zona —que es obligatoria— y lo pierde por el camino, sin
          // entender por qué.
          const sinZonasPorFallo = falloZonas
          mostrarToken(null, null, sinZonasPorFallo
            ? `No se pudieron cargar las zonas (${sinZonasPorFallo.message}), así que no se puede comprobar `
              + 'cuál es la correcta. Recarga la página e inténtalo otra vez: no conviene dar de alta el '
              + 'cliente sin ella.'
            : zonas.length
              ? 'Elige la zona del cliente. Sin zona no hay forma de saber a quién '
                + 'pertenece ni cuánto vale el territorio.'
              : 'No puedes crear clientes sin una zona asignada.')
          return
        }
        const c = await A.api('/customers', { metodo: 'POST', cuerpo: {
          zone_id: Number(f.zona.value),
          name: f.nombre.value.trim(),
          company_name: f.empresa.value.trim() || null,
          phone: f.tel.value.trim() || null,
          email: f.email.value.trim() || null,
          address: f.direccion.value.trim() || null,
          notes: f.notas.value.trim() || null,
        } })
        capa.remove()
        await recargar()
        mostrarToken(c, 'Cliente creado. Guarda este token: es su tarjeta.')
      } catch (e) { mostrarToken(null, null, e.message) }
    }, 'btn btn--principal'),
  ])
  f.nombre.focus()
}

async function rotarQr(c) {
  if (!window.confirm(
    `¿Rotar la tarjeta de ${c.name}?\n\n`
    + 'La tarjeta antigua dejará de servir inmediatamente. Si aún la lleva el '
    + 'cliente, habrá que darle otra.',
  )) return
  try {
    const r = await A.api(`/customers/${c.id}/qr/regenerar`, { metodo: 'POST' })
    mostrarToken(r, 'Tarjeta nueva. La anterior ya no vale.')
  } catch (e) { mostrarToken(null, null, e.message) }
}

/** El token se enseña una sola vez, aquí. Después hay que regenerarlo. */
function mostrarToken(c, titulo, error = null) {
  if (error) { window.alert(error); return }
  const txt = `CS-${c.qr_token}`
  const capa = modal(titulo, el('div', { class: 'pila' }, [
    el('p', { class: 'pista' }, [
      'Este token es la tarjeta del cliente. No lleva su nombre ni su teléfono: ',
      'solo sirve para abrir su ficha. Si la tarjeta se pierde, vuelve aquí y ',
      'rota el token: la vieja deja de servir en el acto.',
    ]),
    el('div', { class: 'codigo-token' }, [el('code', { text: txt })]),
    el('p', { class: 'pequeno' }, ['La tarjeta imprimible llega en la Fase 6.']),
  ]), [boton('Cerrar', () => capa.remove())])
  document.body.append(capa)
  return capa
}

async function ficha(id, recargar) {
  const capa = modal('Ficha del cliente', cargando())
  try {
    const c = await A.api(`/customers/${id}`)
    const cuerpo = el('tbody')
    pintarFilas(cuerpo, c.pedidos, [
      { titulo: 'Pedido', render: (p) => el('code', { text: p.order_code }) },
      { titulo: 'Fecha', render: (p) => fecha(p.order_date) },
      { titulo: 'Estado', render: (p) => estadoPedido(p.status) },
      { titulo: 'Pedido', render: (p) => num(p.qty_ordered, 0) },
      { titulo: 'Servido', render: (p) => num(p.qty_delivered, 0) },
      { titulo: 'Pendiente', render: (p) => num(p.qty_pending, 0) },
      { titulo: 'Total', render: (p) => num(p.total, 2) },
    ], 'Este cliente todavía no ha pedido nada.')
    capa.querySelector('.capa__dialogo').replaceChildren(
      el('div', { class: 'panel__cabecera' }, [el('h2', { text: `${c.name}` })]),
      el('div', { class: 'panel__cuerpo pila' }, [
        el('div', { class: 'rejilla rejilla--3' }, [
          dato('Código', c.code),
          dato('Empresa', c.company_name || '—'),
          dato('Teléfono', c.phone || '—'),
          dato('Correo', c.email || '—'),
          dato('Dirección', c.address || '—'),
          dato('Zona', c.zone_name || '—'),
        ]),
        el('h3', { text: 'Historial de pedidos' }),
        tabla(['Pedido', 'Fecha', 'Estado', 'Pedido', 'Servido', 'Pendiente', 'Total'], cuerpo),
      ]),
      el('div', { class: 'panel__cuerpo pila pila--fin' }, [
        boton('Cerrar', () => capa.remove()),
      ]),
    )
  } catch (e) {
    capa.querySelector('.capa__dialogo').replaceChildren(
      el('div', { class: 'panel__cuerpo' }, [aviso(e.message, 'error')]))
  }
  return capa
}

const dato = (k, v) => el('div', {}, [
  el('div', { class: 'pequeno', text: k }),
  el('div', { text: v }),
])

const ESTADOS_PEDIDO = {
  DRAFT: ['Borrador', ''],
  CONFIRMED: ['Confirmado', 'marca'],
  RESERVED: ['Apartado', 'marca'],
  PREPARED: ['Preparado', 'aviso'],
  IN_ROUTE: ['En reparto', 'aviso'],
  DELIVERED: ['Entregado', 'bien'],
  CANCELLED: ['Anulado', 'peligro'],
}

export function estadoPedido(s) {
  const [t, tono] = ESTADOS_PEDIDO[s] || [s, '']
  return estado(t, tono)
}

/**
 * Imprimir varias tarjetas de una vez.
 *
 * Pregunta cuáles antes de imprimir: sacar veinte hojas cuando solo hacían
 * falta tres es la mitad del trabajo de quien las prepara. Se marca por
 * defecto a quien tiene algo pendiente, que es a quien todavía le va a hacer
 * falta la tarjeta.
 */
async function loteTarjetas(clientes) {
  if (!clientes.length) {
    return window.alert('Todavía no hay clientes.')
  }
  const conPendiente = clientes.filter((c) => Number(c.pendiente || 0) > 0)
  const preseleccionados = new Set((conPendiente.length ? conPendientes : clientes).map((c) => c.id))

  const casillas = new Map()
  const cuerpo = el('div', { class: 'pila' }, [
    el('p', { class: 'pista' }, [
      'Marca a quién se le imprime la tarjeta. Salen de tres en tres en un A4 ',
      'horizontal, en papel grueso.',
    ]),
    el('div', { class: 'pila' }, clientes.map((c) => {
      const marca = el('input', { type: 'checkbox' })
      marca.checked = preseleccionados.has(c.id)
      casillas.set(c.id, { marca, c })
      return el('label', { class: 'fila-check' }, [
        marca,
        el('code', { text: c.code }),
        el('span', { text: c.company_name || c.name }),
        Number(c.pendiente) > 0 ? el('span', { class: 'estado estado--aviso', text: 'pendiente' }) : null,
      ].filter(Boolean))
    })),
  ])

  const capa = modal('Tarjetas en lote', cuerpo, [
    boton('Cancelar', () => capa.remove()),
    boton('Preparar', () => {
      const ids = [...casillas.entries()].filter(([, v]) => v.marca.checked).map(([id]) => id)
      if (!ids.length) { window.alert('No has marcado ningún cliente.'); return }
      capa.remove()
      abrirLoteTarjetas(ids)
    }, 'btn btn--principal'),
  ])
  return capa
}
