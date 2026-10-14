/**
 * COBROS, CAJA Y ALERTAS — LAS REGLAS DEL DINERO, EN LA BASE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ ESTAS PRUEBAS SON CASI TODAS «A LA BASE» Y NO A LA API
 *
 * Porque la regla del negocio no es «el repartidor registra el importe que le
 * dicen», es «el importe sale del pedido y nadie lo puede cambiar». Y esa regla,
 * escrita en el código, se rompe el día que alguien escribe un endpoint nuevo.
 *
 * Escrita como un CHECK o como un disparador, no. Estas pruebas lo comprueban
 * intentando lo contrario y esperando que la base lo rechace.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE SE COMPRUEBA, Y POR QUÉ CADA COSA
 *
 *   1 · No se cobra más de lo que el pedido dice
 *   2 · No se cobra en una moneda que no es la del pedido
 *   3 · Un doble toque no cobra dos veces
 *   4 · Un pago por móvil necesita referencia o comprobante
 *   5 · Un cobro no se verifica sin decir QUIÉN y CUÁNDO
 *   6 · `expected_amount` lo calcula la base, no quien escribe
 *   7 · El saldo del repartidor se DERIVA, no se guarda
 *   8 · Una diferencia sin explicación no se puede registrar
 *   9 · Las alertas miran los datos de verdad
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-cobros-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const { hashPassword } = await import('../src/security/passwords.js')

let adm, cli, lote, pedido, entrega, repartidor, cajero

//
// `baseDePrueba()` levanta el ESQUEMA, no los datos de demostración. Aquí no
// existe ningún `reparto` ni ningún `contabilidad`, y buscarlo devuelve
// `undefined` sin decir nada, que es una forma de perder media tarde.
//
// El reparto y la caja NECESITAN dos personas distintas, porque todo el
// circuito de dinero se apoya en que «quien cobra» y «quien recibe» no son el
// mismo. Crear un usuario y usarlo para los dos dos sería una prueba que pasa
// sin comprobar lo que dice comprobar.
//
async function crearUsuario(username, rol) {
  const u = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [username, username.toUpperCase(), await hashPassword(`${username}-prueba-1`)])).id
  const r = (await one(`SELECT id FROM roles WHERE code = $1`, [rol])).id
  await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [u, r])
  return u
}

test.before(async () => {
  await baseDePrueba()
  adm = await crearUsuario('cob_admin', 'ADMIN')
  repartidor = await crearUsuario('cob_repartidor', 'DELIVERY')
  cajero = await crearUsuario('cob_cajero', 'ACCOUNTING')
  cli = (await one(
    `INSERT INTO customers (code, name, qr_token, created_by)
     VALUES ('CLI-COB', 'Cliente de Cobros', 'tok-cobros-prueba', $1) RETURNING id`, [adm])).id
  // Tampoco hay artículos: la prueba crea los suyos, con su unidad y su lote.
  // Un cobro necesita un pedido que tenga mercancía detrás, y para eso hace
  // falta stock real — que además no se inventa.
  const unidad = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id
  const art = (await one(
    `INSERT INTO items (sku, name, category_kind, unit_id, lot_prefix)
     VALUES ('COB-PT', 'Producto para cobros', 'FINISHED_GOOD', $1, 'COB') RETURNING id`,
    [unidad])).id
  lote = (await one(
    `INSERT INTO lots (code, item_id, lot_kind, initial_qty, qty_available, unit_id, origin_type, created_by)
     VALUES ('COB-0001', $1, 'FINISHED_GOOD', 100, 100, $2, 'MANUAL_RECEPTION', $3) RETURNING id`,
    [art, unidad, adm])).id
  lote = { id: lote, item: art, unit_id: unidad }

  pedido = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-COB', $1, 'CONFIRMED', CURRENT_DATE, 'XOF', 1000, 0.21, 210, 1210, $2)
     RETURNING id`, [cli, adm])).id
  await query(
    `INSERT INTO sales_order_lines
       (sales_order_id, item_id, qty, unit_id, unit_price, tax_rate, line_total)
     VALUES ($1, $2, 10, $3, 100, 0.21, 1210)`, [pedido, lote.item, lote.unit_id])
  entrega = (await one(
    `INSERT INTO deliveries (code, sales_order_id, rep_id, status, created_by)
     VALUES ('ENT-COB', $1, $2, 'DELIVERED', $3) RETURNING id`,
    [pedido, repartidor, repartidor])).id
})
test.after(async () => { await closeDb() })

/**
 * Cobra del pedido de la prueba.
 *
 * El importe por defecto es 710, que es lo que le queda después de que la
 * prueba 1 cobrara 500. Con la regla nueva —que compara contra lo que FALTA y
 * no contra el total— un cobro a ciegas del total falla en cuanto el pedido
 * está pagado, y eso es lo correcto: un test que quiera cobrar el total tiene
 * que decirlo.
 */
