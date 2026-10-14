import { el, panel, aviso, campo, modal, boton as _b, protegido } from '../ui.js'
import * as A from '../api.js'

/**
 * CONFIGURACIÓN GENERAL DE SAHEL.
 *
 * ── POR QUÉ NO ES UN FORMULARIO DE CAMPOS SUELTOS ────────────────────────────
 *
 * Cada apartado está conectado a algo que YA hace el sistema:
 *
 *   · Empresa  → albaranes, etiquetas, membretes. El símbolo de la moneda sale
 *                de aquí y de ningún otro sitio.
 *   · Series   → `fn_siguiente_serie()`. Lo que se cambia aquí es lo que
 *                numera los lotes mañana.
 *   · Numeración → el ejercicio en curso. Cambiarlo abre la serie nueva.
 *
 * Un ajuste que no cambia ningún comportamiento no se enseña: sería un campo
 * decorativo que alguien acabaría creyendo que funciona.
 *
 * ── LO QUE NO SE PUEDE HACER DESDE AQUÍ ─────────────────────────────────────
 *
 * No se renumeran lotes existentes. El prefijo nuevo solo afecta a lo que se
 * numeré a partir de ahora, y la pantalla lo dice antes de guardar. Los lotes
 * de 2024 seguirán siendo `PT-DES-00001` porque esas botellas ya salieron de
 * fábrica.
 */
const boton = (t, f, c = 'btn') => _b(t, f, c)

