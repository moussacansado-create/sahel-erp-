/**
 * Ayudas de interfaz. Nada de framework: unas pocas funciones y ya.
 * El objetivo es que cada página sea legible de arriba abajo.
 */

export const $ = (sel, raiz = document) => raiz.querySelector(sel)
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)]

/** Aplana arrays anidados, sin perder los hijos que ya son nodos. */
function aplanar(hijos, salida = []) {
  for (const h of [].concat(hijos)) {
    if (Array.isArray(h)) aplanar(h, salida)
    else if (h !== null && h !== undefined && h !== false) salida.push(h)
  }
  return salida
}

/**
 * Crea un elemento. `props` acepta class/text/html y atributos sueltos.
 *
 * Los hijos se APLANAN. Antes no se hacía, y `[].concat([[a, b]])` deja un array
 * dentro del array: el navegador lo convertía a texto y la pantalla salía con
 * «[object HTMLDivElement]» donde debía ir un grupo de campos. Pasaba
 * rápidamente porque el elemento existía; lo que no aparecía era su contenido.
 */
export function el(tag, props = {}, hijos = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) n.setAttribute(k, '')
    else n.setAttribute(k, v)
  }
  for (const h of aplanar(hijos)) {
    n.append(h instanceof Node ? h : document.createTextNode(String(h)))
  }
  return n
}

/** Número con separador de miles y decimales fijos. PostgreSQL devuelve texto. */
export function num(v, dec = 2) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '—'
  // Una cantidad entera se muestra entera. Poner «500,0000» unidades de botella
  // delante del operario es ruido, y un formulario lleno de ceros decimales
  // hace dudar de si el dato es real.
  const reales = Math.abs(n - Math.round(n)) < 1e-9 ? 0 : dec
  return n.toLocaleString('es-ES', { minimumFractionDigits: reales, maximumFractionDigits: reales })
}
export function entero(v) { return Number(v ?? 0).toLocaleString('es-ES') }

/** Fecha legible. Si viene vacía, guion. */
export function fecha(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
export function fechaHora(v) {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Insignia de estado con el color que le corresponde. */
export function estado(texto, tono = '') {
  return el('span', { class: `estado${tono ? ' estado--' + tono : ''}`, text: texto })
}

export function vacio(mensaje, icono = '∅') {
  return el('div', { class: 'vacio' }, [el('span', { class: 'vacio__icono', text: icono }), documento(mensaje)])
}
function documento(texto) { return el('div', { text: texto }) }

export function cargando(texto = 'Cargando…') {
  return el('div', { class: 'cargando', text: texto })
}

/** Aviso flotante que se va solo. Para confirmaciones, no para errores de API. */
export function aviso(mensaje, tono = 'bien') {
  const caja = $('#avisos')
  const n = el('div', { class: `alerta alerta--${tono}`, text: mensaje })
  caja.append(n)
  setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 300) }, 4200)
  return n
}

/** Envuelve un manejador async para que sus errores se vean y no se pierdan. */
export function protegido(fn) {
  return async (...args) => {
    try { return await fn(...args) }
    catch (e) { aviso(e.message || 'Algo ha fallado', 'error'); throw e }
  };
}

/** Rellena un <tbody> con filas, o el mensaje de vacío. */
export function cuerpoTabla(tbody, filas, columnas, mensajeVacio = 'Nada por aquí todavía') {
  tbody.replaceChildren()
  if (!filas.length) {
    tbody.append(el('tr', {}, [el('td', { colspan: columnas, class: 'centro' }, [vacio(mensajeVacio)])]))
    return
  }
  for (const f of filas) tbody.append(el('tr', {}, f.map((c) => el('td', { class: c?.clase || '' }, [c?.valor ?? c ?? '']))))
}

export function panel(titulo, acciones, cuerpo, sinPadding = false) {
  return el('section', { class: 'panel' }, [
    titulo ? el('div', { class: 'panel__cabecera' }, [
      el('h2', { text: titulo }),
      acciones ? el('div', { class: 'pila' }, acciones) : null,
    ]) : null,
    el('div', { class: `panel__cuerpo${sinPadding ? ' panel__cuerpo--liso' : ''}` }, cuerpo),
  ])
}

