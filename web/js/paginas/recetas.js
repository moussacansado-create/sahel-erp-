import {
  el, panel, aviso, num, entero, vacio, estado, campo, protegido, fechaHora, fecha, cargando,
  modal, boton, tabla,
} from '../ui.js'
import * as A from '../api.js'

const KIND = { RAW_MATERIAL: 'Materia prima', PACKAGING: 'Envase', FINISHED_GOOD: 'Producto' }
const TONO = { RAW_MATERIAL: 'marca', PACKAGING: 'aviso', FINISHED_GOOD: 'bien' }

/**
 * Recetas.
 *
 * Se edita la receta COMPLETA de un producto, no un ingredientito suelto. Media
 * hora de cambios parciales es como una fórmula acaba con tres ingredientes
 * duplicados y nadie sabe cuál manda.
 */
export async function paginaRecetas() {
  const caja = el('div')
  const puedeEditar = A.puede('recipes', 'edit') || A.puede('production', 'edit')
  const items = await A.api('/items?activos=true')

  const buscador = el('input', { type: 'search', placeholder: 'Buscar producto…', style: 'max-width:260px' })
  const cuerpo = el('div')

  async function pintar() {
    const recetas = await A.api('/recipes')
    const q = buscador.value.trim().toLowerCase()
    const mias = recetas
      .filter((r) => r.is_active || !q)
      .filter((r) => !q || r.product_name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q))

    cuerpo.replaceChildren(mias.length
      ? el('div', {}, mias.map((r) => el('div', { class: 'panel' }, [
          el('div', { class: 'panel__cabecera' }, [
            el('div', {}, [
              el('h2', { text: r.product_name }),
              el('div', { class: 'pista' }, [
                el('span', { class: 'mono', text: r.sku }),
                el('span', { text: ` · ${r.code} · versión ${r.version}` }),
                r.is_active ? null : el('span', { text: ' · superseded' }),
              ]),
            ]),
            el('div', { class: 'pila' }, [
              r.is_active ? estado('Activa', 'bien') : estado('Histórica', ''),
              el('button', { class: 'btn btn--mini', text: 'Ver', onclick: () => verReceta(r.id) }),
              // Planear va AQUÍ, en la fila de SU receta, y no en la cabecera
              // del panel: en la cabecera todavía no se sabe cuál se quiere
              // fabricar.
              puedeEditar && r.is_active
                ? el('button', {
                    class: 'btn btn--mini', text: '▸ Planear',
                    onclick: () => planificar(r, items),
                  })
                : null,
              puedeEditar && r.is_active
                ? el('button', { class: 'btn btn--mini', text: 'Nueva versión', onclick: () => editarReceta(r, items, pintar) })
                : null,
            ].filter(Boolean)),
          ]),
          el('div', { class: 'panel__cuerpo' }, [
            el('p', { class: 'pequeno tenue' }, [
              `Para obtener `, el('b', { text: `${num(r.base_qty, 0)} ${r.sku.includes('PT') ? 'unidades' : ''}` }),
              ' hacen falta:',
            ]),
            el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Ingrediente' }), el('th', { text: 'Tipo' }),
                el('th', { class: 'num', text: `Por ${num(r.base_qty, 0)} uds` }),
                el('th', { class: 'num', text: 'Tolerancia' }),
                el('th', { text: 'Crítico' }),
              ])]),
              el('tbody', {}, (r.lineas || []).map((l) => el('tr', {}, [
                el('td', {}, [el('div', { text: l.item_name }), el('div', { class: 'mono tenue', text: l.sku })]),
                el('td', { class: 'pequeno' }, [estado(KIND[l.category_kind] || l.category_kind, TONO[l.category_kind] || '')]),
                el('td', { class: 'num' }, [num(l.qty_per_batch, 4), ' ', l.unit_code]),
                el('td', { class: 'num tenue' }, [Number(l.tolerance) ? `±${num(Number(l.tolerance) * 100, 1)} %` : '—']),
                el('td', {}, [l.is_critical ? estado('Sí', 'aviso') : el('span', { class: 'tenue', text: 'No' })]),
              ]))),
            ]),
            r.instructions ? el('p', { class: 'pista', text: r.instructions }) : null,
          ]),
        ])))
      : vacio('Ningún producto tiene receta todavía', '📐'))
  }

  buscador.addEventListener('input', () => setTimeout(pintar, 250))
  caja.append(panel('Recetas de fabricación', [buscador,
    puedeEditar ? boton('+ Nueva receta', () => nuevaReceta(items, pintar), 'btn btn--principal') : null], cuerpo))
  await pintar()
  return caja
}

