/**
 * Servicio de inventario.
 *
 * Regla del módulo: NINGUNA función escribe existencias directamente. Todas
 * pasan por `moverStock` y, por tanto, por el libro mayor. Aquí se decide
 * QUÉ pasa; en stock.js se decide CÓMO se refleja.
 *
 * Toda operación es una transacción completa: o deja el lote, el movimiento,
 * el estado y la auditoría, o no deja nada.
 */

import { transaction, one, query } from '../db/client.js'
import { moverStock, crearLoteConEntrada, ErrorDeStock } from './stock.js'
import { siguienteCodigoLoteTexto, siguienteCodigoLoteProducto, siguienteNumeroEntrada } from './codigos.js'
import { auditar } from './auditoria.js'

export class ErrorDeInventario extends Error {
  constructor(mensaje, codigo = 'INVENTARIO', estado = 400, detalle = undefined) {
    super(mensaje)
    this.name = 'ErrorDeInventario'
    this.codigo = codigo
    this.estado = estado
    this.detalle = detalle
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRADAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra una entrada de inventario.
 *
 * El flujo completo, en una transacción:
 *   lote creado → movimiento de entrada → disponible actualizado → auditoría
 *
 * @param {object} p
 * @param {number} p.itemId
 * @param {number} p.cantidad
 * @param {string} [p.codigoLote]  si no, se genera
 * @param {Date}   [p.caducidad]
 * @param {number} [p.proveedorId]
 * @param {number} [p.costeUnitario]
 * @param {string} [p.numeroAlbaran]
 * @param {string} [p.origen]      PURCHASE | MANUAL_RECEPTION
 * @param {number} p.usuarioId
 */
export async function registrarEntrada(p, txExistente = null) {
  // La API y la documentación hablan español; las columnas de PostgreSQL hablan
  // inglés. Aquí se normaliza UNA vez, en un solo sitio, para que el resto del
  // cuerpo use un único vocabulario y no sea fácil equivocarse al escribirlo.
  const op = {
    itemId:        p.itemId,
    qty:           Number(p.cantidad),
    code:          p.codigoLote ?? p.code ?? null,
    expiryDate:    p.caducidad ?? p.expiryDate ?? null,
    supplierId:    p.proveedorId ?? p.supplierId ?? null,
    supplierLot:   p.loteProveedor ?? p.supplierLotCode ?? null,
    invoiceRef:    p.numeroAlbaran ?? p.invoiceRef ?? null,
    unitCost:      p.costeUnitario ?? p.unitCost ?? null,
    documentUrl:   p.documentoUrl ?? p.documentUrl ?? null,
    qualityCert:   p.certificado ?? p.qualityCert ?? null,
    originType:    p.origen ?? p.originType ?? 'MANUAL_RECEPTION',
    originId:      p.origenId ?? p.originId ?? null,
    notes:         p.notas ?? p.notes ?? null,
    userId:        p.usuarioId ?? p.userId,
  }

  if (!op.itemId) throw new ErrorDeInventario('Falta el artículo', 'CAMPO_FALTANTE')
  if (!Number.isFinite(op.qty) || op.qty <= 0) {
    throw new ErrorDeInventario('La cantidad debe ser un número mayor que cero', 'CANTIDAD_INVALIDA')
  }

  const cuerpo = async (tx) => {
    const item = await tx.one(
      `SELECT i.*, u.code AS unit_code FROM items i
         JOIN units u ON u.id = i.unit_id
        WHERE i.id = $1`,
      [op.itemId],
    )
    if (!item) throw new ErrorDeInventario('El artículo no existe', 'ARTICULO_NO_ENCONTRADO', 404)
    if (!item.is_active) {
      throw new ErrorDeInventario(`El artículo ${item.name} está archivado`, 'ARTICULO_ARCHIVADO')
    }

    // Todo lo que se compra entra por lote: es lo que hace posible la
    // trazabilidad y el recall. Un artículo marcado sin control de lotes es una
    // decisión consciente, y hay que tomarla antes, no durante la recepción.
    if (item.track_lots === false) {
      throw new ErrorDeInventario(
        `El artículo ${item.name} está marcado sin control de lotes. ` +
        'Actívalo antes de registrar entradas.', 'SIN_CONTROL_DE_LOTES',
      )
    }

    // Un lote de producto terminado se numera POR PRODUCTO (PT-DES-00001),
    // venga de una producción o de una recepción de apertura. Materia prima y
    // envase siguen su serie propia.
    const code = op.code || (
      item.category_kind === 'FINISHED_GOOD'
        ? await siguienteCodigoLoteProducto(tx, op.itemId)
        : await siguienteCodigoLoteTexto(tx, item.category_kind))

    // El número de ENTRADA sale de su propia serie (), que no comparte
    // contador con ningún lote: una entrada es una recepción, y un lote es una
    // identidad de inventario. Que coincidieran sería pedir que alguien los
    // confunda el día que haya que auditar una retirada.
    const entradaNo = op.entradaNo ?? await siguienteNumeroEntrada(tx)

    const lote = await crearLoteConEntrada(tx, {
      code,
      entradaNo,
      itemId: op.itemId,
      lotKind: item.category_kind,
      initialQty: op.qty,
      unitId: item.unit_id,
      expiryDate: op.expiryDate,
      supplierId: op.supplierId,
      supplierLotCode: op.supplierLot,
      invoiceRef: op.invoiceRef,
      originType: op.originType,
      originId: op.originId,
      unitCost: op.unitCost,
      documentUrl: op.documentUrl,
      qualityCert: op.qualityCert,
      usuarioId: op.userId,
      notes: op.notes,
    })

    await auditar(tx, {
      usuarioId: op.userId, accion: 'RECEPCION', entidad: 'lots', entidadId: lote.id,
      despues: { code, itemId: op.itemId, cantidad: op.qty, proveedorId: op.supplierId, caducidad: op.expiryDate },
    })

    //
    // El movimiento se relee del libro mayor, y no se hace que `crearLoteConEntrada`
    // lo devuelva, porque esa función la usan veinte sitios y cambiar su forma
    // de retorno para acomodar a un solo llamante es poner a todos en riesgo a
    // cambio de ahorrarse una consulta que se nota en nanosegundos.
    //
    const movimientoId = (await tx.one(
      `SELECT id FROM stock_movements
        WHERE lot_id = $1 AND movement_type = 'RECEPTION'
        ORDER BY id DESC LIMIT 1`, [lote.id]))?.id ?? null

    return { lote, stock: await existenciasDe(op.itemId, tx), movimientoId }
  }

  // Si quien llama ya tiene una transacción abierta, se ejecuta dentro de ella:
  // la entrada forma parte de la operación mayor en lugar de abrir la suya.
  return txExistente ? cuerpo(txExistente) : transaction(cuerpo)
}

/**
 * Carga varias entradas a la vez, de un mismo albarán.
 *
 * O entra todo el albarán, o no entra nada. Una sola transacción que abarca las
 * N líneas: si la línea 7 de 20 falla porque el artículo no existe, no queda el
 * lote de la línea 1 ni su movimiento huérfanos por el camino.
 *
 * `stock_movement_keys` garantiza además que, si el cliente reintenta el mismo
 * albarán, no se duplique la entrada.
 */
export async function registrarEntradasMasivas(lineas, usuarioId, opciones = {}) {
  if (!Array.isArray(lineas) || !lineas.length) {
    throw new ErrorDeInventario('No se ha enviado ninguna línea', 'ENTRADA_VACIA')
  }
  if (lineas.length > 200) {
    throw new ErrorDeInventario('Máximo 200 líneas por albarán', 'DEMASIADAS_LINEAS')
  }
  const { numeroAlbaran = null, proveedorId = null, loteProveedor = null } = opciones

  return transaction(async (tx) => {
    //
    // UNA LLAVE POR LÍNEA, no una por albarán.
    //
    // Un albarán de 20 líneas genera 20 movimientos, y `stock_movement_keys`
    // tiene su clave primaria en `key`: una sola fila no puede sujetar veinte.
    // Se numera `ALBARAN:<n>#<línea>`, y la comprobación de repetido mira si
    // YA EXISTE ALGUNA de las líneas de ese albarán. Si el cliente reintenta
    // el albarán entero, se rechaza entero —que es lo que se quiere— y si
    // reintenta una línea suelta, también.
    //
    // Y aquí es donde la versión anterior se rompía: pedía `SELECT id` a una
    // tabla que no tiene columna `id` (su clave es `key`), y luego insertaba
    // una columna `scope` que tampoco existe. Las dos escribían en campos
    // inventados, y PostgreSQL contestaba «column does not exist» sin más.
    //
    const prefijo = numeroAlbaran ? `ALBARAN:${numeroAlbaran}#` : null
    if (prefijo) {
      const repetido = await tx.one(
        `SELECT key FROM stock_movement_keys WHERE key LIKE $1 LIMIT 1`, [`${prefijo}%`])
      if (repetido) {
        throw new ErrorDeInventario(
          `El albarán ${numeroAlbaran} ya estaba registrado`, 'ALBARAN_DUPLICADO', 409)
      }
    }

    const lotes = []
    for (const [i, linea] of lineas.entries()) {
      try {
        const r = await registrarEntrada({
          ...linea,
          proveedorId: linea.proveedorId ?? proveedorId,
          loteProveedor: linea.loteProveedor ?? loteProveedor,
          numeroAlbaran: linea.numeroAlbaran ?? numeroAlbaran,
          //
          // `MANUAL_RECEPTION`, no `RECEPTION`.
          //
          // `RECEPTION` es el movement_type —cómo se movió el stock—, y este
          // campo es el origin_type —de dónde viene la mercancía—, y sus
          // valores son PURCHASE, PRODUCTION o MANUAL_RECEPTION. Se confundían
          // porque las dos cosas se llaman «recepción». El movimiento sigue
          // siendo una RECEPCION: eso no cambia, lo que cambia es de dónde
          // viene, y es un ingreso manual, no una compra ni una producción.
          //
          origen: 'MANUAL_RECEPTION',
          usuarioId,
        }, tx)   // ← la misma transacción, no una propia
        lotes.push(r.lote)

        if (prefijo && r.movimientoId) {
          await tx.query(
            `INSERT INTO stock_movement_keys (key, movement_id, created_at)
             VALUES ($1,$2,now()) ON CONFLICT (key) DO NOTHING`,
            [`${prefijo}${i + 1}`, r.movimientoId],
          )
        }
      } catch (e) {
        // Se dice QUÉ línea ha fallado, no solo que algo falló.
        //
        // Y se escribe en `message`, no en `mensaje`: `ErrorDeInventario` pasa
        // su texto a `super(mensaje)`, así que `message` es lo que ve el
        // operador. Ponerlo en `mensaje` —una propiedad que nadie lee— hacía
        // que la línea exacta del fallo no llegara nunca a la pantalla.
        if (e instanceof ErrorDeInventario) {
          e.message = `Línea ${i + 1} de ${lineas.length}: ${e.message}`
        }
        throw e
      }
    }
    return lotes
  })
}

export async function ajustarInventario({ itemId, loteId, cantidad, motivo, usuarioId, refType = 'ADJUSTMENT', refId = null }) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw new ErrorDeInventario('Un ajuste necesita un motivo', 'MOTIVO_OBLIGATORIO')
  }
  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) === 0) {
    throw new ErrorDeInventario('La cantidad a ajustar no puede ser cero', 'CANTIDAD_INVALIDA')
  }
  if (!itemId && !loteId) {
    throw new ErrorDeInventario('Hay que indicar el artículo o el lote a ajustar', 'CAMPO_FALTANTE')
  }

  const esSalida = Number(cantidad) < 0
  const magnitud = Math.abs(Number(cantidad))

  return transaction(async (tx) => {
    // ── Paso 1: decidir sobre qué lotes va la salida ─────────────────────────
    // Si se indica un lote, ese y solo ese. Si no, se reparte por FEFO entre
    // todos los lotes utilizables del artículo: meterlo todo en el primero
    // obligaría a hacer tres ajustes de 30 para una salida de 90, y además
    // dejaría el lote que caduca primero intacto, que es justo al revés de como
    // se consume el almacén.
    let plan
    if (loteId) {
      const lote = await tx.one('SELECT * FROM lots WHERE id = $1 FOR UPDATE', [loteId])
      if (!lote) throw new ErrorDeInventario('El lote no existe', 'LOTE_NO_ENCONTRADO', 404)
      if (lote.status !== 'ACTIVE') {
        throw new ErrorDeInventario(
          `El lote ${lote.code} está en estado ${lote.status}. Devuélvelo a ACTIVE antes de ajustarlo.`,
          'LOTE_NO_ACTIVO', 409)
      }
      if (esSalida && Number(lote.qty_available) < magnitud) {
        throw new ErrorDeInventario(
          `El lote ${lote.code} tiene ${lote.qty_available} y se piden ${magnitud}`, 'STOCK_INSUFICIENTE', 409)
      }
      plan = [{ itemId: lote.item_id, lotId: lote.id, code: lote.code, qty: magnitud }]
    } else {
      const planificado = await planificar(itemId, magnitud, tx)
      if (!planificado.plan.length) {
        throw new ErrorDeInventario(
          'Ese artículo no tiene existencias utilizables que ajustar', 'SIN_EXISTENCIAS', 409)
      }
      if (!planificado.suficiente) {
        const hay = planificado.plan.reduce((t, p) => t + p.qty, 0)
        throw new ErrorDeInventario(
          `Solo hay ${hay} disponibles y la salida es de ${magnitud}. Faltan ${planificado.faltante}.`,
          'STOCK_INSUFICIENTE', 409)
      }
      // Se bloquean TODOS los lotes del plan, siempre en el mismo orden. Si dos
      // salidas cogieran los lotes en orden distinto seProduce un interbloqueo:
      // cada una espera al lote que la otra tiene Cogido.
      for (const paso of planificado.plan) {
        await tx.one('SELECT id FROM lots WHERE id = $1 FOR UPDATE', [paso.lotId])
      }
      plan = planificado.plan
    }

    const primerLote = await tx.one('SELECT * FROM lots WHERE id = $1', [plan[0].lotId])
    const articleId = primerLote.item_id
    const stockAntes = await existenciasDe(articleId, tx)

    // ── Paso 2: mover, un movimiento por lote tocado ─────────────────────────
    // Varios movimientos y no uno: el libro mayor tiene que poder explicar que
    // 100 unidades salieron repartidas en 40 de un lote y 60 de otro.
    const movimiento = esSalida ? 'ADJUSTMENT_OUT' : 'ADJUSTMENT_IN'
    const movs = []
    for (const paso of plan) {
      const res = await moverStock(tx, {
        lotId: paso.lotId,
        qty: esSalida ? -paso.qty : paso.qty,
        movimiento,
        refType, refId,
        motivo,
        notas: plan.length > 1 ? `${motivo} (repartido entre ${plan.length} lotes)` : null,
        usuarioId,
      })
      movs.push({ lote: paso.code, qty: paso.qty, movimientoId: res.movementId })
    }

    const stockDespues = await existenciasDe(articleId, tx)
    const lotesTocados = []
    for (const paso of plan) {
      const l = await tx.one('SELECT code, qty_available FROM lots WHERE id = $1', [paso.lotId])
      lotesTocados.push({ lote: l.code, disponible: Number(l.qty_available) })
    }

    await auditar(tx, {
      usuarioId, accion: 'AJUSTE', entidad: 'lots', entidadId: plan[0].lotId,
      antes: {
        qty_on_hand_articulo: Number(stockAntes.qty_on_hand),
        lotes: lotesTocados,
      },
      despues: {
        qty_on_hand_articulo: Number(stockDespues.qty_on_hand),
        cantidad: Number(cantidad),
        motivo,
        repartido_en: movs.length,
        lotes: lotesTocados,
      },
    })

    return {
      ok: true,
      itemId: articleId,
      // El artículo: lo que cambia de verdad en el inventario.
      valorAnterior: Number(stockAntes.qty_on_hand),
      valorNuevo: Number(stockDespues.qty_on_hand),
      // El detalle: qué lotes se tocaron y en cuánto.
      movimientos: movs,
      lotes: lotesTocados,
      cantidad: Number(cantidad),
      motivo,
      stock: stockDespues,
    }
  })
}

