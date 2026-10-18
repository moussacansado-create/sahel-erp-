// ═══════════════════════════════════════════════════════════════════════════
// COMISIONES MENSUALES
// ═══════════════════════════════════════════════════════════════════════════
//
// LA REGLA
//
//   comisión propuesta = base mensual aprobada × porcentaje aplicable
//
// Y UNA COSA QUE NO ES NEGOCIABLE: la comisión la CONFIRMA el administrador
// una vez al mes. Antes de eso, lo que hay es una ESTIMACIÓN. El comercial
// no ve una cifra que luego pueda moverse debajo de sus pies.
//
// ── LA MONEDA ──────────────────────────────────────────────────────────────
//
// Todo en la moneda base contable (FCFA / XOF). Un cobro en euros se
// convierte con la tasa CONGELADA del propio cobro (`exchange_rate`), que es
// la que se usó el día que se cobró. Nunca con el precio de hoy.
//
// ── QUÉ CUENTA COMO COBRADO ───────────────────────────────────────────────
//
// Solo los cobros VERIFICADOS. Un PENDING está pendiente de comprobar, y un
// REJECTED no es dinero. Los dos se ven en el detalle; solo uno suma.
//
// ── LA ATRIBUCIÓN ─────────────────────────────────────────────────────────
//
// Al comercial que VENDIÓ (`sales_orders.comercial_id`), no al que cobró. Si el pedido no
// lo tiene, el de la ficha del cliente.
//
// ── NUNCA SE BORRA UN MOVIMIENTO ──────────────────────────────────────────
//
// Este módulo LEE los cobros y los pedidos. No los toca. Si un cobro está
// mal, se corrige el cobro; el histórico de comisiones queda como está.
//
import { query, one, transaction } from '../db/client.js'

// ── EL PERÍODO ─────────────────────────────────────────────────────────────
export function periodoDe(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function rangoDelPeriodo(periodo) {
  const m = /^([0-9]{4})-([0-9]{2})$/.exec(String(periodo || ''))
  if (!m) throw new Error('El periodo tiene que ser AAAA-MM.')
  const desde = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  const hasta = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1))
  return { desde, hasta, desdeIso: desde.toISOString().slice(0, 10), hastaIso: hasta.toISOString().slice(0, 10) }
}

// ── LA MONEDA BASE ─────────────────────────────────────────────────────────
export async function monedaBase() {
  const c = await one('SELECT code FROM currencies WHERE is_base AND is_active LIMIT 1')
  return c?.code || 'XOF'
}

// ═══════════════════════════════════════════════════════════════════════════
// EL PORCENTAJE VIGENTE
// ═══════════════════════════════════════════════════════════════════════════
//
// El aplicable un día D es el de la fila vigente en D: la más reciente cuyo
// `vigente_desde` no sea posterior a D y que aún no tenga `vigente_hasta`.
//
// Un cambio de porcentaje NO reescribe el anterior: se añade uno nuevo con
// fecha posterior. Así el histórico dice siempre qué se aplicó y desde cuándo,
// y por eso un mes confirmado no se mueve cuando cambia el porcentaje.
//
export async function porcentajeVigente(comercialId, fecha = new Date()) {
  const dia = (fecha instanceof Date ? fecha : new Date(fecha)).toISOString().slice(0, 10)
  return one(
    `SELECT p.*, u.full_name AS comercial_nombre
       FROM com_comision_porcentajes p
       JOIN com_perfiles cp ON cp.id = p.comercial_id
       JOIN users u ON u.id = cp.user_id
      WHERE p.comercial_id = $1
        AND p.vigente_desde <= $2::date
        AND (p.vigente_hasta IS NULL OR p.vigente_hasta > $2::date)
      ORDER BY p.vigente_desde DESC
      LIMIT 1`,
    [comercialId, dia],
  )
}

export async function historialPorcentajes(comercialId) {
  return query(
    `SELECT p.*, u.full_name AS comercial_nombre
       FROM com_comision_porcentajes p
       JOIN com_perfiles cp ON cp.id = p.comercial_id
       JOIN users u ON u.id = cp.user_id
      WHERE p.comercial_id = $1
      ORDER BY p.vigente_desde DESC, p.id DESC`,
    [comercialId],
  )
}

/**
 * Poner un porcentaje nuevo. Cierra el anterior el día anterior al nuevo.
 *
 * El anterior NO se borra ni se modifica su porcentaje: se le cierra la
 * vigencia. Así se puede responder «¿qué porcentaje se aplicaba el 12 de
 * marzo?» con certeza.
 */