const cobrar = (extra = {}) => query(
  `INSERT INTO payments
     (sales_order_id, delivery_id, customer_id, collected_by,
      method, amount, currency_code, reference, created_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [pedido, extra.sinEntrega ? null : entrega, cli, repartidor,
    extra.method || 'CASH', extra.amount ?? 710, extra.moneda || 'XOF',
    extra.reference || null, repartidor])

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EL IMPORTE VIENE DEL PEDIDO
// ═══════════════════════════════════════════════════════════════════════════

test('1 · el repartidor NO puede cobrar más de lo que lleva', async () => {
  // El pedido vale 1210. Un cobro de 5000 es imposible, y no lo dice el backend:
  // lo dice un disparador, que es lo único que no se puede saltar.
  await assert.rejects(
    () => cobrar({ amount: 5000 }),
    (e) => /le quedan 1210\.0000 por pagar/i.test(e.message),
    'la base tiene que rechazar el cobro de más, con su explicación',
  )

  // Y uno de menos sí vale: cobrar una parte es legítimo (una seña, por ejemplo).
  const p = await cobrar({ amount: 500 })
  assert.ok(p[0].id, 'un cobro parcial es legítimo')
})

test('2 · un cobro no convierte de moneda', async () => {
  // El pedido está en XOF. Registrar el cobro en EUR inventaría una conversión
  // que nadie ha hecho, y es exactamente la cuenta paralela que se quiere evitar.
  await assert.rejects(
    () => cobrar({ method: 'BANK_TRANSFER', amount: 1210, moneda: 'EUR' }),
    (e) => /Un cobro no convierte/i.test(e.message),
  )
})

test('3 · un doble toque no cobra dos veces', async () => {
  // Lo normal en la calle, con la pantalla mojada. Un UNIQUE en la base, no un
  // botón desactivado: el botón desaparece con la red; la restricción no.
  const nuevo = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-DOBLE', $1, 'CONFIRMED', CURRENT_DATE, 'XOF', 100, 0.21, 21, 121, $2)
     RETURNING id`, [cli, adm])).id
  const ent = (await one(
    `INSERT INTO deliveries (code, sales_order_id, rep_id, status, created_by)
     VALUES ('ENT-DOBLE', $1, $2, 'DELIVERED', $3) RETURNING id`,
    [nuevo, repartidor, repartidor])).id

  const meter = () => query(
    `INSERT INTO payments
       (sales_order_id, delivery_id, customer_id, collected_by,
        method, amount, currency_code, created_by)
     VALUES ($1,$2,$3,$4,'CASH',60,'XOF',$5)`, [nuevo, ent, cli, repartidor, repartidor])

  await meter()
  await assert.rejects(() => meter(), (e) => /duplicate key/i.test(e.message),
    'el segundo toque tiene que rebotar en la base')

  const n = (await one(`SELECT count(*)::int AS n FROM payments WHERE sales_order_id = $1`, [nuevo])).n
  assert.equal(n, 1, 'y solo queda UN cobro, no dos')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · LA REGLA DEL COMPROBANTE
// ═══════════════════════════════════════════════════════════════════════════