export async function paginaConfig() {
  const raiz = el('div', { class: 'pila pila--grande' })

  if (!A.puede('settings', 'view')) {
    return panel('Configuración', null, el('div', { class: 'panel__cuerpo' }, [
      aviso('Tu rol no puede ver la configuración de la aplicación.', 'aviso'),
    ]))
  }

  let datos
  try {
    datos = await A.api('/config')
  } catch (e) {
    return panel('Configuración', null, el('div', { class: 'panel__cuerpo' }, [
      aviso('No se pudo cargar la configuración: ' + e.message, 'error'),
    ]))
  }

  const puedeEditar = A.puede('settings', 'edit')
  const recargar = async () => { const p = await paginaConfig(); raiz.replaceWith(p) }

  // Para el apartado de cajas hacen falta dos cosas más: qué formatos hay y
  // sobre qué productos se pueden crear. Van en su propia llamada, no dentro
  // de `/config`, porque quien mira Ajustes sin permiso de editar las cajas
  // igual tiene que verlas para montar un pedido.
  try {
    datos.cajas = await A.api('/config/formatos')
    const todos = await A.api('/items?limite=200')
    const lista = Array.isArray(todos) ? todos : (todos.data || todos.items || [])
    datos.productosTerminados = lista
      .filter((i) => i.category_kind === 'FINISHED_GOOD')
      .map((i) => ({ id: i.id, sku: i.sku, name: i.name }))
  } catch (e) {
    datos.cajas = []
    datos.productosTerminados = []
  }

  // ═══ EMPRESA ═══════════════════════════════════════════════════════════════
  const empresa = datos.empresa
  const camposEmpresa = {}
  const FIJOS = [
    ['nombre', 'Nombre comercial', 'SAHEL'],
    ['descriptor', 'Descriptor', "PRODUITS D'HYGIÈNE"],
    ['cif', 'CIF / Identificación fiscal', 'ML12345678'],
    ['direccion', 'Dirección', 'Av. de la Liberté 123, Bamako'],
    ['telefono', 'Teléfono', '+223 76 00 00 00'],
    ['email', 'Correo', 'contacto@sahel.ml'],
    ['web', 'Web', 'sahel.ml'],
    ['moneda', 'Código de moneda (ISO)', 'XOF'],
    ['simbolo', 'Símbolo que se imprime', 'FCFA'],
    ['iva', 'IVA', '0.21'],
  ]
  const cuerpoEmpresa = el('div', { class: 'rejilla rejilla--2' }, FIJOS.map(([k, etiqueta, ejemplo]) => {
    const cfg = empresa['empresa.' + k]
    const v = cfg ? cfg.value : (ejemplo ?? '')
    const control = (k === 'iva')
      ? el('input', { type: 'number', step: '0.01', min: '0', max: '1', value: v })
      : el('input', { value: v === null ? '' : v })
    camposEmpresa[k] = control
    return campo(etiqueta, control)
  }))
  cuerpoEmpresa.append(
    el('p', { class: 'pista' },
      'La moneda y su símbolo van separados a propósito: el código sirve para '
      + 'ordenar y calcular, el símbolo para imprimir. Confundirlos fue el error '
      + 'de la aplicación antigua.'),
  )

  raiz.append(panel('Datos de la empresa', null, el('div', { class: 'panel__cuerpo pila' }, [
    cuerpoEmpresa,
    puedeEditar
      ? el('div', { class: 'pila pila--fin' }, [boton('Guardar empresa', protegido(async () => {
        const cambios = {}
        for (const [k, c] of Object.entries(camposEmpresa)) {
          cambios['empresa.' + k] = (k === 'iva') ? Number(c.value) : c.value
        }
        try {
          await A.api('/config/empresa', { metodo: 'PUT', cuerpo: cambios })
          aviso('Empresa guardada. Los albaranes y las etiquetas ya salen con estos datos.')
          await recargar()
        } catch (e) { aviso(e.message, 'error') }
      }), 'btn btn--principal')])
      : el('p', { class: 'pista', text: 'Solo lectura: tu rol no administra la configuración.' }),
  ])))

  // ═══ NUMERACIÓN ════════════════════════════════════════════════════════════
  const fNum = {
    anio: el('input', { type: 'number', min: '2020', max: '2100', value: datos.anio }),
    reinicio: el('input', { type: 'checkbox' }),
  }
  const cfgRein = empresa['numeracion.reinicio_anual']
  fNum.reinicio.checked = cfgRein ? cfgRein.value !== false : true

  raiz.append(panel('Ejercicio y reinicio de numeración', null, el('div', { class: 'panel__cuerpo pila' }, [
    el('div', { class: 'rejilla rejilla--2' }, [
      campo('Ejercicio en curso', fNum.anio),
      el('div', { class: 'pila' }, [
        el('label', { class: 'etiqueta', text: 'Reinicio anual' }),
        el('div', { class: 'fila-fila' }, [fNum.reinicio, el('span', { text: 'cada serie vuelve a empezar en 1' })]),
      ]),
    ]),
    el('div', { class: 'alerta alerta--aviso' }, [
      el('b', { text: 'Cambiar de ejercicio no borra nada. ' }),
      'La serie nueva empieza en 000001 y la anterior se queda donde estaba, '
      + 'con su historial. Los lotes de años pasados conservan su código.',
    ]),
    puedeEditar
      ? el('div', { class: 'pila pila--fin' }, [boton('Guardar ejercicio', protegido(async () => {
        try {
          await A.api('/config/numeracion', {
            metodo: 'PUT',
            cuerpo: { anio: Number(fNum.anio.value), reinicio_anual: fNum.reinicio.checked },
          })
          aviso('Ejercicio actualizado.')
          await recargar()
        } catch (e) { aviso(e.message, 'error') }
      }), 'btn btn--principal')])
      : null,
  ])))

  // ═══ SERIES ════════════════════════════════════════════════════════════════
  const CLASSES = {
    PRODUCTO: 'Producto terminado', MATERIA_PRIMA: 'Materia prima',
    ENVASE: 'Envases y embalaje', ENTRADA: 'Entrada de mercancía',
    FABRICACION: 'Orden de fabricación', PEDIDO: 'Pedido de venta',
    ALBARAN: 'Albarán', DOCUMENTO: 'Documento',
  }
  const cuerpoSeries = el('div', { class: 'pila' })
  let porClase = new Map()
  for (const s of datos.series) {
    if (!porClase.has(s.clase)) porClase.set(s.clase, [])
    porClase.get(s.clase).push(s)
  }
  for (const [clase, lista] of porClase) {
    cuerpoSeries.append(el('h3', { class: 'sub', text: CLASSES[clase] || clase }))
    cuerpoSeries.append(el('div', { class: 'rejilla rejilla--3' }, lista.map((s) => {
      const ejemplo = s.con_anio
        ? `${s.prefijo}-${datos.anio}-${'0'.repeat(s.digitos)}`
        : `${s.prefijo}-${'0'.repeat(s.digitos)}`
      return el('div', { class: 'serie' + (s.is_active ? '' : ' serie--off') }, [
        el('div', { class: 'serie__cabeza' }, [
          el('strong', { text: s.codigo }),
          el('span', { class: 'pastilla pastilla--dato', text: `siguiente: ${s.prefijo}-${s.anio || datos.anio}-${String(s.ultimo_valor + 1).padStart(s.digitos, '0')}` }),
        ]),
        el('div', { class: 'tenue mono', text: ejemplo }),
        el('div', { class: 'tenue', text: `${s.digitos} dígitos · ${s.con_anio ? 'con año' : 'sin año'} · ${s.consumido_anio ?? 0} este ejercicio` }),
        s.prefijo_anterior
          ? el('div', { class: 'serie__aviso', text: `Antes se numeraba «${s.prefijo_anterior}». Los lotes antiguos lo conservan.` })
          : null,
        puedeEditar ? el('div', { class: 'serie__botones' }, [
          boton('Editar', () => abrirSerie(s, recargar), 'btn btn--mini'),
          s.is_active
            ? boton('Pausar', () => guardarSerie(s, { is_active: false }, recargar), 'btn btn--mini')
            : boton('Reactivar', () => guardarSerie(s, { is_active: true }, recargar), 'btn btn--mini'),
        ]) : null,
      ])
    })))
  }

  raiz.append(panel('Series de numeración', null, el('div', { class: 'panel__cuerpo pila' }, [
    el('p', { class: 'pista' },
      'Cada serie lleva su propio contador y su propio ejercicio. Cambiar un '
      + 'prefijo NO reescribe los lotes ya existentes: solo afecta a lo que se '
      + 'numere a partir de ahora.'),
    cuerpoSeries,
    puedeEditar ? el('div', { class: 'pila pila--fin' }, [
      boton('+ Serie nueva', () => abrirSerie(null, recargar), 'btn btn--principal'),
    ]) : null,
  ])))

  // ═══ HISTÓRICO DE NUMERACIÓN ═══════════════════════════════════════════════
  const histo = el('div', { class: 'pila' })
  try {
    const hs = await A.api('/config/series/historial')
    histo.append(hs.length
      ? el('div', { class: 'rejilla rejilla--3' }, hs.slice(0, 30).map((h) => el('div', { class: 'serie' }, [
        el('strong', { text: `${h.serie} · ${h.anio}` }),
        el('div', { class: 'tenue', text: `hasta el ${h.ultimo_valor} · abierto el ${String(h.abierto_at).slice(0, 10)}` }),
      ])))
      : el('p', { class: 'pista', text: 'Todavía no se ha abierto ningún ejercicio.' }))
  } catch { histo.append(aviso('No se pudo cargar el historial.', 'error')) }

  raiz.append(panel('Historial de numeración', null, el('div', { class: 'panel__cuerpo' }, [histo])))

  // ═══ ETIQUETAS ═════════════════════════════════════════════════════════════
  raiz.append(panel('Formatos de etiqueta', null, el('div', { class: 'panel__cuerpo pila' }, [
    el('p', { class: 'pista', text: 'Los formatos disponibles. Los campos que no caben se avisan antes de imprimir.' }),
    el('div', { class: 'rejilla rejilla--3' }, datos.formatos.map((f) => el('div', { class: 'serie' }, [
      el('strong', { text: f.nombre }),
      el('div', { class: 'tenue', text: f.omitidos.length ? `No cabe: ${f.omitidos.join(', ')}` : 'Cabe todo' }),
    ]))),
  ])))

  raiz.append(raizFormatos(datos, puedeEditar, recargar))

  return raiz
}

