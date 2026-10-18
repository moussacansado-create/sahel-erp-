/**
 * VENTAS Y COMISIONES
 *
 * Una sola pantalla, doselligencias.
 *
 *   · el COMERCIAL ve lo suyo: la estimación del mes, el desglose de lo que
 *     la compone, y el historial. Y nunca su comisión definitiva antes de
 *     que el administrador la confirme.
 *
 *   · quien ADMINISTRA ve además el panel: revisar un comercial, preparar
 *     el mes, confirmarlo, registrar el pago, y el historial con la
 *     auditoría.
 *
 * ── LO QUE NO HACE ESTA PANTALLA ──────────────────────────────────────────
 *
 * No calcula. Ni un importe, ni un porcentaje. Todo eso sale de la API, que
 * es donde está la regla y donde se prueba. Si esta pantalla calculara
 * algo, habría dos verdades sobre la misma cifra, y la que se vería en
 * pantalla no sería la que el servidor firma.
 *
 * ── POR QUÉ NO HAY UN CAMPO PARA EL IMPORTE DE LA COMISIÓN ───────────────
 *
 * Por la misma razón que en el cobro de la puerta: la comisión no la sabe
 * quien mira, la sabe el sistema. Se puede REGISTRAR un pago, con su
 * importe, porque eso es un hecho que alguien ha hecho y nadie más sabe.
 * Pero la comisión de un mes no se escribe: se calcula y se confirma.
 *
 * ── EL AISLAMIENTO NO ESTÁ AQUÍ ───────────────────────────────────────────
 *
 * Ocultar un botón no es seguridad. Si esta pantalla se abre con el
 * `comercial_id` de otro, la API recorta los datos a los del token y le
 * devuelve los suyos. El botón se puede esconder; la puerta la cierra el
 * servidor.
 */
import {
  el, boton, aviso, panel, metrica, tabla, campo, opcion, estado, vacio,
  cargando, num, fecha, fechaHora,
} from '../ui.js'
import * as A from '../api.js'

// ── LOS ESTADOS DEL PERIODO ────────────────────────────────────────────────
//
// El nombre que ve la persona. El que va en la base es el del servidor.
const ESTADOS = {
  EN_CURSO: { texto: 'En curso', tono: '' },
  PENDIENTE_REVISION: { texto: 'Pendiente de revisión', tono: 'aviso' },
  CONFIRMADA_PENDIENTE_PAGO: { texto: 'Confirmada, pendiente de pago', tono: 'aviso' },
  PAGADA: { texto: 'Pagada', tono: 'bien' },
}

const METODOS = {
  CASH: 'Efectivo',
  ORANGE_MONEY: 'Orange Money',
  MOBILE_MONEY: 'Móvil Money',
  BANK: 'Banco',
  CHEQUE: 'Cheque',
}

const periodoActual = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const nombreDePeriodo = (p) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(p || ''))
  if (!m) return p || '—'
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
  return `${meses[Number(m[2]) - 1]} de ${m[1]}`
}

const dinero = (v, moneda = 'XOF') => `${num(v, 0)} ${moneda}`

/**
 * La barra de la comisión. Sirve para las dos eligencias: cambia lo que
 * enseña, no de dónde viene el número.
 */
function barraComision(c, mon) {
  const filas = [
    ['Base cobrada en el mes', dinero(c.base_cobrada, mon), 'Lo cobrado de verdad'],
    ['Pendiente de cobro', dinero(c.base_pendiente, mon), 'Vendido y aún no cobrado'],
    ['Porcentaje aplicable', c.porcentaje_aplicado === null || c.porcentaje_aplicado === undefined
      ? '—' : `${num(c.porcentaje_aplicado, 2)} %`, 'El vigente este mes'],
  ]
  return el('div', { class: 'rejilla-metricas' }, [
    ...filas.map(([et, va, no]) => metrica(et, va, no)),
    metrica('Comisión estimada', dinero(c.comision_estimada, mon), 'Provisional hasta que se confirme'),
  ])
}

