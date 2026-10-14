import crypto from 'node:crypto'
import { siguienteCodigoAlbaran } from './codigos.js'
import { empresa as leerEmpresa } from './config.js'
import { registrarEntrega, planEntrega as planEntregaEnTx } from './entregas.js'
import { auditar } from './auditoria.js'

/**
 * Albarán: CREAR → IMPRIMIR → FIRMAR → ENTREGAR.
 *
 * Son cuatro hechos separados y quedan registrados por separado, porque en el
 * almacén se imprime un albarán mucho antes de que nadie lo firme. Si imprimir
 * marcara el pedido como entregado, el parte de trabajo mentiría.
 *
 * La regla «no se entrega sin firma» no vive aquí: vive en un disparador de
 * PostgreSQL. Si alguien cierra la entrega desde una ruta que no pase por este
 * fichero, la base lo rechaza igualmente.
 */

const ESTADOS = ['DRAFT', 'PRINTED', 'SIGNED', 'DELIVERED', 'VOID']
const FIRMADO = 'SIGNED'
const ENTREGADO = 'DELIVERED'

/** Traduce el CHECK de PostgreSQL a un error que la API entienda. */
/**
 * Un error de negocio: el mensaje es para quien lo ve en pantalla.
 *
 * Sin `codigo` ni `estado`, un `Error` a secas acaba en el manejador general y
 * sale como «Error interno del servidor». El repartidor pulsando «Entregar» sin
 * firma se merecía un mensaje que dijera qué le falta.
 */
function fallar(mensaje, codigo = 'ALBARAN_ERROR', estado = 400) {
  const e = new Error(mensaje)
  e.codigo = codigo
  e.estado = estado
  return e
}

function traducirError(e) {
  const m = String(e?.message || '')
  if (m.includes('RESERVA_EXCEDE_PEDIDO')) {
    return { codigo: 'RESERVA_EXCEDE_PEDIDO', estado: 400 }
  }
  if (m.includes('ENTREGA_SIN_FIRMA') || m.includes('ENTREGA_SIN_FECHA')) {
    return { codigo: 'ENTREGA_SIN_EVIDENCIA', estado: 400 }
  }
  // El propio albarán lo dice en sus CHECK: no se puede saltar un paso.
  if (m.includes('albaran_printed_exige_impresion') || m.includes('PRINTED')) {
    return { codigo: 'ALBARAN_SIN_IMPRIMIR', estado: 409 }
  }
  if (m.includes('albaran_signed_exige_firma') || m.includes('albaran_delivered_exige_firma_y_fecha')) {
    return { codigo: 'ALBARAN_SIN_FIRMA', estado: 409 }
  }
  if (m.includes('albaran_')) {
    return { codigo: 'ALBARAN_PASO_INVALIDO', estado: 409 }
  }
  return null
}

/**
 * Crea el albarán. Todavía no se imprime: esto solo deja el documento
 * preparado con los datos del pedido.
 */
