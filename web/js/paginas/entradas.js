import { el, panel, aviso, num, campo, protegido, estado, fecha, modal } from '../ui.js'
import * as A from '../api.js'
import { tokenActual } from '../api.js'

/**
 * Recepción de mercancía.
 *
 * Formulario de una línea, y el de albarán completo. Los dos van contra la
 * misma API: el albarán es UN endpoint que mete N lotes en UNA transacción. Si
 * una línea falla, no queda ninguna dentro.
 */
// ═══════════════════════════════════════════════════════════════════════════
// LA ETIQUETA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Imprimir la pegata de UNA entrada.
 *
 * Abre en una pestaña nueva la hoja imprimible del servidor, con las medidas en
 * milímetros. Elige tamaño, cuántas y a imprimir. Desde ahí el usuario escoge la
 * impresora —la térmica, o «Microsoft Print to PDF» para probar sin gastar
 * rollo— y le da a imprimir.
 *
 * Reimprimir no toca el stock: la hoja es una VISTA del lote. Lo único que
 * cambia es la bitácora de impresiones.
 */
async function imprimirEtiqueta(loteId, { reimpresion = false } = {}) {
  const formatos = await A.api('/inventory/etiqueta/formatos')
  const f = {
    formato: el('select', {}, formatos.map((x) => el('option', { value: x.code, text: x.nombre }))),
    copias: el('input', { type: 'number', min: '1', max: '200', value: '1' }),
  }
  f.formato.value = '60x40'

  const err = el('p', { class: 'alerta alerta--error oculto' })
  const capa = modal('Imprimir etiqueta', el('div', { class: 'pila' }, [
    el('p', { class: 'pista', text: 'La pegata lleva el número de entrada, el artículo, la cantidad y un QR que lleva a su ficha dentro del ERP. El tamaño debe coincidir con el rollo que tengas montado.' }),
    campo('Tamaño de etiqueta', f.formato),
    campo('Número de copias', f.copias),
    el('p', { class: 'pista', text: 'Varias unidades o cajas del mismo material: una pegata por unidad, con la misma entrada.' }),
    err,
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Abrir para imprimir', async () => {
      err.classList.add('oculto')
      const formato = f.formato.value
      const copias = Math.max(1, Math.min(200, Number(f.copias.value) || 1))
      try {
        await A.api(`/inventory/lotes/${loteId}/etiqueta/imprimir`, {
          metodo: 'POST', cuerpo: { formato, copias, reimpresion },
        })
        capa.remove()
        // ── POR QUÉ NO SE ABRE UNA URL ────────────────────────────────────
        //
        // Abrir `/api/inventory/lotes/N/etiqueta` en una pestaña nueva falla por
        // dos motivos, y los dos se han visto en un móvil real:
        //
        //  1. Sin el prefijo `/api`, el servidor no encuentra la ruta y cae en
        //     el fallback de la SPA, que devuelve el index.html. El usuario ve
        //     la pantalla de acceso en lugar de la etiqueta.
        //
        //  2. Con el prefijo, tampoco: la sesion viaja en la cabecera
        //     `Authorization`, y una pestaña nueva no la lleva. Sale un 401.
        //
        // La solucion es NO navegar: se pide la etiqueta con la cabecera que si
        // tenemos, se incrusta el QR como imagen —dentro de un `blob:` las rutas
        // absolutas no significan nada— y se abre el resultado como documento.
        // La pestaña recibe la etiqueta, no un 401.
        // La ventana se abre ANTES de esperar nada, y en el mismo clic.
        //
        // Abrirla después de dos `fetch` es pedir que la bloquee el navegador:
        // el bloqueador solo acepta ventanas abiertas durante el gesto del
        // usuario, y un `await` lo rompe. Con la ventana ya abierta de antes,
        // da igual que tarde un segundo: solo hay que llenarla.
        const v = window.open('', '_blank')
        if (!v) { aviso('El navegador ha bloqueado la ventana. Permite las ventanas emergentes para este sitio.', 'aviso'); return }
        v.document.title = 'Preparando etiqueta…'
        try {
          const url = `${A.baseApi()}/api/inventory/lotes/${loteId}/etiqueta`
            + `?formato=${formato}&copias=${copias}`
          const cab = tokenActual() ? { Authorization: 'Bearer ' + tokenActual() } : {}
          const r = await fetch(url, { headers: cab })
          if (!r.ok) throw new Error('el servidor respondió ' + r.status)
          let html = await r.text()

          // El QR dentro del blob tiene que venir incrustado, no pedido por URL.
          const mqr = html.match(/src="(\/api\/inventory\/lotes\/\d+\/qr\.png[^"]*)"/)
          if (mqr) {
            const q = await fetch(A.baseApi() + mqr[1], { headers: cab })
            if (q.ok) {
              // `q.blob()` devuelve una PROMESA. Pasársela a `readAsDataURL()`
              // directamente revienta con «parameter 1 is not of type 'Blob'»,
              // que es como fallen las cosas a mitad de un flujo y nadie sabe
              // qué lo provocó.
              const blobQr = await q.blob()
              const b64 = await new Promise((res) => {
                const fr = new FileReader()
                fr.onload = () => res(String(fr.result).split(',')[1] || '')
                fr.onerror = () => res('')
                fr.readAsDataURL(blobQr)
              })
              html = html.replace(mqr[1], 'data:image/png;base64,' + b64)
            }
          }

          // `document.write` en una pestaña ya abierta está DESACONSEJADO y en
          // Safari puede ignorarse sin más. Un `blob:` es lo mismo de fiable:
          // la pestaña carga un documento de verdad, con su CSS y su botón de
          // impresión, en vez de un documento a medio construir.
          const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
          v.location.replace(blobUrl)
          // El blob se puede revocar cuando la pestaña ya lo ha leído. Si se
          // revoca antes, Safari se queda con una pestaña en blanco.
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000)
        } catch (e) {
          err.textContent = 'No se pudo preparar la etiqueta: ' + e.message
          err.classList.remove('oculto')
          return
        }
        capa.remove()
        aviso('Etiqueta lista. Elige la impresora térmica y dale a imprimir.')
      } catch (e) { err.textContent = e.message; err.classList.remove('oculto') }
    }, 'btn btn--principal'),
  ])
}

