import {
  el, panel, aviso, num, entero, vacio, estado, campo, protegido, fechaHora, fecha, cargando,
  boton, buscador, modal, tabla,
} from '../ui.js'
import * as A from '../api.js'

/**
 * Producción.
 *
 * El orden de la pantalla ES el orden en que se piensa una fabricación:
 * producto → cantidad → qué va a salir y de qué lotes → confirmar.
 *
 * Y lo importante: el botón de fabricar no está activo hasta que el operario
 * ha visto el plan. No se puede fabricar «a ciegas».
 */
export async function paginaProduccion() {
  const caja = el('div')
  const puedeLanzar = A.puede('production', 'create')

  // ── Planificador ──
  const recetas = await A.api('/recipes')
  const activas = recetas.filter((r) => r.is_active)
  if (!activas.length) {
    return el('div', {}, [
      el('div', { class: 'panel' }, [el('div', { class: 'panel__cuerpo' }, [
        el('div', { class: 'alerta alerta--aviso' }, ['No hay ninguna receta activa. Créalas en «Recetas» antes de fabricar.']),
      ])]),
      historial(await A.api('/productions')),
    ])
  }

  // Escribir «lava» y tocar «Lavavajillas 500 ml · REC-0001», en vez de
  // recorrer un desplegable. Es la elección que más se repite cada día.
  const f = {
    receta: buscador({
      opciones: activas.map((r) => ({
        value: r.id,
        text: `${r.product_name} · ${r.format_label || ''}`.trim(),
        sub: `${r.code} (v${r.version})`,
      })),
      placeholder: 'Escribe el producto o la receta…',
      onChange: (v) => {
        const r = activas.find((x) => String(x.id) === String(v))
        f.cantidad.value = String(r?.base_qty || 500)
        calcular()
      },
    }),
    cantidad: el('input', { type: 'number', min: '1', step: '1', value: 500 }),
    caducidad: el('input', { type: 'date' }),
    notas: el('input', { placeholder: 'Observaciones de la partida' }),
  }
  const plan = el('div')
  const botonProducir = boton('Confirmar producción', () => fabricar(), 'btn btn--principal')
  botonProducir.disabled = true

  async function calcular() {
    const id = f.receta.value()
    const n = Number(f.cantidad.value)
    if (!id || !n || n <= 0) { plan.replaceChildren(); botonProducir.disabled = true; return }
    plan.replaceChildren(cargando('Calculando qué lotes se usarían…'))
    try {
      const p = await A.api('/productions/planificar', { metodo: 'POST', cuerpo: { recipeId: Number(id), cantidad: n } })
      plan.replaceChildren(planPanel(p, n))
      botonProducir.disabled = !p.suficiente
    } catch (e) {
      plan.replaceChildren(el('div', { class: 'alerta alerta--error', text: e.message }))
      botonProducir.disabled = true
    }
  }

  f.cantidad.addEventListener('input', () => setTimeout(calcular, 350))
  plan.addEventListener('click', (ev) => {
    // Al quitar un lote del plan hay que recalcular: el reparto cambia.
    if (ev.target.closest('[data-quitar-lote]')) calcular()
  })

  // ── Lo que hay que fabricar HOY ──────────────────────────────────────────
  // Encima de todo, solo lo pendiente. Abajo, lo ya hecho. Es la misma lógica
  // que en Apartado, Pedidos y Entregas: la lista de trabajo enseña lo que
  // queda por hacer, y lo hecho no desaparece, se aparta.
  const contPendientes = el('div')
  const contHistorial = el('div')

  async function recargarPendientes() {
    contPendientes.replaceChildren(cargando())
    const ordenes = await A.api('/productions/pendientes')
    contPendientes.replaceChildren(ordenes.length
      ? tablaOrdenes(ordenes, { recargar: recargarAmbas, puedeConfirmar: puedeLanzar })
      : vacio('No hay ninguna fabricación pendiente. Nada que hacer hoy.', '✓'))
  }

  async function recargarHistorial() {
    contHistorial.replaceChildren(cargando())
    // Solo lo TERMINADO. Sin este filtro el bloque de abajo repetiría las
    // órdenes que ya están arriba, en «Fabricaciones pendientes».
    contHistorial.replaceChildren(historial(await A.api('/productions?estado=COMPLETED')))
  }

  const recargarAmbas = () => Promise.all([recargarPendientes(), recargarHistorial()])

  caja.append(el('p', { class: 'pista' }, [
    'Lo de arriba es lo que hay que fabricar. Lo de abajo, lo ya hecho.',
  ]))
  caja.append(panel('Fabricaciones pendientes', null, contPendientes, true))
  caja.append(el('div', { style: 'height:20px' }))

  caja.append(panel('Fabricar ahora mismo', null, [
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Producto y receta', f.receta, true),
      campo('Unidades a fabricar', f.cantidad),
      campo('Caducidad del lote resultante', f.caducidad),
      campo('Observaciones', f.notas),
    ]),
    plan,
    el('div', { class: 'pila pila--fin', style: 'margin-top:14px' }, [botonProducir]),
  ]))

  async function fabricar() {
    botonProducir.disabled = true
    botonProducir.textContent = 'Fabricando…'
    try {
      const r = await A.api('/productions', { metodo: 'POST', cuerpo: {
        recipeId: Number(f.receta.value()),
        cantidad: Number(f.cantidad.value),
        caducidad: f.caducidad.value || null,
        notas: f.notas.value.trim() || null,
      } })
      aviso(r.mensaje)
      f.notas.value = ''
      await calcular()
      recargarHistorial()
    } catch (e) { aviso(e.message, 'error') }
    finally { botonProducir.textContent = 'Confirmar producción' }
  }

  caja.append(el('div', { style: 'height:20px' }))
  caja.append(contHistorial)
  await Promise.all([calcular(), recargarPendientes(), recargarHistorial()])
  return caja
}

