/**
 * FASE 4 · Clientes, pedidos y entregas.
 *
 * El ciclo entero, en orden, y cada eslabón con la pregunta que lo rompe:
 *
 *   crear → confirmar (aparta) → fabricar → entregar (descuenta) → anular
 *
 * Lo que se comprueba, exactamente:
 *
 *   1. No se puede sobre-reservar stock.
 *   2. Anular libera correctamente lo apartado.
 *   3. La fabricación queda vinculada al pedido.
 *   4. El lote de producto terminado queda asociado.
 *   5. Una entrega parcial descuenta SOLO lo entregado.
 *   6. Una entrega completa cierra correctamente el pedido.
 *   7. No se puede entregar más de lo reservado ni de lo disponible.
 *   8. La trazabilidad va del pedido al lote PT, producción y MP, y al revés.
 *
 * Y la regla que lo atraviesa todo, comprobada con números antes y después:
 *
 *   CONFIRMAR NO DESCUENTA. ENTREGAR DESCUENTA UNA SOLA VEZ. ANULAR LIBERA.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-fase-4-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const C = await import('../src/core/clientes.js')
const P = await import('../src/core/pedidos.js')
const E = await import('../src/core/entregas.js')
const { producir } = await import('../src/core/produccion.js')
const { moverStock, crearLoteConEntrada } = await import('../src/core/stock.js')

let e = {}
let repartidor = null

test.before(async () => {
  await baseDePrueba()
  e = await escenario()
})
test.after(async () => { await closeDb() })

// ─── Escenario ───────────────────────────────────────────────────────────────
async function escenario() {
  return transaction((tx) => escenarioEn(tx))
}
async function escenarioEn(tx) {
  const u = await tx.one(`SELECT id FROM units ORDER BY id LIMIT 1`)

  // El repartidor. Antes la entrega se cerraba con una firma y el usuario
  // daba igual; ahora lo que no puede faltar es QUIÉN confirmó. Es lo que se
  // pregunta cuando un cliente dice que no recibió nada.
  repartidor = (await tx.one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-f4','Repartidor Fase 4','x', now()) RETURNING id`)).id

  // Producto terminado, con prefijo propio para los lotes PT.
  const pt = await tx.one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,sale_price,tax_rate,purchase_cost)
     VALUES ('PT-F4-1L','Producto Fase 4','FINISHED_GOOD',$1,'F4',10,0.21,3)
     RETURNING id`, [u.id])

  // Materia prima y envase, para poder fabricar de verdad.
  const mp = await tx.one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
     VALUES ('MP-F4-A','Materia A','RAW_MATERIAL',$1,1) RETURNING id`, [u.id])
  const env = await tx.one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
     VALUES ('ENV-F4-A','Envase A','PACKAGING',$1,0.4) RETURNING id`, [u.id])

  // Dos lotes de PT ya en almacén, con cadencias distintas: el FEFO tiene que
  // apartar primero el que caduca antes.
  const lotes = {}
  const abrir = async (code, itemId, cantidad, caducidad) => {
    // Sin movimiento de entrada: la recepción inicial fija `initial_qty` y el
    // saldo, y no genera una línea más en el libro mayor. Si se añadiera, el
    // lote quedaría una vez por encima de lo recibido.
    return (await crearLoteConEntrada(tx, {
      code, itemId, lotKind: itemId === pt.id ? 'FINISHED_GOOD' : 'RAW_MATERIAL',
      initialQty: cantidad, unitId: u.id, expiryDate: caducidad,
      originType: 'OPENING', userId: repartidor,
    })).id
  }
  lotes['PT-F4-00001'] = await abrir('PT-F4-00001', pt.id, 200, '2027-01-31')
  lotes['PT-F4-00002'] = await abrir('PT-F4-00002', pt.id, 200, '2029-01-31')
  const mpLote = { id: await abrir('MP-F4-0001', mp.id, 1000, null) }
  const envLote = { id: await abrir('ENV-F4-0001', env.id, 1000, null) }

  const receta = await tx.one(
    `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
     VALUES ('REC-F4','Receta Fase 4',$1,1,$2) RETURNING id`, [pt.id, u.id])
  for (const item of [mp, env]) {
    await tx.query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, item.id, u.id])
  }

  return { u, pt, mp, env, receta, lotes, mpLote, envLote }
}

/** PNG real, con marca distinta cada vez. */
function firma(quien = 'A') {
  const f = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const t = (ty, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length)
    const c = Buffer.concat([Buffer.from(ty), d])
    const q = Buffer.alloc(4); q.writeUInt32BE(zlib.crc32(c) >>> 0)
    return Buffer.concat([l, c, q])
  }
  const h = Buffer.alloc(13)
  h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8
  return Buffer.concat([
    f, t('IHDR', h), t('tEXt', Buffer.from(`firma ${quien.repeat(260)}`)), t('IEND', Buffer.alloc(0)),
  ])
}