async function verReceta(id) {
  const r = await A.api(`/recipes/${id}`)
  const items = await A.api('/items?activos=true')
  const c = el('input', { type: 'number', min: '1', step: '1', value: Math.round(Number(r.base_qty) / 10) || 100, style: 'max-width:120px' })
  const prev = el('div')
  async function calcular() {
    const n = Number(c.value)
    if (!n || n <= 0) { prev.replaceChildren(); return }
    try {
      const plan = await A.api(`/recipes/${r.id}/necesidades?cantidad=${n}`)
      prev.replaceChildren(el('div', { class: 'alerta alerta--aviso' }, [
        el('b', { text: `Para ${entero(n)} unidades:` }),
        el('ul', { style: 'margin:6px 0 0;padding-left:18px' }, plan.lineas.map((l) =>
          el('li', { class: l.suficiente ? '' : 'estado--peligro' }, [
            `${l.itemName}: ${num(l.qtyAConsumir, 4)} ${l.unitCode} — hay ${num(l.disponible, 4)}`,
            l.suficiente ? ' ✓' : ' ✗ FALTA',
          ]))),
        el('div', { class: 'pequeno', style: 'margin-top:6px', text: plan.suficiente ? 'Se puede fabricar.' : 'No se puede fabricar todavía.' }),
      ]))
    } catch (e) { prev.replaceChildren(el('div', { class: 'alerta alerta--error', text: e.message })) }
  }
  c.addEventListener('input', () => setTimeout(calcular, 300))
  modal(`${r.product_name} · ${r.code}`, [
    el('p', { class: 'pista' }, [`Receta base: ${num(r.base_qty, 0)} unidades. Cambia la cantidad y mira qué haría falta y de qué lotes.`]),
    el('div', { class: 'rejilla rejilla--2' }, [campo('Unidades a fabricar', c)]),
    prev,
  ], [boton('Cerrar', () => capa.remove()), boton('Calcular', calcular, 'btn btn--principal')])
  calcular()
}

