/**
 * LA FICHA DEL PROVEEDOR.
 *
 * Compras ya funciona: se pide, se envía y se recibe. Lo que faltaba era poder
 * mirar a un proveedor y contestar, de golpe, las seis preguntas que se le
 * hacen en la vida real:
 *
 *   1. ¿Cuánto le he comprado?
 *   2. ¿Cuántas órdenes siguen abiertas?
 *   3. ¿Qué factura hay detrás de cada recepción?
 *   4. ¿Qué lotes me ha traído, y caducan cuándo?
 *   5. ¿Me está cobrando más de lo que pidió?
 *   6. ¿En qué condiciones me paga?
 *
 * Y que la ficha NO duplique nada: se apoya en órdenes, líneas y lotes que ya
 * existen y los cuenta.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-proveedores-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const V = await import('../src/core/compras.js')

let e = {}
let persona = null

test.before(async () => {
  await baseDePrueba()
  persona = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('comprador-prov','Comprador','x', now()) RETURNING id`)).id
  e = await escenario()
})
test.after(async () => { await closeDb() })

async function escenario() {
  const u = await one(`SELECT id FROM units ORDER BY id LIMIT 1`)
  const mp1 = (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost,lot_prefix)
     VALUES ('PRV-MP-1','Materia ficha','RAW_MATERIAL',$1,650,'PRV') RETURNING id`, [u.id])).id
  const mp2 = (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost,lot_prefix)
     VALUES ('PRV-MP-2','Materia ficha dos','RAW_MATERIAL',$1,1200,'PRV') RETURNING id`, [u.id])).id

  const prov = await one(
    `INSERT INTO suppliers (code, name, contact_name, phone, payment_terms_days)
     VALUES ('PRO-PRV','Química de Prueba','Fatu','+223 70 00 00 00',30) RETURNING id`)
  const otro = await one(
    `INSERT INTO suppliers (code, name) VALUES ('PRO-OTR','Otro Proveedor') RETURNING id`)

  return { mp1, mp2, prov, otro }
}

/** Una columna `DATE` llega como objeto `Date`, no como «2027-12-31». */
function diaDe(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

async function pedir(lineas, extra = {}, proveedor = null) {
  const o = await V.crearOrden({
    supplierId: proveedor || e.prov.id, lineas, userId: persona, ...extra,
  })
  await V.enviarOrden(o.id, { userId: persona })
  return o
}

// ─── 1 · La ficha existe y no se inventa nada ────────────────────────────────

test('un proveedor sin compras tiene una ficha vacía, no un error', async () => {
  const f = await V.fichaProveedor(e.otro.id, { one, query })
  assert.equal(f.name, 'Otro Proveedor')
  assert.equal(f.totales.ordenes, 0)
  assert.equal(f.totales.lotes, 0)
  assert.deepEqual(f.facturas, [])
  assert.deepEqual(f.ordenes, [])
  // Un proveedor recién dado de alta se puede abrir sin que reviente nada.
})

test('la ficha de un proveedor que no existe da 404, no un 500', async () => {
  await assert.rejects(
    () => V.fichaProveedor(99999, { one, query }),
    (err) => err.codigo === 'PROVEEDOR_NO_ENCONTRADO' && err.estado === 404,
  )
})

// ─── 2 a 5 · Contar lo que ya existe ────────────────────────────────────────

test('la ficha cuenta las órdenes, las recepciones, las facturas y los lotes', async () => {
  const o = await pedir([
    { itemId: e.mp1, qtyOrdered: 100, unitCost: 650 },
    { itemId: e.mp2, qtyOrdered: 50, unitCost: 1200 },
  ])

  // Todavía en curso: una orden abierta, cero mercancía.
  const antesDeRecibir = await V.fichaProveedor(e.prov.id, { one, query })
  assert.equal(antesDeRecibir.totales.ordenes, 1)
  assert.equal(antesDeRecibir.totales.abiertas, 1)
  assert.equal(antesDeRecibir.totales.lotes, 0, 'pedir no ha traído lotes todavía')
  assert.equal(antesDeRecibir.totales.uds_pendientes, 150)

  await V.recibirOrden(o.id, {
    lineas: [
      { lineId: o.lineas[0].id, qty: 100, supplierLotCode: 'LOTE-EXTERNO-1', expiryDate: '2027-12-31' },
      { lineId: o.lineas[1].id, qty: 50, supplierLotCode: 'LOTE-EXTERNO-2' },
    ],
    invoiceRef: 'FAC-FICHA-1', userId: persona,
  })

  const f = await V.fichaProveedor(e.prov.id, { one, query })
  assert.equal(f.totales.ordenes, 1)
  assert.equal(f.totales.abiertas, 0, 'recibida del todo: no queda abierta')
  assert.equal(f.totales.recepciones, 2, 'una recepción por línea')
  assert.equal(f.totales.lotes, 2)
  assert.equal(f.totales.facturas, 1)
  assert.deepEqual(f.facturas, ['FAC-FICHA-1'])
  assert.equal(f.totales.uds_recibidas, 150)
  assert.equal(f.totales.uds_pendientes, 0)
  //
  // «Comprado» NO es el total de los pedidos: es el valor de lo que ha ENTRADO,
  // al precio que se pagó. Son cosas distintas, y por eso van en columnas
  // distintas.
  //
  // Antes `importe_comprado` sumaba el total de las órdenes RECEIVED, con el IVA
  // incluido y sin mirar qué se había recibido de verdad. Una orden a medias
  // contaba cero: le habías pagado la mitad del pedido y el proveedor aparecía
  // con «Comprado 0».
  //
  //   comprado  = 100×650 + 50×1200 = 125 000  (lo que entró, a su coste)
  //   pendiente = 0                               (no debe nada)
  //
  assert.equal(Number(f.totales.importe_comprado), 125000,
    'comprado = lo recibido a su coste real, no el total del pedido con IVA')
  assert.equal(Number(f.totales.importe_pendiente), 0, 'y no queda nada por receber')

  // Y el detalle: qué lote, de quién y con qué caducidad.
  const r = f.recepciones.find((x) => x.supplier_lot_code === 'LOTE-EXTERNO-1')
  assert.ok(r, 'la recepción guarda el lote tal como lo llama el PROVEEDOR')
  assert.equal(diaDe(r.expiry_date), '2027-12-31')
  assert.equal(r.invoice_ref, 'FAC-FICHA-1')
  assert.equal(r.orden_code, o.code, 'y se puede volver a la orden')

  // Y las condiciones de pago, que son del maestro y no se duplican.
  assert.equal(f.payment_terms_days, 30)
  assert.equal(f.contact_name, 'Fatu')
})

// ─── 5 · LA DESVIACIÓN, QUE ES EL DATO QUE HACE FALTA ──────────────────────

test('la desviación compara lo pedido con lo pagado, sobre las MISMAS recepciones', async () => {
  // Un proveedor NUEVO, para que la desviación mida solo lo que pasa aquí. La
  // desviación es acumulada a propósito —uno quiere el historial, no el
  // último pedido—, pero eso significa que mezclarla con otro proveedor la
  // haría depender de las pruebas que se hayan escrito antes.
  const limpio = await one(
    `INSERT INTO suppliers (code, name) VALUES ('PRO-LIMPIO','Proveedor Limpio') RETURNING id`)
  // Este es el número que importa: un proveedor que sube un 8 % cada tres
  // meses avisa antes de que la compra salga cara.
  const o = await pedir([{ itemId: e.mp2, qtyOrdered: 100, unitCost: 1000 }], {}, limpio.id)
  // Se reciben 100 unidades, pero se pagan a 1 100 en vez de a 1 000.
  await V.recibirOrden(o.id, {
    lineas: [{ lineId: o.lineas[0].id, qty: 100, unitCost: 1100 }],
    invoiceRef: 'FAC-SUBIDA', userId: persona,
  })

  const f = await V.fichaProveedor(limpio.id, { one, query })
  const d = f.precios

  // Las DOS sumas tienen que caer sobre las mismas recepciones. Antes la del
  // coste pedido sumaba todas las líneas del proveedor y la del pagado solo las
  // recibidas, y salía un 15 550 %: un número tan absurdo que, de no estar en
  // rojo, habría pasado por un dato real.
  const recibidoDeEsta = 100 * 1100
  assert.equal(Number(d.coste_pagado), recibidoDeEsta,
    'lo pagado se mide sobre lo recibido')
  assert.equal(Number(d.coste_pedido), 100 * 1000, 'y lo pedido, sobre lo MISMO')
  assert.equal(Number(d.desviacion_pct), 10, 'un 10 % de subida, ni un punto más')

  // Y el detalle de cada recepción lleva su propio coste, que es donde se
  // comprueba que el almacén guardó lo que se pagó y no lo que se pidió.
  const deEsta = f.recepciones.find((x) => x.invoice_ref === 'FAC-SUBIDA')
  assert.equal(Number(deEsta.coste), 1100,
    'el lote guarda 1 100: con 1 000 la valoración del almacén miente')
})

// ─── La lista, que es lo que enseña la pantalla ─────────────────────────────

test('el listado trae los números de cada proveedor, sin traer las fichas', async () => {
  const ls = await V.listarProveedores({ soloActivos: true }, { one, query })
  const mio = ls.find((p) => p.id === e.prov.id)
  const otro = ls.find((p) => p.id === e.otro.id)
  assert.ok(mio,
    `el proveedor con compras sale. Hay ${ls.length}: ${ls.map((x) => x.code).join(', ')}`)

  assert.ok(mio, 'el proveedor con compras sale')
  assert.ok(otro, 'el proveedor sin compras también: un proveedor nuevo se ve desde el día uno')
  assert.ok(Number(mio.ordenes) >= 1, 'el proveedor con compras cuenta al menos su orden')
  assert.equal(Number(otro.ordenes), 0, 'y el que no tiene compras, con cero')

  // Y sale ORDENADO por nombre, que es como se busca a un proveedor.
  const nombres = ls.map((p) => p.name.toLowerCase())
  assert.deepEqual(nombres, [...nombres].sort(), 'la lista va por nombre, no por código')
})

// ─── Lo que la ficha NO puede hacer ─────────────────────────────────────────

test('la ficha no da acceso a la compra: es de compras, no de catálogo', async () => {
  // No es un detalle de permisos. La ficha dice LO QUE NOS HA TRAÍDO y CUÁNTO
  // LE HEMOS PAGADO. Quien puede ver un proveedor en el catálogo no tiene por
  // qué ver lo que cuesta.
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const rutas = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../src/modules/compras/rutas.js'), 'utf8')

  const linea = rutas.split('\n').find((l) => l.includes("'/suppliers/compras/:id'"))
  assert.ok(linea, 'debe existir la ficha')
  assert.match(linea, /ver/,
    'la ficha va con `purchases:view`, no con `suppliers:view`')
  assert.ok(!/suppliers', 'view'/.test(linea),
    'NO debe colarse un permiso de catálogo: vería los precios de compra')
})

// ─── LA COHERENCIA ENTRE COLUMNAS ──────────────────────────────────────────

test('comprado y pendiente suman lo pedido, sin IVA y sin huecos', async () => {
  // La prueba que hace falta cuando las columnas se calculan por separado.
  //
  // `importe_comprado` viene de los lotes (lo recibido, a su coste) y
  // `importe_pendiente` se calculaba restándolo del total de la orden. El
  // total lleva IVA y lo recibido no, así que entre las dos columnas sobraba un
  // 21 % que nadie había pedido y que no estaba en ninguna parte: un pedido de
  // 125 000 repartía 125 000 + 26 250.
  //
  // Ahora los dos se miden sobre las líneas y en la misma base, y la suma es
  // exactamente el valor de la mercancía pedida, sin IVA.
  const u2 = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id
  const art = (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix)
     VALUES ('PRV-MP-3','Materia tres','RAW_MATERIAL',$1,'PRV') RETURNING id`, [u2])).id
  const prov = (await one(
    `INSERT INTO suppliers (code, name) VALUES ('PRO-COH','Coherencia') RETURNING id`)).id

  const o = await V.crearOrden({
    supplierId: prov, lineas: [{ itemId: art, qtyOrdered: 200, unitCost: 300 }],
    userId: persona,
  })
  await V.enviarOrden(o.id, { userId: persona })
  // Se reciben 80 de 200: una recepción parcial, que es donde se rompe esto.
  await V.recibirOrden(o.id, {
    lineas: [{ lineId: o.lineas[0].id, qty: 80, unitCost: 300 }],
    userId: persona,
  })

  const f = await V.fichaProveedor(prov, { one, query })
  const comprado = Number(f.totales.importe_comprado)
  const pendiente = Number(f.totales.importe_pendiente)

  assert.equal(comprado, 80 * 300, 'comprado es lo recibido: 80×300')
  assert.equal(pendiente, 120 * 300, 'pendiente es lo que falta: 120×300')
  assert.equal(comprado + pendiente, 200 * 300,
    'los dos juntos son el valor de la mercancía pedida, sin IVA ni huecos')
})