/** La tabla de cobros, con lo verificado y lo que no, SEPARADOS. */
function tablaCobros(cobros, pendientes, rechazados, mon) {
  const filas = [
    ...(cobros || []).map((c) => ({ ...c, clase: 'cobro--cobrado' })),
    ...(pendientes || []).map((c) => ({ ...c, clase: 'cobro--sinverificar' })),
    ...(rechazados || []).map((c) => ({ ...c, clase: 'cobro--rechazado' })),
  ]
  if (!filas.length) {
    return vacio('No hay cobros en este periodo.')
  }
  return tabla(
    ['Fecha', 'Estado', 'Cliente', 'Pedido', 'Método', 'Importe'],
    el('tbody', {}, filas.map((c) => el('tr', { class: c.clase }, [
      el('td', { class: 'pequeno tenue', text: fechaHora(c.fecha) }),
      el('td', {}, [estado(
        c.estado === 'VERIFIED' ? 'Verificado'
          : c.estado === 'REJECTED' ? 'Rechazado' : 'Sin verificar',
        c.estado === 'VERIFIED' ? 'bien' : c.estado === 'REJECTED' ? 'peligro' : 'aviso',
      )]),
      el('td', { class: 'pequeno', text: c.cliente_nombre || '—' }),
      el('td', { class: 'pequeno mono', text: c.pedido_code || '—' }),
      el('td', { class: 'pequeno tenue', text: METODOS[c.metodo] || c.metodo || '—' }),
      el('td', { class: 'num mono', text: num(c.importe_base, 0) }),
    ]))),
    'tabla--cobros',
  )
}

