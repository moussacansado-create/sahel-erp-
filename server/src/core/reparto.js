/**
 * REPARTO
 *
 * La hoja de ruta del repartidor: los albaranes que van en el camión.
 *
 * ── POR QUÉ LA RUTA SON ALBARANES Y NO ENTREGAS ────────────────────────────
 *
 * Lo primero que se ocurrió fue listar `deliveries`, que ya tenía `rep_id`,
 * `zone_id` y sus estados PENDING/ASSIGNED/PICKED_UP. Al probarlo se vio que
 * NO FUNCIONABA, y por qué: la fila de `deliveries` no nace cuando se carga
 * la mercancía, sino cuando el cliente firma. `registrarEntrega()` crea la
 * entrega y la cierra en el mismo paso.
 *
 * Es decir: en el momento en que existiría una «entrega en ruta», ya está
 * entregada. Una ruta construida sobre esa tabla mostraría siempre cero
 * paradas, y el repartidor no sabría qué lleva.
 *
 * El documento que SÍ viaja es el albarán. Sus estados ya son exactamente el
 * recorrido de una entrega:
 *
 *   DRAFT     → impreso todavía, en el almacén
 *   PRINTED   → impreso y cargado. VA EN EL CAMIÓN.
 *   SIGNED    → el cliente ya ha firmado
 *   DELIVERED → cerrado. El stock bajó aquí, no antes.
 *
 * La fila de `deliveries` nace en DELIVERED, y entonces sí queda el repartidor
 * que lo dejó (`rep_id`), para cuando un cliente diga que no recibió nada.
 *
 * ── REPARTIR NO ES ENTREGAR ────────────────────────────────────────────────
 *
 * Que el camión haya salido no significa que la mercancía se haya entregado.
 * El stock lo baja la FIRMA, no el botón de «salido». Si se mezclan, el
 * camión vuelve vacío y el sistema cree que todo entregado.
 */

import { ErrorDeInventario } from './inventario.js'

function fallo(mensaje, codigo, estado = 409) {
  return new ErrorDeInventario(mensaje, codigo, estado)
}

/** Los estados de albarán que representan mercancía todavía por entregar. */
export const EN_CAMINO = ['PRINTED', 'SIGNED']

/**
 * LA HOJA DE RUTA. Y son PEDIDOS, no albaranes.
 *
 * Esto cambió, y no es un retoque de estilo. La ruta se armaba sobre
 * `albaranes`, así que para que una parada apareciera había que IMPRIMIR antes:
 * el repartidor no podía ver el trabajo del día si el almacén no había gastado
 * tinta. Y el papel acabó mandando en la operación, que es justo lo contrario
 * de lo que es.
 *
 * Ahora manda el pedido. Un pedido PREPARED o a medias va en la ruta esté o no
 * tenga albarán, y el albarán se pega a la fila con un LEFT JOIN como lo que
 * es: el papel de ese viaje, si es que se llegó a imprimir.
 *
 * `soloPendientes` deja fuera lo entregado: la ruta es una lista de trabajo, no
 * un historial. Lo ya servido se pide aparte.
 */
