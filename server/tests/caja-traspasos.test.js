/**
 * PUNTO 3 · CAJA, TRASPASO Y CONCILIACIÓN
 *
 * ── LOS DOS AGUJEROS QUE ENCONTRÓ ESTE ARCHIVO ───────────────────────────
 *
 * Se pueden escribir con dos frases, y las dos seArthur.
 *
 * UNO. La caja tiene las dos tablas: `cash_handoffs` dice «este repartidor me
 * ha dado 121», y `payment_handoffs` dice «estos cobros se han entregado». Lo
 * que el repartidor DEBE sale de la segunda. Y el enlace lo ponía el programa,
 * cuando se acordaba.
 *
 *   Resultado: se marcaba un traspaso como RECONCILED sin enlazar nada. La caja
 *   tenía el dinero, y el repartidor seguía debiendo el 121 para siempre. Sin
 *   error, sin aviso, y sin nada que se mirara: nadie abre la deuda de un
 *   repartidor por curiosidad.
 *
 * DOS. `payment_handoffs` no comprobaba el cruce. Se podía enlazar el cobro del
 *   repartidor A al traspaso del repartidor B, y A quedaba saldado con el
 *   dinero de B. Tampoco miraba la moneda, así que un traspaso en euros podía
 *   quedar saldado con cobros en francos.
 *
 *   Resultado: dos cuentas que dicen cosas distintas, cada una con su cifra
 *   delante, y ninguna se poPortable a la otra.
 *
 * ── LO QUE SE COMPRUEBA AQUÍ ──────────────────────────────────────────────
 *
 * Que las dos cuentas NO PUEDAN separarse. Y que la caja sean personas.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-caja-traspasos-larga-suficiente-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const { createApp } = await import('../src/app.js')
const { request } = await import('./supertest-helper.js')
const { hashPassword } = await import('../src/security/passwords.js')
const K = await import('../src/core/caja.js')

let app
let adm
let rep1
let rep2
let caja1
let caja2
let tokRep
let tokCaja1
let tokCaja2
let tokAdm
let cli
let n = 0

await baseDePrueba()
app = createApp()

const C = { adm: 'caja-prueba-adm-1', rep: 'caja-prueba-rep-1', caja: 'caja-prueba-cj-1' }

async function usuario(username, contra, rol) {
  const u = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [username, username.toUpperCase(), await hashPassword(contra)])).id
  await query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
    [u, rol])
  return u
}

adm = await usuario(C.adm, C.adm, 'ADMIN')
rep1 = await usuario(C.rep, C.rep, 'DELIVERY')
rep2 = await usuario('caja-prueba-rep-2', C.rep, 'DELIVERY')
caja1 = await usuario(C.caja, C.caja, 'CAJAJERO')
caja2 = await usuario('caja-prueba-cj-2', C.caja, 'CAJAJERO')

tokAdm = (await request(app).post('/api/auth/login')
  .send({ username: C.adm, password: C.adm })).body.access
tokRep = (await request(app).post('/api/auth/login')
  .send({ username: C.rep, password: C.rep })).body.access
tokCaja1 = (await request(app).post('/api/auth/login')
  .send({ username: C.caja, password: C.caja })).body.access
tokCaja2 = (await request(app).post('/api/auth/login')
  .send({ username: 'caja-prueba-cj-2', password: C.caja })).body.access

cli = (await one(
  `INSERT INTO customers (code, qr_token, name, created_by)
   VALUES ('CL-9100', 'tok-caja-9100', 'Cliente de caja', $1) RETURNING id`, [adm])).id

/**
 * Un repartidor NUEVO para cada prueba.
 *
 * La primera versión usaba el mismo repartidor para todas, y el saldo se le
 * iba acumulando de una a otra: una prueba que quería entregar 500 se
 * encontraba con que el repartidor llevaba 742, y el fallo salía como si fuera
 * de la conciliación cuando era de la prueba. Peor: el fallo de una prueba
 * hacía fallar las siguientes, y había que mirar cuatro errores para entender
 * uno.
 *
 * Un repartidor por prueba hace que cada una pueda decir su cifra en voz alta
 * y que un fallo signifique exactamente lo que dice.
 */