function nuevaReceta(items, recargar) {
  const f = {
    producto: el('select', {}, items.filter((i) => i.category_kind === 'FINISHED_GOOD')
      .map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}` }))),
    base: el('input', { type: 'number', min: '1', step: '1', value: 1000 }),
    nombre: el('input', { placeholder: 'Nombre de la receta' }),
    instrucciones: el('textarea', { rows: 3, placeholder: 'Pasos de fabricación…' }),
  }
  const lineas = el('div')
  const ingredientes = items.filter((i) => i.category_kind !== 'FINISHED_GOOD')
  let n = 0
  function anadir() {
    n++
    const l = {
      item: el('select', {}, ingredientes.map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}` }))),
      qty: el('input', { type: 'number', step: 'any', min: '0.0001', value: 1 }),
      critico: el('input', { type: 'checkbox', checked: true }),
    }
    const fila = el('div', { class: 'linea-albaran' }, [
      el('div', { style: 'flex:3' }, [campo('Ingrediente', l.item)]),
      el('div', { style: 'flex:1' }, [campo(`Por ${f.base.value || 1000} uds`, l.qty)]),
      el('div', { style: 'display:flex;align-items:center;gap:5px;padding-bottom:22px' }, [
        l.critico, el('span', { class: 'pequeno', text: 'crítico' }),
      ]),
      el('div', { style: 'display:flex;align-items:flex-end;padding-bottom:2px' }, [
        boton('Quitar', () => fila.remove(), 'btn btn--mini'),
      ]),
    ])
    lineas.append(fila)
  }
  anadir()
  const err = el('p', { class: 'alerta alerta--error oculto' })

  const capa = modal('Nueva receta', [
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Producto a fabricar', f.producto, true),
      campo('Nombre', f.nombre),
      campo('Unidades por lote', f.base),
    ]),
    el('div', { class: 'separador' }),
    el('h3', { class: 'pequeno tenue' }, ['Ingredientes']),
    lineas,
    el('div', { style: 'margin-top:8px' }, [boton('+ Añadir ingrediente', anadir)]),
    el('div', { class: 'separador' }),
    campo('Instrucciones', f.instrucciones, true),
    err,
  ], [
    boton('Cancelar', () => capa.remove()),
    boton('Crear receta', protegido(async () => {
      err.classList.add('oculto')
      const cuerpo = {
        product_id: Number(f.producto.value),
        base_qty: Number(f.base.value),
        name: f.nombre.value.trim() || null,
        instructions: f.instrucciones.value.trim() || null,
        lineas: [...lineas.querySelectorAll('.linea-albaran')].map((fila) => ({
          item_id: Number(fila.querySelector('select').value),
          qty_per_batch: Number(fila.querySelector('input[type=number]').value),
          unit_id: null,
          is_critical: fila.querySelector('input[type=checkbox]').checked,
        })),
      }
      try {
        const r = await A.api('/recipes', { metodo: 'POST', cuerpo })
        aviso(`Receta ${r.code} creada`)
        capa.remove(); recargar()
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }), 'btn btn--principal'),
  ])
}

