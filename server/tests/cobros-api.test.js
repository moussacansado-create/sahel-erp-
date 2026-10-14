import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-cobros-api-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const {
  baseDePrueba, query, one, closeDb,
} = await import('./banco.js')
const { createApp } = await import('../src/app.js')
const { request } = await import('./supertest-helper.js')
const { hashPassword } = await import('../src/security/passwords.js')
const C = await import('../src/core/clientes.js')
const { transaction } = await import('./banco.js')

const CONTRA = 'cobros-api-prueba-1'
const CONTRA_CAJA = 'cobros-api-caja-1'

let app
let tokRepartidor
let tokCajero
let tokAdmin
let adm
let repartidor   // rol DELIVERY: es quien está en la puerta con la tarjeta
let cajero       // rol ACCOUNTING: es quien recibe el dinero
let cli
let token
let art
let unidad

await baseDePrueba()
app = createApp()

adm = (await one(
  `INSERT INTO users (username, full_name, password_hash, password_changed_at)
   VALUES ('cob_admin', 'Admin cobros', $1, now()) RETURNING id`,
  [await hashPassword(CONTRA)])).id
repartidor = (await one(
  `INSERT INTO users (username, full_name, password_hash, password_changed_at)
   VALUES ('cob_rep', 'Repartidor cobros', $1, now()) RETURNING id`,
  [await hashPassword(CONTRA)])).id
cajero = (await one(
  `INSERT INTO users (username, full_name, password_hash, password_changed_at)
   VALUES ('cob_caja', 'Cajero cobros', $1, now()) RETURNING id`,
  [await hashPassword(CONTRA_CAJA)])).id

for (const [u, r] of [[adm, 'ADMIN'], [repartidor, 'DELIVERY'], [cajero, 'ACCOUNTING']]) {
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, (SELECT id FROM roles WHERE code = $2)`, [u, r])
}

tokAdmin = (await request(app).post('/api/auth/login')
  .send({ username: 'cob_admin', password: CONTRA })).body.access
tokRepartidor = (await request(app).post('/api/auth/login')
  .send({ username: 'cob_rep', password: CONTRA })).body.access
tokCajero = (await request(app).post('/api/auth/login')
  .send({ username: 'cob_caja', password: CONTRA_CAJA })).body.access

//
// El cliente se crea con SU función, no con un INSERT.
//
// El token QR se genera dentro de `crearCliente()` —192 bits, opaco— y la
// columna es NOT NULL: si se inserta a mano sin token, la base lo para. Es un
// recordatorio de que esa columna no es un campo más: es la credencial que
// autoriza a ver los pedidos de un cliente desde la puerta de su casa.
//
const cliente = await C.crearCliente({ name: 'Cliente de la prueba' }, repartidor)
cli = cliente.id
token = (await one('SELECT qr_token FROM customers WHERE id = $1', [cli])).qr_token
unidad = (await one('SELECT id FROM units ORDER BY id LIMIT 1')).id
art = (await one(
  `INSERT INTO items (sku, name, category_kind, unit_id, lot_prefix, sale_price, tax_rate)
   VALUES ('PT-COB-1', 'Producto cobro', 'FINISHED_GOOD', $1, 'COB', 100, 0.21)
   RETURNING id`, [unidad])).id

/**
 * Un pedido que sale en la tarjeta: línea, reserva y lote.
 *
 * Los totales se derivan de la LÍNEA, no se escriben a mano. Hay un disparador
 * que los recalcula desde `sales_order_lines`, y la primera versión de este
 * helper escribía un `total` que no cuadraba con su línea: el disparador lo
 * corrigió y el total acabó siendo otro. No es un fallo del sistema —es que
 * estaba haciendo bien su trabajo— pero una prueba que espera un número y la
 * base le da otro no está probando el número: está probando la suerte.
 *
 * @param {number} precioUnitario  lo que vale una unidad, en la moneda del pedido
 */
async function pedidoEntregable(codigo, moneda, precioUnitario) {
  const qty = 10
  const subtotal = Number((precioUnitario * qty).toFixed(4))
  const impuesto = Number((subtotal * 0.21).toFixed(4))
  const total = Number((subtotal + impuesto).toFixed(4))
  const o = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ($1,$2,'PREPARED',CURRENT_DATE,$3,$4,0.21,$5,$6,$7) RETURNING id`,
    [codigo, cli, moneda, subtotal, impuesto, total, adm])).id
  //
  // El lote, con SU función. `crearLoteConEntrada` monta el lote entero —y su
  // movimiento de entrada— en la transacción que le pases. Con un INSERT a
  // mano aparecen columnas que no son opcionales (`origin_type`), y además el
  // lote existiría sin su movimiento, que es un libro mayor descuadrado desde
  // el primer segundo.
  //
  const { crearLoteConEntrada } = await import('../src/core/stock.js')
  const l = (await transaction(async (tx) => {
    const creado = await crearLoteConEntrada(tx, {
      code: `L-${codigo}`, itemId: art, lotKind: 'FINISHED_GOOD',
      initialQty: 100, unitId: unidad, expiryDate: '2027-01-01',
      originType: 'OPENING', userId: null,
    })
    return creado.id
  }))
  await query(
    `INSERT INTO sales_order_lines
       (sales_order_id, item_id, qty, unit_id, unit_price, tax_rate, line_total)
     VALUES ($1,$2,$3,$4,$5,0.21,$6)`, [o, art, qty, unidad, precioUnitario, subtotal])
  await query(
    `INSERT INTO order_reservations
       (sales_order_id, order_line_id, item_id, lot_id, qty, unit_id, status)
     SELECT s.sales_order_id, s.id, s.item_id, $2::bigint, 10, $3::bigint, 'ACTIVE'
       FROM sales_order_lines s WHERE s.sales_order_id = $1::bigint`,
    [o, l, unidad])
  //
  // Se devuelve EL TOTAL, no solo el id. Que la prueba lo use en vez de
  // escribirlo es toda la diferencia entre comprobar una regla y comprobar que
  // el número que me esperaba seguía ahí: con el número escrito a mano, un
  // cambio en el helper salía como un fallo de la regla, y tocaba adivinar.
  //
  return { id: o, total }
}
const post = (cuerpo, tok = tokRepartidor) => request(app)
  .post('/api/payments').set('authorization', `Bearer ${tok}`).send(cuerpo)


