/**
 * SESIÓN DE CAJA: abrir, mover, arquear, cerrar.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * QUÉ ES
 *
 * Una caja tiene un DÍA. Se abre con un fondo, van entrando y saliendo cosas,
 * y al final alguien cuenta el dinero de verdad y lo compara con lo que el
 * sistema dice que debería haber.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * DÓNDE ESTÁ LA VERDAD
 *
 * El esperado NO se calcula aquí. Está en `fn_caja_esperado()`, en SQL, y esta
 * capa solo lo lee.
 *
 * La razón ya está escrita en el proyecto y es la buena: si el arqueo lo
 * calculara el servidor y el resumen lo calculara la pantalla, los dos
 * números serían ciertos y los dos mentirían. Aquí solo se pregunta.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * DÓNDE ESTÁN LAS PROHIBICIONES
 *
 * En la base. Una sola caja abierta por usuario y moneda es un índice único
 * parcial; los movimientos de una caja cerrada no entran, y un movimiento no
 * se borra nunca, son dos disparadores.
 *
 * Este módulo no los repite porque no puede: si alguien abre la caja por SQL
 * sin pasar por aquí, sigue sin poder hacerlo. Las reglas que se pueden
 * saltarse escribiendo en la base no son reglas.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * LOS IMPORTES NO PASAN POR COMA FLOTANTE
 *
 * Todo entra y sale por `aEnteros()` / `deEnteros()`. Un saldo de caja
 * calculado con `0.1 + 0.2` es un descuadre de un céntimo que nadie sabe de
 * dónde ha salido, y en una caja ese céntimo se multiplica por todos los
 * días del mes.
 */

import { query, one, transaction } from '../db/client.js'
import { aEnteros, deEnteros, cuentaMonetaria } from './dinero.js'

/** Error con código y estado HTTP, como el resto del proyecto. */
function fallar(mensaje, codigo, estado = 400) {
  const e = new Error(mensaje)
  e.codigo = codigo
  e.estado = estado
  return e
}

/** Los periodos que se pueden mirar. */
export const PERIODOS = {
  DIA: 'DIA',
  SEMANA: 'SEMANA',
  MES: 'MES',
}

/**
 * El tramo de fechas de un periodo, en curso si no se dicen fechas.
 *
 * Se calcula en el SERVIDOR y en hora local del servidor, que es la del
 * negocio. Una caja es «hoy» para quien está delante de ella, no para un UTC
 * que en Bamako va siete horas por delante.
 */
export function tramo(preset = 'MES', desde = null, hasta = null) {
  if (desde && hasta) return { desde, hasta, preset }
  const h = new Date()
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (preset === 'DIA') {
    return { desde: iso(h), hasta: iso(h), preset }
  }
  if (preset === 'SEMANA') {
    // Lunes a domingo. El lunes es el primer día de la semana porque el
    // domingo aquí no se trabaja: una semana que empezase en domingo partiría
    // el domingo de su propia semana.
    const d = new Date(h)
    const dow = (d.getDay() + 6) % 7
    d.setDate(d.getDate() - dow)
    const f = new Date(d)
    f.setDate(f.getDate() + 6)
    return { desde: iso(d), hasta: iso(f), preset }
  }
  const primero = new Date(h.getFullYear(), h.getMonth(), 1)
  const ultimo = new Date(h.getFullYear(), h.getMonth() + 1, 0)
  return { desde: iso(primero), hasta: iso(ultimo), preset }
}

/**
 * Abrir la caja del día.
 *
 * El fondo es lo que la persona cuenta al abrir, no lo que el sistema supone.
 * Si no se pasa, es cero — y cero es una decisión, no un olvido: una caja que
 * empieza en cero es una caja que empieza vacía.
 */