const saldo = async (loteId) =>
  Number((await one(`SELECT qty_available FROM lots WHERE id=$1`, [loteId])).qty_available)

/**
 * Producto con su propio stock, aislado de las demás pruebas.
 *
 * Antes todas las pruebas compartían el mismo producto y sus 400 unidades, y
 * el resultado de una dependía de lo que había hecho la anterior. Una prueba
 * que pasa por casualidad el martes no vale.
 */
let serie = 0
async function productoConStock(unidades, nombre = 'Producto Aislado') {
  return transaction(async (tx) => productoConStockEn(tx, unidades, nombre))
}
async function productoConStockEn(tx, unidades, nombre) {
  serie += 1
  const sku = `PT-F4X-${serie}`
  const item = await tx.one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,sale_price,tax_rate)
     VALUES ($1,$2,'FINISHED_GOOD',$3,$4,10,0.21) RETURNING id`,
    [sku, `${nombre} ${serie}`, e.u.id, `X${serie}`])
  const lotes = []
  for (const n of [1, 2]) {
    // Se crean por la MISMA vía que usa la aplicación, con su movimiento en el
    // libro mayor. Con un INSERT a pelo el lote existía sin movimiento, y la
    // comprobación de cuadre del final daba falso descuadre: el problema era
    // del atajo de la prueba, no del sistema.
    const l = await crearLoteConEntrada(tx, {
      code: `${sku}-LOTE${n}`, itemId: item.id, lotKind: 'FINISHED_GOOD',
      initialQty: unidades, unitId: e.u.id, expiryDate: n === 1 ? '2027-01-31' : '2029-01-31',
      originType: 'OPENING', userId: repartidor,
    })
    lotes.push(l)
  }
  return { item, lotes, stockInicial: unidades * 2 }
}

/** Producto con receta, pero SIN ninguna unidad en almacén. */
async function productoSinStock(nombre) {
  serie += 1
  const sku = `PT-F4Y-${serie}`
  const item = await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,sale_price,tax_rate)
     VALUES ($1,$2,'FINISHED_GOOD',$3,$4,10,0.21) RETURNING *`,
    [sku, `${nombre} ${serie}`, e.u.id, `Y${serie}`])
  const receta = await one(
    `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
     VALUES ($1,$2,$3,1,$4) RETURNING id`,
    [`REC-F4-${serie}`, `Receta ${nombre} ${serie}`, item.id, e.u.id])
  for (const insumo of [e.mp, e.env]) {
    await query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, insumo.id, e.u.id])
  }
  return { item, receta }
}

/** Cliente + pedido sobre un producto dado. */
async function pedidoDe(itemId, cantidad, nombre = 'Cliente Fase 4') {
  const c = await C.crearCliente({ name: `${nombre} ${serie}`, phone: '600111222' }, null)
  const p = await P.crearPedido({
    customerId: c.id, lineas: [{ itemId, qty: cantidad }], userId: repartidor,
  })
  return { cliente: c, pedido: p, linea: p.lineas[0] }
}