export async function ponerPorcentaje({ comercialId, porcentaje, vigenteDesde, motivo, usuarioId }) {
  const pct = Number(porcentaje)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error('El porcentaje tiene que estar entre 0 y 100.')
  }
  if (!motivo || String(motivo).trim().length < 3) {
    throw new Error('Hay que decir por qué se cambia el porcentaje. Queda escrito.')
  }
  const desde = String(vigenteDesde || new Date().toISOString().slice(0, 10)).slice(0, 10)

  return transaction(async (tx) => {
    const anterior = await tx.one(
      `SELECT * FROM com_comision_porcentajes
        WHERE comercial_id = $1 AND vigente_desde <= $2::date
          AND (vigente_hasta IS NULL OR vigente_hasta > $2::date)
        ORDER BY vigente_desde DESC LIMIT 1`,
      [comercialId, desde],
    )
    if (anterior) {
      const cierre = new Date(`${desde}T00:00:00Z`)
      cierre.setUTCDate(cierre.getUTCDate() - 1)
      await tx.query(
        `UPDATE com_comision_porcentajes
            SET vigente_hasta = $3::date, updated_at = now()
          WHERE id = $1`,
        [anterior.id, comercialId, cierre.toISOString().slice(0, 10)],
      )
    }
    const nuevo = await tx.one(
      `INSERT INTO com_comision_porcentajes
         (comercial_id, porcentaje, vigente_desde, motivo, creado_por)
       VALUES ($1,$2,$3::date,$4,$5)
       RETURNING *`,
      [comercialId, pct, desde, String(motivo).trim(), usuarioId],
    )
    await tx.query(
      `INSERT INTO com_comision_auditoria
         (comercial_id, accion, valor_anterior, valor_nuevo, motivo, usuario_id)
       VALUES ($1,'porcentaje_cambiado',$2,$3,$4,$5)`,
      [comercialId, anterior ? String(anterior.porcentaje) : null, String(pct),
        String(motivo).trim(), usuarioId],
    )
    return nuevo
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CÁLCULO
// ═══════════════════════════════════════════════════════════════════════════
//
// Todo sale de AQUÍ. Es la única fuente, y por eso el detalle y el resumen
// no pueden contradecirse: los dos salen de la misma consulta.
//
const SQL_COBROS = `
  SELECT p.id                AS pago_id,
         p.amount            AS importe,
         p.currency_code     AS moneda,
         p.exchange_rate     AS tasa,
         p.collected_at      AS fecha,
         p.status            AS estado,
         p.method            AS metodo,
         p.reference         AS referencia,
         p.delivery_id       AS entrega_id,
         o.id                AS pedido_id,
         o.code              AS pedido_code,
         o.status            AS pedido_estado,
         o.total             AS pedido_total,
         c.id                AS cliente_id,
         c.code              AS cliente_code,
         c.name              AS cliente_nombre,
         (CASE WHEN p.currency_code = $4
               THEN p.amount
               ELSE p.amount * COALESCE(p.exchange_rate, 0) END) AS importe_base
    FROM payments p
    JOIN sales_orders o ON o.id = p.sales_order_id
    JOIN customers c    ON c.id = p.customer_id
    LEFT JOIN com_perfiles cp ON cp.id = o.comercial_id
   WHERE p.collected_at >= $2::timestamptz
     AND p.collected_at <  $3::timestamptz
     AND COALESCE(cp.id, c.comercial_id) = $1
   ORDER BY p.collected_at`

const SQL_PEDIDOS = `
  SELECT o.id        AS pedido_id,
         o.code      AS pedido_code,
         o.status    AS pedido_estado,
         o.order_date AS fecha,
         o.total     AS pedido_total,
         c.id        AS cliente_id,
         c.code      AS cliente_code,
         c.name      AS cliente_nombre,
         COALESCE((SELECT SUM((CASE WHEN p.currency_code = $4
                                    THEN p.amount
                                    ELSE p.amount * COALESCE(p.exchange_rate, 0) END))
                     FROM payments p
                    WHERE p.sales_order_id = o.id AND p.status = 'VERIFIED'), 0) AS cobrado
    FROM sales_orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN com_perfiles cp ON cp.id = o.comercial_id
   WHERE o.order_date >= $2::date
     AND o.order_date <  $3::date
     AND o.cancelled_at IS NULL
     AND o.status <> 'DRAFT'
     AND COALESCE(cp.id, c.comercial_id) = $1
   ORDER BY o.order_date`

/**
 * El resumen de un comercial en un mes, con el detalle que lo justifica.
 *
 * `base_cobrada`   — lo VERIFICADO y cobrado dentro del mes, en moneda base.
 * `base_pendiente` — lo vendido en el mes que aún no está cobrado.
 *
 * Los dos NO se suman nunca: uno es la base de la comisión y el otro es
 * lo que falta por entrar.
 */
export async function calcular(comercialId, periodo) {
  const { desde, hasta } = rangoDelPeriodo(periodo)
  const mon = await monedaBase()

  const cobros = await query(SQL_COBROS, [comercialId, desde.toISOString(), hasta.toISOString(), mon])
  const pedidos = await query(SQL_PEDIDOS, [comercialId, desde.toISOString(), hasta.toISOString(), mon])

  // Lo cobrado son SOLO los verificados. Los otros dos se muestran aparte.
  const verificados = cobros.filter((c) => c.estado === 'VERIFIED')
  const pendientesCobro = cobros.filter((c) => c.estado === 'PENDING')
  const rechazados = cobros.filter((c) => c.estado === 'REJECTED')

  const baseCobrada = verificados.reduce((s, c) => s + Number(c.importe_base), 0)
  // Lo que se vendió y no está cobrado: pedido menos lo ya verificado.
  const basePendiente = pedidos.reduce((s, p) => s + Math.max(0, Number(p.pedido_total) - Number(p.cobrado)), 0)

  const pct = await porcentajeVigente(comercialId, desde)
  const porcentaje = pct ? Number(pct.porcentaje) : null
  const comisionEstimada = porcentaje === null ? 0 : redondear(baseCobrada * porcentaje / 100)

  return {
    comercial_id: comercialId,
    periodo,
    moneda: mon,
    base_cobrada: redondear(baseCobrada),
    base_pendiente: redondear(basePendiente),
    porcentaje_aplicado: porcentaje,
    comision_estimada: comisionEstimada,
    porcentaje_vigente_desde: pct?.vigente_desde || null,
    cobros: verificados.map((c) => ({ ...c, importe_base: redondear(c.importe_base) })),
    cobros_pendientes: pendientesCobro.map((c) => ({ ...c, importe_base: redondear(c.importe_base) })),
    cobros_rechazados: rechazados.map((c) => ({ ...c, importe_base: redondear(c.importe_base) })),
    pedidos: pedidos.map((p) => ({
      ...p,
      pendiente: redondear(Math.max(0, Number(p.pedido_total) - Number(p.cobrado))),
    })),
  }
}

// La moneda base del ERP es el FCFA: entero. Redondear a la unidad evita que
// el total de los detalles no cuadre con el total del resumen.
function redondear(n) {
  return Math.round(Number(n) * 100) / 100
}

// ═══════════════════════════════════════════════════════════════════════════
// EL RESUMEN GUARDADO
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo calculado se guarda en `com_comisiones`. Se recalcula cada vez que se
// prepara el mes, y SOLO mientras la comisión no esté confirmada: después,
// lo confirmado es intocable.
//
export async function guardarCalculo(comercialId, periodo, c) {
  const existente = await one(
    `SELECT * FROM com_comisiones WHERE comercial_id = $1 AND periodo = $2`,
    [comercialId, periodo],
  )
  if (existente?.comision_confirmada !== null && existente?.comision_confirmada !== undefined) {
    // Ya confirmada: no se toca lo confirmado. Se devuelve tal cual.
    return existente
  }
  if (existente) {
    return one(
      `UPDATE com_comisiones
          SET base_cobrada = $3, base_pendiente = $4, porcentaje_aplicado = $5,
              comision_estimada = $6, moneda = $7, calculado_en = now(),
              estado = CASE WHEN estado = 'EN_CURSO' THEN 'PENDIENTE_REVISION' ELSE estado END,
              updated_at = now()
        WHERE id = $1 AND comercial_id = $2
        RETURNING *`,
      [existente.id, comercialId, c.base_cobrada, c.base_pendiente,
        c.porcentaje_aplicado, c.comision_estimada, c.moneda],
    )
  }
  return one(
    `INSERT INTO com_comisiones
       (comercial_id, periodo, estado, base_cobrada, base_pendiente,
        porcentaje_aplicado, comision_estimada, moneda, calculado_en)
     VALUES ($1,$2,'PENDIENTE_REVISION',$3,$4,$5,$6,$7,now())
     RETURNING *`,
    [comercialId, periodo, c.base_cobrada, c.base_pendiente,
      c.porcentaje_aplicado, c.comision_estimada, c.moneda],
  )
}

/**
 * Preparar el mes: calcula el resumen de CADA comercial que tenga algo que
 * cobrar y lo deja listo para que el administrador lo revise.
 *
 * Es idempotente: repetirlo recalcula lo provisional, no duplica filas.
 */
export async function prepararMes(periodo, usuarioId) {
  const { desde, hasta } = rangoDelPeriodo(periodo)
  const mon = await monedaBase()
  // Quién tiene algo: o cobros verificados, o pedidos vendidos en el mes.
  const comerciales = await query(
    `SELECT DISTINCT COALESCE(cp.id, c.comercial_id) AS comercial_id
       FROM sales_orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN com_perfiles cp ON cp.id = o.comercial_id
      WHERE o.order_date >= $1::date AND o.order_date < $2::date
        AND o.cancelled_at IS NULL AND o.status <> 'DRAFT'
        AND COALESCE(cp.id, c.comercial_id) IS NOT NULL
      UNION
     SELECT DISTINCT COALESCE(cp.id, c.comercial_id) AS comercial_id
       FROM payments p
       JOIN sales_orders o ON o.id = p.sales_order_id
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN com_perfiles cp ON cp.id = o.comercial_id
      WHERE p.collected_at >= $3::timestamptz AND p.collected_at < $4::timestamptz
        AND COALESCE(cp.id, c.comercial_id) IS NOT NULL`,
    [desde.toISOString().slice(0, 10), hasta.toISOString().slice(0, 10),
      desde.toISOString(), hasta.toISOString()],
  )

  const salidas = []
  for (const { comercial_id } of comerciales) {
    const c = await calcular(comercial_id, periodo)
    const guardada = await guardarCalculo(comercial_id, periodo, c)
    salidas.push(guardada)
  }
  return { periodo, moneda: mon, preparada: salidas.length, comisiones: salidas }
}

// ═══════════════════════════════════════════════════════════════════════════
// LA CONFIRMACIÓN
// ═══════════════════════════════════════════════════════════════════════════
//
// Aquí se congela. Se guarda una copia de la base, del porcentaje y del
// importe, con QUIÉN confirma y CUÁNDO. A partir de aquí, un cambio de
// porcentaje o una venta nueva NO tocan esta comisión.
//
export async function confirmarComision(comisionId, usuarioId, nota) {
  return transaction(async (tx) => {
    const c = await tx.one('SELECT * FROM com_comisiones WHERE id = $1', [comisionId])
    if (!c) throw new Error('Esa comisión no existe.')
    if (c.estado === 'PAGADA') throw new Error('Esa comisión ya está pagada.')
    if (c.comision_confirmada !== null && c.comision_confirmada !== undefined) {
      // Ya confirmada. Se devuelve igual: confirmar dos veces no cambia nada.
      return c
    }
    if (c.porcentaje_aplicado === null || c.porcentaje_aplicado === undefined) {
      throw new Error('No hay porcentaje aplicable. Pon uno antes de confirmar.')
    }
    // La base se recalcula AHORA, no se copia la de hace un rato: el
    // administrador confirma lo que ve, y lo que ve es el estado actual.
    const calc = await calcular(c.comercial_id, c.periodo)
    const base = calc.base_cobrada
    const comision = redondear(base * Number(c.porcentaje_aplicado) / 100)

    const guardada = await tx.one(
      `UPDATE com_comisiones
          SET base_confirmada = $2, porcentaje_confirmado = $3, comision_confirmada = $4,
              confirmado_por = $5, confirmado_en = now(), nota_confirmacion = $6,
              estado = 'CONFIRMADA_PENDIENTE_PAGO', updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [comisionId, base, c.porcentaje_aplicado, comision, usuarioId,
        nota ? String(nota) : null],
    )
    await tx.query(
      `INSERT INTO com_comision_auditoria
         (comision_id, comercial_id, periodo, accion, valor_anterior, valor_nuevo, motivo, usuario_id)
       VALUES ($1,$2,$3,'comision_confirmada',$4,$5,$6,$7)`,
      [comisionId, c.comercial_id, c.periodo,
        String(calc.base_cobrada), String(comision), nota || null, usuarioId],
    )
    return guardada
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// EL PAGO
// ═══════════════════════════════════════════════════════════════════════════
//
// El administrador registra lo que ha pagado. Sin importe y sin fecha no
// se puede marcar como pagada: el estado se lo pone la base, no el código.
//
export async function registrarPago(comisionId, { importe, fecha, referencia, nota }, usuarioId) {
  const imp = Number(importe)
  if (!Number.isFinite(imp) || imp <= 0) {
    throw new Error('El importe del pago tiene que ser mayor que cero.')
  }
  if (!fecha) throw new Error('El pago necesita su fecha.')
  return transaction(async (tx) => {
    const c = await tx.one('SELECT * FROM com_comisiones WHERE id = $1', [comisionId])
    if (!c) throw new Error('Esa comisión no existe.')
    if (c.estado !== 'CONFIRMADA_PENDIENTE_PAGO') {
      throw new Error('Solo se puede pagar una comisión confirmada.')
    }
    const pago = await tx.one(
      `INSERT INTO com_comision_pagos (comision_id, importe, fecha, usuario_id, referencia, nota)
       VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING *`,
      [comisionId, imp, String(fecha).slice(0, 10), usuarioId,
        referencia ? String(referencia) : null, nota ? String(nota) : null],
    )
    const pagado = await tx.one(
      `SELECT COALESCE(SUM(importe),0) AS total FROM com_comision_pagos WHERE comision_id = $1`,
      [comisionId],
    )
    const total = Number(pagado.total)
    // Cuando lo pagado llega a la comisión confirmada, la comisión está
    // pagada. Si no llega, se queda pendiente con lo que se haya pagado.
    const estado = total + 0.001 >= Number(c.comision_confirmada) ? 'PAGADA' : 'CONFIRMADA_PENDIENTE_PAGO'
    const actualizada = await tx.one(
      `UPDATE com_comisiones
          SET pagado_importe = $2, pagado_en = $3::date, pagado_por = $4,
              pagado_referencia = COALESCE($5, pagado_referencia),
              estado = $6, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [comisionId, total, String(fecha).slice(0, 10), usuarioId,
        referencia ? String(referencia) : null, estado],
    )
    await tx.query(
      `INSERT INTO com_comision_auditoria
         (comision_id, comercial_id, periodo, accion, valor_anterior, valor_nuevo, motivo, usuario_id)
       VALUES ($1,$2,$3,'pago_registrado',$4,$5,$6,$7)`,
      [comisionId, c.comercial_id, c.periodo, null, String(total),
        referencia ? String(referencia) : null, usuarioId],
    )
    return { comision: actualizada, pago }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// LA LISTA Y EL HISTORIAL
// ═══════════════════════════════════════════════════════════════════════════
export async function listar({ comercialId, anio, estado } = {}) {
  const cond = []
  const args = []
  if (comercialId) { args.push(comercialId); cond.push(`c.comercial_id = $${args.length}`) }
  if (anio) { args.push(String(anio)); cond.push(`c.periodo LIKE $${args.length} || '%'`) }
  if (estado) { args.push(String(estado)); cond.push(`c.estado = $${args.length}`) }
  return query(
    `SELECT c.*, cp.user_id, u.full_name AS comercial_nombre, u.username,
            (SELECT COALESCE(SUM(pg.importe),0) FROM com_comision_pagos pg
              WHERE pg.comision_id = c.id) AS pagado_total
       FROM com_comisiones c
       JOIN com_perfiles cp ON cp.id = c.comercial_id
       JOIN users u ON u.id = cp.user_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY c.periodo DESC, u.full_name`,
    args,
  )
}

export async function detalle(comisionId) {
  const c = await one(
    `SELECT c.*, cp.user_id, u.full_name AS comercial_nombre, u.username
       FROM com_comisiones c
       JOIN com_perfiles cp ON cp.id = c.comercial_id
       JOIN users u ON u.id = cp.user_id
      WHERE c.id = $1`,
    [comisionId],
  )
  if (!c) return null
  const pagos = await query(
    `SELECT p.*, u.full_name AS registrado_por
       FROM com_comision_pagos p JOIN users u ON u.id = p.usuario_id
      WHERE p.comision_id = $1 ORDER BY p.fecha, p.id`,
    [comisionId],
  )
  const calculo = await calcular(c.comercial_id, c.periodo)
  const auditoria = await query(
    `SELECT a.*, u.full_name AS usuario
       FROM com_comision_auditoria a LEFT JOIN users u ON u.id = a.usuario_id
      WHERE a.comercial_id = $1 ORDER BY a.created_at DESC`,
    [c.comercial_id],
  )
  return { comision: c, pagos, calculo, auditoria }
}