/** Lo que se va a fabricar y de dónde sale: el corazón de la pantalla. */
function planPanel(p, cantidad) {
  const totalLotes = p.lineas.reduce((t, l) => t + l.reparto.length, 0)
  return el('div', { style: 'margin-top:16px' }, [
    el('div', { class: `alerta alerta--${p.suficiente ? 'bien' : 'error'}` }, [
      el('b', { text: p.suficiente
        ? `Se pueden fabricar ${entero(cantidad)} unidades.`
        : 'No se puede fabricar: falta materia prima.' }),
      el('div', { class: 'pequeno', text: `Salieron de ${totalLotes} lote(s), siempre el que caduca antes.` }),
    ]),
    el('table', { style: 'margin-top:10px' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Ingrediente' }),
        el('th', { class: 'num', text: 'Necesario' }),
        el('th', { class: 'num', text: 'Disponible' }),
        el('th', { text: 'De qué lotes sale' }),
      ])]),
      el('tbody', {}, p.lineas.map((l) => el('tr', {}, [
        el('td', {}, [
          el('div', { text: l.itemName }),
          el('div', { class: 'mono tenue', text: l.sku }),
          l.esCritica ? el('div', { class: 'pequeno', style: 'color:var(--peligro)', text: 'crítico' }) : null,
        ]),
        el('td', { class: 'num' }, [`${num(l.qtyAConsumir, 4)} ${l.unitCode}`]),
        el('td', { class: 'num' }, [l.suficiente
          ? el('span', { class: 'estado estado--bien', text: num(l.disponible, 4) })
          : el('span', { class: 'estado estado--peligro', text: `faltan ${num(l.falta, 4)}` })]),
        // (el reparto de lotes va en su propia columna, más adelante)
        el('td', {}, l.reparto.length
          ? el('div', {}, l.reparto.map((r) => el('div', { class: 'mono pequeno' }, [
              el('span', { text: r.code }),
              el('span', { class: 'tenue', text: ` → ${num(r.qty, 4)}` }),
              r.caducidad ? el('span', { class: 'tenue', text: ` (cad. ${fecha(r.caducidad)})` }) : null,
            ])))
          : el('span', { class: 'tenue', text: '—' })),
      ]))),
    ]),
  ])
}

function historial(producciones) {
  return panel('Producciones realizadas', null,
    producciones.length
      ? el('div', { style: 'overflow-x:auto' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Código' }), el('th', { text: 'Producto' }),
            el('th', { class: 'num', text: 'Unidades' }),
            el('th', { text: 'Lote resultante' }),
            el('th', { class: 'num', text: 'Lotes usados' }),
            el('th', { text: 'Fecha' }), el('th', { class: 'centro', text: '' }),
          ])]),
          el('tbody', {}, producciones.map((p) => el('tr', {}, [
            el('td', { class: 'mono', text: p.code }),
            el('td', {}, [el('div', { text: p.product_name }), el('div', { class: 'mono tenue', text: p.sku })]),
            el('td', { class: 'num' }, [num(p.actual_qty, 0)]),
            el('td', { class: 'mono', text: p.lot_code || '—' }),
            el('td', { class: 'num' }, [num(p.n_consumos, 0)]),
            el('td', { class: 'pequeno tenue', text: fechaHora(p.finished_at || p.started_at) }),
            el('td', { class: 'centro' }, [boton('Ver', () => detalle(p.id), 'btn btn--mini')]),
          ]))),
        ])])
      : vacio('Todavía no se ha fabricado nada', '🏭'),
    true)
}

