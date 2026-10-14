/**
 * Libro mayor de existencias.
 *
 * ESTE ES EL MÓDULO MÁS IMPORTANTE DEL SISTEMA.
 *
 * En la aplicación anterior el stock se escribía desde nueve sitios distintos
 * y cada uno olvidaba alguno. Aquí hay UNA función, `moverStock`, y el resto del
 * código no tiene forma de cambiar existencias sin pasar por ella.
 *
 * Garantías:
 *   1. Siempre dentro de la transacción que la llama. Si el resto de la
 *      operación falla, el movimiento desaparece con ella.
 *   2. `lots.qty_available` no puede quedar negativo: CHECK en la tabla.
 *   3. No se puede consumir de un lote RETIRED, en cuarentena o caducado.
 *   4. Cada movimiento deja rastro: qué, cuánto, por qué, quién y con qué saldo.
 *   5. Con `clave` se garantiza el consumo único (una entrega no descuenta dos
 *      veces el mismo lote), y la garantía vive en la base, no en el código.
 */

import { query, one } from '../db/client.js'

/** Motivos de bloqueo que impiden consumir de un lote. */
const NO_CONSUMIBLES = new Set(['RETIRED', 'QUARANTINE', 'EXPIRED', 'EXHAUSTED', 'BLOCKED'])

export class ErrorDeStock extends Error {
  constructor(mensaje, detalle = {}) {
    super(mensaje)
    this.name = 'ErrorDeStock'
    this.codigo = 'STOCK_INSUFICIENTE'
    this.detalle = detalle
  }
}

/**
 * Mueve existencias de un lote.
 *
 * @param {object} tx      transacción de db/client.js
 * @param {object} params
 * @param {number} params.lotId
 * @param {number} params.qty        positivo entra, negativo sale
 * @param {string} params.movimiento uno de movement_type (ver migración 003)
 * @param {string} [params.refType]  POLYGENERIC: PURCHASE_ORDER, PRODUCTION, SALES_ORDER, DELIVERY…
 * @param {number} [params.refId]
 * @param {string} [params.clave]    clave de unicidad del movimiento. Si ya existe, no se duplica.
 * @param {string} [params.motivo]   obligatorio en ajustes
 * @param {string} [params.notas]
 * @param {number} [params.usuarioId]
 * @returns {Promise<{movementId, balanceAfter, duplicado: boolean}>}
 */