export async function paginaEntradas() {
  const caja = el('div')
  const [items, proveedores] = await Promise.all([
    A.api('/items'),
    A.api('/suppliers').catch(() => []),
  ])

  const recibidos = items.filter((i) => i.is_active)
  if (!recibidos.length) {
    return el('div', { class: 'panel' }, [el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'alerta alerta--aviso', text: 'No hay artículos en el catálogo. Crea uno antes de registrar entradas.' }),
    ])])
  }

  const punto = (clave) => recibidos.find((i) => i.id === Number(clave))
  const unidades = new Set(recibidos.map((i) => i.unit_id))

  // ── Entrada de una línea ──
  const f1 = {
    item: el('select', {}, recibidos.map((i) => el('option', {
      value: i.id, text: `${i.sku} · ${i.name}${unidades.size > 1 ? '' : ''}` }))),
    cantidad: el('input', { type: 'number', step: 'any', min: '0.0001', placeholder: '0' }),
    caducidad: el('input', { type: 'date' }),
    albaran: el('input', { placeholder: 'ALB-001' }),
    loteProv: el('input', { placeholder: 'Lote del fabricante' }),
    coste: el('input', { type: 'number', step: 'any', min: '0', value: '' }),
    proveedor: el('select', {}, [el('option', { value: '', text: '— sin proveedor —' }),
      ...proveedores.map((s) => el('option', { value: s.id, text: s.name }))]),
  }
  const err1 = el('p', { class: 'alerta alerta--error oculto' })
  const salida1 = el('div')

  caja.append(panel('Recepción rápida · una línea', null, [
    el('div', { class: 'rejilla rejilla--3' }, [
      campo('Artículo', f1.item, true),
      campo('Cantidad', f1.cantidad),
      campo('Caducidad', f1.caducidad),
      campo('Nº de albarán', f1.albaran),
      campo('Lote del proveedor', f1.loteProv),
      campo('Proveedor', f1.proveedor),
      campo('Coste unitario', f1.coste),
    ]),
    el('div', { class: 'pila pila--fin', style: 'margin-top:16px' }, [
      boton('Registrar entrada', protegido(async () => {
        err1.classList.add('oculto')
        try {
          const cuerpo = {
            itemId: Number(f1.item.value),
            cantidad: Number(f1.cantidad.value),
            caducidad: f1.caducidad.value || null,
            numeroAlbaran: f1.albaran.value.trim() || null,
            loteProveedor: f1.loteProv.value.trim() || null,
            costeUnitario: f1.coste.value === '' ? null : Number(f1.coste.value),
            proveedorId: f1.proveedor.value ? Number(f1.proveedor.value) : null,
          }
          const r = await A.api('/inventory/recepciones', { metodo: 'POST', cuerpo })
          salida1.replaceChildren(avisoReal(r, () => imprimirEtiqueta(r.lote.id)))
          f1.cantidad.value = ''
        } catch (e) {
          err1.textContent = e.message
          err1.classList.remove('oculto')
        }
      }), 'btn btn--principal'),
    ]),
    err1, salida1,
  ]))

  // ── Albarán con varias líneas ──
  caja.append(panel('Albarán completo · varias líneas en una sola transacción', null, albaran(punto, unidades, recibidos)))

  // ── Historial de entradas, con reimpresión ──
  //
  // Una pegata se pierde, se mancha o se pega en la caja equivocada. Poder volver
  // a imprimirla NO es un lujo: es la diferencia entre tener el material
  // identificado o tener un bidón suelto en un almacén. Y NO vuelve a crear la
  // entrada ni mueve una unidad: la etiqueta es una vista del lote.
  const listaEntradas = el('div')
  const buscar = el('input', { placeholder: 'Buscar por entrada, lote, código o nombre' })
  const puede = A.puede('inventory', 'create')
  let timer = null
  buscar.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => cargarEntradas(buscar.value.trim()), 300)
  })

  async function cargarEntradas(texto = '') {
    try {
      const filas = await A.api(`/inventory/entradas?limite=100&buscar=${encodeURIComponent(texto)}`)
      if (!filas.length) {
        listaEntradas.replaceChildren(vacio('Ninguna entrada coincide con esa búsqueda.'))
        return
      }
      listaEntradas.replaceChildren(el('div', { class: 'rejilla rejilla--tabla' }, [tablaEntradas(filas, puede)]))
    } catch (e) {
      listaEntradas.replaceChildren(aviso('No se pudo cargar el historial: ' + e.message, 'error'))
    }
  }

  function tablaEntradas(filas, conBoton) {
    return el('table', { class: 'tabla' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Nº entrada' }), el('th', { text: 'Lote Sahel' }),
        el('th', { text: 'Lote fab.' }), el('th', { text: 'Artículo' }),
        el('th', { text: 'Tipo' }), el('th', { text: 'Recibido' }),
        el('th', { text: 'Impresiones' }), el('th', { text: '' }),
      ])]),
      el('tbody', {}, filas.map((f) => el('tr', {}, [
        el('td', {}, [el('strong', { class: 'mono', text: f.entrada_no })]),
        el('td', { class: 'mono', text: f.lote_interno }),
        el('td', { class: 'mono', text: f.supplier_lot_code || '—' }),
        el('td', { text: `${f.sku} · ${f.articulo}` }),
        el('td', { text: f.tipoMaterial }),
        el('td', { text: fecha(f.received_at) }),
        el('td', { text: f.impresiones ? `${f.impresiones}×` : '—' }),
        el('td', {}, [conBoton
          ? boton('Etiqueta', () => imprimirEtiqueta(f.id, { reimpresion: f.impresiones > 0 }), 'btn btn--mini')
          : el('span', { class: 'tenue', text: 'sin permiso' })]),
      ]))),
    ])
  }

  caja.append(panel('Entradas registradas · reimprimir etiqueta', null, el('div', { class: 'pila' }, [
    el('div', { style: 'max-width:360px' }, [campo('Buscar entrada', buscar)]),
    puede
      ? null
      : aviso('Tu rol puede consultar las entradas pero no tiene permiso de almacén, así que no puede imprimirlas.', 'aviso'),
    listaEntradas,
  ])))
  await cargarEntradas()

  return caja
}