async function detalle(id) {
  const p = await A.api(`/productions/${id}`)
  const capa = el('div', { class: 'capa' }, [el('div', { class: 'capa__dialogo panel', style: 'max-width:720px' }, [
    el('div', { class: 'panel__cabecera' }, [el('h2', { text: `Producción ${p.code}` })]),
    el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'rejilla rejilla--2' }, [
        campo('Producto', `${p.product_name} (${p.sku})`),
        campo('Unidades', num(p.actual_qty, 0)),
        campo('Lote resultante', p.lot?.code || '—'),
        campo('Terminada', fechaHora(p.finished_at)),
      ]),
      el('div', { class: 'separador' }),
      el('h3', { class: 'pequeno tenue' }, ['Trazabilidad: qué lote de qué materia prima se consumió']),
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Lote de origen' }), el('th', { text: 'Materia prima' }),
          el('th', { class: 'num', text: 'Teórico' }), el('th', { class: 'num', text: 'Consumido' }),
          el('th', { text: 'Caducidad' }),
        ])]),
        el('tbody', {}, p.consumos.map((c) => el('tr', {}, [
          el('td', { class: 'mono', text: c.lot_code }),
          el('td', {}, [el('div', { text: c.item_name }), el('div', { class: 'mono tenue', text: c.sku })]),
          el('td', { class: 'num tenue' }, [num(c.theoretical_qty, 4)]),
          el('td', { class: 'num' }, [num(c.actual_qty, 4), ' ', c.unit_code]),
          el('td', { class: 'pequeno tenue', text: fecha(c.expiry_date) }),
        ]))),
      ]),
      p.notes ? el('p', { class: 'pista', text: p.notes }) : null,
    ]),
    el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' },
      [boton('Cerrar', () => capa.remove())]),
  ])])
  document.body.append(capa)
  capa.addEventListener('click', (ev) => { if (ev.target === capa) capa.remove() })
}


// ═══════════════════════════════════════════════════════════════════════════
// Las órdenes que el planificador ha dejado
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La lista de trabajo del operario: qué hay que fabricar.
 *
 * Cada fila dice si hay material. Y si NO lo hay, lo dice en rojo y con
 * cuánto falta — la orden NO desaparece ni se cancela sola, porque cancelar en
 * silencio le quitaría al planificador la única señal de que hay un problema.
 */
function tablaOrdenes(ordenes, { recargar, puedeConfirmar }) {
  const cuerpo = el('tbody')
  for (const o of ordenes) {
    // La FILA entera abre la orden, no solo el botón.
    //
    // En un móvil de 390px esta tabla no cabe entera y hay que arrastrarla
    // para llegar al botón de la última columna. Con la fila pulsable da igual:
    // se toca donde sea. El botón se queda para quien venga con un ratón.
    cuerpo.append(el('tr', {
      class: 'fila-pulsable',
      onclick: () => abrirOrden(o, { recargar, puedeConfirmar }),
    }, [
      el('td', {}, [el('code', { text: o.code })]),
      el('td', {}, [
        el('b', { text: o.product_name || '—' }),
        el('div', { class: 'pequeno', text: [o.sku, o.format_label].filter(Boolean).join(' · ') }),
      ]),
      el('td', { class: 'num' }, [`${num(o.planned_qty, 0)}`, el('span', { class: 'solo-ancho', text: ' uds' })]),
      el('td', { class: 'pequeno tenue col-fecha', text: fechaHora(o.planned_at) }),
      el('td', { class: 'col-material' }, [el('div', { id: `material-${o.id}`, class: 'pequeno' }, ['comprobando…'])]),
      el('td', { class: 'centro' }, [
        boton('Ver', () => abrirOrden(o, { recargar, puedeConfirmar }), 'btn btn--mini'),
      ]),
    ]))
  }

  // El material se comprueba después de pintar, para que la lista aparezca de
  // inmediato y el operario no espere con la pantalla en blanco.
  for (const o of ordenes) {
    A.api(`/productions/${o.id}/plan`).then((c) => {
      const celda = document.getElementById(`material-${o.id}`)
      if (!celda) return
      celda.replaceChildren(c.falta_material
        ? el('span', {
            class: 'estado estado--peligro',
            text: `Faltan ${c.faltan.map((f) => `${num(f.falta, 2)} ${f.unidad || ''} de ${f.nombre}`).join(' · ')}`,
          })
        : el('span', { class: 'estado estado--bien', text: 'Material disponible' }))
    }).catch(() => {})
  }
  // `col-fecha` se oculta sola en pantallas estrechas. Con seis columnas, el
  // botón «Ver» quedaba fuera de la vista y había que arrastrar la tabla para
  // llegar a él: el flujo principal del operario, escondido.
  return tabla(['Código', 'Producto', 'Cantidad',
    { text: 'Planificada', clase: 'col-fecha' },
    { text: 'Material', clase: 'col-material' }, ''], cuerpo)
}

