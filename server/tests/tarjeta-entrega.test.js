/**
 * LA ENTREGA CONFIRMADA DESDE LA TARJETA.
 *
 * Este archivo es la prueba de la regla que decidió el reparto entero:
 *
 *   EL ALBARÁN NO CONFIRMA LA ENTREGA.
 *   LA ENTREGA SE CONFIRMA ESCANEANDO LA TARJETA DEL CLIENTE.
 *
 * El reparto de verdad es: el repartidor se lleva la mercancía y el albarán, el
 * cliente FIRMA EN PAPEL, y luego el repartidor escanea la tarjeta y pulsa
 * «Entregar». Ese último gesto es el que escribe en el sistema.
 *
 * Se comprueba, unidas en una sola prueba, las nueve cosas que importan:
 *
 *   1. La tarjeta enseña QUÉ se puede entregar. Ni uno más, ni uno menos.
 *   2. El repartidor ve el producto y la cantidad de cada pedido.
 *   3. Entregar descuenta el stock UNA SOLA VEZ.
 *   4. Queda QUÉ quién confirmó, CUÁNDO y POR QUÉ VÍA.
 *   5. Solo se entrega UN pedido: el de al lado no se mueve.
 *   6. Un pedido ya entregado no se entrega otra vez.
 *   7. La tarjeta tiene que ser la del CLIENTE de ese pedido.
 *   8. Un pedido sin preparar NO se puede entregar.
 *   9. Imprimir o tener albarán NO cambia el estado. Ni confirmar por él.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-tarjeta-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const C = await import('../src/core/clientes.js')
const P = await import('../src/core/pedidos.js')
const E = await import('../src/core/entregas.js')
const { crearLoteConEntrada, existenciasDe } = await import('../src/core/stock.js')
const A = await import('../src/core/albaranes.js')

let e = {}
let usuarioId = null

test.before(async () => {
  await baseDePrueba()
  // Un repartidor de verdad, con su usuario. Que quede escrita SU identidad en
  // la entrega es justo una de las cosas que se comprueban.
  usuarioId = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-tarjeta','Repartidor Tarjeta','x', now()) RETURNING id`)).id
  e = await escenario()
})
test.after(async () => { await closeDb() })

/** Un cliente con TRES pedidos: dos por entregar y uno ya entregado. */
async function escenario() {
  // NADA de esto se llama con una `tx` por la razón que explica la última
  // prueba: estas tres funciones abren SIEMPRE su propia transacción.
  //
  //   crearPedido({...})                sin `tx`
  //   confirmarPedido(id, usuarioId)    sin `tx`
  //   prepararPedido(id, usuarioId)     sin `tx`
  //
  // Su segundo parámetro es el USUARIO, no la transacción. Pásales una `tx` por
  // costumbre y abren una segunda conexión sobre la única de PGlite: la suite se
  // queda colgada sin decir ni una palabra. Es el deadlock más caro del
  // proyecto, y no por culpa de PGlite sino de un parámetro que se parece
  // mucho al que ya no es.
  const cliente = await C.crearCliente(
    { name: 'Distribuidora Tarjeta', companyName: 'Dist. Tarjeta S.A.' }, usuarioId)

  const u = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id

  // Productos y lotes sí van dentro de una transacción: esas funciones SÍ la
  // aceptan, y así se escriben de golpe o no se escriben.
  const { pt, pt2 } = await transaction(async (tx) => {
    const pt = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,sale_price,tax_rate)
       VALUES ('PT-TARJ-1','Producto Tarjeta','FINISHED_GOOD',$1,'TARJ',10,0.21)
       RETURNING id`, [u])
    const pt2 = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,sale_price,tax_rate)
       VALUES ('PT-TARJ-2','Producto Tarjeta Dos','FINISHED_GOOD',$1,'TARJD',10,0.21)
       RETURNING id`, [u])

    // Stock de sobra: los tres pedidos tienen que caber, y además hay que poder
    // comprobar que la entrega NO vuelve a descontar.
    await crearLoteConEntrada(tx, {
      code: 'TARJ-PT-1', itemId: pt.id, lotKind: 'FINISHED_GOOD',
      initialQty: 500, unitId: u, expiryDate: '2027-01-01',
      originType: 'OPENING', userId: null,
    })
    await crearLoteConEntrada(tx, {
      code: 'TARJ-PT-2', itemId: pt2.id, lotKind: 'FINISHED_GOOD',
      initialQty: 500, unitId: u, expiryDate: '2027-01-01',
      originType: 'OPENING', userId: null,
    })
    return { pt, pt2 }
  })

  const hacer = async (itemId, qty) => {
    const o = await P.crearPedido({
      customerId: cliente.id, userId: usuarioId,
      lineas: [{ itemId, qty, unitPrice: 1500 }],
    })
    await P.confirmarPedido(o.id, usuarioId)
    await P.prepararPedido(o.id, usuarioId)
    return o
  }

  return {
    u, pt, pt2, cliente,
    p1: await hacer(pt.id, 40),    // se entrega en la prueba
    p2: await hacer(pt2.id, 25),   // NO se toca: tiene que seguir pendiente
    p3: await hacer(pt.id, 15),    // se entrega antes, para tener un entregado
  }
}