export async function crearAlbaran(tx, {
  // UNA hoja por defecto.
  //
  // `copies` NO es lo que se imprime: el documento es siempre un albarán, y
  // quien lo imprime decide en su diálogo cuántas copias saca. Este campo es la
  // nota de cuántas hojas se quedaron en el archivo.
  salesOrderId, deliveryId = null, copies = 1,
  recipientName = null, observations = null, userId,
  lineas = null,
}) {
  const pedido = await tx.one(
    `SELECT id, code, status FROM sales_orders WHERE id = $1`, [salesOrderId],
  )
  if (!pedido) throw fallar(`El pedido ${salesOrderId} no existe`)
  if (pedido.status === 'CANCELLED') {
    throw fallar('No se puede hacer un albarán de un pedido anulado')
  }
  if (pedido.status === 'DELIVERED') {
    throw fallar(`El pedido ${pedido.code} ya está entregado`, 'PEDIDO_YA_ENTREGADO', 409)
  }

  // Un albarán EN CURSO por pedido. Uno por viaje: si el pedido está a medias,
  // el siguiente viaje abre un albarán nuevo, y el anterior queda cerrado con
  // lo que llevó. Sin esto se montaban dos albaranes para el mismo pedido y uno
  // acababa huérfano, «pendiente», con el pedido ya entregado.
  const abierto = await tx.one(
    `SELECT id, code FROM albaranes
      WHERE sales_order_id = $1 AND status IN ('DRAFT','PRINTED','SIGNED')
      ORDER BY id DESC LIMIT 1`, [salesOrderId])
  if (abierto) {
    throw fallar(
      `El pedido ${pedido.code} ya tiene el albarán ${abierto.code} a medio `
      + 'camino. Termínalo o anúlalo antes de abrir otro.',
      'ALBARAN_EN_CURSO', 409)
  }

  const code = await siguienteCodigoAlbaran(tx)
  const fila = await tx.one(
    `INSERT INTO albaranes
       (code, sales_order_id, delivery_id, copies, recipient_name, observations, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, code, status, copies, created_at`,
    [code, salesOrderId, deliveryId, copies, recipientName, observations, userId],
  )

  // ── Las líneas de ESTE viaje ────────────────────────────────────────────
  //
  // Si no las dice quien lo crea, se llevan todas las que queden servibles.
  // Lo que se guarda es lo que se IMPRIME y lo que se FIRMA, que es justo lo
  // que se tiene que poder comprobar después.
  const elegidas = lineas?.length
    ? lineas
    : (await tx.query(
      `SELECT l.id, l.qty, l.unit_id,
              GREATEST(l.qty - l.qty_delivered, 0) AS pendiente
         FROM sales_order_lines l WHERE l.sales_order_id = $1
        ORDER BY l.id`, [salesOrderId]))
      .filter((l) => Number(l.pendiente) > 0)
      .map((l) => ({ orderLineId: l.id, qty: l.pendiente, unitId: l.unit_id }))

  if (!elegidas.length) {
    throw fallar(`El pedido ${pedido.code} no tiene nada por servir`, 'PEDIDO_SIN_PENDIENTE', 400)
  }
  for (const l of elegidas) {
    const linea = await tx.one(
      `SELECT id, unit_id, qty, qty_delivered FROM sales_order_lines
        WHERE id = $1 AND sales_order_id = $2`,
      [l.orderLineId, salesOrderId])
    if (!linea) throw fallar(`La línea ${l.orderLineId} no es de este pedido`, 'LINEA_NO_ES_DEL_PEDIDO', 400)
    if (!Number(l.qty) || Number(l.qty) <= 0) {
      throw fallar('Cada línea del albarán tiene que llevar algo', 'CANTIDAD_CERO', 400)
    }
    // El disparador `fn_albaran_linea_no_supera_pendiente` lo vuelve a
    // comprobar en la base. Aquí se avisa antes, para no fallar a medias.
    const restante = Number(linea.qty) - Number(linea.qty_delivered)
    if (Number(l.qty) - restante > 0.0001) {
      throw fallar(
        `La línea lleva ${l.qty} y solo quedaban ${restante} por servir`,
        'CANTIDAD_SUPERA_PENDIENTE', 400)
    }
    await tx.query(
      `INSERT INTO albaran_lines (albaran_id, order_line_id, qty, unit_id)
       VALUES ($1,$2,$3,$4)`,
      [fila.id, linea.id, Number(l.qty), linea.unit_id])
  }
  return fila
}

/**
 * Marca el albarán como impreso. NO entrega ni descuenta stock: solo deja
 * constancia de que salieron las copias. Las dos, por defecto: una para el
 * cliente y otra que vuelve firmada a Sahel.
 */