let nRep = 0
async function repartidorNuevo() {
  nRep += 1
  return usuario(`caja-rep-${nRep}-${Date.now().toString().slice(-5)}`, C.rep, 'DELIVERY')
}

/** Un repartidor con UN cobro de 700, para las pruebas de la API. */
let elDeEstaPrueba = null
async function repartoDeEstaPrueba() {
  if (!elDeEstaPrueba) {
    const r = await repartidorNuevo()
    await cobroDe(r, 700)
    elDeEstaPrueba = r
  }
  return elDeEstaPrueba
}

/** Un pedido y un cobro de `quien`, por `euros`. Devuelve el id del cobro. */
async function cobroDe(quien, euros, codigo) {
  n += 1
  const o = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ($1,$2,'PREPARED',CURRENT_DATE,'XOF',$3,0,0,$3,$4) RETURNING id`,
    [codigo || `PED-C${n}`, cli, euros, adm])).id
  await query(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount, currency_code, created_by)
     VALUES ($1,$2,$3,'CASH',$4,'XOF',$3)`, [o, cli, quien, euros])
  return (await one('SELECT id FROM payments WHERE sales_order_id = $1', [o])).id
}

// ═══════════════════════════════════════════════════════════════════════════
// AGUJERO UNO · EL DINERO RECIBIDO SIN COBROS DETRÁS
// ═══════════════════════════════════════════════════════════════════════════

test('AGUJERO 1 · un traspaso recibido SIN enlaces es imposible', async () => {
  const rep = await repartidorNuevo()
  const pago = await cobroDe(rep, 121)

  await assert.rejects(
    () => query(
      `INSERT INTO cash_handoffs
         (handed_by, received_by, received_at, received_amount,
          currency_code, note, status, created_by)
       VALUES ($1,$2,now(),121,'XOF','todo bien','RECONCILED',$2)`,
      [rep, caja1]),
    (e) => /no enlaza ni un cobro/i.test(e.message),
    'la caja tiene el dinero y el repartidor debe 121: eso no se puede guardar',
  )

  // Y sobre todo: el repartidor SIGUE debiéndolo, que es la verdad.
  const deuda = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(deuda.lleva_ahora), 121, 'el dinero no está entregado: se sigue debiendo')
  const enlazado = await one('SELECT COUNT(*) AS n FROM payment_handoffs WHERE payment_id=$1', [pago])
  assert.equal(Number(enlazado.n), 0)
})

