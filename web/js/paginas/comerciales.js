/**
 * COMERCIALES · MAPA, ZONAS, ASIGNACIONES Y RANKING
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EL ORDEN DE LA PANTALLA, Y POR QUÉ ES ESTE
 *
 *   1 · el MAPA, grande, arriba
 *   2 · las REGIONES y sus ZONAS
 *   3 · el RANKING del equipo, debajo
 *
 * El ranking NO va arriba. Encima del mapa se ve lo único que cambia cada
 * segundo según el filtro, y entonces el mapa —que es lo que hay que
 * mirar— queda debajo de una fila de cifras que nadie Lee. Un mapa con el
 * ranking al lado se mira de un vistazo; un ranking encima del mapa esconde
 * el mapa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE SE PUEDE HACER DESDE AQUÍ, Y ES REAL
 *
 *   · Crear un comercial CON SU USUARIO, y usarlo enseguida.
 *   · Clic en una región → entrar en una zona.
 *   · Ver quién la cubre y quién NO la cubre.
 *   · Asignar, y quitar la asignación.
 *
 * Nada de esto es un dibujo: cada botón llama a una ruta que escribe en la base
 * y devuelve lo que ha guardado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * UNA ZONA PUEDE TENER VARIOS COMERCIALES, Y UN COMERCIAL VARIAS ZONAS.
 *
 * La relación está en `com_comercial_zonas`, no en el `home_zona_id` del
 * perfil. `home_zona_id` es solo «cuál se marca en el mapa», y asentar ahí la
 * relación entera fue el error que hizo que un comercial con tres zonas
 * pareciera tener una y las otras dos desaparecieran.
 *
 */

import {
  el, boton, aviso, modal, panel, cargando, vacio, campo, buscador,
} from '../ui.js'
import * as A from '../api.js'

const ENTERO = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })
const dinero = (v) => (v === null || v === undefined ? '—' : ENTERO.format(Number(v)))
const guion = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))

const tono = (texto, tiene) => {
  if (!tiene || texto === '—') return 'estado estado--marca'
  const n = Number(String(texto).replace(/[^\d.,-]/g, '').replace(',', '.'))
  if (Number.isNaN(n)) return 'estado estado--marca'
  if (n >= 100) return 'estado estado--bien'
  if (n >= 60) return 'estado estado--aviso'
  return 'estado estado--peligro'
}

// ═══════════════════════════════════════════════════════════════════════════
// EL MAPA
// ═══════════════════════════════════════════════════════════════════════════

const LIM = { lonMin: -13.2, lonMax: 5.2, latMin: 9.4, latMax: 25.8 }
const ANCHO = 1000
const ALTO = Math.round(ANCHO * ((LIM.latMax - LIM.latMin) / (LIM.lonMax - LIM.lonMin)))

const proy = ([lon, lat]) => [
  Number(((ANCHO * (lon - LIM.lonMin)) / (LIM.lonMax - LIM.lonMin)).toFixed(1)),
  Number(((ALTO * (LIM.latMax - lat)) / (LIM.latMax - LIM.latMin)).toFixed(1)),
]

const svg = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

// La función vale para los dos mapas. Lo único que cambia entre el de Mali y
// el recuadro de Bamako es DÓNDE SE MIRA y cuánto cabe en pantalla, así que
// eso son parámetros y no dos funciones parecidas: dos copias divergen, y la
// segunda se queda sin arreglar cuando se arregla la primera.
function dibujarMapa(zonas, selId, conEquipo, alElegir, op = {}) {
  const lim = op.lim || LIM
  const ancho = op.ancho || ANCHO
  const alto = op.alto || ALTO
  const proy = ([lon, lat]) => [
    Number(((ancho * (lon - lim.lonMin)) / (lim.lonMax - lim.lonMin)).toFixed(1)),
    Number(((alto * (lim.latMax - lat)) / (lim.latMax - lim.latMin)).toFixed(1)),
  ]
  const s = svg('svg', {
    viewBox: `0 0 ${ancho} ${alto}`,
    class: `mapa__svg ${op.clase || 'mapa__svg--grande'}`,
    role: 'group',
    'aria-label': op.aria || 'Mapa de las nueve regiones de Mali',
  })

  const puestos = []
  for (const z of [...zonas].sort((a, b) => (a.id === selId ? 1 : b.id === selId ? -1 : 0))
    .map((z) => ({ ...z, esPadre: !!(op.sinRotuloPadre && z.id === 1) }))) {
    const p = (z.poligono ?? []).map(proy)
    if (!p.length) continue
    const path = svg('path', {
      d: `M ${p.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`,
      class: ['mapa__zona', z.id === selId ? 'mapa__zona--activa' : '',
        conEquipo.has(z.id) ? 'mapa__zona--principal' : ''].filter(Boolean).join(' '),
      tabindex: '0', role: 'button', 'aria-label': `${z.nombre}`,
      'data-zona-id': String(z.id),
    })
    const t = svg('title')
    t.textContent = `${z.nombre} — ${z.cumplimiento}`
    path.appendChild(t)
    path.addEventListener('click', () => alElegir(z))
    path.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alElegir(z) }
    })
    s.appendChild(path)

    // El nombre, DENTRO de su polígono. Un mapa sin rótulos es un mapa de
    // siluetas: se ve Mali, pero no se sabe qué es cada trozo.
    const [cx, cy] = proy([z.lng, z.lat])
    // EL RÓTULO, COLOCADO.
    //
    // En el mapa de Mali los rótulos van repartidos y no se tocan. En el
    // recuadro de Bamako, que es unas veinte veces más pequeño, «Centro» y
    // «Oeste» tienen el centro casi en el mismo punto: con el mismo
    // desplazamiento para todos seguían encima.
    //
    // Así que cada rótulo se coloca donde puede: se prueba en su sitio y, si
    // pisa a uno ya puesto, baja hasta encontrar hueco. El ancho se estima
    // por número de letras, que es lo que hace el navegador, y se deja
    // margen para que el halo blanco no toque al vecino.
    const anchoR = z.nombre.length * 7.2 + 6
    const altoR = 15
    let ly = cy
    for (let intento = 0; intento < 12; intento++) {
      const choca = puestos.some((p) => Math.abs(p.x - cx) < (p.ancho + anchoR) / 2
        && Math.abs(p.y - ly) < altoR)
      if (!choca) break
      ly += altoR
    }
    puestos.push({ x: cx, y: ly, ancho: anchoR })
    const txt = svg('text', {
      x: cx, y: ly, class: `mapa__etiqueta ${op.etiquetaAlto ? 'mapa__etiqueta--recuadro' : ''}`,
      'text-anchor': 'middle', 'pointer-events': 'none',
      'data-zona-id': String(z.id),
    })
    // En el recuadro, el distrito (Bamako) NO lleva rotulo: sus cinco zonas
    // los llevan, y el titulo del recuadro ya dice «Distrito de Bamako». Con el
    // rotulo del distrito encima, su etiqueta caia sobre las de «Bamako Este»
    // y «Bamako Centro» y las tapaba. El distrito se sigue viendo: es el
    // contorno que las rodea.
    if (!op.sinRotuloPadre || !z.esPadre) {
      txt.textContent = z.nombre
      s.appendChild(txt)
    }
  }
  return s
}

// ═══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ─── EL RECUADRO DE BAMAKO ─────────────────────────────────────
//
// POR QUÉ HACE FALTA
//
// Mali va de -13,2 a 5,2 de longitud: dieciocho grados. Bamako va de -8,06
// a -7,92: CERO PUNTO CATORCE. En el mapa nacional Bamako sale con cinco
// píxeles de ancho y su zona Centro con dos. Están en su sitio —no es un
// error de coordenadas ni de proyección— pero cinco píxeles no se pulsan, y
// una etiqueta más grande que la zona tapa el distrito entero.
//
// La tentación es dibujarlo más grande donde sea, y eso es mentira
// cartográfica: el mapa enseñaría Bamako en un sitio donde no está. La
// solución es un recuadro de ampliación, que es lo que se hace en un atlas:
// el mapa grande no se toca y al lado está el mismo distrito mirado de cerca.
//
// El recuadro usa la MISMA función y las MISMAS coordenadas reales, con otra
// ventana. Si algún día se corrige el mapa grande, el recuadro se corrige con
// él, porque no son dos mapas: es el mismo dos veces.

const RECUADRO_BKO = { lonMin: -8.16, lonMax: -7.82, latMin: 12.50, latMax: 12.74 }

function dibujarRecuadroBamako(zonas, selId, conEquipo, alElegir) {
  const subzonas = zonas.filter((z) => z.id === 1 || z.parentId === 1
    || String(z.code || '').startsWith('BKO-'))
  if (!subzonas.length) return null
  const ancho = 420
  const alto = Math.round(ancho * ((RECUADRO_BKO.latMax - RECUADRO_BKO.latMin)
    / (RECUADRO_BKO.lonMax - RECUADRO_BKO.lonMin)))
  return el('figure', { class: 'mapa__recuadro' }, [
    el('figcaption', { class: 'mapa__recuadro-titulo' }, [
      el('strong', { text: 'Ampliación · Distrito de Bamako' }),
      el('span', { class: 'tenue', text: 'Mismo mapa, mismas coordenadas, otra ventana.' }),
    ]),
    dibujarMapa(subzonas, selId, conEquipo, alElegir, {
      lim: RECUADRO_BKO, ancho, alto,
      clase: 'mapa__svg--recuadro',
      etiquetaAlto: true,
      sinRotuloPadre: true,
      aria: 'Ampliación del distrito de Bamako con sus zonas',
    }),
  ])
}