export async function imprimirAlbaran(tx, { albaranId, copies = null, userId }) {
  const antes = await obtener(tx, albaranId)
  if (antes.status === 'VOID') throw fallar('El albarán está anulado', 'ALBARAN_ANULADO', 409)
  if (antes.status === 'DELIVERED') throw fallar('El albarán ya está entregado', 'ALBARAN_YA_ENTREGADO', 409)

  const fila = await tx.one(
    `UPDATE albaranes
        SET status = 'PRINTED', copies = COALESCE($2, copies),
            printed_at = now(), printed_by = $3, updated_at = now()
      WHERE id = $1
      RETURNING id, code, status, copies, printed_at`,
    [albaranId, copies, userId],
  )
  return { ...fila, entregado: false, motivo: 'Imprimir un albarán no entrega el pedido' }
}

/**
 * Firma del cliente. Guarda la imagen de verdad —binario y su hash— y solo
 * entonces avanza el albarán a FIRMADO.
 */
export async function firmarAlbaran(tx, {
  albaranId, signerName, image, contentType = 'image/png',
  width = null, height = null, userId,
}) {
  const antes = await obtener(tx, albaranId)
  if (antes.status === 'VOID') throw fallar('El albarán está anulado', 'ALBARAN_ANULADO', 409)
  if (antes.status === 'DELIVERED') throw fallar('El albarán ya está entregado', 'ALBARAN_YA_ENTREGADO', 409)
  // Una firma NO se vuelve a poner. Antes solo se bloqueaban `VOID` y
  // `DELIVERED`, así que un albarán ya FIRMADO aceptaba una segunda firma y la
  // SOBRESCRIBÍA: la imagen y el nombre de quien recibió quedaban cambiados
  // después de haber servido la mercancía, y nadie lo notaba. Aquí es donde se
  // decide quién recibió, y una vez decidido no se toca.
  if (antes.status === 'SIGNED') {
    // `signed_at` llega como Date, no como texto: `String(fecha).slice(0,16)`
    // devolvía '' y el mensaje salía con un «el » sin fecha detrás.
    const cuando = antes.signed_at
      ? ` el ${new Date(antes.signed_at).toISOString().slice(0, 16).replace('T', ' ')}`
      : ''
    throw fallar(
      `El albarán ya está firmado por ${antes.signed_by_name || 'quien recibió'}${cuando}. `
      + 'La firma no se cambia.',
      'ALBARAN_YA_FIRMADO', 409)
  }
  if (!antes.printed_at) {
    throw fallar('Un albarán no se puede firmar sin haberlo impreso antes', 'ALBARAN_SIN_IMPRIMIR', 409)
  }
  if (!image || !Buffer.isBuffer(image) || image.length === 0) {
    throw fallar('Falta la firma del cliente')
  }
  if (image.length > 262144) {
    throw fallar('La firma es demasiado grande (máximo 256 KB)')
  }

  const sha256 = crypto.createHash('sha256').update(image).digest('hex')
  // OJO: `query`, no `exec`. `tx.exec()` no acepta parámetros: se los come y
  // PostgreSQL responde «no parameter $1». Ya pasó dos veces en este proyecto.
  await tx.query(
    `INSERT INTO delivery_signatures
       (albaran_id, delivery_id, content_type, image, width, height, sha256,
        signer_name, signed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (albaran_id) DO UPDATE
       SET image = EXCLUDED.image, content_type = EXCLUDED.content_type,
           width = EXCLUDED.width, height = EXCLUDED.height, sha256 = EXCLUDED.sha256,
           signer_name = EXCLUDED.signer_name, signed_at = now()`,
    [albaranId, antes.delivery_id, contentType, image, width, height, sha256, signerName, userId],
  )

  const fila = await tx.one(
    `UPDATE albaranes
        SET status = 'SIGNED', signed_at = now(), signed_by_name = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, code, status, signed_at, signed_by_name`,
    [albaranId, signerName],
  )
  return { ...fila, sha256 }
}

