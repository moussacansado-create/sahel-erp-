/**
 * Pruebas de los siete puntos que el negocio fijó a mano.
 *
 * No se comprueba que el código LO INTENTE. Se comprueba que la BASE DE DATOS
 * lo impide, que es lo único que no depende de que alguien escriba bien una
 * función dentro de dos años.
 *
 *   1. No se puede crear una reserva duplicada.
 *   2. Imprimir un albarán no entrega.
 *   3. Una entrega solo puede descontar una vez.
 *   4. La firma queda asociada a la entrega correcta.
 *   5. Cada producción genera un lote PT único.
 *   6. El lote PT queda vinculado a su producción.
 *   7. El lote PT queda vinculado a los lotes de MP consumidos.
 */

const anio = new Date().getFullYear()
import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-de-alcance-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

// La MISMA base limpia que usan las demás pruebas: se aplica el esquema
// completo, migraciones incluidas. Si la 010 estuviera mal, no arrancaría.
const { baseDePrueba, query, one, exec, closeDb } = await import('./banco.js')
// El servicio de albaranes trabaja contra una transacción. En la prueba se le
// pasa este envoltorio, que tiene exactamente los tres métodos que usa.
const tx = { query, one, exec }
// El servicio de albaranes trabaja contra una transacción. En la prueba se le
// pasa este envoltorio, que tiene exactamente los tres métodos que usa.
const { siguienteCodigoLoteProducto } = await import('../src/core/codigos.js')
const albaranes = await import('../src/core/albaranes.js')
const { crearCliente } = await import('../src/core/clientes.js')
const { crearPedido, confirmarPedido } = await import('../src/core/pedidos.js')
const pedidos = await import('../src/core/pedidos.js')
const E = await import('../src/core/entregas.js')

let id = {}
// El repartidor: la entrega la confirma una persona, no una firma en pantalla.
let repartidor = null

test.before(async () => {
  await baseDePrueba()
  repartidor = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-alc','Repartidor Alcance','x', now()) RETURNING id`)).id
  // Un único escenario para las seis pruebas. Antes se creaba uno por prueba y
  // la segunda se moría por SKU duplicado: el fallo no tenía nada que ver con
  // lo que se quería comprobar.
  await construirEscenario()
})
test.after(async () => { await closeDb() })

