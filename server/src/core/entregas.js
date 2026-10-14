import crypto from 'node:crypto'
import { transaction, one } from '../db/client.js'
import { siguienteCodigoEntrega } from './codigos.js'
import { auditar } from './auditoria.js'
import { moverStock } from './stock.js'

/**
 * Entregas.
 *
 * ── Aquí, y solo aquí, el stock baja ───────────────────────────────────────
 *
 * En las tres fases anteriores ya estaba montado el mecanismo completo de
 * apartar y liberar, pero nada lo había ejecutado nunca. Este es el primer
 * punto del sistema donde `lots.qty_available` disminuye por una venta.
 *
 * Las tres reglas que rigen este fichero:
 *
 *   1. SOLO SE DESCUENTA LO ENTREGADO. Un pedido de 100 del que se serves 40
 *      descuenta 40. Los 60 restantes siguen apartados para la próxima visita.
 *
 *   2. UNA SOLA VEZ. `stock_movement_keys` es un índice único sobre
 *      (entrega, lote). Si la misma entrega volviera a pasar por aquí, la base
 *      rechazaría el segundo movimiento aunque el código no se hubiera
 *      dado cuenta.
 *
 *   3. NUNCA MÁS DE LO APARTADO. El disparador `fn_reserva_no_sobre_entrega`
 *      impide que una reserva se sirva por encima de su propia cantidad, así
 *      que tampoco se puede inventar una entrega por encima del pedido.
 *
 * La reserva no se parte en dos filas: se le sube `qty_consumed`. Así una
 * línea de 100 que se sirve en dos entregas de 40 y 60 deja una sola reserva
 * con `qty=100, qty_consumed=100, status=CONSUMED`, y el histórico dice
 * exactamente qué pasó sin depender de recomputar nada.
 */

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const hashFirma = (b) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * Registra una entrega. Puede ser parcial o completa.
 *
 * @param {object} p
 * @param {number} p.orderId        pedido
 * @param {Array}  p.lineas         [{ orderLineId, qty, lotId? }]
 * @param {number} p.userId         quién confirma la entrega
 * @param {number} [p.repId]        repartidor
 * @param {string} [p.via]          'TARJETA_QR' (lo normal) | 'ALBARAN' | 'MANUAL'
 * @param {number} [p.albaranId]    albarán que acompaña el viaje, si se imprimió
 * @param {Buffer} [p.firma]        imagen de la firma, si la hay
 *
 * QUÉ PRUEBA QUE QUEDA UNA ENTREGA
 *
 * Antes exigía una IMAGEN de la firma. Ahora exige saber QUIÉN confirmó y
 * CUÁNDO. La firma en papel no está en el sistema —está con el cliente— y
 * atar el reparto a una imagen obligaba al repartidor a abrir el pedido en el
 * móvil delante de la puerta para subir un dibujo.
 *
 * Lo que se guarda ahora es la persona, que es lo que de verdad se pregunta
 * cuando un cliente dice que no recibió nada. Si algún día hay una imagen
 * (porque se fotografíe el papel firmado), se guarda también: suma, no estorba.
 */