test('EL CONTRATO · POST /api/payments no tiene ningún campo de importe', async () => {
  //
  // Esto no prueba que el backend lo ignore: lo comprueba el 2. Esto comprueba
  // algo más básico y más difícil de arreglar por costumbre: que el CONTRATO no
  // tenga un hueco por donde meter un importe.
  //
  // Un endpoint que acepta `amount` es un endpoint que algún día alguien usa
  // mandándolo, aunque hoy el backend lo deseche.
  //
  //
  // Se lee el FICHERO, no el router en memoria.
  //
  // `express.Router()` devuelve una función cuyas rutas se añaden después con
  // métodos de prototipo, así que su `toString()` son 72 caracteres y no
  // contiene ni una línea del endpoint. Lo que se mira, entonces, es el
  // código: que el manejador de POST /payments no lea ningún importe.
  //
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const ruta = fileURLToPath(new URL('../src/modules/ventas/rutas.js', import.meta.url))
  const fuente = readFileSync(ruta, 'utf8')
  const src = fuente

  assert.ok(src.includes("router.post('/payments'"),
    'existe POST /api/payments')

  // Solo el manejador, no todo el fichero: los GET de clientes y pedidos sí
  // mentioning importes en otros sitios, y no es lo que se está mirando.
  const manejador = src.slice(
    src.indexOf("router.post('/payments'"),
    src.indexOf('export default router'))
  assert.ok(manejador.length > 200, 'el manejador del cobro se ha leído entero')

  // Lo que el backend le PASA a `cobrar()`. Un `amount` aquí sería leerlo.
  // Y `cuerpo: cuerpo` a secas es lo que hace el resto fiable: que el núcleo
  // reciba el JSON entero y sea él el que decide qué campo es un importe.
  // Si aquí se hiciera `cuerpo: { pedidoId, metodo }`, el backend estarías
  // decidiendo qué es importante, y eso es justo lo que se quiere evitar.
  const called = src.match(/await cobrar\(\{[\s\S]*?\}\)/)
  assert.ok(called, 'el endpoint llama a cobrar()')
  assert.ok(!/\bamount\b/.test(called[0]),
    `el endpoint NO lee «amount» del cuerpo: ${called[0].slice(0, 80)}`)
  assert.ok(!/req\.body\.\s*(amount|importe|precio|total)/.test(manejador),
    'el endpoint no lee ningún campo de importe del cuerpo')
  assert.ok(!/\b(amount|precio)\b\s*[:,)]/.test(manejador.match(/cuerpo: cuerpo[^)]*\)/)?.[0] || ''),
    'y el cuerpo se pasa entero, para que sea el núcleo quien mire pieza a pieza')
})

