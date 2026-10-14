import { el, panel, aviso, num, entero, vacio, estado, campo, protegido, cargando } from '../ui.js'
import * as A from '../api.js'

const MODULO = { RAW_MATERIAL: 'raw_materials', PACKAGING: 'packaging', FINISHED_GOOD: 'products' }
const TITULO_KIND = { RAW_MATERIAL: 'materia prima', PACKAGING: 'envase', FINISHED_GOOD: 'producto' }

/**
 * Una sola página para los tres catálogos, parametrizada por `category_kind`.
 * No hay tres implantaciones parecidas: hay una, y el tipo decide el permiso y
 * los campos. Es la misma razón por la que el backend tiene una sola tabla.
 */
export async function paginaCatalogo(_ctx, kind, titulo) {
  const modulo = MODULO[kind]
  const caja = el('div')
  const puedeCrear = A.puede(modulo, 'create')
  const puedeEditar = A.puede(modulo, 'edit')
  const puedeArchivar = A.puede(modulo, 'delete')

  const filtro = el('input', { type: 'search', placeholder: 'Buscar por nombre o SKU…', style: 'max-width:280px' })

  async function pintar() {
    const q = filtro.value.trim()
    const items = await A.api(`/items${q ? `?buscar=${encodeURIComponent(q)}` : ''}`)
    const mio = (caja.dataset.secuencia = String(Number(caja.dataset.secuencia || 0) + 1))
    if (caja.dataset.secuencia !== mio) return

    const mios = items.filter((i) => i.category_kind === kind)
    const cuerpo = el('div', { style: 'overflow-x:auto' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'SKU' }), el('th', { text: 'Nombre' }),
          el('th', { class: 'num', text: 'Stock' }), el('th', { class: 'num', text: 'Mínimo' }),
          el('th', { class: 'num', text: 'Coste' }),
          el('th', { class: 'num', text: 'Precio' }), el('th', { text: 'Estado' }),
          el('th', { class: 'centro', text: '' }),
        ])]),
        el('tbody', {}, mios.length ? mios.map((i) => fila(i, { puedeEditar, puedeArchivar, recargar: pintar }))
          : [el('tr', {}, [el('td', { colspan: 8 }, [vacio(`No hay ${TITULO_KIND[kind]}s todavía`, '📦')])])]),
      ]),
    ])

    caja.replaceChildren(panel(
      `${titulo} (${mios.length})`,
      [filtro, puedeCrear ? boton('+ Nuevo', () => formulario({ kind, modulo, recargar: pintar })) : null],
      cuerpo, true))
  }

  filtro.addEventListener('input', protegido(() => setTimeout(pintar, 250)))
  await pintar()
  return caja
}

function fila(item, { puedeEditar, puedeArchivar, recargar }) {
  const acciones = el('div', { class: 'pila' }, [
    puedeEditar ? boton('Editar', () => formulario({ item, recargar }), 'btn--mini') : null,
    puedeArchivar ? boton('Archivar', protegido(async () => {
      if (!confirm(`¿Archivar «${item.name}»?\n\nSi tiene existencias no se archivará: el sistema lo impide.`)) return
      const r = await A.api(`/items/${item.id}`, { metodo: 'DELETE' })
      aviso(r.mensaje, r.is_active ? 'aviso' : 'bien')
      recargar()
    }), 'btn--mini btn--peligro') : null,
  ].filter(Boolean))

  const bajo = Number(item.qty_available) < Number(item.min_stock)
  return el('tr', {}, [
    el('td', { class: 'mono', text: item.sku }),
    el('td', {}, [
      el('div', { text: item.name }),
      item.format_label ? el('div', { class: 'pequeno tenue', text: item.format_label }) : null,
    ]),
    el('td', { class: 'num' }, [num(item.qty_available)]),
    el('td', { class: 'num tenue' }, [num(item.min_stock, 0)]),
    el('td', { class: 'num tenue' }, [num(item.purchase_cost, 2)]),
    el('td', { class: 'num' }, [num(item.sale_price, 2)]),
    el('td', {}, [item.is_active
      ? (bajo ? estado('Bajo mínimo', 'peligro') : estado('Activo', 'bien'))
      : estado('Archivado', '')]),
    el('td', { class: 'centro' }, [acciones]),
  ])
}