export async function abrirCaja({ usuarioId, moneda = 'XOF', fondoContado = 0, notas = null }) {
  const fondo = deEnteros(aEnteros(fondoContado))
  if (fondo < 0) throw fallar('El fondo inicial no puede ser negativo.', 'FONDO_NEGATIVO')

  return transaction(async (tx) => {
    const abierta = await tx.one(
      `SELECT id FROM cash_sessions WHERE user_id = $1 AND moneda = $2 AND cerrada_at IS NULL`,
      [usuarioId, moneda],
    )
    if (abierta) {
      throw fallar(
        `Ya tienes una caja abierta (la ${abierta.id}). Ciérrala antes de abrir otra: ` +
        'con dos cajas abiertas, ningún arqueo significa nada.',
        'CAJA_YA_ABIERTA', 409,
      )
    }
    const s = await tx.one(
      `INSERT INTO cash_sessions (user_id, moneda, fondo_contado, fondo_notas)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [usuarioId, moneda, fondo, notas],
    )
    return s
  })
}

/**
 * Las retiradas de una sesión cerrada, con el total y lo que queda.
 *
 * Vive aparte del resultado del día a propósito. Una retirada no es una salida:
 * el dinero sigue siendo de la empresa, solo cambia de manos. Si se mezclara con
 * `entradas`/`salidas`, el resultado de la jornada bajaría a cero y se perdería
 * la única cifra que dice cuánto gestionó la caja ese día.
 */
export async function retiradasDe(sessionId) {
  const f = await one('SELECT * FROM fn_caja_retirado($1::int)', [sessionId])
  if (!f) throw fallar('Esa caja no existe.', 'CAJA_NO_EXISTE', 404)
  const lista = await query(
    `SELECT w.id, w.importe, w.moneda, w.destino, w.destinatario, w.retirado_at,
            w.notas, u.full_name AS retirado_por_nombre
       FROM cash_withdrawals w
       JOIN users u ON u.id = w.retirado_por
      WHERE w.session_id = $1
      ORDER BY w.retirado_at, w.id`,
    [sessionId],
  )
  return {
    listado: lista.map((w) => ({
      id: w.id,
      importe: Number(w.importe),
      moneda: w.moneda,
      destino: w.destino,
      destinatario: w.destinatario,
      retiradoAt: w.retirado_at,
      notas: w.notas,
      retiradoPor: w.retirado_por_nombre,
    })),
    // Una caja abierta no tiene contado, y sin contado no hay nada que retirar.
    contado: f.contado === null ? null : Number(f.contado),
    retirado: Number(f.retirado),
    pendiente: f.pendiente === null ? null : Number(f.pendiente),
  }
}

/** La sesión abierta de un usuario, o `null`. */
export async function cajaAbierta(usuarioId, moneda = 'XOF') {
  return one(
    `SELECT * FROM cash_sessions WHERE user_id = $1 AND moneda = $2 AND cerrada_at IS NULL`,
    [usuarioId, moneda],
  )
}

/**
 * Las tres cifras de una caja: esperado, contado y diferencia.
 *
 * Se pregunta a SQL, no se calcula. Ver la cabecera.
 */
export async function estado(sessionId) {
  const f = await one('SELECT * FROM fn_caja_esperado($1::int)', [sessionId])
  if (!f) throw fallar('Esa caja no existe.', 'CAJA_NO_EXISTE', 404)
  return {
    id: sessionId,
    abierta: f.abierta,
    abiertaAt: f.abierta_at,
    cerradaAt: f.cerrada_at,
    fondo: Number(f.fondo),
    entradas: Number(f.entradas),
    salidas: Number(f.salidas),
    esperado: Number(f.esperado),
    contado: f.contado === null ? null : Number(f.contado),
    diferencia: f.contado === null ? null : Number(f.contado) - Number(f.esperado),
  }
}

/**
 * Meter dinero o sacarlo.
 *
 * El importe va en positivo siempre; el `kind` dice de qué lado. La caja
 * cerrada y el borrado de histórico los=frena la base, no esto.
 */
export async function registrarMovimiento({
  sessionId, kind, concepto, importe, usuarioId, ref = null, notas = null,
}) {
  if (kind !== 'IN' && kind !== 'OUT') {
    throw fallar('Un movimiento es de entrada (IN) o de salida (OUT).', 'MOVIMIENTO_KIND')
  }
  const valor = deEnteros(aEnteros(importe))
  if (valor <= 0) {
    throw fallar('El importe tiene que ser mayor que cero. Para corregir algo se mete otro movimiento.', 'MOVIMIENTO_CERO')
  }
  if (!concepto || !String(concepto).trim()) {
    throw fallar('Un movimiento sin concepto no se puede explicar después.', 'MOVIMIENTO_SIN_CONCEPTO')
  }

  return transaction(async (tx) => {
    const sesion = await tx.one('SELECT * FROM cash_sessions WHERE id = $1', [sessionId])
    if (!sesion) throw fallar('Esa caja no existe.', 'CAJA_NO_EXISTE', 404)
    if (sesion.cerrada_at) {
      throw fallar(
        'La caja está cerrada. Nada entra ni sale de una caja cerrada: para corregir, se abre otra.',
        'CAJA_CERRADA', 409,
      )
    }
    return tx.one(
      `INSERT INTO cash_movements
         (session_id, kind, concepto, importe, moneda, ref_tipo, ref_id, usuario_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [sessionId, kind, String(concepto).trim(), valor, sesion.moneda,
        ref?.tipo ?? null, ref?.id != null ? String(ref.id) : null, usuarioId, notas],
    )
  })
}

/** Los movimientos de una caja, del más reciente al más antiguo. */
export async function movimientos(sessionId, { limite = 200 } = {}) {
  return query(
    `SELECT m.*, u.full_name AS usuario_nombre
       FROM cash_movements m
       JOIN users u ON u.id = m.usuario_id
      WHERE m.session_id = $1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    [sessionId, limite],
  )
}

/**
 * Arquear y cerrar.
 *
 * Se escribe lo que se ha contado a mano. El sistema calcula el esperado y deja
 * la diferencia, aunque sea cero: un descuadre de cero también es un dato, y
 * dejarlo escrito es lo que permite comparar sesiones más adelante.
 *
 * La diferencia NO bloquea el cierre. Bloquear deja a alguien con el dinero
 * contado y sin poder salir de la jornada, y eso se arregla llamándonos.
 */
export async function arquearYCerrar({ sessionId, contado, usuarioId, notas = null }) {
  const valor = deEnteros(aEnteros(contado))
  if (valor < 0) throw fallar('El efectivo contado no puede ser negativo.', 'CONTADO_NEGATIVO')

  return transaction(async (tx) => {
    const sesion = await tx.one('SELECT * FROM cash_sessions WHERE id = $1', [sessionId])
    if (!sesion) throw fallar('Esa caja no existe.', 'CAJA_NO_EXISTE', 404)
    if (sesion.cerrada_at) throw fallar('Esa caja ya está cerrada.', 'CAJA_CERRADA', 409)

    const cerrado = await tx.one(
      `UPDATE cash_sessions
          SET arqueo_contado = $2, arqueo_notas = $3, cerrada_at = now(), cerrada_por = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [sessionId, valor, notas, usuarioId],
    )

    // El descuadre, escrito con la diferencia que se ha visto al arquear. Se
    // guarda aunque sea 0: es un hecho de la jornada, no una nota opcional.
    const f = await tx.one('SELECT * FROM fn_caja_esperado($1::int)', [sessionId])
    const esperado = Number(f.esperado)
    const diferencia = valor - esperado
    if (diferencia !== 0 && notas && !String(notas).trim()) {
      throw fallar(
        `El dinero contado NO cuadra: faltan o sobran ${Math.abs(diferencia)}. ` +
        'Pon en las notas qué ha pasado antes de cerrar.',
        'DESCUADRE_SIN_NOTAS',
      )
    }
    return { caja: cerrado, esperado, contado: valor, diferencia }
  })
}

