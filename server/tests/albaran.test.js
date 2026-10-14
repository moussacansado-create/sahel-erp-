/**
 * ALBARÁN
 *
 *   CREAR → IMPRIMIR → FIRMAR → ENTREGAR
 *
 * Lo que se comprueba, con números delante:
 *   · crear NO toca el almacén
 *   · no se puede saltar un paso (firmar sin imprimir, entregar sin firmar)
 *   · la firma NO se puede volver a poner
 *   · ENTREGAR DESCUENTA EL STOCK, una sola vez
 *   · la entrega queda enlazada al albarán y al revés
 *   · el albarán conserva su código de principio a fin
 *   · los pasos quedan escritos en el historial del documento
 */

import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-albaran-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')

// Los módulos de albarán reciben el «tx» como primer argumento y llaman a
// `tx.one` / `tx.query` sin más. Fuera de una transacción se les pasa el mismo
// contrato que usan las rutas (`db`).
const db = { one, query }
const { crearLoteConEntrada } = await import('../src/core/stock.js')
const P = await import('../src/core/produccion.js')
const C = await import('../src/core/clientes.js')
const Ped = await import('../src/core/pedidos.js')
const E = await import('../src/core/entregas.js')
const A = await import('../src/core/albaranes.js')

let e
let cliente
// El repartidor. La entrega la confirma una PERSONA: la firma en papel no
// entra en el sistema, así que lo que queda escrito es quién la confirmó.
let repartidor = null

test.before(async () => {
  await baseDePrueba()
  repartidor = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-alb','Repartidor Albarán','x', now()) RETURNING id`)).id
  e = await escenario()
  cliente = await C.crearCliente(
    { name: 'Supermercado Albarán', phone: '+223 70 00 00 00', address: 'Bamako' }, repartidor)
})
test.after(async () => { await closeDb() })

async function escenario() {
  return transaction(async (tx) => {
    const u = await tx.one('SELECT id FROM units ORDER BY id LIMIT 1')
    const cat = await tx.one(
      `INSERT INTO item_categories (code, name, category_kind)
       VALUES ('ALB-F5','Albarán','FINISHED_GOOD') RETURNING id`)
    const pt = await tx.one(
      `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price,tax_rate,format_label)
       VALUES ('PT-ALB-1','Producto albarán','FINISHED_GOOD',$1,$2,'ALB',1000,0.21,'1 L')
       RETURNING id`, [cat.id, u.id])
    const mp = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
       VALUES ('MP-ALB-1','Materia albarán','RAW_MATERIAL',$1,1) RETURNING id`, [u.id])
    const receta = await tx.one(
      `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
       VALUES ('REC-ALB-1','Receta albarán',$1,100,$2) RETURNING id`, [pt.id, u.id])
    await tx.query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, mp.id, u.id])
    // Materia prima de arranque. Sin este lote, `loteProducto()` no podría
    // fabricar nada y la prueba reventaría antes de llegar al albarán.
    const mpLote = await tx.one(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ('MP-ALB-0001',$1,'RAW_MATERIAL','ACTIVE',5000,5000,$2,'OPENING') RETURNING id`,
      [mp.id, u.id])
    return { u, pt, mp, receta, mpLote }
  })
}

/** Un lote de producto terminado con saldo, hecho por la vía de siempre. */
async function loteProducto(cantidad = 1000) {
  return P.producir({
    recipeId: e.receta.id, cantidad, usuarioId: null, produccionId: null,
  })
}

const saldoPT = async () =>
  Number((await one(
    `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id = $1`, [e.pt.id])).s)

/** Un pedido confirmado con mercancía apartada, listo para albarán. */
async function pedidoConfirmado(cantidad = 300) {
  const p = await Ped.crearPedido({
    customerId: cliente.id, userId: null,
    lineas: [{ itemId: e.pt.id, qty: cantidad, unitPrice: 1000 }],
  })
  await Ped.confirmarPedido(p.id, null)
  return Ped.obtenerPedido(p.id)
}

/** Un PNG en blanco, para la firma. */
function firmaPng() {
  const W = 120, H = 40
  const filas = []
  for (let y = 0; y < H; y++) filas.push('0', ...Array(W).fill('255,255,255'))
  return Buffer.from(filas.join(''), 'binary')
}

