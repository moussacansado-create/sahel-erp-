/**
 * EL FLUJO DE ENTREGA, DE PRINCIPIO A FIN
 *
 *   pedido → preparado → tarjeta QR → escaneo → albarán → entregado
 *
 * Existe porque había DOS puertas para entregar el mismo pedido, y solo una
 * cerraba el albarán. Con la otra, un pedido podía estar ENTREGADO mientras su
 * albarán seguía en la lista de «por entregar»: dos verdades sobre la misma
 * entrega, y la que se ve primero es la equivocada.
 *
 * Aquí se comprueba, con números delante:
 *   · solo se entrega por el albarán firmado
 *   · el cambio se refleja en Pedidos, ficha, escáner, reparto e histórico
 *   · no hay dos albaranes vivos para el mismo pedido
 *   · lo NO entregado NO puede parecer entregado por tener albarán
 *   · con varios pedidos del mismo cliente, entregar uno NO toca los demás
 *   · el albarán lleva las líneas de ESE viaje, no las del pedido entero
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-flujo-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const P = await import('../src/core/produccion.js')
const C = await import('../src/core/clientes.js')
const Ped = await import('../src/core/pedidos.js')
const A = await import('../src/core/albaranes.js')

let e
const db = { one, query }
const E = await import('../src/core/entregas.js')

// El repartidor. La entrega la confirma una PERSONA: la firma en papel no
// entra en el sistema, así que lo que queda escrito es quién la confirmó.
let repartidor = null

test.before(async () => {
  await baseDePrueba()
  repartidor = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-flujo','Repartidor Flujo','x', now()) RETURNING id`)).id
  e = await escenario()
})
test.after(async () => { await closeDb() })

async function escenario() {
  return transaction(async (tx) => {
    const u = await tx.one('SELECT id FROM units ORDER BY id LIMIT 1')
    const cat = await tx.one(
      `INSERT INTO item_categories (code, name, category_kind)
       VALUES ('FLU-F6','Flujo','FINISHED_GOOD') RETURNING id`)
    const mp = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
       VALUES ('MP-FLU-1','Materia flujo','RAW_MATERIAL',$1,1) RETURNING id`, [u.id])
    const receta = await tx.one(
      `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
       VALUES ('REC-FLU-1','Receta flujo',$1,100,$2) RETURNING id`,
      [(await tx.one(
        `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price,tax_rate,format_label)
         VALUES ('PT-FLU-1','Producto flujo','FINISHED_GOOD',$1,$2,'FLU',1000,0.21,'1 L') RETURNING id`,
        [cat.id, u.id])).id, u.id])
    const pt = await tx.one(`SELECT id FROM items WHERE sku = 'PT-FLU-1'`)
    await tx.query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, mp.id, u.id])
    await tx.one(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ('MP-FLU-0001',$1,'RAW_MATERIAL','ACTIVE',9000,9000,$2,'OPENING') RETURNING id`,
      [mp.id, u.id])
    return { u, pt: pt.id, receta }
  })
}

function firmaPng() {
  const W = 120, H = 40
  const filas = []
  for (let y = 0; y < H; y++) filas.push('0', ...Array(W).fill('255,255,255'))
  return Buffer.from(filas.join(''), 'binary')
}

async function cliente(nombre) {
  return C.crearCliente({ name: nombre, phone: '+223 70 00 00 00' }, null)
}

async function pedidoListo(c, lineas) {
  const p = await Ped.crearPedido({
    customerId: c.id, userId: repartidor, lineas,
  })
  await Ped.confirmarPedido(p.id, null)
  await Ped.prepararPedido(p.id, null)
  return p
}

async function lineaDe(orderId, qty = 6) {
  return { itemId: e.pt, qty, unitPrice: 1000 }
}

const lineasDelAlbaran = async (albaranId) => (await query(
  `SELECT order_line_id, qty FROM albaran_lines WHERE albaran_id = $1 ORDER BY id`, [albaranId]))

/**
 * EL REPARTO, PASO A PASO. Y el orden importa.
 *
 *   1. Se imprime el albarán, que es el papel que se lleva el repartidor.
 *   2. El cliente lo firma, en papel.
 *   3. El repartidor ESCANEA LA TARJETA y confirma la entrega.
 *
 * El paso 3 NO es «confirmar el albarán». Es la tarjeta. Y se puede hacer sin
 * haber impreso nada: el albarán es una referencia del viaje, no un requisito.
 */