export function metrica(etiqueta, valor, nota) {
  return el('div', { class: 'panel metrica' }, [
    el('div', { class: 'metrica__etiqueta', text: etiqueta }),
    el('div', { class: 'metrica__valor', text: valor }),
    nota ? el('div', { class: 'metrica__nota', text: nota }) : null,
  ])
}

export function campo(etiqueta, control, ancho = false) {
  return el('label', { class: `campo${ancho ? ' campo--ancho' : ''}` }, [el('span', { text: etiqueta }), control])
}

export function opcion(valor, texto) {
  return el('option', { value: valor, text: texto })
}

// ─── Piezas compartidas ─────────────────────────────────────────────────────
// Antes cada página traía su propia copia de `modal`, `boton` y `tabla`. Tres
// copias de la misma ventana modal significa tres sitios donde arreglar el
// cierre con la tecla Escape, y solo uno se habría acordado.

/**
 * Tabla a partir de una lista de cabeceras y un `tbody` ya llenado.
 *
 * El contenedor lleva `overflow-x: auto` porque en un móvil de 390 px una
 * tabla de siete columnas no cabe: sin esto, la de pedidos se salía de la
 * pantalla y no había manera de llegar a la última.
 */
export function tabla(cabeceras, cuerpo, clase = '') {
  // Una cabecera puede ser un texto suelto o `{ text, clase }`.
  //
  // La clase importa: en móvil hay columnas que sobran (las fechas, por
  // ejemplo) y se ocultan por CSS. Para que el CSS pueda esconderlas hay que
  // poder marcar TAMBIÉN la cabecera, no solo la celda: si solo se marca la
  // celda, el `<th>` sigue allí, la columna sigue ocupando su sitio y no se
  // oculta nada.
  return el('div', {
    class: `tabla-envoltura ${clase}`.trim(),
    style: 'overflow-x:auto;-webkit-overflow-scrolling:touch',
  }, [
    el('table', { class: 'tabla' }, [
      el('thead', {}, [el('tr', {}, cabeceras.map((c) => (typeof c === 'string'
        ? el('th', { text: c })
        : el('th', { class: c.clase || null, text: c.text }))))]),
      cuerpo,
    ]),
  ])
}

/**
 * Rellena un `tbody` desde una lista de filas y una definición de columnas.
 *
 * La cabecera y las celdas salen de la MISMA lista de columnas, así que no
 * pueden desincronizarse: es lo que pasó con la tabla del panel, que enseñaba
 * cinco cabeceras y cuatro celdas con ceros que la API no devolvía.
 */
export function pintarFilas(cuerpo, filas, columnas, mensajeVacio = 'Nada por aquí todavía.') {
  cuerpo.replaceChildren()
  if (!filas.length) {
    cuerpo.append(el('tr', {}, [el('td', {
      colspan: columnas.length, class: 'vacio', text: mensajeVacio,
    })]))
    return cuerpo
  }
  for (const f of filas) {
    cuerpo.append(el('tr', {}, columnas.map(
      (c) => el('td', { class: c.clase || '' }, [c.render(f)]))))
  }
  return cuerpo
}

/** Ventana modal. Se cierra con el fondo o con el botón que le pasen. */
export function modal(titulo, cuerpo, acciones = null) {
  const capa = el('div', { class: 'capa' }, [el('div', { class: 'capa__dialogo panel' }, [
    el('div', { class: 'panel__cabecera' }, [el('h2', { text: titulo })]),
    el('div', { class: 'panel__cuerpo' }, [cuerpo]),
    acciones ? el('div', { class: 'panel__cuerpo pila pila--fin', style: 'border-top:1px solid var(--linea)' },
      acciones) : null,
  ])])
  document.body.append(capa)
  capa.addEventListener('click', (ev) => { if (ev.target === capa) capa.remove() })
  const cerrar = (ev) => { if (ev.key === 'Escape') { capa.remove(); document.removeEventListener('keydown', cerrar) } }
  document.addEventListener('keydown', cerrar)
  return capa
}