/** Los pedidos que componen la base, con lo cobrado de cada uno. */
function tablaPedidos(pedidos, mon) {
  if (!pedidos?.length) return vacio('No hay pedidos vendidos en este periodo.')
  return tabla(
    ['Fecha', 'Cliente', 'Pedido', 'Estado', 'Total', 'Cobrado', 'Pendiente'],
    el('tbody', {}, pedidos.map((p) => el('tr', {}, [
      el('td', { class: 'pequeno tenue', text: fecha(p.fecha) }),
      el('td', { class: 'pequeno', text: p.cliente_nombre || '—' }),
      el('td', { class: 'pequeno mono', text: p.pedido_code || '—' }),
      el('td', { class: 'pequeno tenue', text: p.pedido_estado || '—' }),
      el('td', { class: 'num mono', text: num(p.pedido_total, 0) }),
      el('td', { class: 'num mono', text: num(p.cobrado, 0) }),
      el('td', { class: 'num mono', text: num(p.pendiente, 0) }),
    ]))),
    'tabla--pedidos',
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// LA PÁGINA
// ═══════════════════════════════════════════════════════════════════════════
export async function paginaComisiones() {
  const raiz = el('div', { class: 'comisiones' })
  const administra = A.puede('commissions', 'manage')
  raiz.append(cargando('Cargando comisiones…'))

  // ── EL COMERCIAL ─────────────────────────────────────────────────────────
  // EL ROUTER ESPERA QUE ESTA FUNCIÓN DEVUELVA LA PANTALLA.
  //
  // `vista.replaceChildren(contenido)`: lo que se pinta es lo que se
  // devuelve. Si aquí no se devuelve nada, la pantalla sale VACIA y no hay
  // ningun error: el router no se queja, simplemente no pinta nada. Por eso
  // se devuelve `raiz` y no se monta a mano.
  if (!administra) await pantallaComercial(raiz)
  else await pantallaAdmin(raiz)
  return raiz
}

// ───────────────────────────────────────────────────────────────────────────
// LA VISTA DEL COMERCIAL
// ───────────────────────────────────────────────────────────────────────────
async function pantallaComercial(raiz) {
  raiz.replaceChildren()

  const selPeriodo = el('input', { type: 'month', class: 'input', value: periodoActual() })
  const cuerpo = el('div')
  // LA CAJA DEL HISTORIAL, GUARDADA.
  //
  // No se busca por id con `document.getElementById`: el router monta la
  // pantalla DESPUÉS de que esta función termine, así que mientras se está
  // cargando el elemento todavía no está en el documento y la búsqueda
  // devolvería null. Se guarda la referencia y se usa.
  const cajaHistorial = el('div', { id: 'historial-propio' }, [cargando('…')])

  async function cargar() {
    cuerpo.replaceChildren(cargando('…'))
    const periodo = selPeriodo.value || periodoActual()
    let datos
    try {
      datos = await A.api(`/comisiones/mi/${periodo}`)
    } catch (e) {
      cuerpo.replaceChildren(aviso(e.message, 'error'))
      return
    }
    const c = datos.calculo
    const com = datos.comision
    const mon = c.moneda || 'XOF'
    const provisional = datos.provisional

    // LO QUE VE EL COMERCIAL DEPENDE DE SI EL MES ESTÁ CONFIRMADO.
    //
    // Antes de la confirmación ve una ESTIMACIÓN, y se dice. Después ve la
    // comisión DEFINITIVA, congelada, con su estado de pago. Nunca se ve una
    // cifra provisional donde la definitiva, ni al revés.
    const cab = com?.estado ? ESTADOS[com.estado] : ESTADOS.PENDIENTE_REVISION

    // UN MES CONFIRMADO SE MUESTRA CON SUS CIFRAS CONGELADAS.
    //
    // La estimación es de ANTES de confirmar. Si el mes ya está confirmado,
    // lo que vale es lo que se confirmó: la base y el importe de entonces.
    // Enseñar la estimación de ahora al lado de la comisión confirmada
    // daría dos cifras distintas de lo mismo, y la gente compararía.
    const mostrado = provisional ? c : {
      ...c,
      base_cobrada: Number(com.base_confirmada ?? c.base_cobrada),
      porcentaje_aplicado: Number(com.porcentaje_confirmado ?? c.porcentaje_aplicado),
      comision_estimada: Number(com.comision_confirmada ?? c.comision_estimada),
    }

    cuerpo.replaceChildren(
      panel('Mi comisión de ' + nombreDePeriodo(periodo),
        [estado(cab.texto, cab.tono)],
        el('div', { class: 'pila' }, [
          provisional
            ? el('div', { class: 'aviso aviso--info' }, [
              el('strong', { text: 'Estimación provisional. ' }),
              el('span', {
                text: 'Esta cifra se calcula con lo cobrado hasta ahora. '
                  + 'La comisión definitiva la confirma el administrador al cerrar el mes.',
              }),
            ])
            : el('div', { class: 'aviso aviso--bien' }, [
              el('strong', { text: 'Comisión confirmada. ' }),
              el('span', {
                text: com?.estado === 'PAGADA'
                  ? 'Está pagada.'
                  : 'Pendiente de pago.',
              }),
            ]),
          barraComision(mostrado, mon),
          panel('De dónde sale la base', null, el('div', { class: 'pila' }, [
            el('p', { class: 'pista', text: 'Los cobros del mes, con lo verificado y lo que aún no.' }),
            tablaCobros(c.cobros, c.cobros_pendientes, c.cobros_rechazados, mon),
          ])),
          panel('Pedidos del mes', null, tablaPedidos(c.pedidos, mon)),
        ])),
      panel('Meses anteriores', null, cajaHistorial),
    )

    // EL HISTORIAL PROPIO
    const lista = el('div')
    try {
      const h = await A.api('/comisiones')
      const filas = h.comisiones || []
      lista.replaceChildren(filas.length
        ? tabla(['Mes', 'Base cobrada', 'Porcentaje', 'Comisión', 'Estado', 'Pagado'],
          el('tbody', {}, filas.map((f) => el('tr', {}, [
            el('td', { text: nombreDePeriodo(f.periodo) }),
            el('td', { class: 'num mono', text: num(f.base_confirmada ?? f.base_cobrada, 0) }),
            el('td', { class: 'num', text: f.porcentaje_confirmado ?? f.porcentaje_aplicado
              ? `${num(f.porcentaje_confirmado ?? f.porcentaje_aplicado, 2)} %` : '—' }),
            el('td', { class: 'num mono', text: num(f.comision_confirmada ?? f.comision_estimada, 0) }),
            el('td', {}, [estado((ESTADOS[f.estado] || {}).texto || f.estado,
              (ESTADOS[f.estado] || {}).tono)]),
            el('td', { class: 'num mono', text: f.pagado_importe ? num(f.pagado_importe, 0) : '—' }),
          ]))), 'tabla--historial')
        : vacio('Todavía no hay comisiones confirmadas.'))
    } catch (e) {
      lista.replaceChildren(aviso(e.message, 'error'))
    }
    cajaHistorial.replaceChildren(lista)
  }

  selPeriodo.addEventListener('change', cargar)
  raiz.replaceChildren(
    el('div', { class: 'pila' }, [
      panel('Ventas y comisiones', null, el('div', { class: 'pila' }, [
        el('p', { class: 'pista', text: 'Tus ventas del mes, lo que has cobrado y lo que se te calcula.' }),
        campo('Mes', selPeriodo),
      ])),
      cuerpo,
    ]),
  )
  await cargar()
}

// ───────────────────────────────────────────────────────────────────────────
// EL PANEL DE ADMINISTRACIÓN
// ───────────────────────────────────────────────────────────────────────────
async function pantallaAdmin(raiz) {
  raiz.replaceChildren()

  let comerciales = []
  try {
    const r = await A.api('/comerciales')
    comerciales = (r.comerciales || r || []).filter((c) => c.comercial_id || c.id)
  } catch (e) {
    raiz.replaceChildren(aviso('No se han podido cargar los comerciales: ' + e.message, 'error'))
    return
  }

  const selCom = el('select', { class: 'input' })
  selCom.append(opcion('', '— elige un comercial —'))
  for (const c of comerciales) {
    const id = c.comercial_id || c.id
    selCom.append(opcion(String(id), `${c.full_name || c.nombre || c.name || 'Comercial ' + id}`))
  }
  const selPeriodo = el('input', { type: 'month', class: 'input', value: periodoActual() })

  const barra = el('div', { class: 'pila' })
  const detalle = el('div', { class: 'pila' })
  const historial = el('div')

  async function cargarHistorial() {
    const id = Number(selCom.value)
    if (!id) { historial.replaceChildren(); return }
    try {
      const h = await A.api(`/comisiones?comercial_id=${id}`)
      const filas = h.comisiones || []
      historial.replaceChildren(panel('Historial del comercial', null, filas.length
        ? tabla(['Mes', 'Base', 'Porcentaje', 'Comisión', 'Estado', 'Pagado', 'Confirmada'],
          el('tbody', {}, filas.map((f) => el('tr', {}, [
            el('td', { text: nombreDePeriodo(f.periodo) }),
            el('td', { class: 'num mono', text: num(f.base_confirmada ?? f.base_cobrada, 0) }),
            el('td', { class: 'num', text: f.porcentaje_confirmado ?? f.porcentaje_aplicado
              ? `${num(f.porcentaje_confirmado ?? f.porcentaje_aplicado, 2)} %` : '—' }),
            el('td', { class: 'num mono', text: num(f.comision_confirmada ?? f.comision_estimada, 0) }),
            el('td', {}, [estado((ESTADOS[f.estado] || {}).texto || f.estado, (ESTADOS[f.estado] || {}).tono)]),
            el('td', { class: 'num mono', text: f.pagado_importe ? num(f.pagado_importe, 0) : '—' }),
            el('td', { class: 'pequeno tenue', text: f.confirmado_en ? fechaHora(f.confirmado_en) : '—' }),
          ]))), 'tabla--historial')
        : vacio('Ese comercial todavía no tiene comisiones.')))
    } catch (e) {
      historial.replaceChildren(aviso(e.message, 'error'))
    }
  }

  async function cargar() {
    detalle.replaceChildren(cargando('…'))
    await cargarHistorial()
    const id = Number(selCom.value)
    if (!id) {
      barra.replaceChildren()
      detalle.replaceChildren(panel('Elige un comercial y un mes', null,
        vacio('Sin comercial no hay nada que revisar.')))
      return
    }
    const periodo = selPeriodo.value || periodoActual()
    let r
    try {
      r = await A.api(`/comisiones/resumen/${periodo}?comercial_id=${id}`)
    } catch (e) {
      detalle.replaceChildren(aviso(e.message, 'error'))
      return
    }
    const resumen = (r.resumenes || []).find((x) => Number(x.comercial_id) === id)
    if (!resumen) {
      barra.replaceChildren()
      detalle.replaceChildren(panel('Sin datos', null,
        vacio('Este comercial no tiene ventas ni cobros en ' + nombreDePeriodo(periodo) + '.')))
      return
    }
    const c = resumen.calculo
    const com = resumen.comision
    const mon = c.moneda || 'XOF'
    const cab = com?.estado ? ESTADOS[com.estado] : ESTADOS.EN_CURSO

    barra.replaceChildren(
      panel(`Revisión de ${nombreDePeriodo(periodo)}`, [estado(cab.texto, cab.tono)],
        el('div', { class: 'pila' }, [
          barraComision(c, mon),
          com?.comision_confirmada != null
            ? el('div', { class: 'aviso aviso--bien' }, [
              el('strong', { text: 'Comisión confirmada: ' }),
              el('span', { text: `${dinero(com.comision_confirmada, mon)} al ${num(com.porcentaje_confirmado, 2)} % de una base de ${dinero(com.base_confirmada, mon)}.` }),
              el('div', { class: 'tenue pequeno', text: `Confirmada el ${fechaHora(com.confirmado_en)}.` }),
            ])
            : el('div', { class: 'aviso aviso--info' }, [
              el('strong', { text: 'Todavía no está confirmada. ' }),
              el('span', { text: 'El comercial ve una estimación hasta que confirmes.' }),
            ]),
        ])),
    )

    // ── LAS ACCIONES ───────────────────────────────────────────────────────
    const acciones = el('div', { class: 'pila' })

    if (!com) {
      acciones.append(boton('Preparar el mes', async () => {
        try {
          await A.api('/comisiones/preparar', { metodo: 'POST', cuerpo: { periodo } })
          aviso('Mes preparado. Ya puedes revisarlo y confirmarlo.', 'ok')
          await cargar()
        } catch (e) { aviso(e.message, 'error') }
      }, 'btn btn--principal'))
    }

    if (com && com.estado !== 'PAGADA' && com.comision_confirmada == null) {
      const nota = el('input', { class: 'input', placeholder: 'Nota de la confirmación (opcional)' })
      acciones.append(
        el('div', { class: 'pila' }, [
          nota,
          boton('Confirmar comisión', async () => {
            try {
              await A.api(`/comisiones/${com.id}/confirmar`, { metodo: 'POST', cuerpo: { nota: nota.value || null } })
              aviso('Comisión confirmada.', 'ok')
              await cargar()
            } catch (e) { aviso(e.message, 'error') }
          }, 'btn btn--principal'),
        ]),
      )
    }

    if (com && com.estado === 'CONFIRMADA_PENDIENTE_PAGO') {
      const importe = el('input', { type: 'number', class: 'input', min: '1', step: '1', placeholder: 'Importe pagado' })
      const fechaPago = el('input', { type: 'date', class: 'input', value: new Date().toISOString().slice(0, 10) })
      const ref = el('input', { class: 'input', placeholder: 'Referencia o justificante' })
      acciones.append(
        el('div', { class: 'pila' }, [
          el('h4', { class: 'seccion-mini', text: 'Registrar el pago' }),
          campo('Importe', importe), campo('Fecha', fechaPago), campo('Referencia', ref),
          boton('Marcar como pagada', async () => {
            if (!importe.value) { aviso('Falta el importe del pago.', 'error'); return }
            if (!fechaPago.value) { aviso('Falta la fecha del pago.', 'error'); return }
            try {
              await A.api(`/comisiones/${com.id}/pagar`, {
                metodo: 'POST',
                cuerpo: { importe: Number(importe.value), fecha: fechaPago.value, referencia: ref.value || null },
              })
              aviso('Pago registrado.', 'ok')
              await cargar()
            } catch (e) { aviso(e.message, 'error') }
          }, 'btn btn--principal'),
        ]),
      )
    }

    if (com && com.estado === 'CONFIRMADA_PENDIENTE_PAGO') {
      const motivo = el('input', { class: 'input', placeholder: 'Por qué se descarta' })
      acciones.append(
        el('div', { class: 'pila' }, [
          el('h4', { class: 'seccion-mini', text: 'Descartar la confirmación' }),
          el('p', { class: 'pista', text: 'Devuelve el mes a revisión y deja escrito quién lo hizo y por qué. No borra nada.' }),
          campo('Motivo', motivo),
          boton('Descartar y volver a revisión', async () => {
            if (!motivo.value) { aviso('Hay que decir por qué. Queda escrito.', 'error'); return }
            try {
              await A.api(`/comisiones/${com.id}/descartar`, { metodo: 'POST', cuerpo: { motivo: motivo.value } })
              aviso('Mes devuelto a revisión.', 'ok')
              await cargar()
            } catch (e) { aviso(e.message, 'error') }
          }, 'btn'),
        ]),
      )
    }

    // ── EL PORCENTAJE ──────────────────────────────────────────────────────
    const pct = el('input', { type: 'number', class: 'input', min: '0', max: '100', step: '0.001' })
    const desde = el('input', { type: 'date', class: 'input', value: new Date().toISOString().slice(0, 10) })
    const motivoPct = el('input', { class: 'input', placeholder: 'Motivo del cambio' })
    const pctBox = el('div', { class: 'pila' }, [
      el('h4', { class: 'seccion-mini', text: 'Porcentaje del comercial' }),
      el('p', { class: 'pista', text: 'Con fecha de vigencia. Un cambio posterior NO altera los meses ya confirmados.' }),
      campo('Porcentaje', pct), campo('Vigente desde', desde), campo('Motivo', motivoPct),
      boton('Guardar porcentaje', async () => {
        if (pct.value === '') { aviso('Falta el porcentaje.', 'error'); return }
        if (!motivoPct.value) { aviso('Hay que decir por qué. Queda escrito.', 'error'); return }
        try {
          await A.api('/comisiones/porcentajes', {
            metodo: 'POST',
            cuerpo: {
              comercial_id: id, porcentaje: Number(pct.value),
              vigente_desde: desde.value, motivo: motivoPct.value,
            },
          })
          aviso('Porcentaje guardado.', 'ok')
          pct.value = ''; motivoPct.value = ''
          await cargar()
        } catch (e) { aviso(e.message, 'error') }
      }, 'btn'),
    ])

    // ── EL HISTORIAL DE PORCENTAJES ───────────────────────────────────────
    const histPct = el('div')
    try {
      const hp = await A.api(`/comisiones/porcentajes/${id}`)
      const filas = hp.porcentajes || []
      histPct.replaceChildren(filas.length
        ? tabla(['Desde', 'Hasta', 'Porcentaje', 'Motivo', 'Quién'],
          el('tbody', {}, filas.map((p) => el('tr', {}, [
            el('td', { class: 'pequeno', text: fecha(p.vigente_desde) }),
            el('td', { class: 'pequeno tenue', text: p.vigente_hasta ? fecha(p.vigente_hasta) : '—' }),
            el('td', { class: 'num', text: `${num(p.porcentaje, 3)} %` }),
            el('td', { class: 'pequeno', text: p.motivo || '—' }),
            el('td', { class: 'pequeno tenue', text: p.comercial_nombre || '—' }),
          ]))), 'tabla--porcentajes')
        : vacio('Este comercial no tiene porcentaje configurado.'))
    } catch (e) {
      histPct.replaceChildren(aviso(e.message, 'error'))
    }

    // ── LA AUDITORÍA ───────────────────────────────────────────────────────
    let auditoria = null
    if (com?.id) {
      try {
        const d = await A.api(`/comisiones/${com.id}`)
        const filas = d.auditoria || []
        auditoria = filas.length
          ? tabla(['Cuándo', 'Quién', 'Qué pasó', 'De', 'A', 'Motivo'],
            el('tbody', {}, filas.map((a) => el('tr', {}, [
              el('td', { class: 'pequeno tenue', text: fechaHora(a.created_at) }),
              el('td', { class: 'pequeno', text: a.usuario || '—' }),
              el('td', { class: 'pequeno', text: a.accion || '—' }),
              el('td', { class: 'pequeno mono', text: a.valor_anterior ?? '—' }),
              el('td', { class: 'pequeno mono', text: a.valor_nuevo ?? '—' }),
              el('td', { class: 'pequeno tenue', text: a.motivo || '—' }),
            ]))), 'tabla--auditoria')
          : vacio('Sin movimientos registrados todavía.')
      } catch (e) {
        auditoria = aviso(e.message, 'error')
      }
    }

    detalle.replaceChildren(
      el('div', { class: 'pila' }, [
        panel('Acciones del periodo', null, acciones),
        panel('De dónde sale la base', null, el('div', { class: 'pila' }, [
          el('p', { class: 'pista', text: 'Lo cobrado de verdad, lo que aún no está verificado y lo que se rechazó.' }),
          tablaCobros(c.cobros, c.cobros_pendientes, c.cobros_rechazados, mon),
        ])),
        panel('Pedidos del mes', null, tablaPedidos(c.pedidos, mon)),
        pctBox,
        panel('Historial de porcentajes', null, histPct),
        com?.id ? panel('Auditoría', null, auditoria) : null,
      ]),
    )
  }

  selCom.addEventListener('change', cargar)
  selPeriodo.addEventListener('change', cargar)

  raiz.replaceChildren(
    el('div', { class: 'pila' }, [
      panel('Comisiones mensuales', null, el('div', { class: 'pila' }, [
        el('p', { class: 'pista', text: 'La comisión se calcula una vez al mes sobre lo cobrado, y la confirma el administrador. Un comercial solo ve su estimación hasta que se confirma.' }),
        el('div', { class: 'rejilla-metricas rejilla-metricas--filtros' }, [
          campo('Comercial', selCom), campo('Mes', selPeriodo),
        ]),
      ])),
      barra,
      detalle,
      historial,
    ]),
  )
  await cargar()
}
