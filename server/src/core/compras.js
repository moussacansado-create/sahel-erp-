/**
 * COMPRAS.
 *
 * Una orden de compra es un COMPROMISO con un proveedor: «de aquí al mes que
 * viene, en la fecha que dijimos, quiero esto a este precio». Eso la separa de
 * todo lo demás, y de ahí sale todo el módulo:
 *
 *   · Crear la orden no toca el almacén. Pedir no es tener.
 *   · Enviar la orden la convierte en un compromiso con fecha.
 *   · RECIBIR es lo único que entra en stock, y entra por el MISMO motor que
 *     cualquier otra entrada: lote, movimiento, saldo y auditoría, en una sola
 *     transacción. Compras no tiene un almacén paralelo.
 *
 * ── LA RECEpCIÓN, QUE ES DONDE ESTÁ LA FABRICA ──────────────────────────
 *
 * Cuando llega la mercancía, cada línea recibida produce un LOTE con:
 *
 *   · el código de lote del PROVEEDOR, que es por donde lo llama él;
 *   · su fecha de caducidad;
 *   · su coste unitario, que es el de la orden… salvo que se corrija al
 *     recibir, porque el precio que se acaba pagando no siempre es el que se
 *     pidió, y el almacén tiene que saber lo que se pagó de verdad.
 *
 * El lote queda con `origin_type='PURCHASE'` y `origin_id` = la línea de
 * compra. Eso es lo que permite, dentro de seis meses, responder a «¿de dónde
 * salió este lote y cuánto se pagó por él?» sin reconstruir nada a mano.
 *
 * ── LO QUE ESTE MÓDULO NO TOCA ────────────────────────────────────────────
 *
 * Ni Producción, ni Stock, ni Reparto, ni Clientes, ni los permisos. Llama al
 * motor de entradas que ya existía y le pasa el contexto. Si algún día hace
 * falta tocar algo de ahí, se avisa antes.
 */

import { transaction } from '../db/client.js'
import { siguienteCodigoCompra } from './codigos.js'
import { auditar } from './auditoria.js'
import { registrarEntrada } from './inventario.js'
import { cuentaMonetaria } from './dinero.js'

const REDONDEO = 2

/** Redondea a céntimos. El dinero no acumula decimales de más. */
function dinero(n) {
  return Math.round(Number(n || 0) * 10 ** REDONDEO) / 10 ** REDONDEO
}

function fallo(mensaje, codigo, estado = 400) {
  const e = new Error(mensaje)
  e.codigo = codigo
  e.estado = estado
  return e
}