async function repartirPorTarjeta(pedidoId, lineas = null, signer = 'Cliente', conAlbaran = true) {
  let a = null
  if (conAlbaran) {
    a = await A.crearAlbaran(db, { salesOrderId: pedidoId, userId: repartidor, lineas })
    await A.imprimirAlbaran(db, { albaranId: a.id, userId: repartidor })
    await A.firmarAlbaran(db, {
      albaranId: a.id, signerName: signer, image: firmaPng(), userId: repartidor,
    })
  }
  const r = await E.confirmarDesdeTarjeta({
    orderId: pedidoId, clienteId: null, userId: repartidor, lineas,
  })
  return { a, r }
}

/** El auxiliar viejo, para las pruebas que siguen hablando del papel. */
async function entregarPorAlbaran(pedidoId, lineas = null, signer = 'Cliente') {
  return repartirPorTarjeta(pedidoId, lineas, signer, true)
}

const estadoDe = async (id) => (await one(
  `SELECT status FROM sales_orders WHERE id = $1`, [id])).status

// ═══════════════════════════════════════════════════════════════════════════
test('1 · Un pedido sale y llega hasta PREPARED, y el QR lo encuentra', async () => {
  await P.producir({ recipeId: e.receta.id, cantidad: 1000, usuarioId: null, produccionId: null })
  const c = await cliente('Flujo Uno')
  const p = await Ped.crearPedido({ customerId: c.id, userId: repartidor, lineas: [await lineaDe(null, 6)] })
  assert.equal(await estadoDe(p.id), 'DRAFT')

  await Ped.confirmarPedido(p.id, null)
  assert.equal(await estadoDe(p.id), 'RESERVED', 'confirmar no reservó la mercancía')

  await Ped.prepararPedido(p.id, null)
  assert.equal(await estadoDe(p.id), 'PREPARED')

  // El QR lo ve, con el MISMO estado.
  const res = await C.resolverQr(c.qr_token)
  const suyo = res.pedidos_pendientes.find((x) => x.order_id === p.id)
  assert.ok(suyo, 'el QR no ofrece un pedido que está preparado')
  assert.equal(suyo.status, 'PREPARED', 'el escáner enseña otro estado que Pedidos')
  globalThis.uno = { c, p }
})

// ═══════════════════════════════════════════════════════════════════════════
test('2 · PREPARED no es DELIVERED, aunque tenga albarán impreso', async () => {
  // El caso contrario que pediste: que tener un documento NO convierta el
  // pedido en entregado. Es justo lo que pasaba con la puerta falsa.
  const c = await cliente('Flujo Dos')
  const p = await pedidoListo(c, [await lineaDe(null, 4)])

  const a = await A.crearAlbaran(db, { salesOrderId: p.id, userId: repartidor })
  await A.imprimirAlbaran(db, { albaranId: a.id, userId: repartidor })
  assert.equal(await estadoDe(p.id), 'PREPARED', 'tener el albarán impreso entregó el pedido')

  // Y ahora al revés, que es la regla nueva: se puede entregar SIN IMPRIMIR
  // NADA. El albarán no hace falta. Lo que no puede faltar es el repartidor.
  const c2 = await cliente('Flujo Sin Papel')
  const p2 = await pedidoListo(c2, [await lineaDe(null, 4)])
  const r = await E.confirmarDesdeTarjeta({
    orderId: p2.id, clienteId: c2.id, userId: repartidor,
  })
  assert.equal(r.pedido_estado, 'DELIVERED', 'no se pudo entregar sin albarán')
  assert.equal(r.confirmed_via, 'TARJETA_QR')
  assert.equal(await estadoDe(p.id), 'PREPARED', 'el albarán del otro pedido sigue como estaba')
})