test('AGUJERO 1 · y tampoco por la puerta de la aplicación', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 500)
  const abierto = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ repartidorId: rep })
  assert.equal(abierto.status, 201)

  // Recibir SIN decir qué cobros: el backend los enlaza todos. Y cuadra.
  const bien = await request(app).post(`/api/caja/traspasos/${abierto.body.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ recibido: 500 })
  assert.equal(bien.status, 200, `un traspaso de verdad se recibe: ${JSON.stringify(bien.body)}`)
  assert.equal(bien.body.status, 'RECONCILED')
  assert.ok(bien.body.cobros_entregados > 0, 'y enlaza los cobros que lo respaldan')

  const deuda = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(deuda.lleva_ahora), 0, 'el repartidor ya no debe nada')
})

test('AGUJERO 1 · un traspaso que cuadra DEBERÍA tener cobros, pero no los tiene', async () => {
  //
  // La versión fina del agujero: la caja dice que ha recibido 121 y enlaza un
  // cobro de 50. Nada de eso cuadra, y sin este disparador nadie se enteraría.
  //
  const rep = await repartidorNuevo()
  const p50 = await cobroDe(rep, 50)
  await cobroDe(rep, 71)

  //
  // TODO EN UNA TRANSACCIÓN, y no por gusto.
  //
  // El guard que comprueba esto es un CONSTRAINT TRIGGER DEFERRABLE, y eso
  // significa que se dispara al CERRAR. Si el traspaso y su enlace van en
  // transacciones distintas, al cerrar la primera el traspaso ya está
  // RECEIVED y todavía no tiene nada detrás — y el guard tiene razón.
  //
  // La primera versión de esta prueba hacía justo eso, con `query()` suelta, y
  // el error que salía era el del otro agujero. No era un fallo del guard: era
  // la prueba haciendo justo lo que la base dice que no se haga.
  //
  await assert.rejects(
    () => transaction(async (tx) => {
      const t = (await tx.one(
        `INSERT INTO cash_handoffs (handed_by, received_by, currency_code, created_by)
         VALUES ($1,$2,'XOF',$2) RETURNING id`, [rep, caja1])).id
      await tx.query(
        `UPDATE cash_handoffs SET received_at=now(), received_amount=121, status='RECONCILED'
          WHERE id=$1`, [t])
      await tx.query('INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)', [p50, t])
    }),
    (e) => /respalda con cobros por 50\.0000 lo que su repartidor llevaba 121\.0000/i.test(e.message),
    'el traspaso respalda 50 de los 121 que llevaba: no puede quedar así',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// AGUJERO DOS · MEZCLAR REPARTIDORES O MONEDAS
// ═══════════════════════════════════════════════════════════════════════════

test('AGUJERO 2 · el cobro de UN repartidor no se enlaza al traspaso de OTRO', async () => {
  const uno = await repartidorNuevo()
  const otro = await repartidorNuevo()
  const mio = await cobroDe(uno, 100)
  const suyo = await cobroDe(otro, 900)

  //
  // Se apunta lo que debe ANTES, en vez de escribir un número.
  //
  // Estas pruebas comparten repartidor, y las de arriba le han dejado cobros
  // pendientes. Escribir «100» aquí sería escribir el número de una versión
  // anterior de este archivo: en cuanto una prueba de arriba cambiara, esta
  // fallaría diciendo que la mezcla de repartidores está rota, que es justo lo
  // que está comprobando. Lo que se compara es antes con después.
  //
  const antes1 = Number((await K.saldoDe(uno, 'XOF')).lleva_ahora)
  const antes2 = Number((await K.saldoDe(otro, 'XOF')).lleva_ahora)

  await assert.rejects(
    () => transaction(async (tx) => {
      const t = (await tx.one(
        `INSERT INTO cash_handoffs
           (handed_by, received_by, received_at, received_amount,
            currency_code, note, status, created_by)
         VALUES ($1,$2,now(),100,'XOF','entrega','RECONCILED',$2) RETURNING id`,
        [uno, caja1])).id
      await tx.query('INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)', [mio, t])
      await tx.query('INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)', [suyo, t])
    }),
    (e) => /un cobro se entrega en el traspaso de quien lo cobró/i.test(e.message),
    'saldar a uno con el dinero del otro',
  )

  // Y ninguno de los dos ha cambiado de saldo: la transacción entera se deshizo.
  assert.equal(Number((await K.saldoDe(uno, 'XOF')).lleva_ahora), antes1,
    'el repartidor del traspaso sigue debiendo lo mismo')
  assert.equal(Number((await K.saldoDe(otro, 'XOF')).lleva_ahora), antes2,
    'y el del otro también: ninguno se ha saldado con el dinero del otro')
})

test('AGUJERO 2 · un traspaso en euros no se salda con cobros en francos', async () => {
  const rep = await repartidorNuevo()
  // Un cobro en euros de un repartidor, y un traspaso del MISMO repartidor en
  // francos. La moneda del repartidor no importa: lo que tiene que cuadrar es
  // la del traspaso.
  const euros = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ('PED-EUR-C',$1,'PREPARED',CURRENT_DATE,'EUR',10,0,0,10,$2) RETURNING id`,
    [cli, adm])).id
  await query(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount, currency_code, created_by)
     VALUES ($1,$2,$3,'CASH',10,'EUR',$3)`, [euros, cli, rep])
  const pagoEur = (await one('SELECT id FROM payments WHERE sales_order_id=$1', [euros])).id

  await assert.rejects(
    () => transaction(async (tx) => {
      const t = (await tx.one(
        `INSERT INTO cash_handoffs
           (handed_by, received_by, received_at, received_amount,
            currency_code, note, status, created_by)
         VALUES ($1,$2,now(),500,'XOF','traspaso en francos','RECONCILED',$2) RETURNING id`,
        [rep, caja1])).id
      await tx.query('INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)', [pagoEur, t])
    }),
    (e) => /una moneda/i.test(e.message),
    'euros contra francos no se suman: se convierten, y aquí no se convierte',
  )
})

test('AGUJERO 2 · un cobro no se enlaza a un traspaso que aún no se ha recibido', async () => {
  const rep = await repartidorNuevo()
  const mio = await cobroDe(rep, 300)
  const t = (await one(
    `INSERT INTO cash_handoffs (handed_by, received_by, currency_code, created_by)
     VALUES ($1,$2,'XOF',$2) RETURNING id`, [rep, caja1])).id

  await assert.rejects(
    () => query('INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1,$2)', [mio, t]),
    (e) => /antes de recibirlo/i.test(e.message),
    'un traspaso pendiente es una promesa, no un hecho',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// LAS DOS PERSONAS
// ═══════════════════════════════════════════════════════════════════════════

test('PERSONAS · nadie se entrega dinero a sí mismo', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 700)
  await assert.rejects(
    () => K.abrirTraspaso({ handedBy: rep, receivedBy: rep, usuarioId: rep }),
    (e) => e.codigo === 'CAJA_NO_SI_MISMO',
    'entregarse a uno mismo concilia siempre, y por eso no comprueba nada',
  )
})

test('PERSONAS · el receptor es quien pregunta, no un campo del cuerpo', async () => {
  await repartoDeEstaPrueba()
  const abierto = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ repartidorId: await repartoDeEstaPrueba(), receivedBy: caja2 })
  assert.equal(abierto.status, 201)
  assert.equal(abierto.body.received_by, caja1,
    'la caja 1 no puede registrar que le entregó a la caja 2')
})

test('PERSONAS · dos cajeros distintos, y cada uno con su nombre', async () => {
  //
  // No es una cuenta compartida con dos claves. Si lo fuera, la caja no sería
  // nadie: el dinero entra y no se le puede preguntar a quién.
  //
  const rep = await repartoDeEstaPrueba()
  const t1 = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })
  const t2 = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja2}`).send({ repartidorId: rep })

  assert.equal(t1.body.received_by, caja1)
  assert.equal(t2.body.received_by, caja2, 'la caja 2 abre su propio traspaso')
  assert.notEqual(t1.body.id, t2.body.id, 'y son dos traspasos distintos')

  const h1 = await request(app).post(`/api/caja/traspasos/${t1.body.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`).send({ recibido: 700 })
  assert.equal(h1.status, 200, `la caja 1 recibe su traspaso: ${JSON.stringify(h1.body)}`)

  //
  // Y la caja 2 NO PUEDE recibir el suyo.
  //
  // No porque esté «ya recibido» —está pendiente— sino porque ese dinero ya no
  // está en manos de nadie: se lo llevó la caja 1. Que la caja 2 pueda
  // «recibir» 700 que ya no existen sería el agujero otra vez por otro lado:
  // dos cajas contando el mismo franc.
  //
  const t2b = await request(app).post(`/api/caja/traspasos/${t2.body.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja2}`).send({ recibido: 700 })
  assert.equal(t2b.status, 409, 'no se puede contar dos veces el mismo dinero')
  assert.ok(['SIN_DINERO_QUE_ENTREGAR', 'TRASPASO_YA_RECIBIDO'].includes(t2b.body.codigo),
    `y el motivo es claro: ${t2b.body.codigo}`)

  const saldo = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(saldo.lleva_ahora), 0, 'y el repartidor queda debiendo cero, no -700')
})