// GRÁFICOS POR ZONA
// ══════════════════════════════════════════════════════════════════
//
// El mapa dice DÓNDE. El gráfico dice CUÁNTO, y el mapa no puede: dentro de
// un polígono caben «vende mucho» y «vende poco» sin que se note. Estas
// barras son las que convierten un mapa bonito en una herramienta de
// trabajo.
//
// ── UNA MÉTRICA POR GRÁFICO, NUNCA DOS EN LA MISMA ESCALA ────────────────
//
// Es tentador juntar ventas y clientes en un mismo gráfico con dos ejes, y
// es la forma más rápida de mentir: 2.200.000 FCFA y 5 clientes no se
// comparan, y quien mira el dibujo se cree que sí. Aquí hay un botón por
// métrica y solo se enseña una barra a la vez.
//
// ── LAS ZONAS SIN DATOS SE VEN ───────────────────────────────────────────
//
// Una zona con cero no se esconde. Si Norte vende y Centro no, la pregunta
// útil es «¿es que Centro no vende o es que no tiene comercial?», y para
// contestarla hay que ver las dos barras. Ocultar las vacías convierte «no
// hay datos» en «no hay zonas», que no es lo mismo.
const METRICAS_ZONA = [
  { clave: 'importe', nombre: 'Ventas (FCFA)', de: (z) => Number(z.ventas?.importe ?? 0), tipo: 'dinero' },
  { clave: 'pedidos', nombre: 'Pedidos', de: (z) => Number(z.ventas?.pedidos ?? 0), tipo: 'entero' },
  { clave: 'clientes', nombre: 'Clientes activos', de: (z) => Number(z.ventas?.clientesActivos ?? 0), tipo: 'entero' },
  { clave: 'nuevos', nombre: 'Clientes nuevos', de: (z) => Number(z.ventas?.nuevosClientes ?? 0), tipo: 'entero' },
  { clave: 'unidades', nombre: 'Unidades vendidas', de: (z) => Number(z.ventas?.unidades ?? 0), tipo: 'entero' },
  { clave: 'potencial', nombre: 'Potencial (FCFA)', de: (z) => Number(z.potencial ?? 0), tipo: 'dinero' },
]


// LA PANTALLA
// ═══════════════════════════════════════════════════════════════════════════