test('4 · un pago por móvil necesita referencia o comprobante', async () => {
  // «Comprobante recibido ≠ pago confirmado» empieza aquí: sin referencia ni
  // comprobante, «cobré por Orange Money» es una frase, y el cajero no tiene
  // nada contra lo que comparar cuando le dan el dinero.
  await assert.rejects(
    () => cobrar({ method: 'ORANGE_MONEY' }),
    (e) => /chk_pago_movil_necesita_identificacion/.test(e.message),
  )

  // Con referencia, sí. Y entra como PENDING: pendiente, no confirmado.
  const p = (await cobrar({ method: 'ORANGE_MONEY', reference: 'OM-1' }))[0]
  const fila = await one(`SELECT status FROM payments WHERE id = $1`, [p.id])
  assert.equal(fila.status, 'PENDING', 'nace PENDING: un comprobante no confirma un pago')
})

test('5 · un cobro no se verifica sin decir QUIÉN y CUÁNDO', async () => {
  // En un pedido con SALDO. El de la prueba 1 está ya pagado, y con la regla
  // nueva —que compara contra lo que FALTA, no contra el total— un segundo
  // cobro sobre un pedido saldado ni siquiera llega a crearse.
  const conSaldo = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-VERIF', $1, 'CONFIRMED', CURRENT_DATE, 'XOF', 100, 0.21, 21, 121, $2)
     RETURNING id`, [cli, adm])).id
  const p = (await query(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount,
        currency_code, reference, created_by)
     VALUES ($1,$2,$3,'MOBILE_MONEY',121,'XOF','MM-1',$4) RETURNING id`,
    [conSaldo, cli, repartidor, repartidor]))[0]

  await assert.rejects(
    () => query(`UPDATE payments SET status = 'VERIFIED' WHERE id = $1`, [p.id]),
    (e) => /chk_payment_verificado/.test(e.message),
    'no se puede verificar a escondidas',
  )

  await query(
    `UPDATE payments SET status = 'VERIFIED', verified_by = $1, verified_at = now()
      WHERE id = $2`, [cajero, p.id])
  const f = await one(`SELECT status, verified_by FROM payments WHERE id = $1`, [p.id])
  assert.equal(f.status, 'VERIFIED')
  assert.equal(f.verified_by, cajero, 'y se sabe quién lo verificó')
})

test('5b · un cobro rechazado tiene que decir por qué', async () => {
  // Otra entrega: el UNIQUE (delivery_id, method) impide cobrar dos veces en
  // efectivo la MISMA entrega, y es justo lo que hay que comprobar aquí no.
  const propio = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-REC', $1, 'CONFIRMED', CURRENT_DATE, 'XOF', 1000, 0.21, 210, 1210, $2)
     RETURNING id`, [cli, adm])).id
  const ent2 = (await one(
    `INSERT INTO deliveries (code, sales_order_id, rep_id, status, created_by)
     VALUES ('ENT-REC', $1, $2, 'DELIVERED', $3) RETURNING id`,
    [propio, repartidor, repartidor])).id
  const p = (await query(
    `INSERT INTO payments
       (sales_order_id, delivery_id, customer_id, collected_by,
        method, amount, currency_code, reference, created_by)
     VALUES ($1,$2,$3,$4,'MOBILE_MONEY',300,'XOF','MM-REC',$5) RETURNING id`,
    [propio, ent2, cli, repartidor, repartidor]))[0]
  await assert.rejects(
    () => query(`UPDATE payments SET status = 'REJECTED' WHERE id = $1`, [p.id]),
    (e) => /chk_payment_rechazado/.test(e.message),
    '«rechazado» sin motivo no dice nada a nadie',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · CAJA
// ═══════════════════════════════════════════════════════════════════════════

test('6 · el importe esperado lo calcula la BASE, no quien lo escribe', async () => {
  // La columna estaba documentada como derivada y no había disparador que la
  // derivara: se podía escribir 999 a mano y nadie se enteraba. Un campo que
  // miente en silencio es peor que no tenerlo.
  // la vez— y lo que entrega a caja es la suma de todos los que aún no ha
  // entregado. Por eso el importe esperado no es «el de este pedido».
  //
  const h = (await one(
    `INSERT INTO cash_handoffs (handed_by, received_by, currency_code, expected_amount, created_by)
     VALUES ($1, $2, 'XOF', 999, $3) RETURNING id, expected_amount`,
    [repartidor, cajero, cajero]))

  const real = (await one(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payments
      WHERE collected_by = $1 AND status <> 'REJECTED'
        AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = payments.id)`,
    [repartidor])).s

  assert.equal(Number(h.expected_amount), Number(real),
    'lo que escribió el repartidor (999) se ignora: se guarda lo que de verdad había cobrado')
  assert.notEqual(Number(h.expected_amount), 999)
})