/**
 * ANOTA QUE EL PAPEL VOLVIÓ. Y nada más.
 *
 * ESTA FUNCIÓN YA NO ENTREGA NADA.
 *
 * Antes significaba «cerrar la entrega»: exigía firma en pantalla, consumía el
 * stock y cerraba el pedido. Todo eso lo hace ahora la TARJETA, desde
 * `core/entregas.js`, en `confirmarDesdeTarjeta()`.
 *
 * Lo que queda es una constancia sobre el PAPEL: que el albarán que salió con la
 * mercancía volvió, y quién lo devolvió. Se escribe en `albaranes` y en ninguna
 * otra tabla. `sales_orders` no se toca, y el stock no se mueve.
 *
 * Para registrar una entrega de verdad, la ruta es:
 *
 *     POST /api/reparto/pedido/:id/entregar      (tarjeta QR)
 */
export async function anotarPapelDevuelto(tx, { albaranId, userId, repId = null }) {
  const antes = await obtener(tx, albaranId)
  if (antes.status === 'VOID') throw fallar('El albarán está anulado', 'ALBARAN_ANULADO', 409)

  if (antes.status === 'DELIVERED') {
    throw fallar('Este albarán ya consta devuelto', 'ALBARAN_YA_ENTREGADO', 409)
  }

  // Si la entrega de verdad ya existe, este papel es el suyo. Si no existe, no
  // se inventa ninguna: aquí solo se dice que volvió, y el pedido sigue igual.
  const entrega = await tx.one(
    `SELECT id FROM deliveries WHERE albaran_id = $1 LIMIT 1`, [albaranId])

  const fila = await tx.one(
    `UPDATE albaranes
        SET status='DELIVERED', delivered_at=now(), delivered_by=$2, updated_at=now()
      WHERE id=$1 AND status <> 'VOID'
    RETURNING *`,
    [albaranId, userId ?? null])

  if (!fila) throw fallar('Ese albarán no existe', 'ALBARAN_NO_ENCONTRADO', 404)

  await auditar(tx, {
    usuarioId: userId ?? null,
    accion: 'ANOTAR_ALBARAN_DEVUELTO',
    entidad: 'albaranes',
    entidadId: Number(albaranId),
    antes: { status: antes.status },
    despues: { status: 'DELIVERED', entrega: entrega?.id ?? null },
  })

  return { ...fila, entrega_id: entrega?.id ?? null }
}

/** Anula el albarán con motivo obligatorio. */
export async function anularAlbaran(tx, { albaranId, motivo, userId }) {
  if (!motivo || motivo.trim().length < 3) {
    throw fallar('Anular un albarán necesita un motivo')
  }
  const fila = await tx.one(
    `UPDATE albaranes
        SET status = 'VOID', void_reason = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, code, status, void_reason`,
    [albaranId, motivo],
  )
  if (!fila) throw fallar(`El albarán ${albaranId} no existe`)
  return fila
}

export async function obtener(tx, albaranId) {
  const fila = await tx.one(
    `SELECT id, code, sales_order_id, delivery_id, status, copies, recipient_name,
            printed_at, signed_at, signed_by_name, delivered_at, void_reason, created_at
       FROM albaranes WHERE id = $1`,
    [albaranId],
  )
  if (!fila) throw fallar(`El albarán ${albaranId} no existe`)
  return fila
}

/**
 * Albarán completo tal como se imprime: cliente, pedido, líneas y el estado de
 * los cuatro hechos. La firma se devuelve aparte, en binario.
 */