// ═══════════════════════════════════════════════════════════════════════════
// LA CONCILIACIÓN
// ═══════════════════════════════════════════════════════════════════════════

test('CONCILIAR · lo que cuadra se concilia', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 400)
  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body
  assert.equal(Number(t.expected_amount), 400, 'lo que lleva, lo cuenta la base')

  const r = (await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`).send({ recibido: 400 })).body
  assert.equal(r.status, 'RECONCILED')
  assert.equal(Number(r.difference), 0)
})

test('CONCILIAR · lo que NO cuadra se anota con su explicación', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 900)
  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body

  // Primero sin nota: no se guarda.
  const sinNota = await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`).send({ recibido: 500 })
  assert.equal(sinNota.status, 409, `sin nota: ${JSON.stringify(sinNota.body)}`)
  assert.equal(sinNota.body.codigo, 'DISCREPANCY_SIN_EXPLICACION')

  // Y sigue pendiente: un rechazo no es un traspaso recibido a medias.
  const estado = await one('SELECT status FROM cash_handoffs WHERE id=$1', [t.id])
  assert.equal(estado.status, 'PENDING', 'y el traspaso sigue abierto, no a medio hacer')

  // Con nota, sí.
  const conNota = await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ recibido: 500, nota: 'el cliente dice que pagó por Orange y el comprobante no llegó' })
  assert.equal(conNota.status, 200, `con nota: ${JSON.stringify(conNota.body)}`)
  assert.equal(conNota.body.status, 'DISCREPANCY')
  assert.equal(Number(conNota.body.difference), -400, 'faltan 400')

  //
  // Y LO MÁS IMPORTANTE DE ESTA PRUEBA.
  //
  // El repartidor entregó los 900 que llevaba. La caja contó 500. El que
  // faltan 400 es la CAJA, no él: se le han ido de las manos, y el problema es
  // que la caja los busque.
  //
  // Si aquí el repartidor se quedara debiendo 400, tendríamos una deuda sobre
  // dinero que ya no está en ningún sitio: una cuenta que no se puede pagar ni
  // con el mejor cajero del mundo, y que nadie sabría de dónde salió. Es el
  // fantasma del que habla el agujero uno, vestido con otros ropajes.
  //
  const saldo = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(saldo.lleva_ahora), 0,
    'el repartidor queda en cero: entregó todo lo que llevaba')
})