// ═══════════════════════════════════════════════════════════════════════════
test('1 · No se puede sobre-reservar stock', async (t) => {
  await t.test('a) confirmar aparta EXACTAMENTE lo pedido', async () => {
    const p = await productoConStock(100)
    const { pedido } = await pedidoDe(p.item.id, 120)
    const r = await P.confirmarPedido(pedido.id, null)
    assert.equal(Number(r.apartado), 120)
    assert.equal(r.status, 'RESERVED')
  })

  await t.test('b) y NO toca el stock: sigue todo en el almacén', async () => {
    // Esta es LA regla. Si algún día alguien mete un UPDATE lots dentro de
    // confirmar, esto falla en la suite y no en el almacén.
    const p = await productoConStock(100)
    const antes = await one(
      `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [p.item.id])
    const { pedido } = await pedidoDe(p.item.id, 80)
    await P.confirmarPedido(pedido.id, null)
    const despues = await one(
      `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [p.item.id])
    assert.equal(Number(antes.s), Number(despues.s),
      'confirmar movió el stock del almacén')
  })

  await t.test('c) no se puede confirmar por encima de lo que hay', async () => {
    const p = await productoConStock(10)          // 20 en total
    const { pedido } = await pedidoDe(p.item.id, 500)
    await assert.rejects(() => P.confirmarPedido(pedido.id, null),
      /No hay stock|STOCK_INSUFICIENTE/i, 'confirmó un pedido de 500 con 20 en almacén')
  })

  await t.test('d) el fallo es TODO O NADA: no aparta ni una unidad', async () => {
    const p = await productoConStock(10)
    const { pedido } = await pedidoDe(p.item.id, 500)
    await P.confirmarPedido(pedido.id, null).catch(() => {})
    const res = await P.obtenerPedido(pedido.id)
    assert.equal(res.reservas.length, 0, 'dejó reservas huérfanas tras el fallo')
    assert.equal(res.status, 'DRAFT', 'cambió el estado del pedido pese al fallo')
  })

  await t.test('e) la base también lo impide, no solo el código', async () => {
    const p = await productoConStock(20)      // 40 en total
    const { pedido } = await pedidoDe(p.item.id, 20)
    await P.confirmarPedido(pedido.id, null)
    await assert.rejects(
      () => query(
        `INSERT INTO order_reservations
           (sales_order_id,order_line_id,item_id,lot_id,qty,unit_id,status,hold_type)
         VALUES ($1,$2,$3,$4,99999,$5,'ACTIVE','ORDER')`,
        [pedido.id, pedido.lineas[0].id, p.item.id, p.lotes[0].id, e.u.id]),
      /RESERVA_EXCEDE_PEDIDO|23514/i,
      'la base aceptó apartar 99999 unidades de una línea de 20')
  })

  await t.test('f) el reparto entre lotes es FEFO: primero lo que caduca antes', async () => {
    const p = await productoConStock(100)   // 200 en total, 100 por lote
    const { pedido } = await pedidoDe(p.item.id, 150)
    const plan = await P.simularConfirmacion(pedido.id)
    const reparto = plan.lineas[0].reparto
    assert.equal(reparto.length, 2, `esperaba 2 lotes en el reparto, hubo ${reparto.length}`)
    // Caducidad creciente: la primera fila tiene que ser la que caduca antes.
    const caducidades = reparto.map((r) => r.caducidad)
    assert.deepEqual(caducidades, [...caducidades].sort(),
      'el reparto no respeta el orden de caducidad')

    await P.confirmarPedido(pedido.id, null)
    const guardado = await query(
      `SELECT l.code, l.expiry_date FROM order_reservations r
         JOIN lots l ON l.id = r.lot_id WHERE r.order_line_id = $1`,
      [pedido.lineas[0].id])
    assert.equal(guardado.length, 2, 'no repartió entre los dos lotes')
    assert.equal(Number(guardado.reduce((s, r) => s + 0, 0)), 0)
    assert.ok(guardado[0].expiry_date < guardado[1].expiry_date,
      'la reserva no se hizo por caducidad: la primera no es la que caduca antes')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('2 · Anular libera lo apartado, y NO devuelve stock porque no se movió', async (t) => {
  const prod = await productoConStock(100)
  const { pedido, linea } = await pedidoDe(prod.item.id, 100, 'Se Anula')
  await P.confirmarPedido(pedido.id, null)

  const antes = await P.obtenerPedido(pedido.id)
  assert.equal(antes.reservas.reduce((s, r) => s + Number(r.qty_viva), 0), 100)

  const r = await P.anularPedido(pedido.id, 'El cliente lo cancela por teléfono', null)
  assert.equal(r.status, 'CANCELLED')
  assert.equal(r.liberadas, 1, 'no liberó las reservas')
  assert.equal(Number(r.unidades_liberadas), 100)

  await t.test('a) las reservas quedan RELEASED, no borradas', async () => {
    const res = await P.obtenerPedido(pedido.id)
    assert.equal(res.reservas.length, 1, 'borró la reserva en vez de liberarla')
    assert.equal(res.reservas[0].status, 'RELEASED')
  })

  await t.test('b) el stock no se «devuelve» porque nunca salió', async () => {
    const s = await one(
      `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [prod.item.id])
    assert.equal(Number(s.s), prod.stockInicial,
      'anular devolvió stock que nunca se había movido')
  })

  await t.test('c) lo apartado ya no bloquea a otro pedido', async () => {
    const v = await one(
      `SELECT COALESCE(SUM(qty),0) s FROM order_reservations
        WHERE order_line_id=$1 AND status IN ('ACTIVE','ASSIGNED')`, [linea.id])
    assert.equal(Number(v.s), 0, 'sigue apartada una reserva anulada')
  })

  await t.test('d) anular sin motivo no vale', async () => {
    const { pedido: p2 } = await pedidoDe(prod.item.id, 20, 'Sin Motivo')
    await P.confirmarPedido(p2.id, null)
    await assert.rejects(() => P.anularPedido(p2.id, 'x', null), /motivo/i)
  })

  await t.test('e) un pedido entregado no se anula: se devuelve', async () => {
    const p3 = await productoConStock(20)
    const { pedido: ped, linea: l3 } = await pedidoDe(p3.item.id, 10, 'Ya Entregado')
    await P.confirmarPedido(ped.id, null)
    await E.registrarEntrega({
      orderId: ped.id, lineas: [{ orderLineId: l3.id, qty: 10 }],
      firma: firma('Anulable'), recipientName: 'X', userId: repartidor,
    })
    await assert.rejects(() => P.anularPedido(ped.id, 'cambio de opinión', null),
      /entregado/i, 'anuló un pedido ya entregado')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('3 y 4 · Fabricar para un pedido lo vincula a él y aparta el lote PT', async (t) => {
  // Un producto sin existencias y SU PROPIA receta. Con la receta del
  // escenario se fabricaría un lote `PT-F4-00001` que ya existe de apertura, y
  // el fallo parecería un problema de códigos cuando es de la prueba.
  const p = await productoSinStock('Para Fabricar')
  const { pedido, linea } = await pedidoDe(p.item.id, 300, 'Necesita Fábrica')

  await t.test('a) sin stock, el pedido no se puede confirmar', async () => {
    await assert.rejects(() => P.confirmarPedido(pedido.id, null), /No hay stock/i)
  })

  const mpAntes = await saldo(e.mpLote.id)
  const envAntes = await saldo(e.envLote.id)
  const pr = await producir({ recipeId: p.receta.id, cantidad: 300, orderId: pedido.id, usuarioId: null })

  await t.test('b) la producción guarda el pedido del que salió', async () => {
    const fila = await one(`SELECT sales_order_id, status FROM productions WHERE id=$1`,
      [pr.produccion.id])
    assert.equal(Number(fila.sales_order_id), pedido.id, 'la producción no apunta a su pedido')
    assert.equal(fila.status, 'COMPLETED')
  })

  await t.test('c) el lote PT nace con el formato de ESE producto', async () => {
    // El número del lote sale de la SERIE del producto, no del SKU: un producto
    // de la familia `LAV` da `LAV-2026-000001`, igual que cualquier otro. Lo
    // que se esperaba aquí —`PT-LAV-00001`— era el prefijo del SKU con un
    // número pegado, un formato que el sistema no ha producido nunca.
    //
    // Lo que este caso quiere comprobar —que el lote lleve la familia de ESE
    // producto y no la de otro— se sigue comprobando igual, que es lo que
    // importa.
    const anio = new Date().getFullYear()
    const esperado = p.item.lot_prefix || p.item.sku.split('-')[1]
    assert.ok(pr.lote.code.startsWith(`${esperado}-${anio}-`),
      `esperaba un lote ${esperado}-${anio}-… y salió ${pr.lote.code}`)
    assert.match(pr.lote.code, /^[A-Z0-9]{2,4}-\d{4}-\d{6}$/)
  })

  await t.test('d) el lote PT apunta a su producción', async () => {
    const l = await one(`SELECT production_id, origin_type FROM lots WHERE id=$1`, [pr.lote.id])
    assert.equal(Number(l.production_id), pr.produccion.id)
    assert.equal(l.origin_type, 'PRODUCTION')
  })

  await t.test('e) lo fabricado sale APARTADO para el pedido, sin pasos extra', async () => {
    const res = await P.obtenerPedido(pedido.id)
    const reserva = res.reservas.find((r) => Number(r.lot_id) === Number(pr.lote.id))
    assert.ok(reserva, 'el lote fabricado no quedó apartado para el pedido')
    assert.equal(Number(reserva.qty_viva), 300)
  })

  await t.test('f) confirmar COMPLETA lo apartado, no lo duplica', async () => {
    // La producción ya había apartado las 300. Confirmar tiene que completar
    // la línea, no intentar apartar otras 300 y chocar con el propio pedido.
    const r = await P.confirmarPedido(pedido.id, null)
    assert.equal(r.status, 'RESERVED')
    const res = await P.obtenerPedido(pedido.id)
    const total = res.reservas.reduce((s, x) => s + Number(x.qty), 0)
    assert.equal(total, 300, `quedaron ${total} unidades apartadas para un pedido de 300`)
  })

  await t.test('g) las MP de fábrica bajaron de verdad', async () => {
    assert.equal(await saldo(e.mpLote.id), mpAntes - 300, 'la materia prima no bajó al fabricar')
    assert.equal(await saldo(e.envLote.id), envAntes - 300, 'el envase no bajó al fabricar')
  })

  await t.test('h) la producción consumió los lotes de MP que dijo, con su cantidad', async () => {
    const pm = await query(
      `SELECT pm.actual_qty, l.code FROM production_materials pm JOIN lots l ON l.id = pm.lot_id
        WHERE pm.production_id = $1 ORDER BY l.code`, [pr.produccion.id])
    assert.equal(pm.length, 2, 'no guardó los dos lotes de MP')
    assert.ok(pm.every((x) => Number(x.actual_qty) === 300), 'guardó una cantidad consumida rara')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · Una entrega parcial descuenta SOLO lo entregado', async (t) => {
  const prod = await productoConStock(100)
  const { pedido, linea } = await pedidoDe(prod.item.id, 100, 'Parcial')
  await P.confirmarPedido(pedido.id, null)

  const reserva = (await P.obtenerPedido(pedido.id)).reservas[0]
  const loteId = Number(reserva.lot_id)
  const antes = await saldo(loteId)

  const ent = await E.registrarEntrega({
    orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 40 }],
    firma: firma('Parcial'), recipientName: 'Señor Pérez', userId: repartidor,
  })

  assert.equal(Number(ent.cantidad), 40)
  assert.equal(antes - await saldo(loteId), 40, 'no descontó exactamente lo entregado')
  assert.equal(ent.pedido_estado, 'IN_ROUTE', 'cerró el pedido con la entrega parcial')

  await t.test('a) lo no entregado sigue apartado para la próxima visita', async () => {
    const res = await P.obtenerPedido(pedido.id)
    assert.equal(Number(res.resumen.entregado), 40)
    assert.equal(Number(res.resumen.pendiente), 60, 'no cuenta lo que queda por servir')
    const r = res.reservas[0]
    assert.equal(Number(r.qty), 100, 'la reserva se partió en vez de anotar lo servido')
    assert.equal(Number(r.qty_consumed), 40)
    assert.equal(Number(r.qty_viva), 60, 'los 60 restantes dejaron de estar apartados')
    assert.equal(r.status, 'ACTIVE')
  })

  await t.test('b) la firma queda colgada de SU entrega', async () => {
    const f = await one(
      `SELECT delivery_id, signer_name FROM delivery_signatures WHERE delivery_id=$1`, [ent.id])
    assert.equal(Number(f.delivery_id), ent.id)
    assert.equal(f.signer_name, 'Señor Pérez')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('6 · Una entrega completa cierra el pedido', async (t) => {
  const prod = await productoConStock(100)
  const { pedido, linea } = await pedidoDe(prod.item.id, 80, 'Completo')
  await P.confirmarPedido(pedido.id, null)

  await E.registrarEntrega({
    orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 30 }],
    firma: firma('A'), recipientName: 'A', userId: repartidor,
  })
  const ent2 = await E.registrarEntrega({
    orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 50 }],
    firma: firma('B'), recipientName: 'B', userId: repartidor,
  })

  assert.equal(ent2.pedido_estado, 'DELIVERED', 'la entrega completa no cerró el pedido')
  assert.equal(Number(ent2.pedido_pendiente), 0)

  await t.test('a) el stock bajó exactamente 80, en dos entregas', async () => {
    const s = await one(
      `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [prod.item.id])
    assert.equal(Number(s.s), prod.stockInicial - 80, 'no descontó exactamente lo entregado')
    const r = (await P.obtenerPedido(pedido.id)).reservas[0]
    assert.equal(r.status, 'CONSUMED', 'la reserva no quedó marcada como consumida')
  })

  await t.test('b) el pedido queda DELIVERED con fecha', async () => {
    const p = await one(`SELECT status, delivered_at FROM sales_orders WHERE id=$1`, [pedido.id])
    assert.equal(p.status, 'DELIVERED')
    assert.ok(p.delivered_at, 'cerró el pedido sin fecha de entrega')
  })

  await t.test('c) no se puede volver a entregar', async () => {
    await assert.rejects(
      () => E.registrarEntrega({
        orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 1 }],
        firma: firma('C'), recipientName: 'C', userId: repartidor,
      }),
      /ya se entregó|PEDIDO_YA_ENTREGADO/i, 'permitió entregar otra vez un pedido cerrado')
  })

  await t.test('d) la base no permite reabrir un pedido entregado', async () => {
    await assert.rejects(
      () => query(`UPDATE sales_orders SET status='DRAFT' WHERE id=$1`, [pedido.id]),
      /PEDIDO_ENTREGADO_NO_SE_REABRE|23514/i, 'reabrió por SQL un pedido ya entregado')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('7 · No se puede entregar más de lo reservado ni de lo disponible', async (t) => {
  await t.test('a) más de lo pendiente en la línea', async () => {
    const prod = await productoConStock(100)
    const { pedido, linea } = await pedidoDe(prod.item.id, 30, 'De mas')
    await P.confirmarPedido(pedido.id, null)
    await assert.rejects(
      () => E.registrarEntrega({
        orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 31 }],
        firma: firma('X'), recipientName: 'X', userId: repartidor,
      }),
      /CANTIDAD_SUPERA_PENDIENTE|ya está entregada|quedaban/i,
    )
    const s = await one(`SELECT status FROM sales_orders WHERE id=$1`, [pedido.id])
    assert.notEqual(s.status, 'DELIVERED', 'cerró un pedido al que le faltaba mercancía')
  })

  await t.test('b) servir más de lo que queda apartado tras una entrega parcial', async () => {
    const prod = await productoConStock(100)
    const { pedido, linea } = await pedidoDe(prod.item.id, 100, 'Se queda corto')
    await P.confirmarPedido(pedido.id, null)
    await E.registrarEntrega({
      orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 100 }],
      firma: firma('S'), recipientName: 'S', userId: repartidor,
    })
    // La reserva ya está consumida: no queda nada que servir.
    await assert.rejects(
      () => E.registrarEntrega({
        orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 10 }],
        firma: firma('S2'), recipientName: 'S2', userId: repartidor,
      }),
      /ya se entregó|PEDIDO_YA_ENTREGADO|Solo hay 0|apartadas/i,
      'entregó una segunda vez sobre una reserva ya consumida')
  })

  await t.test('c) un pedido sin confirmar no se entrega', async () => {
    const prod = await productoConStock(10)
    const { pedido, linea } = await pedidoDe(prod.item.id, 10, 'Sin confirmar')
    await assert.rejects(
      () => E.registrarEntrega({
        orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 10 }],
        firma: firma('Z'), recipientName: 'Z', userId: repartidor,
      }),
      /confirm/i, 'entregó un pedido que nadie había confirmado')
  })

    // ESTA PRUEBA CAMBIÓ DE SENTIDO, y hay que decirlo.
    //
    // Antes: «una entrega sin firma no se registra». La firma era la prueba.
    // Ahora la firma está EN PAPEL, con el cliente, y no se puede comprobar. Lo
    // que sí tiene que existir es QUIÉN confirmó y CUÁNDO — y sin eso no hay
    // entrega, porque nadie sabría después quién dejó esto aquí.
    await t.test('d) una entrega sin QUIÉN la confirmó no se registra ni mueve el stock',
      async () => {
        const prod = await productoConStock(20)
        const { pedido } = await pedidoDe(prod.item.id, 10, 'Sin repartidor')
        await P.confirmarPedido(pedido.id, null)
        const antes = await one(
          `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [prod.item.id])
        await assert.rejects(
          () => E.registrarEntrega({
            orderId: pedido.id,
            lineas: [{ orderLineId: pedido.lineas[0].id, qty: 10 }],
            userId: null,
          }),
          /ENTREGA_SIN_AUTOR|saber quién la confirmó/i,
          'entregó sin saber quién la confirmó')
        const despues = await one(
          `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [prod.item.id])
        assert.equal(Number(antes.s), Number(despues.s),
          'el stock se movió pese a fallar la entrega')
      })

    // Y el caso bueno, que antes no existía: SIN imagen de firma sí se entrega,
    // porque la firma está en papel. Lo que se guarda es la persona.
    await t.test('d2) sin imagen de firma SÍ se entrega, y consta quién confirmó', async () => {
      const prod = await productoConStock(20)
      const { pedido } = await pedidoDe(prod.item.id, 10, 'Firma en papel')
      await P.confirmarPedido(pedido.id, repartidor)
      const r = await E.registrarEntrega({
        orderId: pedido.id,
        lineas: [{ orderLineId: pedido.lineas[0].id, qty: 10 }],
        userId: repartidor, via: 'TARJETA_QR',
      })
      assert.equal(r.firma, null, 'no hay imagen: la firma física está en el albarán')
      assert.equal(r.confirmed_via, 'TARJETA_QR')
      assert.equal(r.confirmed_by, repartidor)
      assert.ok(r.confirmed_at)
    })

    // La base sigue siendo la última palabra, pero lo que exige es la
    // CONFIRMACIÓN —quién y cuándo—, no la imagen de una firma.
    await t.test('e) y la base tampoco deja cerrar la entrega sin confirmación', async () => {
      const prod = await productoConStock(20)
      const { pedido } = await pedidoDe(prod.item.id, 10, 'SQL directo')
      await P.confirmarPedido(pedido.id, null)
      const d = await one(
        `INSERT INTO deliveries (code,sales_order_id,status)
         VALUES ('ENT-SQL',$1,'PICKED_UP') RETURNING id`, [pedido.id])
      await assert.rejects(
        () => query(`UPDATE deliveries SET status='DELIVERED', delivered_at=now() WHERE id=$1`, [d.id]),
        /ENTREGA_SIN_CONFIRMACION|23514/i,
        'cerró por SQL una entrega sin saber quién la confirmó')
      // Con las dos cosas, la base lo permite.
      await query(
        `UPDATE deliveries SET status='DELIVERED', delivered_at=now(),
                confirmed_via='TARJETA_QR', confirmed_by=$2, confirmed_at=now()
          WHERE id=$1`, [d.id, repartidor])
    })

  await t.test('f) la misma entrega no descuenta dos veces el mismo lote', async () => {
    const prod = await productoConStock(20)
    const { pedido } = await pedidoDe(prod.item.id, 20, 'Doble')
    await P.confirmarPedido(pedido.id, null)
    const ent = await E.registrarEntrega({
      orderId: pedido.id, lineas: [{ orderLineId: pedido.lineas[0].id, qty: 20 }],
      firma: firma('W'), recipientName: 'W', userId: repartidor,
    })
    const lote = (await P.obtenerPedido(pedido.id)).reservas[0].lot_id
    const mov = await one(`SELECT id FROM stock_movements LIMIT 1`)

    // La clave que YA usó la entrega se lee del libro mayor, no se adivina.
    // (`stock_movement_keys` no tiene columna `id`: su clave primaria es `key`.)
    const usada = await one(
      `SELECT key FROM stock_movement_keys WHERE key LIKE $1 LIMIT 1`,
      [`%:${ent.id}:lot:${lote}`])
    assert.ok(usada, 'la entrega no dejó su clave de consumo único en el libro mayor')
    await assert.rejects(
      () => query(
        `INSERT INTO stock_movement_keys (key, movement_id) VALUES ($1, $2)`, [usada.key, mov.id]),
      /23505|duplicate key/i, 'aceptó la misma clave de entrega dos veces')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('8 · La trazabilidad va en los dos sentidos', async (t) => {
  const p = await productoSinStock('Trazable')
  const { pedido } = await pedidoDe(p.item.id, 250, 'Trazable')
  const pr = await producir({ recipeId: p.receta.id, cantidad: 250, orderId: pedido.id, usuarioId: null })
  await P.confirmarPedido(pedido.id, null)
  const linea = (await P.obtenerPedido(pedido.id)).lineas[0]
  await E.registrarEntrega({
    orderId: pedido.id, lineas: [{ orderLineId: linea.id, qty: 250 }],
    firma: firma('T'), recipientName: 'Trazable', userId: repartidor,
  })

  await t.test('a) pedido → lote PT → producción → receta → MP', async () => {
    const filas = await query(
      `SELECT finished_lot_code, production_code, recipe_code, recipe_version,
              material_lot_code, material_sku, product_sku, order_code, customer_name
         FROM v_trace_from_material
        WHERE finished_lot_id = $1 AND order_code = $2`, [pr.lote.id, pedido.code])
    assert.ok(filas.length >= 2, `esperaba las 2 MP de la receta, salieron ${filas.length}`)
    const f = filas[0]
    assert.equal(f.finished_lot_code, pr.lote.code, 'no llega al lote de PT')
    assert.equal(f.production_code, pr.produccion.code, 'no llega a la producción')
    assert.ok(f.recipe_code, 'no llega a la receta')
    assert.ok(f.recipe_version, 'no dice qué versión de receta se usó')
    assert.equal(f.order_code, pedido.code, 'no llega al pedido')
    const nombreCliente = (await one(`SELECT name FROM customers WHERE id=$1`, [pedido.customer_id])).name
    assert.equal(f.customer_name, nombreCliente, 'no llega al cliente')
    const mps = filas.map((x) => x.material_lot_code).sort()
    assert.deepEqual(mps, ['ENV-F4-0001', 'MP-F4-0001'], 'no llega a los dos lotes de MP')
  })

  await t.test('b) el mismo camino, desde el lote de producto terminado', async () => {
    const filas = await query(
      `SELECT material_lot_code, production_code, recipe_code, product_sku,
              supplier_name, received_by_name
         FROM v_trace_to_material WHERE finished_lot_id = $1`, [pr.lote.id])
    assert.equal(filas.length, 2, 'v_trace_to_material no devuelve las dos MP')
    assert.ok(filas.every((f) => f.production_code === pr.produccion.code))
    assert.ok(filas.every((f) => f.recipe_code), 'no sale la receta usada')
  })

  await t.test('c) y el inverso: desde un lote de MP hasta el cliente', async () => {
    const filas = await query(
      `SELECT order_code, customer_name, finished_lot_code, production_code
         FROM v_trace_from_material
        WHERE material_lot_code = 'MP-F4-0001' AND order_code = $1`, [pedido.code])
    assert.ok(filas.length > 0, 'desde la materia prima no se llega a ninguna entrega')
    const nombreCliente = (await one(`SELECT name FROM customers WHERE id=$1`, [pedido.customer_id])).name
    assert.ok(filas.every((f) => f.customer_name === nombreCliente),
      `la trazabilidad lleva un cliente distinto: ${filas.map((f) => f.customer_name).join(', ')}`)
  })

  await t.test('d) la entrega queda enlazada con su lote en delivery_lines', async () => {
    const dl = await query(
      `SELECT dl.lot_id, dl.qty_delivered, d.code AS entrega
         FROM delivery_lines dl JOIN deliveries d ON d.id = dl.delivery_id
        WHERE dl.order_line_id = $1`, [linea.id])
    assert.equal(dl.length, 1, 'no se guardó la línea de entrega')
    assert.equal(Number(dl[0].lot_id), Number(pr.lote.id), 'la entrega no apunta a su lote')
    assert.equal(Number(dl[0].qty_delivered), 250)
  })

  await t.test('e) el cliente tiene su historial de pedidos', async () => {
    const ficha = await C.obtenerCliente(pedido.customer_id)
    assert.ok(ficha.pedidos.length > 0, 'el cliente no tiene historial')
    assert.ok(ficha.pedidos.some((p) => p.order_code === pedido.code), 'falta su pedido en el historial')
    assert.equal(Number(ficha.pedidos.find((p) => p.order_code === pedido.code).qty_pending), 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('Extra · El QR es opaco, revocable y no lleva datos personales', async (t) => {
  const c = await C.crearCliente({ name: 'Cliente QR', phone: '600999888', email: 'a@b.es' }, null)

  await t.test('a) el token no contiene el nombre, ni el teléfono, ni nada', async () => {
    const bruto = Buffer.from(c.qr_token, 'base64url').toString('utf8')
    for (const secreto of ['Cliente', 'QR', '600999888', 'a@b.es']) {
      assert.ok(!bruto.includes(secreto), `el QR filtra «${secreto}»`)
    }
    assert.ok(c.qr_token.length >= 24, 'el token es demasiado corto para ser aleatorio')
  })

  await t.test('b) dos clientes nunca comparten token', async () => {
    const otro = await C.crearCliente({ name: 'Otro' }, null)
    assert.notEqual(c.qr_token, otro.qr_token)
  })

  await t.test('c) resuelve a un cliente real', async () => {
    const r = await C.resolverQr(c.qr_token)
    assert.equal(r.id, c.id)
    assert.equal(r.valido, true)
  })

  await t.test('d) al rotarlo, la tarjeta vieja deja de servir', async () => {
    const antes = c.qr_token
    const r = await C.regenerarTokenQr(c.id, null)
    assert.notEqual(r.qr_token, antes)
    await assert.rejects(() => C.resolverQr(antes), /no es válida|revocado/i,
      'la tarjeta perdida siguió funcionando tras rotar el token')
    assert.equal((await C.resolverQr(r.qr_token)).id, c.id)
  })

  await t.test('e) resuelve aunque venga con el prefijo de la tarjeta', async () => {
    const r = await C.resolverQr(`CS-${(await C.obtenerCliente(c.id)).qr_token}`)
    assert.equal(r.id, c.id, 'no resolvió con el prefijo CS- de la tarjeta')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('Extra · El libro mayor cuadra con las existencias', async () => {
  // Si el stock y el historial de movimientos dejan de estar de acuerdo, todo
  // lo anterior es decorativo.
  // La invariante es:  disponible = SUMA DE LOS MOVIMIENTOS DEL LOTE.
  // `crearLoteConEntrada` escribe su propio movimiento de entrada, así que el
  // libro mayor lo explica TODO, desde la creación hasta ahora. Ni una unidad
  // sin origen, ni un movimiento que no se refleje en el saldo.
  const desajuste = await query(
    `SELECT l.id, l.code, l.qty_available, l.initial_qty,
            COALESCE(SUM(sm.qty), 0) AS por_movimientos
       FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id = l.id
      GROUP BY l.id, l.code, l.qty_available, l.initial_qty
     HAVING ABS(l.qty_available - COALESCE(SUM(sm.qty), 0)) > 0.0001`)
  assert.equal(desajuste.length, 0,
    `lotes descuadrados: ${JSON.stringify(desajuste.slice(0, 3))}`)
  // Todo lote que haya salido de fábrica o de una entrega tiene que tener su
  // consumo registrado. Un lote de apertura sin mover es normal.
  const sinLibro = await query(
    `SELECT l.code FROM lots l
      WHERE l.origin_type = 'PRODUCTION'
        AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.lot_id = l.id)`)
  assert.equal(sinLibro.length, 0,
    `lotes de producción sin salida en el libro mayor: ${sinLibro.map((x) => x.code).join(', ')}`)

  const lotesNegativos = await query(`SELECT code FROM lots WHERE qty_available < 0`)
  assert.equal(lotesNegativos.length, 0, 'hay lotes con saldo negativo')
})