export async function moverStock(tx, {
  lotId, qty, movimiento, refType = null, refId = null,
  clave = null, motivo = null, notas = null, usuarioId = null,
}) {
  if (!Number.isFinite(qty) || qty === 0) {
    throw new ErrorDeStock('La cantidad del movimiento debe ser un número distinto de cero', { lotId, qty })
  }
  if (['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].includes(movimiento) && !motivo) {
    // La base también lo exige; aquí el error es claro desde el principio.
    throw new ErrorDeStock('Un ajuste necesita un motivo', { lotId })
  }

  // Consumo único: si la clave ya se usó, no se vuelve a descontar.
  if (clave) {
    const previa = await tx.one('SELECT movement_id FROM stock_movement_keys WHERE key = $1', [clave])
    if (previa) {
      const mov = await tx.one('SELECT * FROM stock_movements WHERE id = $1', [previa.movement_id])
      return { movementId: previa.movement_id, balanceAfter: mov.balance_after, duplicado: true }
    }
  }

  const lot = await tx.one('SELECT * FROM lots WHERE id = $1 FOR UPDATE', [lotId])
  if (!lot) throw new ErrorDeStock(`El lote ${lotId} no existe`, { lotId })

  if (qty < 0) {
    // Un lote no consumible no puede devolver existencia. El trigger de la base
    // bloquea el caso equivalente, pero aquí el error le llega a la aplicación
    // con un mensaje que el operario entiende.
    if (NO_CONSUMIBLES.has(lot.status)) {
      throw new ErrorDeStock(
        `El lote ${lot.code} está en estado ${lot.status} y no admite consumo`,
        { lotId, code: lot.code, status: lot.status },
      )
    }
    if (lot.expiry_date && new Date(lot.expiry_date) <= new Date()) {
      throw new ErrorDeStock(`El lote ${lot.code} está caducado`, { lotId, code: lot.code })
    }
  }

  const nuevoSaldo = Number(lot.qty_available) + qty
  if (nuevoSaldo < 0) {
    throw new ErrorDeStock(
      `Existencias insuficientes en ${lot.code}: hay ${lot.qty_available} y se piden ${Math.abs(qty)}`,
      { lotId, code: lot.code, disponible: Number(lot.qty_available), pedido: Math.abs(qty) },
    )
  }
  const consumido = qty < 0
    ? Number(lot.qty_consumed) + Math.abs(qty)
    : Number(lot.qty_consumed)
  const esAjuste = ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'].includes(movimiento)

  // Un ajuste por recuento puede legítimamente encontrar más (o menos) material
  // del que decía la recepción. En ese caso `initial_qty` se corrige también,
  // de modo que la invariante disponible + consumido = recibido siga valiendo.
  if (esAjuste && nuevoSaldo + consumido > Number(lot.initial_qty)) {
    await tx.query(
      `UPDATE lots SET qty_available = $2, qty_consumed = $3, initial_qty = $4 WHERE id = $1`,
      [lotId, nuevoSaldo, consumido, nuevoSaldo + consumido],
    )
  } else {
    if (nuevoSaldo > Number(lot.initial_qty) + 1e-9) {
      throw new ErrorDeStock(
        `El movimiento dejaría el lote ${lot.code} por encima de lo recibido (${lot.initial_qty}). ` +
        'Si es una corrección de inventario, regístrala como ajuste.',
        { lotId, code: lot.code },
      )
    }
    await tx.query(
      `UPDATE lots SET qty_available = $2, qty_consumed = $3 WHERE id = $1`,
      [lotId, nuevoSaldo, consumido],
    )
  }

  // 2. Dejar el movimiento en el libro mayor.
  const mov = await tx.one(
    `INSERT INTO stock_movements
       (lot_id, item_id, movement_type, qty, unit_id, balance_after, ref_type, ref_id, reason, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, balance_after`,
    [lotId, lot.item_id, movimiento, qty, lot.unit_id, nuevoSaldo, refType, refId, motivo, notas, usuarioId],
  )

  // 3. Registrar la clave de unicidad, si la hay.
  if (clave) {
    await tx.query('INSERT INTO stock_movement_keys (key, movement_id) VALUES ($1, $2)', [clave, mov.id])
  }

  return { movementId: mov.id, balanceAfter: nuevoSaldo, duplicado: false }
}

/** Crea un lote y su primer movimiento de entrada, en la misma transacción. */
/**
 * Qué movimiento deja en el libro mayor un lote, según de dónde venga.
 *
 * Antes TODO era RECEPTION: un lote fabricado se contabilizaba como si lo
 * hubieran comprado. El libro mayor dizia «entrada» donde debía decir
 * «producción», y luego nadie podía explicar de dónde salió ese producto.
 */
function movimientoYReferencia(originType, originId, code, productionId) {
  switch (originType) {
    case 'PURCHASE':
      return { movimiento: 'PURCHASE_RECEPTION', refType: 'PURCHASE_ORDER', refId: originId,
        notas: `Entrada del lote ${code}` }
    case 'PRODUCTION':
      return { movimiento: 'PRODUCTION_OUTPUT', refType: 'PRODUCTION', refId: productionId ?? originId,
        notas: `Producción del lote ${code}` }
    case 'RETURN':
      return { movimiento: 'RETURN', refType: 'DELIVERY', refId: originId,
        notas: `Devolución del lote ${code}` }
    default:
      return { movimiento: 'RECEPTION', refType: null, refId: null,
        notas: `Entrada del lote ${code}` }
  }
}

export async function crearLoteConEntrada(tx, {
  code, itemId, lotKind, initialQty, unitId,
  expiryDate = null, supplierId = null, supplierLotCode = null, invoiceRef = null,
  originType = 'MANUAL_RECEPTION', originId = null, unitCost = null,
  documentUrl = null, qualityCert = null, productionId = null,
  machineId = null, operatorId = null, usuarioId = null, notas = null, now = null,
  entradaNo = null,
}) {
  const dup = await tx.one('SELECT id FROM lots WHERE code = $1', [code])
  if (dup) throw new ErrorDeStock(`Ya existe un lote con el código ${code}`, { code })

  //
  // EL COSTE DEL LOTE, Y POR QUÉ SE CALCULA SI NO VIENE
  //
  // El lote guarda lo que costó UNA UNIDAD BASE el día que entró. De ahí salen
  // el coste de las producciones y el margen de las ventas: no es un dato de
  // adorno, es de dónde sale el número que dice si el negocio gana dinero.
  //
  // `unitCost` es lo que se pagó POR LA UNIDAD DEL ARTÍCULO —por litro, por
  // kilo, por unidad—. Y el lote cuenta en unidades BASE, que no siempre son las
  // mismas: comprado a 3,69 €/L y guardado en un lote que cuenta en mililitros,
  // son 0,00369 por ml. Aquí es donde se ganaba o se perdía el factor mil.
  //
  // Y si NO se pasa `unitCost`, el lote nace con el coste DESCONOCIDO —nulo—,
  // no con coste cero. Cero dice «no cuesta nada»; nulo dice «no se sabe». Lo
  // primero es una mentira, y es justo la que después sale como un margen del
  // 100 %.
  //
  //
  // `origin_type` admite 'PURCHASE', y no 'PURCHASE_RECEPTION' —que es el tipo
  // del MOVIMIENTO, no el del lote—. La primera versión comparaba contra el
  // nombre equivocado y por eso todo lote comprado salía con `cost_source =
  // 'MANUAL'`: el coste se guardaba, pero de dónde venía se perdía, y el margen
  // no distinguía entre lo comprado y lo puesto a mano.
  //
  const deDonde = productionId ? 'PRODUCTION'
    : originType === 'PURCHASE' ? 'PURCHASE'
      : originType === 'OPENING' ? 'OPENING' : 'MANUAL'

  let costeBase = null
  if (unitCost !== null && unitCost !== undefined) {
    costeBase = (await tx.one(
      `SELECT fn_convertir($1::numeric, $2::int, $3::int) AS v`,
      [unitCost, unitId, await unidadBaseDe(tx, itemId)])).v
  }

  const lot = await tx.one(
    `INSERT INTO lots
       (code, item_id, lot_kind, initial_qty, qty_available, unit_id,
        expiry_date, supplier_id, supplier_lot_code, invoice_ref, document_url, quality_cert,
        unit_cost, origin_type, origin_id, machine_id, operator_id, notes, created_by,
        received_at, manufactured_at, cost_per_base_unit, cost_source, entrada_no)
     VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20,$21, COALESCE($22::int, nextval('entradas_numero_seq')))
     RETURNING *`,
    [code, itemId, lotKind, initialQty, unitId, expiryDate, supplierId, supplierLotCode,
      invoiceRef, documentUrl, qualityCert, unitCost, originType, originId, machineId,
      operatorId, notas, usuarioId, now || new Date().toISOString(), costeBase, deDonde, entradaNo],
  )

  if (productionId) {
    await tx.query('UPDATE lots SET production_id = $2 WHERE id = $1', [lot.id, productionId])
  }
  // El lote nace en cero y RECIBE la cantidad. Así el libro mayor registra la
  // entrada de verdad y el saldo del movimiento coincide con lo disponible.
  await moverStock(tx, {
    lotId: lot.id, qty: initialQty,
    ...movimientoYReferencia(originType, originId, code, productionId),
    // El usuario va FUERA del helper a propósito: es el mismo para cualquier
    // origen, y esconderlo dentro haría que se perdiera en un refactor.
    usuarioId,
  })
  // Se relee el lote: el INSERT devolvió la fila anterior al movimiento, y el
  // trigger de estado la dejó en EXHAUSTED al nacer en cero.
  return tx.one('SELECT * FROM lots WHERE id = $1', [lot.id])
}

/**
 * La unidad BASE de un artículo: su `base_unit_id`, o su propia unidad si no
 * tiene una separada.
 *
 * Existe por una razón concreta: el lote cuenta en unidades base, y el coste se
 * paga en las del artículo. Si son la misma, no hay nada que hacer; si no, hay
 * que convertir, y equivocarse ahí es un factor mil.
 */
/**
 * La unidad BASE de la DIMENSIÓN del artículo: el litro, el kilo, la unidad.
 *
 * NO es `items.base_unit_id`. Ese campo es otra cosa: es la unidad en la que se
 * compra y guarda el artículo (el bidón de 20 L), y sirve para recepcionar. El
 * coste, en cambio, se guarda POR UNIDAD BASE DE LA DIMENSIÓN, porque es la
 * única que hace que 1 ml y 1 L se puedan sumar sin inventarse un factor.
 *
 * Confundir las dos era el bug: se guardaba 3,69 €/bidón = 0,1845 €/bidón como
 * si fuera un coste por litro, y la caja salía 1.000 veces más barata de lo que
 * es. Nadie lo ve en un número suelto: 0,03 € parece un precio razonable hasta
 * que lo comparas con la factura.
 */
async function unidadBaseDe(tx, itemId) {
  const base = await tx.one('SELECT fn_unidad_base(unit_id) AS b FROM items WHERE id = $1', [itemId])
  if (!base) throw new ErrorDeStock(`El artículo ${itemId} no existe`, { itemId })
  if (!base.b) {
    throw new ErrorDeStock(
      `La dimensión del artículo ${itemId} no tiene unidad base declarada`,
      { itemId },
    )
  }
  return base.b
}

/**
 * Planifica el consumo por FEFO y devuelve los lotes que se usarían, en orden.
 *
 * NO descuenta nada: solo dice qué se va a tocar y por qué. El operario lo ve
 * antes de confirmar. El descuento real es una llamada a `moverStock` dentro de
 * la transacción de producción.
 */
export async function planificarFefo(itemId, cantidad, unitId = null) {
  //
  // LAS UNIDADES IMPORTAN, Y AQUÍ NO SE MIRABAN.
  //
  // El plan comparaba `qty_available` —en la unidad del LOTE— con `cantidad` —
  // en la unidad de lo que se PIDE—, sin convertirlas. Y el sistema tiene
  // unidades que no son la misma cosa: el concentrado está en el almacén en
  // litros y la receta lo pide en mililitros.
  //
  // Un lote de 20 L se comparaba contra 9.000 ml, y salía que no había nada
  // suficiente. En un almacén real es el fallo más tonto y más caro que hay:
  //la máquina dice que no hay producto que sí hay, o al revés.
  //
  // Ahora cada lote se convierte a la unidad en la que se ha pedido, y el
  // consumo que se registra es en ESA unidad, que es la que se descuenta.
  //
  const candidatos = await query(
    `SELECT * FROM v_fefo_candidates WHERE item_id = $1 AND qty_available > 0
     ORDER BY priority`,
    [itemId],
  )
  const plan = []
  let restante = Number(cantidad)
  for (const c of candidatos) {
    if (restante <= 1e-9) break
    // Lo que hay de ese lote, DICHO en la unidad en la que se ha pedido.
    const disponible = unitId && c.unit_id && unitId !== c.unit_id
      ? (await one(
        `SELECT fn_convertir($1::numeric, $2::int, $3::int) AS v`,
        [c.qty_available, c.unit_id, unitId])).v
      : c.qty_available
    const tomar = Math.min(restante, Number(disponible))
    plan.push({
      lotId: c.lot_id, code: c.code,
      qty: tomar,
      // Y el disponible va también en la unidad pedida, que es la que va a leer
      // quien mira el plan. Si no, un número en litros junto a otro en
      // mililitros parecen dos cantidades de la misma cosa.
      disponible: Number(disponible),
      disponibleEnSuUnidad: Number(c.qty_available),
      unitId: unitId || c.unit_id,
      expiryDate: c.expiry_date, motivo: c.expiry_reason, prioridad: c.priority,
    })
    restante -= tomar
  }
  return { plan, suficiente: restante <= 1e-9, faltante: Math.max(restante, 0), unitId }
}

/** Existencias de un artículo, leídas de la vista que es la definición. */
export async function existenciasDe(itemId) {
  return one('SELECT * FROM v_item_available WHERE item_id = $1', [itemId])
}

/** Suma de movimientos de un lote: la historia completa e inmutable. */
export async function historialDeLote(lotId) {
  return query('SELECT * FROM stock_movements WHERE lot_id = $1 ORDER BY id', [lotId])
}