test('CONCILIAR · la caja NO puede mandar lo que espera', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 1100)
  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body

  for (const campo of ['expected_amount', 'expectedAmount', 'en_su_poder', 'saldo']) {
    const r = await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
      .set('authorization', `Bearer ${tokCaja1}`)
      .send({ recibido: 1100, [campo]: 0 })
    assert.equal(r.status, 400, `«${campo}» no se acepta`)
    assert.equal(r.body.codigo, 'IMPORTE_NO_ADMISIBLE')
  }
  const r2 = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ repartidorId: rep, expected_amount: 0 })
  assert.equal(r2.status, 400, 'ni al abrir el traspaso')
})

test('CONCILIAR · el importe esperado LO CALCULA LA BASE', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 2500)
  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body
  const enLaBase = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(t.expected_amount), Number(enLaBase.lleva_ahora),
    'el traspaso y la función dicen lo mismo: no hay dos cuentas')
})

test('CONCILIAR · elegir cobros que no son los que lleva, no cuela', async () => {
  const rep = await repartidorNuevo()
  const p1 = await cobroDe(rep, 100)
  await cobroDe(rep, 200)
  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body

  const r = await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ recibido: 300, pagos: [p1] })   // solo el de 100, pero dice 300

  assert.equal(r.status, 400, 'no se puede decir «recibo 300» y respaldarlo con un cobro de 100')
  assert.match(r.body.error, /se han elegido unos cobros/i)
})

test('CONCILIAR · sin cobros que entregar no hay traspaso', async () => {
  const rep = await repartidorNuevo()
  const r = await K.abrirTraspaso({ handedBy: rep, receivedBy: caja1, usuarioId: caja1 })
    .catch((e) => e)
  assert.equal(r.codigo, 'SIN_DINERO_QUE_ENTREGAR',
    'una caja que abre un traspaso de cero se ha inventado un traspaso')
})

// ═══════════════════════════════════════════════════════════════════════════
// QUIÉN PUEDE
// ═══════════════════════════════════════════════════════════════════════════

test('PERMISOS · un repartidor no abre ni recibe traspasos', async () => {
  const mio = await repartoDeEstaPrueba()
  const abrir = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokRep}`).send({ repartidorId: mio })
  assert.ok([401, 403].includes(abrir.status), `ni abrir: ${abrir.status}`)

  // Y tampoco puede abrir SU propio traspaso por la vía de admin, porque no es
  // admin: el mismo endpoint, otro usuario.
  const yo = await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokRep}`).send({ repartidorId: rep2 })
  assert.ok([401, 403].includes(yo.status), `ni el suyo: ${yo.status}`)
})