test('7 · tras entregar todo, su saldo derivado llega a cero SOLO', async () => {
  //
  // TODO EN UNA TRANSACCIÓN, Y RECIBIDO ANTES DE ENLAZAR.
  //
  // Enlazar un cobro exige que su traspaso esté recibido —dar el dinero por
  // entregado antes de recibirlo es justo lo que no se quiere—, así que el
  // orden es: se recibe primero, se enlaza después. Con sentencias sueltas el
  // enlace rebotaba contra la regla que esta misma prueba está comprobando, y
  // el error que salía no era el del saldo.
  //
  await transaction(async (tx) => {
    const h = (await tx.one(
      `INSERT INTO cash_handoffs (handed_by, received_by, currency_code, created_by)
       VALUES ($1, $2, 'XOF', $3) RETURNING id`,
      [repartidor, cajero, cajero])).id
    await tx.query(
      `UPDATE cash_handoffs
          SET received_at = now(), received_amount = expected_amount,
              status = 'RECONCILED'
        WHERE id = $1`, [h])
    const cobros = await tx.query(
      `SELECT id FROM payments
        WHERE collected_by = $1 AND status <> 'REJECTED'
          AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = payments.id)`,
      [repartidor])
    for (const c of cobros) {
      await tx.query(`INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)`,
        [c.id, h])
    }
  })
  const d = await one('SELECT en_su_poder FROM v_deuda_repartidor WHERE user_id = $1', [repartidor])
  assert.equal(Number(d.en_su_poder), 0,
    'cuando ha entregado todo lo que cobró, su saldo derivado es cero — sin escribir nada')
})