export function boton(texto, onclick, clase = 'btn') {
  //
  // UN BOTÓN NO ES UN BOTÓN HASTA QUE DICE QUÉ HA HECHO.
  //
  // Antes esto era `el('button', { class: clase, text: texto, onclick })`: el
  // manejador se ponía tal cual y punto. De ahí salían los tres problemas que
  // más se Quejaba la gente en el uso diario:
  //
  //   · «se queda cargando» — si el manejador lanzaba, el error se iba a la
  //     consola y el botón se quedaba ahí, con la misma pinta, sin decir nada.
  //     El usuario no sabía si se había hecho. Y no: no se había hecho, pero
  //     desde fuera parecía lo mismo que cuando sí se hace.
  //
  //   · «lo he pulsado dos veces» — nada bloqueaba el segundo clic. Cobrar dos
  //     veces, entregar dos veces, guardar dos veces. El backend protege
  //     algunas cosas, pero no todas, y una que se repita es un problema de
  //     caja, no un aviso.
  //
  //   · «no se ve nada pasar» — una operación de dos segundos sin ninguna
  //     señal parece una página colgada.
  //
  // Ahora, mientras la acción corre: el botón se bloquea, se pone en ocupado y
  // no admite un segundo clic. Cuando acaba, vuelve a su estado normal. Si
  // falla, se desbloquea y se AVISA con el motivo real: el usuario tiene que
  // poder contestar siempre «¿se hizo o no se hizo?» con un dato.
  //
  const b = el('button', { class: clase, text: texto })

  b.addEventListener('click', async (ev) => {
    ev.preventDefault()

    // El segundo clic no llega ni al manejador. Aquí es donde se corta el
    // «lo he pulsado dos veces», y no en el backend: en el backend hay
    // acciones que una vez están bien y dos veces no.
    if (b.dataset.ocupado === '1') return
    b.dataset.ocupado = '1'

    const textoOriginal = b.textContent
    b.disabled = true
    b.classList.add('btn--ocupado')
    b.textContent = textoOriginal ? `${textoOriginal}…` : '…'

    try {
      await onclick(ev)
    } catch (e) {
      // El error REAL, no un «algo ha ido mal». El backend manda mensajes
      // escritos para entenderse («el pedido no tiene mercancía apartada»),
      // y esconderlos detrás de un texto genérico es lo que obliga a cerrar
      // la ventana y volver a entrar a mirar.
      avisoError(e)
    } finally {
      // Siempre se desbloquea. Un botón que se queda bloqueado para siempre
      // es tan ambiguo como uno que nunca se pulsó.
      b.dataset.ocupado = '0'
      b.disabled = false
      b.classList.remove('btn--ocupado')
      b.textContent = textoOriginal
    }
  })

  return b
}

/**
 * Poner el fallo delante del usuario.
 *
 * `window.alert` y un error de red, que es lo que se veía hasta ahora. Se
 * intenta primero el aviso de la propia aplicación, que se lee mejor y no
 * interrumpe; y si no hay, se cae al `alert` de siempre, porque un error
 * escondido es peor que uno incómodo.
 */
function avisoError(e) {
  const mensaje = String(e?.message ?? e ?? 'No se ha podido completar la operación.')
  const consola = typeof window !== 'undefined' ? window.consella ?? window.console : null

  if (typeof window !== 'undefined' && typeof window.aviso === 'function') {
    try { window.aviso(mensaje, 'error'); return } catch { /* se cae al alert */ }
  }
  if (typeof window !== 'undefined') window.alert(mensaje)
  consola?.error('[acción fallida]', e)
}

// ─── Buscador con sugerencias ───────────────────────────────────────────────
//
// Un `<select>` obliga a encontrar el nombre exacto en una lista de veinte
// productos. Escribir «Lava» debería bastar para ver «Lavavajillas 500 ml» y
// poderlo tocar.
//
// Se usa donde hay que ELEGIR algo que ya existe (productos, clientes,
// recetas, almacenes). No se usa en campos de texto libre: escribir «algo que
// no está en la lista» sigue siendo una operación válida.
//
// No inventa nada: solo propone lo que hay. Elegir una opción no crea ningún
// registro; solo fija el id en un campo oculto que acompaña al input.

