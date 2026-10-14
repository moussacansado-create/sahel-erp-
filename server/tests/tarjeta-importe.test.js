/**
 * LA TARJETA QUE DICE CUÁNTO COBRAR
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * «Si el pedido son 125.000 FCFA, el sistema le tiene que indicar que debe
 * cobrar 125.000 FCFA.»
 *
 * Eso es lo que hace este fichero. Antes, `resolverQr()` devolvía el código
 * del pedido, el estado, las cantidades y qué lleva. **Ni una cifra.** El
 * repartidor escaneaba, veía la lista y entregaba, y el importe looney...
 * no looney. Lo sacaba de donde fuera, y de donde fuera es un sitio donde se
 * equivocan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE NO SE TOCA
 *
 * Una consulta y nada más. La entrega, el albarán, el reparto y el pedido
 * siguen igual. Aquí solo se AÑADE qué tiene que cobrar, y se lee del pedido:
 * no hay forma de que esta cifra y la del cobro sean distintas, porque el
 * cobro se valida contra la misma fila.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-tarjeta-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb } = await import('./banco.js')
const { resolverQr } = await import('../src/core/clientes.js')

let adm, cli, token, art, unidad, lote, pedido

test.before(async () => {
  await baseDePrueba()
  adm = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('tarjeta_admin', 'Administrador', 'x', now()) RETURNING id`)).id
  unidad = (await one(
    `INSERT INTO units (code, name, symbol, dimension)
     VALUES ('UT', 'Unidad', 'u', 'VOLUME') RETURNING id`)).id
  art = (await one(
    `INSERT INTO items (sku, name, category_kind, unit_id, lot_prefix)
     VALUES ('TAR-PT', 'Producto de prueba', 'FINISHED_GOOD', $1, 'TAR') RETURNING id`,
    [unidad])).id
  lote = (await one(
    `INSERT INTO lots (code, item_id, lot_kind, initial_qty, qty_available,
                        unit_id, origin_type, created_by)
     VALUES ('TAR-0001', $1, 'FINISHED_GOOD', 100, 100, $2, 'MANUAL_RECEPTION', $3) RETURNING id`,
    [art, unidad, adm])).id
  cli = (await one(
    `INSERT INTO customers (code, name, qr_token, created_by)
     VALUES ('CLI-TAR', 'Cliente Tarjeta', 'tok-tarjeta-unico', $1) RETURNING id`, [adm])).id
  token = 'tok-tarjeta-unico'
  pedido = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-TAR', $1, 'PREPARED', CURRENT_DATE, 'XOF', 1000, 0.21, 210, 1210, $2)
     RETURNING id`, [cli, adm])).id
  await query(
    `INSERT INTO sales_order_lines
       (sales_order_id, item_id, qty, unit_id, unit_price, tax_rate, line_total)
     VALUES ($1, $2, 10, $3, 100, 0.21, 1210)`, [pedido, art, unidad])
  await query(
    `INSERT INTO order_reservations
       (sales_order_id, order_line_id, item_id, lot_id, qty, unit_id, status)
     SELECT s.sales_order_id, s.id, s.item_id, $2::bigint, 10, $3::bigint, 'ACTIVE'
       FROM sales_order_lines s WHERE s.sales_order_id = $1::bigint`,
    [pedido, lote, unidad])
})
test.after(async () => { await closeDb() })

/**
 * Un pedido que sale en la tarjeta.
 *
 * No basta con insertarlo en `sales_orders`: la tarjeta usa `v_order_progress`,
 * que calcula lo pendiente a partir de las LÍNEAS, y sin líneas ni reserva el
 * pedido no aparece. Era un paso que se olvidaba y el resultado era un test que
 * falla con «undefined» y no dice por qué.
 */