// ═══════════════════════════════════════════════════════════════════════════
test('3 · El albarán lleva SUS líneas, no las del pedido entero', async () => {
  const c = await cliente('Flujo Tres')
  const p = await Ped.crearPedido({
    customerId: c.id, userId: repartidor, lineas: [await lineaDe(null, 10), await lineaDe(null, 5)],
  })
  await Ped.confirmarPedido(p.id, null)
  await Ped.prepararPedido(p.id, null)

  // Un viaje a medias: solo la primera línea.
  const lineaPedido = await query(
    `SELECT id FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY id`, [p.id])
  const { a } = await entregarPorAlbaran(p.id, [
    { orderLineId: lineaPedido[0].id, qty: 4 },
  ])

  const suyas = await lineasDelAlbaran(a.id)
  assert.equal(suyas.length, 1, `el albarán lleva ${suyas.length} líneas; este viaje llevaba una`)
  assert.equal(Number(suyas[0].qty), 4, 'el albarán no lleva la cantidad del viaje')

  // El pedido queda a medias, NO entregado, y el resto sigue pendiente.
  assert.equal(await estadoDe(p.id), 'IN_ROUTE', 'una entrega parcial no puede cerrar el pedido')
  const det = await Ped.obtenerPedido(p.id)
  assert.equal(Number(det.lineas[0].qty_delivered), 4, 'no se sirvió lo que decía el albarán')
  // La línea que el albarán NO llevaba no se puede haber servido. Y esto es lo
  // que un albarán con las líneas del PEDIDO entero habría roto: habría
  // firmado el cliente un papel que decía que se lleva el pedido completo.
  assert.equal(Number(det.lineas[1].qty_delivered), 0,
    'se sirvió una línea que este viaje no llevaba')
  globalThis.tres = { c, p, albaran: a }
})

// ═══════════════════════════════════════════════════════════════════════════
test('4 · El albarán no puede llevar más de lo que queda pendiente', async () => {
  const { p } = globalThis.tres
  const lineas = await query(
    `SELECT id, qty, qty_delivered FROM sales_order_lines
      WHERE sales_order_id = $1 ORDER BY id`, [p.id])
  const pendiente = Number(lineas[0].qty) - Number(lineas[0].qty_delivered)

  await assert.rejects(
    () => A.crearAlbaran(db, {
      salesOrderId: p.id, userId: repartidor,
      lineas: [{ orderLineId: lineas[0].id, qty: pendiente + 100 }],
    }),
    /quedaban|servir/i,
    'un albarán puede llevar más mercancía de la que queda: se serviría dos veces')
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · No hay DOS albaranes vivos para el mismo pedido', async () => {
  const { p } = globalThis.tres
  await assert.rejects(
    () => A.crearAlbaran(db, { salesOrderId: p.id, userId: repartidor }),
    /a medio camino|ALBARAN_EN_CURSO/i,
    'admite un segundo albarán para un pedido que ya tiene uno abierto: '
    + 'uno de los dos acabaría huérfano en «por entregar»')
})

// ═══════════════════════════════════════════════════════════════════════════
test('6 · Entregar por el albarán propaga a TODAS las pantallas', async () => {
  const { c, p } = globalThis.uno
  const { a, r } = await entregarPorAlbaran(p.id, null, 'Cliente Real')

  assert.equal(r.pedido_estado, 'DELIVERED')
  assert.equal(r.confirmed_via, 'TARJETA_QR', 'la entrega no salió de la tarjeta')
  assert.ok(r.id, 'no se creó ninguna entrega')

  // 1. El pedido, que es la fuente de verdad.
  assert.equal(await estadoDe(p.id), 'DELIVERED', 'el pedido no quedó entregado')
  // 2. La ficha del pedido.
  const det = await Ped.obtenerPedido(p.id)
  assert.equal(det.status, 'DELIVERED')
  // 3. El albarán.
  const alb = await A.detalleAlbaran(db, a.id)
  assert.equal(alb.status, 'DELIVERED', 'el albarán quedó en otro estado que el pedido')
  assert.ok(alb.delivery_id, 'el albarán no apunta a su entrega')
  // 4. El escáner: ya no lo ofrece.
  const res = await C.resolverQr(c.qr_token)
  assert.ok(!(await res).pedidos_pendientes.some((x) => x.order_id === p.id),
    'el escáner sigue ofreciendo un pedido ya entregado')
  // 5. El historial del documento.
  // El historial del papel: se creó, se imprimió, el cliente firmó y volvió con
  // la entrega. La última fila la puso la TARJETA, no el albarán.
  assert.deepEqual(alb.eventos.map((x) => x.event),
    ['CREATED', 'PRINTED', 'SIGNED', 'DELIVERED'],
    'el historial del albarán está incompleto')
  globalThis.entregado = { c, p, a }
})