/**
 * Las sesiones de un usuario, o todas si no se dice de quién.
 *
 * Con el estado de cada una calculado en SQL, para no tener que abrir cada caja
 * una por una solo para pintar una lista.
 */
export async function listarSesiones({ usuarioId = null, estado: est = null, limite = 50 } = {}) {
  const cond = []
  const p = []
  if (usuarioId) { p.push(usuarioId); cond.push(`s.user_id = $${p.length}`) }
  if (est === 'ABIERTA') cond.push('s.cerrada_at IS NULL')
  if (est === 'CERRADA') cond.push('s.cerrada_at IS NOT NULL')
  if (p.length) p.push(limite); else p.push(limite)

  return query(
    `SELECT s.*, u.full_name AS usuario_nombre,
            e.fondo, e.entradas, e.salidas, e.esperado, e.contado, e.diferencia
       FROM cash_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN fn_caja_esperado(s.id) e ON TRUE
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY s.abierta_at DESC
      LIMIT $${p.length}`,
    p,
  )
}

/**
 * Qué dinero hubo y qué pasó, por día, semana o mes.
 *
 * Devuelve las sesiones del tramo CON su esperado, contado y diferencia. No
 * devuelve totales inventados: si no abrió caja, no aparece una sesión con
 * cero, porque no abrió caja.
 */