/**
 * Una orden pendiente en detalle: qué falta, y el botón de confirmar.
 *
 * Confirmar es lo ÚNICO que consume material. Hasta ese momento la mercancía
 * sigue en el almacén.
 */
async function abrirOrden(o, { recargar, puedeConfirmar }) {
  const c = await A.api(`/productions/${o.id}/plan`)
  const cuerpo = el('div', { class: 'pila' })

  cuerpo.append(c.falta_material
    ? el('div', { class: 'alerta alerta--error' }, [
      el('b', { text: '⚠ Material insuficiente' }),
      el('div', { class: 'pequeno', style: 'margin-top:6px' }, [
        ...c.faltan.flatMap((f, i) => [
          i > 0 ? el('br') : null,
          `${f.nombre}: faltan ${num(f.falta, 2)} ${f.unidad || ''} `
          + `(hay ${num(f.disponible, 2)}, hacen falta ${num(f.necesita, 2)})`,
        ]),
      ]),
      el('div', { class: 'pequeno', style: 'margin-top:8px' }, [
        'La orden sigue pendiente y no se ha cancelado. Se podrá fabricar en ',
        'cuanto llegue el material, o se puede cambiar la cantidad desde ',
        '«Planificar» si la partida ya no es la que se pidió.',
      ]),
    ])
    : el('div', { class: 'alerta alerta--bien' }, [
      `Hay material para fabricar ${num(c.planned_qty, 0)} unidades.`,
    ]))

  cuerpo.append(el('h3', { text: 'Material de la receta' }))
  cuerpo.append(tabla(
    ['Ingrediente', 'Necesario', 'Disponible'],
    (() => {
      const tb = el('tbody')
      for (const l of c.lineas) {
        const falta = Number(l.disponible) + 1e-9 < Number(l.qtyAConsumir)
        tb.append(el('tr', {}, [
          el('td', { text: l.itemName }),
          el('td', { class: 'num', text: `${num(l.qtyAConsumir, 2)} ${l.unitCode || ''}` }),
          el('td', { class: 'num' }, [el('span', {
            class: falta ? 'estado estado--peligro' : 'estado estado--bien',
            text: num(l.disponible, 2),
          })]),
        ]))
      }
      return tb
    })()))

  cuerpo.append(el('p', { class: 'pista' }, [
    'Al confirmar, el material sale del almacén y se crea el lote de producto ',
    'terminado. Hasta ese momento no se toca nada: planificar no mueve stock.',
  ]))

  const acciones = [boton('Cerrar', () => capa.remove())]
  if (puedeConfirmar && !c.falta_material) {
    acciones.unshift(boton('Confirmar fabricación', async (ev) => {
      const b = ev.currentTarget
      b.disabled = true
      b.textContent = 'Fabricando…'
      try {
        const r = await A.api(`/productions/${o.id}/confirmar`, { metodo: 'POST' })
        capa.remove()
        await recargar()
        window.alert(
          `Fabricación ${r.codigo} confirmada.\n\n`
          + `Lote de producto terminado: ${r.lote.code}\n`
          + `Materia prima consumida de ${r.consumos.length} lote(s).`)
      } catch (e) { window.alert(e.message); b.disabled = false; b.textContent = 'Confirmar fabricación' }
    }, 'btn btn--principal'))
  }

  const capa = modal(`${o.product_name} · ${o.code}`, cuerpo, acciones)
  return capa
}