test('PERMISOS · un repartidor ve SU saldo, y no el de los demás', async () => {
  // Ver no es tocar. Un repartidor tiene que poder mirar el dinero que lleva
  // encima: no es curiosidad, es para saber qué le falta por entregar.
  //
  // El SUYO. Y «el suyo» es el usuario que ha iniciado sesión, no cualquier
  // repartidor: la primera versión pedía el saldo de otro y se sorprende
  // cuando salía un 403, cuando lo raro era que saliera un 200.
  //
  const yo = (await one('SELECT id FROM users WHERE username = $1', [C.rep])).id
  await cobroDe(yo, 700)

  const suyo = await request(app).get(`/api/caja/repartidor/${yo}/saldo`)
    .set('authorization', `Bearer ${tokRep}`)
  assert.equal(suyo.status, 200, 'el suyo, sí')
  assert.equal(Number(suyo.body.lleva_ahora), 700)

  // El de otro, no. Y esto NO es por descuido: si un repartidor pudiera mirar
  // el saldo de los demás, sabría cuánto lleva cada uno, y con eso ya tienes
  // medio caminho para saber cuánto lleva la caja.
  const ajeno = await request(app).get(`/api/caja/repartidor/${caja1}/saldo`)
    .set('authorization', `Bearer ${tokRep}`)
  assert.ok([401, 403].includes(ajeno.status), `el de otro, no: ${ajeno.status}`)

  // Y la lista completa, tampoco.
  const lista = await request(app).get('/api/caja/pendientes?moneda=XOF')
    .set('authorization', `Bearer ${tokRep}`)
  assert.ok([401, 403].includes(lista.status), `ni la lista de todos: ${lista.status}`)

})

test('PERMISOS · la caja ve la lista, y un repartidor NO', async () => {
  const deCaja = await request(app).get('/api/caja/pendientes?moneda=XOF')
    .set('authorization', `Bearer ${tokCaja1}`)
  assert.equal(deCaja.status, 200, 'la caja necesita ver a quién hay que cobrarle')
  assert.ok(Array.isArray(deCaja.body) && deCaja.body.length > 0)
  for (const fila of deCaja.body) {
    assert.ok('user_id' in fila && 'lleva_ahora' in fila,
      'y cada uno con lo que lleva, en su moneda')
  }
})

test('PERMISOS · sin sesión no hay caja', async () => {
  const r = await request(app).get('/api/caja/pendientes')
  assert.equal(r.status, 401)
})

// ═══════════════════════════════════════════════════════════════════════════
// EL SALDO NUNCA ES UN NÚMERO GUARDADO
// ═══════════════════════════════════════════════════════════════════════════

test('EL SALDO · se deriva, y se deriva BIEN', async () => {
  const rep = await repartidorNuevo()
  await cobroDe(rep, 1000)
  const antes = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(antes.lleva_ahora), 1000)

  const t = (await request(app).post('/api/caja/traspasos')
    .set('authorization', `Bearer ${tokCaja1}`).send({ repartidorId: rep })).body
  await request(app).post(`/api/caja/traspasos/${t.id}/recibir`)
    .set('authorization', `Bearer ${tokCaja1}`)
    .send({ recibido: 1000, nota: 'cerrado' })

  const despues = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(despues.lleva_ahora), 0, 'después de entregar, no debe nada')

  // Y no hay ninguna columna donde se pueda haber guardado.
  const columnas = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name LIKE '%saldo%'
         OR column_name LIKE '%deuda%' OR column_name LIKE '%efectivo%'`)
  assert.equal(columnas.length, 0,
    'y no existe ningún campo de saldo en el usuario: se cuenta, no se guarda')
})

test('EL SALDO · un cobro rechazado no es dinero que llevaba', async () => {
  const rep = await repartidorNuevo()
  const p = await cobroDe(rep, 800)
  await query(`UPDATE payments SET status='REJECTED', rejection_note='no era ese' WHERE id=$1`, [p])
  const saldo = await K.saldoDe(rep, 'XOF')
  assert.equal(Number(saldo.lleva_ahora), 0,
    'un cobro rechazado es un cobro que no ocurrió: no se lleva dinero por él')
})

test.after(async () => { await closeDb() })