export async function consultaPeriodo({ preset = 'MES', desde = null, hasta = null, usuarioId = null } = {}) {
  const t = tramo(preset, desde, hasta)
  const sesiones = await listarSesiones({ usuarioId, limite: 500 })
  const delTramo = sesiones.filter((s) => {
    // La fecha en YYYY-MM-DD, en la zona del SERVIDOR.
    //
    // `String(fecha).slice(0,10)` devuelve «Tue Oct 08», no «2026-10-08»:
    // la comparación con el tramo no casa nunca y el periodo sale vacío. Un
    // filtro que no casa con nada parece un filtro que funciona.
    const d = new Date(s.abierta_at)
    const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return dia >= t.desde && dia <= t.hasta
  })

  // Los totales se suman en ENTEROS, con la misma cuenta que el resto del
  // proyecto. Sumar flotantes aquí y comparar con un esperado de SQL daría
  // céntimos fantasma justo en la cifra que se enseña arriba.
  // Las retiradas de todas las sesiones del tramo, de una sola consulta: una
  // por sesión sería una ida a la base por cada fila del historial, y el
  // historial es justo lo que se abre con la base ya cargada.
  const retiros = new Map()
  if (delTramo.length) {
    const rs = await query(
      `SELECT w.session_id, w.id, w.importe, w.moneda, w.destino, w.destinatario,
              w.retirado_at, w.notas, u.full_name AS retirado_por
         FROM cash_withdrawals w
         JOIN users u ON u.id = w.retirado_por
        WHERE w.session_id = ANY($1::int[])
        ORDER BY w.retirado_at, w.id`,
      [delTramo.map((s) => s.id)],
    )
    for (const r of rs) {
      if (!retiros.has(r.session_id)) retiros.set(r.session_id, [])
      retiros.get(r.session_id).push({
        id: r.id, importe: Number(r.importe), moneda: r.moneda, destino: r.destino,
        destinatario: r.destinatario, retiradoAt: r.retirado_at, notas: r.notas,
        retiradoPor: r.retirado_por,
      })
    }
  }
  for (const s of delTramo) s.abierta_retiradas = retiros.get(s.id) || []

  const cuenta = cuentaMonetaria()
  for (const s of delTramo) {
    cuenta.suma(Number(s.esperado ?? 0))
    if (s.contado !== null) cuenta.suma(Number(s.diferencia ?? 0))
  }

  return {
    ...t,
    sesiones: delTramo.slice().sort((a, b) => new Date(b.abierta_at) - new Date(a.abierta_at)).map((s) => {
      // El total de lo retirado se SACA de las retiradas de esta sesion.
      // `cash_sessions` no lo tiene: leer una columna inexistente daba 0, y el
      // historial llegaba a decir «0 retirado» con las dos retiraciones
      // escritas encima, en la misma tarjeta. Una cifra que se contradice a si
      // misma es peor que no tenerla.
      const retirado = (s.abierta_retiradas || []).reduce((t2, w) => t2 + Number(w.importe), 0)
      const contado = s.contado === null ? null : Number(s.contado)
      const pendiente = contado === null ? null : contado - retirado
      return {
      id: s.id,
      usuario: s.usuario_nombre,
      abiertaAt: s.abierta_at,
      cerradaAt: s.cerrada_at,
      cerrada: s.cerrada_at !== null,
      fondo: Number(s.fondo ?? 0),
      entradas: Number(s.entradas ?? 0),
      salidas: Number(s.salidas ?? 0),
      esperado: Number(s.esperado ?? 0),
      contado: s.contado === null ? null : Number(s.contado),
      diferencia: s.diferencia === null ? null : Number(s.diferencia),
      descuadre: s.diferencia !== null && Number(s.diferencia) !== 0,
      // Lo que se llevó el dinero de esta jornada, y a quién. Va en la sesión,
      // NO en sus movimientos: es un hecho posterior al cierre.
      retiradas: s.abierta_retiradas || [],
      retirado,
      pendiente,
      // «Pendiente» solo existe si la caja esta cerrada Y se conto. Una caja
      // abierta no tiene nada pendiente: todavia no se sabe cuanto hay.
      retiradaPendiente: s.cerrada_at !== null && pendiente !== null && pendiente !== 0,
      }
    }),
    totalEsperado: cuenta.total(2),
    totalContado: delTramo.filter((s) => s.contado !== null)
      .reduce((t2, s) => t2 + Number(s.contado), 0),
    totalDiferencia: delTramo.filter((s) => s.diferencia !== null)
      .reduce((t2, s) => t2 + Number(s.diferencia), 0),
    sesionesConDescuadre: delTramo.filter((s) => s.diferencia !== null && Number(s.diferencia) !== 0).length,
  }
}

