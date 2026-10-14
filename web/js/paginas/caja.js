/**
 * CAJA
 *
 * Lo que ve la persona que recibe el dinero.
 *
 * Tres cosas, en este orden y ninguna más:
 *
 *   1. QUIÉN LLEVA QUÉ — y de dónde sale ese número.
 *   2. ABRIR UN TRASPASO — quién viene, en qué moneda. Sin cifras.
 *   3. RECIBIR — lo que ha contado en la mano, y una casilla para explicar por
 *      qué no cuadra.
 *
 * ── EL NÚMERO MÁS GRANDE DE LA PANTALLA ES EL QUE LA CAJA ESPERA ───────────
 *
 * Antes de abrir nada. Porque «cuánto debería haber» es el dato contra el que
 * se compara todo lo demás, y si la caja lo ve después de contar, ya ha
 * contado mal a propósito.
 *
 * ── POR QUÉ NO HAY UN CAMPO DE «LO QUE LLEVA» ──────────────────────────────
 *
 * Por lo mismo que en el cobro. Este número sale de `fn_por_entregar()`, que
 * cuenta los cobros y descuenta los ya entregados. Si se pudiera escribir, el
 * campo sería un segundo lugar donde dice cuánto dinero hay, y la
 * conciliación compararía la caja contra ella misma.
 *
 * Y en la caja esto no es un detalle teórico: es que la caja cuenta dinero en
 * efectivo delante de otra persona, y la cifra que tiene delante es la que
 * hace la cuenta.
 */

import {
  el, boton, aviso, modal, panel, cargando, vacio, tabla, campo,
} from '../ui.js'
import * as A from '../api.js'