function albaran(punto, unidades, recibidos) {
  const lineas = el('div')
  const numAlbaran = el('input', { placeholder: 'ALB-002' })
  const err = el('p', { class: 'alerta alerta--error oculto' })
  const resultado = el('div')

  function nuevaLinea(valores = {}) {
    const l = {
      item: el('select', {}, recibidos.map((i) => el('option', { value: i.id, text: `${i.sku} · ${i.name}`, selected: i.id === valores.itemId }))),
      cantidad: el('input', { type: 'number', step: 'any', min: '0.0001', value: valores.cantidad ?? '' }),
      caducidad: el('input', { type: 'date', value: valores.caducidad || '' }),
      loteProv: el('input', { value: valores.loteProveedor || '', placeholder: 'Lote fabricante' }),
    }
    const fila = el('div', { class: 'linea-albaran' }, [
      el('div', { style: 'flex:3' }, [campo('Artículo', l.item)]),
      el('div', { style: 'flex:1' }, [campo('Cantidad', l.cantidad)]),
      el('div', { style: 'flex:1' }, [campo('Caducidad', l.caducidad)]),
      el('div', { style: 'flex:1.5' }, [campo('Lote proveedor', l.loteProv)]),
      el('div', { style: 'display:flex;align-items:flex-end;padding-bottom:2px' }, [
        boton('Quitar', () => fila.remove(), 'btn btn--mini'),
      ]),
    ])
    lineas.append(fila)
    return l
  }
  nuevaLinea(); nuevaLinea()

  return el('div', {}, [
    el('div', { style: 'max-width:320px;margin-bottom:14px' }, [campo('Nº de albarán (evita duplicados al reintentar)', numAlbaran)]),
    lineas,
    el('div', { class: 'pila', style: 'margin-top:12px' }, [boton('+ Añadir línea', () => nuevaLinea())]),
    el('div', { class: 'pila pila--fin', style: 'margin-top:16px' }, [
      boton('Registrar albarán entero', protegido(async () => {
        err.classList.add('oculto')
        resultado.replaceChildren()
        const lineasEnviadas = [...lineas.querySelectorAll('.linea-albaran')].map((f) => ({
          itemId: Number(f.querySelector('select').value),
          cantidad: Number(f.querySelector('input[type=number]').value),
          caducidad: f.querySelector('input[type=date]').value || null,
          loteProveedor: f.querySelectorAll('input[type=text], input:not([type])')[0]?.value.trim() || null,
        })).filter((l) => Number.isFinite(l.cantidad) && l.cantidad > 0)

        if (!lineasEnviadas.length) { err.textContent = 'Añade al menos una línea con cantidad.'; err.classList.remove('oculto'); return }

        try {
          const r = await A.api('/inventory/recepciones/masivas', {
            metodo: 'POST',
            cuerpo: { lineas: lineasEnviadas, numeroAlbaran: numAlbaran.value.trim() || null },
          })
          resultado.replaceChildren(el('div', { class: 'alerta alerta--bien' }, [
            el('div', { text: r.mensaje }),
            el('ul', { style: 'margin:8px 0 0;padding-left:20px' }, r.lotes.map((l) =>
              el('li', {}, [
                el('span', { class: 'mono', text: l.code }),
                ' · ', num(l.qty_available, 0), ' ',
                boton('Etiqueta', () => imprimirEtiqueta(l.id), 'btn btn--mini'),
              ]))),
          ]))
          aviso(r.mensaje)
          lineas.replaceChildren(); nuevaLinea(); nuevaLinea(); numAlbaran.value = ''
        } catch (e) {
          err.textContent = e.message
          err.classList.remove('oculto')
        }
      }), 'btn btn--principal'),
    ]),
    err, resultado,
  ])
}

function avisoReal(r, alImprimir) {
  return el('div', { class: 'alerta alerta--bien' }, [
    el('div', { text: `Entrada ${r.lote.entrada_no} · Lote ${r.lote.code} creada` }),
    el('div', { class: 'pequeno', text: `Disponible ahora: ${num(r.stock.qty_available)} · Apartado: ${num(r.stock.qty_reserved)}` }),
    // El paso siguiente del trabajo: la pegata va en el bote, en la caja o en
    // el bidón. Sin ella el material entra en el almacén sin identificar.
    alImprimir
      ? el('div', { class: 'pila', style: 'margin-top:10px' }, [
        boton('Imprimir etiqueta', alImprimir, 'btn btn--principal'),
        el('span', { class: 'pequeno', text: 'También podrás volver a imprimirla después desde el historial.' }),
      ])
      : null,
  ])
}

function boton(texto, onclick, clase = 'btn') {
  return el('button', { class: clase, text: texto, onclick })
}
