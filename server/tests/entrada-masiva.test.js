/**
 * LA ENTRADA MASIVA.
 *
 * Es la puerta por la que entra un albarán entero: 20 líneas de un proveedor,
 * leídas de un papel, en un solo rato. Y llevaba MESES rota sin que nadie se
 * enterara, porque la ruta que la llama no existía y el error se escondía
 * detrás de un `catch` que se tragaba la excepción.
 *
 * Lo que se rompe aquí, y cómo se sabe que está bien:
 *
 *   1. Un albarán es TODO O NADA. Si la línea 7 falla, no puede quedar el lote
 *      de la línea 1 por el camino.
 *   2. Reintentar el mismo albarán NO duplica mercancía. Un doble toque, o un
 *      reenvío del cliente con la wifi pillada, no puede Costar doble.
 *   3. Cada línea deja su lote y su movimiento, y el saldo del movimiento
 *      coincide con lo que hay en el almacén.
 *   4. El fallo dice QUÉ línea falló, no «algo falló».
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-masivas-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb } = await import('./banco.js')
const INV = await import('../src/core/inventario.js')

let u = null
let persona = null
let mp1, mp2, prov

test.before(async () => {
  await baseDePrueba()
  persona = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('masiva','Almacén','x', now()) RETURNING id`)).id
  u = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id
  mp1 = (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix)
     VALUES ('MSV-MP-1','Albárán uno','RAW_MATERIAL',$1,'MSV') RETURNING id`, [u])).id
  mp2 = (await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix)
     VALUES ('MSV-MP-2','Albárán dos','RAW_MATERIAL',$1,'MSV') RETURNING id`, [u])).id
  prov = (await one(`INSERT INTO suppliers (code, name) VALUES ('PRO-MSV','Proveedor Masivo') RETURNING id`)).id
})
test.after(async () => { await closeDb() })

const linea = (itemId, cantidad, extra = {}) => ({ itemId, cantidad, ...extra })

/**
 * El saldo de un artículo es la SUMA de sus lotes.
 *
 * La primera versión hacía `SELECT qty_available ... LIMIT 1` sin ordenar: leía
 * un lote cualquiera. Con un solo lote por artículo daba igual, pero en cuanto
 * hubo dos devolvía uno u otro según el plan de ejecución y el test pasaba o
 * fallaba sin que hubiera cambiado nada. Un test que depende del orden en que
 * PostgreSQL devuelve las filas no mide nada: mide el plan de la consulta.
 */
async function saldo(itemId) {
  const f = await one(`SELECT COALESCE(SUM(qty_available), 0) AS s FROM lots WHERE item_id = $1`, [itemId])
  return Number(f.s)
}