export async function registrarEntrega({
  orderId, lineas = [], userId, repId = null, notas = null, scheduledAt = null,
  recipientName = null, firma = null, firmaId = null, tx: txFuera = null,
  via = 'MANUAL', albaranId = null,
}) {
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw new Error('Una entrega necesita al menos una línea')
  }
  for (const l of lineas) {
    if (!Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0) {
      throw new Error('La cantidad a entregar tiene que ser mayor que cero')
    }
  }

  // Si quien llama ya tiene una transacción abierta, se trabaja en esa.
  //
  // Abrir una transacción DENTRO de otra es el interbloqueo que ya dejó
  // escrito el cuaderno: PGlite tiene una sola conexión, así que la segunda
  // transacción espera a la primera para siempre y la petición no termina
  // nunca. El albarán entrega dentro de su propia transacción.
  const correr = (fn) => (txFuera ? fn(txFuera) : transaction(fn))

  return correr(async (tx) => {
    const pedido = await tx.one(`SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE`, [orderId])
    if (!pedido) throw new Error('El pedido no existe')
    if (pedido.status === 'CANCELLED') throw new Error('Un pedido anulado no se entrega')
    if (pedido.status === 'DRAFT' || pedido.status === 'CONFIRMED') {
      throw new Error('Este pedido no está confirmado. Confírmalo antes de entregar.')
    }
    if (pedido.status === 'DELIVERED') {
      const err = new Error(`El pedido ${pedido.code} ya se entregó por completo`)
      err.codigo = 'PEDIDO_YA_ENTREGADO'
      throw err
    }

    // O bien llega la firma como imagen suelta (API directa), o bien llega el
    // identificador de una firma YA GUARDADA —que es lo que pasa cuando la
    // entrega viene del albarán, donde el cliente firmó en la pantalla.
    //
    // Antes solo se aceptaba la imagen. Guardarla dos veces habría dejado dos
    // copias idénticas del mismo rótulo en `delivery_signatures`, y la segunda
    // apuntaría a un `albaran_id` que ya tenía una firma y es ÚNICO.
    // Sin imagen de firma, la entrega se confirma igualmente: lo que no puede
    // faltar es QUIÉN la confirmó. La base lo comprueba con un disparador.
    if (!firmaId && firma && (!Buffer.isBuffer(firma) || firma.length === 0)) {
      const err = new Error('La firma no se ha podido leer')
      err.codigo = 'FIRMA_INVALIDA'
      throw err
    }
    if (!userId) {
      const err = new Error(
        'Una entrega necesita saber quién la confirmó. Sin eso, nadie sabe '
        + 'después quién dejó esto aquí.')
      err.codigo = 'ENTREGA_SIN_AUTOR'
      throw err
    }
    if (!firmaId && firma && firma.length > 262144) {
      const err = new Error('La firma es demasiado grande (máximo 256 KB)')
      err.codigo = 'FIRMA_DEMASIADO_GRANDE'
      throw err
    }

    const code = await siguienteCodigoEntrega(tx)
    const entrega = await tx.one(
      `INSERT INTO deliveries (code, sales_order_id, rep_id, status, scheduled_at, notes, created_by)
       VALUES ($1,$2,$3,'PICKED_UP',$4,$5,$6) RETURNING id, code`,
      [code, orderId, repId, scheduledAt, notas, userId])

    // La firma se guarda y se ENLAZA a la entrega en el mismo paso. El
    // disparador `fn_entrega_exige_firma` mira `deliveries.signature_id`: si
    // la firma quedara huérfana en su tabla, la entrega no cerraría.
    //
    // Cuando la entrega viene del albarán, la firma YA está guardada (el
    // cliente firmó en la pantalla). Entonces se ENLAZA, no se inserta: son la
    // MISMA fila de la MISMA imagen, ymeter una segunda dejaría dos rótulos
    // idénticos con un `albaran_id` que es ÚNICO.
    //
    // Hay tres caminos, y el tercero es el normal:
    //
    //   1. Viene una firma YA guardada → se ENLAZA. Son la MISMA fila de la
    //      MISMA imagen; meter una segunda dejaría dos rótulos idénticos con un
    //      `albaran_id` que es ÚNICO.
    //   2. Viene una imagen nueva      → se inserta.
    //   3. NO HAY NADA                 → no se inserta fila ninguna.
    //
    // El tercero es lo que pasa en cada entrega de la tarjeta. La firma en papel
    // está con el cliente; el sistema guarda quién confirmó, no un dibujo.
    const firmaFila = firmaId
      ? await tx.one(
        `UPDATE delivery_signatures
            SET delivery_id = $2
          WHERE id = $1 AND delivery_id IS NULL
          RETURNING id, sha256`,
        [firmaId, entrega.id])
      : firma
        ? await tx.one(
          `INSERT INTO delivery_signatures
             (delivery_id, content_type, image, sha256, signer_name, signed_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, sha256`,
          [entrega.id, 'image/png', firma, hashFirma(firma), recipientName, userId])
        : null
    // Solo es un problema si SE PIDIÓ una firma y no se pudo colocar. Sin firma
    // no hay nada que comprobar: la entrega la confirma la persona, que ya se
    // guardó más abajo.
    if (firma && !firmaFila) {
      const err = new Error('Esa firma ya estaba enlazada a otra entrega')
      err.codigo = 'FIRMA_YA_ENLAZADA'
      throw err
    }

    let totalEntregado = 0
    const detalle = []

    for (const l of lineas) {
      const linea = await tx.one(
        `SELECT * FROM sales_order_lines WHERE id=$1 AND sales_order_id=$2 FOR UPDATE`,
        [l.orderLineId, orderId])
      if (!linea) throw new Error(`La línea ${l.orderLineId} no es de este pedido`)

      const pendiente = Number(linea.qty) - Number(linea.qty_delivered)
      if (Number(l.qty) - pendiente > 1e-9) {
        const err = new Error(
          `La línea de «${linea.qty}» ya está entregada en ${linea.qty_delivered} `
          + `y solo quedaban ${pendiente}. No se puede servir más de lo pendiente.`)
        err.codigo = 'CANTIDAD_SUPERA_PENDIENTE'
        throw err
      }

      // Se sirve de lo que estaba APARTADO para esta línea, no de cualquier
      // lote del almacén. Apartar fijó los lotes al confirmar el pedido, y ese
      // es el compromiso con el cliente.
      const reservas = await tx.query(
        `SELECT * FROM order_reservations
          WHERE order_line_id=$1 AND status IN ('ACTIVE','ASSIGNED') AND qty_consumed < qty
          ORDER BY (lot_id IS NULL), id FOR UPDATE`,
        [l.orderLineId])

      const pedible = reservas.reduce((s, r) => s + (Number(r.qty) - Number(r.qty_consumed)), 0)
      if (Number(l.qty) - pedible > 1e-9) {
        const err = new Error(
          `Solo hay ${pedible} unidades apartadas de esta línea, y pides servir ${l.qty}. `
          + 'Confirma el pedido antes de entregar.')
        err.codigo = 'NO_HAY_APARTADO_SUFICIENTE'
        err.apartado = pedible
        throw err
      }

      let restante = Number(l.qty)
      for (const r of reservas) {
        if (restante <= 1e-9) break
        const viva = Number(r.qty) - Number(r.qty_consumed)
        if (viva <= 1e-9) continue
        // Si la entrega indica un lote concreto, se respeta; si no, se sigue
        // el orden de las reservas, que ya es FEFO porque así se apartaron.
        if (l.lotId && Number(r.lot_id) !== Number(l.lotId)) continue
        const tomar = Math.min(restante, viva)

        await servirDeLote(tx, {
          entregaId: entrega.id, linea, reserva: r, cantidad: tomar, userId,
        })
        restante -= tomar
        totalEntregado += tomar
        detalle.push({
          orderLineId: linea.id, lotId: r.lot_id, qty: tomar, reservaId: r.id,
        })
      }
      if (restante > 1e-9) {
        throw new Error(
          `No se ha podido servir todo lo pedido en la línea ${linea.id}: faltan ${restante}`)
      }
    }

    // ── ¿Queda algo por servir? ───────────────────────────────────────────
    const resumen = await tx.one(
      `SELECT COALESCE(SUM(qty - qty_delivered),0) pendiente
         FROM sales_order_lines WHERE sales_order_id=$1`, [orderId])

    const completo = Number(resumen.pendiente) <= 1e-9
    // El albarán va como REFERENCIA, no como requisito: es el papel que
    // acompaña al viaje, y puede que no llegara a imprimirse.
    await tx.query(
        `UPDATE deliveries
            SET status='DELIVERED',
                signature_id = COALESCE($2, signature_id),
                recipient_name = COALESCE(recipient_name, $3),
                confirmed_via = $4, confirmed_by = $5, confirmed_at = now(),
                albaran_id = COALESCE(albaran_id, $6),
                delivered_at=now(), picked_up_at=COALESCE(picked_up_at, now())
          WHERE id=$1`,
        [entrega.id, firmaFila?.id ?? null, recipientName, via, userId, albaranId])

    // El pedido solo se cierra si TODO está servido. El disparador
    // `fn_pedido_estado_coherente` vuelve a comprobarlo en la base: si aquí
    // faltara una línea por sumar, PostgreSQL rechazaría el DELIVERED.
    await tx.query(
      `UPDATE sales_orders SET status=$2, updated_at=now()
              ${completo ? ', delivered_at = now()' : ''}
        WHERE id=$1`,
      [orderId, completo ? 'DELIVERED' : 'IN_ROUTE'])

    await auditar(tx, {
      usuarioId: userId, accion: 'REGISTRAR_ENTREGA', entidad: 'deliveries', entidadId: entrega.id,
      despues: {
        pedido: pedido.code, lineas: detalle.length, cantidad: r2(totalEntregado),
        estado_pedido: completo ? 'DELIVERED' : 'IN_ROUTE',
      },
    })
    // Se relee la entrega DESPUÉS de actualizarla. Devolver el objeto de antes
    // del UPDATE hacía que `confirmed_via`, `confirmed_by` y `confirmed_at`
    // salieran `undefined` aunque estuvieran guardados: la fila existe, pero
    // este return era una foto de un momento anterior.
    const guardada = await tx.one(
      `SELECT id, code, sales_order_id, status, confirmed_via, confirmed_by,
              confirmed_at, delivered_at, albaran_id, rep_id, recipient_name
         FROM deliveries WHERE id = $1`, [entrega.id])

    return {
      ...guardada, lineas: detalle, cantidad: r2(totalEntregado),
      // Sin imagen de firma (lo normal en la tarjeta) esto viene a null. La
      // entrega la confirma QUIÉN, que se guarda en confirmed_by.
      firma: firmaFila
        ? { id: firmaFila.id, sha256: firmaFila.sha256, receptor: recipientName }
        : null,
      pedido_estado: completo ? 'DELIVERED' : 'IN_ROUTE',
      pedido_pendiente: r2(resumen.pendiente),
    }
  })
}