export async function listarReparto({
  soloPendientes = true, zona = null, limite = 200,
} = {}, tx) {
  // Lo que se puede entregar AHORA. Un RESERVED tiene la mercancía apartada pero
  // aún no se ha cerrado la caja ni se ha impreso: no va en el camión.
  const cond = [soloPendientes
    ? "o.status IN ('PREPARED','IN_ROUTE')"
    : "o.status IN ('PREPARED','IN_ROUTE','DELIVERED')"]
  const p = []
  if (zona) { p.push(zona); cond.push(`z.id = $${p.length}`) }
  p.push(limite)

  return tx.query(
    `SELECT o.id AS pedido_id, o.code AS pedido_code, o.status AS pedido_estado,
            c.id AS cliente_id, c.code AS cliente_code, c.name AS cliente_name,
            c.company_name, c.address, c.phone,
            c.qr_token IS NOT NULL AS tiene_tarjeta,
            z.id AS zona_id, z.name AS zona,
            p.unidades_pendientes, p.lineas_pendientes,
            o.promised_date,
            -- ── ¿DE VERDAD SE PUEDE SERVIR? ──────────────────────────
            --
            -- Un pedido puede estar PREPARED y no tener NI UNA unidad
            -- apartada. Pasa cuando la reserva se liberó por el motivo que
            -- sea, o cuando el pedido se preparó en un entorno y las
            -- reservas se fueron después.
            --
            -- La hoja de ruta lo enseñaba igual, y el repartidor pulsaba
            -- «Entregar» y el servidor le decía «Revisa el stock antes de
            -- confirmar la entrega». El sistema le había prometido una
            -- entrega que después se negaba a hacer, y el repartidor se
            -- quedaba sin saber si el pedido se había entregado o no.
            --
            -- Aquí se cuenta lo que hay REALMENTE apartado. El pedido puede
            -- seguir apareciendo —el cliente sigue debiendo, y hay que
            -- saber de él— pero ya no se presenta como servible.
            --
            COALESCE((SELECT SUM(r.qty) FROM order_reservations r
                       WHERE r.sales_order_id = o.id AND r.status = 'ACTIVE'), 0)
              AS unidades_apartadas,
            (SELECT COUNT(*) FROM order_reservations r
              WHERE r.sales_order_id = o.id AND r.status = 'ACTIVE') AS lineas_apartadas,
            (SELECT COUNT(*) FROM route_notes rn WHERE rn.order_id = o.id) AS intentos_fallidos,
            (SELECT rn.motivo FROM route_notes rn WHERE rn.order_id = o.id
              ORDER BY rn.created_at DESC LIMIT 1) AS ultimo_motivo,
            -- El papel de este viaje, si lo hay. NULL es una respuesta VÁLIDA:
            -- se puede repartir sin haber impreso nada.
            a.id AS albaran_id, a.code AS albaran_code, a.status AS albaran_status,
            a.copies, a.recipient_name, a.printed_at, a.signed_at, a.signed_by_name,
            d.id AS entrega_id, d.code AS entrega_code, d.confirmed_via, d.confirmed_at
       FROM sales_orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN zones z ON z.id = c.zone_id
       -- Cuánto falta de cada pedido, en una subconsulta.
       --
       -- Antes se hacia con JOIN a las lineas mas un GROUP BY, y eso obligaba
       -- a meter en el GROUP BY todas las columnas del albaran y de la
       -- entrega. Ademas, la variable p tambien se usaba para los parametros,
       -- y el mismo nombre para dos cosas distintas. Sumar en un LATERAL
       -- cuesta lo mismo y no obliga a agrupar nada.
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.qty - l.qty_delivered), 0) AS unidades_pendientes,
                COUNT(*) FILTER (WHERE l.qty > l.qty_delivered) AS lineas_pendientes
           FROM sales_order_lines l
          WHERE l.sales_order_id = o.id AND l.qty > l.qty_delivered
       ) p ON true
       -- UNA entrega por fila, y solo UNA. Un LEFT JOIN normal multiplicaba la
       -- fila: un pedido servido en dos tandas sale DOS VECES en la ruta, y el
       -- repartidor va dos veces a la misma puerta.
       LEFT JOIN LATERAL (
         SELECT id, code, confirmed_via, confirmed_at FROM deliveries
          WHERE sales_order_id = o.id
          ORDER BY delivered_at DESC, id DESC
          LIMIT 1
       ) d ON true
       -- Y UN albarán por fila: el último vivo, o el último de todos si ya
       -- no queda ninguno vivo. Sin este LATERAL, un pedido con tres albaranes
       -- —tres visitas— salía tres veces.
       LEFT JOIN LATERAL (
         SELECT id, code, status, copies, recipient_name,
                printed_at, signed_at, signed_by_name
           FROM albaranes
          WHERE sales_order_id = o.id AND status <> 'VOID'
          ORDER BY (status IN ('DRAFT','PRINTED','SIGNED')) DESC, id DESC
          LIMIT 1
       ) a ON true
      WHERE ${cond.join(' AND ')}
      ORDER BY z.name NULLS LAST, c.name, o.code
      LIMIT $${p.length}`,
    p,
  )
}