/**
 * Registrar que el dinero de una caja CERRADA se ha entregado a alguien.
 *
 * No es un movimiento de caja y no se escribe como uno. El dinero no se ha
 * gastado: ha cambiado de manos. Se anota aparte precisamente para que el
 * resultado de la jornada siga diciendo lo que la caja gestionó ese día, que es
 * un dato distinto de dónde acabó el dinero.
 *
 * Las dos reglas que importan —solo con la caja cerrada, y nunca por encima de
 * lo contado— las comprueba el DISPARADOR `retirada_solo_caja_cerrada`. Aquí se
 * limpian los datos y se le da un mensaje mejor; la garantía no depende de que
 * este camino se ejecute.
 */
export async function registrarRetirada({
  sessionId, importe, destino, destinatario = null, notas = null, usuarioId,
}) {
  const monto = deEnteros(aEnteros(importe))
  if (!(monto > 0)) {
    throw fallar('Una retirada de cero no es una retirada.', 'IMPORTE_INVALIDO')
  }
  const PERMITIDOS = ['BANCO', 'RESPONSABLE', 'CAJA_MATRIZ']
  if (!PERMITIDOS.includes(destino)) {
    throw fallar(
      'El dinero tiene que ir a algún sitio: elige banco, responsable o caja matriz.',
      'DESTINO_INVALIDO',
    )
  }
  if (!destinatario || !String(destinatario).trim()) {
    // La tabla lo permite vacío porque un banco se escribe de muchas maneras,
    // pero desde la aplicación se exige: «el dinero se fue» sin decir a quién no
    // es un hecho auditable.
    throw fallar('Falta decir quién recibe el dinero.', 'DESTINATARIO_OBLIGATORIO')
  }

  const sesion = await one(
    'SELECT id, moneda, cerrada_at, arqueo_contado FROM cash_sessions WHERE id = $1',
    [sessionId],
  )
  if (!sesion) throw fallar('Esa caja no existe.', 'CAJA_NO_EXISTE', 404)
  if (sesion.cerrada_at === null) {
    throw fallar(
      'Esta caja todavía está abierta. Primero se cierra el día: hasta el cierre '
      + 'no se sabe cuánto dinero físico hay, y retirarlo antes sería estimar.',
      'CAJA_ABIERTA', 409,
    )
  }
  if (sesion.arqueo_contado === null) {
    throw fallar('Esta caja se cerró sin contar, así que no hay nada que retirar.',
      'CAJA_SIN_CONTAR', 409)
  }

  const f = await one('SELECT * FROM fn_caja_retirado($1::int)', [sessionId])
  const pendiente = Number(f.pendiente)
  if (monto > pendiente) {
    throw fallar(
      `No queda tanto dinero. Esta caja se cerró en ${sesion.arqueo_contado} y ya `
      + `se han retirado ${f.retirado}; quedan ${pendiente} por retirar.`,
      'EXCEDE_LO_DISPONIBLE', 409,
    )
  }

  const fila = await one(
    `INSERT INTO cash_withdrawals
       (session_id, importe, moneda, destino, destinatario, retirado_por, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [sessionId, monto, sesion.moneda, destino, String(destinatario).trim(), usuarioId, notas],
  )
  const despues = await one('SELECT * FROM fn_caja_retirado($1::int)', [sessionId])
  return {
    retirada: {
      id: fila.id,
      sessionId: fila.session_id,
      importe: Number(fila.importe),
      moneda: fila.moneda,
      destino: fila.destino,
      destinatario: fila.destinatario,
      retiradoAt: fila.retirado_at,
      notas: fila.notas,
    },
    retirado: Number(despues.retirado),
    contado: Number(despues.contado),
    pendiente: Number(despues.pendiente),
  }
}