test('8 · una entrega que no cuadra necesita su explicación', async () => {
  //
  // En UNA transacción, y con el traspaso RECIBIDO antes de enlazar.
  //
  // Ahora enlazar un cobro exige que su traspaso esté recibido —dar el dinero
  // por entregado antes de recibirlo es lo que no se quiere—, así que la
  // prueba tiene que hacer las dos cosas en el mismo acto. Con sentencias
  // sueltas, el enlace rebotaba contra la regla que esta misma prueba está
  // comprobando, y el error que salía no era el del descuadre.
  //
  await assert.rejects(
    () => transaction(async (tx) => {
      const h = (await tx.one(
        `INSERT INTO cash_handoffs (handed_by, received_by, currency_code, created_by)
         VALUES ($1, $2, 'XOF', $3) RETURNING id`, [repartidor, cajero, cajero])).id
      await tx.query(
        `UPDATE cash_handoffs
            SET received_at = now(), received_amount = 500, expected_amount = 1210,
                status = 'DISCREPANCY'
          WHERE id = $1`, [h])
    }),
    (e) => /chk_handoff_discrepancy/.test(e.message),
    '«faltan 710» sin escribirlo no sirve de nada',
  )

  // Con la explicación, sí. Y la diferencia queda guardada.
  // Antes, un cobro nuevo SIN entregar, en un pedido con saldo: si no, el
  // repartidor ya no lleva nada y lo esperado sería 0 —que es lo correcto, pero
  // no prueba nada.
  const dif = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-DIF', $1, 'CONFIRMED', CURRENT_DATE, 'XOF', 500, 0.21, 105, 605, $2)
     RETURNING id`, [cli, adm])).id
  const ent3 = (await one(
    `INSERT INTO deliveries (code, sales_order_id, rep_id, status, created_by)
     VALUES ('ENT-DIF', $1, $2, 'DELIVERED', $3) RETURNING id`,
    [dif, repartidor, repartidor])).id
  await query(
    `INSERT INTO payments
       (sales_order_id, delivery_id, customer_id, collected_by,
        method, amount, currency_code, created_by)
     VALUES ($1,$2,$3,$4,'CASH',600,'XOF',$5)`,
    [dif, ent3, cli, repartidor, repartidor])

  // Se escriben las dos cifras a propósito, y las dos a la vez: el importe
  // esperado se calcula y la diferencia también. Lo que se escribe y no se usa
  // es la diferencia: si se pudiera poner a mano, un signo equivocado haría que
  // la conciliación dijera lo contrario de lo que pasó.
  //
  // Y lo esperado NO se fija a ojo: la prueba lo calcula con la MISMA cuenta
  // que debería usar la base, y compara. Fijar un número en el test es
  // comprobar que 2+2=4 escribiendo «espero 4»: no dice nada de quién lo
  // calculó.
  //
  // El repartidor lleva cobros de VARIOS pedidos —cobra para varios clientes a

  const esperadoReal = (await one(
    `SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p
      WHERE p.collected_by = $1 AND p.status <> 'REJECTED' AND p.currency_code = 'XOF'
        AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = p.id)`,
    [repartidor])).s
  //
  // Y que NO sea el total de este pedido. Aquí coinciden, porque el repartidor
  // ya entregó todo lo anterior y solo le queda este cobro. Si mañana llevara
  // dos, el mismo código seguiría dando la suma: eso es lo que se está
  // probando, no el número de hoy.
  //
  assert.equal(Number(esperadoReal), 600,
    'lo pendiente del repartidor es la suma de sus cobros sin entregar')

    //
    // En una transacción, recibido antes de enlazar, y con los cobros detrás.
    //
    // Lo de escribir las dos cifras y el 99999 sigue igual de tonto a
    // propósito: se escriben para que se vea que la base las rehace. Y ahora
    // además se enlaza el cobro, porque un traspaso recibido sin cobros detrás
    // es uno de los agujeros que este punto cerró.
    //
    const h = (await transaction(async (tx) => {
      const t = (await tx.one(
        `INSERT INTO cash_handoffs
           (handed_by, received_by, received_at, received_amount,
            currency_code, expected_amount, status, note, difference, created_by)
         VALUES ($1,$2,now(),500,'XOF',605,'DISCREPANCY',$3,99999,$4)
         RETURNING id, expected_amount, difference, status`,
        [repartidor, cajero, 'Faltan 110', cajero]))
      const suyos = await tx.query(
        `SELECT id FROM payments
          WHERE collected_by = $1 AND status <> 'REJECTED'
            AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = payments.id)`,
        [repartidor])
      for (const c of suyos) {
        await tx.query(
          `INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)`, [c.id, t.id])
      }
      return t
    }))
  assert.equal(h.status, 'DISCREPANCY')
  assert.equal(Number(h.expected_amount), Number(esperadoReal),
    'lo esperado lo calcula la base, y coincide con la misma cuenta hecha aparte')
  //
  // Y que la diferencia venga del número DERIVADO. El cajero escribió 605 y
  // recibió 500: si la diferencia saliera de lo que escribió, sería -105, que
  // cuadra contra una cifra inventada. Sale de lo que la base derivó, -100, y
  // por eso encaja.
  //
  assert.equal(Number(h.difference), 500 - Number(h.expected_amount),
    'la diferencia sale del importe derivado, no del 605 que escribió el cajero')
  assert.equal(Number(h.difference), -100, '500 recibidos sobre 600 esperados')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · LAS ALERTAS, QUE NO EXISTÍAN
// ═══════════════════════════════════════════════════════════════════════════

test('9 · un lote por debajo del mínimo sale en la alerta', async () => {
  // El plan original pedía «alertas reales para stock mínimo». El catálogo
  // llevaba `min_stock` desde el principio y NADIE miraba la columna.
  await query(`UPDATE items SET min_stock = 999999 WHERE id = $1`, [lote.item])

  const alerta = await one(
    `SELECT * FROM v_alertas_activas WHERE kind = 'STOCK_MINIMO' AND label = (SELECT sku FROM items WHERE id = $1)`,
    [lote.item])
  assert.ok(alerta, 'tiene que salir: se piden 999999 y hay 100')
  // Nivel 2: queda algo, pero menos de la mitad de lo pedido. El 3 es para
  // cuando no queda NADA, y con 100 unidades no es el caso.
  assert.equal(Number(alerta.severity), 2, 'nivel 2: hayExistencia, pero es una fracción del mínimo')
  assert.match(alerta.detail, /Quedan/)

  // Y a cero, nivel 3. La distinción entre «faltan 20» y «no hay nada» es la
  // que hace que la alerta sea accionable.
  await query(`UPDATE lots SET qty_available = 0 WHERE item_id = $1`, [lote.item])
  const critico = await one(
    `SELECT severity FROM v_alertas_activas WHERE kind = 'STOCK_MINIMO' AND label = (SELECT sku FROM items WHERE id = $1)`,
    [lote.item])
  assert.equal(Number(critico.severity), 3, 'a cero, crítico')
  await query(`UPDATE lots SET qty_available = 100 WHERE item_id = $1`, [lote.item])
})

test('10 · un lote caducado avisa, y uno que caduca pronto también', async () => {
  const l1 = lote.id
  const l2 = (await one(
    `INSERT INTO lots (code, item_id, lot_kind, initial_qty, qty_available, unit_id, origin_type, created_by)
     VALUES ('COB-0002', $1, 'FINISHED_GOOD', 50, 50, $2, 'MANUAL_RECEPTION', $3) RETURNING id`,
    [lote.item, lote.unit_id, adm])).id
  await query(`UPDATE lots SET expiry_date = CURRENT_DATE - 3 WHERE id = $1`, [l1])
  await query(`UPDATE lots SET expiry_date = CURRENT_DATE + 5 WHERE id = $1`, [l2])

  const pasado = await one(`SELECT * FROM v_alertas_activas WHERE label = (SELECT code FROM lots WHERE id = $1)`, [l1])
  const pronto = await one(`SELECT * FROM v_alertas_activas WHERE label = (SELECT code FROM lots WHERE id = $1)`, [l2])

  assert.ok(pasado, 'un lote caducado avisa')
  assert.equal(Number(pasado.severity), 3, 'y es crítico')
  assert.match(pasado.detail, /CADUCADO hace 3/)
  assert.ok(pronto, 'uno que caduca en 5 días también avisa: hay tiempo para reponer')
})

test('11 · la severidad es un NIVEL, no una cantidad', async () => {
  // La primera versión devolvía «cuánto falta» en la columna de severidad:
  // un nivel que vale 4850.0000 no es un nivel, y ordenar por él ordena por
  // unidades equivocadas. Además «faltan 20» y «no hay nada» se confundían.
  const todas = await query(`SELECT severity, detail FROM v_alertas_activas`)
  for (const a of todas) {
    assert.ok([1, 2, 3].includes(Number(a.severity)),
      `severity ${a.severity} no es un nivel (1/2/3): «${a.detail}»`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · LO QUE SE MATÓ
// ═══════════════════════════════════════════════════════════════════════════

test('12 · `expenses` ya no tiene su propio interruptor de pagado', async () => {
  // Un gasto con `amount` y `paid` en la misma tabla es un sistema paralelo:
  // nadie lo mantiene, y un día un gasto dirá que está pagado y el cobro no
  // existirá. Un gasto se paga con un pago real, en `payments`.
  const col = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'expenses' AND column_name = 'paid'`)
  assert.equal(col.length, 0, 'la columna `paid` tiene que estar eliminada')
})