/**
 * ═══ FORMATOS DE VENTA (CAJAS) ═════════════════════════════════════════════
 *
 * Una caja NO es un artículo. No se fabrica, no entra por almacén y no se
 * descuenta: el almacén sigue contando botellas. Aquí solo se dice cuántas
 * botellas lleva una caja y cuánto vale.
 *
 * Por eso este apartado va en Ajustes y no en el catálogo. Y por eso el
 * precio se puede cambiar sin miedo: los pedidos ya hechos guardan una copia
 * del nombre, las unidades y el precio, así que sus albaranes no se mueven.
 */
function raizFormatos(datos, puedeEditar, recargar) {
  const cuerpo = el('div', { class: 'pila' })

  const producto = el('select', {})
  const soloTerminados = (datos.productosTerminados || [])
    .map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}` }))

  if (!soloTerminados.length) {
    cuerpo.append(el('p', { class: 'pista', text: 'No hay producto terminado. Las cajas se configuran sobre producto que se vende.' }))
    return panel('Formatos de venta (cajas)', null, cuerpo)
  }
  producto.append(...soloTerminados)

  // Se agrupan por producto: una lista plana de cuarenta cajas es
  // ilegible, y quien las configura las reconoce por producto.
  const porProducto = new Map()
  for (const f of (datos.cajas || [])) {
    if (!porProducto.has(f.item_id)) porProducto.set(f.item_id, [])
    porProducto.get(f.item_id).push(f)
  }

  const lista = el('div', { class: 'pila' })
  for (const [id, formatos] of porProducto) {
    const art = soloTerminados.find((i) => String(i.id) === String(id))
    lista.append(el('div', { class: 'pila pila--fin' }, [
      el('h3', { text: art ? `${art.sku} · ${art.name}` : `Producto ${id}` }),
      el('div', { class: 'rejilla rejilla--3' }, formatos.map((f) => el('div', { class: 'serie' + (f.is_active ? '' : ' serie--inactiva') }, [
        el('strong', { text: f.name }),
        el('div', { class: 'tenue', text: `${f.units_per_format} uds · ${f.price == null ? 'precio de la ficha' : f.price}` }),
        f.is_active
          ? null
          : el('div', { class: 'tenue', text: 'Desactivado' }),
        puedeEditar
          ? el('div', { class: 'fila-fila' }, [
            boton('Editar', () => ventanaFormato(f, datos, puedeEditar, recargar), 'btn btn--pequeno'),
            f.is_active
              ? boton('Desactivar', async () => {
                try {
                  await A.api(`/config/formatos/${f.id}`, { metodo: 'DELETE' })
                  aviso(`«${f.name}» ya no se puede pedir. Los pedidos antiguos lo conservan.`)
                  await recargar()
                } catch (e) { aviso(e.message, 'error') }
              }, 'btn btn--pequeno')
              : null,
          ])
          : null,
      ]))),
    ]))
  }
  if (!porProducto.size) {
    lista.append(el('p', { class: 'pista', text: 'Todavía no hay ninguna caja configurada.' }))
  }

  cuerpo.append(
    el('p', { class: 'pista', text: 'Una caja es una forma de vender. El inventario sigue contando botellas: 2 cajas de 12 descuentan 24.' }),
    puedeEditar
      ? el('div', { class: 'fila-fila' }, [boton('Nueva caja', () => ventanaFormato(null, datos, puedeEditar, recargar), 'btn btn--principal')])
      : null,
    lista,
  )

  return panel('Formatos de venta (cajas)', null, cuerpo)
}

/** Alta y edición de un formato. `s` es null cuando es uno nuevo. */
function ventanaFormato(s, datos, puedeEditar, recargar) {
  const f = {
    name: el('input', { value: s ? s.name : '', placeholder: 'Caja de 12' }),
    unidades: el('input', { type: 'number', min: '1', step: '1', value: s ? s.units_per_format : '' }),
    precio: el('input', { type: 'number', min: '0', step: '0.01', value: s && s.price != null ? s.price : '' }),
    iva: el('input', { type: 'number', min: '0', step: '0.0001', value: s && s.tax_rate != null ? s.tax_rate : '' }),
    producto: el('select', {}),
  }
  f.producto.append(...(datos.productosTerminados || [])
    .map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}` })))
  if (s) f.producto.value = String(s.item_id)
  f.producto.disabled = !!s

  const err = el('p', { class: 'alerta alerta--error oculto' })
  const vista = el('p', { class: 'pista' })
  const refrescarVista = () => {
    const u = Number(f.unidades.value || 0)
    const c = Number(f.precio.value || 0)
    vista.textContent = u > 0 && c > 0
      ? `1 caja = ${u} uds · 2 cajas = ${u * 2} uds por ${(c * 2).toLocaleString('es-ES')} `
      : 'Pon las unidades y el precio para ver lo que sale.'
  }
  f.unidades.addEventListener('input', refrescarVista)
  f.precio.addEventListener('input', refrescarVista)
  refrescarVista()

  const capa = modal(s ? `Editar «${s.name}»` : 'Nueva caja', el('div', { class: 'pila' }, [
    campo('Nombre', f.name),
    campo('Producto', f.producto),
    campo('Botellas por caja', f.unidades),
    campo('Precio de la caja', f.precio),
    campo('IVA (si lo dejas vacío, el del producto)', f.iva),
    vista,
    el('p', { class: 'pista', text: 'Cambiar el precio no toca los pedidos ya emitidos: cada albarán guarda el que tenía el día que se pidió.' }),
    err,
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton(s ? 'Guardar' : 'Crear caja', async () => {
      err.classList.add('oculto')
      const cuerpo = {
        name: f.name.value.trim(),
        units_per_format: Number(f.unidades.value),
        price: f.precio.value === '' ? null : Number(f.precio.value),
        tax_rate: f.iva.value === '' ? null : Number(f.iva.value),
      }
      if (!s) cuerpo.item_id = Number(f.producto.value)
      if (!cuerpo.name) { err.textContent = 'La caja necesita un nombre.'; err.classList.remove('oculto'); return }
      if (!(cuerpo.units_per_format > 0) || !Number.isInteger(cuerpo.units_per_format)) {
        err.textContent = 'Las botellas por caja tienen que ser un número entero mayor que cero.'
        err.classList.remove('oculto'); return
      }
      try {
        if (s) await A.api(`/config/formatos/${s.id}`, { metodo: 'PUT', cuerpo })
        else await A.api('/config/formatos', { metodo: 'POST', cuerpo })
        capa.remove()
        aviso(s ? 'Caja actualizada.' : 'Caja creada. Ya se puede vender así.')
        await recargar()
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }, 'btn btn--principal'),
  ])
}

async function guardarSerie(s, cambios, recargar) {
  try {
    await A.api(`/config/series/${s.codigo}`, { metodo: 'PUT', cuerpo: cambios })
    aviso(`Serie ${s.codigo} actualizada.`)
    await recargar()
  } catch (e) { aviso(e.message, 'error') }
}

function abrirSerie(s, recargar) {
  const f = {
    codigo: el('input', { value: s ? s.codigo : '', disabled: !!s }),
    nombre: el('input', { value: s ? s.nombre : '' }),
    prefijo: el('input', { value: s ? s.prefijo : '', maxlength: '8' }),
    digitos: el('input', { type: 'number', min: '1', max: '12', value: s ? s.digitos : 6 }),
    con_anio: el('input', { type: 'checkbox' }),
    clase: el('select'),
  }
  for (const [v, t] of Object.entries({
    PRODUCTO: 'Producto terminado', MATERIA_PRIMA: 'Materia prima',
    ENVASE: 'Envases y embalaje', ENTRADA: 'Entrada de mercancía',
    FABRICACION: 'Orden de fabricación', PEDIDO: 'Pedido de venta',
    ALBARAN: 'Albarán', DOCUMENTO: 'Documento',
  })) f.clase.append(el('option', { value: v, text: t }))
  f.clase.value = s ? s.clase : 'PRODUCTO'
  f.con_anio.checked = s ? s.con_anio : true

  const ejemplo = el('p', { class: 'frase' })
  const pintar = () => {
    const p = f.prefijo.value.toUpperCase() || 'XXX'
    const d = Number(f.digitos.value) || 6
    ejemplo.textContent = f.con_anio.checked
      ? `Los lotes nuevos saldrán ${p}-2026-${'0'.repeat(d)}`
      : `Los lotes nuevos saldrán ${p}-${'0'.repeat(d)}`
  }
  f.prefijo.addEventListener('input', pintar)
  f.digitos.addEventListener('input', pintar)
  f.con_anio.addEventListener('change', pintar)
  pintar()

  const avisoPrefijo = el('p', { class: 'alerta alerta--aviso' },
    'Cambiar el prefijo NO cambia los lotes ya existentes. Un lote de 2024 '
    + 'sigue siendo lo que era aunque mañana el prefijo sea otro.')

  const err = el('p', { class: 'alerta alerta--error oculto' })
  const capa = modal('Serie', el('div', { class: 'pila' }, [
    campo('Código', f.codigo),
    campo('Nombre', f.nombre),
    campo('Prefijo', f.prefijo),
    campo('Dígitos del número', f.digitos),
    el('div', { class: 'fila-fila' }, [f.con_anio, el('span', { text: 'incluir el año en el código' })]),
    s ? null : campo('Clase', f.clase),
    ejemplo,
    s ? avisoPrefijo : null,
    err,
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton(s ? 'Guardar' : 'Crear serie', async () => {
      err.classList.add('oculto')
      try {
        const cuerpo = {
          nombre: f.nombre.value.trim() || f.codigo.value,
          prefijo: f.prefijo.value.trim() || f.codigo.value,
          digitos: Number(f.digitos.value),
          con_anio: f.con_anio.checked,
        }
        if (s) await A.api(`/config/series/${s.codigo}`, { metodo: 'PUT', cuerpo })
        else await A.api('/config/series', { metodo: 'POST', cuerpo: { ...cuerpo, codigo: f.codigo.value, clase: f.clase.value } })
        capa.remove()
        aviso('Serie guardada.')
        await recargar()
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }, 'btn btn--principal'),
  ])
}