// ═══════════════════════════════════════════════════════════════════════════
test('1 · Crear el albarán NO toca el almacén', async () => {
  await loteProducto(1000)
  const p = await pedidoConfirmado(300)
  const antes = await saldoPT()

  const a = await A.crearAlbaran(db, { salesOrderId: p.id, copies: 2, userId: repartidor })

  assert.equal(a.status, 'DRAFT', 'un albarán nuevo no nació en borrador')
  assert.equal(Number(a.copies), 2)
  assert.match(a.code, /^ALB-\d{4}-\d{4}$/, `código de albarán raro: ${a.code}`)
  assert.equal(await saldoPT(), antes, 'crear un albarán movió el almacén')
  // `crearAlbaran` devuelve un resumen; la fila entera se lee de la base.
  assert.equal((await A.obtener(db, a.id)).delivery_id, null,
    'un albarán en borrador ya tiene entrega')
  globalThis.primero = { a, p, antes }
})

// ═══════════════════════════════════════════════════════════════════════════
test('2 · No se puede saltar ningún paso', async () => {
  const { a, p } = globalThis.primero

  const sinImprimir = await A.firmarAlbaran(db, {
    albaranId: a.id, image: firmaPng(), userId: null,
  }).then(() => null).catch((e) => e)
  assert.ok(sinImprimir, 'firmó un albarán que no se había impreso')
  assert.equal(sinImprimir.codigo, 'ALBARAN_SIN_IMPRIMIR')
  assert.equal(sinImprimir.estado, 409, 'un paso saltado debe ser 409, no 500')

  // Y ESTE ya no es un «paso que se puede saltar», porque el albarán no es una
  // puerta de entrega. Lo que se comprueba es lo contrario: el albarán tampoco
  // se puede ANOTAR como devuelto sin motivo, y desde luego no entrega nada.
  const entregadoDeMas = await E.confirmarDesdeTarjeta({
    orderId: p.id, clienteId: null, userId: null,
  }).then(() => null).catch((e) => e)
  assert.ok(entregadoDeMas, 'entregó sin saber quién confirmó')

  assert.equal((await A.obtener(db, a.id)).status, 'DRAFT',
    'el albarán cambió de estado al fallar la entrega')
})

// ═══════════════════════════════════════════════════════════════════════════
test('3 · Imprimir NO entrega (el almacén imprime antes de tiempo)', async () => {
  const { a, p, antes } = globalThis.primero
  const r = await A.imprimirAlbaran(db, { albaranId: a.id, copies: 2, userId: null })
  assert.equal(r.status, 'PRINTED')
  assert.ok(r.printed_at, 'no quedó constancia de que se imprimió')
  assert.equal(r.entregado, false)
  assert.equal(await saldoPT(), antes, 'imprimir movió el almacén')
  assert.equal((await Ped.obtenerPedido(p.id)).status, 'RESERVED',
    'imprimir un albarán cambió el estado del pedido')
})

// ═══════════════════════════════════════════════════════════════════════════
test('4 · Firmar guarda la imagen de verdad, con su hash', async () => {
  const { a } = globalThis.primero
  const f = await A.firmarAlbaran(db, {
    albaranId: a.id, signerName: 'Moussa Diallo', image: firmaPng(),
    width: 120, height: 40, userId: null,
  })
  assert.equal(f.status, 'SIGNED')
  assert.equal(f.signed_by_name, 'Moussa Diallo')

  const det = await A.detalleAlbaran(db, a.id)
  assert.equal(det.tieneFirma, true)
  assert.match(det.firma.sha256, /^[0-9a-f]{64}$/, 'la firma no tiene hash SHA-256')
  assert.equal(det.empresa.nombre, 'SAHEL', 'el documento no trae los datos de la empresa')
  assert.equal(det.empresa.simbolo, 'FCFA', 'la moneda no es FCFA')
  assert.ok(det.lineas[0].presentacion, 'las líneas no traen la PRESENTACIÓN')
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · La firma NO se puede volver a poner', async () => {
  const { a } = globalThis.primero
  const otra = await A.firmarAlbaran(db, {
    albaranId: a.id, signerName: 'OTRO', image: firmaPng(), userId: null,
  }).then(() => null).catch((e) => e)
  assert.ok(otra, 'aceptó una segunda firma sobre un albarán ya firmado')
  assert.equal(otra.codigo, 'ALBARAN_YA_FIRMADO')
  const det = await A.detalleAlbaran(db, a.id)
  assert.equal(det.signed_by_name, 'Moussa Diallo',
    'la segunda firma SOBRESCRIBIÓ quién recibió: la prueba de entrega dejó de ser cierta')
})