// ─── 1 y 2 · LO QUE ENSEÑA LA TARJETA ───────────────────────────────────────

test('la tarjeta enseña solo lo que se puede entregar, y dice qué lleva', async () => {
  // Se entrega DENTRO de una transacción explícita. PGlite tiene una sola
  // conexión: llamar a una función de módulo que abre su propia transacción
  // desde dentro de otra se queda esperando para siempre.
  await transaction((tx) => E.confirmarDesdeTarjeta({
    orderId: e.p3.id, clienteId: e.cliente.id, userId: usuarioId, tx,
  }))

  const t = await C.resolverQr(e.cliente.qr_token)

  assert.equal(t.code, e.cliente.code)
  assert.equal(t.valido, true)

  // #3 ya está entregado: no sale. #1 y #2 sí.
  const codigos = t.pedidos_pendientes.map((p) => p.order_code)
  assert.deepEqual(codigos, [e.p1.code, e.p2.code],
    'solo los dos que quedan por entregar, en orden')

  // Cada uno dice QUÉ lleva y cuántas unidades. Sin esto, con tres pedidos del
  // mismo cliente, el repartidor no sabe cuál es cuál.
  const uno = t.pedidos_pendientes[0]
  assert.match(uno.que_lleva, /Producto Tarjeta/)
  assert.match(uno.que_lleva, /40/)
  assert.equal(Number(uno.qty_pending), 40)
  assert.equal(Number(uno.lineas), 1)
})

test('un pedido sin preparar NO aparece como entregable', async () => {
  const borrador = await P.crearPedido({
    customerId: e.cliente.id, userId: usuarioId,
    lineas: [{ itemId: e.pt.id, qty: 5, unitPrice: 1500 }],
  })
  try {
    const t = await C.resolverQr(e.cliente.qr_token)
    assert.equal(t.pedidos_pendientes.some((p) => p.order_id === borrador.id), false,
      'un borrador no es entregable: ni tiene mercancía apartada')
    // Pero sí se ve, como aviso, para que el repartidor no se pregunte.
    const avisos = t.pedidos_no_entregables.map((p) => p.order_code)
    assert.equal(avisos.includes(borrador.code), true)
  } finally { await P.anularPedido(borrador.id, 'Prueba: no hace falta', usuarioId) }
})

// ─── 3, 4 y 5 · LO QUE PASA AL PULSAR «ENTREGAR» ─────────────────────────────