export async function reservar({ orderId, orderLineId, itemId, cantidad, usuarioId }) {
  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) {
    throw new ErrorDeInventario('La cantidad a reservar debe ser mayor que cero', 'CANTIDAD_INVALIDA')
  }
  return transaction(async (tx) => {
    const item = await tx.one('SELECT id, name, unit_id FROM items WHERE id = $1', [itemId])
    if (!item) throw new ErrorDeInventario('El artículo no existe', 'ARTICULO_NO_ENCONTRADO', 404)

    const disponible = await existenciasDe(itemId, tx)
    const pedida = Number(cantidad)
    if (Number(disponible.qty_available) < pedida) {
      throw new ErrorDeInventario(
        `No hay existencias suficientes de ${item.name}: disponibles ${disponible.qty_available}, pedidas ${pedida}`,
        'EXISTENCIAS_INSUFICIENTES', 409,
        { disponibles: Number(disponible.qty_available), pedidas: pedida },
      )
    }

    const reserva = await tx.one(
      `INSERT INTO order_reservations
         (sales_order_id, order_line_id, item_id, qty, unit_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
      [orderId, orderLineId, itemId, pedida, item.unit_id, usuarioId],
    )
    await auditar(tx, {
      usuarioId, accion: 'RESERVA', entidad: 'order_reservations', entidadId: reserva.id,
      despues: { itemId, cantidad: pedida, orderId },
    })
    const stock = await existenciasDe(itemId, tx)
    return { reserva, stock }
  })
}

/** Libera una reserva. NO devuelve stock: nunca se movió. */
export async function liberarReserva({ reservaId, motivo = null, usuarioId }) {
  return transaction(async (tx) => {
    const r = await tx.one('SELECT * FROM order_reservations WHERE id = $1 FOR UPDATE', [reservaId])
    if (!r) throw new ErrorDeInventario('La reserva no existe', 'RESERVA_NO_ENCONTRADA', 404)
    if (r.status !== 'ACTIVE' && r.status !== 'ASSIGNED') {
      throw new ErrorDeInventario(
        `La reserva ya está en estado ${r.status} y no se puede liberar`, 'RESERVA_NO_LIBERABLE', 409,
      )
    }
    await tx.query(
      `UPDATE order_reservations SET status='RELEASED', released_at=now(), release_reason=$2 WHERE id=$1`,
      [reservaId, motivo],
    )
    await auditar(tx, {
      usuarioId, accion: 'LIBERAR_RESERVA', entidad: 'order_reservations', entidadId: reservaId,
      antes: { status: r.status, qty: Number(r.qty) }, despues: { status: 'RELEASED' },
    })
    return { ok: true, liberada: Number(r.qty) }
  })
}

/** Reserva unplanned: aparta existencias sin un pedido detrás (uso interno). */
/**
 * Retención interna: apartar stock sin que exista un pedido de venta.
 *
 * Para una orden de producción, una muestra de laboratorio, un control de
 * calidad o una reparación. Antes esto fabricaba un pedido falso con el primer
 * cliente de la tabla, que era peor que no tener la función: metía en el
 * histórico de ventas líneas de precio cero que nadie había pedido.
 *
 * Ahora es una retención de verdad: misma tabla, `sales_order_id` a NULL, y un
 * motivo obligatorio que queda registrado.
 */
export async function reservarInterno({ itemId, cantidad, motivo, usuarioId, holdType = 'OTHER' }) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw new ErrorDeInventario(
      'Una retención interna necesita un motivo de al menos 3 caracteres', 'MOTIVO_OBLIGATORIO')
  }
  if (!['PRODUCTION', 'SAMPLE', 'QUALITY', 'MAINTENANCE', 'OTHER'].includes(holdType)) {
    throw new ErrorDeInventario(`Tipo de retención desconocido: ${holdType}`, 'TIPO_RETENCION_INVALIDO')
  }

  return transaction(async (tx) => {
    const item = await tx.one('SELECT * FROM items WHERE id = $1', [itemId])
    if (!item) throw new ErrorDeInventario('El artículo no existe', 'ARTICULO_NO_ENCONTRADO', 404)
    if (!item.is_active) {
      throw new ErrorDeInventario(`El artículo ${item.name} está archivado`, 'ARTICULO_ARCHIVADO')
    }

    const stock = await existenciasDe(itemId, tx)
    if (Number(stock.qty_available) < Number(cantidad)) {
      throw new ErrorDeInventario(
        `No hay existencias suficientes: se piden ${cantidad} y hay ${stock.qty_available} disponibles`,
        'STOCK_INSUFICIENTE', 409,
      )
    }

    const reserva = await tx.one(
      `INSERT INTO order_reservations
         (sales_order_id, order_line_id, item_id, qty, unit_id, status, created_by, hold_type, hold_reason)
       VALUES (NULL, NULL, $1, $2, $3, 'ACTIVE', $4, $5, $6)
       RETURNING *`,
      [itemId, Number(cantidad), item.unit_id, usuarioId, holdType, String(motivo).trim()],
    )
    await auditar(tx, {
      usuarioId, accion: 'RETENCION_INTERNA', entidad: 'order_reservations', entidadId: reserva.id,
      despues: { itemId, cantidad: Number(cantidad), motivo, holdType },
    })
    return { reserva, stock: await existenciasDe(itemId, tx) }
  })
}

export async function cambiarEstadoLote({ loteId, estado, motivo, usuarioId }) {
  const validos = ['ACTIVE', 'BLOCKED', 'QUARANTINE', 'RETIRED']
  if (!validos.includes(estado)) {
    throw new ErrorDeInventario(`Estado no válido: ${estado}`, 'ESTADO_INVALIDO')
  }
  if (!motivo) throw new ErrorDeInventario('Cambiar el estado de un lote necesita un motivo', 'MOTIVO_OBLIGATORIO')

  return transaction(async (tx) => {
    const antes = await tx.one('SELECT * FROM lots WHERE id = $1 FOR UPDATE', [loteId])
    if (!antes) throw new ErrorDeInventario('El lote no existe', 'LOTE_NO_ENCONTRADO', 404)
    if (antes.status === estado) {
      return { ok: true, yaEstaba: true, estado }
    }
    await tx.query(
      `UPDATE lots SET status = $2, status_reason = $3, status_changed_by = $4, status_changed_at = now()
        WHERE id = $1`,
      [loteId, estado, motivo, usuarioId],
    )
    await auditar(tx, {
      usuarioId, accion: `LOTE_${estado}`, entidad: 'lots', entidadId: loteId,
      antes: { status: antes.status }, despues: { status: estado, motivo },
    })
    return { ok: true, estado, anterior: antes.status }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSULTAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Existencias de un artículo. Se leen de la vista, que es LA definición.
 * No hay ningún campo paralelo que pueda contradecirla.
 */
export async function existenciasDe(itemId, tx = null) {
  const leer = tx ? tx.one.bind(tx) : one
  return leer('SELECT * FROM v_item_available WHERE item_id = $1', [itemId])
}

/** Existencias de todo el catálogo, con filtro por tipo. */
export async function listarExistencias({ tipo = null, soloBajoMinimo = false, buscar = null } = {}) {
  const cond = []
  const params = []
  if (tipo) { params.push(tipo); cond.push(`s.category_kind = $${params.length}`) }
  if (soloBajoMinimo) cond.push('s.is_below_min')
  if (buscar) { params.push(`%${buscar}%`); cond.push(`(s.name ILIKE $${params.length} OR s.sku ILIKE $${params.length})`) }
  return query(
    `SELECT s.*, u.code AS unit_code, u.symbol AS unit_symbol
       FROM v_item_available s
       JOIN units u ON u.id = (SELECT unit_id FROM items WHERE id = s.item_id)
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY s.name`,
    params,
  )
}

/** Lotes de un artículo, con su historia de movimientos. */
export async function lotesDe(itemId, { incluirAgotados = true } = {}) {
  return query(
    `SELECT l.*, u.code AS unit_code, u.symbol AS unit_symbol
       FROM lots l JOIN units u ON u.id = l.unit_id
      WHERE l.item_id = $1
        ${incluirAgotados ? '' : "AND l.qty_available > 0 AND l.status = 'ACTIVE'"}
      ORDER BY l.expiry_date NULLS LAST, l.received_at DESC`,
    [itemId],
  )
}

/** Historial de movimientos de un lote o de un artículo. */
export async function movimientos({ loteId = null, itemId = null, limite = 100, tipo = null } = {}) {
  const cond = []
  const params = []
  if (loteId) { params.push(loteId); cond.push(`m.lot_id = $${params.length}`) }
  if (itemId) { params.push(itemId); cond.push(`m.item_id = $${params.length}`) }
  if (tipo) { params.push(tipo); cond.push(`m.movement_type = $${params.length}`) }
  params.push(limite)
  return query(
    `SELECT m.*, l.code AS lot_code, i.sku, i.name AS item_name, u.symbol AS unit_symbol,
            us.full_name AS user_name
       FROM stock_movements m
       JOIN lots l ON l.id = m.lot_id
       JOIN items i ON i.id = m.item_id
       JOIN units u ON u.id = m.unit_id
       LEFT JOIN users us ON us.id = m.created_by
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY m.id DESC LIMIT $${params.length}`,
    params,
  )
}

/** Plan FEFO sin consumir nada: qué lotes se tocarían y por qué. */
export async function planificar(itemId, cantidad, tx = null) {
  const { planificarFefo } = await import('./stock.js')
  if (tx) {
    const filas = await tx.query(
      `SELECT item_id, lot_id, code, qty_available, expiry_date, expiry_reason, priority
         FROM v_fefo_candidates WHERE item_id = $1 AND qty_available > 0 ORDER BY priority`,
      [itemId],
    )
    let restante = Number(cantidad)
    const plan = []
    for (const f of filas) {
      if (restante <= 1e-9) break
      const tomar = Math.min(restante, Number(f.qty_available))
      plan.push({ itemId: f.item_id, lotId: f.lot_id, code: f.code, qty: tomar, disponible: Number(f.qty_available), expiryDate: f.expiry_date, motivo: f.expiry_reason, prioridad: f.priority })
      restante -= tomar
    }
    return { plan, suficiente: restante <= 1e-9, faltante: Math.max(restante, 0) }
  }
  return planificarFefo(itemId, cantidad)
}

/** Resumen para el panel de inventario. */
export async function resumenInventario() {
  const porTipo = await query(
    `SELECT category_kind AS tipo,
            COUNT(*)::int AS articulos,
            COALESCE(SUM(qty_on_hand), 0) AS existencias,
            COALESCE(SUM(qty_reserved), 0) AS reservadas,
            COALESCE(SUM(qty_available), 0) AS disponibles,
            COALESCE(SUM(qty_quarantined), 0) AS en_cuarentena,
            COALESCE(SUM(qty_expired), 0) AS caducadas
       FROM v_item_available GROUP BY category_kind ORDER BY category_kind`,
  )
  const bajoMinimo = await query(
    `SELECT item_id, sku, name, qty_on_hand, min_stock, category_kind
       FROM v_item_available WHERE is_below_min ORDER BY (min_stock - qty_on_hand) DESC`,
  )
  const caducidad = await query(
    `SELECT item_id, sku, name, qty_on_hand, min_stock, category_kind
       FROM v_item_available
      WHERE qty_on_hand > 0 AND EXISTS (
        SELECT 1 FROM lots l WHERE l.item_id = v_item_available.item_id
          AND l.status='ACTIVE' AND l.qty_available > 0
          AND l.expiry_date IS NOT NULL AND l.expiry_date <= now() + interval '90 days')
      ORDER BY qty_on_hand DESC`,
  )
  const totales = await one(
    `SELECT COALESCE(SUM(value_at_cost),0) AS valor_coste,
            COALESCE(SUM(value_at_sale),0) AS valor_venta
       FROM v_inventory_value WHERE category_kind IS NOT NULL`,
  )
    // La moneda se lee de la configuración, no se supone. Un panel que dice
    // «EUR» sin haberlo comprobado miente en cuanto la empresa facture en FCFA.
    const moneda = (await one(`SELECT code FROM currencies WHERE is_base = TRUE LIMIT 1`))?.code || null
    return { porTipo, bajoMinimo, caducidad, totales, moneda }
}

// `auditar` vive en core/auditoria.js. Estaba aquí dentro y las demás áreas no
// lo alcanzaban, así que cada una iba a copiarlo. Una copia por módulo es seis
// sitios que se olvidan de actualizar.