/** Un importe con los decimales de SU moneda. XOF no lleva. */
function dinero(v, moneda) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '—'
  const dec = moneda === 'EUR' ? 2 : 0
  // `es-ES` NO pone separador de miles en los números de cuatro cifras: por eso
  // salía «3000» al lado de «25.000» en la misma fila. En dinero eso no se
  // permite: se agrupa siempre. El separador de millares lo pone `es-ES`, y no
  // el decimal, que en XOF no existe.
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: 'always',
  }) + ' ' + (moneda === 'EUR' ? 'EUR' : 'FCFA')
}

  // ══════════════════════════════════════════════════════════════════════
  // MI CAJA: LA SESIÓN DEL DÍA
  //
  // Lo de arriba es el traspaso: el repartidor vuelve con el dinero. Esto es la
  // caja: el día, con su fondo, sus movimientos y su arqueo.
  //
  // El ORDEN importa y va en el sitio, no de memoria: primero se cuenta (arqueo),
  // y el esperado se enseña AL LADO de lo contado, no antes. Si el sistema dijera
  // primero cuánto debería haber, quien cuenta miraría la respuesta.
  // ══════════════════════════════════════════════════════════════════════

  async function miCaja(moneda, recargar) {
    const abierta = await A.api('/caja/sesion/actual?moneda=' + encodeURIComponent(moneda))

    if (!abierta.abierta) {
      return panel('Abrir la caja de hoy', [], [
        el('p', { class: 'caja__intro' },
          'Antes de abrir se cuenta el dinero que hay en el cajón. Ese es el fondo, '
          + 'y a partir de él se calcula lo que debería haber al final del día.'),
        el('div', { class: 'caja__abrir' }, [
          campo('Fondo inicial (contado a mano)', el('input', { id: 'caja-fondo', type: 'number', step: '0.01', min: '0', placeholder: '0' })),
          campo('Nota (opcional)',
            el('input', { id: 'caja-nota', type: 'text', placeholder: 'Qué hay en el cajón al abrir' })),
          boton('Abrir caja', async () => {
            const fondo = document.getElementById('caja-fondo').value
            const nota = document.getElementById('caja-nota').value
            try {
              await A.api('/caja/sesion', { metodo: 'POST', cuerpo: { fondoContado: Number(fondo || 0), moneda, notas: nota || null } })
              recargar()
            } catch (e) { aviso(e.message, 'error') }
          }, 'principal'),
        ]),
      ])
    }

    const filas = abierta.movimientos || []
    const totales = el('div', { class: 'caja__cifras' }, [
      cifraCaja('Fondo', dinero(abierta.fondo, moneda), 'Lo que había al abrir'),
      cifraCaja('Entradas', '+ ' + dinero(abierta.entradas, moneda), 'Cobros y entregas'),
      cifraCaja('Salidas', '− ' + dinero(abierta.salidas, moneda), 'Retiros y gastos'),
      cifraCaja('Esperado', dinero(abierta.esperado, moneda), 'Lo que debería haber ahora', 'caja__cifra--esperado'),
    ])

    const conMov = tabla(
      ['Hora', 'Tipo', 'Concepto', 'Importe'],
      filas.map((m) => [
        String(m.created_at).slice(11, 16),
        m.kind === 'IN' ? 'Entra' : 'Sale',
        m.concepto,
        (m.kind === 'IN' ? '+ ' : '− ') + dinero(m.importe, moneda),
      ]),
    )

    const bloqueArqueo = el('div', { class: 'caja__arqueo' }, [
      el('h3', { text: 'Arqueo y cierre' }),
      el('p', { class: 'caja__nota' },
        'Se cuenta el dinero del cajón y se escribe. El sistema ya ha calculado '
        + 'cuánto debería haber: se enseña al lado, no antes, para no contar mirando.'),
      campo('Efectivo contado', el('input', { id: 'caja-contado', type: 'number', step: '0.01', min: '0', placeholder: '0' })),
      campo('Si no cuadra, qué ha pasado',
            el('input', { id: 'caja-arqueo-nota', type: 'text', placeholder: 'Obligatorio si hay descuadre' })),
      el('div', { class: 'caja__previsto' }, [
        el('span', { text: 'Esperado ahora: ' }),
        el('strong', { text: dinero(abierta.esperado, moneda) }),
      ]),
      boton('Cerrar caja', async () => {
        const contado = document.getElementById('caja-contado').value
        const nota = document.getElementById('caja-arqueo-nota').value
        try {
          const r = await A.api('/caja/sesion/' + abierta.id + '/cerrar', { metodo: 'POST', cuerpo: {
            contado: Number(contado || 0), notas: nota || null } })
          aviso(
            r.diferencia === 0
              ? 'Caja cerrada. Cuadra.'
              : 'Caja cerrada con un descuadre de ' + dinero(r.diferencia, moneda) + '. Queda registrado.',
            r.diferencia === 0 ? 'ok' : 'aviso',
          )
          recargar()
        } catch (e) { aviso(e.message, 'error') }
      }, 'principal'),
    ])

    return panel('Caja de hoy', [], [
      el('p', { class: 'caja__intro' },
        'Abierta ' + String(abierta.abiertaAt).slice(11, 16) + '. Nada entra ni sale de una caja cerrada.'),
      totales,
      el('h3', { text: 'Meter y sacar dinero' }),
      el('div', { class: 'caja__mov' }, [
        el('label', { class: 'campo' }, [
          el('span', { text: 'Tipo' }),
          el('select', { id: 'caja-kind' }, [
            el('option', { value: 'IN', text: 'Entra dinero' }),
            el('option', { value: 'OUT', text: 'Sale dinero' }),
          ]),
        ]),
        campo('Concepto',
            el('input', { id: 'caja-concepto', type: 'text', placeholder: 'Cobro, gasto, retiro…' })),
        campo('Importe', el('input', { id: 'caja-importe', type: 'number', step: '0.01', min: '0', placeholder: '0' })),
        boton('Anotar', async () => {
          const body = {
            kind: document.getElementById('caja-kind').value,
            concepto: document.getElementById('caja-concepto').value,
            importe: Number(document.getElementById('caja-importe').value || 0),
          }
          try {
            await A.api('/caja/sesion/' + abierta.id + '/movimientos', { metodo: 'POST', cuerpo: body })
            recargar()
          } catch (e) { aviso(e.message, 'error') }
        }),
      ]),
      conMov,
      bloqueArqueo,
    ])
  }

  /** Una cifra grande con su explicacion debajo. */
  function cifraCaja(titulo, valor, pie, clase = '') {
    return el('div', { class: 'caja__cifra ' + clase }, [
      el('span', { class: 'caja__cifra-titulo', text: titulo }),
      el('strong', { class: 'caja__cifra-valor', text: valor }),
      el('span', { class: 'caja__cifra-pie', text: pie }),
    ])
  }

  /** Consulta por día, semana o mes, con los descuadres a la vista. */
  /** «+150.000» o «−20.000». El signo va DENTRO de la cifra, no pegado al lado. */
  const signo = (v, moneda) => (Number(v) >= 0 ? '+ ' : '− ') + dinero(Math.abs(Number(v)), moneda)

  /** Una SALIDA lleva menos siempre. Su valor viene positivo, así que mirar el
   *  signo del número no vale: 20.000 de gastos se pintaban como «+ 20.000». */
  const menos = (v, moneda) => '− ' + dinero(Math.abs(Number(v)), moneda)

  /**
   * UNA TARJETA POR JORNADA. No una fila en una tabla de ocho columnas.
   *
   * Una tabla con «Fondo · Entradas · Salidas · Esperado · Contado · Diferencia»
   * obliga a leer la CABECERA para saber qué es cada número, y con ocho columnas
   * en un móvil la etiqueta ya no está donde el número. Aquí cada cifra lleva
   * su nombre pegado, y las que mandan —esperado, contado, diferencia— están
   * separadas del resto porque son las tres que se comparan entre sí.
   */
  function tarjetaJornada(s, moneda) {
    const descuadre = s.descuadre
    const retiradaPendiente = s.retiradaPendiente
    const estado = !s.cerrada ? 'ABIERTA'
      : descuadre ? 'CERRADA CON DESCUADRE'
        : retiradaPendiente ? 'CERRADA · RETIRADA PENDIENTE'
          : 'CERRADA CORRECTAMENTE'
    const clase = !s.cerrada ? 'jornada--abierta'
      : descuadre ? 'jornada--descuadre'
        : retiradaPendiente ? 'jornada--pendiente' : 'jornada--ok'

    // Una fila: etiqueta a la izquierda, cifra a la derecha. La etiqueta NUNCA
    // se deduce de la posición: alguien que llegue aquí sin conocer el modelo
    // tiene que poder leerlo entero sin instrucciones.
    const fila = (etiqueta, valor, opts = {}) => el('div', { class: 'jornada__fila' + (opts.fuerte ? ' jornada__fila--fuerte' : '') }, [
      el('span', { class: 'jornada__etiqueta', text: etiqueta }),
      el('span', { class: 'jornada__valor' + (opts.clase ? ' ' + opts.clase : ''), text: valor }),
    ])

    const bloqueRetiradas = s.retiradas && s.retiradas.length
      ? el('div', { class: 'jornada__retiradas' }, [
        el('h4', { class: 'jornada__subtitulo', text: 'Retiradas DESPUÉS del cierre' }),
        el('p', { class: 'jornada__pista' },
          'Una retirada no es una salida de caja. El dinero no se ha gastado: ha '
          + 'cambiado de manos. El resultado del día, arriba, no cambia.'),
        el('ul', { class: 'jornada__lista' }, s.retiradas.map((w) => el('li', { class: 'jornada__retirada' }, [
          el('span', { class: 'jornada__destino', text: w.destino === 'CAJA_MATRIZ' ? 'Caja matriz' : w.destino.charAt(0) + w.destino.slice(1).toLowerCase() }),
          el('span', { class: 'jornada__a-quien', text: w.destinatario || 'sin destinatario anotado' }),
          el('span', { class: 'jornada__importe-retirado', text: dinero(w.importe, moneda) }),
        ]))),
        fila('Total retirado', dinero(s.retirado, moneda), { fuerte: true }),
        fila('Pendiente de retirar', dinero(s.pendiente, moneda),
          { clase: retiradaPendiente ? 'jornada__valor--alerta' : '' }),
      ])
      : (s.cerrada && s.pendiente !== null && s.pendiente !== 0
        ? el('div', { class: 'jornada__retiradas' }, [
          el('h4', { class: 'jornada__subtitulo', text: 'Retiradas DESPUÉS del cierre' }),
          el('p', { class: 'jornada__pista', text: 'Todavía no se ha registrado ninguna retirada de esta jornada.' }),
          fila('Pendiente de retirar', dinero(s.pendiente, moneda), { clase: 'jornada__valor--alerta', fuerte: true }),
        ])
        : null)

    return el('article', { class: 'jornada ' + clase }, [
      el('header', { class: 'jornada__cabecera' }, [
        el('div', {}, [
          el('h3', { class: 'jornada__fecha', text: fechaLarga(s.abiertaAt) }),
          el('p', { class: 'jornada__quien', text: s.usuario + ' · caja abierta a las ' + hora(s.abiertaAt) }),
        ]),
        el('span', { class: 'jornada__estado', text: estado }),
      ]),

      el('div', { class: 'jornada__bloque' }, [
        el('p', { class: 'jornada__leyenda', text: 'El dinero durante el día' }),
        fila('Fondo inicial (contado al abrir)', dinero(s.fondo, moneda)),
        fila('Entradas (dinero que ha entrado)', signo(s.entradas, moneda), { clase: 'jornada__valor--entra' }),
        fila('Salidas (dinero que ha salido)', menos(s.salidas, moneda), { clase: 'jornada__valor--sale' }),
      ]),

      el('div', { class: 'jornada__bloque jornada__bloque--comparacion' }, [
        el('p', { class: 'jornada__leyenda', text: 'El cierre: lo que debía haber y lo que había' }),
        fila('Efectivo esperado', dinero(s.esperado, moneda), { fuerte: true }),
        fila('Efectivo contado', s.contado === null ? '—' : dinero(s.contado, moneda), { fuerte: true }),
        // El descuadre se dice con palabras, no solo con un -1.000 suelto.
        el('div', { class: 'jornada__fila jornada__fila--fuerte' }, [
          el('span', { class: 'jornada__etiqueta', text: 'Diferencia' }),
          el('span', { class: 'jornada__valor' + (descuadre ? ' jornada__valor--alerta' : ' jornada__valor--ok'),
            text: s.diferencia === null ? '—'
              : descuadre ? (dinero(s.diferencia, moneda) + '  ·  ' + (Number(s.diferencia) < 0 ? 'faltó dinero' : 'sobró dinero'))
                : '0 FCFA  ·  cuadra' }),
        ]),
        s.cerrada && s.arqueoNota
          ? el('p', { class: 'jornada__nota', text: 'Motivo anotado: ' + s.arqueoNota })
          : null,
      ]),

      bloqueRetiradas,
    ])
  }

  async function periodoCaja(moneda, periodo) {
    const p = await A.api('/caja/periodo?periodo=' + periodo + '&moneda=' + encodeURIComponent(moneda))
    const jornadas = (p.sesiones || [])

    // Resumen del periodo: tres cifras y ninguna más. Si hay un descuadre, se
    // dice con la palabra «descuadre» al lado del número.
    const resumen = el('div', { class: 'caja__cifras' }, [
      cifraCaja('Jornadas', String(jornadas.length), jornadaCuentas(jornadas, 'cerrada') + ' cerrada(s)'),
      cifraCaja('Total esperado', dinero(p.totalEsperado, moneda), 'Suma del efectivo esperado de cada día'),
      cifraCaja('Total contado', dinero(p.totalContado, moneda), 'Suma de lo que se contó al cerrar'),
      cifraCaja('Diferencias', dinero(p.totalDiferencia, moneda),
        p.sesionesConDescuadre === 0
          ? 'Ningún descuadre en el periodo'
          : p.sesionesConDescuadre + ' jornada(s) con descuadre',
        p.sesionesConDescuadre === 0 ? '' : 'caja__cifra--alerta'),
    ])

    return panel('Historial de caja · ' + periodo.toLowerCase(), [], [
      el('p', { class: 'caja__intro' },
        'Del ' + p.desde + ' al ' + p.hasta + '. Cada tarjeta es UNA JORNADA de caja, '
        + 'no un movimiento suelto: lo más reciente arriba. Un descuadre no se borra, '
        + 'se queda con su fecha, su cantidad y su nota.'),
      resumen,
      el('div', { class: 'jornadas' }, jornadas.length
        ? jornadas.map((s) => tarjetaJornada(s, moneda))
        : [el('p', { class: 'caja__intro', text: 'No hay jornadas de caja en este periodo.' })]),
    ])
  }

  const jornadaCuentas = (jornadas, tipo) => jornadas.filter((s) => s.cerrada).length

  /** «08/10/2026» */
  const fechaLarga = (iso) => {
    const d = new Date(iso)
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear()
  }

  /** «20:07» */
  const hora = (iso) => {
    const d = new Date(iso)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

/**
 * La pantalla de caja.
 *
 * @param {object} ctx
 * @param {string} ctx.moneda
 */
export async function paginaCaja(ctx) {
  const caja = el('div', { class: 'pila' })
  const cabecera = el('div')
  const contLista = el('div')
  let moneda = ctx?.moneda || 'XOF'
    // Qué se está mirando: la caja de hoy, el dinero de un periodo, o los
    // traspasos de reparto. Son tres cosas distintas y se eligen, no se mezclan.
    let vista = 'CAJA'
    let periodo = 'MES'

  async function recargar() {
    contLista.replaceChildren(cargando('Abriendo la caja…'))
    const [pendientes, traspasos] = await Promise.all([
      A.api(`/caja/pendientes?moneda=${moneda}`),
      A.api(`/caja/traspasos?moneda=${moneda}`),
    ])

    cabecera.replaceChildren(el('div', { class: 'ficha-cifras' }, [
      cifra('Repartidores con dinero', pendientes.length),
      cifra('Total que debería haber',
        dinero(pendientes.reduce((t, p) => t + Number(p.lleva_ahora || 0), 0), moneda)),
      cifra('Traspasos', traspasos.length),
    ]))

      if (vista === 'CAJA') {
        contLista.replaceChildren(await miCaja(moneda, recargar))
        return
      }
      if (vista === 'PERIODO') {
        contLista.replaceChildren(await periodoCaja(moneda, periodo))
        return
      }

    contLista.replaceChildren(
      pendientes.length
        ? panel('Quién lleva qué', [
          boton('Recargar', () => recargar(), 'btn btn--mini'),
        ], el('div', { class: 'panel__cuerpo pila' }, [
          // La columna del importe va la última y es la más grande. Es lo que la
          // caja va a comparar con lo que cuenta.
          tablaCaja(pendientes, moneda, recargar),
        ]))
        : vacio('No hay nadie con dinero pendiente de entregar.', '💶'),
      el('div', { style: 'height:18px' }),
      panel('Traspasos', [], tablaTraspasos(traspasos, moneda)),
    )
  }

  caja.append(
    el('p', { class: 'pista' }, [
      'Cada repartidor entrega aquí el dinero que ha cobrado. Lo que lleva lo ',
      'cuenta el sistema a partir de sus cobros, y no se escribe: la caja ',
      'cuenta lo que tiene en la mano, y si no coincide, se anota por qué. ',
      'Una diferencia sin explicación no se guarda.',
    ]),
    cabecera,
    el('div', { class: 'caja__pestanos' }, [
      boton('Mi caja de hoy', () => { vista = 'CAJA'; recargar() }, 'btn btn--mini'),
      boton('Dinero del dia', () => { periodo = 'DIA'; vista = 'PERIODO'; recargar() }, 'btn btn--mini'),
      boton('de la semana', () => { periodo = 'SEMANA'; vista = 'PERIODO'; recargar() }, 'btn btn--mini'),
      boton('del mes', () => { periodo = 'MES'; vista = 'PERIODO'; recargar() }, 'btn btn--mini'),
      boton('Traspasos de reparto', () => { vista = 'TRASPASOS'; recargar() }, 'btn btn--mini'),
    ]),
    contLista,
  )
  await recargar()
  return caja
}

function cifra(t, n) {
  return el('div', { class: 'cifra' }, [
    el('div', { class: 'cifra__n', text: String(n) }),
    el('div', { class: 'cifra__t', text: t }),
  ])
}

function tablaCaja(pendientes, moneda, recargar) {
  const cuerpo = el('tbody')
  for (const p of pendientes) {
    cuerpo.append(el('tr', {}, [
      el('td', {}, [
        el('b', { text: p.full_name }),
        el('div', { class: 'pequeno tenue', text: `@${p.username}` }),
      ]),
      el('td', { class: 'pequeno tenue col-secundaria' }, [
        el('div', { text: `Cobrado ${dinero(p.cobrado, p.currency_code)}` }),
        el('div', {
          class: Number(p.cobros_por_verificar) > 0 ? 'pequeno' : 'pequeno tenue',
          style: Number(p.cobros_por_verificar) > 0 ? 'color:#a60' : '',
          text: Number(p.cobros_por_verificar) > 0
            ? `${p.cobros_por_verificar} por verificar` : 'todo verificado',
        }),
      ]),
      el('td', { class: 'col-dinero' }, [
        // El número grande, y sin ningún campo al lado para cambiarlo.
        el('div', { class: 'cobro-cifra__valor', text: dinero(p.lleva_ahora, p.currency_code) }),
      ]),
      el('td', { class: 'centro' }, [
        boton('Recibir', () => abrirTraspaso(p, recargar), 'btn btn--principal'),
      ]),
    ]))
  }
  //
  // «Estado» es SECUNDARIO en un móvil.
  //
  // Con cuatro columnas, la cifra grande en su medio y un botón al final, la
  // tabla no cabe en 420 píxeles: el botón «Recibir» se va fuera de la pantalla
  // y la caja no ve que se puede cobrar. Lo que se ve es lo que se puede hacer,
  // así que en pantalla estrecha lo secundario se esconde y la fila se queda
  // con repartidor, cifra y botón.
  //
  return tabla([
    'Repartidor',
    { text: 'Estado', clase: 'col-secundaria' },
    'Lleva',
    '',
  ], cuerpo)
}

function tablaTraspasos(traspasos, moneda) {
  const cuerpo = el('tbody')
  for (const t of traspasos) {
    const tono = t.status === 'RECONCILED' ? 'bien'
      : t.status === 'DISCREPANCY' ? 'peligro' : ''
    cuerpo.append(el('tr', {}, [
      el('td', { class: 'pequeno' }, [
        el('b', { text: `${t.entrega} → ${t.recibe}` }),
        el('div', { class: 'tenue', text: new Date(t.handed_at).toLocaleString('es-ES') }),
      ]),
      el('td', { class: 'pequeno col-dinero' }, [
        el('div', { text: `${dinero(t.expected_amount, t.currency_code)} esperado` }),
        el('div', { class: 'tenue', text: `${dinero(t.received_amount, t.currency_code)} recibido` }),
        Number(t.difference) !== 0
          ? el('div', { class: 'pequeno', style: 'color:#b00',
            text: `${Number(t.difference) > 0 ? 'sobran' : 'faltan'} ${dinero(Math.abs(Number(t.difference)), t.currency_code)}` })
          : null,
      ].filter(Boolean)),
      el('td', { class: 'pequeno tenue', text: t.note || '' }),
      el('td', {}, [el('span', { class: 'estado estado--' + tono,
        text: { RECONCILED: 'Conciliado', DISCREPANCY: 'Descuadre', PENDING: 'Abierto' }[t.status] || t.status })]),
    ]))
  }
  return traspasos.length
    ? tabla(['De → a', 'Cuentas', 'Nota', 'Estado'], cuerpo)
    : vacio('Todavía no se ha registrado ningún traspaso.')
}

// ───────────────────────────────────────────────────────────────────────────
// ABRIR Y RECIBIR
// ───────────────────────────────────────────────────────────────────────────

/**
 * Abrir el traspaso.
 *
 * El cuerpo lleva el repartidor y la moneda. NO lleva ni «cuánto espera» ni
 * «cuánto lleva»: eso lo dice el sistema. Lo que la caja escribe es lo que
 * cuenta, y eso va al RECIBIR.
 */
function abrirTraspaso(p, recargar) {
  const nota = el('input', { class: 'input', type: 'text', placeholder: 'Opcional' })
  //
  // `const capa`, y NO `return modal(...)` suelto.
  //
  // El modal se abre igual, y por eso el fallo se esconde: la pantalla se ve,
  // el título está bien, la cifra está bien. Lo que revienta es pulsar
  // «Abrir traspaso» o «Cancelar», que llaman a `capa.remove()` — y `capa` no
  // está declarada en ninguna parte. En un móvil sale un «Can't find variable»
  // de Safari y el proceso se queda a medias.
  //
  // Es el mismo error de siempre: usar una variable antes de que exista. Aquí
  // dentro de una función de flecha, que además hace que `node --check` no
  // diga nada: la variable se declara más abajo… en el sitio de al lado.
  //
  const capa = modal(`Recibir de ${p.full_name}`, el('div', { class: 'pila' }, [
    el('div', { class: 'cobro-cifra cobro-cifra--grande' }, [
      el('span', { class: 'cobro-cifra__etiqueta', text: 'Debería entregar' }),
      el('span', { class: 'cobro-cifra__valor', text: dinero(p.lleva_ahora, p.currency_code) }),
    ]),
    aviso('Esta cifra la cuenta el sistema a partir de sus cobros. No se puede cambiar.', ''),
    el('div', { class: 'pila' }, [
      el('label', { class: 'etiqueta', text: 'Nota (opcional)' }),
      nota,
    ]),
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Abrir traspaso', async () => {
      try {
        const t = await A.api('/caja/traspasos', {
          metodo: 'POST',
          cuerpo: { repartidorId: p.user_id, moneda: p.currency_code, nota: nota.value.trim() || null },
        })
        capa.remove()
        await recibir(t, p, recargar)
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
  return capa
}

/**
 * RECIBIR.
 *
 * El único campo de la pantalla donde se escribe una cantidad, y escribe LA
 * REALIDAD: lo que hay en la mano. Arriba está lo que debía haber, y no se
 * toca.
 */
function recibir(t, p, recargar) {
  const recibido = el('input', {
    class: 'input', type: 'number', inputmode: 'decimal', step: '0.01',
  })
  const nota = el('textarea', {
    rows: 2, placeholder: 'Si no cuadra: qué ha pasado. Sin esto no se guarda.',
  })
  const cajaNota = el('div', { class: 'pila' }, [
    el('label', { class: 'etiqueta', text: '¿Por qué no cuadra?' }),
    nota,
  ])

  //
  // La casilla de «por qué» aparece SOLA cuando no cuadra. Escribirla siempre
  // sería un trámite falso —casi nunca hay nada que explicar—; no escribirla
  // nunca dejaría sin guardar el traspaso que de verdad no cuadra.
  //
  const revisar = () => {
    const d = Math.abs(Number(recibido.value || 0) - Number(t.expected_amount))
    cajaNota.style.display = d > 0.0001 ? '' : 'none'
  }
  recibido.addEventListener('input', revisar)
  revisar()

  // Ídem: sin `const capa`, los botones de este modal tampoco funcionarían.
  const capa = modal('Contar el dinero', el('div', { class: 'pila' }, [
    el('div', { class: 'ficha-datos' }, [
      el('div', {}, [el('b', { text: p.full_name + ' entrega a caja' })]),
      el('div', { class: 'pequeno', text: `Traspaso #${t.id} · ${t.currency_code}` }),
    ]),
    el('div', { class: 'cobro-cifra' }, [
      el('span', { class: 'cobro-cifra__etiqueta', text: 'Esperado' }),
      el('span', { class: 'cobro-cifra__valor', text: dinero(t.expected_amount, t.currency_code) }),
    ]),
    el('div', { class: 'pila' }, [
      el('label', { class: 'etiqueta', text: 'Cuánto hay en la mano' }),
      recibido,
    ]),
    cajaNota,
  ]), [
    boton('Cancelar', () => capa.remove()),
    boton('Recibir', async () => {
      const v = Number(recibido.value)
      if (!(v >= 0)) { window.alert('Hay que decir cuánto hay en la mano.'); return }
      const d = Math.abs(v - Number(t.expected_amount))
      if (d > 0.0001 && nota.value.trim().length < 3) {
        window.alert('Faltan o sobran ' + dinero(d, t.currency_code)
          + '. Hay que decir por qué: sin explicación, no se guarda.')
        return
      }
      try {
        await A.api(`/caja/traspasos/${t.id}/recibir`, {
          metodo: 'POST',
          // Ni `expected_amount` ni `saldo`: aquí solo va lo que se ha contado.
          cuerpo: { recibido: v, nota: nota.value.trim() || null },
        })
        capa.remove()
        await recargar()
        window.alert(d > 0.0001
          ? `Traspaso guardado con un descuadre de ${dinero(d, t.currency_code)}.`
          : 'Traspaso conciliado.')
      } catch (e) { window.alert(e.message) }
    }, 'btn btn--principal'),
  ])
}