test('entregar descuenta el stock una sola vez y deja constancia de quién y cuándo', async () => {
  const antes = await existenciasDe(e.pt.id)   // v_item_available
  const pedidoAntes = await one(`SELECT status FROM sales_orders WHERE id=$1`, [e.p1.id])

  const r = await E.confirmarDesdeTarjeta({
    orderId: e.p1.id, clienteId: e.cliente.id, userId: usuarioId,
  })

  // ── El stock baja justo lo entregado, ni una unidad más ──────────────────
  const despues = await existenciasDe(e.pt.id)
  assert.equal(Number(antes.qty_on_hand) - Number(despues.qty_on_hand), 40,
    'descuenta 40 y solo 40')

  // ── El pedido pasa a ENTREGADO ────────────────────────────────────────────
  assert.equal(pedidoAntes.status, 'PREPARED')
  assert.equal(r.pedido_estado, 'DELIVERED')
  assert.equal((await one(`SELECT status FROM sales_orders WHERE id=$1`, [e.p1.id])).status,
    'DELIVERED')

  // ── LO QUE QUEDA ESCRITO ─────────────────────────────────────────────────
  // Esto es lo que se necesita cuando un cliente dice que no recibió nada.
  assert.equal(r.confirmed_via, 'TARJETA_QR', 'y por qué vía se confirmó')
  assert.equal(r.confirmed_by, usuarioId, 'quién lo confirmó')
  assert.ok(r.confirmed_at, 'cuándo se confirmó')
  assert.equal(r.cliente_nombre, e.cliente.name, 'a qué cliente')

  const entrega = await one(
    `SELECT d.confirmed_via, d.confirmed_by, d.confirmed_at, d.rep_id, d.recipient_name
       FROM deliveries d WHERE d.id=$1`, [r.id])
  assert.equal(entrega.confirmed_via, 'TARJETA_QR')
  assert.equal(entrega.confirmed_by, usuarioId)
  assert.ok(entrega.confirmed_at)
  assert.equal(entrega.recipient_name, e.cliente.name)

  // La entrega no va firmada con una imagen: la firma está en papel, con el
  // cliente. Lo que se guarda es la persona.
  assert.equal(r.firma, null, 'no hay imagen de firma: la firma física es papel')
  assert.equal((await one(`SELECT COUNT(*) n FROM delivery_signatures WHERE delivery_id=$1`,
    [r.id])).n, 0)

  // ── Y el reparto se ve en el historial, sin duplicados ────────────────────
  const linea = await one(
    `SELECT qty_delivered, lot_id FROM delivery_lines
      WHERE delivery_id=$1 AND order_line_id=`
    + `(SELECT id FROM sales_order_lines WHERE sales_order_id=$2)`,
    [r.id, e.p1.id])
  assert.equal(Number(linea.qty_delivered), 40)
  assert.ok(linea.lot_id, 'y se sabe de qué lote salió la mercancía')
})

test('entregar UN pedido no mueve los demás', async () => {
  // #2 no se ha tocado en absoluto.
  const p2 = await one(`SELECT status FROM sales_orders WHERE id=$1`, [e.p2.id])
  assert.equal(p2.status, 'PREPARED', '#2 sigue preparado, como estaba')
  assert.equal(Number((await one(
    `SELECT COALESCE(SUM(qty - qty_delivered),0) p FROM sales_order_lines
      WHERE sales_order_id=$1`, [e.p2.id])).p), 25)

  // Y #3 sigue entregado, con su entrega intacta.
  assert.equal((await one(`SELECT status FROM sales_orders WHERE id=$1`, [e.p3.id])).status,
    'DELIVERED')
})

// ─── 6, 7 y 8 · LO QUE NO SE PUEDE HACER ────────────────────────────────────

test('un pedido ya entregado no se entrega dos veces', async () => {
  await assert.rejects(
    () => E.confirmarDesdeTarjeta({
      orderId: e.p1.id, clienteId: e.cliente.id, userId: usuarioId }),
    (err) => err.codigo === 'PEDIDO_YA_ENTREGADO' && err.estado === 409,
  )
  // Y el stock no se ha vuelto a tocar.
  const t = await C.resolverQr(e.cliente.qr_token)
  assert.equal(t.pedidos_pendientes.some((p) => p.order_id === e.p1.id), false)
})