// ─── Escenario compartido ────────────────────────────────────────────────────
// Un cliente, un producto con existencias, un pedido de 100 unidades y dos
// lotes de producto terminado que ya podemos consume
async function construirEscenario() {
  // Unidades, monedas y categorías ya vienen de la siembra: no se vuelven a
  // crear, se buscan.
  const u = await one(`SELECT id FROM units ORDER BY id LIMIT 1`)
  const cur = await one(`SELECT code FROM currencies ORDER BY code LIMIT 1`)
  const cat = await one(
    `INSERT INTO item_categories (code, name, category_kind)
     VALUES ('TEST-FIN','Acabados de prueba','FINISHED_GOOD')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`)

  const pt = await one(
    `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price)
     VALUES ('PT-AUD-1L','Producto de prueba','FINISHED_GOOD',$1,$2,'AUD',10)
     RETURNING id`, [cat.id, u.id])
  const otro = await one(
    `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price)
     VALUES ('PT-BOL-1L','Otro producto','FINISHED_GOOD',$1,$2,'BOL',10)
     RETURNING id`, [cat.id, u.id])

  // Lotes de PT ya en almacén, para poder confirmar y entregar.
  for (const n of [1, 2]) {
    const lote = await one(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ($1,$2,'FINISHED_GOOD','ACTIVE',200,200,$3,'OPENING') RETURNING id`,
      [`PT-AUD-0000${n}`, pt.id, u.id])
    if (n === 1) id.loteA = lote.id
    else id.loteB = lote.id
  }

  const rec = await one(
    `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
     VALUES ('REC-T1','Receta prueba',$1,1,$2) RETURNING id`, [pt.id, u.id])

  const cli = await one(
    `INSERT INTO customers (code,name,qr_token)
     VALUES ('CLI-T1','Cliente de prueba',$1) RETURNING id`, [crypto.randomUUID()])

  let n = 0
  const nuevoPedido = async () => {
    n += 1
    return one(
      `INSERT INTO sales_orders (code,customer_id,status,currency_code,subtotal,tax_rate,tax_amount,total)
       VALUES ($1,$2,'DRAFT',$3,1000,0.21,210,1210) RETURNING id`, [`PED-T${n}`, cli.id, cur.code])
  }
  const ped = await nuevoPedido()

  const lin = await one(
    `INSERT INTO sales_order_lines (sales_order_id,item_id,qty,unit_id,unit_price,tax_rate,line_total)
     VALUES ($1,$2,100,$3,10,0.21,1210) RETURNING id`, [ped.id, pt.id, u.id])

    /**
     * Un pedido listo para albarán: confirmado y con mercancía APARTADA.
     *
     * Hace falta una fábrica y no un pedido fijo, porque ahora un pedido solo
     * admite UN albarán vivo a la vez —que es justo lo que se quiere— y estas
     * pruebas crean varios sobre el mismo escenario.
     */
    let nserv = 0
    const pedidoServible = async () => {
      nserv += 1
      // Un lote PROPIO de este pedido. Compartir los lotes del escenario hacía
      // que el segundo pedido se encontrara sin género: el primero se lo había
      // llevado todo al entregar.
      const lote = await one(
        `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
         VALUES ($1,$2,'FINISHED_GOOD','ACTIVE',200,200,$3,'OPENING') RETURNING id`,
        [`PT-AUD-NS${nserv}`, pt.id, u.id])
      const o = await nuevoPedido()
      const l = await one(
        `INSERT INTO sales_order_lines (sales_order_id,item_id,qty,unit_id,unit_price,tax_rate,line_total)
         VALUES ($1,$2,100,$3,10,0.21,1210) RETURNING id`, [o.id, pt.id, u.id])
      await query(`UPDATE sales_orders SET status='RESERVED' WHERE id=$1`, [o.id])
      await query(
        `INSERT INTO order_reservations
           (sales_order_id,order_line_id,item_id,unit_id,lot_id,qty,status)
         VALUES ($1,$2,$3,$4,$5,100,'ACTIVE')`,
        [o.id, l.id, pt.id, u.id, lote.id])
      return o
    }

    Object.assign(id, { unidad: u.id, moneda: cur.code, pt: pt.id, otro, receta: rec.id,
                       cliente: cli.id, pedido: ped.id, linea: lin.id, nuevoPedido,
                       pedidoServible })
  return id
}

// ═══════════════════════════════════════════════════════════════════════════
test('1 · La reserva duplicada la detiene la BASE, no el código', async (t) => {
  const e = id

  // Apartado legítimo: 60 de los 100.
  await query(
    `INSERT INTO order_reservations (sales_order_id,order_line_id,item_id,lot_id,qty,unit_id,status,hold_type)
     VALUES ($1,$2,$3,$4,60,$5,'ACTIVE','ORDER')`,
    [e.pedido, e.linea, e.pt, id.loteA, e.unidad])

  await t.test('a) el mismo lote no se puede apartar dos veces para la misma línea', async () => {
    await assert.rejects(
      () => query(
        `INSERT INTO order_reservations (sales_order_id,order_line_id,item_id,lot_id,qty,unit_id,status,hold_type)
         VALUES ($1,$2,$3,$4,60,$5,'ACTIVE','ORDER')`,
        [e.pedido, e.linea, e.pt, id.loteA, e.unidad]),
      // Lo rechaza la base. Puede ser el índice único O el disparador de suma:
      // el orden depende de cuál comprueba PostgreSQL antes, y los dos son la
      // misma garantía desde el punto de vista de quien opera.
      /uniq_reserva_linea_lote|duplicate key|23505|RESERVA_EXCEDE_PEDIDO|23514/i,
      'aceptó apartar dos veces el mismo lote de la misma línea',
    )
  })

  await t.test('b) repartir entre dos lotes SÍ es legal (40 y 60)', async () => {
    // Esta es la razón de que la protección sea sobre la SUMA y no un índice
    // único por línea: una línea de 100 puede necesitar dos lotes.
    await query(
      `INSERT INTO order_reservations (sales_order_id,order_line_id,item_id,lot_id,qty,unit_id,status,hold_type)
       VALUES ($1,$2,$3,$4,40,$5,'ACTIVE','ORDER')`,
      [e.pedido, e.linea, e.pt, id.loteB, e.unidad])
    const f = await one(
      `SELECT COALESCE(SUM(qty),0) s FROM order_reservations
        WHERE order_line_id=$1 AND status='ACTIVE'`, [e.linea])
    assert.equal(Number(f.s), 100, 'no se acumuló el reparto entre lotes')
  })

  await t.test('c) no se puede apartar MÁS de lo pedido, ni entre varios lotes', async () => {
    await assert.rejects(
      () => query(
        `INSERT INTO order_reservations (sales_order_id,order_line_id,item_id,lot_id,qty,unit_id,status,hold_type)
         VALUES ($1,$2,$3,$4,1,$5,'ACTIVE','ORDER')`,
        [e.pedido, e.linea, e.pt, id.loteA, e.unidad]),
      /RESERVA_EXCEDE_PEDIDO|23514/i,
      'aceptó apartar más unidades de las que pide la línea',
    )
  })

  await t.test('d) liberar y volver a apartar sí funciona', async () => {
    await query(`UPDATE order_reservations SET status='RELEASED', released_at=now()
                 WHERE order_line_id=$1 AND lot_id=$2`, [e.linea, id.loteA])
    const libre = await one(
      `SELECT COALESCE(SUM(qty),0) s FROM order_reservations
        WHERE order_line_id=$1 AND status IN ('ACTIVE','ASSIGNED')`, [e.linea])
    assert.equal(Number(libre.s), 40, 'la liberación no quitó el apartado')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('2 · Imprimir un albarán NO entrega el pedido', async (t) => {
  const e = id
  const pedidoDeEsta = await e.pedidoServible()
  const a = await albaranes.crearAlbaran(tx, { salesOrderId: pedidoDeEsta.id, userId: null })
  id.albaran = a.id

  const impreso = await albaranes.imprimirAlbaran(tx, { albaranId: a.id, copies: 2, userId: null })
  assert.equal(impreso.status, 'PRINTED')
  assert.equal(impreso.entregado, false, 'la propia API dice que entregado')

  const tras = await albaranes.obtener(tx, a.id)
  assert.equal(tras.status, 'PRINTED', 'imprimir avanzó el estado más allá de PRINTED')
  assert.equal(tras.delivered_at, null, 'imprimir puso fecha de entrega')
  assert.equal(tras.signed_at, null, 'imprimir puso fecha de firma')

  await t.test('a) el evento queda en el historial como PRINTED, no DELIVERED', async () => {
    const ev = await query(
      `SELECT event FROM albaran_events WHERE albaran_id=$1 ORDER BY id`, [a.id])
    const nombres = ev.map((x) => x.event)
    assert.ok(nombres.includes('CREATED'))
    assert.ok(nombres.includes('PRINTED'))
    assert.ok(!nombres.includes('DELIVERED'), `imprimir registró entrega: ${nombres.join(',')}`)
  })

  await t.test('b) el stock no se toca al imprimir', async () => {
    const l = await one(`SELECT qty_available FROM lots WHERE id=$1`, [id.loteA])
    assert.equal(Number(l.qty_available), 200, 'imprimir movió el stock')
  })

  // ESTA COMPROBACIÓN CAMBIÓ DE REGLA, y hay que decirlo.
  //
  // Antes: sin firma en pantalla, no se podía entregar.
  // Ahora: la firma está EN PAPEL. Lo que no puede faltar es QUIÉN confirma.
  //
  // Y el albarán, en cualquier caso, ya no es la puerta: la entrega se confirma
  // con la tarjeta. Así que lo que se comprueba aquí es lo contrario de lo de
  // antes — que el albarán tampoco puede hacer de puerta por la espalda.
  await t.test('c) el albarán no es una puerta de entrega, ni con firma', async () => {
    await albaranes.firmarAlbaran(tx, {
      albaranId: a.id, signerName: 'Cliente', image: pngFalso(), userId: null,
    })
    const pedido = await one(`SELECT sales_order_id FROM albaranes WHERE id=$1`, [a.id])
    const antes = await one(
      `SELECT status FROM sales_orders WHERE id=$1`, [pedido.sales_order_id])
    assert.ok(['PREPARED', 'RESERVED'].includes(antes.status),
      `firmar el albarán no puede cerrar el pedido: quedó en ${antes.status}`)
  })

  await t.test('d) y tampoco se puede firmar sin haber impreso', async () => {
    // Un pedido PROPIO: un pedido solo admite un albarán vivo, y este ya tiene
    // el suyo abierto desde el paso anterior.
    const pedidoPropio = await e.pedidoServible()
    const b = await albaranes.crearAlbaran(tx, { salesOrderId: pedidoPropio.id, userId: null })
    await assert.rejects(
      () => albaranes.firmarAlbaran(tx, {
        albaranId: b.id, signerName: 'X', image: pngFalso(), userId: null,
      }),
      /impreso/i, 'firmó un albarán que nunca se imprimió',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('3 · Una entrega solo puede descontar una vez', async (t) => {
    const e = id

    // El albarán entrega de VERDAD: llama al motor de entregas, y ese motor se
    // niega a servir un pedido sin confirmar.
    //
    // Antes esta prueba pasaba porque el albarán solo se marcaba `DELIVERED` y
    // no tocaba nada: daba por bueno exactamente el agujero que la Fase 5 acaba
    // de cerrar. Una prueba verde sobre un sistema incompleto es peor que una
    // roja, porque tranquiliza.
    // Un pedido con mercancía APARTADA de verdad. Se usa la fábrica del
    // escenario, que sabe qué lotes quedan, en vez de crear uno a mano y
    // encontrarse sin género.
    const ped3 = await e.pedidoServible()
    const a = await albaranes.crearAlbaran(tx, { salesOrderId: ped3.id, userId: null })
  await albaranes.imprimirAlbaran(tx, { albaranId: a.id, userId: null })
  await albaranes.firmarAlbaran(tx, {
    albaranId: a.id, signerName: 'Cliente', image: pngFalso(), userId: null,
  })
  const pedido3 = await one(`SELECT sales_order_id FROM albaranes WHERE id=$1`, [a.id])

  // La entrega, POR LA TARJETA. El albarán firmado solo está mirando.
  const entregado = await E.confirmarDesdeTarjeta({
    orderId: pedido3.sales_order_id, clienteId: null, userId: repartidor,
  })
  assert.equal(entregado.pedido_estado, 'DELIVERED')
  assert.equal(entregado.confirmed_via, 'TARJETA_QR')

  await t.test('a) el segundo intento se rechaza', async () => {
    await assert.rejects(
      () => E.confirmarDesdeTarjeta({
        orderId: pedido3.sales_order_id, clienteId: null, userId: repartidor,
      }),
      /ya está entregado|dos veces/i, 'permitió entregar dos veces el mismo pedido',
    )
  })

  // Lo que el albarán NO puede es lying sobre SU PROPIA fecha de entrega.
  // Escribir `status='DELIVERED'` sin `delivered_at` es una incoherencia que la
  // base detecta aunque venga por SQL, saltándose la API entera.
  await t.test('b) la base lo impide aunque se fuerce por SQL', async () => {
    const pedido = await e.pedidoServible()
    const sinFirmar = await albaranes.crearAlbaran(tx, { salesOrderId: pedido.id, userId: null })
    await albaranes.imprimirAlbaran(tx, { albaranId: sinFirmar.id, userId: null })
    await assert.rejects(
      () => query(
        `UPDATE albaranes SET status='DELIVERED', delivered_at=NULL WHERE id=$1`, [sinFirmar.id]),
      /albaran_delivered_exige_fecha|23514/i,
      'un UPDATE directo by-passó las reglas del albarán',
    )
  })

  // Y la entrega: lo que la base exige ya no es una imagen de firma, sino saber
  // QUIÉN confirmó y CUÁNDO. Sin eso, ni por SQL.
  await t.test('c) una entrega sin QUIÉN la confirmó no se puede cerrar ni por SQL',
    async () => {
    const ent = await one(
      `INSERT INTO deliveries (code,sales_order_id,status) VALUES ('ENT-T1',$1,'PICKED_UP') RETURNING id`,
      [e.pedido])
    await assert.rejects(
      () => query(`UPDATE deliveries SET status='DELIVERED', delivered_at=now() WHERE id=$1`, [ent.id]),
      /ENTREGA_SIN_CONFIRMACION|23514/i,
      'cerró una entrega sin saber quién la confirmó mediante UPDATE directo',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('4 · La firma queda asociada a la entrega correcta', async (t) => {
  const e = id
  // Dos PEDIDOS distintos, con un albarán cada uno. Antes eran dos albaranes
  // del mismo pedido, y eso ya no se permite: un pedido solo admite un albarán
  // vivo a la vez, que es justo lo que evita que uno quede huérfano.
  //
  // Tiene más sentido así: lo que se comprueba es que cada firma va con SU
  // entrega, no que dos firmas del mismo papel se separen.
  const pa = await e.pedidoServible()
  const pb = await e.pedidoServible()
  const a = await albaranes.crearAlbaran(tx, { salesOrderId: pa.id, userId: null })
  const b = await albaranes.crearAlbaran(tx, { salesOrderId: pb.id, userId: null })
  const ent1 = await one(
    `INSERT INTO deliveries (code,sales_order_id,status) VALUES ('ENT-S1',$1,'PICKED_UP') RETURNING id`,
    [pa.id])
  const ent2 = await one(
    `INSERT INTO deliveries (code,sales_order_id,status) VALUES ('ENT-S2',$1,'PICKED_UP') RETURNING id`,
    [pb.id])

  await query(`UPDATE albaranes SET delivery_id=$1 WHERE id=$2`, [ent1.id, a.id])
  await query(`UPDATE albaranes SET delivery_id=$1 WHERE id=$2`, [ent2.id, b.id])

  const png = pngFalso()
  const huella = crypto.createHash('sha256').update(png).digest('hex')
  await albaranes.imprimirAlbaran(tx, { albaranId: a.id, userId: null })
  await albaranes.firmarAlbaran(tx, {
    albaranId: a.id, signerName: 'Señor de la entrega A', image: png, userId: null,
  })
  await albaranes.imprimirAlbaran(tx, { albaranId: b.id, userId: null })
  await albaranes.firmarAlbaran(tx, {
    albaranId: b.id, signerName: 'Señora de la entrega B', image: pngFalso('otra'), userId: null,
  })

  const fa = await one(`SELECT * FROM delivery_signatures WHERE albaran_id=$1`, [a.id])
  const fb = await one(`SELECT * FROM delivery_signatures WHERE albaran_id=$1`, [b.id])

  assert.equal(fa.albaran_id, a.id, 'la firma quedó en el albarán equivocado')
  assert.equal(fb.albaran_id, b.id, 'la firma quedó en el albarán equivocado')
  assert.equal(Number(fa.delivery_id), ent1.id, 'la firma no apunta a su entrega')
  assert.equal(Number(fb.delivery_id), ent2.id, 'la firma no apunta a su entrega')
  assert.notEqual(fa.signer_name, fb.signer_name, 'las dos firmas son la misma')
  assert.equal(fa.sha256, huella, 'el hash guardado no corresponde a la imagen')

  await t.test('b) la imagen se recupera idéntica a como se envió', async () => {
    const recup = await one(`SELECT image FROM delivery_signatures WHERE albaran_id=$1`, [a.id])
    assert.equal(Buffer.from(recup.image).toString('base64'), png.toString('base64'),
      'la firma guardada no es la que se firmó')
  })

  await t.test('c) el detalle del albarán dice si tiene firma', async () => {
    const d = await albaranes.detalleAlbaran(tx, a.id)
    assert.equal(d.tieneFirma, true)
    assert.equal(d.firma.signer_name, 'Señor de la entrega A')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · Cada producción genera un lote PT único y propio del producto', async (t) => {
  const e = id

  const c1 = await siguienteCodigoLoteProducto(tx, e.pt)
  const c2 = await siguienteCodigoLoteProducto(tx, e.pt)
  const c3 = await siguienteCodigoLoteProducto(tx, e.pt)
  assert.match(c1, /^AUD-\d{4}-\d{6}$/, `formato inesperado: ${c1}`)
  assert.match(c2, /^AUD-\d{4}-\d{6}$/, `formato inesperado: ${c2}`)
  assert.match(c3, /^AUD-\d{4}-\d{6}$/, `formato inesperado: ${c3}`)
  assert.equal(new Set([c1, c2, c3]).size, 3, 'repitio codigo de lote')

  await t.test('a) el contador es INDEPENDIENTE por producto', async () => {
    const otro1 = await siguienteCodigoLoteProducto(tx, e.otro.id)
    assert.equal(otro1, `BOL-${anio}-000001`,
      `otro producto debería empezar en 1, dio ${otro1}`)
  })

  await t.test('b) dos peticiones a la vez reciben números distintos', async () => {
    // Se piden al mismo tiempo, como dos operarios que pulsan «fabricar» a la
    // vez. El contador se incrementa con INSERT … ON CONFLICT DO UPDATE, que
    // bloquea la fila: la segunda petición espera a que la primera confirme.
    //
    // NOTA HONESTA: esto demuestra la semántica del contador, no un bloqueo
    // real entre dos conexiones de PostgreSQL. PGlite serializa dentro del
    // mismo proceso, así que la concurrencia de verdad (dos conexiones, dos
    // transacciones abiertas a la vez) solo se puede probar contra un
    // PostgreSQL de servidor. Está anotado en docs/ALCANCE.md como pendiente.
    const pedir = () => tx.one(
      `INSERT INTO code_counters (scope,last_value) VALUES ('LOTE:PAR',1)
         ON CONFLICT (scope) DO UPDATE SET last_value = code_counters.last_value+1
       RETURNING last_value`)
    const rs = await Promise.all([pedir(), pedir(), pedir()])
    const valores = rs.map((r) => Number(r.last_value))
    assert.equal(new Set(valores).size, 3, `dos procesos simultáneos repitieron número: ${valores}`)
    assert.deepEqual(valores, [1, 2, 3], 'el contador no avanzó de uno en uno')
  })

  await t.test('c) el código ya usado no se puede volver a emitir', async () => {
    await query(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ('PT-AUD-00009',$1,'FINISHED_GOOD','ACTIVE',1,1,$2,'OPENING')`,
      [e.pt, e.unidad])
    await assert.rejects(
      () => query(
        `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
         VALUES ('PT-AUD-00009',$1,'FINISHED_GOOD','ACTIVE',1,1,$2,'OPENING')`,
        [e.pt, e.unidad]),
      /23505|duplicate key|uniq/i,
      'admite dos lotes con el mismo código',
    )
  })

  await t.test('d) un producto sin prefijo lo deduce del SKU, sin inventarlo', async () => {
    const sinPrefijo = await one(
      `INSERT INTO items (sku,name,category_kind,unit_id,sale_price)
       VALUES ('PT-SIN-X','Sin prefijo','FINISHED_GOOD',$1,1) RETURNING id`, [e.unidad])
    const c = await siguienteCodigoLoteProducto(tx, sinPrefijo.id)
    assert.equal(c, `SIN-${anio}-000001`, `dedujo mal el prefijo: ${c}`)
    const guardado = await one(`SELECT lot_prefix FROM items WHERE id=$1`, [sinPrefijo.id])
    assert.equal(guardado.lot_prefix, 'SIN', 'no guardó el prefijo deducido')
  })

  await t.test('e) y si el SKU tampoco da prefijo, avisa en vez de inventar', async () => {
    const ilegible = await one(
      `INSERT INTO items (sku,name,category_kind,unit_id,sale_price)
       VALUES ('PT-9','SKU ilegible','FINISHED_GOOD',$1,1) RETURNING id`, [e.unidad])
    await assert.rejects(() => siguienteCodigoLoteProducto(tx, ilegible.id), /prefijo/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test('6 y 7 · El lote PT queda unido a su producción y a sus lotes de MP', async (t) => {
  const e = id

  // Materia prima con dos lotes, para comprobar que la cadena guarda cada uno.
  const mp = await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
     VALUES ('MP-TEST-1','Materia de prueba','RAW_MATERIAL',$1,1) RETURNING id`, [e.unidad])
  const m1 = await one(
    `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
     VALUES ('MP-90001',$1,'RAW_MATERIAL','ACTIVE',5,5,$2,'OPENING') RETURNING id`, [mp.id, e.unidad])
  const m2 = await one(
    `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
     VALUES ('MP-90002',$1,'RAW_MATERIAL','ACTIVE',50,50,$2,'OPENING') RETURNING id`, [mp.id, e.unidad])

  await query(
    `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id)
     VALUES ($1,$2,1,$3)`, [e.receta, mp.id, e.unidad])

  const { producir } = await import('../src/core/produccion.js')
  const pr = await producir({
    recipeId: e.receta, cantidad: 10, caducidad: null, notas: 'prueba', usuarioId: null,
  })

  await t.test('a) la producción tiene su propio código FAB', async () => {
    assert.match(pr.produccion.code, /^FAB-\d{4}-\d{4}$/, `código raro: ${pr.produccion.code}`)
  })

  await t.test('b) el lote PT lleva el formato del producto, no del año', async () => {
    assert.equal(pr.lote.code, `AUD-${anio}-000004`,
      `esperaba AUD-${anio}-000004 y salió ${pr.lote.code}`)
  })

  await t.test('c) el lote PT apunta a su producción', async () => {
    const l = await one(
      `SELECT production_id, origin_type, lot_kind FROM lots WHERE code=$1`, [pr.lote.code])
    assert.equal(Number(l.production_id), pr.produccion.id, 'el lote PT no apunta a su producción')
    assert.equal(l.origin_type, 'PRODUCTION', 'el origen del lote no es PRODUCTION')
    assert.equal(l.lot_kind, 'FINISHED_GOOD')
  })

  await t.test('d) la producción apunta a la receta que se usó', async () => {
    const p = await one(`SELECT recipe_id FROM productions WHERE id=$1`, [pr.produccion.id])
    assert.equal(Number(p.recipe_id), e.receta)
  })

  await t.test('e) el lote PT queda unido a CADA lote de MP consumido', async () => {
    const pm = await query(
      `SELECT lot_id, actual_qty FROM production_materials WHERE production_id=$1`, [pr.produccion.id])
    assert.equal(pm.length, 2, `debería apuntar a 2 lotes de MP, apunta a ${pm.length}`)
    const ids = pm.map((r) => Number(r.lot_id)).sort((a, b) => a - b)
    assert.deepEqual(ids, [Number(m1.id), Number(m2.id)].sort((a, b) => a - b),
      'no guardó los dos lotes de MP consumidos')
    assert.ok(pm.every((r) => Number(r.actual_qty) > 0), 'guardó una cantidad consumida en cero')
  })

  await t.test('f) el stock de MP bajó de verdad y el de PT subió', async () => {
    // 10 pedidos: 5 del primer lote (que solo tenía 5) y 5 del segundo.
    const a1 = await one(`SELECT qty_available FROM lots WHERE id=$1`, [m1.id])
    const a2 = await one(`SELECT qty_available FROM lots WHERE id=$1`, [m2.id])
    assert.equal(Number(a1.qty_available), 0, 'el primer lote de MP no se vació')
    assert.equal(Number(a2.qty_available), 45, 'el segundo lote de MP no bajó')
    const pt = await one(`SELECT qty_available FROM lots WHERE code=$1`, [pr.lote.code])
    assert.equal(Number(pt.qty_available), 10, 'el PT no tiene lo fabricado')
  })

  await t.test('g) la trazabilidad llega del PT hasta los lotes de MP', async () => {
    // v_trace_backward arranca por delivery_lines y responde a «qué salió de
    // este producto entregado». Para el tramo de fábrica, sin entrega todavía,
    // está v_trace_to_material.
    const at = await query(
      `SELECT material_lot_id FROM v_trace_to_material WHERE finished_lot_id=$1`, [pr.lote.id])
    const origenes = at.map((r) => Number(r.material_lot_id)).sort((a, b) => a - b)
    assert.deepEqual(origenes, [Number(m1.id), Number(m2.id)].sort((a, b) => a - b),
      'la trazabilidad no llega a los lotes de materia prima')
  })

  await t.test('h) dos producciones del mismo producto no comparten lote', async () => {
    const pr2 = await producir({
      recipeId: e.receta, cantidad: 5, caducidad: null, notas: 'otra', usuarioId: null,
    })
    assert.notEqual(pr2.lote.code, pr.lote.code, 'dos producciones comparten el mismo lote')
    assert.notEqual(Number(pr2.lote.id), Number(pr.lote.id))
  })
})

/**
 * PNG real y válido, cada uno con un texto distinto dentro.
 *
 * La base exige que la firma pese al menos 200 bytes, así que un PNG de un
 * píxel se queda corto. Este mete la marca en un trozo `tEXt`, que es la
 * forma canónica de llevar metadatos dentro de un PNG, y de paso sirve para
 * comprobar que dos firmas distintas no se confunden entre sí.
 */
function pngFalso(sello = 'A') {
  const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const trozo = (tipo, datos) => {
    const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length)
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(cuerpo) >>> 0)
    return Buffer.concat([largo, cuerpo, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const texto = Buffer.from(`firma\u0000${sello.repeat(260)}`, 'utf8')
  return Buffer.concat([
    firma,
    trozo('IHDR', ihdr),
    trozo('tEXt', texto),
    trozo('IEND', Buffer.alloc(0)),
  ])
}