test('EL CONTRATO · el núcleo de cobros rechaza un importe, con NOMBRE y todo', async () => {
  const { cobrar } = await import('../src/core/cobros.js')

  //
  // No un campo: los cinco nombres que se le ocurren a alguien. `amount` es el
  // de la API; `importe` y `total` los de nuestra propia pantalla; `precio` el que
  // ponería alguien que piensa en cotizaciones. Todos se rechazan.
  //
  for (const campo of ['amount', 'importe', 'precio', 'total', 'importe_pedido']) {
    await assert.rejects(
      () => cobrar({
        pedidoId: 1, metodo: 'CASH', usuarioId: adm,
        extra: { [campo]: 500000 },
      }),
      (e) => e.codigo === 'IMPORTE_NO_ADMISIBLE',
      `«${campo}» se rechaza con su propio código, no se ignora en silencio`,
    )
  }
})

test('EL CONTRATO · mandar un importe NO registra ese importe', async () => {
  // Un pedido de 121, de verdad, entregable.
  const { id: pedido, total } = await pedidoEntregable('PED-1', 'XOF', 121)

  const antes = await one(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE sales_order_id = $1`, [pedido])

  const r = await post({
    pedidoId: pedido, metodo: 'CASH', amount: 500000, importe: 500000,
  })

  assert.equal(r.status, 400, 'la petición con importe se rechaza')
  assert.equal(r.body.codigo, 'IMPORTE_NO_ADMISIBLE')

  // Y lo importante: en la base no hay ni un céntimo de ese número.
  const despues = await one(
    `SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM payments WHERE sales_order_id = $1`,
    [pedido])
  assert.equal(Number(despues.n), 0, 'no se registró NINGÚN cobro')
  assert.equal(Number(despues.s), 0)
  assert.equal(Number(antes.s), 0)
})

test('EL CONTRATO · 500000 tampoco entra por la puerta de atrás', async () => {
  // El mismo número, con las comillas changes: como texto, como entero, en
  // negativo, en notación científica. Cualquier camino que no sea el esperado.
  const { id: pedido, total } = await pedidoEntregable('PED-2', 'XOF', 121)
  const deHuerfano = [
    { pedidoId: pedido, metodo: 'CASH', amount: 500000 },
    { pedidoId: pedido, metodo: 'CASH', amount: '500000' },
    { pedidoId: pedido, metodo: 'CASH', amount: 5e5 },
    { pedidoId: pedido, metodo: 'CASH', amount: -500000 },
    { pedidoId: pedido, metodo: 'CASH', extra: { amount: 500000 } },
    { pedidoId: pedido, metodo: 'CASH', Amount: 500000 },
    { pedidoId: pedido, metodo: 'CASH', AMOUNT: 500000 },
  ]
  //
  // La regla es «lo ignore o lo rechace». Las dos cosas valen, y por eso este
  // test NO mira el código de respuesta: mira lo que hay en la base.
  //
  // Un importe anidado —`{"extra": {"amount": …}}`— no es un campo del
  // contrato, es basura dentro de un campo del contrato, y lo natural es que no
  // se mire. Lo que no vale bajo ningún concepto es que ese número llegue a
  // existir como cobro.
  //
  const fallos = []
  for (const cuerpo of deHuerfano) {
    const r = await post(cuerpo)
    if (r.status === 201) continue
    if (r.status < 400) fallos.push(`«${JSON.stringify(cuerpo)}» → ${r.status}`)
  }
  assert.deepEqual(fallos, [], 'ninguna variante vuelve con un código de éxito raro')

  const suma = await one(
    `SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n
       FROM payments WHERE sales_order_id = $1`, [pedido])
  // Todas las que se aceptaron tienen que haber cobrado lo que el pedido debía
  // —una sola vez— y NUNCA las 500 000 que venían en el cuerpo.
  assert.equal(Number(suma.s), total, `solo se registró el importe del pedido, no el del cliente (${suma.s})`)
  assert.ok(Number(suma.n) <= 1, `y como mucho un cobro, no uno por cada variante (${suma.n})`)
})

test('LO NORMAL · sin importe, se cobra lo que el pedido debe', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-3', 'XOF', 121)
  const r = await post({ pedidoId: pedido, metodo: 'CASH' })

  assert.equal(r.status, 201, `por qué no: ${JSON.stringify(r.body)}`)
  const p = await one('SELECT amount, currency_code, collected_by FROM payments WHERE id = $1',
    [r.body.cobro.id])
  assert.equal(Number(p.amount), total, 'exactamente lo que debía el pedido')
  assert.equal(p.currency_code, 'XOF', 'la moneda del pedido, no otra')
  assert.equal(p.collected_by, repartidor, 'cobró quien estaba en la puerta')
  assert.equal(r.body.pendiente_tras_cobro, 0)
})

test('LO NORMAL · un pedido pagado NO admite otro cobro', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-4', 'XOF', 121)
  const ok = await post({ pedidoId: pedido, metodo: 'CASH' })
  assert.equal(ok.status, 201)

  // El segundo. Con el MISMO método para que lo que lo para no sea el UNIQUE
  // de (pedido, método), que es otra cosa y se prueba en cobros-caja.
  const otra = await post({ pedidoId: pedido, metodo: 'MOBILE_MONEY', referencia: 'X' })
  assert.equal(otra.status, 409, '409, no 400: no es una petición mala, es un pedido saldado')
  assert.equal(otra.body.codigo, 'PEDIDO_YA_PAGADO')

  const n = await one('SELECT COUNT(*) AS n FROM payments WHERE sales_order_id = $1', [pedido])
  assert.equal(Number(n.n), 1, 'sigue habiendo UN solo cobro')
})

test('LA FUENTE ÚNICA · el importe sale de la función, no de la pantalla', async () => {
  //
  // La tarjeta enseña una cifra y el cobro registra otra. Si algún día dejan de
  // ser el mismo número, el repartidor cobra lo que le han enseñado y el sistema
  // guarda otra cosa. Aquí se comprueba que salen del MISMO sitio.
  //
  const { id: pedido, total } = await pedidoEntregable('PED-5', 'XOF', 802.1916)

  //
  // Y A MEDIAS. Con el pedido entero, la tarjeta y el cobro dicen lo mismo
  // porque las dos cuentas coinciden: total y pendiente son el mismo número
  // cuando no se ha cobrado nada. Esa es la versión de la prueba que pasaba
  // verde con la tarjeta mintiendo, porque aún no había nada que mintiera.
  //
  // Un pedido pagado a medias es donde las dos cuentas se separan, y es
  // exactamente el caso de la calle: el cliente deja una seña y vuelve.
  //
  //
  // La seña va por BANCO, no por efectivo, y con su comprobante.
  //
  // No es un detalle: «un pago por entrega y método» es una restricción de la
  // base, y este mismo endpoint no podría registrar un segundo efectivo en este
  // pedido. La seña de una prueba tiene que entrar por la puerta que le toca,
  // como entraría en la calle.
  //
  await query(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount, currency_code, reference, created_by)
     VALUES ($1,$2,$3,'BANK_TRANSFER',$4,'XOF','SEÑA-PRUEBA',$3)`,
    [pedido, cli, repartidor, 3000])

  const cuerpo = (await request(app).get(`/api/qr/${token}`)
    .set('authorization', `Bearer ${tokRepartidor}`)).body
  const enLaTarjeta = cuerpo.pedidos_pendientes.find((x) => x.order_code === 'PED-5')
  assert.ok(enLaTarjeta, 'el pedido sale en la tarjeta')
  assert.equal(Number(enLaTarjeta.importe_pedido), total, 'el total del pedido')
  assert.notEqual(Number(enLaTarjeta.pendiente_de_cobro), total,
    'pero lo que falta NO es el total: ya se ha dejado una seña')

  const enLaBase = await one('SELECT fn_pendiente_cobro($1::bigint) AS p', [pedido])
  // PGlite devuelve los NUMERIC como CADENA, para no perder un decimal al pasar por el WASM.
  assert.equal(Number(enLaTarjeta.pendiente_de_cobro), Number(enLaBase.p),
    `la tarjeta y la base dicen EXACTAMENTE lo mismo (tarjeta ${enLaTarjeta.pendiente_de_cobro}, base ${enLaBase.p})`)
  //
  // Se compara con 4 decimales, que es donde vive. En coma flotante
  // 9706.5184 - 3000 da 6706.518400000001, y esa diferencia no es un error del
  // sistema: es la cuenta de este lado. Un importe se mira con la misma
  // precisión con la que está guardado, no con diecisiete decimales inventados.
  //
  assert.equal(Number(enLaBase.p), Number((total - 3000).toFixed(4)),
    'que es el total menos la seña')

  // Y ahora en efectivo, que es un método que este pedido no ha usado.
  const r = await post({ pedidoId: pedido, metodo: 'CASH' })
  assert.equal(r.status, 201, `por qué no: ${JSON.stringify(r.body)}`)
  assert.equal(Number(r.body.cobro.amount), Number(enLaTarjeta.pendiente_de_cobro),
    'y el cobro registrado es ese mismo número')
})