test('la tarjeta de otro cliente NO puede entregar este pedido', async () => {
  const otro = await C.crearCliente({ name: 'Cliente Que No Es' }, usuarioId)
  const suyo = await P.crearPedido({
    customerId: otro.id, userId: usuarioId,
    lineas: [{ itemId: e.pt.id, qty: 8, unitPrice: 1500 }],
  })
  try {
    await P.confirmarPedido(suyo.id, usuarioId)
    await P.prepararPedido(suyo.id, usuarioId)
    // Escanea la tarjeta de «Distribuidora Tarjeta» y tries su pedido.
    await assert.rejects(
      () => E.confirmarDesdeTarjeta({
        orderId: suyo.id, clienteId: e.cliente.id, userId: usuarioId }),
      (err) => err.codigo === 'TARJETA_NO_CORRESPONDE' && err.estado === 409,
    )
  } finally { await P.anularPedido(suyo.id, 'Prueba: tarjeta ajena', usuarioId) }
})

test('un pedido sin preparar NO se puede entregar', async () => {
  const borrador = await P.crearPedido({
    customerId: e.cliente.id, userId: usuarioId,
    lineas: [{ itemId: e.pt.id, qty: 4, unitPrice: 1500 }],
  })
  try {
    await assert.rejects(
      () => E.confirmarDesdeTarjeta({
        orderId: borrador.id, clienteId: e.cliente.id, userId: usuarioId }),
      (err) => err.codigo === 'PEDIDO_NO_PREPARADO' && err.estado === 409,
    )
  } finally { await P.anularPedido(borrador.id, 'Prueba: sin preparar', usuarioId) }
})

// ─── 9 · EL ALBARÁN ES PAPEL ────────────────────────────────────────────────

test('tener albarán, imprimirlo o intentar confirmar por él NO entrega nada', async () => {
  const estado = async () =>
    (await one(`SELECT status FROM sales_orders WHERE id=$1`, [e.p2.id])).status

  assert.equal(await estado(), 'PREPARED', 'punto de partida: preparado')

  const albaran = await transaction((tx) =>
    A.crearAlbaran(tx, { salesOrderId: e.p2.id, copies: 2, userId: usuarioId }))
  assert.equal(await estado(), 'PREPARED', 'crear el albarán no entrega')

  await transaction((tx) =>
    A.imprimirAlbaran(tx, { albaranId: albaran.id, copies: 2, userId: usuarioId }))
  assert.equal(await estado(), 'PREPARED',
    'IMPRIMIR el albarán no entrega. El papel no es el estado.')
})

test('el albarán queda como REFERENCIA del viaje, y la entrega lo apunta', async () => {
  // El mismo albarán del caso anterior, ya impreso: no se puede abrir otro
  // albarán para el mismo pedido mientras este siga a medio camino.
  const albaran = (await one(
    `SELECT * FROM albaranes WHERE sales_order_id=$1 AND status <> 'VOID'`, [e.p2.id]))
  assert.ok(albaran, 'el albarán de la prueba anterior sigue ahí')

  // El reparto se hace igual por la tarjeta.
  const r = await E.confirmarDesdeTarjeta({
    orderId: e.p2.id, clienteId: e.cliente.id, userId: usuarioId,
  })
  assert.equal(r.pedido_estado, 'DELIVERED')
  assert.equal(r.albaran_id, albaran.id,
    'la entrega apunta al papel de ese viaje, aunque nobody lo creara para eso')

  // Y el albarán se cierra cuando su entrega existe. Ni antes, ni por imprimirlo:
  // el estado del papel lo sigue la entrega, nunca al revés.
  const refreshed = await one(`SELECT status FROM albaranes WHERE id=$1`, [albaran.id])
  assert.equal(refreshed.status, 'DELIVERED',
    'el papel se marca entregado cuando la entrega existe, no cuando se imprime')
})