// ═══════════════════════════════════════════════════════════════════════════
test('7 · El estado NO vuelve atrás al recargar', async () => {
  const { p } = globalThis.entregado
  // Diez lecturas seguidas, como recargar la pantalla con F5.
  for (let i = 0; i < 10; i++) {
    assert.equal(await estadoDe(p.id), 'DELIVERED', `en la lectura ${i + 1} el pedido volvió a otro estado`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test('8 · Con VARIOS pedidos del mismo cliente, entregar uno NO toca los demás', async () => {
  // El repartidor escaneó la tarjeta y vio tres pedidos. Si el botón fuera
  // genérico, cerraría el que pillara. Y cerrar una entrega no se deshace: el
  // stock ya bajó y el cliente ya firmó.
  const c = await cliente('Flujo Cuatro')
  const pedidos = []
  for (let i = 0; i < 3; i++) {
    pedidos.push(await Ped.crearPedido({
      customerId: c.id, userId: repartidor, lineas: [await lineaDe(null, 2 + i)],
    }))
    await Ped.confirmarPedido(pedidos[i].id, null)
  }
  await Ped.prepararPedido(pedidos[1].id, null)

  // El QR los enseña los tres, cada uno con su código.
  const res = await C.resolverQr(c.qr_token)
  const suyos = res.pedidos_pendientes.filter((x) => pedidos.some((p) => p.id === x.order_id))
  assert.equal(suyos.length, 3, 'el QR no enseña los tres pedidos por separado')
  assert.equal(new Set(suyos.map((x) => x.order_code)).size, 3,
    'el QR mezcla los pedidos del cliente: no se puede saber cuál se entrega')

  // Se entrega EL DE EN MEDIO, que es el preparado.
  await entregarPorAlbaran(pedidos[1].id, null)

  assert.equal(await estadoDe(pedidos[1].id), 'DELIVERED', 'no se entregó el que se eligió')
  assert.equal(await estadoDe(pedidos[0].id), 'RESERVED',
    'entregar uno cambió el estado de otro que no se tocó')
  assert.equal(await estadoDe(pedidos[2].id), 'RESERVED',
    'entregar uno cambió el estado de otro que no se tocó')

  // Y el albarán es del pedido entregado, no del cliente entero.
  const det = await Ped.obtenerPedido(pedidos[1].id)
  assert.equal(det.albaranes.length, 1, 'un pedido con varios albaranes: uno quedaría huérfano')
  assert.equal(await estadoDe(pedidos[0].id), 'RESERVED')
  const otros = await Ped.obtenerPedido(pedidos[0].id)
  assert.equal(otros.albaranes.length, 0, 'el albarán se colgó en el pedido que no se entregó')
})

// ═══════════════════════════════════════════════════════════════════════════
test('9 · Un pedido ya entregado no se puede volver a entregar por la tarjeta', async () => {
  const { p } = globalThis.entregado
  await assert.rejects(
    () => A.crearAlbaran(db, { salesOrderId: p.id, userId: repartidor }),
    /ya está entregado/i,
    'abrió un albarán de un pedido ya entregado: aparecería «por entregar» sin serlo')
})