async function pedidoEntregable(codigo, moneda, subtotal, impuesto, total) {
  const o = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ($1, $2, 'PREPARED', CURRENT_DATE, $3, $4, 0.21, $5, $6, $7) RETURNING id`,
    [codigo, cli, moneda, subtotal, impuesto, total, adm])).id
  await query(
    `INSERT INTO sales_order_lines
       (sales_order_id, item_id, qty, unit_id, unit_price, tax_rate, line_total)
     VALUES ($1, $2, 10, $3, 100, 0.21, $4)`, [o, art, unidad, total])
  await query(
    `INSERT INTO order_reservations
       (sales_order_id, order_line_id, item_id, lot_id, qty, unit_id, status)
     SELECT s.sales_order_id, s.id, s.item_id, $2::bigint, 10, $3::bigint, 'ACTIVE'
       FROM sales_order_lines s WHERE s.sales_order_id = $1::bigint`,
    [o, lote, unidad])
  return o
}

const cobrar = (metodo, amount, referencia = null) => query(
  `INSERT INTO payments
     (sales_order_id, customer_id, collected_by, method, amount,
      currency_code, reference, created_by)
   VALUES ($1, $2, $3, $4, $5, 'XOF', $6, $3)`,
  [pedido, cli, adm, metodo, amount, referencia])

const pendienteDe = async () => {
  const f = await resolverQr(token)
  return f.pedidos_pendientes.find((p) => p.order_code === 'PED-TAR')
}

// ═══════════════════════════════════════════════════════════════════════════

test('la tarjeta dice el importe exacto que hay que cobrar', async () => {
  const p = await pendienteDe()
  assert.ok(p, 'el pedido preparado sale en la tarjeta')
  assert.equal(Number(p.importe_pedido), 1210, 'el importe sale del pedido, exacto')
  assert.equal(p.moneda, 'XOF', 'y con su moneda')
  assert.equal(Number(p.pendiente_de_cobro), 1210, 'lo que hay que cobrar ahora')
  assert.equal(p.ya_cobrado, false)
  assert.equal(Number(p.cobros), 0)
})

test('el importe de la tarjeta es EXACTO, no redondeado para enseñarlo', async () => {
  // El importe se guarda y se muestra con cuatro decimales. Un pedido de
  // 983,9355 FCFA tiene que LEERSE 983,9355 en la tarjeta, no 984: la cifra
  // que ve el repartidor es la que se va a cobrar, y si se le enseña otra,
  // cobra otra.
  // 970,65184 tiene CINCO decimales, y la columna es NUMERIC(18,4): la base lo
  // deja en 970,6518. UNA vez, al guardar. Lo que importa no es que conserve
  // cinco decimales —para eso no hay sitio, y no lo vamos a fingir—, sino que
  // lo que se guarda es lo que se enseña y lo que se cobra. Los tres son
  // 970,6518.
  await pedidoEntregable('PED-TAR2', 'XOF', 802.1916, 168.4602, 970.6518)
  const f = await resolverQr(token)
  const p = f.pedidos_pendientes.find((x) => x.order_code === 'PED-TAR2')
  assert.equal(Number(p.importe_pedido), 970.6518,
    'la tarjeta enseña el importe con sus cuatro decimales, no uno redondeado a entero')
  assert.equal(Number(p.pendiente_de_cobro), 970.6518)
  assert.notEqual(Number(p.importe_pedido), 971,
    'ni redondeado al franco entero: lo que se cobra es lo que se ve')
})

test('el pendiente BAJA cuando se cobra, y sube a cero cuando se paga entero', async () => {
  assert.equal(Number((await pendienteDe()).pendiente_de_cobro), 1210)

  await cobrar('CASH', 500)
  const medio = await pendienteDe()
  assert.equal(Number(medio.pendiente_de_cobro), 710, '1210 − 500 = 710')
  assert.equal(medio.ya_cobrado, false, 'todavía no está pagado')
  assert.equal(Number(medio.cobros), 1)

  await cobrar('ORANGE_MONEY', 710, 'OM-99')
  const entero = await pendienteDe()
  assert.equal(Number(entero.pendiente_de_cobro), 0, '1210 − 500 − 710 = 0')
  assert.equal(entero.ya_cobrado, true, 'y la tarjeta lo marca como ya cobrado')
  assert.equal(Number(entero.cobros), 2)
  assert.equal(Number(entero.cobros_por_verificar), 2,
    'y avisa de que los dos siguen SIN VERIFICAR: cobrar no es confirmar')
})

test('un cobro RECHAZADO no descuenta del pendiente', async () => {
  // Un cobro rechazado es un cobro que no ocurrió. Si contara para el
  // pendiente, el repartidor vería que ya está pagado y no cobraría.
  //
  // Y necesita un pedido con SALDO: al principio sólo comprobaba que cobrar más
  // de lo pendiente se rechaza, y no miraba si lo rechazado se devolvía. Con
  // el pedido ya pagado, el cobro ni siquiera llegaba a crearse.
  const oPropio = await pedidoEntregable('PED-RECH', 'XOF', 100, 21, 121)
  const f = await resolverQr(token)
  const pRech = f.pedidos_pendientes.find((x) => x.order_code === 'PED-RECH')
  assert.equal(Number(pRech.pendiente_de_cobro), 121, 'parte de 121 por cobrar')
  const p = (await one(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount,
        currency_code, reference, created_by)
     VALUES ($1,$2,$3,'MOBILE_MONEY',40,'XOF','MM-RECH',$3) RETURNING id`,
    [oPropio, cli, adm]))
  await query(`UPDATE payments SET status = 'REJECTED', rejection_note = $1 WHERE id = $2`,
    ['El cliente dice que no pagó así', p.id])

  const trasRechazar = (await resolverQr(token))
    .pedidos_pendientes.find((x) => x.order_code === 'PED-RECH')
  assert.equal(Number(trasRechazar.pendiente_de_cobro), 121,
    'un cobro RECHAZADO no descuenta: el cliente sigue debiendo 121')
  assert.equal(Number(trasRechazar.cobros), 0, 'y no cuenta como cobro')

  // Y el mismo criterio con el pedido ya pagado, que es donde más se nota.
  const antes = Number((await pendienteDe()).pendiente_de_cobro)
  const despues = await pendienteDe()
  assert.equal(Number(despues.pendiente_de_cobro), antes,
    'un cobro rechazado no resta: no se cobró')
  assert.equal(Number(despues.cobros), 2, 'y tampoco cuenta como cobro')
})

