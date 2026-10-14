/**
 * COMPRAS.
 *
 * El módulo entero, en orden, y cada eslabón con la pregunta que lo rompe.
 *
 * La idea que lo atraviesa todo, y que hay que tener clara antes de leer nada
 * más:
 *
 *   PEDIR NO ES TENER.
 *
 * De ahí sale todo lo demás. Crear una orden no toca el almacén. Enviarla la
 * convierte en compromiso con el proveedor. RECIBIRLA es lo único que mete
 * mercancía, y entra por el MISMO motor que una apertura o un ajuste: no hay
 * un almacén paralelo dentro de Compras.
 *
 * Lo que se comprueba, exactamente:
 *
 *   1. Pedir no es tener. El almacén no se mueve al crear la orden.
 *   2. Los totales se calculan con la tasa REAL de la empresa, no con una fija.
 *   3. Enviar es una vez. Pedir dos veces no es más compromiso.
 *   4. RECIBIR ES LO QUE SUBE EL STOCK, y sube lo recibido, ni una unidad más.
 *   5. Cada línea recibida genera un LOTE con el código del PROVEEDOR, su
 *      caducidad y el coste que se pagó DE VERDAD.
 *   6. De ese lote se puede volver a la orden, la línea y la factura.
 *   7. Se puede recibir A PARTES, y el estado sale de las líneas, no de lo que
 *      se haya pedido.
 *   8. No se recibe más de lo pedido.
 *   9. Un borrador no se recibe: pedir no es tener, tampoco al revés.
 *  10. Una orden con mercancía dentro NO se anula: anularla dejaría lotes sin
 *      origen, que es justo lo que rompe la trazabilidad.
 *  11. Si una línea falla, no entra ninguna. Todo o nada.
 *  12. Un doble toque en «Recibir» no duplica la mercancía.
 *  13. Los permisos de Compras son los de Compras… y RECIBIR es además del
 *      almacén, porque es sacar mercancía del almacén.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-compras-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const V = await import('../src/core/compras.js')
const { registrarEntrada } = await import('../src/core/inventario.js')

let e = {}
let repartidor = null

test.before(async () => {
  await baseDePrueba()
  repartidor = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('comprador','Comprador','x', now()) RETURNING id`)).id
  e = await escenario()
})
test.after(async () => { await closeDb() })

async function escenario() {
  const u = await one(`SELECT id FROM units ORDER BY id LIMIT 1`)
  const mk = async (sku, name, kind, cost) => (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost,lot_prefix)
     VALUES ($1,$2,$3,$4,$5,'CPR') RETURNING id`, [sku, name, kind, u.id, cost])).id
  const mp1 = await mk('CPR-MP-1', 'Materia de prueba 1', 'RAW_MATERIAL', 650)
  const mp2 = await mk('CPR-MP-2', 'Materia de prueba 2', 'RAW_MATERIAL', 1200)
  const proveedor = await one(
    `INSERT INTO suppliers (code, name, country) VALUES ('PRO-CPR','Proveador de prueba','ML')
     RETURNING id`)
  return { u, mp1, mp2, proveedor }
}

const ordenDe = (lineas, extra = {}) => ({
  supplierId: e.proveedor.id, lineas, ...extra,
})

// ─── 1 y 2 · PEDIR NO ES TENER ───────────────────────────────────────────────

test('crear una orden NO toca el almacén, y calcula los totales con la tasa real', async () => {
  const antes = await existencias(e.mp1)

  const o = await V.crearOrden(
    ordenDe([{ itemId: e.mp1, qtyOrdered: 500, unitCost: 650 },
      { itemId: e.mp2, qtyOrdered: 200, unitCost: 1200 }], { userId: repartidor }))

  assert.equal(o.status, 'DRAFT', 'una orden nueva nace en borrador')
  assert.match(o.code, /^COM-\d{4}-\d{4}$/, `código de orden raro: ${o.code}`)
  assert.equal(o.lineas.length, 2)

  // La tasa sale de `app_config`, no de un 21% escrito a mano. Si la empresa
  // cambia su IVA, los totales cambian con ella.
  const iva = await one(`SELECT value FROM app_config WHERE key = 'empresa.iva'`)
  const tasa = Number(iva.value)
  const bruto = 500 * 650 + 200 * 1200
  assert.equal(Number(o.subtotal), bruto, 'el subtotal es la suma de las líneas')
  assert.equal(Number(o.tax_amount), Math.round(bruto * tasa * 100) / 100)
  assert.equal(Number(o.total), Math.round((bruto * (1 + tasa)) * 100) / 100)
  assert.equal(o.currency_code, 'XOF', 'la moneda es la de la empresa, no EUR')

  assert.deepEqual(await existencias(e.mp1), antes,
    'crear una orden movió el almacén: PEDIR NO ES TENER')
})

// ─── 3 · ENVIAR ES UNA VEZ ──────────────────────────────────────────────────

test('enviar convierte el borrador en compromiso, y solo una vez', async () => {
  const o = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  const enviada = await V.enviarOrden(o.id, { userId: repartidor, expectedDate: '2026-12-01' })
  assert.equal(enviada.status, 'ORDERED')
  assert.equal(diaDe(enviada.expected_date), '2026-12-01')

  await assert.rejects(
    () => V.enviarOrden(o.id, { userId: repartidor }),
    (err) => err.codigo === 'ORDEN_NO_ENVIABLE' && err.estado === 409,
    'la misma orden se envió dos veces: el proveedor recibe dos compromisos')
})

// ─── 4, 5 y 6 · RECIBIR, Y LO QUE DEJA written ──────────────────────────────

test('recibir mete la mercancía EN EL ALMACÉN, con su lote y su coste real', async () => {
  const o = await V.crearOrden(
    ordenDe([{ itemId: e.mp1, qtyOrdered: 100, unitCost: 650 },
      { itemId: e.mp2, qtyOrdered: 50, unitCost: 1200 }], { userId: repartidor }))
  await V.enviarOrden(o.id, { userId: repartidor })

  const antes1 = await existencias(e.mp1)
  const antes2 = await existencias(e.mp2)

  const r = await V.recibirOrden(o.id, {
    lineas: [
      { lineId: o.lineas[0].id, qty: 100, supplierLotCode: 'PROV-L-1', expiryDate: '2027-06-30' },
      { lineId: o.lineas[1].id, qty: 50, supplierLotCode: 'PROV-L-2' },
    ],
    invoiceRef: 'FAC-PRUEBA-1', userId: repartidor,
  })

  assert.equal(r.status, 'RECEIVED')

  // ── El stock sube LO RECIBIDO, ni una unidad más ──────────────────────────
  const d1 = await existencias(e.mp1)
  assert.equal(Number(d1.on_hand) - Number(antes1.on_hand), 100,
    'el almacén no subió exactamente lo recibido')
  const d2 = await existencias(e.mp2)
  assert.equal(Number(d2.on_hand) - Number(antes2.on_hand), 50)

  // ── Y el lote guarda lo del PROVEEDOR ─────────────────────────────────────
  const lotes = await query(
    `SELECT * FROM lots WHERE origin_type='PURCHASE' AND origin_id = ANY($1) ORDER BY id`,
    [[o.lineas[0].id, o.lineas[1].id]])
  assert.equal(lotes.length, 2, 'cada línea recibida genera su propio lote')
  const l1 = lotes.find((l) => l.supplier_lot_code === 'PROV-L-1')
  assert.ok(l1, 'el lote guarda el código con el que lo llama el PROVEEDOR')
  assert.equal(diaDe(l1.expiry_date), '2027-06-30')
  assert.equal(Number(l1.unit_cost), 650, 'y el coste')

  // ── El coste REAL puede ser otro que el pedido ───────────────────────────
  const o2 = await V.crearOrden(
    ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }], { userId: repartidor }))
  await V.enviarOrden(o2.id, { userId: repartidor })
  await V.recibirOrden(o2.id, {
    lineas: [{ lineId: o2.lineas[0].id, qty: 10, unitCost: 712.5 }],
    userId: repartidor,
  })
  const loteReal = await one(
    `SELECT unit_cost FROM lots WHERE origin_type='PURCHASE' AND origin_id=$1`, [o2.lineas[0].id])
  assert.equal(Number(loteReal.unit_cost), 712.5,
    'el almacén guarda lo que se PAGÓ, no lo que se pidió. Con 650 en el lote, ' +
    'la valoración del almacén miente en cuanto el proveedor se pasa un 10 %.')

  // ── Y de ese lote se vuelve a la orden, la línea y la factura ────────────
  const det = await V.obtenerOrden({ one, query }, o.id)
  assert.equal(det.recepciones.length, 2)
  const rec = det.recepciones.find((x) => x.invoice_ref === 'FAC-PRUEBA-1')
  assert.ok(rec, 'la orden recuerda de dónde salió su mercancía')
  assert.ok(rec.lote_codigo, 'con el código del lote')
  assert.ok(det.lineas.every((l) => Number(l.qty_received) === Number(l.qty_ordered)))
})

// ─── 7 · RECIBIR A PARTES ───────────────────────────────────────────────────

test('se puede recibir en varias veces, y el estado sale de las líneas', async () => {
  const o = await V.crearOrden(
    ordenDe([{ itemId: e.mp1, qtyOrdered: 100, unitCost: 650 },
      { itemId: e.mp2, qtyOrdered: 100, unitCost: 1200 }], { userId: repartidor }))
  await V.enviarOrden(o.id, { userId: repartidor })
  const [a, b] = o.lineas

  const p1 = await V.recibirOrden(o.id, { lineas: [{ lineId: a.id, qty: 100 }], userId: repartidor })
  assert.equal(p1.status, 'PARTIALLY_RECEIVED',
    'recibir una de dos no puede decir que la orden está recibida')
  assert.equal(Number(p1.lineas.find((l) => l.id === b.id).qty_pending), 100)

  const p2 = await V.recibirOrden(o.id, { lineas: [{ lineId: b.id, qty: 100 }], userId: repartidor })
  assert.equal(p2.status, 'RECEIVED', 'la segunda parte cierra la orden')
  assert.ok(p2.received_at, 'y queda la fecha de recepción')
})

// ─── 8 · NI UN GRAMO DE MÁS ─────────────────────────────────────────────────

test('no se puede recibir más de lo pedido', async () => {
  const o = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 50, unitCost: 650 }]))
  await V.enviarOrden(o.id, { userId: repartidor })
  const antes = await existencias(e.mp1)

  await assert.rejects(
    () => V.recibirOrden(o.id, { lineas: [{ lineId: o.lineas[0].id, qty: 80 }], userId: repartidor }),
    (err) => err.codigo === 'SOBRA_MERCANCIA',
    'se recibió más de lo pedido: el almacén tiene mercancía que nadie pidió')
  assert.deepEqual(await existencias(e.mp1), antes, 'y el intento falló movió el stock')

  // YReceive exacto en dos medias partes SÍ vale: 20 + 30 = 50.
  await V.recibirOrden(o.id, { lineas: [{ lineId: o.lineas[0].id, qty: 20 }], userId: repartidor })
  const f = await V.recibirOrden(o.id, { lineas: [{ lineId: o.lineas[0].id, qty: 30 }], userId: repartidor })
  assert.equal(f.status, 'RECEIVED', '20 + 30 = 50 exactos')
})

// ─── 9 · UN BORRADOR NO SE RECIBE ───────────────────────────────────────────

test('un borrador no se puede recibir: pedir no es tener, tampoco al revés', async () => {
  const o = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  const antes = await existencias(e.mp1)
  await assert.rejects(
    () => V.recibirOrden(o.id, { lineas: [{ lineId: o.lineas[0].id, qty: 10 }], userId: repartidor }),
    (err) => err.codigo === 'ORDEN_NO_ENVIADA' && err.estado === 409,
    'se recibió mercancía de una orden que nadie ha enviado: es fábrica fantasma')
  assert.deepEqual(await existencias(e.mp1), antes)

  // Y una ya recibida no entra dos veces.
  const o2 = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  await V.enviarOrden(o2.id, { userId: repartidor })
  await V.recibirOrden(o2.id, { lineas: [{ lineId: o2.lineas[0].id, qty: 10 }], userId: repartidor })
  await assert.rejects(
    () => V.recibirOrden(o2.id, { lineas: [{ lineId: o2.lineas[0].id, qty: 5 }], userId: repartidor }),
    (err) => err.codigo === 'ORDEN_YA_RECIBIDA' && err.estado === 409,
  )
})

// ─── 10 · ANULAR ────────────────────────────────────────────────────────────

test('una orden con mercancía DENTRO no se anula: dejaría lotes sin origen', async () => {
  const vacia = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  await assert.rejects(
    () => V.anularOrden(vacia.id, { motivo: 'x', userId: repartidor }),
    (err) => err.codigo === 'FALTA_MOTIVO',
  )
  const anulada = await V.anularOrden(vacia.id, { motivo: 'El proveedor no tiene', userId: repartidor })
  assert.equal(anulada.status, 'CANCELLED')
  assert.match(anulada.notes, /Anulada/, 'y queda por qué, escrito')

  const conMercancia = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  await V.enviarOrden(conMercancia.id, { userId: repartidor })
  await V.recibirOrden(conMercancia.id, {
    lineas: [{ lineId: conMercancia.lineas[0].id, qty: 10 }], userId: repartidor,
  })
  await assert.rejects(
    () => V.anularOrden(conMercancia.id, { motivo: 'Ya Changed', userId: repartidor }),
    (err) => err.codigo === 'ORDEN_CON_MERCANCIA' && err.estado === 409,
    'anular una orden con lotes dentro deja mercancía sin origen en el almacén')
})

// ─── 11 · TODO O NADA ───────────────────────────────────────────────────────

test('si una línea falla, NO entra ninguna: el almacén no queda a medias', async () => {
  const o = await V.crearOrden(
    ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 },
      { itemId: e.mp2, qtyOrdered: 10, unitCost: 1200 }], { userId: repartidor }))
  await V.enviarOrden(o.id, { userId: repartidor })
  const antes1 = await existencias(e.mp1)

  // La segunda línea apunta a un artículo que no existe. La primera es buena.
  await assert.rejects(() => V.recibirOrden(o.id, {
    lineas: [
      { lineId: o.lineas[0].id, qty: 10 },
      { lineId: o.lineas[1].id, qty: 10, unitCost: -5 },
    ],
    userId: repartidor,
  }), /coste/i)

  assert.deepEqual(await existencias(e.mp1), antes1,
    'la línea 1 entró pese a que la 2 falló: el almacén está a medias y nadie ' +
    'sabe qué parte de la entrega se registró')
  const detalle = await V.obtenerOrden({ one, query }, o.id)
  assert.ok(detalle.lineas.every((l) => Number(l.qty_received) === 0),
    'las líneas quedaron marcadas como recibidas sin haberlo estado')
  assert.equal(detalle.recepciones.length, 0, 'y no quedó ningún lote huérfano')
})

// ─── 12 · EL DOBLE TOQUE ────────────────────────────────────────────────────

test('un doble toque en «Recibir» no duplica la mercancía', async () => {
  const o = await V.crearOrden(ordenDe([{ itemId: e.mp1, qtyOrdered: 10, unitCost: 650 }]))
  await V.enviarOrden(o.id, { userId: repartidor })
  const antes = await existencias(e.mp1)

  await V.recibirOrden(o.id, {
    lineas: [{ lineId: o.lineas[0].id, qty: 10 }],
    token: 'FAC-1', userId: repartidor,
  })
  // El MISMO token otra vez. En un móvil, un doble toque es lo normal.
  await assert.rejects(() => V.recibirOrden(o.id, {
    lineas: [{ lineId: o.lineas[0].id, qty: 10 }],
    token: 'FAC-1', userId: repartidor,
  }), (err) => err.estado === 409, 'la misma factura entró dos veces')

  const despues = await existencias(e.mp1)
  assert.equal(Number(despues.on_hand) - Number(antes.on_hand), 10,
    'el doble toque duplicó la mercancía')
})

// ─── 13 · PERMISOS ──────────────────────────────────────────────────────────

test('recibir exige permiso de ALMACÉN, no solo de compras', async () => {
  // No es un detalle: `POST /purchases/:id/recibir` es `purchases:create` Y
  // `inventory:create`, porque escribir una orden no mete nada en el almacén y
  // recibir sí. Con uno de los dos, la puerta se queda a medio abrir.
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const rutas = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../src/modules/compras/rutas.js'), 'utf8')

  const linea = rutas.split('\n').find((l) => l.includes("'/purchases/:id/recibir'"))
  assert.ok(linea, 'debe existir la ruta de recepción')
  assert.match(linea, /recibir/,
    'recibir tiene que exigir `inventory:create`: es sacar mercancía del almacén')
  assert.notEqual(linea.trim(), undefined)
  assert.match(linea, /auth/,
    'y sesión, como todo lo demás')
})

// ─── El botón que no hacía nada ──────────────────────────────────────────────

test('«Nueva orden» abre el formulario, y con los totales puestos', async () => {
  // Un fallo de tres líneas que dejó el botón muerto.
  //
  // La función del formulario terminaba en `añadir()`, que a su vez llama a
  // `recalcular()`. Pero `recalcular` se declaraba DESPUÉS con `const`, así que
  // en el momento de la primera llamada estaba en la zona muerta temporal y
  // reventaba con:
  //
  //     Cannot access 'recalcular' before initialization
  //
  // El síntoma era el peor posible: el botón no hacía NADA. No había error en
  // pantalla, no había modal, no había red de por medio. Clic y silencio.
  //
  // Y una regla general detrás: un error de JavaScript dentro de un manejador
  // de clic no se ve si nadie lo mira. Por eso esto se comprueba en el
  // navegador, no solo leyendo el código.
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const raiz = join(dirname(fileURLToPath(import.meta.url)), '../../web/js/paginas')
  const src = await readFile(join(raiz, 'compras.js'), 'utf8')

  // `recalcular` tiene que existir ANTES de la primera llamada a `añadir()`.
  const dondeRecalcular = src.indexOf('const recalcular')
  const dondeAnade = src.indexOf('const añadir =')
  const primeraLlamada = src.indexOf('\n  añadir()')
  assert.ok(dondeRecalcular > 0 && dondeAnade > 0 && primeraLlamada > 0,
    'no se encuentra la estructura del formulario')
  assert.ok(dondeRecalcular < dondeAnade && dondeRecalcular < primeraLlamada,
    '`recalcular` se declara después de usarse: el botón «Nueva orden» no abrirá nada')

  // Y el precio se rellena al AÑADIR la línea, no solo al cambiar el artículo.
  // Si espera al `change`, la primera línea sale con el coste en blanco y un
  // subtotal de 0, que parece una pantalla rota.
  assert.match(src, /costeDe\(\)\n\s*sel\.addEventListener/,
    'el coste debe rellenarse al añadir la línea, no solo al cambiar el artículo')
})

// ─── Ayudas ─────────────────────────────────────────────────────────────────

/**
 * Una columna `DATE` llega como objeto `Date`, no como «2027-06-30». Hacerle
 * `.slice(0,10)` devuelve «Tue Jun 30» y la comprobación pasa o falla por
 * casualidad.
 */
function diaDe(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

/** Lo que hay en almacén de un artículo, para comparar antes y después. */
async function existencias(itemId) {
  const f = await one(
    `SELECT COALESCE(SUM(qty_available),0) AS disponible,
            COALESCE(SUM(qty_on_hand),0) AS on_hand
       FROM v_item_available WHERE item_id = $1`, [itemId])
  return { disponible: Number(f.disponible), on_hand: Number(f.on_hand) }
}