/** Una columna `DATE` llega como objeto `Date`, no como «2028-01-31». */
function diaDe(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

// ─── 1 · Un albarán entero entra bien ───────────────────────────────────────

test('un albarán de varias líneas entra entero: lote, movimiento y saldo por línea', async () => {
  const antes1 = await saldo(mp1)
  const antes2 = await saldo(mp2)

  const lotes = await INV.registrarEntradasMasivas([
    linea(mp1, 12, { codigoLote: 'MSV-A', proveedorId: prov, loteProveedor: 'P-001',
      caducidad: '2028-01-31', costeUnitario: 400 }),
    linea(mp2, 5, { codigoLote: 'MSV-B', proveedorId: prov, loteProveedor: 'P-002' }),
    linea(mp1, 8, { codigoLote: 'MSV-C', proveedorId: prov }),
  ], persona, { numeroAlbaran: 'ALB/2026/9001' })

  assert.equal(lotes.length, 3, 'tres líneas, tres lotes')

  // Cada línea, con SU lote.
  assert.deepEqual(lotes.map((l) => l.code), ['MSV-A', 'MSV-B', 'MSV-C'])
  assert.equal(Number(lotes[0].qty_available), 12)
  assert.equal(diaDe(lotes[0].expiry_date), '2028-01-31')
  assert.equal(lotes[0].supplier_lot_code, 'P-001', 'el lote guarda el código que usa el PROVEEDOR')
  assert.equal(lotes[0].invoice_ref, 'ALB/2026/9001', 'y el número de albarán, para poder seguirlo')

  // El saldo es EXACTO, línea a línea. Ni una unidad de más ni de menos.
  assert.equal(await saldo(mp1), antes1 + 20, '12 + 8 en el primero')
  assert.equal(await saldo(mp2), antes2 + 5, '5 en el segundo')

  // Y el libro mayor cuenta lo mismo que el almacén. Si diverge, alguno miente.
  const movs = await query(
    `SELECT lot_id, qty FROM stock_movements
      WHERE movement_type = 'RECEPTION' AND lot_id = ANY($1::bigint[])
      ORDER BY id`, [lotes.map((l) => l.id)])
  assert.equal(movs.length, 3, 'un movimiento por línea: no uno por albarán')
  for (const m of movs) {
    const lote = await one(`SELECT qty_available FROM lots WHERE id = $1`, [m.lot_id])
    assert.equal(Number(lote.qty_available), Number(m.qty),
      'saldo del lote = cantidad del movimiento. Siempre.')
  }
})

// ─── 2 · Idempotencia: el mismo albarán dos veces NO duplica ────────────────

test('reintentar el mismo albarán no duplica mercancía', async () => {
  const antes = await saldo(mp1)
  const nLotesAntes = (await one(`SELECT count(*) AS n FROM lots`)).n

  await assert.rejects(
    () => INV.registrarEntradasMasivas(
      [linea(mp1, 999, { codigoLote: 'MSV-REPETIDO' })],
      persona, { numeroAlbaran: 'ALB/2026/9001' }),
    (err) => err.codigo === 'ALBARAN_DUPLICADO' && err.estado === 409,
  )

  assert.equal(await saldo(mp1), antes, 'ni una unidad más')
  assert.equal((await one(`SELECT count(*) AS n FROM lots`)).n, nLotesAntes, 'ni un lote más')
  assert.equal((await one(`SELECT count(*) AS n FROM lots WHERE code = 'MSV-REPETIDO'`)).n, 0)
})

// ─── 3 · TODO O NADA ────────────────────────────────────────────────────────

test('una línea inválida tira el albarán entero: no queda ni un lote a medias', async () => {
  const antes1 = await saldo(mp1)
  const nLotesAntes = (await one(`SELECT count(*) AS n FROM lots`)).n
  const nMovsAntes = (await one(`SELECT count(*) AS n FROM stock_movements`)).n

  // La línea 2 pide un artículo que no existe. La 1 es perfectamente buena.
  await assert.rejects(
    () => INV.registrarEntradasMasivas([
      linea(mp1, 50, { codigoLote: 'MSV-OK' }),
      linea(999999, 50, { codigoLote: 'MSV-MAL' }),
      linea(mp1, 50, { codigoLote: 'MSV-OK2' }),
    ], persona, { numeroAlbaran: 'ALB/2026/9002' }),
  )

  assert.equal(await saldo(mp1), antes1, 'las líneas 1 y 3 NO han dejado ni rastro')
  assert.equal((await one(`SELECT count(*) AS n FROM lots`)).n, nLotesAntes)
  assert.equal((await one(`SELECT count(*) AS n FROM stock_movements`)).n, nMovsAntes)
  assert.equal((await one(`SELECT count(*) AS n FROM lots WHERE code LIKE 'MSV-OK%'`)).n, 0)

  // Y el albarán queda LIBRE: si se reintenta tras arreglar el artículo, entra.
  const reintento = await INV.registrarEntradasMasivas(
    [linea(mp1, 10, { codigoLote: 'MSV-REINTENTO' })], persona, { numeroAlbaran: 'ALB/2026/9002' })
  assert.equal(reintento.length, 1, 'el fallo no quemó el número de albarán')
})

// ─── 4 · El fallo dice QUÉ línea ────────────────────────────────────────────

test('el error nombra la línea que falló, no solo que algo falló', async () => {
  try {
    await INV.registrarEntradasMasivas([
      linea(mp1, 1, { codigoLote: 'MSV-X1' }),
      linea(mp2, -5, { codigoLote: 'MSV-X2' }),   // cantidad negativa
      linea(mp1, 1, { codigoLote: 'MSV-X3' }),
    ], persona)
    assert.fail('debería haber fallado')
  } catch (err) {
    assert.match(err.message, /Línea 2 de 3/,
      `el operario tiene que ver cuál es, sin contar: "${err.message}"`)
  }
})

// ─── 5 · Lo que NO debe romperse ────────────────────────────────────────────

test('sin número de albarán también entra, y sin llamar dos veces al banco', async () => {
  const antes = await saldo(mp2)
  const lotes = await INV.registrarEntradasMasivas(
    [linea(mp2, 3, { codigoLote: 'MSV-SIN-NUM' })], persona)
  assert.equal(lotes.length, 1)
  assert.equal(await saldo(mp2), antes + 3)
  assert.equal(lotes[0].invoice_ref, null, 'sin albarán no hay factura que guardar')
})

test('el origen es MANUAL_RECEPTION, no el movement_type RECEPCION', async () => {
  // Son dos cosas distintas y se confundían porque las dos se llaman recepción:
  //   movement_type = de CÓMO se movió el stock  → RECEPCION
  //   origin_type   = de DÓNDE viene la mercancía → MANUAL_RECEPTION
  // Con `RECEPTION` en origin_type, PostgreSQL lo rechazaba por el CHECK: un
  // ingreso manual no es una compra ni una producción.
  await INV.registrarEntradasMasivas(
    [linea(mp2, 1, { codigoLote: 'MSV-ORIGEN' })], persona)

  const lote = await one(`SELECT origin_type FROM lots WHERE code = 'MSV-ORIGEN'`)
  assert.equal(lote.origin_type, 'MANUAL_RECEPTION')

  const mov = await one(
    `SELECT movement_type FROM stock_movements
      WHERE lot_id = (SELECT id FROM lots WHERE code = 'MSV-ORIGEN')`)
  assert.equal(mov.movement_type, 'RECEPTION', 'el movimiento sigue siendo una recepción')
})

test('la llave de idempotencia se guarda con una columna que existe', async () => {
  // `stock_movement_keys` tiene (key, movement_id, created_at). La versión
  // anterior pedía `id` y escribía `scope`: dos columnas inventadas, y el
  // PostgreSQL contestaba «column does not exist» sin más pista.
  const filas = await query(
    `SELECT key, movement_id FROM stock_movement_keys WHERE key LIKE 'ALBARAN:ALB/2026/9001%'`)
  assert.equal(filas.length, 3, 'una llave por línea del albarán')
  for (const f of filas) {
    assert.ok(f.movement_id, 'y cada llave apunta a su movimiento')
    const m = await one(`SELECT lot_id FROM stock_movements WHERE id = $1`, [f.movement_id])
    assert.ok(m, 'y ese movimiento existe de verdad')
  }
})

test('el tope de 200 líneas se respeta', async () => {
  const muchas = Array.from({ length: 201 }, () => linea(mp1, 1))
  await assert.rejects(
    () => INV.registrarEntradasMasivas(muchas, persona),
    (err) => err.codigo === 'DEMASIADAS_LINEAS',
  )
})