function editarReceta(receta, items, recargar) {
  // Se reconstruye el formulario con la receta actual cargada.
  A.api(`/recipes/${receta.id}`).then((r) => {
    const c = {
      base: el('input', { type: 'number', min: '1', step: '1', value: r.base_qty }),
      instrucciones: el('textarea', { rows: 3 }, [r.instructions || '']),
    }
    const ingredientes = items.filter((i) => i.category_kind !== 'FINISHED_GOOD')
    const lineas = el('div')
    const lineasApi = r.lineas
    function pintarLineas() {
      lineas.replaceChildren(...lineasApi.map((l) => {
        const item = el('select', {}, ingredientes.map((i) =>
          el('option', { value: i.id, text: `${i.sku} · ${i.name}`, selected: i.id === l.item_id })))
        const qty = el('input', { type: 'number', step: 'any', min: '0.0001', value: l.qty_per_batch })
        const critico = el('input', { type: 'checkbox', checked: l.is_critical })
        const fila = el('div', { class: 'linea-albaran' }, [
          el('div', { style: 'flex:3' }, [campo('Ingrediente', item)]),
          el('div', { style: 'flex:1' }, [campo('Cantidad', qty)]),
          el('div', { style: 'display:flex;align-items:center;gap:5px;padding-bottom:22px' }, [critico, el('span', { class: 'pequeno', text: 'crítico' })]),
          el('div', { style: 'display:flex;align-items:flex-end;padding-bottom:2px' }, [
            boton('Quitar', () => { fila.remove(); }, 'btn btn--mini'),
          ]),
        ])
        fila.leer = () => ({ item_id: Number(item.value), qty_per_batch: Number(qty.value), unit_id: null, is_critical: critico.checked })
        return fila
      }))
    }
    pintarLineas()
    const err = el('p', { class: 'alerta alerta--error oculto' })

    const capa = modal(`Nueva versión de ${r.product_name}`, [
      el('div', { class: 'alerta alerta--info' }, [
        `La versión actual (${r.code}, v${r.version}) seguirá existiendo intacta. `,
        'Las producciones ya hechas seguirán apuntando a ella.',
      ]),
      el('div', { class: 'rejilla rejilla--2' }, [campo('Unidades por lote', c.base)]),
      el('div', { class: 'separador' }),
      lineas,
      el('div', { style: 'margin-top:8px' }, [boton('+ Añadir ingrediente', () => {
        const nuevo = { item_id: ingredientes[0].id, qty_per_batch: 1, is_critical: true, unit_id: null }
        lineasApi.push(nuevo); pintarLineas()
      })]),
      el('div', { class: 'separador' }),
      campo('Instrucciones', c.instrucciones, true),
      err,
    ], [
      boton('Cancelar', () => capa.remove()),
      boton('Guardar versión nueva', protegido(async () => {
        err.classList.add('oculto')
        const filas = [...lineas.querySelectorAll('.linea-albaran')].map((f) => f.leer ? f.leer() : {})
        try {
          const nueva = await A.api(`/recipes/${r.id}`, { metodo: 'PUT', cuerpo: {
            base_qty: Number(c.base.value), instructions: c.instrucciones.value, lineas: filas,
          } })
          aviso(`Versión ${nueva.version} creada. La anterior sigue en el histórico.`)
          capa.remove(); recargar()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }), 'btn btn--principal'),
    ])
  }).catch((e) => aviso(e.message, 'error'))
}

/**
 * Planear una fabricación desde la propia receta.
 *
 * Es el punto de partida de todo el flujo: quien programa dice «este producto,
 * esta cantidad» y la orden aparece arriba en la pantalla de Producción. Aquí
 * no se toca ni un gramo de material: la mercancía sigue en el almacén hasta
 * que el operario confirme.
 */
function planificar(receta, items) {
  const f = {
    cantidad: el('input', { type: 'number', min: '1', step: '1', value: receta.base_qty || 1000 }),
    notas: el('input', { placeholder: 'Para cuándo es, remarks, quién lo pidió…' }),
  }
  const prevision = el('div')

  async function calcular() {
    const n = Number(f.cantidad.value)
    if (!n || n <= 0) { prevision.replaceChildren(); return }
    prevision.replaceChildren(cargando('Calculando…'))
    try {
      const p = await A.api('/productions/planificar', {
        metodo: 'POST', cuerpo: { recipeId: receta.id, cantidad: n },
      })
      prevision.replaceChildren(planMiniatura(p, n))
    } catch (e) {
      prevision.replaceChildren(el('div', { class: 'alerta alerta--error', text: e.message }))
    }
  }
  f.cantidad.addEventListener('input', () => setTimeout(calcular, 350))

  const capa = modal(`Planear · ${receta.product_name}`, el('div', { class: 'pila' }, [
    el('p', { class: 'pista' }, [
      'Crea una orden pendiente para Producción. NO se consume material todavía: ',
      'eso pasa al confirmar la fabricación, que es cuando la mercancía sale ',
      'de fábrica.',
    ]),
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Unidades a fabricar', f.cantidad),
      campo('Observaciones', f.notas, true),
    ]),
    prevision,
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Crear orden pendiente', async () => {
      const n = Number(f.cantidad.value)
      if (!n || n <= 0) { window.alert('La cantidad tiene que ser mayor que cero.'); return }
      try {
        const o = await A.api('/productions/plan', {
          metodo: 'POST',
          cuerpo: { recipeId: receta.id, cantidad: n, notas: f.notas.value.trim() || null },
        })
        capa.remove()
        window.alert(
          `Orden ${o.code} creada.\n\n`
          + 'Aparece en Producción → Fabricaciones pendientes.\n'
          + 'El material sigue en el almacén: no se toca nada hasta que confirmen.')
        window.location.hash = '#/produccion'
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
  calcular()
}

/** Vista previa dentro del modal de planificar: qué hace falta y de qué lotes. */
function planMiniatura(p, cantidad) {
  return el('div', { class: 'pila' }, [
    el('div', { class: `alerta alerta--${p.suficiente ? 'bien' : 'aviso'}` }, [
      p.suficiente
        ? `Hay material para ${entero(cantidad)} unidades. La orden se puede confirmar.`
        : '⚠ Faltará material cuando llegue el momento. La orden se creará igualmente ',
    ]),
    tabla(['Ingrediente', 'Necesario', 'Disponible'], (() => {
      const tb = el('tbody')
      for (const l of p.lineas) {
        const falta = Number(l.disponible) < Number(l.qtyAConsumir)
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
    })()),
  ])
}