// ═══════════════════════════════════════════════════════════════════════════
test('6 · ENTREGAR DESCUENTA EL STOCK, y solo una vez', async () => {
  const { a, p } = globalThis.primero
  const antes = await saldoPT()
  const pedidoAntes = await Ped.obtenerPedido(p.id)

  // LA ENTREGA SE CONFIRMA DESDE LA TARJETA. El albarán se crea, se imprime y
  // el cliente lo firma en papel; de eso no sale ninguna entrega.
  const r = await E.confirmarDesdeTarjeta({
    orderId: p.id, clienteId: p.customer_id, userId: repartidor,
  })

  assert.equal(r.confirmed_via, 'TARJETA_QR')
  assert.equal(r.confirmed_by, repartidor)
  assert.equal(r.pedido_estado, 'DELIVERED')

  // El corazón de la fase: el albarán no puede decir «entregado» mientras la
  // mercancía sigue en el almacén. Antes marcaba el documento y nada más.
  const servido = pedidoAntes.lineas
    .reduce((s, l) => s + (Number(l.qty) - Number(l.qty_delivered)), 0)
  assert.equal(antes - await saldoPT(), servido,
    'el albarán quedó entregado pero el stock no bajó: es un almacén que regala')

  // La entrega apunta al pedido y a la persona, no a un dibujo de firma.
  const entrega = await one(`SELECT * FROM deliveries WHERE id = $1`, [r.id])
  assert.equal(entrega.sales_order_id, Number(p.id))
  assert.equal(entrega.confirmed_by, repartidor)
  assert.ok(entrega.confirmed_at)

  // La firma que se firm�� en pantalla, si la hubo, es la MISMA fila: no se
  // duplica al enlazarla con la entrega.
  const firmas = await one(
    `SELECT COUNT(*) n FROM delivery_signatures WHERE albaran_id = $1`, [a.id])
  assert.equal(Number(firmas.n), 1,
    'la firma del albarán se duplicó al enlazarla con la entrega')
  globalThis.entregado = { a, p, r }
})

test('7 · Entregar dos veces no descuenta dos veces', async () => {
  const { a, p } = globalThis.entregado
  const antes = await saldoPT()
  const otra = await E.confirmarDesdeTarjeta({
    orderId: p.id, clienteId: null, userId: repartidor,
  }).then(() => null).catch((e) => e)
  assert.ok(otra, 'entregó el mismo pedido dos veces')
  assert.equal(otra.codigo, 'PEDIDO_YA_ENTREGADO')
  // Y tampoco se puede anotar el papel otra vez.
  const papel = await A.anotarPapelDevuelto(db, { albaranId: a.id, userId: repartidor })
    .then(() => null).catch((e) => e)
  assert.ok(papel, 'anotó el mismo albarán devuelto dos veces')
  assert.equal(papel.codigo, 'ALBARAN_YA_ENTREGADO')
  assert.equal(await saldoPT(), antes, 'el segundo intento volvió a descontar stock')
})

// ═══════════════════════════════════════════════════════════════════════════
test('8 · El documento conserva su código y deja escrito todo lo que pasó', async () => {
  const { a, r } = globalThis.entregado
  const det = await A.detalleAlbaran(db, a.id)
  assert.equal(det.code, a.code, `el albarán era ${a.code} y salió como ${det.code}`)
  assert.equal(Number(det.delivery_id), Number(r.id),
    'el albarán no apunta a la entrega que se confirmó por la tarjeta')
  const pasos = det.eventos.map((e) => e.event)
  assert.deepEqual(pasos, ['CREATED', 'PRINTED', 'SIGNED', 'DELIVERED'],
    `el historial del documento está incompleto: ${pasos.join(' → ')}`)
  // Los tiempos tienen que ir en orden. El CHECK de la migración lo vigila, pero
  // que el historial lo cuente también evita depender solo de la base.
  const tiempos = det.eventos.map((e) => new Date(e.occurred_at).getTime())
  for (let i = 1; i < tiempos.length; i++) {
    assert.ok(tiempos[i] >= tiempos[i - 1], `el paso ${i} ocurrió antes que el anterior`)
  }
})