/** Tasas y moneda de la empresa. Se leen de `app_config`, no se hardcodean. */
async function configuracion(tx) {
  // OJO con el corchete: `ANY($1)` espera UN parámetro que sea el ARRAY entero,
  // así que va `[[...]]`. Pasando la lista suelta, PostgreSQL ve tres
  // parámetros ($1, $2, $3) para un sitio que solo admite uno, y contesta
  // «bind message supplies 3 parameters, but prepared statement requires 1».
  // Un error que parece de magia y es un corchete de más.
  const claves = ['empresa.moneda', 'empresa.simbolo', 'empresa.iva']
  const filas = await tx.query(
    `SELECT key, value FROM app_config WHERE key = ANY($1)`, [claves])
  const mapa = Object.fromEntries(filas.map((f) => [f.key, f.value]))
  return {
    moneda: mapa['empresa.moneda'] || 'XOF',
    simbolo: mapa['empresa.simbolo'] || 'FCFA',
    iva: Number(mapa['empresa.iva'] ?? 0.21),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ALTA DE LA ORDEN
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Crea una orden en BORRADOR con sus líneas.
 *
 * No toca el almacén, no crea lotes y no cuesta dinero: es una intención. Lo
 * que cuesta es cuando se envía al proveedor, que es cuando se puede receiving
 * algo.
 */
export async function crearOrden(datos, txExistente = null) {
  const correr = (fn) => (txExistente ? fn(txExistente) : transaction(fn))
  return correr(async (tx) => {
    const { supplierId, lineas = [], expectedDate = null, notes = null, userId = null } = datos
    if (!supplierId) throw fallo('La orden necesita un proveedor', 'PROVEEDOR_FALTANTE')
    if (!Array.isArray(lineas) || !lineas.length) {
      throw fallo('Una orden sin líneas no es una orden', 'ORDEN_SIN_LINEAS')
    }
    if (lineas.length > 200) throw fallo('Máximo 200 líneas por orden', 'DEMASIADAS_LINEAS')

    const prov = await tx.one(
      `SELECT id, code, name, is_active FROM suppliers WHERE id = $1`, [supplierId])
    if (!prov) throw fallo('Ese proveedor no existe', 'PROVEEDOR_NO_ENCONTRADO', 404)
    if (!prov.is_active) {
      throw fallo(`El proveedor ${prov.name} está archivado`, 'PROVEEDOR_ARCHIVADO', 409)
    }

    const cfg = await configuracion(tx)
    // La tasa de la orden es la de la EMPRESA en este momento. Si un proveedor
    // factura a otro tipo, la tasa va en la línea, no aquí: aquí va la que se
    // aplica por defecto a todo lo que no venga especificado.
    const lineasOk = []
    // Las dos cuentas van en enteros de diezmilésimas: no redondean hasta el
    // final, y el final es cuando el documento se presenta.
    const cuentaSubtotal = cuentaMonetaria(cfg.moneda)
    const cuentaImpuesto = cuentaMonetaria(cfg.moneda)
    for (const [i, l] of lineas.entries()) {
      const item = await tx.one(
        `SELECT i.id, i.sku, i.name, i.unit_id, i.category_kind, i.purchase_cost, i.is_active,
                u.code AS unit_code
           FROM items i JOIN units u ON u.id = i.unit_id
          WHERE i.id = $1`, [l.itemId])
      if (!item) {
        throw fallo(`La línea ${i + 1}: el artículo ${l.itemId} no existe`, 'ARTICULO_NO_ENCONTRADO')
      }
      if (!item.is_active) {
        throw fallo(`La línea ${i + 1}: «${item.name}» está archivado`, 'ARTICULO_ARCHIVADO')
      }
      const qty = Number(l.qtyOrdered ?? l.qty_ordered)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw fallo(`La línea ${i + 1}: la cantidad debe ser mayor que cero`, 'CANTIDAD_INVALIDA')
      }
      // El precio se puede dejar vacío: se usa el último coste conocido del
      // artículo. Comprar lo de siempre no debería obligar a teclear el precio.
      const unitCost = l.unitCost != null ? Number(l.unitCost) : Number(item.purchase_cost || 0)
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw fallo(`La línea ${i + 1}: el precio no puede ser negativo`, 'PRECIO_INVALIDO')
      }
      //
      // SIN REDONDEAR. NADA DE ESTO SE REDONDEA.
      //
      // Aquí se acumulaba `dinero(qty * unitCost)` por línea, luego
      // `dinero(subtotal + base)`, luego `dinero(impuesto + base * iva)`: tres
      // redondeos por línea, y el subtotal redondeado otra vez al acumular. Con dos
      // decimales, una línea de 0,005 se perdía; repetido 1 000 veces, medio
      // euro que nadie ve en ninguna factura.
      //
      // Ahora la cuenta va en enteros de diezmilésimas (ver `core/dinero.js`) y
      // sale exacta. El redondeo, si lo hay, es al presentar el documento, una
      // sola vez, y se anota en vez de evaporarse.
      //
      const base = qty * unitCost
      cuentaSubtotal.suma(base)
      // El IVA es POR LÍNEA, no sobre el subtotal entero. Cada línea lleva su
      // propio tipo, y aplicarlo al acumulado cobraría el impuesto una vez
      // sobre todo y otra sobre cada línea, que es justo el error clásico.
      cuentaImpuesto.suma(base * cfg.iva)
      lineasOk.push({
        itemId: item.id,
        unitId: l.unitId ?? item.unit_id,
        qtyOrdered: qty,
        unitCost,
        supplierLotCode: l.supplierLotCode || null,
        expiryDate: l.expiryDate || null,
        notes: l.notes || null,
        _sku: item.sku, _nombre: item.name, _unidad: item.unit_code,
      })
    }

    const code = await siguienteCodigoCompra(tx)
    const orden = await tx.one(
      `INSERT INTO purchase_orders
         (code, supplier_id, status, order_date, expected_date, currency_code,
          subtotal, tax_amount, total, notes, created_by)
       VALUES ($1,$2,'DRAFT',CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [code, supplierId, expectedDate, cfg.moneda,
        // `.guardar()` es el ÚLTIMO paso: baja a los cuatro decimales que caben
        // en la columna, y solo ahí. Antes, aquí dentro, se va con ocho.
        //
        // El total se monta sobre las cifras de TRABAJO de los otros dos, no
        // sobre las que ya bajaron a cuatro: si no, el total sería la suma de
        // dos números ya redondeados, que es justo el error que se ha venido
        // corrigiendo.
        cuentaSubtotal.guardar(), cuentaImpuesto.guardar(),
        cuentaMonetaria(cfg.moneda).suma(cuentaSubtotal.exacto())
          .suma(cuentaImpuesto.exacto()).guardar(),
        notes, userId])

    for (const l of lineasOk) {
      await tx.query(
        `INSERT INTO purchase_lines
           (purchase_order_id, item_id, qty_ordered, unit_id, unit_cost,
            supplier_lot_code, expiry_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orden.id, l.itemId, l.qtyOrdered, l.unitId, l.unitCost,
          l.supplierLotCode, l.expiryDate, l.notes])
    }

    await auditar(tx, {
      usuarioId: userId,
      accion: 'CREATE',
      entidad: 'purchase_orders',
      entidadId: orden.id,
      despues: { code, supplier: prov.code, lineas: lineasOk.length, total: orden.total },
    })

    return obtenerOrden(tx, orden.id)
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// LECTURA
// ═════════════════════════════════════════════════════════════════════════════

/** La lista de trabajo: primero lo que está en curso, luego lo reciente. */
export async function listarOrdenes({ status = null, supplierId = null, limite = 200 } = {}, tx) {
  const cond = []
  const p = []
  if (status) { p.push(status); cond.push(`o.status = $${p.length}`) }
  if (supplierId) { p.push(supplierId); cond.push(`o.supplier_id = $${p.length}`) }
  p.push(limite)
  return tx.query(
    `SELECT o.id, o.code, o.status, o.order_date, o.expected_date, o.currency_code,
            o.subtotal, o.tax_amount, o.total, o.received_at,
            s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
            u.full_name AS creada_por,
            (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_order_id = o.id) AS lineas,
            (SELECT COUNT(*) FROM purchase_lines l
              WHERE l.purchase_order_id = o.id AND l.qty_received >= l.qty_ordered) AS lines_completas,
            (SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_lines l
              WHERE l.purchase_order_id = o.id) AS uds_recibidas,
            (SELECT COALESCE(SUM(l.qty_ordered), 0) FROM purchase_lines l
              WHERE l.purchase_order_id = o.id) AS uds_pedidas
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN users u ON u.id = o.created_by
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY o.order_date DESC, o.id DESC
      LIMIT $${p.length}`,
    p,
  )
}

/** Una orden con sus líneas y de dónde salió cada trozo ya recibido. */
export async function obtenerOrden(tx, id) {
  const orden = await tx.one(
    `SELECT o.*, s.code AS supplier_code, s.name AS supplier_name, s.phone AS supplier_phone,
            s.email AS supplier_email,
            u.full_name AS creada_por
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN users u ON u.id = o.created_by
      WHERE o.id = $1`, [id])
  if (!orden) throw fallo('Esa orden no existe', 'ORDEN_NO_ENCONTRADA', 404)

  const lineas = await tx.query(
    `SELECT l.*, i.sku, i.name AS item_name, i.category_kind, u.code AS unit_code,
            (l.qty_ordered - l.qty_received) AS qty_pending
       FROM purchase_lines l
       JOIN items i ON i.id = l.item_id
       JOIN units u ON u.id = l.unit_id
      WHERE l.purchase_order_id = $1
      ORDER BY l.id`, [id])

  // De dónde salió cada mercancia ya recibida. Sin esto, «este lote se pagó a
  // 450» es una OPINION, porque el lote no guarda a qué línea de compra vino.
  const recepciones = await tx.query(
    `SELECT l.id AS linea_id, lo.id AS lote_id, lo.code AS lote_codigo,
            lo.supplier_lot_code, lo.unit_cost AS coste_real,
            m.qty AS cantidad, m.occurred_at, m.movement_type, lo.invoice_ref
       FROM lots lo
       JOIN stock_movements m ON m.lot_id = lo.id
       -- origin_id esta en el LOTE y apunta a la LINEA de compra. El alias l
       -- es de purchase_lines y no tiene esa columna: leerlo de ahi confunde
       -- la linea con el lote y da un error que no senala el origen.
       JOIN purchase_lines l ON l.id = lo.origin_id
      WHERE lo.origin_type = 'PURCHASE'
        AND l.purchase_order_id = $1
        AND m.movement_type = 'PURCHASE_RECEPTION'
      ORDER BY m.occurred_at`, [id])

  return {
    ...orden,
    lineas,
    recepciones,
    uds_pedidas: lineas.reduce((t, l) => t + Number(l.qty_ordered), 0),
    uds_recibidas: lineas.reduce((t, l) => t + Number(l.qty_received), 0),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EL CICLO DE VIDA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * BORRADOR → PEDIDA.
 *
 * Es el momento en que la orden deja de ser una intención y pasa a ser un
 * compromiso con el proveedor, con fecha. Hasta aquí no compromete a nadie.
 */
export async function enviarOrden(id, { userId = null, expectedDate = null } = {}) {
  return transaction(async (tx) => {
    const o = await tx.one(
      `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [id])
    if (!o) throw fallo('Esa orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
    if (o.status !== 'DRAFT') {
      throw fallo(
        `La orden ${o.code} ya está enviada (${o.status}). Solo se envía una vez.`,
        'ORDEN_NO_ENVIABLE', 409)
    }
    const lineas = await tx.query(
      `SELECT COUNT(*) n FROM purchase_lines WHERE purchase_order_id = $1`, [id])
    if (Number(lineas[0].n) === 0) {
      throw fallo('Una orden sin líneas no se envía', 'ORDEN_SIN_LINEAS', 409)
    }

    const fecha = expectedDate || o.expected_date
    const f = await tx.one(
      `UPDATE purchase_orders
          SET status='ORDERED', expected_date=$2, updated_at=now()
        WHERE id=$1 RETURNING *`, [id, fecha])

    await auditar(tx, {
      usuarioId: userId, accion: 'SEND', entidad: 'purchase_orders', entidadId: id,
      antes: { status: o.status }, despues: { status: 'ORDERED', fecha },
    })
    return obtenerOrden(tx, id)
  })
}

/**
 * RECIBIR MERCANCÍA. Y aquí entra en el almacén.
 *
 * Cada línea recibida genera un LOTE a través del motor de entradas que ya
 * existía —el mismo que usa el ajuste manual y la apertura—, con el proveedor,
 * su código de lote, su caducidad y su coste real.
 *
 * TODO EN UNA TRANSACCIÓN. Si la línea 3 de 5 falla porque el artículo no
 * existe, no queda el lote de la 1 ni el de la 2: o entra la mercancía entera, o
 * no entra ninguna. Un almacén a medias es peor que un almacén intacto, porque
 * no sabes qué es lo que tienes.
 *
 * Se puede recibir en varias veces —un proveedor que entrega a medias es lo
 * normal— y la orden se queda en `PARTIALLY_RECEIVED` hasta que esté completa.
 *
 * @param {object} p
 * @param {number} p.id             orden
 * @param {Array}  p.lineas         [{ lineId, qty, supplierLotCode, expiryDate,
 *                                    lotCode?, unitCost? }]
 * @param {string} [p.invoiceRef]   número de factura del proveedor
 * @param {string} [p.token]        llave de idempotencia del proveedor. Si se
 *                                   repite la misma petición, no entra dos veces.
 */
export async function recibirOrden(id, {
  lineas = [], invoiceRef = null, notes = null, userId = null, token = null,
} = {}) {
  if (!Array.isArray(lineas) || !lineas.length) {
    throw fallo('No se ha indicado qué mercancía llega', 'RECEPCION_SIN_LINEAS')
  }

  return transaction(async (tx) => {
    // El bloqueo va PRIMERO. Dos personas_receiveiendo a la vez el mismo
    // proveedor han de verse en serie, no en paralelo: sin esto, las dos leen
    // `qty_received` antes de que ninguna escriba, y la mercancía se duplica.
    const orden = await tx.one(
      `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [id])
    if (!orden) throw fallo('Esa orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
    if (orden.status === 'DRAFT') {
      throw fallo(
        `La orden ${orden.code} está en borrador. Envíala al proveedor antes de `
        + 'recibir nada: pedir no es tener.', 'ORDEN_NO_ENVIADA', 409)
    }
    if (orden.status === 'RECEIVED' || orden.status === 'CLOSED') {
      throw fallo(
        `La orden ${orden.code} ya está recibida`, 'ORDEN_YA_RECIBIDA', 409)
    }

    const cfg = await configuracion(tx)
    const creadas = []

    for (const [i, l] of lineas.entries()) {
      const linea = await tx.one(
        `SELECT l.*, i.name AS item_name, i.sku, i.is_active, i.category_kind
           FROM purchase_lines l JOIN items i ON i.id = l.item_id
          WHERE l.id = $1 AND l.purchase_order_id = $2`,
        [l.lineId, id])
      if (!linea) {
        throw fallo(
          `La línea ${i + 1} no pertenece a la orden ${orden.code}`, 'LINEA_NO_EN_MI_ORDEN')
      }

      const qty = Number(l.qty)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw fallo(`La línea ${i + 1}: la cantidad debe ser mayor que cero`, 'CANTIDAD_INVALIDA')
      }
      const pendiente = Number(linea.qty_ordered) - Number(linea.qty_received)
      if (qty - pendiente > 1e-9) {
        // Tolerar un poco de más es normal —el proveedor manda 51 de 50—,
        // pero la diferencia se avisa en vez de aceptarse en silencio.
        throw fallo(
          `La línea ${i + 1} (${linea.item_name}): se piden ${pendiente} y_has recibido ${qty}. `
          + 'No se puede recibir más de lo pedido.', 'SOBRA_MERCANCIA')
      }

      // El coste real puede diferir del pedido. El almacén tiene que saber lo
      // que se PAGÓ, no lo que se pidió.
      const coste = l.unitCost != null ? Number(l.unitCost) : Number(linea.unit_cost)
      if (!Number.isFinite(coste) || coste < 0) {
        throw fallo(`La línea ${i + 1}: el coste no puede ser negativo`, 'COSTE_INVALIDO')
      }

      // ── AQUÍ ENTRA LA MERCANCÍA EN EL ALMACÉN ──────────────────────────
      // Se llama al motor que ya existía. Compras no reimplementa el stock: si
      // mañana el motor cambia, cambia para todos y no para dos sitios.
      const r = await registrarEntrada({
        itemId: linea.item_id,
        cantidad: qty,
        codigoLote: l.lotCode || null,
        caducidad: l.expiryDate ?? linea.expiry_date ?? null,
        proveedorId: orden.supplier_id,
        loteProveedor: l.supplierLotCode ?? linea.supplier_lot_code ?? null,
        numeroAlbaran: invoiceRef,
        costeUnitario: coste,
        origen: 'PURCHASE',
        // El lote apunta a la LÍNEA de compra. Ahí está la respuesta a
        // «¿de dónde salió esto y cuánto se pagó?».
        origenId: linea.id,
        notas: notes || null,
        usuarioId: userId,
      }, tx)

      // ── Y el movimiento, a esta recepción ────────────────────────────────
      // La llave usa el token del proveedor si lo manda, y si no, un contador
      // de esta misma orden. Con eso, un doble toque en «Recibir» —que en un
      // móvil pasa— no duplica la mercancía.
      const llave = token
        ? `PURCHASE:${id}:${token}:${linea.id}`
        : `PURCHASE:${id}:${linea.id}:${await siguienteRecibo(tx, linea.id)}`
      const movimiento = await tx.one(
        `SELECT id FROM stock_movements
          WHERE lot_id = $1 AND movement_type = 'PURCHASE_RECEPTION'
          ORDER BY id DESC LIMIT 1`, [r.lote.id])
      if (movimiento) {
        await tx.query(
          `INSERT INTO stock_movement_keys (key, movement_id) VALUES ($1,$2)
           ON CONFLICT (key) DO NOTHING`, [llave, movimiento.id])
      }

      const f = await tx.one(
        `UPDATE purchase_lines
            SET qty_received = qty_received + $2
          WHERE id = $1 RETURNING *`, [linea.id, qty])

      creadas.push({
        linea_id: linea.id,
        item: linea.item_name,
        sku: linea.sku,
        qty,
        lote_id: r.lote.id,
        lote_codigo: r.lote.code,
        lote_proveedor: l.supplierLotCode ?? linea.supplier_lot_code ?? null,
        caducidad: l.expiryDate ?? linea.expiry_date ?? null,
        coste_unitario: coste,
        linea: f,
      })
    }

    // ── El estado sale de las líneas, no de lo que se haya pedido ──────────
    const resumen = await tx.one(
      `SELECT COUNT(*) FILTER (WHERE qty_received <= 0) AS sin_tocar,
              COUNT(*) FILTER (WHERE qty_received >= qty_ordered) AS completas,
              COUNT(*) AS total
         FROM purchase_lines WHERE purchase_order_id = $1`, [id])

    const nuevo = Number(resumen.completas) === Number(resumen.total)
      ? 'RECEIVED'
      : (Number(resumen.sin_tocar) === Number(resumen.total) ? 'ORDERED' : 'PARTIALLY_RECEIVED')

    const f = await tx.one(
      `UPDATE purchase_orders
          SET status = $2,
              received_at = CASE WHEN $2 = 'RECEIVED' THEN COALESCE(received_at, now())
                                 ELSE received_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`, [id, nuevo])

    await auditar(tx, {
      usuarioId: userId,
      accion: 'RECEIVE',
      entidad: 'purchase_orders',
      entidadId: id,
      antes: { status: orden.status },
      despues: {
        status: nuevo,
        factura: invoiceRef,
        lineas: creadas.map((c) => ({
          linea: c.linea_id, sku: c.sku, qty: c.qty,
          lote: c.lote_codigo, coste: c.coste_unitario,
        })),
      },
    })

    return { ...(await obtenerOrden(tx, id)), receivable: creadas, moneda: cfg.moneda, simbolo: cfg.simbolo }
  })
}

/** Cuántas recepciones ha tenido ya una línea. Se usa para las llaves. */
async function siguienteRecibo(tx, lineaId) {
  const n = await tx.one(
    `SELECT COUNT(*) AS n FROM lots WHERE origin_type = 'PURCHASE' AND origin_id = $1`,
    [lineaId])
  return Number(n.n) + 1
}

/**
 * ANULAR. Solo si no ha entrado nada.
 *
 * Una orden con mercancía recibida dentro no se anula: se corrige. Anularla
 * dejaría lotes en el almacén que nadie sabe de dónde salieron, y la
 * trazabilidad —que es lo que justifica este sistema— se rompería aquí.
 */
export async function anularOrden(id, { motivo, userId = null } = {}) {
  if (!motivo || String(motivo).trim().length < 3) {
    throw fallo('Anular una orden necesita un motivo', 'FALTA_MOTIVO')
  }
  return transaction(async (tx) => {
    const o = await tx.one(
      `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [id])
    if (!o) throw fallo('Esa orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
    if (o.status === 'RECEIVED' || o.status === 'CLOSED') {
      throw fallo(
        `La orden ${o.code} ya tiene mercancía recibida dentro. Anularla dejaría `
        + 'lotes sin origen. Corrige la entrada en el almacén en su lugar.',
        'ORDEN_CON_MERCANCIA', 409)
    }
    const touched = await tx.one(
      `SELECT COALESCE(SUM(qty_received),0) AS s FROM purchase_lines WHERE purchase_order_id = $1`,
      [id])
    if (Number(touched.s) > 0) {
      throw fallo(
        `La orden ${o.code} ya tiene mercancía recibida dentro. Anularla dejaría `
        + 'lotes sin origen. Corrige la entrada en el almacén en su lugar.',
        'ORDEN_CON_MERCANCIA', 409)
    }
    if (o.status === 'CANCELLED') {
      throw fallo('Esta orden ya está anulada', 'ORDEN_YA_ANULADA', 409)
    }

    await tx.query(
      `UPDATE purchase_orders
          SET status='CANCELLED', notes = COALESCE(notes || E'\\n', '') || $2, updated_at=now()
        WHERE id=$1`, [id, `Anulada: ${String(motivo).trim()}`])

    await auditar(tx, {
      usuarioId: userId, accion: 'CANCEL', entidad: 'purchase_orders', entidadId: id,
      antes: { status: o.status }, despues: { status: 'CANCELLED', motivo },
    })
    return obtenerOrden(tx, id)
  })
}

/** Los números de arriba de la pantalla, sin traer todas las órdenes. */
export async function resumenCompras(tx) {
  const f = await tx.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS importe
       FROM purchase_orders WHERE status <> 'CANCELLED' GROUP BY status`)
  const porEstado = Object.fromEntries(f.map((x) => [x.status, Number(x.n)]))
  const enCurso = (porEstado.DRAFT || 0) + (porEstado.ORDERED || 0)
    + (porEstado.PARTIALLY_RECEIVED || 0)
  return {
    total: f.reduce((t, x) => t + Number(x.n), 0),
    en_curso: enCurso,
    en_borrador: porEstado.DRAFT || 0,
    pedidas: porEstado.ORDERED || 0,
    a_medias: porEstado.PARTIALLY_RECEIVED || 0,
    recibidas: porEstado.RECEIVED || 0,
    cerradas: porEstado.CLOSED || 0,
    importe_pendiente: dinero(f
      .filter((x) => !['RECEIVED', 'CLOSED'].includes(x.status))
      .reduce((t, x) => t + Number(x.importe), 0)),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LA FICHA DEL PROVEEDOR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Todo lo que se sabe de un proveedor, en una sola lectura.
 *
 * Esto no duplica nada: se apoya en las órdenes, las líneas y los lotes que ya
 * existen, y los cuenta. El maestro del proveedor vive en el catálogo; esta es
 * la VISTA de COMPRAS de ese proveedor, que es información distinta —qué nos
 * ha traído, cuánto, a qué precio y con qué caducidades—.
 *
 * Las seis cosas que se contestan aquí, y que antes había que buscar a mano:
 *
 *   1. Cuánto se le ha comprado, y en cuántas órdenes.
 *   2. Cuántas siguen abiertas, y qué se espera de cada una.
 *   3. Qué factura hay detrás de cada recepción.
 *   4. Qué lotes nos ha traído, con su caducidad.
 *   5. A qué precio nos cobra, y si ha subido respecto a lo pedido.
 *   6. En qué condiciones paga, y desde cuándo es proveedor nuestro.
 */
export async function fichaProveedor(id, tx) {
  const p = await tx.one(
    `SELECT s.*, z.name AS zone_name, u.full_name AS creado_por
       FROM suppliers s
       LEFT JOIN zones z ON z.id = s.zone_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1`, [id])
  if (!p) throw fallo('Ese proveedor no existe', 'PROVEEDOR_NO_ENCONTRADO', 404)

  // ── Las órdenes ────────────────────────────────────────────────────────────
  const ordenes = await tx.query(
    `SELECT o.id, o.code, o.status, o.order_date, o.expected_date, o.received_at,
            o.currency_code, o.subtotal, o.tax_amount, o.total,
            (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_order_id = o.id) AS lineas,
            (SELECT COALESCE(SUM(l.qty_ordered), 0)  FROM purchase_lines l
              WHERE l.purchase_order_id = o.id) AS uds_pedidas,
            (SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_lines l
              WHERE l.purchase_order_id = o.id) AS uds_recibidas
       FROM purchase_orders o
      WHERE o.supplier_id = $1 AND o.status <> 'CANCELLED'
      ORDER BY o.order_date DESC, o.id DESC
      LIMIT 100`, [id])

  // ── Las recepciones, con su factura y su lote ──────────────────────────────
  const recepciones = await tx.query(
    `SELECT m.id AS movimiento_id, m.qty AS cantidad, m.occurred_at, lo.invoice_ref,
            lo.id AS lote_id, lo.code AS lote_codigo, lo.supplier_lot_code,
            lo.expiry_date, lo.unit_cost AS coste,
            i.id AS item_id, i.sku, i.name AS item_name,
            l.id AS linea_id, o.id AS orden_id, o.code AS orden_code
       FROM lots lo
       JOIN stock_movements m
         ON m.lot_id = lo.id AND m.movement_type = 'PURCHASE_RECEPTION'
       JOIN purchase_lines l ON l.id = lo.origin_id
       JOIN purchase_orders o ON o.id = l.purchase_order_id
       JOIN items i ON i.id = lo.item_id
      WHERE lo.supplier_id = $1
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT 300`, [id])

  // ── Qué factura corresponde a cada orden ───────────────────────────────────
  // El número de factura vive en el movimiento, no en la orden: una orden puede
  // recibirse en tres visitas con tres facturas distintas, o una factura puede
  // cubrir una visita con varias líneas.
  const facturas = [...new Set(
    recepciones.map((r) => r.invoice_ref).filter(Boolean),
  )].sort()

  // ── El precio: lo pedido contra lo pagado ─────────────────────────────────
  // La desviación es el dato que de verdad interesa: un proveedor que sube un
  // 8 % cada tres meses avisa antes de que la compra salga cara.
  //
  // OJO CON LAS DOS SUMAS: tienen que caer sobre LAS MISMAS FILAS.
  //
  // La versión anterior sumaba `l.unit_cost` de TODAS las líneas del proveedor,
  //incluidas las que nunca llegaron, y lo pagaba contra `lo.unit_cost` solo de
  // las recibidas. Denominador y numerador medían|populationes distintas y salía
  // una desviación del 15 550 %: un número tan absurdo que, de no estar en
  // rojo, habría pasado por un dato real.
  //
  // Ahora se parte del LOTE, que es lo que se recibió, y de ahí sale la línea
  // y su precio. Las dos sumas miran exactamente las mismas recepciones.
  const desviacion = await tx.one(
    `SELECT COUNT(DISTINCT lo.origin_id) AS lineas,
            COALESCE(SUM(l.unit_cost * m.qty), 0) AS coste_pedido,
            COALESCE(SUM(lo.unit_cost * m.qty), 0) AS coste_pagado
       FROM lots lo
       JOIN purchase_lines l ON l.id = lo.origin_id
       JOIN purchase_orders o ON o.id = l.purchase_order_id
       JOIN stock_movements m
         ON m.lot_id = lo.id AND m.movement_type = 'PURCHASE_RECEPTION'
      WHERE o.supplier_id = $1 AND m.qty > 0`, [id])

  //
  // Lo que aún NO ha llegado, valued AL PRECIO QUE SE PIDIÓ.
  //
  // No se saca de restar al total de la orden, que es un error tempting: el
  // total lleva IVA y `coste_pagado` no, así que la diferencia salía con un 21 %
  // de mysteriously de más. Un pedido de 125 000 pendiente daba 26 250 de
  // «pendiente» y 125 000 de «comprado»: 151 250, que era el total con IVA, y
  // además repartido entre dos columnas que dicen cosas distintas.
  //
  // Se mide sobre las LÍNEAS, y en la MISMA base que lo recibido: lo que se
  // pidió y no ha llegado, a su coste. Comprado + pendiente = el valor de la
  // mercancía pedida, sin IVA, y sin que falte ni sobre nada.
  //
  const pendiente = await tx.one(
    `SELECT COALESCE(SUM((l.qty_ordered - l.qty_received) * l.unit_cost), 0) AS lineas
       FROM purchase_lines l
       JOIN purchase_orders o ON o.id = l.purchase_order_id
      WHERE o.supplier_id = $1 AND o.status <> 'CANCELLED'
        AND l.qty_received < l.qty_ordered`, [id])

  // ── Los números de arriba ──────────────────────────────────────────────────
  const abiertas = ordenes.filter((o) =>
    ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status))
  // La columna de la consulta se llama `cantidad`, no `qty`.
  const udsRecibidas = recepciones.reduce((t, r) => t + Number(r.cantidad || 0), 0)
  const udsPendientes = ordenes.reduce(
    (t, o) => t + Math.max(0, Number(o.uds_pedidas) - Number(o.uds_recibidas)), 0)

  return {
    ...p,
    // ── Los titulares ───────────────────────────────────────────────────────
    totales: {
      ordenes: ordenes.length,
      abiertas: abiertas.length,
      anuladas: (await tx.one(
        `SELECT COUNT(*) AS n FROM purchase_orders
          WHERE supplier_id = $1 AND status = 'CANCELLED'`, [id])).n,
      recepciones: recepciones.length,
      facturas: facturas.length,
      lotes: new Set(recepciones.map((r) => r.lote_id)).size,
      uds_recibidas: udsRecibidas,
      uds_pendientes: udsPendientes,
      //
      // «Comprado» es lo que REALMENTE ha entrado, al precio que se pagó —no lo
      // que dicen los pedidos— y «Pendiente» lo que aún puede llegar.
      //
      // Antes solo contaba las órdenes RECEIVED y las PARTIALLY_RECEIVED
      // contaba cero, de modo que un proveedor al que le acabas de recibir la
      // mitad de un pedido aparecía con «Comprado 0» having already paid.
      //
      // Los dos números salen de las recepciones, que son el hecho. «Comprado»
      // es exacto. «Pendiente» es la diferencia hasta el total de los pedidos,
      // así que si el proveedor cobró de más en una línea, el pendiente refleja
      // esa diferencia: es deliberado, para que el saldo cuadre y el desvío se
      // vea en la cuenta del proveedor y no escondido.
      //
      importe_comprado: dinero(desviacion.coste_pagado),
      importe_pendiente: dinero(pendiente.lineas),
      importe_abierto: dinero(abiertas.reduce((t, o) => t + Number(o.total), 0)),
    },
    // ── El precio, pedido contra pagado ────────────────────────────────────
    precios: {
      lineas_recibidas: Number(desviacion.lineas || 0),
      coste_pedido: dinero(desviacion.coste_pedido),
      coste_pagado: dinero(desviacion.coste_pagado),
      // Positivo = el proveedor cobró MÁS de lo pedido. Es la alerta que
      // importa; el signo al revés sería un discount y no avisa de nada.
      desviacion_pct: Number(desviacion.coste_pedido) > 0
        ? dinero(((Number(desviacion.coste_pagado) - Number(desviacion.coste_pedido))
            / Number(desviacion.coste_pedido)) * 100)
        : 0,
    },
    // ── Y el detalle ───────────────────────────────────────────────────────
    ordenes,
    recepciones,
    facturas,
  }
}

/** El listado, con los números de cada uno. Lo que enseña la pantalla. */
export async function listarProveedores({ soloActivos = true } = {}, tx) {
  return tx.query(
    `SELECT s.id, s.code, s.name, s.contact_name, s.phone, s.email, s.country,
            s.payment_terms_days, s.is_active, s.tax_id, s.address,
            z.name AS zone_name,
            (SELECT COUNT(*) FROM purchase_orders o
              WHERE o.supplier_id = s.id AND o.status <> 'CANCELLED') AS ordenes,
            (SELECT COUNT(*) FROM purchase_orders o
              WHERE o.supplier_id = s.id
                AND o.status IN ('DRAFT','ORDERED','PARTIALLY_RECEIVED')) AS abiertas,
            -- «Comprado» es lo que ha ENTRADO, valued at what was PAID for it.
            (SELECT COALESCE(SUM(lo.unit_cost * m.qty), 0)
               FROM lots lo
               JOIN purchase_lines l ON l.id = lo.origin_id
               JOIN purchase_orders o ON o.id = l.purchase_order_id
               JOIN stock_movements m
                 ON m.lot_id = lo.id AND m.movement_type = 'PURCHASE_RECEPTION'
              WHERE o.supplier_id = s.id) AS importe_comprado,
            -- Y «pendiente» es lo que aún no ha llegado: el total pedido menos
            -- lo recibido. Los dos son disjuntos y juntos dan la cuenta completa.
            (SELECT GREATEST(0, COALESCE((
                 SELECT SUM(o.total) FROM purchase_orders o
                  WHERE o.supplier_id = s.id AND o.status <> 'CANCELLED'), 0)
               - COALESCE((
                 SELECT SUM(lo.unit_cost * m.qty)
                   FROM lots lo
                   JOIN purchase_lines l ON l.id = lo.origin_id
                   JOIN purchase_orders o ON o.id = l.purchase_order_id
                   JOIN stock_movements m
                     ON m.lot_id = lo.id AND m.movement_type = 'PURCHASE_RECEPTION'
                  WHERE o.supplier_id = s.id), 0)))
              AS importe_pendiente,
            -- La desviación de PRECIO, no de unidades.
            --
            -- Aquí estaba SUM(l.qty_received - l.qty_ordered), que es una
            -- diferencia de CANTIDADES —cero si todo llegó bien, y un número
            -- sin unidades si no llegó— y la pantalla la pintaba como un
            -- porcentaje. De ahí el «-100 %» de un proveedor al que se le había
            -- recibido justo lo pedido: 0 unidades de diferencia, un -100 % de
            -- precio. Dos medidas distintas con el mismo nombre.
            (SELECT CASE
                      WHEN COALESCE(SUM(l.unit_cost * m.qty), 0) > 0
                      THEN ROUND(100.0 * (SUM(lo.unit_cost * m.qty) - SUM(l.unit_cost * m.qty))
                                  / SUM(l.unit_cost * m.qty), 2)
                      ELSE 0 END
               FROM lots lo
               JOIN purchase_lines l ON l.id = lo.origin_id
               JOIN purchase_orders o ON o.id = l.purchase_order_id
               JOIN stock_movements m
                 ON m.lot_id = lo.id AND m.movement_type = 'PURCHASE_RECEPTION'
              WHERE o.supplier_id = s.id) AS desviacion_pct
       FROM suppliers s
       LEFT JOIN zones z ON z.id = s.zone_id
      ${soloActivos ? 'WHERE s.is_active' : ''}
      ORDER BY lower(s.name)`)
}