/**
 * Saca mercancía de un lote y deja constancia en la reserva.
 *
 * Delega el movimiento en `moverStock`, que ya lleva dentro la clave de
 * consumo único. Escribir el `UPDATE lots` a mano aquí habría duplicado esa
 * lógica y, con el tiempo, una de las dos copias se habría quedado sin ella.
 */
async function servirDeLote(tx, { entregaId, linea, reserva, cantidad, userId }) {
  if (!reserva.lot_id) {
    const err = new Error(
      'Esta reserva no tiene lote asignado. No se puede entregar: la mercancía no está identificada.')
    err.codigo = 'RESERVA_SIN_LOTE'
    throw err
  }

  const mov = await moverStock(tx, {
    lotId: reserva.lot_id,
    qty: -Number(cantidad),
    movimiento: 'DELIVERY',
    refType: 'DELIVERY',
    refId: entregaId,
    // ── La garantía de «entrega una sola vez» ──────────────────────────────
    // La clave es única en la base. Si esta misma entrega volviera a pasar por
    // aquí con el mismo lote, `moverStock` devolvería `duplicado: true` y no
    // descontaría nada. La protección no depende de que el código se acuerde.
    clave: `DELIVERY:${entregaId}:lot:${reserva.lot_id}`,
    notas: `Entrega de pedido`,
    usuarioId: userId,
  })
  if (mov.duplicado) {
    const err = new Error(
      'Esta entrega ya había servido este lote. No se descuenta dos veces.')
    err.codigo = 'ENTREGA_DUPLICADA'
    throw err
  }

  // ── La línea de entrega ─────────────────────────────────────────────────
  // Sin esta fila, el lote entregado no se sabe de dónde salió. Toda la
  // trazabilidad hacia atrás (v_trace_backward) arranca en `delivery_lines`:
  // vacío significa que la mercancía desapareció sin dejar rastro de qué lote
  // se llevó.
  await tx.query(
    `INSERT INTO delivery_lines (delivery_id, order_line_id, item_id, lot_id, qty_delivered, unit_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entregaId, linea.id, linea.item_id, reserva.lot_id, cantidad, linea.unit_id])

  const servido = Number(reserva.qty_consumed) + Number(cantidad)
  await tx.query(
    `UPDATE order_reservations
        SET qty_consumed = $2,
            status = CASE WHEN $2 >= qty - 0.0001 THEN 'CONSUMED' ELSE status END,
            consumed_at = CASE WHEN $2 >= qty - 0.0001 THEN now() ELSE consumed_at END
      WHERE id=$1`,
    [reserva.id, servido])

  // Y la línea del pedido lleva su propio contador de lo servido. Son dos datos
  // distintos a propósito: `qty_consumed` dice cuánto se consumió de ESTA
  // reserva, y `qty_delivered` cuánto lleva servido el pedido de ese artículo
  // en total, venga de donde venga. Sin este segundo, un pedido de 100 quedaba
  // «pendiente 100» después de haber servido 40, y no se cerraba nunca.
  await tx.query(
    `UPDATE sales_order_lines SET qty_delivered = qty_delivered + $2 WHERE id = $1`,
    [linea.id, cantidad])
}

/** Consultar qué se puede servir ahora de un pedido, sin servir nada. */
export async function planEntrega(orderId, txFuera = null) {
  const correr = (fn) => (txFuera ? fn(txFuera) : transaction(fn))
  return correr(async (tx) => {
    const lineas = await tx.query(
      `SELECT l.id, l.item_id, l.qty, l.qty_delivered, i.name, i.sku
         FROM sales_order_lines l JOIN items i ON i.id = l.item_id
        WHERE l.sales_order_id=$1 ORDER BY l.id`, [orderId])
    const salida = []
    for (const l of lineas) {
      const reservas = await tx.query(
        `SELECT r.id, r.lot_id, r.qty, r.qty_consumed,
                (r.qty - r.qty_consumed) AS qty_viva, lo.code AS lote_code, lo.expiry_date
           FROM order_reservations r JOIN lots lo ON lo.id = r.lot_id
          WHERE r.order_line_id=$1 AND r.status IN ('ACTIVE','ASSIGNED')
            AND r.qty_consumed < r.qty
          ORDER BY r.id`, [l.id])
      const apartado = reservas.reduce((s, r) => s + Number(r.qty_viva), 0)
      salida.push({
        lineaId: l.id, itemId: l.item_id, nombre: l.name, sku: l.sku,
        pedido: Number(l.qty), entregado: Number(l.qty_delivered),
        pendiente: Number(l.qty) - Number(l.qty_delivered),
        apartado, lotes: reservas,
        servible: Math.min(apartado, Number(l.qty) - Number(l.qty_delivered)),
      })
    }
    return {
      pedido_id: orderId,
      lineas: salida,
      total_servible: r2(salida.reduce((s, l) => s + l.servible, 0)),
    }
  })
}

export async function listarEntregas({ orderId = null, limite = 100, vivas = false } = {}) {
  return transaction(async (tx) => {
    const cond = []
    const p = []
    if (orderId) { p.push(orderId); cond.push(`d.sales_order_id=$${p.length}`) }
    // Una entrega ya cerrada no es una entrega que haya que hacer.
    if (vivas) cond.push(`d.status <> 'DELIVERED'`)
    p.push(limite)
    return tx.query(
      `SELECT d.id, d.code, d.status, d.scheduled_at, d.delivered_at, d.rep_id,
              d.recipient_name, u.full_name AS repartidor,
              o.code AS pedido_code, c.code AS cliente_code, c.name AS cliente_name,
              (SELECT COALESCE(SUM(qty_delivered),0) FROM delivery_lines dl
                WHERE dl.delivery_id = d.id) AS cantidad,
              (s.id IS NOT NULL) AS firmada
         FROM deliveries d
         JOIN sales_orders o ON o.id = d.sales_order_id
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = d.rep_id
         LEFT JOIN delivery_signatures s ON s.delivery_id = d.id
        ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER BY d.created_at DESC LIMIT $${p.length}`, p)
  })
}

/**
 * CONFIRMAR LA ENTREGA DESDE LA TARJETA DEL CLIENTE
 *
 * Este es EL camino. El único.
 *
 * El reparto real es: el repartidor lleva la mercancía y el albarán, el cliente
 * FIRMA EN PAPEL, y luego el repartidor escanea la tarjeta y pulsa «Entregar».
 * El albarán no interviene: es papel.
 *
 * Lo que se guarda, que es lo que se necesita cuando alguien pregunta:
 *
 *   · el pedido servido y el cliente al que pertenecía
 *   · la fecha y la hora
 *   · QUIÉN confirmó, que es el repartidor con su usuario
 *   · por qué vía se confirmó
 *   · el albarán del viaje, si se imprimió, como referencia del papel
 *
 * Y se guarda en la MISMA transacción que descuenta el stock, de modo que no
 * puede pasar una cosa sin la otra.
 *
 * @param {object}  p
 * @param {number}  p.orderId     pedido que se acaba de entregar
 * @param {number}  p.clienteId   cliente de la tarjeta escaneada
 * @param {number}  p.userId      repartidor que pulsa «Entregar»
 * @param {number} [p.repId]      mismo repartidor, si viene informado aparte
 * @param {string} [p.recibe]     nombre de quien recibe
 * @param {Array}  [p.lineas]     qué se sirve. Por defecto, todo lo servible.
 */
export async function confirmarDesdeTarjeta({
  orderId, clienteId, userId, repId = null, recibe = null, lineas = null,
  tx: txFuera = null,
}) {
  const correr = (fn) => (txFuera ? fn(txFuera) : transaction(fn))
  return correr(async (tx) => {
    // ── Que la tarjeta sea la de ESE cliente ─────────────────────────────
    //
    // Sin esta comprobación, el repartidor podría escanear una tarjeta y
    // marcar entregado el pedido de otro. La tarjeta identifica al CLIENTE;
    // el pedido tiene que ser suyo.
    const pedido = await tx.one(
      `SELECT o.id, o.code, o.status, o.customer_id, c.name AS cliente_name,
              c.code AS cliente_code
         FROM sales_orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 FOR UPDATE OF o`, [orderId],
    )
    if (!pedido) {
      const e = new Error('Ese pedido no existe')
      e.codigo = 'PEDIDO_NO_ENCONTRADO'; e.estado = 404
      throw e
    }
    if (clienteId && Number(pedido.customer_id) !== Number(clienteId)) {
      const e = new Error(
        `Esta tarjeta es de ${pedido.cliente_name} y ese pedido es de otro cliente. `
        + 'Escanea la tarjeta del cliente al que se le ha entregado.')
      e.codigo = 'TARJETA_NO_CORRESPONDE'; e.estado = 409
      throw e
    }
    if (pedido.status === 'DELIVERED') {
      const e = new Error(
        `El pedido ${pedido.code} ya está entregado. No se entrega dos veces.`)
      e.codigo = 'PEDIDO_YA_ENTREGADO'; e.estado = 409
      throw e
    }
    if (pedido.status === 'DRAFT' || pedido.status === 'CONFIRMED') {
      const e = new Error(
        `El pedido ${pedido.code} no está listo para entregar. `
        + 'Confírmalo y aprétalo antes de ponerlo en la ruta.')
      e.codigo = 'PEDIDO_NO_PREPARADO'; e.estado = 409
      throw e
    }

    // ── Qué se sirve ─────────────────────────────────────────────────────
    const plan = await planEntrega(orderId, tx)
    const aServir = lineas?.length
      ? lineas
      : plan.lineas.filter((l) => Number(l.servible) > 0)
        .map((l) => ({ orderLineId: l.lineaId, qty: Number(l.servible) }))
    if (!aServir.length) {
      const e = new Error(
        `No queda mercancía apartada del pedido ${pedido.code}. `
        + 'Revisa el stock antes de confirmar la entrega.')
      e.codigo = 'SIN_MERCANCIA_APARTADA'; e.estado = 400
      throw e
    }

    // ── El albarán de este viaje, si lo hay ─────────────────────────────
    //
    // Va como REFERENCIA del papel que se llevó el repartidor. No hace falta
    // que exista: se puede entregar sin haber impreso nada, y aun así queda
    // escrito quién entregó y cuándo.
    const albaran = await tx.one(
      `SELECT id, code FROM albaranes
        WHERE sales_order_id = $1 AND status <> 'VOID'
        ORDER BY created_at DESC LIMIT 1`, [orderId])

    const entrega = await registrarEntrega({
      orderId,
      lineas: aServir,
      userId,
      repId: repId ?? userId,
      recipientName: recibe || pedido.cliente_name,
      via: 'TARJETA_QR',
      albaranId: albaran?.id ?? null,
      tx,
    })

    // El papel también se anota. OJO CON EL SENTIDO: el albarán NO decide la
    // entrega, pero una vez que la entrega existe, el papel que salió con ella
    // vuelve firmada y hay que poder decir. Se escribe en `albaranes` y en
    // NINGÚN otro sitio: `sales_orders` no se toca aquí, se ha tocado arriba
    // y solo con lo que el reparto ha servido de verdad.
    if (albaran?.id) {
      await tx.query(
        `UPDATE albaranes
            SET status='DELIVERED', delivered_at=now(), delivered_by=$2,
                delivery_id = COALESCE(delivery_id, $3)
          WHERE id=$1 AND status IN ('PRINTED','SIGNED','DELIVERED')`,
        [albaran.id, userId, entrega.id])
    }

    // El estado del pedido, leído DESPUÉS de servir: es lo que queda, no lo que
    // se quería.
    const pedidoTras = await tx.one(
      `SELECT status FROM sales_orders WHERE id = $1`, [orderId])

    await auditar(tx, {
      usuarioId: userId,
      accion: 'CONFIRMAR_ENTREGA_TARJETA',
      entidad: 'deliveries',
      entidadId: entrega.id,
      despues: {
        pedido: pedido.code,
        cliente: pedido.cliente_code,
        albaran: albaran?.code ?? null,
        lineas: aServir.length,
        via: 'TARJETA_QR',
      },
    })

    const tras = await tx.one(
      `SELECT d.id, d.code, d.status, d.confirmed_via, d.confirmed_by, d.confirmed_at,
              d.delivered_at, d.albaran_id, d.rep_id, d.recipient_name
         FROM deliveries d WHERE d.id = $1`, [entrega.id])
    return {
      ...tras,
      // Sin imagen de firma, que es lo normal cuando el cliente firma en papel.
      // Se dice explícitamente para que quien lo lee no piense que falta algo.
      firma: null,
      lineas: entrega.lineas,
      cantidad: entrega.cantidad,
      pedido_id: Number(orderId),
      pedido_codigo: pedido.code,
      cliente_id: Number(pedido.customer_id),
      cliente_nombre: pedido.cliente_name,
      pedido_estado: pedidoTras.status,
      lineas_servidas: aServir.reduce((t, l) => t + Number(l.qty || 0), 0),
    }
  })
}