function boton(texto, onclick, clase = 'btn') {
  return el('button', { class: clase, text: texto, onclick })
}

/** Formulario de alta/edición. Valida en cliente lo obvio; el backend valida el resto. */
async function formulario({ item = null, kind, modulo, recargar }) {
  const esNuevo = !item
  const [unidades, categorias] = await Promise.all([
    A.api('/units'),
    A.api('/item-categories').catch(() => []),
  ])

  const f = {
    sku: el('input', { value: item?.sku || '', required: true, disabled: !esNuevo,
      placeholder: 'RM-AGUA / ENV-BOT-500 / PT-LAV-500' }),
    name: el('input', { value: item?.name || '', required: true }),
    unit_id: el('select', {}, unidades.map((u) => el('option', {
      value: u.id, text: `${u.code}${u.name ? ' · ' + u.name : ''}`,
      selected: item ? u.id === item.unit_id : u.dimension === 'VOLUME' ? u.code === 'L' : false,
    }))),
    format_label: el('input', { value: item?.format_label || '', placeholder: '500 ml, 5 L, caja de 12…' }),
    min_stock: el('input', { type: 'number', step: 'any', min: '0', value: item?.min_stock ?? 0 }),
    purchase_cost: el('input', { type: 'number', step: 'any', min: '0', value: item?.purchase_cost ?? 0 }),
    sale_price: el('input', { type: 'number', step: 'any', min: '0', value: item?.sale_price ?? 0 }),
    notes: el('textarea', { rows: 2, text: item?.notes || '' }),
  }

  // ─── El SKU deducido del nombre ────────────────────────────────────────
  //
  // Se escribe el nombre y el código sale solo. Escribirlo a mano en cada alta
  // es donde se cuelan los dos errores caros: el mismo material con dos
  // códigos, porque nadie se acordaba del anterior, y un código mal tecleado
  // que ya no se puede cambiar porque hay etiquetas repartidas.
  //
  // Pero «automático» NO es «a ciegas». El campo se rellena solo y se puede
  // rectificar, y sobre todo avisa de dos cosas que solo se ven mirando el
  // catálogo entero: que el artículo YA EXISTE con ese nombre, y que el código
  // propuesto es el de otro material con otro nombre.
  const pistaSku = el('p', { class: 'pequeno' })
  let skuTocado = false
  let esperaSku = 0
  // Su propia cuenta de peticiones, y no la de la caja de la página: `caja` vive
  // en paginaCatalogo, no aquí, y pedirla prestada lanzaba un ReferenceError
  // en cuanto alguien tecleaba — el campo se quedaba vacío sin decir por qué.
  let skuEnVuelo = 0

  // Al SKU que se ha rellenado solo se le selecciona todo el texto al entrar.
  // Sin esto, quien viene a corregir «RM-ALCOH» hace clic y teclea encima, y
  // le sale «RM-ALCOHRM-MIALCOH» — un código nuevo, sin avisar, con etiquetas
  // impresas luego.
  let skuVieneDeFabrica = false
  f.sku.addEventListener('focus', () => { if (skuVieneDeFabrica) f.sku.select() })
  f.sku.addEventListener('input', () => { skuTocado = true; skuVieneDeFabrica = false })

  const pista = (texto, tono) => {
    pistaSku.textContent = texto || ''
    pistaSku.className = texto ? 'pequeno ' + (tono || 'tenue') : 'pequeno'
  }

  async function deducirSku() {
    if (!esNuevo) return
    const nombre = f.name.value.trim()
    // Con menos de dos palabras no hay nada que deducir todavía, y una
    // consulta por cada tecla es ruido. Se espera a que pare de teclear.
    if (nombre.length < 3) { if (!skuTocado) f.sku.value = ''; return }
    const mio = (skuEnVuelo += 1)
    try {
      const r = await A.api(
        `/items/sku-sugerido?nombre=${encodeURIComponent(nombre)}&tipo=${kind}`,
      )
      // Si mientras se esperaba la respuesta el nombre ha cambiado otra vez, la
      // respuesta que llega es de un nombre que ya no está en el campo: se tira.
      if (skuEnVuelo !== mio) return
      if (r.existente) {
        pista(`Ojo: «${r.existente.name}» ya existe con el código ${r.existente.sku}. `
          + 'Si es el mismo material, ciérralo y ábrelo del catálogo en vez de crear otro.', 'alerta--aviso')
        if (!skuTocado) { f.sku.value = r.existente.sku; skuVieneDeFabrica = true }
        return
      }
      if (!skuTocado && r.sku) { f.sku.value = r.sku; skuVieneDeFabrica = true }
      if (r.colision) {
        pista(`Ese código ya lo tiene otro material distinto. Si es otro artículo, `
          + `guarda como está; si es el mismo, no lo dupliques.`, 'alerta--aviso')
      } else if (r.sku) {
        pista('Código deducido del nombre. Puedes cambiarlo si prefieres otro.')
      } else {
        pista('')
      }
    } catch { pista('') }
  }


  if (categorias.length) {
    f.category_id = el('select', {}, [el('option', { value: '', text: '— sin subcategoría —' }),
      ...categorias.map((c) => el('option', { value: c.id, text: c.name, selected: item?.category_id === c.id }))])
  }

  const error = el('p', { class: 'alerta alerta--error oculto' })
  const guardar = boton(esNuevo ? 'Crear' : 'Guardar', protegido(async () => {
    error.classList.add('oculto')
    const cuerpo = {
      name: f.name.value.trim(),
      unit_id: Number(f.unit_id.value),
      format_label: f.format_label.value.trim() || null,
      min_stock: Number(f.min_stock.value || 0),
      purchase_cost: Number(f.purchase_cost.value || 0),
      sale_price: Number(f.sale_price.value || 0),
      notes: f.notes.value.trim() || null,
    }
    if (f.category_id) cuerpo.category_id = Number(f.category_id.value) || null
    try {
      if (esNuevo) {
        await A.api('/items', { metodo: 'POST', cuerpo: { ...cuerpo, sku: f.sku.value.trim().toUpperCase(), category_kind: kind } })
        aviso(`${cuerpo.name} creado`)
      } else {
        await A.api(`/items/${item.id}`, { metodo: 'PUT', cuerpo })
        aviso(`${cuerpo.name} actualizado`)
      }
      cerrar(); recargar()
    } catch (e) {
      error.textContent = e.message
      error.classList.remove('oculto')
    }
  }), 'btn btn--principal')

  const capa = el('div', { class: 'capa' }, [el('div', { class: 'capa__dialogo panel' }, [
    el('div', { class: 'panel__cabecera' }, [el('h2', { text: esNuevo ? 'Nuevo artículo' : `Editar ${item.sku}` })]),
    el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'rejilla rejilla--2' }, [
        campo('SKU', f.sku),
        campo('Nombre', f.name),
        esNuevo ? pistaSku : null,
        campo('Unidad de medida', f.unit_id),
        campo('Formato', f.format_label),
        campo('Mínimo en almacén', f.min_stock),
        campo('Coste de compra', f.purchase_cost),
        campo('Precio de venta', f.sale_price),
        f.category_id ? campo('Subcategoría', f.category_id) : null,
        campo('Notas', f.notes, true),
      ]),
      error,
    ]),
    el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' }, [
      boton('Cancelar', cerrar), guardar,
    ]),
  ])])
  // Los oyentes se enganchan AQUÍ, ya pasada toda la declaración, y no junto al
  // campo. Es lo mismo y funciona igual, pero si alguna vez el bloque de arriba
  // se mueve, el error sale en la línea del oyente y no en la de la declaración,
  // que es donde de verdad hay que mirar.
  f.name.addEventListener('input', () => {
    clearTimeout(esperaSku)
    esperaSku = setTimeout(() => deducirSku(), 400)
  })
  f.name.addEventListener('blur', () => deducirSku())

  document.body.append(capa)
  f.name.focus()

  function cerrar() { capa.remove() }
  capa.addEventListener('click', (ev) => { if (ev.target === capa) cerrar() })
}