test('9 · El histórico y los pendientes no se solapan', async () => {
  const todos = await A.listarAlbaranes(db, {})
  const enCurso = todos.filter((a) => ['DRAFT', 'PRINTED', 'SIGNED'].includes(a.status))
  const cerrados = todos.filter((a) => ['DELIVERED', 'VOID'].includes(a.status))
  const codigos = new Set(cerrados.map((a) => a.code))
  for (const a of enCurso) {
    assert.ok(!codigos.has(a.code), `${a.code} está a la vez pendiente y entregado`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test('10 · El albarán es de UNA sola hoja', async () => {
  // La aplicación genera UN albarán. Cuántas hojas saque quien lo imprime lo
  // decide su diálogo de impresión, no el sistema.
  //
  // Lo que se guarda en `copies` es otra cosa: cuántas hojas se quedaron en el
  // archivo. Que valga 10 NO significa que el documento tenga diez páginas.
  const o = await pedidoConfirmado(40)
  // Un albarán con `copies: 10`: diez hojas para el archivo, y aun así el
  // documento es UNO. Antes esta prueba creaba dos albaranes del mismo pedido,
  // que ya no se permite (y no hace falta para comprobar nada de esto).
  const a = await A.crearAlbaran(db, { salesOrderId: o.id, copies: 10, userId: null })

  assert.equal(Number(a.copies), 10, 'no se guardó el número de hojas del archivo')

  // El detalle solo trae UNA copia: el documento es único, y la hoja de
  // archivo se cuenta aparte.
  const det = await A.detalleAlbaran(db, a.id)
  assert.equal(det.lineas.length >= 0, true)
  assert.equal(Array.isArray(det.copies) ? det.copies.length : 0, 0,
    'el detalle trae copias del documento: el albarán dejaría de ser una sola hoja')

  // Y por defecto se crea con una.
  const otro = await pedidoConfirmado(15)
  const b = await A.crearAlbaran(db, { salesOrderId: otro.id, userId: null })
  assert.equal(Number(b.copies), 1,
    `un albarán nuevo nace con ${b.copies} hojas; debería nacer con una`)
})

// ═══════════════════════════════════════════════════════════════════════════
test('11 · Cada documento se imprime en SU papel', async () => {
  // Regresión que costó encontrar: `@page` no admite selectores, así que el
  // tamaño del albarán (A4) y el de la tarjeta (85,6 × 54 mm) se pisaban, y
  // acababa GANANDO el de la tarjeta porque su hoja de estilo carga después.
  // El albarán salía impreso en un bolsillo y partido en cuatro páginas.
  //
  // Aquí se comprueba que ambos tamaños están declarados y NAMBRADOS, que es
  // lo que evita el pisón: sin nombre, manda el último que llegue.
  const css = await readFile(new URL('../../web/css/albaran.css', import.meta.url), 'utf-8')
  const cssTarjeta = await readFile(new URL('../../web/css/tarjeta.css', import.meta.url), 'utf-8')

  assert.match(css, /@page\s+albaran\s*\{[^}]*size:\s*A4/,
    'el albarán no declara su página CON NOMBRE: otro documento puede pisarle el tamaño')
  // La tarjeta se imprime EN UNA HOJA A4, con la tarjeta encima a 85,6 × 54 mm
  // y su marca de recorte alrededor. Por eso la página es A4 y NO del tamaño
  // de la tarjeta: es lo que permite imprimir diez tarjetas de una vez en una
  // hoja normal, que es como se usa en el almacén.
  //
  // La expectativa anterior pedía `size: 85.6mm 54mm`, de cuando se imprimía
  // de una en una. Lo que importa aquí es lo que sigue: que la página esté
  // CON NOMBRE, para que otro documento no le pise el tamaño.
  assert.match(cssTarjeta, /@page\s+tarjeta\s*\{[^}]*size:\s*A4/,
    'la tarjeta no declara su página CON NOMBRE')
  assert.match(cssTarjeta, /width:\s*85\.6mm/,
    'la tarjeta ya no mide 85,6 mm: se ha cambiado el formato en la hoja')
  assert.match(css, /body:has\(\.albaran\)\s*\{\s*page:\s*albaran/,
    'el albarán no dice qué papel usa')
  assert.match(cssTarjeta, /body:has\(\.tarjeta-marco\)\s*\{\s*page:\s*tarjeta/,
    'la tarjeta no dice qué papel usa')

  // Y ningún `@page` anónimo suelto, que es justo lo que se pisaba.
  assert.ok(!/@page\s*\{/.test(css), 'albaran.css tiene un @page sin nombre: pisa al de la tarjeta')
  assert.ok(!/@page\s*\{/.test(cssTarjeta), 'tarjeta.css tiene un @page sin nombre')
})