test('LA MONEDA · el pedido en euros se cobra en euros, sin convertir', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-EUR', 'EUR', 121)
  // Y ahora en efectivo, que es un método que este pedido no ha usado.
  const r = await post({ pedidoId: pedido, metodo: 'CASH' })
  assert.equal(r.status, 201, `por qué no: ${JSON.stringify(r.body)}`)
  assert.equal(r.body.cobro.currency_code, 'EUR')
  assert.equal(Number(r.body.cobro.amount), total, 'lo que debía, en la moneda del pedido')
})

test('EL MÓVIL · sin comprobante no hay cobro', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-OM', 'XOF', 121)
  const r = await post({ pedidoId: pedido, metodo: 'ORANGE_MONEY' })
  assert.ok(r.status >= 400, 'Orange Money sin comprobante no se registra')
  const n = await one('SELECT COUNT(*) AS n FROM payments WHERE sales_order_id = $1', [pedido])
  assert.equal(Number(n.n), 0, 'no queda un cobro a medias')
})

test('PERMISOS · sin permiso de entregas, no se cobra', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-SIN-PERM', 'XOF', 121)
  const r = await post({ pedidoId: pedido, metodo: 'CASH' }, tokCajero)
  assert.ok(r.status === 403 || r.status === 401,
    `sin permiso: 403, no 201. Llegó a ser ${r.status}`)
  const n = await one('SELECT COUNT(*) AS n FROM payments WHERE sales_order_id = $1', [pedido])
  assert.equal(Number(n.n), 0, 'y no se registró nada')
})

test('SIN SESIÓN · sin token no se cobra', async () => {
  const { id: pedido, total } = await pedidoEntregable('PED-ANON', 'XOF', 121)
  const r = await request(app).post('/api/payments')
    .send({ pedidoId: pedido, metodo: 'CASH' })
  assert.equal(r.status, 401)
  const n = await one('SELECT COUNT(*) AS n FROM payments WHERE sales_order_id = $1', [pedido])
  assert.equal(Number(n.n), 0)
})

// ───────────────────────────────────────────────────────────────────────────

test.after(async () => { await closeDb() })