export async function paginaComerciales(ctx) {
  const raiz = panel('Comerciales')
  const cuerpo = el('div', { class: 'comerciales' })
  raiz.appendChild(cuerpo)


  const st = { periodo: 'MES', desde: null, hasta: null, zonaId: null, metrica: 'importe' }
  let sinAsignar = { clientes: 0, activos: 0 }
  let zonas = []
  let ranking = []
  const cache = { comerciales: null }

  const zonaLista = el('div', { class: 'zonas' })
  const panelZona = el('div', { class: 'panel-zona' })
  const cajaRanking = el('div', { class: 'ranking' })

  // ─── FILTROS ────────────────────────────────────────────────────────────
  function barra() {
    const b = el('div', { class: 'filtros' })
    const periodos = [['HOY', 'Hoy'], ['SEMANA', 'Semana'], ['MES', 'Mes'],
      ['TRIMESTRE', 'Trimestre'], ['ANIO', 'Año'], ['PERSONALIZADO', 'Personalizado']]
    b.append(
      el('span', { class: 'etiqueta', text: 'Periodo' }),
      ...periodos.map(([c, t]) => boton(t, () => {
        st.periodo = c; st.desde = null; st.hasta = null
        if (c === 'PERSONALIZADO') return pedirPersonalizado()
        cargar()
      }, `chip${st.periodo === c ? ' chip--activo' : ''}`)),
      el('span', { class: 'filtros__hueco' }),
      boton('+ Nuevo comercial', () => abrirNuevoComercial(cargar), 'btn btn--principal'),
    )
    return b
  }

  function pedirPersonalizado() {
    const d = el('input', { type: 'date' })
    const h = el('input', { type: 'date' })
    const capa = modal('Periodo personalizado', el('div', { class: 'pila' }, [
      el('label', { class: 'etiqueta', text: 'Desde' }), d,
      el('label', { class: 'etiqueta', text: 'Hasta' }), h,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Aplicar', () => {
        if (!d.value || !h.value) { aviso('Las dos fechas hacen falta.', 'error'); return }
        st.desde = d.value; st.hasta = h.value
        capa.remove(); cargar()
      }, 'btn btn--principal'),
    ])
  }

  // ─── CARGA ─────────────────────────────────────────────────────────────
  async function cargar() {
    const params = new URLSearchParams()
    if (st.periodo !== 'MES') params.set('periodo', st.periodo)
    if (st.desde) { params.set('desde', st.desde); params.set('hasta', st.hasta) }
    try {
      const [mapa, rk, coms] = await Promise.all([
        A.api(`/comerciales/mapa?${params}`),
        A.api(`/comerciales/ranking?${params}`),
        cache.comerciales ? Promise.resolve(cache.comerciales) : A.api('/comerciales'),
      ])
      cache.comerciales = coms
      zonas = mapa.zonas ?? []
      sinAsignar = mapa.sinAsignar ?? { clientes: 0, activos: 0 }
      ranking = rk.comerciales ?? []
    } catch (e) {
      zonaLista.replaceChildren(aviso(`No se ha podido cargar: ${e.message}`, 'error'))
      return
    }
    pintarMapa()
    pintarZonas()
    if (st.zonaId) await pintarPanelZona()
    pintarRanking()
    pintarGraficos()
  }

  function pintarMapa() {
    // Los clientes que no son de nadie, arriba del mapa y no escondidos en una
    // esquina. Son 13 y son reales: si no se ven, el mapa parece completo cuando
    // no lo está. Solo se enseña quien puede verlos.
    if (sinAsignar && sinAsignar.clientes > 0 && A.puede('commercial', 'view')) {
      lienzo.parentElement.querySelector('.mapa__aviso')?.remove()
      lienzo.parentElement.insertBefore(
        el('div', { class: 'mapa__aviso' }, [
          el('strong', { text: `${sinAsignar.clientes} cliente${sinAsignar.clientes === 1 ? '' : 's'} sin comercial asignado` }),
          el('span', { class: 'tenue', text: 'No cuentan para ningún ranking ni comisión hasta que se confirme su responsable.' }),
        ]),
        lienzo,
      )
    } else {
      lienzo.parentElement.querySelector('.mapa__aviso')?.remove()
    }
    const conEquipo = new Set(zonas.filter((z) => (z.comercial ?? 0) > 0).map((z) => z.id))
    const elegir = (z) => {
      st.zonaId = z.id
      pintarMapa(); pintarZonas(); pintarPanelZona()
    }
    const nacional = dibujarMapa(zonas, st.zonaId, conEquipo, elegir)
    const recuadro = dibujarRecuadroBamako(zonas, st.zonaId, conEquipo, elegir)
    lienzo.replaceChildren(...(recuadro ? [nacional, recuadro] : [nacional]))
  }

  // ─── ZONAS ─────────────────────────────────────────────────────────────
  // El boton de una zona, con su identificador estable.
  function btnZona(z) {
    const b = boton(z.nombre, () => {
      st.zonaId = z.id
      pintarMapa(); pintarZonas(); pintarPanelZona()
    }, 'zona__nombre')
    b.dataset.zonaId = String(z.id)
    return b
  }
  function pintarZonas() {
    if (!zonas.length) { zonaLista.replaceChildren(vacio('No hay zonas.')); return }
    zonaLista.replaceChildren(
      el('div', { class: 'zonas__rejilla' }, zonas.map((z) => el('div', {
        class: `zona${st.zonaId === z.id ? ' zona--activa' : ''}`,
      }, [
        // El identificador va en el `data-` y no en el texto: el texto es lo
        // que ve la persona y puede cambiar en cualquier momento. Un
        // identificador estable es lo que permite que una prueba o un
        // enlace externo apunte a ESTA zona y no a la que se le parezca.
        btnZona(z),
        el('span', { class: 'zona__datos', text: `${z.comercial ?? 0} comercial(es)` }),
        el('span', { class: tono(z.cumplimiento, z.tieneObjetivo), text: z.cumplimiento }),
      ]))),
    )
  }

  // ─── EL PANEL DE GESTIÓN DE UNA ZONA ──────────────────────────────────
  async function pintarPanelZona() {
    if (!st.zonaId) {
      panelZona.replaceChildren()
      return
    }
    panelZona.replaceChildren(cargando('…'))
    let g
    try {
      g = await A.api(`/comerciales/zona/${st.zonaId}/gestion`)
    } catch (e) {
      panelZona.replaceChildren(aviso(`No se ha podido abrir la zona: ${e.message}`, 'error'))
      return
    }

    const sel = el('select', { class: 'campo' })
    sel.appendChild(el('option', { value: '', text: '— elige un comercial —' }))
    for (const c of g.disponibles) {
      sel.appendChild(el('option', { value: String(c.comercial_id), text: `${c.full_name}${c.idiomas.length ? ` (${c.idiomas.join(', ')})` : ''}` }))
    }
    const pct = el('input', { type: 'number', min: '0', max: '100', placeholder: '% de la zona', value: '50' })
    const prio = el('input', { type: 'checkbox' })

    const box = el('div', { class: 'asignar' }, [
      el('div', { class: 'asignar__fila' }, [
        el('label', { class: 'etiqueta', text: 'Comercial para asignar' }),
        sel,
        el('label', { class: 'etiqueta', text: '%' }),
        pct,
        el('label', { class: 'casilla' }, [prio, el('span', { text: 'zona principal' })]),
        boton('Asignar zona', async () => {
          if (!sel.value) { aviso('Elige un comercial.', 'error'); return }
          try {
            await A.api(`/comerciales/zona/${st.zonaId}/asignar`, {
              metodo: 'POST',
              cuerpo: {
                comercialId: Number(sel.value),
                esPrincipal: prio.checked,
                porcentaje: pct.value === '' ? null : Number(pct.value),
              },
            })
            cache.comerciales = null
            aviso('Asignado.', 'ok')
            await cargar()
            await pintarPanelZona()
          } catch (e) { aviso(e.message, 'error') }
        }, 'btn btn--principal'),
      ]),
    ])

    panelZona.replaceChildren(
      el('div', { class: 'panel-zona__cab' }, [
        el('div', {}, [
          el('h3', { text: `${g.zona.nombre}` }),
          el('p', { class: 'tenue', text: `${g.zona.code} · ${g.zona.region ? `región de ${g.zona.region}` : 'sin región'}` }),
        ]),
        boton('×', () => { st.zonaId = null; pintarMapa(); pintarZonas(); pintarPanelZona() }, 'btn btn--plano'),
      ]),

      // Hay gente en la zona, pero dos empatan: no hay UN responsable. Va antes
      // de la lista porque es lo que hay que resolver primero, y antes estaba
      // dentro de la rama de «nadie», que es justo cuando NO ocurre.
      g.empate ? el('p', { class: 'vacio vacio--aviso' },
        `Nadie es EL responsable: ${g.empate} comerciales tienen el mismo `
        + 'porcentaje. Marca uno como principal y quedará claro a quién llamar.') : null,

      el('h4', { class: 'seccion-mini', text: `Comerciales en esta zona (${g.asignados.length})` }),
      g.asignados.length
        ? el('ul', { class: 'lista' }, g.asignados.map((a) => el('li', { class: 'lista__item' }, [
          el('div', {}, [
            el('strong', { text: a.full_name }),
            // El teléfono es lo que se busca al abrir una zona: para llamar. Si
            // no lo ha dado, se dice que no lo ha dado, en vez de esconderlo.
            el('div', { class: 'tenue', text: a.phone
              ? `☎ ${a.phone}`
              : '☎ sin teléfono registrado' }),
            el('div', { class: 'tenue', text: `@${a.username}${a.idiomas.length ? ` · ${a.idiomas.join(', ')}` : ''}` }),
          ]),
          el('span', { class: 'pastilla pastilla--dato', text: `${a.clientes ?? 0} cliente${(a.clientes ?? 0) === 1 ? '' : 's'}` }),
          a.es_principal ? el('span', { class: 'pastilla', text: 'principal' }) : null,
          el('span', { class: 'tenue', text: a.porcentaje !== null ? `${a.porcentaje} %` : 'sin %' }),
          boton('Quitar', async () => {
            try {
              await A.api(`/comerciales/zona/${st.zonaId}/comerciales/${a.comercial_id}`, { metodo: 'DELETE' })
              cache.comerciales = null
              aviso('Quitado de la zona. El comercial sigue en el sistema.', 'ok')
              await cargar()
              await pintarPanelZona()
            } catch (e) { aviso(e.message, 'error') }
          }, 'btn btn--plano btn--peligro'),
        ])))
        // Una zona sin nadie es un dato que hay que ver, no una lista vacía que
        // parece un fallo de carga. Y si hay empate, se dice cuántos empatan.
        : el('p', { class: 'vacio vacio--aviso' },
          'Nadie cubre esta zona todavía. Es una zona del territorio sin '
          + 'nadie detrás: o se asigna, o no tiene a quién llamar.'),

      el('h4', { class: 'seccion-mini', text: `Disponibles para asignar (${g.disponibles.length})` }),
      box,
    )
  }

  // ─── RANKING, DEBAJO ──────────────────────────────────────────────────
  /** Barras horizontales, ordenadas por la métrica elegida, con el nombre a la izquierda. */
  function dibujarBarras(filas, metrica) {
    // El orden cambia con la métrica a propósito: comparar por ventas y
    // comparar por clientes dan rankings distintos, y a veces justo eso es lo
    // que se quería ver.
    const datos = [...filas].sort((a, b) => metrica.de(b) - metrica.de(a))
    const maximo = Math.max(1, ...datos.map(metrica.de))
    const AN = 150        // ancho de la etiqueta
    const ALTO = 34       // alto de cada fila
    const ancho = 520
    const alto = Math.max(ALTO, datos.length * ALTO) + 8

    const s = svg('svg', {
      viewBox: `0 0 ${ancho + AN + 90} ${alto}`,
      class: 'grafico__svg', role: 'img',
      'aria-label': `${metrica.nombre} por zona`,
    })

    datos.forEach((z, i) => {
      const v = metrica.de(z)
      const w = Math.round((v / maximo) * ancho)
      const y = i * ALTO + 6

      // La fila entera es pulsable, no solo la barra: una zona con cero tiene
      // una barra de cero píxeles, y si solo se pulsara la barra esa zona sería
      // inclasificable justo cuando es la que interesa.
      const g = svg('g', {
        class: ['grafico__fila', st.zonaId === z.id ? 'grafico__fila--activa' : ''].filter(Boolean).join(' '),
        tabindex: '0', role: 'button',
        'aria-label': `${z.nombre}: ${metrica.tipo === 'dinero' ? dinero(v) : v}`,
      })
      g.appendChild(svg('rect', { x: 0, y, width: ancho + AN, height: ALTO - 8, rx: 4, class: 'grafico__fila-fondo' }))

      const etiqueta = svg('text', { x: AN - 10, y: y + 17, 'text-anchor': 'end', class: 'grafico__nombre' })
      etiqueta.textContent = z.nombre
      g.appendChild(etiqueta)

      g.appendChild(svg('rect', {
        x: AN, y: y + 4, width: Math.max(w, v > 0 ? 3 : 0), height: ALTO - 16, rx: 3,
        class: ['grafico__barra', v === 0 ? 'grafico__barra--vacia' : ''].filter(Boolean).join(' '),
      }))

      // La cifra SIEMPRE a la derecha, también cuando es 0. Esconder el cero en
      // las zonas sin datos es justo lo que este gráfico viene a arreglar.
      const valor = svg('text', { x: AN + ancho + 8, y: y + 17, class: 'grafico__valor' })
      valor.textContent = metrica.tipo === 'dinero' ? dinero(v) : String(v)
      g.appendChild(valor)

      g.addEventListener('click', () => {
        st.zonaId = z.id
        pintarMapa(); pintarZonas(); pintarPanelZona(); pintarGraficos()
      })
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); g.dispatchEvent(new Event('click')) }
      })
      s.appendChild(g)
    })

    if (!datos.length) {
      const t = svg('text', { x: AN, y: 24, class: 'grafico__nombre' })
      t.textContent = 'No hay zonas que comparar.'
      s.appendChild(t)
    }
  return s
}

  // ── GRÁFICOS ─────────────────────────────────────────────────────────────
  // Se redibujan con el mismo `cargar()` que el mapa y el ranking, así que
  // cambiar el período los mueve a los tres a la vez. Sin esto se acaba
  // viendo «el mapa es de este mes» junto a «las barras son del anterior».
  const cajaGraficos = el('div', { class: 'grafico' })

  function pintarGraficos() {
    // Solo las zonas que están bajo Bamako, que es lo que un comercial de
    // Bamako puede comparar. Comparar Gao con Kidal no sirve para decidir
    // nada, y mete en el gráfico regiones que nadie está trabajando.
    const lista = zonas.filter((z) => z.id !== 1 && z.kind !== 'REGION' && z.nivel !== 'REGION')
    const meta = METRICAS_ZONA.find((m) => m.clave === st.metrica) || METRICAS_ZONA[0]

    const conDatos = lista.filter((z) => meta.de(z) > 0)
    const sinNada = lista.filter((z) => meta.de(z) === 0)
    const top = conDatos[0]

    cajaGraficos.replaceChildren(
      el('div', { class: 'grafico__controles' }, [
        el('span', { class: 'grafico__titulo', text: 'Rendimiento por zona' }),
        el('div', { class: 'grafico__botones' }, METRICAS_ZONA.map((m) => boton(
          m.nombre, () => { st.metrica = m.clave; pintarGraficos() },
          'btn btn--mini' + (m.clave === meta.clave ? ' btn--principal' : '')))),
      ]),
      el('div', { class: 'grafico__resumen' }, [
        el('span', {}, [el('strong', { text: 'Mejor: ' }),
          el('span', { text: top ? `${top.nombre} · ${meta.tipo === 'dinero' ? dinero(meta.de(top)) : meta.de(top)}` : '—' })]),
        el('span', {}, [el('strong', { text: 'Zonas sin actividad: ' }),
          el('span', { text: String(sinNada.length) }),
          sinNada.length ? el('span', { class: 'tenue', text: ` (${sinNada.map((z) => z.nombre).join(', ')})` }) : null]),
      ].filter(Boolean)),
      el('div', { class: 'grafico__lienzo' }, [dibujarBarras(lista, meta)]),
      el('p', { class: 'pista', text: 'Pulsa una barra para marcar esa zona en el mapa.' }),
    )
  }

  function pintarRanking() {
    if (!ranking.length) { cajaRanking.replaceChildren(vacio('Ninguno todavía.')); return }
    cajaRanking.replaceChildren(
      el('table', { class: 'tabla' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '#' }), el('th', { text: 'Comercial' }), el('th', { text: 'Zona' }),
          el('th', { text: 'Objetivo' }), el('th', { text: 'Cumplimiento' }),
          el('th', { text: 'Ventas' }), el('th', { text: 'Visitas' }), el('th', { text: 'Puntos (vivo / registrados)' }),
          el('th', { text: '' }),
        ])]),
        el('tbody', {}, ranking.map((c) => el('tr', {}, [
          el('td', {}, [el('strong', { text: `${c.puesto}º` })]),
          el('td', { text: c.nombre }),
          el('td', { text: guion(c.zona) }),
          el('td', { text: dinero(c.objetivo) }),
          el('td', {}, [el('span', { class: tono(c.cumplimientoTexto, c.tieneObjetivo), text: c.cumplimientoTexto })]),
          el('td', { text: dinero(c.importe) }),
          el('td', { text: String(c.visitas) }),
          el('td', {}, [
            el('strong', { text: String(c.puntos) }),
            // Lo que queda REGISTRADO, con su evento. No es el mismo número que
            // el de arriba a propósito: uno se recalcula, el otro no se repite.
            el('div', { class: 'tenue', text: `${c.puntosOtorgados ?? 0} registrados` }),
          ]),
          el('td', {}, [boton('Ficha', () => abrirFicha(c.comercialId, cargar), 'btn btn--plano')]),
        ]))),
      ]),
    )
  }

  // ─── FICHA ─────────────────────────────────────────────────────────────
  async function abrirFicha(comercialId, alCerrar) {
    let f
    try { f = await A.api(`/comerciales/ficha/${comercialId}`) }
    catch (e) { aviso(`No se ha podido abrir: ${e.message}`, 'error'); return }

    const cuerpo = el('div', { class: 'pila' }, [
      el('div', { class: 'rejilla rejilla--2' }, [
        dato('Usuario', `@${f.comercial.username}`),
        dato('Alta', guion(f.comercial.hiredOn)),
        dato('Idiomas', f.comercial.idiomas.join(', ') || '—'),
        dato('Vendido', dinero(f.metricas.ventas)),
        dato('Visitas', String(f.metricas.visitas)),
        dato('Puntos', String(f.metricas.puntos)),
      ]),
      el('h4', { class: 'seccion-mini', text: 'Zonas' }),
      el('ul', { class: 'lista' }, f.estructura.zonas.map((z) => el('li', { class: 'lista__item' }, [
        el('strong', { text: z.nombre }),
        el('span', { class: 'tenue', text: `de ${z.region} · ${z.porcentaje !== null ? `${z.porcentaje} %` : 'sin %'}` }),
        z.esPrincipal ? el('span', { class: 'pastilla', text: 'principal' }) : null,
        boton('Quitar zona', async () => {
          try {
            await A.api(`/comerciales/zona/${z.id}/comerciales/${f.comercial.id}`, { metodo: 'DELETE' })
            capa.remove()
            cache.comerciales = null
            aviso('Zona quitada. El comercial sigue en el sistema.', 'ok')
            await alCerrar()
          } catch (e) { aviso(e.message, 'error') }
        }, 'btn btn--plano btn--peligro'),
      ]))),
      el('h4', { class: 'seccion-mini', text: 'Añadir otra zona' }),
      // Se pasa una FUNCIÓN, no la capa.
      //
      // `capa` se declara con `const` DOS LÍNEAS más abajo, cuando se crea el
      // modal. Pasarla aquí como valor la evalúa antes de que exista, y sale
      // «Cannot access 'capa' before initialization»: la ficha no abría. No
      // era un fallo al pinchar, era un fallo al ABRIRLA, y por eso daba
      // igual cuántas veces se pulsara.
      //
      // La función solo mira `capa` cuando se pulse, y para entonces ya está.
      selectZona(f, () => capa.remove(), alCerrar),
    ])

    const capa = modal(f.comercial.nombre, cuerpo, [
      boton('Cerrar', () => capa.remove()),
    ])
  }

  function dato(et, va) {
    return el('div', { class: 'cifra' }, [
      el('span', { class: 'cifra__et', text: et }),
      el('strong', { class: 'cifra__va', text: va }),
    ])
  }

  function selectZona(f, cerrar, alCerrar) {
    const sel = el('select', { class: 'campo' })
    sel.appendChild(el('option', { value: '', text: '— elige una zona —' }))
    const dentro = new Set(f.estructura.zonas.map((z) => z.id))
    for (const z of zonas) {
      if (dentro.has(z.id)) continue
      sel.appendChild(el('option', { value: String(z.id), text: `${z.nombre}${z.region ? ` (${z.region})` : ''}` }))
    }
    return el('div', { class: 'asignar__fila' }, [
      sel,
      boton('+ Asignar zona', async () => {
        if (!sel.value) { aviso('Elige una zona.', 'error'); return }
        try {
          await A.api(`/comerciales/zona/${sel.value}/asignar`, {
            metodo: 'POST', cuerpo: { comercialId: f.comercial.id, esPrincipal: false, porcentaje: 50 },
          })
          cerrar()
          cache.comerciales = null
          aviso('Zona asignada.', 'ok')
          await alCerrar()
        } catch (e) { aviso(e.message, 'error') }
      }, 'btn btn--principal'),
    ])
  }

  // ─── CREAR UN COMERCIAL CON SU USUARIO ────────────────────────────────
  async function abrirNuevoComercial(alGuardar) {
    const f = {
      nombre: el('input', { type: 'text', placeholder: 'Nombre' }),
      apellidos: el('input', { type: 'text', placeholder: 'Apellidos' }),
      usuario: el('input', { type: 'text', placeholder: 'usuario (minúsculas)' }),
      clave: el('input', { type: 'password', placeholder: 'contraseña' }),
      tel: el('input', { type: 'tel', placeholder: '+223 …' }),
      puesto: el('input', { type: 'text', placeholder: 'Ej.: Delegado comercial' }),
      idiomas: el('input', { type: 'text', placeholder: 'fr, bm', value: 'fr' }),
      notas: el('textarea', { rows: 3, placeholder: 'Notas internas' }),
    }

    const capa = modal('Nuevo comercial', el('div', { class: 'pila' }, [
      el('p', {
        class: 'aviso aviso--info',
        text: 'Se crea la persona Y su usuario del ERP, con su contraseña. '
          + 'Después podrá entrar y asignarle zonas desde el mapa.',
      }),
      el('div', { class: 'rejilla rejilla--2' }, [
        campo('Nombre', f.nombre), campo('Apellidos', f.apellidos),
        campo('Usuario (login)', f.usuario), campo('Contraseña', f.clave),
        campo('Teléfono', f.tel), campo('Puesto', f.puesto),
      ]),
      campo('Idiomas (separados por comas)', f.idiomas),
      campo('Notas', f.notas),
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Crear comercial', async () => {
        const nombreCompleto = `${f.nombre.value.trim()} ${f.apellidos.value.trim()}`.trim()
        if (!nombreCompleto) { aviso('Falta el nombre.', 'error'); return }
        if (!f.usuario.value.trim()) { aviso('Falta el usuario.', 'error'); return }
        if (f.clave.value.length < 8) { aviso('La contraseña necesita al menos 8 caracteres.', 'error'); return }

        try {
          // 1 · El USUARIO del ERP, con su contraseña y su rol.
          const usuario = await A.api('/users', {
            metodo: 'POST',
            cuerpo: {
              username: f.usuario.value.trim().toLowerCase(),
              fullName: nombreCompleto,
              password: f.clave.value,
              roles: ['COMMERCIAL'],
              locale: 'es',
            },
          })
          // 2 · El COMERCIAL, que apunta a ese usuario.
          const comLanguages = f.idiomas.value.split(',').map((x) => x.trim()).filter(Boolean)
          const comercial = await A.api('/comerciales', {
            metodo: 'POST',
            cuerpo: { userId: usuario.id, idiomas: comLanguages, notas: f.notas.value || null },
          })
          capa.remove()
          cache.comerciales = null
          aviso(`${nombreCompleto} creado. Ya se puede asignarle una zona desde el mapa.`, 'ok')
          await alGuardar()
          return comercial
        } catch (e) {
          aviso(e.message, 'error')
        }
      }, 'btn btn--principal'),
    ])
  }

  //
  // El cuerpo se engancha ANTES de cargar. Si se enganchara después y
  // `cargar()` lanzara, la función moriría sin devolver nada: pantalla en
  // blanco, sin un error y sin decir por qué. Que es lo que pasaba.
  //
  //

  // El lienzo se guarda en una variable. Si se creara aquí cada vez que se
  // repinta la pantalla habría varios `.mapa__lienzo` en el DOM y
  // `document.querySelector` elegiría el primero —el de una pantalla
  // anterior— y pintaría el mapa ahí. El nuevo se quedaría vacío sin error.
  const lienzo = el('div', { class: 'mapa__lienzo' })
  function cajaMapa() { return lienzo }

  function leyenda(clase, texto) {
    return el('span', { class: 'leyenda' }, [
      el('span', { class: `mapa__muestra ${clase}` }),
      el('span', { text: texto }),
    ])
  }

  // El `append` va AQUÍ y no arriba: usa `lienzo`, `zonaLista`, `panelZona` y
  // `cajaRanking`, que se declaran más abajo. `const` no se hoistea, y usarlo
  // antes de declararlo rompe el `append` entero. El router se come el error y
  // la pantalla queda EN BLANCO, sin un mensaje y sin rastro.
  //

  /** Alta de incidencia. Sin botón de borrar: no se puede, ni aquí ni atrás. */
  async function abrirIncidencia(recargar) {
   try {
    const f = {
      clienteId: null,
      tipo: el('select'),
      gravedad: el('select'),
      descripcion: el('textarea', { rows: 3, placeholder: 'Qué ha pasado' }),
      accion: el('input', { placeholder: 'Qué hay que hacer' }),
      fecha: el('input', { type: 'date' }),
    }
    for (const [v, t] of [['FALTA_MERCANCIA', 'Falta mercancía'], ['CALIDAD', 'Reclamo de calidad'],
      ['PEDIDO_NO_LLEGADO', 'El pedido no ha llegado'], ['PRECIO_O_FACTURA', 'Precio o factura'],
      ['SERVICIO', 'Descontento con el servicio'], ['COMERCIAL', 'Problema comercial'],
      ['OTRO', 'Otro']]) f.tipo.append(el('option', { value: v, text: t }))
    for (const [v, t] of [['BAJA', 'Baja'], ['NORMAL', 'Normal'], ['ALTA', 'Alta'], ['URGENTE', 'Urgente']]) {
      f.gravedad.append(el('option', { value: v, text: t, selected: v === 'NORMAL' }))
    }
    // Sin este onChange el buscador se rellenaba, se elegia el cliente, y al
    // guardar se enviaba `clienteId: null`: la incidencia salia sin cliente. El
    // selector solo DECORA; alguien tiene que guardarse el id.
    const selCliente = await campoCliente({ onChange: (v) => { f.clienteId = v } })
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const capa = modal('Nueva incidencia', el('div', { class: 'pila' }, [
      selCliente,
      campo('Tipo', f.tipo, true),
      campo('Gravedad', f.gravedad, true),
      campo('Descripción', f.descripcion, true),
      campo('Próxima acción', f.accion, true),
      campo('Fecha de seguimiento', f.fecha, true),
      err,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Comunicar', async () => {
        err.classList.add('oculto')
        const desc = f.descripcion.value.trim()
        if (!desc) {
          err.textContent = 'Escribe qué ha pasado. Sin descripción no dice nada.'
          err.classList.remove('oculto'); return
        }
        try {
          await A.api('/comerciales/incidencias', { metodo: 'POST', cuerpo: {
            clienteId: f.clienteId || null,
            tipo: f.tipo.value,
            gravedad: f.gravedad.value,
            descripcion: desc,
            proximaAccion: f.accion.value.trim() || null,
            fechaSeguimiento: f.fecha.value || null,
          } })
          capa.remove()
          await recargar()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
   } catch (e) {
    // Antes este fallo se comia en silencio: se pulsaba «Nueva incidencia» y no
    // pasaba nada. Un boton que no hace nada parece una base que no guarda.
    aviso('No se pudo abrir el formulario de incidencia: ' + e.message, 'error')
   }
  }

  /**
   * Resolver. La resolución es OBLIGATORIA y el backend lo rechaza si falta:
   * aquí solo se explica antes de que salte.
   */
  function abrirResolver(inc, recargar) {
    const f = { texto: el('textarea', { rows: 3, placeholder: 'Qué se ha hecho para resolverla' }) }
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const capa = modal(`Resolver incidencia #${inc.id}`, el('div', { class: 'pila' }, [
      el('p', { class: 'pista', text: inc.descripcion }),
      campo('Resolución', f.texto, true),
      err,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Marcar resuelta', async () => {
        err.classList.add('oculto')
        try {
          await A.api(`/comerciales/incidencias/${inc.id}`, { metodo: 'PUT', cuerpo: {
            estado: 'RESUELTA', resolucion: f.texto.value.trim(),
          } })
          capa.remove()
          await recargar()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }



  /**
   * SELECTOR DE CLIENTES DEL MÓDULO CENTRAL.
   *
   * ── POR QUÉ NO UN CAMPO DE TEXTO ──────────────────────────────────────────
   *
   * Porque escribir el nombre a mano produce tres fallos distintos: o se
   * escribe mal y no guarda, o se repite con otro nombre y crea otro cliente
   * que nadie ha dado de alta, o se deja en blanco y la incidencia queda
   * huérfana. Los tres son el mismo error: un cliente de verdad tiene un id,
   * y ese id es lo que hay que guardar.
   *
   * Solo propone clientes que YA están en la base central. No crea ninguno: si
   * no está, se dice que no está y se usa el formulario oficial de Clientes.
   *
   * La lista se pide una vez y se filtra en memoria. Son 14 clientes; con
   * veinte mil habría que ir al servidor, y entonces el buscador dejaría de
   * funcionar cada vez que la red fallase — que en este entorno pasa.
   */
  let _catalogoClientes = null
  async function catalogoClientes() {
    if (!_catalogoClientes) {
      // Si el catalogo falla, se entrega VACIO y el buscador avisa. Romper aqui
      //_impedia abrir el formulario entero, y el sintoma era «las incidencias no
      // se guardan»: en realidad no habia forma de empezarlas.
      const lista = await A.api('/customers?limite=500&todos=1').catch((e) => {
        aviso('No se pudo cargar el catalogo de clientes: ' + e.message, 'error'); return [] })
      _catalogoClientes = (Array.isArray(lista) ? lista : (lista.clientes || []))
        .map((c) => ({
          value: c.id,
          // Nombre y código juntos: quien busca «Keita» y quien busca «CL-00002»
          // tienen que encontrarlo los dos.
          text: `${c.code ? c.code + ' — ' : ''}${c.name}`,
          sub: [c.commercial_name || c.comercial || 'sin comercial', c.zone_name || 'sin zona']
            .filter(Boolean).join(' · '),
          _c: c,
        }))
    }
    return _catalogoClientes
  }

  /** El texto visible del cliente elegido, o el que venga por defecto. */
  const nombreDeCliente = (id) => {
    const c = (_catalogoClientes || []).find((x) => x.value === id)
    return c ? c._c.name : null
  }

  /**
   * El control de cliente, listo para usar. `value` es el id que ya tuviera el
   * registro (al editar, por ejemplo) y `onChange` recibe el id elegido.
   */
  async function campoCliente({ value = null, onChange = null, obligatorio = false } = {}) {
    const catalogo = await catalogoClientes()
    return buscador({
      opciones: catalogo,
      value,
      placeholder: obligatorio
        ? 'Busca el cliente por nombre o por número…'
        : 'Busca un cliente (opcional)…',
      permitirVacio: !obligatorio,
      vacio: '— sin cliente —',
      onChange,
    })
  }

  /** Nueva tarea de seguimiento. El título es lo que se lee en la lista. */
  async function abrirSeguimiento(recargar) {
    let f = {
      clienteId: null,
      titulo: el('input', { placeholder: 'Qué hay que hacer' }),
      motivo: el('input', { placeholder: 'Por qué' }),
      prioridad: el('select'),
      vence: el('input', { type: 'date' }),
    }
    for (const [v, t] of [['BAJA', 'Baja'], ['NORMAL', 'Normal'], ['ALTA', 'Alta'], ['URGENTE', 'Urgente']]) {
      f.prioridad.append(el('option', { value: v, text: t, selected: v === 'NORMAL' }))
    }
    // Mismo fallo que en incidencias: el buscador se llenaba y el id se perdia.
    const selCliente = await campoCliente({ onChange: (v) => { f.clienteId = v } })
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const capa = modal('Nueva tarea de seguimiento', el('div', { class: 'pila' }, [
      campo('Título', f.titulo, true),
      campo('Cliente', selCliente),
      campo('Motivo', f.motivo, true),
      el('div', { class: 'rejilla rejilla--2' }, [campo('Prioridad', f.prioridad), campo('Vence el', f.vence)]),
      err,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Crear tarea', async () => {
        err.classList.add('oculto')
        if (!f.titulo.value.trim()) {
          err.textContent = 'La tarea necesita un título. «Seguir con el cliente» no dice qué hacer.'
          err.classList.remove('oculto'); return
        }
        try {
          await A.api('/comerciales/seguimientos', { metodo: 'POST', cuerpo: {
            titulo: f.titulo.value.trim(),
            clienteId: f.clienteId || null,
            motivo: f.motivo.value.trim() || null,
            prioridad: f.prioridad.value,
            venceEn: f.vence.value || null,
          } })
          capa.remove()
          await recargar()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }

  /** Atender o cancelar. Los dos piden decir qué pasó; cancelar, por qué. */
  function abrirCerrarSeguimiento(t, recargar) {
    const modo = { v: 'HECHA' }
    const f = {
      texto: el('textarea', { rows: 3, placeholder: 'Qué se hizo' }),
      motivo: el('input', { placeholder: 'Por qué se cancela' }),
    }
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const sel = el('select')
    sel.append(el('option', { value: 'HECHA', text: 'Tarea atendida' }), el('option', { value: 'CANCELADA', text: 'La tarea ya no hace falta' }))
    sel.addEventListener('change', () => { modo.v = sel.value })
    const capa = modal(`Tarea #${t.id}`, el('div', { class: 'pila' }, [
      el('p', { class: 'pista', text: t.titulo }),
      campo('Qué ha pasado', sel, true),
      campo('Resultado', f.texto, true),
      campo('Motivo (si se cancela)', f.motivo, true),
      err,
    ]), [
      boton('Dejar abierta', () => capa.remove()),
      boton('Guardar', async () => {
        err.classList.add('oculto')
        try {
          await A.api(`/comerciales/seguimientos/${t.id}/cerrar`, { metodo: 'POST', cuerpo: modo.v === 'CANCELADA'
            ? { cancelar: true, motivoCancelacion: f.motivo.value.trim() }
            : { resultado: f.texto.value.trim() } })
          capa.remove()
          await recargar()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }


  // ═══ CONFIGURAR RANKINGS ═══════════════════════════════════════════════════
  //
  // Solo aparece si el backend dice que se puede. Y no es que el botón se
  // esconda: `A.puede` refleja el permiso REAL que el servidor exige, así que
  // lo que no se ve es lo que el servidor no dejaría hacer. Un comercial que
  // llame a la API directamente recibe el mismo 403.
  //
  // Y antes de guardar una regla se enseña, en una frase, lo que va a pasar.
  // «Esta regla no se puede calcular» es una respuesta, no un fallo: es el
  // sistema diciendo que le faltan datos, y se dice ANTES de activarla.
  const zonaRankings = el('div', { class: 'rank-config' })
  // Se lee AQUÍ, antes de que se monte la pantalla: el árbol se construye una
  // sola vez y los datos llegan después. Consultarlo en el `cargar` era tarde —
  // la sección se quedaba sin pintar y nadie entendía por qué.
  const puedeConfigurar = A.puede('rankings', 'edit')
  let metricasCat = null
  let ASSERT = null

  async function cargarConfigRankings() {
    if (!puedeConfigurar) { zonaRankings.replaceChildren(); return }
    if (!metricasCat) metricasCat = await A.api('/rankings/metricas')
    const [rankings, reglas] = await Promise.all([
      A.api('/rankings'),
      A.api('/rankings/reglas'),
    ])
    ASSERT = metricasCat.familias
    pintarConfig(rankings, reglas)
  }

  const findMetrica = (code) => {
    for (const f of metricasCat.familias) {
      const m = f.metricas.find((x) => x.code === code)
      if (m) return m
    }
    return null
  }

  function pintarConfig(rankings, reglas) {
    const cab = el('div', { class: 'rank-config__cab' }, [
      boton('+ Competición', () => abrirCompeticion(null), 'btn btn--mini'),
      boton('+ Regla', () => abrirRegla(null, rankings), 'btn btn--mini'),
      boton('Calcular puntos', async () => {
        try {
          const r = await A.api('/rankings/calcular', { metodo: 'POST', cuerpo: {} })
          aviso(`${r.insertados} puntos nuevos, ${r.omitidos} ya estaban. Total: ${r.total}.`)
          if (r.noCalculables.length) {
            for (const n of r.noCalculables) aviso(`${n.regla}: ${n.motivo}`, 'aviso')
          }
          await cargarConfigRankings()
        } catch (e) { aviso(e.message, 'error') }
      }, 'btn btn--mini'),
    ])

    const porComp = new Map()
    for (const r of rankings) porComp.set(r.id, [])
    for (const g of reglas) {
      if (!porComp.has(g.ranking_id)) porComp.set(g.ranking_id, [])
      porComp.get(g.ranking_id).push(g)
    }

    zonaRankings.replaceChildren(
      cab,
      ...rankings.map((rk) => {
        const rs = porComp.get(rk.id) || []
        return panel(rk.nombre + ` · ${rk.reglas_activas}/${rk.reglas} activas · ${rk.puntos_registrados} pts registrados`, [
          boton('Editar', () => abrirCompeticion(rk), 'btn btn--mini'),
        ], el('div', { class: 'pila' }, [
          rk.proposito ? el('p', { class: 'rank-config__proposito', text: rk.proposito }) : null,
          rk.que_premia ? el('p', { class: 'pista', text: 'Premia: ' + rk.que_premia }) : null,
          el('p', { class: 'tenue', text: `Desde ${rk.vigente_desde}${rk.vigente_hasta ? ' hasta ' + rk.vigente_hasta : ' (abierta)'}` }),
          el('span', { class: 'pastilla ' + (rk.estado === 'ACTIVA' ? 'pastilla--estado' : 'pastilla--dato'), text: rk.estado }),
          rs.length
            ? el('ul', { class: 'lista' }, rs.map((g) => el('li', { class: 'regla' + (g.estado !== 'ACTIVA' ? ' regla--inactiva' : '') }, [
              el('div', { class: 'regla__cabeza' }, [
                el('strong', { text: `${g.nombre} · ${g.puntos} pts` }),
                el('span', { class: 'pastilla pastilla--dato', text: `${g.familia} · ${g.modo_real}` }),
                el('span', { class: 'pastilla ' + (g.estado === 'ACTIVA' ? 'pastilla--estado' : 'pastilla--dato'), text: g.estado }),
              ]),
              el('p', { class: 'pista', text: g.explicacion }),
              // Si no se puede calcular, se DICE y se dice por qué. Es la
              // diferencia entre una regla que vale cero y una que no se sabe.
              g.calculable
                ? null
                : el('p', { class: 'regla__aviso', text: '⚠ ' + g.motivo_no_calculable }),
              g.estado !== 'ACTIVA' && g.estado !== 'DESACTIVADA'
                ? el('p', { class: 'pista', text: `Los puntos ya concedidos con esta regla se conservan (${g.puntos_registrados ?? '—'}).` })
                : null,
              el('div', { class: 'regla__botones' }, [
                boton('Editar', () => abrirRegla(g, rankings), 'btn btn--mini'),
                g.estado === 'ACTIVA'
                  ? boton('Pausar', () => cambiar(g, 'PAUSADA'), 'btn btn--mini')
                  : null,
                g.estado === 'PAUSADA' || g.estado === 'DESACTIVADA'
                  ? boton('Reactivar', () => cambiar(g, 'ACTIVA'), 'btn btn--mini') : null,
                g.estado !== 'DESACTIVADA'
                  ? boton('Desactivar', () => cambiar(g, 'DESACTIVADA'), 'btn btn--mini') : null,
              ]),
            ])))
            : vacio('Esta competición todavía no tiene reglas.'),
        ]))
      }),
    )
  }

  async function cambiar(g, estado) {
    try {
      await A.api(`/rankings/reglas/${g.id}/estado`, { metodo: 'POST', cuerpo: { estado } })
      aviso(`Regla «${g.nombre}» → ${estado}. Los puntos ya concedidos no se tocan.`)
      await cargarConfigRankings()
    } catch (e) { aviso(e.message, 'error') }
  }

  /** Antes de guardar, la frase exacta de lo que va a pasar. */
  function frase(metrica, puntos, modo, cantidad, periodo, estado) {
    if (!metrica) return 'Elige qué se premia.'
    if (estado !== 'ACTIVA') return `Quedará ${estado.toLowerCase()}: no contará, pero se conservará y se podrá volver a activar.`
    if (modo === 'UMBRAL') {
      return `Cada vez que se alcancen ${cantidad || '?'} (${periodo === 'NINGUNO' ? 'contando desde siempre' : 'en cada ' + periodo.toLowerCase().replace('men', 'mes').replace('trimes', 'trimestre')}), se concederán ${puntos} puntos. Se concede una vez, no por cada unidad.`
    }
    if (!metrica.avisaSiFalta) return `Por cada ${metrica.nombre.toLowerCase()} se concederán ${puntos} puntos.`
    return `Atención: ${metrica.avisaSiFalta} Con los datos de ahora, esta regla no puede calcularse.`
  }

  function abrirRegla(g, rankings) {
    const f = {
      nombre: el('input', { value: g ? g.nombre : '' }),
      competicion: el('select'),
      metrica: el('select'),
      puntos: el('input', { type: 'number', min: '0.1', step: '0.5', value: g ? g.puntos : '2' }),
      cantidad: el('input', { type: 'number', min: '1', value: g ? (g.cantidad || g.umbral || '') : '' }),
      periodo: el('select'),
      acumulativo: el('input', { type: 'checkbox' }),
      desde: el('input', { type: 'date' }),
      proposito: el('input', { value: g ? (g.descripcion || '') : '' }),
    }
    for (const rk of rankings) f.competicion.append(el('option', { value: rk.id, text: rk.nombre }))
    if (g?.ranking_id) f.competicion.value = g.ranking_id
    for (const fa of metricasCat.familias) {
      const og = el('optgroup', { label: fa.familia })
      for (const m of fa.metricas) og.append(el('option', { value: m.code, text: `${m.nombre} (${m.modo})` }))
      f.metrica.append(og)
    }
    for (const p of metricasCat.periodos) f.periodo.append(el('option', { value: p.code, text: p.nombre }))
    f.periodo.value = g ? g.periodo : 'NINGUNO'
    if (g?.metrica) {
      const existe = findMetrica(g.metrica)
      if (!existe) f.metrica.append(el('option', { value: g.metrica, text: g.metrica + ' (métrica heredada)' }))
      f.metrica.value = g.metrica
    }
    f.acumulativo.checked = g ? g.acumulativo : false
    f.desde.value = g && g.vigente_desde ? String(g.vigente_desde).slice(0, 10) : ''

    const explicacion = el('p', { class: 'frase' })
    const actualizar = () => {
      const m = findMetrica(f.metrica.value)
      explicacion.textContent = frase(m, f.puntos.value, m ? m.modo : 'UNIDAD', f.cantidad.value, f.periodo.value, 'ACTIVA')
      // `actualizar` se llama antes de que los campos estén en el DOM —el
      // formulario todavía se está construyendo—, y ahí `parentElement` es
      // null. Sin esta guarda, abrir «+ Regla» reventaba en silencio y no
      // pasaba nada, que es la peor forma de fallar.
      const env = f.cantidad.closest('.campo')
      if (env) env.style.display = (m && m.modo === 'UMBRAL') ? '' : 'none'
    }
    f.metrica.addEventListener('change', actualizar)
    f.puntos.addEventListener('input', actualizar)
    f.cantidad.addEventListener('input', actualizar)
    f.periodo.addEventListener('change', actualizar)
    actualizar()

    const err = el('p', { class: 'alerta alerta--error oculto' })
    const cuerpo = el('div', { class: 'pila' }, [
      campo('Nombre de la regla', f.nombre),
      campo('Competición', f.competicion),
      campo('Qué se premia', f.metrica, true),
      explicacion,
      campo('Puntos', f.puntos),
      campo('Cantidad para el umbral', f.cantidad),
      campo('Periodo', f.periodo),
      campo('Vigente desde (vacío = desde que existe)', f.desde),
      campo('Descripción', f.proposito),
      err,
    ])
    const capa = modal(g ? 'Editar regla' : 'Nueva regla', cuerpo, [
      boton('Cancelar', () => capa.remove()),
      boton(g ? 'Guardar cambios' : 'Crear regla', async () => {
        err.classList.add('oculto')
        const datos = {
          nombre: f.nombre.value.trim() || findMetrica(f.metrica.value)?.nombre,
          ranking_id: Number(f.competicion.value),
          metrica: f.metrica.value,
          puntos: Number(f.puntos.value),
          cantidad: f.cantidad.value ? Number(f.cantidad.value) : null,
          tipo_regla: findMetrica(f.metrica.value)?.modo,
          periodo: f.periodo.value,
          acumulativo: f.acumulativo.checked,
          descripcion: f.proposito.value.trim() || null,
          vigente_desde: f.desde.value || null,
        }
        try {
          if (g) await A.api(`/rankings/reglas/${g.id}`, { metodo: 'PUT', cuerpo: datos })
          else await A.api('/rankings/reglas', { metodo: 'POST', cuerpo: datos })
          capa.remove()
          aviso('Regla guardada. Los puntos ya concedidos no cambian.')
          await cargarConfigRankings()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }

  function abrirCompeticion(rk) {
    const f = {
      nombre: el('input', { value: rk ? rk.nombre : '' }),
      proposito: el('input', { value: rk ? rk.proposito || '' : '', placeholder: 'Premiar a quien abre puertas nuevas' }),
      que_premia: el('input', { value: rk ? rk.que_premia || '' : '' }),
      descripcion: el('textarea', { value: rk ? rk.descripcion || '' : '' }),
      desde: el('input', { type: 'date', value: rk ? String(rk.vigente_desde).slice(0, 10) : '' }),
      hasta: el('input', { type: 'date', value: rk && rk.vigente_hasta ? String(rk.vigente_hasta).slice(0, 10) : '' }),
      estado: el('select'),
    }
    for (const e of ['ACTIVA', 'PAUSADA', 'DESACTIVADA']) f.estado.append(el('option', { value: e, text: e }))
    f.estado.value = rk ? rk.estado : 'ACTIVA'
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const capa = modal(rk ? 'Editar competición' : 'Nueva competición', el('div', { class: 'pila' }, [
      campo('Nombre', f.nombre),
      campo('Para qué sirve', f.proposito),
      campo('Qué se premia', f.que_premia),
      campo('Descripción', f.descripcion),
      campo('Desde', f.desde),
      campo('Hasta (vacío = abierta)', f.hasta),
      campo('Estado', f.estado),
      err,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Guardar', async () => {
        err.classList.add('oculto')
        const datos = { nombre: f.nombre.value.trim(), proposito: f.proposito.value.trim(), que_premia: f.que_premia.value.trim(), descripcion: f.descripcion.value.trim(), vigente_desde: f.desde.value || null, vigente_hasta: f.hasta.value || null, estado: f.estado.value }
        try {
          if (rk) await A.api(`/rankings/${rk.id}`, { metodo: 'PUT', cuerpo: datos })
          else await A.api('/rankings', { metodo: 'POST', cuerpo: datos })
          capa.remove(); aviso('Competición guardada.'); await cargarConfigRankings()
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }

  // ═══ CENTRO DE ALERTAS ═══════════════════════════════════════════════════
  //
  // Arriba del todo, antes que incidencias y tareas: es lo que hay que mirar
  // para saber si hay que mirar algo. Y las de STOCK van aparte, marcadas como
  // lo que son, porque «quedan 2 cartons de suavizante» y «Moussa no ha pagado
  // lo de septiembre» no se resuelven en el mismo sitio ni por la misma persona.
  /**
   * SECCION PLEGABLE.
   *
   * El mapa es lo que se viene a ver. Debajo habia cinco bloques abiertos a la
   * vez — zonas, alertas, incidencias, tareas y ranking — y para llegar al final
   * habia que pasar por todo. Ahora cada uno es un boton y se abre solo el que
   * se pulse.
   *
   * Se usa `<details>` nativo: el navegador ya sabe plegarlo, se puede abrir con
   * el teclado y sigue funcionando sin JavaScript. El contador se actualiza sin
   * desplegar nada, que es justo lo que hace util tenerlo a la vista.
   */
  function plegable(titulo, contenido, { abierta = false, contador = null } = {}) {
    const d = el('details', { class: 'plegable', open: abierta ? 'open' : null })
    const badge = el('span', { class: 'plegable__contador oculto' })
    const set = (n) => {
      if (n == null) { badge.classList.add('oculto'); return }
      badge.textContent = n > 99 ? '99+' : String(n)
      badge.classList.toggle('urgente', n > 0)
      badge.classList.remove('oculto')
    }
    set(contador)
    d.append(
      el('summary', { class: 'plegable__cabecera' }, [el('span', { text: titulo }), badge]),
      el('div', { class: 'plegable__cuerpo' }, [contenido]),
    )
    // Lo que se pinte dentro despues (las listas se rellenan al cargar) se
    // refleja en el contador sin volver a abrir el panel.
    d.__setContador = set
    return d
  }

  let secAlertas, secIncidencias, secTareas
  const listaAlertas = el('div', { class: 'alertas-centro' })
  const filtroAlerta = el('select', { class: 'campo' })
  filtroAlerta.append(
    el('option', { value: '', text: 'Todas las comerciales' }),
    el('option', { value: 'SEGUIMIENTO', text: 'Solo seguimientos' }),
    el('option', { value: 'INCADENCIA', text: 'Solo incidencias' }),
    el('option', { value: 'INACTIVIDAD', text: 'Solo inactividad' }),
  )
  filtroAlerta.addEventListener('change', () => pintarAlertas())
  let alertas = []
  let configCom = { umbralInactividad: 15, inactividadActiva: false }

  async function cargarCentro() {
    // El generador se llama UNA vez, al entrar, y es idempotente: si ya están
    // todas, no inserta ninguna. Recargar no crea alertas nuevas, pero tampoco
    // se queda sin las nuevas que hayan aparecido.
    try { await A.api('/comerciales/alertas/generar', { metodo: 'POST' }) } catch (e) { /* el centro se ve igual */ }
    configCom = await A.api('/comerciales/config')
    alertas = await A.api('/comerciales/alertas')
    if (secAlertas) secAlertas.__setContador(alertas.length)
    pintarAlertas()
  }

  const TIPO = (k) => k.startsWith('SEGUIMIENTO') ? 'seg'
    : k.startsWith('INCADENCIA') ? 'inc' : 'inac'

  function pintarAlertas() {
    const f = filtroAlerta.value
    const lista = f ? alertas.filter((a) => a.kind.startsWith(f)) : alertas

    // Las de stock se leen aparte y NO se mezclan: son otro departamento.
    const stock = el('div', { class: 'alertas__stock' }, [
      el('h4', { class: 'seccion-mini', text: 'Alertas de almacén (otro módulo)' }),
      el('p', { class: 'pista', text: 'Stock bajo, lotes y producción. Se gestionan donde siempre: en su propia pantalla de alertas.' }),
    ])

    const cuerpo = el('div', { class: 'panel__cuerpo pila' }, [
      filtroAlerta,
      el('div', { class: 'alertas__config' }, [
        el('span', { class: 'tenue', text: 'Inactividad: ' }),
        el('strong', { text: `${configCom.umbralInactividad} días sin compra válida` }),
        el('span', { class: 'pastilla ' + (configCom.inactividadActiva ? 'pastilla--estado' : 'pastilla--dato') },
          configCom.inactividadActiva ? 'alertas activas' : 'alertas desactivadas'),
        !configCom.inactividadActiva
          ? el('span', { class: 'tenue', text: 'No hay ninguna entrega registrada, así que ningún cliente puede contar como compra válida todavía.' })
          : null,
        A.puede('commercial', 'create')
          ? boton('Cambiar umbral', abrirUmbral, 'btn btn--mini') : null,
      ]),
      lista.length
        ? el('ul', { class: 'lista' }, lista.map((a) => el('li', { class: `alerta alerta--${TIPO(a.kind)}` }, [
          el('div', { class: 'alerta__cabeza' }, [
            el('strong', { text: a.title }),
            el('span', { class: 'pastilla pastilla--estado', text: a.kind.replace(/_/g, ' ').toLowerCase() }),
          ]),
          el('p', { class: 'alerta__texto', text: a.message }),
          a.data && a.data.cliente ? el('p', { class: 'tenue', text: `Cliente: ${a.data.cliente}` }) : null,
          a.data && a.data.vence ? el('p', { class: 'tenue', text: `Vence: ${a.data.vence}` }) : null,
          boton('Atendida', async () => {
            try { await A.api('/comerciales/alertas/atender', { metodo: 'POST', cuerpo: { dedupeKey: a.dedupe_key } }); await cargarCentro() }
            catch (e) { aviso(e.message, 'error') }
          }, 'btn btn--mini'),
        ])))
        : vacio('No hay alertas comerciales.'),
      stock,
    ])

    listaAlertas.replaceChildren(
      panel(`Centro de alertas comerciales (${lista.length})`, [], cuerpo),
    )
  }

  /** El umbral, desde aquí. Guarda con la API y se queda guardado. */
  function abrirUmbral() {
    const f = { dias: el('input', { type: 'number', min: '1', max: '3650', value: String(configCom.umbralInactividad) }) }
    const err = el('p', { class: 'alerta alerta--error oculto' })
    const capa = modal('Días sin compra para considerar inactivo a un cliente', el('div', { class: 'pila' }, [
      campo('Días', f.dias),
      el('p', { class: 'pista', text: 'A partir de cuántos días sin comprar un cliente se avisa. Se guarda en la base, no en el código.' }),
      err,
    ]), [
      boton('Cancelar', () => capa.remove()),
      boton('Guardar', async () => {
        err.classList.add('oculto')
        try {
          await A.api('/comerciales/config/inactividad', { metodo: 'PUT', cuerpo: { dias: Number(f.dias.value) } })
          capa.remove()
          configCom = await A.api('/comerciales/config')
          pintarAlertas()
          aviso('Umbral guardado. Sigue siendo el mismo después de recargar.')
        } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
      }, 'btn btn--principal'),
    ])
  }

  // ═══ SEGUIMIENTOS ═══════════════════════════════════════════════════════
  // ═══ INCIDENCIAS ═══════════════════════════════════════════════════════
  //
  // Van en la MISMA pantalla que el mapa, no en otra: el mapa dice quién lleva
  // cada zona, y estas son lasavergüenza de ese comercial. Partirlas en dos
  // páginas obligaría a saltar de una a otra para saber si un cliente tiene un
  // problema abierto.
  //
  // Y no hay botón de borrar en ninguna parte. Una incidencia se resuelve, no
  // se borra; el botón no existe porque ni siquiera el servidor lo permitiría.
  const listaIncidencias = el('div', { class: 'lista-incidencias' })
  const filtroEstado = el('select', { class: 'campo' })
  filtroEstado.append(
    el('option', { value: '', text: 'Todos los estados' }),
    el('option', { value: 'ABIERTA', text: 'Abiertas' }),
    el('option', { value: 'EN_CURSO', text: 'En curso' }),
    el('option', { value: 'ESPERA', text: 'Pendientes de respuesta' }),
    el('option', { value: 'RESUELTA', text: 'Resueltas' }),
  )
  filtroEstado.addEventListener('change', () => cargarIncidencias())
  let incidencias = []

  async function cargarIncidencias() {
    listaIncidencias.replaceChildren(cargando('Cargando incidencias…'))
    const est = filtroEstado.value
    incidencias = await A.api(
      `/comerciales/incidencias?limite=100${est ? `&estado=${est}` : ''}`,
    )
    if (secIncidencias) secIncidencias.__setContador(incidencias.filter((i) => i.estado !== 'RESUELTA').length)
    pintarIncidencias()
  }

  const sev = (g) => g === 'URGENTE' ? 'inc--urgente' : g === 'ALTA' ? 'inc--alta' : g === 'BAJA' ? 'inc--baja' : ''

  function pintarIncidencias() {
    // El botón de «nueva» va SIEMPRE, incluso con la lista vacía. Antes solo se
    // pintaba con incidencias en pantalla, así que la PRIMERA incidencia no se
    // podía crear desde la interfaz: había que entrar por la API. Un formulario
    // que no aparece cuando no hay nada que mostrar es un formulario inútil.
    const cabecera = [boton('+ Nueva incidencia', () => abrirIncidencia(cargarIncidencias), 'btn btn--mini')]
    if (!incidencias.length) {
      listaIncidencias.replaceChildren(
        panel('Incidencias comerciales (0)', cabecera,
          el('div', { class: 'panel__cuerpo' }, [vacio('No hay incidencias con ese filtro.')])),
      )
      return
    }
    listaIncidencias.replaceChildren(
      // El boton de nueva incidencia va SIEMPRE en la cabecera, tambien cuando
      // ya hay incidencias. Con la cabecera vacia desaparecia en cuanto exista
      // la primera, y no habia forma de abrir el formulario.
      panel(`Incidencias comerciales (${incidencias.length})`, cabecera,
      el('div', { class: 'panel__cuerpo pila' }, [
        filtroEstado,
        el('ul', { class: 'lista' }, incidencias.map((i) => el('li', { class: `lista__item inc ${sev(i.gravedad)}` }, [
          el('div', { class: 'inc__cabeza' }, [
            // Nombre Y codigo: «Supermarché Keita» se parece a otros dos, y
            // «CL-00002» es lo que se cita al teléfono para resolverlo. Los dos
            // vienen del modulo central de Clientes, no de un campo duplicado.
            i.cliente
              ? el('strong', {}, [
                i.cliente,
                el('span', { class: 'inc__codigo', text: i.cliente_code || '' }),
              ])
              : el('strong', { text: '(sin cliente)' }),
            el('span', { class: 'pastilla pastilla--estado', text: i.estado.replace('_', ' ') }),
            el('span', { class: 'pastilla pastilla--dato', text: i.gravedad }),
          ]),
          el('p', { class: 'inc__texto', text: i.descripcion }),
          // Los tres roles, POR SEPARADO. Confundir «quién la lleva» con «de
          // quién es el cliente» es justo lo que hizo inútil la tabla de antes.
          el('p', { class: 'tenue inc__roles' }, [
            `La lleva: ${i.comercial || '(sin asignar)'} · `,
            `Cliente de: ${i.responsable_id ? `comercial ${i.responsable_id}` : '(sin responsable)'} · `,
            `Registró: ${i.registrada_por_nombre || '—'}`,
            i.zona ? ` · ${i.zona}` : '',
          ].join('')),
          i.proxima_accion
            ? el('p', { class: 'inc__accion', text: `Próxima: ${i.proxima_accion}` })
            : null,
          i.fecha_seguimiento
            ? el('p', { class: 'inc__fecha', text: `Seguimiento: ${i.fecha_seguimiento}` })
            : null,
          i.estado === 'RESUELTA'
            ? el('p', { class: 'inc__resuelta', text: `Resuelta: ${String(i.resolucion || '').slice(0, 120)}` })
            : boton('Resolver', () => abrirResolver(i, cargarIncidencias), 'btn btn--mini'),
        ]))),
      ]), true),
    )
  }

  // ─── SEGUIMIENTOS ──────────────────────────────────────────────────────────
  //
  // Debajo de Incidencias y encima del Ranking: son cosas que necesitan
  // atención, y el ranking es lo que se mira cuando ya no hay nada que hacer.
  const listaSeguimientos = el('div', { class: 'lista-incidencias' })
  const filtroSituacion = el('select', { class: 'campo' })
  filtroSituacion.append(
    el('option', { value: '', text: 'Todas las tareas' }),
    el('option', { value: 'VENCIDA', text: 'Vencidas' }),
    el('option', { value: 'HOY', text: 'Para hoy' }),
    el('option', { value: 'PROXIMA', text: 'Próximas' }),
    el('option', { value: 'A_TIEMPO', text: 'A tiempo' }),
    el('option', { value: 'COMPLETADA', text: 'Completadas' }),
    el('option', { value: 'CANCELADA', text: 'Canceladas' }),
  )
  filtroSituacion.addEventListener('change', () => cargarSeguimientos())

  async function cargarSeguimientos() {
    listaSeguimientos.replaceChildren(cargando('Cargando tareas…'))
    const sit = filtroSituacion.value
    const todas = await A.api('/comerciales/seguimientos?limite=200')
    const tareas = sit ? todas.filter((t) => t.situacion === sit) : todas
    if (secTareas) secTareas.__setContador(tareas.filter((t) => t.situacion !== 'COMPLETADA' && t.situacion !== 'CANCELADA').length)
    pintarSeguimientos(tareas)
  }

  const SIT = {
    VENCIDA: 'seg--vencida', HOY: 'seg--hoy', PROXIMA: 'seg--proxima',
    A_TIEMPO: 'seg--atiempo', COMPLETADA: 'seg--hecha', CANCELADA: 'seg--cancelada',
  }

  function pintarSeguimientos(tareas) {
    const cabecera = [boton('+ Nueva tarea', () => abrirSeguimiento(cargarSeguimientos), 'btn btn--mini')]
    if (!tareas.length) {
      listaSeguimientos.replaceChildren(
        panel('Tareas de seguimiento (0)', cabecera,
          el('div', { class: 'panel__cuerpo' }, [vacio('No hay tareas con ese filtro.')])),
      )
      return
    }
    listaSeguimientos.replaceChildren(
      panel(`Tareas de seguimiento (${tareas.length})`, cabecera,
        el('div', { class: 'panel__cuerpo pila' }, [
          filtroSituacion,
          el('ul', { class: 'lista' }, tareas.map((t) => el('li', { class: `lista__item seg ${SIT[t.situacion] || ''}` }, [
            el('div', { class: 'inc__cabeza' }, [
              el('strong', { text: t.titulo }),
              el('span', { class: 'pastilla pastilla--estado', text: t.situacion.replace('_', ' ') }),
              el('span', { class: 'pastilla pastilla--dato', text: t.prioridad }),
            ]),
            el('p', { class: 'tenue inc__roles' },
              `Cliente: ${t.cliente || '(ninguno)'} · Vence: ${t.vence_en || 'sin fecha'} · `
              + `Asignada a: ${t.asignado_nombre || t.asignado || '(sin asignar)'} · `
              + `De la cartera de: ${t.responsable_nombre || t.responsable || '(sin responsable)'}`),
            t.motivo ? el('p', { class: 'inc__accion', text: `Por qué: ${t.motivo}` }) : null,
            t.resultado ? el('p', { class: 'inc__resuelta', text: `Resultado: ${t.resultado}` }) : null,
            t.situacion === 'COMPLETADA' || t.situacion === 'CANCELADA'
              ? null
              : boton('Atender', () => abrirCerrarSeguimiento(t, cargarSeguimientos), 'btn btn--mini'),
          ]))),
        ])),
    )
  }

  cuerpo.append(
    barra(),

    // ─── EL MAPA, Y SOLO EL MAPA ───────────────────────────────────────────
    //
    // Un mapa. El de las regiones, que es el que se sabe usar: se pulsa
    // Tombouctou, queda marcada, el mapa se centra y sale su zona.
    //
    el('section', { class: 'seccion-principal' }, [
      el('h2', { class: 'seccion', text: 'Mapa de Mali' }),
      el('div', { class: 'mapa__caja' }, [cajaMapa(), el('div', { class: 'mapa__leyenda' }, [
        leyenda('mapa__zona--principal', 'Con comerciales asignados'),
        leyenda('', 'Sin asignar'),
        leyenda('mapa__zona--activa', 'Seleccionada'),
      ])]),
      cajaGraficos,
      // El mapa se ve al entrar. Las zonas, sus localidades y los controles de
      // asignar se esconden detras de un boton: ocupan media pantalla y no
      // hacen falta para VER el mapa, que es para lo que se viene.
      plegable('Zonas y localidades', el('div', { class: 'pila' }, [
        zonaLista,
        panelZona,
      ])),
    ]),

    // ─── CENTRO DE ALERTAS ──────────────────────────────────────────────
    //
    // Lo primero de la pantalla: es lo que dice si hay que mirar algo.
    secAlertas = plegable('Centro de alertas', listaAlertas, { contador: 0 }),

    secIncidencias = plegable('Incidencias comerciales',
      el('div', { class: 'pila' }, [
        el('p', { class: 'pista' },
          'Problemas de los clientes. Resolver una incidencia no la borra: se queda '
          + 'con su resolución y quién la resolvió, y una vez resuelta no se puede '
          + 'reabrir.'),
        listaIncidencias,
      ]), { contador: 0 }),

    // ─── SEGUIMIENTOS ──────────────────────────────────────────────────
    //
    // Debajo de Incidencias y encima del Ranking: son cosas que necesitan
    // atención, y el ranking se mira cuando ya no hay nada que hacer.
    secTareas = plegable('Tareas de seguimiento', el('div', { class: 'pila' }, [
      el('p', { class: 'pista', text: 'Tareas con fecha y responsable. «Vencida» no se escribe: se calcula con la fecha de hoy, así que una tarea deja de estar vencida sola cuando la atienden.' }),
      listaSeguimientos,
    ])),

    // «Configurar rankings» NO se pinta si el backend no da el permiso. No es
    // que se esconda: `A.puede` lee el permiso real, y sin `rankings:edit` el
    // servidor devuelve 403 a esta misma pantalla.
    puedeConfigurar
      ? plegable('Configurar Rankings', zonaRankings, { contador: 0 })
      : null,
    plegable('Ranking del equipo', el('div', { class: 'pila' }, [
      cajaRanking,
    ])),
  )
  raiz.append(cuerpo)
  try {
    await cargar()
  // Las incidencias se piden DESPUES de montar la pantalla: si fallan, la
  // página ya está dibujada y se ve el error, en vez de quedarse en blanco.
  await cargarSeguimientos()
  await cargarConfigRankings()
  await cargarCentro()
  await cargarIncidencias()
  } catch (e) {
    cuerpo.replaceChildren(aviso(`No se ha podido cargar Comerciales: ${e.message}`, 'error'))
  }
  return raiz
}