/** El resumen de arriba, para el móvil del repartidor. */
export async function resumenReparto({ soloPendientes = true } = {}, tx) {
  const filas = await listarReparto({ soloPendientes }, tx)
  return {
    total: filas.length,
    // «En el camión» = lo que está preparado y va entero en una visita.
    en_camion: filas.filter((f) => f.pedido_estado === 'PREPARED').length,
    // «A medias» = ya se sirvió parte y queda resto.
    por_cerrar: filas.filter((f) => f.pedido_estado === 'IN_ROUTE').length,
    // «Con papel impreso» = cuántas paradas llevan ya su albarán. Las demás
    // también se entregan: el papel no es lo que las hace aparecer aquí.
    con_albaran: filas.filter((f) => f.albaran_id).length,
    entregadas: filas.filter((f) => f.pedido_estado === 'DELIVERED').length,
    // Las paradas en las que ya se llamó y no estaba nadie: van a necesitar
    // una segunda visita y conviene saberlo antes de salir.
    intentos_fallidos: filas.filter((f) => Number(f.intentos_fallidos) > 0).length,
    clientes: new Set(filas.map((f) => f.cliente_id)).size,
  }
}

/**
 * Anota que no se pudo entregar. SIN cambiar NADA del estado.
 *
 * La mercancía no vuelve al almacén por escribir un motivo: sigue siendo de la
 * fábrica, y la entrega sigue sin hacerse. El pedido queda exactamente donde
 * estaba. Lo único que se guarda es el PORQUÉ, para no ir tres días seguidos a
 * una puerta cerrada sin saber qué pasa.
 *
 * La nota cuelga del PEDIDO, que es donde ocurrió el hecho. Antes colgaba del
 * albarán, lo que significaba dos cosas raras: que solo se podía anotar si
 * además se había impreso, y que la nota de una visita se guardaba en un
 * documento que el repartidor ni se lleva. Si esa visita tenía albarán, se
 * anota también en su historial —el papel que vuelve sin firmar es una pista
 * más— pero la nota vive en la parada.
 */
export async function anotarNoEntregado(pedidoId, { motivo, usuarioId = null }, tx) {
  if (!motivo || motivo.trim().length < 3) {
    throw fallo('Hay que decir por qué no se pudo entregar', 'FALTA_MOTIVO', 400)
  }
  const o = await tx.one('SELECT id, code, status FROM sales_orders WHERE id = $1', [pedidoId])
  if (!o) throw fallo('Ese pedido no existe', 'PEDIDO_NO_ENCONTRADO', 404)
  if (o.status === 'DELIVERED') {
    throw fallo('Este pedido ya está entregado', 'PEDIDO_YA_ENTREGADO', 409)
  }
  if (o.status === 'CANCELLED') {
    throw fallo('Este pedido está anulado', 'PEDIDO_ANULADO', 409)
  }

  await tx.query(
    `INSERT INTO route_notes (order_id, motivo, user_id) VALUES ($1, $2, $3)`,
    [pedidoId, motivo.trim(), usuarioId],
  )

  // Si esta visita llevaba albarán, se anota en su historial también.
  const a = await tx.one(
    `SELECT id FROM albaranes
      WHERE sales_order_id = $1 AND status IN ('DRAFT','PRINTED')
      ORDER BY id DESC LIMIT 1`, [pedidoId])
  if (a) {
    await tx.query(
      `INSERT INTO albaran_events (albaran_id, event, detail, user_id)
       VALUES ($1, 'NOT_DELIVERED', $2::jsonb, $3)`,
      [a.id, JSON.stringify({ motivo: motivo.trim() }), usuarioId],
    )
    await tx.query(
      `UPDATE albaranes SET observations = COALESCE(observations || E'\\n', '') || $2,
              updated_at = now()
        WHERE id = $1`,
      [a.id, `No entregado: ${motivo.trim()}`],
    )
  }

  return {
    pedido_id: Number(pedidoId),
    pedido_codigo: o.code,
    estado: o.status,          // el MISMO de antes. Nada se movió.
    albaran_anotado: a?.id ?? null,
  }
}

/** Los intentos fallidos de un pedido, del más reciente al más antiguo. */
export async function intentosDeReparto(pedidoId, tx) {
  return tx.query(
    `SELECT rn.motivo, rn.created_at, u.full_name AS usuario
       FROM route_notes rn
       LEFT JOIN users u ON u.id = rn.user_id
      WHERE rn.order_id = $1
      ORDER BY rn.created_at DESC, rn.id DESC`, [pedidoId],
  )
}
