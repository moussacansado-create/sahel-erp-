import { transaction } from '../db/client.js'
import { siguienteCodigoPedido } from './codigos.js'
import { auditar } from './auditoria.js'

/**
 * Pedidos de venta.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 *   CONFIRMAR  →  aparta stock. NO lo descuenta.
 *   ENTREGAR   →  descuenta stock. UNA sola vez.
 *   ANULAR     →  libera lo apartado. NO devuelve stock, porque nunca salió.
 *
 * Todo lo que hay aquí gira alrededor de esa frase: «confirmar no descuenta».
 * Aparta significa que la mercancía sigue en su lote, en su sitio, con la
 * misma cantidad física. Lo único que cambia es que queda marcada como
 * comprometida para este pedido. Por eso confirmar NO toca `lots` y por eso
 * anular no tiene que devolver nada: no se movió nada.
 */

const IVA_POR_DEFECTO = 0.21
const REDONDEO = 2

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 10 ** REDONDEO) / 10 ** REDONDEO

// ═══════════════════════════════════════════════════════════════════════════
// Alta
// ═══════════════════════════════════════════════════════════════════════════

export async function crearPedido({
  customerId, lineas = [], userId, notas = null, promisedDate = null, commercialId = null,
}) {
  if (!customerId) throw new Error('El pedido necesita un cliente')
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw new Error('Un pedido necesita al menos una línea')
  }

  return transaction(async (tx) => {
    const cliente = await tx.one(`SELECT id, code, name FROM customers WHERE id=$1`, [customerId])
    if (!cliente) throw new Error('El cliente no existe')

    // Dentro de la transacción se usa `tx.one`, NUNCA el `one` de módulo: este
    // pide una conexión propia y, con PGlite, que solo tiene una, la transacción
    // se queda esperando para siempre. En PostgreSQL de servidor tampoco sería
    // gratis: abriría un segundo(pool) mientras se mantiene el primero tomado.
    const base = await tx.one(`SELECT code FROM currencies WHERE is_base = TRUE LIMIT 1`)
    const detalles = []
    let subtotal = 0
    let descuento = 0
    let imposicion = 0

    for (const l of lineas) {
      const item = await tx.one(
        // `category_kind` va en la lista: sin él, la comprobación de abajo
        // compara contra `undefined` y rechaza TODOS los productos, incluidos
        // los de venta. Parecía un fallo de la validación, no una columna
        // que faltaba en el SELECT.
        `SELECT id, sku, name, category_kind, sale_price, tax_rate, unit_id
           FROM items WHERE id=$1`,
        [l.itemId])
      if (!item) throw new Error(`El artículo ${l.itemId} no existe`)
      // Una línea puede venir en unidades (botellas) o en cajas. Solo se
      // exige que diga ALGO, y más abajo se comprueba que lo que dice esté
      // dentro de 0. Si aquí se exigiera `qty > 0`, una línea de cajas sin
      //abotellas quedaría rechazada antes de tiempo.
      if (l.saleFormatId == null && !(Number(l.qty) > 0)) {
        throw new Error(`La cantidad de ${item.name} tiene que ser mayor que cero`)
      }
      if (l.saleFormatId != null) {
        const nCajas = Number(l.formatsQty ?? l.formats_qty)
        if (!Number.isFinite(nCajas) || nCajas <= 0) {
          throw new Error(`La cantidad de cajas de ${item.name} tiene que ser mayor que cero`)
        }
      }
      if (item.category_kind !== 'FINISHED_GOOD') {
        // Solo se vende producto terminado. Meter materia prima en un pedido de
        // venta terminaría en una entrega de botes de desinfectante.
        throw new Error(`${item.name} es materia prima o envase, no producto para vender`)
      }
      // ── CAJAS ────────────────────────────────────────────────────────────
      // Si la línea viene en un formato («2 cajas de 12»), aquí se traduce a
      // lo que el almacén entiende: botellas. `qty` sigue siendo 24, porque
      // reservas, entregas y trazabilidad leen esta misma columna y cuentan
      // en unidades base. Lo que cambia es de dónde sale la cantidad.
      let formato = null
      if (l.saleFormatId != null) {
        const f = await tx.query(
          `SELECT * FROM sale_formats WHERE id = $1`, [l.saleFormatId])
        if (!f.length) {
          throw new Error(`El formato ${l.saleFormatId} no existe`)
        }
        formato = f[0]
        if (!formato.is_active) {
          throw new Error(
            `El formato «${formato.name}» ya no está disponible para ${item.name}. `
            + 'Elige otro o pídeselo a quien lleva Ajustes.')
        }
        if (formato.item_id !== item.id) {
          throw new Error(
            `El formato «${formato.name}» es de otro producto, no de ${item.name}.`)
        }
      }

      const enCajas = formato != null
      // En cajas manda el número de cajas; si vienen las dos cosas, es un
      // error de tecleo y no se elige por la persona: se le avisa.
      if (enCajas && l.qty != null && Number(l.qty) !== Number(l.formatsQty ?? l.formats_qty) * Number(formato.units_per_format)) {
        throw new Error(
          `En ${item.name} has puesto a la vez cajas y botellas. Elige una: `
          + `${l.formatsQty ?? l.formats_qty} ${formato.name} son `
          + `${Number(l.formatsQty ?? l.formats_qty) * Number(formato.units_per_format)} unidades.`)
      }

      const qty = enCajas
        ? Number(l.formatsQty ?? l.formats_qty) * Number(formato.units_per_format)
        : Number(l.qty)
      if (!(qty > 0)) {
        throw new Error(`La cantidad de ${item.name} tiene que ser mayor que cero`)
      }

      // El precio y el IVA los pone la ficha del producto o el formato. El
      // cliente puede pedir otro precio, pero nunca inventar el IVA.
      const precioIndividual = l.unitPrice != null
        ? Number(l.unitPrice)
        : Number(item.sale_price)
      // En cajas se cobra POR CAJA, y la caja trae su propio IVA si lo tiene.
      const precio = enCajas
        ? (formato.price != null ? Number(formato.price) : precioIndividual)
        : precioIndividual
      const iva = enCajas && formato.tax_rate != null
        ? Number(formato.tax_rate)
        : (item.tax_rate != null ? Number(item.tax_rate) : IVA_POR_DEFECTO)
      const bruto = enCajas ? Number(l.formatsQty ?? l.formats_qty) * precio : qty * precio
      const descLinea = l.discountAmount != null ? Number(l.discountAmount) : 0
      const neto = bruto - descLinea
      const cuota = neto * iva

      subtotal += bruto
      descuento += descLinea
      imposicion += cuota
      detalles.push({
        item, qty, precio, iva, descLinea, neto, cuota,
        // La foto del formato. Se guarda en la línea para que el albarán de
        // dentro de dos años siga diciendo «Caja de 12 · 1.200» aunque el
        // formato ya no exista o cueste otra cosa.
        formato: enCajas ? {
          id: formato.id,
          cajas: Number(l.formatsQty ?? l.formats_qty),
          nombre: formato.name,
          unidades: Number(formato.units_per_format),
          precio,
        } : null,
      })
    }

    const code = await siguienteCodigoPedido(tx)
    const pedido = await tx.one(
      `INSERT INTO sales_orders
         (code, customer_id, comercial_id, status, order_date, promised_date,
          currency_code, subtotal, discount_amount, tax_rate, tax_amount, total, notes, created_by)
       VALUES ($1,$2,$3,'DRAFT',CURRENT_DATE,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [code, customerId, commercialId, promisedDate, base?.code || 'EUR',
       r2(subtotal), r2(descuento),
       detalles[0]?.iva ?? IVA_POR_DEFECTO, r2(imposicion),
       r2(subtotal - descuento + imposicion), notas, userId],
    )

    for (const d of detalles) {
      await tx.query(
        `INSERT INTO sales_order_lines
           (sales_order_id, item_id, qty, unit_id, unit_price, discount_amount,
            tax_rate, line_total, notes,
            sale_format_id, formats_qty, format_name, format_units, format_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [pedido.id, d.item.id, d.qty, d.item.unit_id, r2(d.precio), r2(d.descLinea),
         d.iva, r2(d.neto), null,
         d.formato ? d.formato.id : null,
         d.formato ? d.formato.cajas : null,
         d.formato ? d.formato.nombre : null,
         d.formato ? d.formato.unidades : null,
         d.formato ? r2(d.formato.precio) : null],
      )
    }

    await auditar(tx, {
      usuarioId: userId, accion: 'CREAR_PEDIDO', entidad: 'sales_orders', entidadId: pedido.id,
      despues: { code: pedido.code, cliente: cliente.code, lineas: detalles.length, total: pedido.total },
    })
    return obtenerPedidoEn(tx, pedido.id)
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Confirmar: APARTA. No descuenta.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Confirma el pedido y aparta su mercancía.
 *
 * El reparto entre lotes es FEFO, el mismo criterio con el que se consume en
 * producción: se aparta lo que caduca antes. Y los lotes se eligen AQUÍ, que
 * es lo que luego permite saber de dónde sale cada entrega.
 *
 * Todo o nada: si falta stock de una línea, no se aparta nada. Un pedido con
 * tres líneas y una corta no deja dos líneas comprometidas y la tercera libre.
 */
export async function confirmarPedido(orderId, userId) {
  return transaction(async (tx) => {
    const pedido = await tx.one(
      `SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [orderId])
    if (!pedido) throw new Error('El pedido no existe')
    if (pedido.status !== 'DRAFT' && pedido.status !== 'CONFIRMED') {
      throw new Error(`El pedido está en estado ${pedido.status} y no se puede confirmar`)
    }

    const lineas = await tx.query(
      `SELECT l.*, i.name, i.sku, i.track_lots
         FROM sales_order_lines l JOIN items i ON i.id = l.item_id
        WHERE l.sales_order_id = $1 ORDER BY l.id FOR UPDATE`, [orderId])

    const plan = []
    const faltan = []

    for (const l of lineas) {
      // ── Lo que YA está apartado para esta línea ─────────────────────────
      // Puede venir de una fabricación hecha para este pedido: `producir()`
      // aparta el lote PT recién salido de fábrica. Si se confirmara el pedido
      // a ciegas se intentaría apartar otra vez lo mismo y la base lo
      // rechazaría por sobre-reserva. Lo correcto es completar, no empezar.
      const yaReservado = await tx.one(
        `SELECT COALESCE(SUM(qty - qty_consumed), 0) s
           FROM order_reservations
          WHERE order_line_id = $1 AND status IN ('ACTIVE','ASSIGNED')`, [l.id])
      const viva = Number(yaReservado.s)
      const porApartar = Math.max(Number(l.qty) - viva, 0)
      if (porApartar <= 1e-9) {
        plan.push({ linea: l, reparto: [] })
        continue
      }
      // Los lotes se leen de la vista y se bloquean uno a uno, en el MISMO
      // orden que devuelve el FEFO. Dos confirmaciones simultáneas que leyeran
      // en distinto orden esperarían cada una al lote que la otra tiene
      // bloqueado, y se colgarían.
      const lotes = await tx.query(
        `SELECT lot_id, code, qty_available, expiry_date
           FROM v_fefo_candidates
          WHERE item_id = $1 AND qty_available > 0
          ORDER BY priority`,
        [l.item_id],
      )
      for (const c of lotes) {
        await tx.one('SELECT id FROM lots WHERE id = $1 FOR UPDATE', [c.lot_id])
      }
      let restante = porApartar
      const reparto = []
      for (const c of lotes) {
        if (restante <= 1e-9) break
        const tomar = Math.min(restante, Number(c.qty_available))
        if (tomar <= 0) continue
        reparto.push({ lotId: c.lot_id, code: c.code, qty: tomar, caducidad: c.expiry_date })
        restante -= tomar
      }
      if (restante > 1e-9) {
        faltan.push({ linea: l.id, nombre: l.name, falta: restante, pide: porApartar })
      }
      plan.push({ linea: l, reparto })
    }

    if (faltan.length > 0) {
      const detalle = faltan.map((f) => `${f.nombre} (faltan ${f.falta} de las ${f.pide} por apartado)`)
        .join(', ')
      const err = new Error(`No hay stock para confirmar el pedido: ${detalle}`)
      err.codigo = 'STOCK_INSUFICIENTE_PARA_CONFIRMAR'
      // 409, no 500: es una regla de negocio —falta mercancía—, no una avería.
      // Con 500 el usuario veía «Error interno del servidor» y no entendía
      // que lo que le faltaba era stock.
      err.estado = 409
      err.faltan = faltan
      throw err
    }

    let apartada = 0
    for (const { linea, reparto } of plan) {
      if (reparto.length === 0) continue
      for (const r of reparto) {
        const reserva = await tx.one(
          `INSERT INTO order_reservations
             (sales_order_id, order_line_id, item_id, lot_id, qty, unit_id, status, hold_type, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE','ORDER',$7)
           RETURNING id, lot_id, qty`,
          [orderId, linea.id, linea.item_id, r.lotId, r.qty, linea.unit_id, userId],
        )
        apartada += Number(reserva.qty)
        // ── AQUÍ NO SE TOCA lots.qty_available. ────────────────────────────
        // La mercancía sigue en el almacén. Solo queda comprometida.
      }
    }

    const d = await tx.one(
      `UPDATE sales_orders SET status='RESERVED', updated_at=now() WHERE id=$1 RETURNING *`, [orderId])
    await auditar(tx, {
      usuarioId: userId, accion: 'CONFIRMAR_PEDIDO', entidad: 'sales_orders', entidadId: orderId,
      antes: { status: pedido.status }, despues: { status: 'RESERVED', apartada },
    })
    return { ...d, apartado: apartada }
  })
}

/** Simula qué se apartaría, sin apartar nada. La pantalla lo llama antes de confirmar. */
export async function simularConfirmacion(orderId) {
  return transaction(async (tx) => {
    const lineas = await tx.query(
      `SELECT l.*, i.name, i.sku FROM sales_order_lines l
         JOIN items i ON i.id = l.item_id
        WHERE l.sales_order_id = $1 ORDER BY l.id`, [orderId])
    const salida = []
    for (const l of lineas) {
      const lotes = await tx.query(
        `SELECT lot_id, code, qty_available, expiry_date
           FROM v_fefo_candidates WHERE item_id = $1 AND qty_available > 0 ORDER BY priority`,
        [l.item_id])
      let restante = Number(l.qty)
      const reparto = []
      for (const c of lotes) {
        if (restante <= 1e-9) break
        const tomar = Math.min(restante, Number(c.qty_available))
        if (tomar <= 0) continue
        reparto.push({ lotId: c.lot_id, code: c.code, qty: tomar, caducidad: c.expiry_date })
        restante -= tomar
      }
      salida.push({
        lineaId: l.id, itemId: l.item_id, nombre: l.name, pide: Number(l.qty),
        reparto, falta: Math.max(restante, 0), suficiente: restante <= 1e-9,
      })
    }
    return { lineas: salida, se_puede_confirmar: salida.every((l) => l.suficiente) }
  })
}

/** Pasa el pedido a PREPARED. Ya está apartado: esto es solo el parte de trabajo. */
export async function prepararPedido(orderId, userId) {
  return transaction(async (tx) => {
    const p = await tx.one(`SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [orderId])
    if (!p) throw new Error('El pedido no existe')
    if (p.status !== 'RESERVED') {
      throw new Error(`Solo se puede preparar un pedido reservado. Este está en ${p.status}.`)
    }
    const vivas = await tx.one(
      `SELECT COUNT(*) n FROM order_reservations
        WHERE sales_order_id=$1 AND status IN ('ACTIVE','ASSIGNED')`, [orderId])
    if (Number(vivas.n) === 0) {
      throw new Error('El pedido no tiene nada apartado. Confírmalo antes de preparar.')
    }
    const d = await tx.one(
      `UPDATE sales_orders SET status='PREPARED', updated_at=now() WHERE id=$1 RETURNING *`, [orderId])
    await auditar(tx, {
      usuarioId: userId, accion: 'PREPARAR_PEDIDO', entidad: 'sales_orders', entidadId: orderId,
      antes: { status: p.status }, despues: { status: 'PREPARED' },
    })
    return d
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Anular: LIBERA. No devuelve stock, porque no se movió.
// ═══════════════════════════════════════════════════════════════════════════

export async function anularPedido(orderId, motivo, userId) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw new Error('Anular un pedido necesita un motivo')
  }
  return transaction(async (tx) => {
    const p = await tx.one(`SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [orderId])
    if (!p) throw new Error('El pedido no existe')
    if (p.status === 'DELIVERED') {
      const err = new Error('Un pedido entregado no se anula: se devuelve, que es otra cosa')
      err.codigo = 'PEDIDO_ENTREGADO_NO_ANULABLE'
      throw err
    }
    if (p.status === 'CANCELLED') throw new Error('El pedido ya está anulado')

    const reservas = await tx.query(
      `SELECT * FROM order_reservations
        WHERE sales_order_id=$1 AND status IN ('ACTIVE','ASSIGNED') FOR UPDATE`, [orderId])
    for (const r of reservas) {
      await tx.query(
        `UPDATE order_reservations
            SET status='RELEASED', released_at=now(), release_reason=$2 WHERE id=$1`,
        [r.id, motivo])
    }
    const d = await tx.one(
      `UPDATE sales_orders
          SET status='CANCELLED', cancelled_at=now(), cancel_reason=$2, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [orderId, motivo])
    await auditar(tx, {
      usuarioId: userId, accion: 'ANULAR_PEDIDO', entidad: 'sales_orders', entidadId: orderId,
      antes: { status: p.status }, despues: { status: 'CANCELLED', liberadas: reservas.length },
    })
    return { ...d, liberadas: reservas.length, unidades_liberadas: r2(reservas.reduce((s, r) => s + Number(r.qty), 0)) }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Lectura
// ═══════════════════════════════════════════════════════════════════════════

export async function obtenerPedidoEn(tx, orderId) {
  const p = await tx.one(
    `SELECT o.*, c.code AS cliente_code, c.name AS cliente_name, c.company_name,
            c.address, c.phone, c.email, c.qr_token, z.name AS zona,
            u.full_name AS comercial
       FROM sales_orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN zones z ON z.id = c.zone_id
       LEFT JOIN com_perfiles cp ON cp.id = o.comercial_id
       LEFT JOIN users u ON u.id = cp.user_id
      WHERE o.id = $1`, [orderId])
  if (!p) return null
  p.lineas = await tx.query(
    `SELECT l.*, i.sku, i.name AS item_name, u.code AS unit_code
       FROM sales_order_lines l
       JOIN items i ON i.id = l.item_id
       JOIN units u ON u.id = l.unit_id
      WHERE l.sales_order_id = $1 ORDER BY l.id`, [orderId])
  p.reservas = await tx.query(
    `SELECT r.id, r.order_line_id, r.item_id, r.lot_id, r.qty, r.qty_consumed,
            (r.qty - r.qty_consumed) AS qty_viva, r.status, r.created_at,
            l.code AS lote_code, l.expiry_date
       FROM order_reservations r
       JOIN lots l ON l.id = r.lot_id
      WHERE r.sales_order_id = $1 ORDER BY r.id`, [orderId])
  p.entregas = await tx.query(
    `SELECT d.id, d.code, d.status, d.delivered_at, u.full_name AS repartidor
       FROM deliveries d LEFT JOIN users u ON u.id = d.rep_id
      WHERE d.sales_order_id = $1 ORDER BY d.created_at`, [orderId])
  p.albaranes = await tx.query(
    `SELECT id, code, status, copies, printed_at, signed_at, delivered_at
       FROM albaranes WHERE sales_order_id = $1 ORDER BY created_at`, [orderId])
  p.producciones = await tx.query(
    `SELECT pr.id, pr.code, pr.status, pr.actual_qty, pr.finished_at, l.id AS lot_id, l.code AS lote_pt
       FROM productions pr LEFT JOIN lots l ON l.production_id = pr.id
      WHERE pr.sales_order_id = $1 ORDER BY pr.id`, [orderId])
  p.resumen = {
    pedido: r2(p.lineas.reduce((s, l) => s + Number(l.qty), 0)),
    entregado: r2(p.lineas.reduce((s, l) => s + Number(l.qty_delivered), 0)),
    pendiente: r2(p.lineas.reduce((s, l) => s + (Number(l.qty) - Number(l.qty_delivered)), 0)),
  }
  return p
}

export async function obtenerPedido(orderId) {
  return transaction((tx) => obtenerPedidoEn(tx, orderId))
}

export async function listarPedidos({ status = null, customerId = null, buscar = '', limite = 100, vivas = false } = {}) {
  return transaction(async (tx) => {
    // `v_order_progress` renombra las columnas: aqui son `order_id`,
    // `order_code`... y no `id` y `code`. Confundirlas devuelve un error de
    // columna inexistente que parece un fallo de la vista.
    const cond = []
    const p = []
    if (status) { p.push(status); cond.push(`o.status = $${p.length}`) }
    if (customerId) { p.push(customerId); cond.push(`o.customer_id = $${p.length}`) }
    if (buscar) {
      p.push(`%${String(buscar).toLowerCase()}%`)
      cond.push(`(lower(o.order_code) LIKE $${p.length} OR lower(o.customer_name) LIKE $${p.length}`
              + ` OR lower(o.customer_code) LIKE $${p.length})`)
    }
    // «Vivas» = lo que todavía hay que hacer. Un pedido entregado o anulado NO
    // sale en la lista de trabajo, pero sigue en su histórico y en su ficha.
    if (vivas) cond.push(`o.status IN ('DRAFT','CONFIRMED','RESERVED','PREPARED','IN_ROUTE')`)
    p.push(limite)
    return tx.query(
      `SELECT o.order_id, o.order_code, o.status, o.order_date, o.promised_date,
              o.total, o.currency_code, o.qty_ordered, o.qty_delivered, o.qty_pending,
              o.pending_lines, o.customer_id, o.customer_code, o.customer_name,
              (SELECT COUNT(*) FROM deliveries d WHERE d.sales_order_id = o.order_id) AS entregas,
              (SELECT COUNT(*) FROM albaranes a WHERE a.sales_order_id = o.order_id) AS albaranes
         FROM v_order_progress o
        ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER BY o.created_at DESC LIMIT $${p.length}`, p)
  })
}
