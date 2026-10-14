/**
 * TARJETA, ESCÁNER Y REPARTO
 *
 * La cadena entera: tarjeta → QR → escaneo → pedido → reparto → entrega → stock
 * → historial.
 *
 * Lo que se comprueba, y POR QUÉ importa cada cosa:
 *
 *   · El QR no lleva NADA de la dirección. Si llevara una URL, el día que se
 *     cambie de servidor todas las tarjetas repartidas dejarían de servir.
 *   · El QR no lleva datos personales. Ni nombre, ni teléfono, ni dirección.
 *   · La tarjeta generada y la tarjeta leída por el mismo motor cuadran: el QR
 *     que se imprime es el que el escáner resuelve.
 *   · Rotar el QR invalida la tarjeta vieja EN EL MISMO INSTANTE.
 *   · Salir a repartir NO toca el stock. Es la confusion mas cara del reparto.
 *   · La entrega la cierra el albarán firmado, no el botón de «entregado».
 *   · Una entrega sale una sola vez en la hoja de ruta del repartidor.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import jsQR from 'jsqr'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-tarjeta-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const P = await import('../src/core/produccion.js')
const C = await import('../src/core/clientes.js')
const Ped = await import('../src/core/pedidos.js')
const E = await import('../src/core/entregas.js')
const A = await import('../src/core/albaranes.js')
const T = await import('../src/core/tarjeta.js')
const R = await import('../src/core/reparto.js')
const cfg = await import('../src/core/config.js')

let e
let cliente

test.before(async () => {
  await baseDePrueba()
  repartidor = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('repartidor-tar','Repartidor Tarjeta','x', now()) RETURNING id`)).id
  e = await escenario()
  cliente = await C.crearCliente({
    name: 'Cliente de la tarjeta', phone: '+223 70 11 22 33',
    address: 'Av. de la Liberté 1, Bamako', email: 'cliente@ejemplo.ml',
  }, null)
})
test.after(async () => { await closeDb() })

const db = { one, query }


// El repartidor. La entrega la confirma una PERSONA: la firma en papel no
// entra en el sistema, así que lo que queda escrito es quién la confirmó.
let repartidor = null

async function escenario() {
  return transaction(async (tx) => {
    const u = await tx.one('SELECT id FROM units ORDER BY id LIMIT 1')
    const cat = await tx.one(
      `INSERT INTO item_categories (code, name, category_kind)
       VALUES ('TAR-F6','Tarjetas','FINISHED_GOOD') RETURNING id`)
    const pt = await tx.one(
      `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price,tax_rate,format_label)
       VALUES ('PT-TAR-1','Producto tarjeta','FINISHED_GOOD',$1,$2,'TAR',1000,0.21,'1 L') RETURNING id`,
      [cat.id, u.id])
    const mp = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
       VALUES ('MP-TAR-1','Materia tarjeta','RAW_MATERIAL',$1,1) RETURNING id`, [u.id])
    const receta = await tx.one(
      `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
       VALUES ('REC-TAR-1','Receta tarjeta',$1,100,$2) RETURNING id`, [pt.id, u.id])
    await tx.query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, mp.id, u.id])
    await tx.one(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ('MP-TAR-0001',$1,'RAW_MATERIAL','ACTIVE',9000,9000,$2,'OPENING') RETURNING id`,
      [mp.id, u.id])
    return { u, pt, mp, receta }
  })
}

const saldoPT = async () => Number((await one(
  `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id = $1`, [e.pt.id])).s)

/** Un PNG tal y como lo devuelve `qrcode`, para leerlo. */
function leerPng(buffer) {
  let off = 8, w = 0, h = 0
  const trozos = []
  while (off < buffer.length) {
    const len = buffer.readUInt32BE(off)
    const tipo = buffer.toString('ascii', off + 4, off + 8)
    const data = buffer.subarray(off + 8, off + 8 + len)
    if (tipo === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4) }
    if (tipo === 'IDAT') trozos.push(data)
    off += 12 + len
  }
  const crudo = zlib.inflateSync(Buffer.concat(trozos))
  const bpp = 4, paso = w * bpp
  const px = new Uint8ClampedArray(w * h * 4)
  const prev = new Uint8Array(paso)
  const cur = new Uint8Array(paso)
  for (let y = 0; y < h; y++) {
    const filtro = crudo[y * (paso + 1)]
    cur.set(crudo.subarray(y * (paso + 1) + 1, y * (paso + 1) + 1 + paso))
    for (let i = 0; i < paso; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      if (filtro === 1) cur[i] = (cur[i] + a) & 0xff
      else if (filtro === 2) cur[i] = (cur[i] + b) & 0xff
      else if (filtro === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff
      else if (filtro === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    px.set(cur, y * paso)
    prev.set(cur)
  }
  return jsQR(px, w, h)
}

async function pedidoConfirmado(cantidad = 200) {
  const p = await Ped.crearPedido({
    customerId: cliente.id, userId: repartidor,
    lineas: [{ itemId: e.pt.id, qty: cantidad, unitPrice: 1000 }],
  })
  await Ped.confirmarPedido(p.id, null)
  return p
}

function firmaPng() {
  const W = 120, H = 40
  const filas = []
  for (let y = 0; y < H; y++) filas.push('0', ...Array(W).fill('255,255,255'))
  return Buffer.from(filas.join(''), 'binary')
}

// ═══════════════════════════════════════════════════════════════════════════
test('1 · El QR no lleva la dirección, ni los datos personales', async () => {
  const token = cliente.qr_token
  const contenido = T.contenidoQr(token)

  assert.ok(contenido.startsWith('CS-'), 'el código de la tarjeta debería empezar por CS-')
  assert.equal(contenido, `CS-${token}`)
  for (const prohibido of ['http', 'https', '//', 'localhost', 'trycloudflare', 'api/']) {
    assert.ok(!contenido.includes(prohibido),
      `el QR lleva «${prohibido}»: si el servidor cambia de dominio, la tarjeta deja de servir`)
  }
  for (const pii of [cliente.name, cliente.phone, cliente.email, cliente.address].filter(Boolean)) {
    assert.ok(!contenido.includes(pii), `el QR contiene un dato personal: «${pii}»`)
  }
  // Y el tamaño del token: 192 bits en base64url son 32 caracteres.
  assert.equal(token.length, 32, `token de ${token.length} caracteres, se esperaban 32`)
})

test('2 · El QR impreso es exactamente el que el escáner resuelve', async () => {
  // Generador y lector, comprobados EL UNO CONTRA EL OTRO. Si estos no
  // cuadran, la tarjeta sirve en el despacho y falla en la calle.
  const png = await T.imagenQr(cliente.qr_token, { tamano: 320 })
  assert.ok(Buffer.isBuffer(png) && png.length > 100)
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'no es un PNG')

  const leido = leerPng(png)
  assert.ok(leido, 'el QR impreso no se puede leer: el escáner fallaría en la puerta')
  assert.equal(leido.data, T.contenidoQr(cliente.qr_token),
    'el QR impreso no lleva el token del cliente')

  // Y el motor de la API lo resuelve con ese contenido.
  const resuelto = await C.resolverQr(leido.data)
  assert.equal(resuelto.valido, true)
  assert.equal(resuelto.code, cliente.code)
})

test('3 · La tarjeta lleva los datos de la empresa desde app_config', async () => {
  const empresa = await cfg.empresa(db)
  const t = T.datosTarjeta({ cliente: { ...cliente }, empresa })
  assert.equal(t.codigo, cliente.code)
  assert.equal(t.nombre, cliente.name)
  assert.equal(t.empresa.nombre, 'SAHEL')
  assert.equal(t.empresa.simbolo ?? 'FCFA', 'FCFA')       // el símbolo, si viene
  assert.equal(empresa.simbolo, 'FCFA')
  assert.equal(empresa.moneda, 'XOF', 'la moneda interna debe ser el código ISO')
})

test('4 · Rotar el QR invalida la tarjeta vieja EN EL MISMO INSTANTE', async () => {
  const antes = cliente.qr_token
  const viejo = T.contenidoQr(antes)

  const r = await C.regenerarTokenQr(cliente.id, null)
  const nuevo = r.qr_token

  assert.notEqual(nuevo, antes, 'rotar el QR devolvió el mismo token')

  // La tarjeta vieja, la que está plastificada en la cartera de alguien, tiene
  // que dejar de servir AHORA. No mañana, no «cuando se sincronice».
  await assert.rejects(
    () => C.resolverQr(viejo),
    /no es válida|revocad/i,
    'una tarjeta rotada sigue funcionando: perder la tarjeta no sirve de nada')

  const ahora = await C.resolverQr(T.contenidoQr(nuevo))
  assert.equal(ahora.valido, true, 'la tarjeta nueva no sirve')
  assert.equal(ahora.code, cliente.code)
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · Un QR inventado no abre nada', async () => {
  await assert.rejects(() => C.resolverQr('CS-estaNoExisteEnAbsolute'), /no es válida|revocad/i)
  await assert.rejects(() => C.resolverQr(''), /Falta el código/i)
})

// ═══════════════════════════════════════════════════════════════════════════
test('6 · La ruta del repartidor la llevan los PEDIDOS, no los albaranes', async () => {
  //
  // ESTA PRUEBA CAMBIÓ DE SENTIDO, y hay que decirlo.
  //
  // Antes afirmaba lo contrario: «la ruta del repartidor son los ALBARANES, no
  // las entregas», y comprobaba que un albarán sin imprimir NO salía en la ruta.
  //
  // Eso convertía el papel en la llave de la operación: si el almacén no gastaba
  // tinta, el repartidor no veía ni una parada del día, y para poder repartir
  // había que imprimir antes. El albarán es el papel que firma el cliente; no es
  // el parte de trabajo.
  //
  // Ahora lo que lleva la ruta es el PEDIDO, esté o no impreso, y el albarán se
  // pega a la fila como lo que es: el papel de ese viaje, si es que lo hay.
  //
  await P.producir({ recipeId: e.receta.id, cantidad: 1000, usuarioId: null, produccionId: null })
  const p = await pedidoConfirmado(200)
  await Ped.prepararPedido(p.id, repartidor)

  // SIN albarán: la parada sale igual, que es lo que tiene que pasar.
  const sinPapel = await R.listarReparto({}, db)
  const fila = sinPapel.find((f) => f.pedido_id === p.id)
  assert.ok(fila,
    'un pedido preparado NO sale en la ruta aunque no tenga albarán: para repartir no hay que imprimir')
  assert.equal(fila.albaran_id, null, 'no se inventa un albarán para que la parada exista')
  assert.ok(Number(fila.unidades_pendientes) > 0, 'y la parada dice cuánto falta servir')

  // Y la fila de `deliveries` sigue sin existir: imprimir no crea entregas.
  const entregas = await one(`SELECT COUNT(*) n FROM deliveries WHERE sales_order_id = $1`, [p.id])
  assert.equal(Number(entregas.n), 0,
    'se creó la entrega sin repartir: la mercancía habría salido sin que nadie la recibiera')

  // Y un RESERVED, que aún no está preparado, NO va en el camión.
  const reserva = await Ped.crearPedido({
    customerId: cliente.id, userId: repartidor,
    lineas: [{ itemId: e.pt.id, qty: 20, unitPrice: 1000 }],
  })
  await Ped.confirmarPedido(reserva.id, repartidor)
  const trasReservar = await R.listarReparto({}, db)
  assert.equal(trasReservar.some((f) => f.pedido_id === reserva.id), false,
    'un pedido solo reservado no va en el camión: la caja no está cerrada')

  // Con albarán, la parada lo lleva encima como referencia.
  const alb = await A.crearAlbaran(db, { salesOrderId: p.id, userId: repartidor })
  await A.imprimirAlbaran(db, { albaranId: alb.id, userId: repartidor })
  const conPapel = await R.listarReparto({}, db)
  const f2 = conPapel.find((f) => f.pedido_id === p.id)
  assert.equal(f2.albaran_id, alb.id, 'la parada lleva su albarán cuando lo hay')
  assert.equal(f2.albaran_status, 'PRINTED')

  await Ped.anularPedido(reserva.id, 'Prueba: no va en el camión', repartidor)
  globalThis.ruta = { p, alb }
})


test('7 · Imprimir y firmar NO mueven el stock; entregar sí', async () => {
  const { p, alb } = globalThis.ruta
  const stockInicial = await saldoPT()

  await A.firmarAlbaran(db, {
    albaranId: alb.id, signerName: 'Cliente de la calle', image: firmaPng(), userId: repartidor,
  })

  assert.equal(await saldoPT(), stockInicial,
    'FIRMAR el albarán bajó el stock: la mercancía sale al firmarlo, pero hasta que el cliente no lo ha recibido y el pedido no se ha cerrado, sigue siendo de la fábrica')

  // La entrega la confirma la TARJETA. El albarán solo estaba mirando.
  const r = await E.confirmarDesdeTarjeta({ orderId: p.id, clienteId: null, userId: repartidor })
  assert.equal(r.pedido_estado, 'DELIVERED')
  assert.equal(r.confirmed_via, 'TARJETA_QR')
  const servido = stockInicial - await saldoPT()
  assert.equal(servido, 200, `se sirvieron ${servido} unidades de las 200 del pedido`)

  // Y la entrega nace AQUÍ, con repartidor, que es cuando se puede saber quién
  // lo dejó. Es la pregunta que se hace cuando un cliente dice que no recibió.
  const ent = await one(
    `SELECT rep_id, status, confirmed_by, confirmed_via FROM deliveries WHERE id = $1`, [r.id])
  assert.equal(ent.status, 'DELIVERED')
  assert.equal(ent.confirmed_by, repartidor)
  assert.equal(ent.confirmed_via, 'TARJETA_QR')
})

test('8 · Una parada sale UNA SOLA VEZ, aunque el pedido tenga varias entregas', async () => {
  // El riesgo real ya no es el albarán (uno por fila), sino el `LEFT JOIN` a
  // `deliveries`: un pedido entregado en dos tandas tiene DOS filas de entrega,
  // y un JOIN normal multiplica la fila de la parada. El repartidor vería la
  // misma parada dos veces e iría dos veces a la misma puerta.
  //
  // El escenario: primera visita (albarán cerrado, pedido a medias), segunda
  // visita con su albarán impreso, y el pedido con DOS entregas ya cerradas.
  await P.producir({ recipeId: e.receta.id, cantidad: 500, usuarioId: null, produccionId: null })
  const c3 = await C.crearCliente({ name: 'Cliente de la ruta' }, null)
  const ped = await Ped.crearPedido({
    customerId: c3.id, userId: repartidor, lineas: [{ itemId: e.pt.id, qty: 60, unitPrice: 1000 }],
  })
  await Ped.confirmarPedido(ped.id, null)
  await Ped.prepararPedido(ped.id, null)

  // Primera visita: entrega parcial de 20 de 60.
  const lineaPedido = (await Ped.obtenerPedido(ped.id)).lineas[0].id
  const primera = await A.crearAlbaran(db, {
    salesOrderId: ped.id, userId: repartidor, lineas: [{ orderLineId: lineaPedido, qty: 20 }],
  })
  await A.imprimirAlbaran(db, { albaranId: primera.id, userId: repartidor })
  await A.firmarAlbaran(db, {
    albaranId: primera.id, signerName: 'Primera visita', image: firmaPng(), userId: repartidor })
  await E.confirmarDesdeTarjeta({ orderId: ped.id, clienteId: c3.id, userId: repartidor, lineas: [{ orderLineId: lineaPedido, qty: 20 }] })

  // Segunda visita: albarán nuevo, impreso y esperando en la calle.
  const segunda = await A.crearAlbaran(db, {
    salesOrderId: ped.id, userId: repartidor, lineas: [{ orderLineId: lineaPedido, qty: 40 }],
  })
  await A.imprimirAlbaran(db, { albaranId: segunda.id, userId: repartidor })

  // Se fuerza el fan-out: una tercera entrega ya cerrada para el mismo pedido.
  const dup = await query(
    `INSERT INTO deliveries (code, sales_order_id, status, delivered_at)
     VALUES ($1, $2, 'DELIVERED', now()) RETURNING id`,
    [`ENT-DUP-${Date.now()}`, ped.id])
  assert.equal(dup.length, 1, 'no se pudo crear la entrega repetida')
  const nEntregas = await one(
    `SELECT COUNT(*) n FROM deliveries WHERE sales_order_id = $1 AND status = 'DELIVERED'`,
    [ped.id])
  assert.ok(Number(nEntregas.n) >= 2, 'el caso de prueba no se ha montado')

  const ruta = await R.listarReparto({}, db)
  const ids = ruta.map((f) => f.albaran_id)
  assert.equal(new Set(ids).size, ids.length,
    `la misma parada sale repetida en la ruta: ${ids.join(', ')}`)
  assert.ok(ruta.some((f) => f.albaran_id === segunda.id),
    'la segunda visita no sale en la ruta del repartidor')

  for (const f of ruta) {
    assert.ok(f.pedido_id, 'una parada sin pedido: el repartidor no sabe qué lleva')
    assert.ok(f.cliente_name, 'una parada sin cliente: no hay puerta a la que ir')
  }
  globalThis.segundaVisita = segunda
})

test('9 · Al cerrar, la parada desaparece de la ruta y queda en el histórico', async () => {
  await P.producir({ recipeId: e.receta.id, cantidad: 500, usuarioId: null, produccionId: null })
  const p2 = await pedidoConfirmado(80)
  await Ped.prepararPedido(p2.id, repartidor)
  const alb2 = await A.crearAlbaran(db, { salesOrderId: p2.id, userId: repartidor })
  await A.imprimirAlbaran(db, { albaranId: alb2.id, userId: repartidor })

  assert.ok((await R.listarReparto({}, db)).some((f) => f.pedido_id === p2.id),
    'un pedido preparado no está en la ruta del repartidor')

  // El cliente firma EN PAPEL. Aquí se anota por cortesía, y da igual: ni esto
  // ni lo de antes tocan el estado del pedido.
  await A.firmarAlbaran(db, {
    albaranId: alb2.id, signerName: 'Cliente', image: firmaPng(), userId: repartidor,
  })
  assert.equal((await one(`SELECT status FROM sales_orders WHERE id=$1`, [p2.id])).status,
    'PREPARED', 'firmar el papel cambió el estado del pedido')

  // La entrega la confirma la TARJETA. Y solo ella.
  await E.confirmarDesdeTarjeta({ orderId: p2.id, clienteId: null, userId: repartidor })

  const tras = await R.listarReparto({}, db)
  assert.ok(!tras.some((f) => f.pedido_id === p2.id),
    'una entrega cerrada sigue en la hoja de ruta: el repartidor iría a una puerta donde ya no hay nada')

  // Pero no se ha borrado: sigue estando, y eso es lo que se puede consultar.
  const historico = await R.listarReparto({ soloPendientes: false }, db)
  const f = historico.find((x) => x.pedido_id === p2.id)
  assert.ok(f, 'el histórico no conserva la entrega: se desapareció en lugar de pasar a lo hecho')
  assert.equal(f.pedido_estado, 'DELIVERED')
  assert.ok(f.entrega_id, 'y se puede ver de qué entrega fue')
})

test('10 · «No pude entregar» NO cambia el estado ni mueve el stock', async () => {
  // La nota cuelga del PEDIDO. Antes colgaba del albarán, y eso significaba que
  // solo se podía anotar si además se había impreso, cuando lo que pasó en la
  // puerta no tiene nada que ver con si el almacén gastó tinta.
  await P.producir({ recipeId: e.receta.id, cantidad: 500, usuarioId: null, produccionId: null })
  const p3 = await pedidoConfirmado(60)
  await Ped.prepararPedido(p3.id, repartidor)
  const antes = await saldoPT()
  const estadoAntes = (await one(`SELECT status FROM sales_orders WHERE id=$1`, [p3.id])).status

  await assert.rejects(
    () => R.anotarNoEntregado(p3.id, { motivo: '', usuarioId: repartidor }, db),
    /por qué|motivo/i,
    'anotó un fallo sin decir por qué')

  // Y se puede anotar SIN albarán: esta parada no tiene papel.
  const f = await R.anotarNoEntregado(p3.id,
    { motivo: 'El local estaba cerrado', usuarioId: repartidor }, db)

  assert.equal(f.pedido_id, Number(p3.id))
  assert.equal(f.estado, estadoAntes,
    '«no pude entregar» cambió el estado: el cliente no estaba y su pedido se ha evaporado')
  assert.equal(f.albaran_anotado, null,
    'esta parada no llevaba albarán, y eso no impide anotar el motivo')
  assert.equal(await saldoPT(), antes, '«no pude entregar» movió el stock')

  // Y la parada sigue en la ruta, que es lo que hace falta: hay que volver.
  const fila = (await R.listarReparto({}, db)).find((x) => x.pedido_id === p3.id)
  assert.ok(fila, 'la parada salió de la ruta al no poder entregar: se pierde para siempre')
  assert.equal(Number(fila.intentos_fallidos), 1, 'pero avisa de que ya se llamó')
  assert.equal(fila.ultimo_motivo, 'El local estaba cerrado')

  // Y el motivo queda escrito donde se consulta.
  const notas = await R.intentosDeReparto(p3.id, db)
  assert.equal(notas.length, 1)
  assert.equal(notas[0].motivo, 'El local estaba cerrado')

  // Con albarán, también se anota en el papel, que vuelve sin firmar.
  const alb3 = await A.crearAlbaran(db, { salesOrderId: p3.id, userId: repartidor })
  await A.imprimirAlbaran(db, { albaranId: alb3.id, userId: repartidor })
  const f2 = await R.anotarNoEntregado(p3.id,
    { motivo: 'Segunda vez, seguía cerrado', usuarioId: repartidor }, db)
  assert.equal(f2.albaran_anotado, alb3.id, 'no se anotó en el albarán de esa visita')
  const det = await A.detalleAlbaran(db, alb3.id)
  assert.ok(det.eventos.some((e) => e.event === 'NOT_DELIVERED'),
    'no quedó anotado en el papel por qué no se pudo entregar')

  globalThis.noEntregado = p3
})

test('11 · Un albarán ya entregado no se puede marcar como no entregado', async () => {
  // El de la prueba 7, que sí está entregado.
  const entregado = await one(
    `SELECT id FROM albaranes WHERE status = 'DELIVERED' ORDER BY id LIMIT 1`)
  assert.ok(entregado, 'no hay ningún albarán entregado con el que probar')
  await assert.rejects(
    () => R.anotarNoEntregado(entregado.id, { motivo: 'El cliente no estaba', usuarioId: null }, db),
    /ya está entregado/i,
    'se marcó como no entregado un albarán que ya se entregó: dos verdades distintas a la vez')
})

test('12 · El resumen de reparto cuadra con la lista', async () => {
  const ruta = await R.listarReparto({}, db)
  const resumen = await R.resumenReparto({}, db)

  // El resumen cuenta PEDIDOS, no estados de albarán. Antes contaba albaranes
  // IMPRESOS y albaranes FIRMADOS, que son cosas del PAPEL: una parada sin
  // albarán no cabía en ninguna casilla y desaparecía del resumen aunque
  // estuviera en la lista de al lado.
  assert.equal(resumen.total, ruta.length)
  assert.equal(resumen.en_camion, ruta.filter((f) => f.pedido_estado === 'PREPARED').length)
  assert.equal(resumen.por_cerrar, ruta.filter((f) => f.pedido_estado === 'IN_ROUTE').length)
  assert.equal(resumen.entregadas, ruta.filter((f) => f.pedido_estado === 'DELIVERED').length)

  // Y cada parada cae en una casilla, sin perderse por el camino.
  assert.equal(
    resumen.en_camion + resumen.por_cerrar + resumen.entregadas,
    resumen.total,
    'las paradas se pierden entre los estados: hay pedidos sin sitio en el resumen')

  // «Con albarán» es un dato, no una puerta: las paradas sin papel también
  // cuentan, y por eso van aparte.
  assert.equal(resumen.con_albaran, ruta.filter((f) => f.albaran_id).length)
  assert.ok(resumen.con_albaran <= resumen.total)
  assert.ok(resumen.intentos_fallidos <= resumen.total)
  assert.ok(resumen.clientes <= resumen.total)
})