test('la tarjeta NO trae un importe que nadie pueda cambiar', async () => {
  //
  // La prueba que de verdad importa: que no exista ningún camino por el que la
  // cifra de la tarjeta se pueda separar de la del pedido.
  //
  // Se comprueba de dos formas: leyendo el código, para ver que no hay un
  // parámetro que la modifique, y la segunda es la de la tarjeta contra el
  // cobro —que es la que importa de verdad— en la base de pagos.
  //
  const f = await resolverQr(token)
  const p = f.pedidos_pendientes.find((x) => x.order_code === 'PED-TAR')

  // El importe de la tarjeta ES el del pedido. Literalmente el mismo número.
  const enPedido = (await one(`SELECT total FROM sales_orders WHERE id = $1`, [p.order_id])).total
  assert.equal(Number(p.importe_pedido), Number(enPedido),
    'la tarjeta lee la fila del pedido, no lleva su propia cifra')

  // Y el cobro se valida contra ESA MISMA fila. Cobrar de más se rechaza, que
  // es lo que impide que la tarjeta y el cobro se separen.
  //
  // El pedido ya está pagado del todo en la prueba anterior, así que su
  // pendiente es CERO: cualquier cobro, por pequeño que sea, es de más. Es el
  // caso más fuerte: si el sistema aceptara un céntimo con el pedido ya
  // saldado, es que no está mirando el pedido.
  const pendienteReal = (await one(
    `SELECT COALESCE(total,0) - COALESCE(
       (SELECT SUM(amount) FROM payments
         WHERE sales_order_id = $1 AND status <> 'REJECTED'), 0) AS p
       FROM sales_orders WHERE id = $1`, [p.order_id])).p
  assert.equal(Number(pendienteReal), 0, 'el pedido de esta prueba ya está pagado')

  await assert.rejects(
    () => query(
      `INSERT INTO payments
         (sales_order_id, customer_id, collected_by, method, amount,
          currency_code, reference, created_by)
       VALUES ($1,$2,$3,'BANK_TRANSFER',1,'XOF','TRF-1',$3)`,
      [p.order_id, cli, adm]),
    (e) => /le quedan 0(\.0+)? por pagar/i.test(e.message),
    'un céntimo sobre un pedido ya saldado, y la base lo para — y el mensaje DICE que no le queda nada',
  )
})

test('tampoco con un cobro SIN entrega se puede pasar de lo que se debe', async () => {
  //
  // Este hueco lo encontró esta misma prueba.
  //
  // La comprobación de «no cobres más de lo que llevas» estaba metida dentro
  // de «si la entrega viene», con la idea de que sin entrega es alguien
  // cobrando en la puerta de la tienda y que ahí una seña es legítima. La
  // idea es buena; el límite estaba mal puesto.
  //
  // Con la condición, un cobro SIN entrega se saltaba la comprobación entera:
  // 500 000 FCFA sobre un pedido de 1210, y nadie se enteraba.
  //
  // Una seña es un pago PARCIAL, y un pago parcial es menor que el total. La
  // misma regla cubre los dos casos, sin excepciones.
  //
  const nuevo = await pedidoEntregable('PED-SIN-ENT', 'XOF', 100, 21, 121)
  await assert.rejects(
    () => query(
      `INSERT INTO payments
         (sales_order_id, customer_id, collected_by, method, amount,
          currency_code, created_by)
       VALUES ($1,$2,$3,'CASH',500000,'XOF',$3)`, [nuevo, cli, adm]),
    (e) => /le quedan 121.0000 por pagar/i.test(e.message),
    '500 000 sobre un pedido de 121, sin entrega: rechazado igual',
  )
})

test('la tarjeta no enseña un importe en una moneda que no es la del pedido', async () => {
  // Un pedido en euros se enseña en euros, y el cobro en euros. Ni una palabra
  // de francos: mezclar es exactamente la cuenta paralela que no se quiere.
  const eur = await pedidoEntregable('PED-EUR', 'EUR', 100, 21, 121)
  const f = await resolverQr(token)
  const p = f.pedidos_pendientes.find((x) => x.order_code === 'PED-EUR')
  assert.equal(p.moneda, 'EUR', 'el pedido en euros se enseña en euros')
  assert.equal(Number(p.importe_pedido), 121)

  // Y cobrarlo en francos no se puede ni intentar.
  await assert.rejects(
    () => query(
      `INSERT INTO payments
         (sales_order_id, customer_id, collected_by, method, amount,
          currency_code, created_by)
       VALUES ($1,$2,$3,'CASH',121,'XOF',$3)`, [eur, cli, adm]),
    (e) => /Un cobro no convierte/i.test(e.message),
  )
})