export async function detalleAlbaran(tx, albaranId) {
  const a = await obtener(tx, albaranId)
  const cabecera = await tx.one(
    `SELECT o.id AS pedido_id, o.code AS pedido_code, o.order_date, o.promised_date,
            o.currency_code, o.subtotal, o.tax_rate, o.tax_amount, o.discount_amount, o.total,
            c.id AS cliente_id, c.code AS cliente_code, c.name AS cliente_name,
            c.company_name, c.address, c.phone, z.name AS zona
       FROM sales_orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN zones z ON z.id = c.zone_id
      WHERE o.id = $1`,
    [a.sales_order_id],
  )
  // ── Las líneas del ALBARÁN, no las del pedido ──────────────────────────
  //
  // El documento tiene que decir lo que lleva ESTE viaje. Si se imprimieran
  // todas las líneas del pedido, un cliente firmando un albarán de media
  // entrega estaría firmando que se lleva el pedido entero.
  const lineasDelAlbaran = await tx.query(
    `SELECT al.id, al.qty, al.order_line_id,
            l.qty AS qty_pedida, l.qty_delivered,
            i.sku, i.name AS item_name, u.code AS unit_code,
            -- PRESENTACIÓN. Es la MISMA columna que sale en la hoja de pedido, y
            -- sin ella el albarán decía «120 UD» sin decir «750 ml».
            i.format_label AS presentacion,
            l.unit_price, l.tax_rate, l.line_total, l.notes,
            -- CAJAS. La FOTO que se guardó al pedir, no una consulta al
            -- formato actual: un albarán de 2024 tiene que decir «Caja de 12
            -- · 1.200» aunque esa caja hoy valga 1.350 o ya no exista. Por eso
            -- se leen format_name / format_price, que son copias inmutables.
            l.format_name, l.format_units, l.format_price, l.formats_qty
       FROM albaran_lines al
       JOIN sales_order_lines l ON l.id = al.order_line_id
       JOIN items i ON i.id = l.item_id
       JOIN units u ON u.id = al.unit_id
      WHERE al.albaran_id = $1
      ORDER BY al.id`, [albaranId],
  )
  const lineas = lineasDelAlbaran.length
    ? lineasDelAlbaran
    : // Un albarán viejo, creado antes de que existiera esta tabla: se cae
      // al pedido entero para no dejar el documento en blanco.
      await tx.query(
        `SELECT l.id, l.qty, l.qty_delivered, l.unit_price, l.tax_rate,
                l.line_total, l.notes, i.sku, i.name AS item_name, u.code AS unit_code,
                i.format_label AS presentacion,
                l.format_name, l.format_units, l.format_price, l.formats_qty
           FROM sales_order_lines l
           JOIN items i ON i.id = l.item_id
           JOIN units u ON u.id = l.unit_id
          WHERE l.sales_order_id = $1
          ORDER BY l.id`, [a.sales_order_id],
      )

  const eventos = await tx.query(
    `SELECT event, occurred_at, user_name FROM albaran_events
      WHERE albaran_id = $1 ORDER BY occurred_at, id`,
    [albaranId],
  )
  const firma = await tx.one(
    `SELECT signer_name, signed_at, sha256, width, height FROM delivery_signatures
      WHERE albaran_id = $1`,
    [albaranId],
  )
  // Los datos de la empresa se leen de `app_config`, no se escriben aquí.
  // El documento se arma con ellos en el servidor, de modo que lo que se
  // imprime y lo que se ve en pantalla no pueden contradecirse.
  const empresa = await leerEmpresa(tx)
  return { ...a, cabecera, lineas, eventos, empresa, tieneFirma: Boolean(firma), firma }
}

export async function listarAlbaranes(tx, { salesOrderId = null, status = null } = {}) {
  const cond = ['TRUE']
  const p = []
  if (salesOrderId) { p.push(salesOrderId); cond.push(`a.sales_order_id = $${p.length}`) }
  if (status) { p.push(status); cond.push(`a.status = $${p.length}`) }
  return tx.query(
    `SELECT a.id, a.code, a.status, a.copies, a.sales_order_id, a.delivery_id,
            a.recipient_name, a.printed_at, a.signed_at, a.signed_by_name,
            a.delivered_at, a.created_at,
            o.code AS pedido_code, c.code AS cliente_code, c.name AS cliente_name,
            (s.id IS NOT NULL) AS tiene_firma
       FROM albaranes a
       JOIN sales_orders o ON o.id = a.sales_order_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN delivery_signatures s ON s.albaran_id = a.id
      WHERE ${cond.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC`,
    p,
  )
}

export { traducirError, ESTADOS, FIRMADO, ENTREGADO }
