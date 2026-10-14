/**
 * COBRO
 *
 * Un cobro es un HECHO —alguien handingó dinero por un pedido— no una cifra que
 * alguien teclea. Por eso aquí no hay ni un solo número escrito por el cliente.
 *
 * ── LA REGLA, ENTERA ───────────────────────────────────────────────────────
 *
 * El contrato de `cobrar()` tiene tres cosas: un pedido, un método y una
 * referencia. NO tiene importe. No es que el importe se valide, es que NO SE
 * PUEDE mandar. La diferencia es la diferencia entre una puerta con un candado
 * y una puerta con un cartel de «por favor, no entréis sin pagar»; la primera
 * se puede dejar de leer.
 *
 * El importe sale de `fn_pendiente_cobro()`, que es la misma función que
 * alimenta la tarjeta del repartidor y el disparador de la base. No hay dos
 * cuentas que puedan discrepar, porque hay una.
 *
 * ── POR QUÉ NO SE ACEPTA `amount` NI AUNQUE VENGA DENTRO ───────────────────
 *
 * Podría aceptarlo y validarlo. Sería más hospitable con un cliente mal
 * escrito y daría un error más claro. Y sería peor, por dos razones:
 *
 *   · Un endpoint que acepta un importe y a veces lo ignora es un endpoint que
 *     la gente empeieza a usar mandándolo. El día que alguien lea el código y
 *     vea «aquí hay un `amount`»,Ipso facto lo Tea.
 *   · El día que se acepte, alguien lo ajustará. «Cobra 1210 pero pon 1000 por
 *     si el cliente protesta». Y entonces el sistemadirección vuelve a ser un
 *     sitio donde se puede negociar el precio, que es justo lo que este
 *     circuito no admite.
 *
 * Mande lo que mande el cliente el importe, el importe es el que la base dice
 * que se debe.
 * Si mandan un `amount`, se rechaza la petición entera: es más ruidoso que
 * ignorarlo, y el ruido es la respuesta correcta a un cliente que no debería
 * poder mandar esa cifra.
 */

import { transaction } from '../db/client.js'

/** Los métodos que existen. Vienen de la tabla, no de un `if` en el código. */
const METODOS = `
  SELECT code, label, requires_reference FROM payment_methods WHERE active = true`

/** Códigos de moneda de los documentos. */
const MONEDAS = ['XOF', 'EUR']

/**
 * Los métodos de pago. Se leen de la tabla y no se escriben aquí.
 *
 * escritos en el backend, un método nuevo sería un despliegue. En la tabla,
 * es una fila.
 */
export async function listarMetodos() {
  const db = await import('../db/client.js')
  return db.query(METODOS)
}

/**
 * COBRAR.
 *
 * Todo lo que se acepta del cliente, en un sitio y con nombre:
 *
 *   pedidoId  qué pedido se cobra
 *   metodo    cómo se paga
 *   referencia  el comprobante, si el método lo pide
 *   deliveryId  la entrega, si el cobro va atado a una
 *
 * El importe NO está en la lista, y no es un olvido.
 *
 * @param {{pedidoId:number, metodo:string, referencia?:string, deliveryId?:number,
 *          extra?:object, usuarioId:number}} entrada
 */
export async function cobrar({
  pedidoId, metodo, referencia = null, deliveryId = null,
  extra = {}, usuarioId,
}) {
  //
  // Si el cliente manda un importe, se para aquí y no se mira nada más.
  //
  // Podría ignorarse en silencio —que es lo que hacen casi todas las APIs— y
  // seguir. Aquí no. Un cliente que manda `amount` está intentando negociar el
  // precio, y la respuesta a eso no es «vale, te hago caso» ni «vale, te
  // ignoro», sino «esto no se puede hacer». Que se entienda en el momento es
  // lo que evita que alguien descubra en junio que podía mandar esa cifra.
  //
  for (const campo of ['amount', 'importe', 'precio', 'total', 'importe_pedido']) {
    if (Object.prototype.hasOwnProperty.call(extra, campo)) {
      throw Object.assign(
        new Error(
          `El endpoint no acepta «${campo}». El importe lo calcula la base a `
          + 'partir de lo que el pedido debe; no se puede mandar.',
        ),
        { codigo: 'IMPORTE_NO_ADMISIBLE' },
      )
    }
  }

  if (!pedidoId) throw new Error('Falta el pedido que se cobra')
  if (!metodo) throw new Error('Falta el método de pago')

  if (!MONEDAS.length) throw new Error('Error de configuración')
  if (!MONEDAS.includes(extra.moneda)) {
    // Por si acaso alguien intenta colar una moneda por la puerta de atrás.
    delete extra.moneda
  }

  return transaction(async (tx) => {
    const pedido = await tx.one(
      `SELECT o.id, o.code, o.customer_id, o.currency_code, o.status,
              fn_pendiente_cobro(o.id) AS pendiente,
              COALESCE(o.total, 0) AS total
         FROM sales_orders o WHERE o.id = $1`,
      [pedidoId],
    )
    if (!pedido) throw new Error('Ese pedido no existe')

    //
    // Un pedido pagado es un pedido que no se cobra. Ni un céntimo.
    //
    // Y esto NO es lo mismo que el disparador. El disparador rechaza el cobro
    // de MÁS; esto rechaza el cobro de CUALQUIER cosa sobre algo que ya no debe
    // nada. Un pedido con un error de redondeo de un céntimo quedaba
    // «pendiente» para siempre y aceptaba cobros de un céntimo sin parar, uno
    // detrás de otro. Cero pendiente es cero cobros, sin excepción.
    //
    if (Number(pedido.pendiente) <= 0) {
      throw Object.assign(
        new Error(
          `El pedido ${pedido.code} ya está pagado. No queda nada por cobrar.`,
        ),
        { codigo: 'PEDIDO_YA_PAGADO', pedidoId: pedido.id, pendiente: 0 },
      )
    }

    if (!['RESERVED', 'PREPARED', 'IN_ROUTE', 'CONFIRMED', 'DELIVERED'].includes(pedido.status)) {
      throw new Error(
        `El pedido ${pedido.code} está en estado ${pedido.status} y no se puede cobrar.`,
      )
    }

    const cliente = await tx.one(
      `SELECT id, name FROM customers WHERE id = $1`, [pedido.customer_id],
    )

    // El importe: de la base, de UNA función, y no de un argumento.
    const importe = pedido.pendiente

    // La moneda: la del pedido. Jamás la del cliente.
    const p = await tx.query(
      `INSERT INTO payments
         (sales_order_id, delivery_id, customer_id, collected_by,
          method, amount, currency_code, reference, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$4) RETURNING *`,
      [pedido.id, deliveryId, pedido.customer_id, usuarioId,
        metodo, importe, pedido.currency_code, referencia || null],
    )
    return {
      cobro: p[0],
      pedido: { id: pedido.id, code: pedido.code },
      cliente: cliente ? { id: cliente.id, name: cliente.name } : null,
      // Lo que queda después de este cobro. Viene de la MISMA función, y por
      // construcción es cero: se acaba de pagar todo lo que había.
      pendiente_tras_cobro: 0,
    }
  })
}