export function buscador({
  opciones = [],
  placeholder = 'Escribe para buscar…',
  value = null,
  onChange = null,
  permitirVacio = true,
  vacio = '—',
} = {}) {
  // `opciones`: [{ value, text, sub }]
  const ocult = el('input', { type: 'hidden', value: value ?? '' })
  const texto = el('input', {
    type: 'search', placeholder, autocomplete: 'off',
    value: value != null ? (opciones.find((o) => String(o.value) === String(value))?.text ?? '') : '',
  })
  const lista = el('div', { class: 'buscador__lista oculto' })
  const capa = el('div', { class: 'buscador' }, [texto, lista, ocult])
  let fijada = value != null

  function coincide(q) {
    const t = q.trim().toLowerCase()
    if (!t) return opciones
    return opciones.filter((o) =>
      o.text.toLowerCase().includes(t) || String(o.sub ?? '').toLowerCase().includes(t))
  }

  function pintar() {
    const q = texto.value
    const res = coincide(q).slice(0, 60)
    if (!res.length) {
      lista.replaceChildren(el('div', { class: 'buscador__nada', text: 'Nada coincide con eso.' }))
    } else {
      lista.replaceChildren(...res.map((o) => el('button', {
        class: 'buscador__opcion', type: 'button',
        onclick: (ev) => {
          ev.preventDefault()
          elegir(o)
        },
      }, [
        el('span', { class: 'buscador__texto', text: o.text }),
        o.sub ? el('span', { class: 'buscador__sub', text: o.sub }) : null,
      ])))
    }
    lista.classList.remove('oculto')
  }

  function elegir(o) {
    fijada = true
    texto.value = o.text
    ocult.value = o.value
    lista.classList.add('oculto')
    if (onChange) onChange(o.value, o)
  }

  texto.addEventListener('focus', () => { if (!fijada || texto.value === '') pintar() })
  texto.addEventListener('input', () => {
    // Al escribir a mano, lo que hubiera elegido deja de valer: si luego
    // alguien guardara sin elegir de la lista, el id sería el viejo.
    fijada = false
    ocult.value = ''
    pintar()
  })
  texto.addEventListener('blur', () => setTimeout(() => lista.classList.add('oculto'), 180))
  texto.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') lista.classList.add('oculto')
    if (ev.key === 'Enter') {
      const primera = lista.querySelector('.buscador__opcion')
      if (primera && !lista.classList.contains('oculto')) { ev.preventDefault(); primera.click() }
    }
  })

  capa.elegido = () => fijada
  capa.value = () => ocult.value
  capa.opciones = (nuevas) => { opciones = nuevas; if (!fijada) texto.value = '' }
  capa.setOpciones = (nuevas) => { opciones = nuevas }
  capa.ref = texto
  capa.inputOculto = ocult
  return capa
}

/**
 * Panel de histórico, plegado.
 *
 * La lista de arriba enseña lo que hay que hacer. Esto guarda lo que ya se
 * hizo, con su cuenta, y no ocupa sitio hasta que alguien lo abre. Nunca se
 * borra nada: es un cambio de dónde se mira, no de qué existe.
 */
export function historico(titulo, cantidad, contenido) {
  const cuerpo = el('div', { class: 'historico__cuerpo oculto' }, [contenido])
  const cabecera = el('button', {
    class: 'historico__cabecera', type: 'button',
    'aria-expanded': 'false',
  }, [
    el('span', { text: titulo }),
    el('span', { class: 'historico__contador', text: String(cantidad) }),
  ])
  cabecera.addEventListener('click', () => {
    const abierta = !cuerpo.classList.contains('oculto')
    cuerpo.classList.toggle('oculto', abierta)
    cabecera.setAttribute('aria-expanded', String(!abierta))
    cabecera.firstChild.textContent = `${titulo} ${abierta ? '▸' : '▾'}`
  })
  cabecera.firstChild.textContent = `${titulo} ▸`
  return el('div', { class: 'historico' }, [cabecera, cuerpo])
}
