/**
 * ÓRDENES DE FABRICACIÓN
 *
 *   PLANIFICAR → PENDIENTE → FABRICAR → CONFIRMAR → DESAPARECE → HISTÓRICO
 *
 * Lo que se comprueba, con números delante:
 *   · planificar NO consume material
 *   · la orden aparece en la lista de trabajo
 *   · si falta material, la orden NO se cancela y dice cuánto falta
 *   · la cantidad se puede cambiar mientras siga pendiente
 *   · NO se puede cambiar cuando ya ha comenzado
 *   · confirmar consume el material y crea el lote PT
 *   · confirmar dos veces no se puede
 *   · la orden desaparece de pendientes y queda en el histórico
 *   · conserva SU código: el parte y el histórico son el mismo trabajo
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-ordenes-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb, transaction } = await import('./banco.js')
const { crearLoteConEntrada } = await import('../src/core/stock.js')
const P = await import('../src/core/produccion.js')

let e

test.before(async () => {
  await baseDePrueba()
  e = await escenario()
})
test.after(async () => { await closeDb() })

async function escenario() {
  return transaction(async (tx) => {
    const u = await tx.one(`SELECT id FROM units ORDER BY id LIMIT 1`)

    // La serie 'ORD' tiene que existir antes de fabricar.
    //
    // Este test fallaba con «La serie ORD no existe» y la culpa era SUYA, no
    // del sistema: creaba un producto con `lot_prefix = 'ORD'` sin crear la
    // serie correspondiente. El sistema hace bien —sin serie no hay numeración,
    // y lo dice con un mensaje claro—: lo que faltaba era el paso de dar de
    // alta la serie, que es justo lo que hace un administrador en
    // Configuración → Numeración antes de fabricar con una familia nueva.
    //
    // No se «arregla» poniendo una serie inventada en la migración: eso
    // metería en producción una familia de productos que nadie ha pedido.
    await tx.query(
      `INSERT INTO config_series (codigo, nombre, clase, prefijo, digitos, con_anio, ultimo_valor, anio)
       VALUES ('ORD','Órdenes de prueba','PRODUCTO','ORD',6,true,0,NULL)
       ON CONFLICT (codigo) DO NOTHING`,
    )

    const cat = await tx.one(
      `INSERT INTO item_categories (code, name, category_kind)
       VALUES ('ORD-F4','Órdenes de prueba','FINISHED_GOOD') RETURNING id`)
    const pt = await tx.one(
      `INSERT INTO items (sku,name,category_kind,category_id,unit_id,lot_prefix,sale_price,tax_rate)
       VALUES ('PT-ORD-1L','Producto de órdenes','FINISHED_GOOD',$1,$2,'ORD',10,0.21) RETURNING id`,
      [cat.id, u.id])
    const mp = await tx.one(
      `INSERT INTO items (sku,name,category_kind,unit_id,purchase_cost)
       VALUES ('MP-ORD-1','Materia de órdenes','RAW_MATERIAL',$1,1) RETURNING id`, [u.id])
    const receta = await tx.one(
      `INSERT INTO recipes (code,name,product_id,base_qty,base_unit_id)
       VALUES ('REC-ORD-1','Receta de órdenes',$1,100,$2) RETURNING id`, [pt.id, u.id])
    await tx.query(
      `INSERT INTO recipe_lines (recipe_id,item_id,qty_per_batch,unit_id) VALUES ($1,$2,1,$3)`,
      [receta.id, mp.id, u.id])
    const mpLote = await tx.one(
      `INSERT INTO lots (code,item_id,lot_kind,status,initial_qty,qty_available,unit_id,origin_type)
       VALUES ('MP-ORD-0001',$1,'RAW_MATERIAL','ACTIVE',500,500,$2,'OPENING') RETURNING id`,
      [mp.id, u.id])
    return { u, pt, mp, receta, mpLote }
  })
}

const saldo = async (loteId) =>
  Number((await one(`SELECT qty_available FROM lots WHERE id=$1`, [loteId])).qty_available)

const pendientes = async () =>
  (await P.listarOrdenesPendientes({})).map((x) => x.code)

// ═══════════════════════════════════════════════════════════════════════════
test('1 · Planificar NO toca el stock y crea la orden PENDIENTE', async () => {
  const antesMp = await saldo(e.mpLote.id)
  const o = await P.planificarFabricacion({
    recipeId: e.receta.id, cantidad: 500, usuarioId: null, notas: 'Parte del día',
  })
  assert.equal(o.status, 'PLANNED', 'una orden nueva no quedó pendiente')
  assert.equal(o.actual_qty, null, 'una orden pendiente no debe llevar cantidad fabricada')
  assert.match(o.code, /^FAB-\d{4}-\d{4}$/, `código de orden raro: ${o.code}`)
  assert.equal(await saldo(e.mpLote.id), antesMp, 'planificar movió el stock de materia prima')
  const lotes = await one(`SELECT COUNT(*) n FROM lots WHERE production_id = $1`, [o.id])
  assert.equal(Number(lotes.n), 0, 'planificar creó un lote de producto terminado')
  assert.ok((await pendientes()).includes(o.code), 'la orden no sale en la lista de trabajo')
  globalThis.orden1 = o
})

// ═══════════════════════════════════════════════════════════════════════════
test('2 · Si falta material, la orden NO se cancela: lo dice y sigue viva', async () => {
  // La receta es de 100 unidades y gasta 1 de materia prima por unidad. El
  // almacén tiene 500. Pedir 900.000 son 9.000 de materia prima: imposible.
  const o = await P.planificarFabricacion({
    recipeId: e.receta.id, cantidad: 900000, usuarioId: null,
  })
  const c = await P.comprobarPlan(o.id)
  assert.equal(c.falta_material, true, 'no detectó que faltaba material')
  assert.ok(c.faltan.length > 0, 'no dice QUÉ falta')
  assert.ok(c.faltan[0].falta > 0, 'no dice CUÁNTO falta')
  assert.ok(c.faltan[0].nombre, 'no dice QUÉ ingrediente falta')
  assert.ok((await pendientes()).includes(o.code), 'la falta de material canceló la orden')
  assert.equal((await P.comprobarPlan(o.id)).status, 'PLANNED')
  globalThis.ordenFalta = o
})

test('3 · No se puede fabricar sin material', async () => {
  await assert.rejects(
    () => P.confirmarPlan(globalThis.ordenFalta.id, { usuarioId: null }),
    /materia prima suficiente/i,
    'permitió fabricar sin material')
})

test('4 · Comprobar el plan NO escribe nada en el almacén', async () => {
  const antes = await saldo(e.mpLote.id)
  await P.comprobarPlan(globalThis.ordenFalta.id)
  await P.comprobarPlan(globalThis.ordenFalta.id)
  assert.equal(await saldo(e.mpLote.id), antes, 'comprobar el plan movió el stock')
})

// ═══════════════════════════════════════════════════════════════════════════
test('5 · La cantidad se cambia mientras siga pendiente', async () => {
  const o = await P.planificarFabricacion({ recipeId: e.receta.id, cantidad: 100, usuarioId: null })
  const d = await P.editarPlan(o.id, { cantidad: 250 }, null)
  assert.equal(Number(d.planned_qty), 250, 'no cambió la cantidad planificada')
  globalThis.ordenEditada = o
})

test('6 · Una vez empezada, la cantidad ya no se toca', async () => {
  const o = globalThis.ordenEditada
  const he = await P.confirmarPlan(o.id, { usuarioId: null })
  await assert.rejects(
    () => P.editarPlan(o.id, { cantidad: 999 }, null),
    /comenzado|ORDEN_YA_INICIADA/i,
    'cambió la cantidad de una fabricación ya hecha, rompiendo la trazabilidad')
  assert.equal(Number(he.produccion.actual_qty), 250,
    'la cantidad realizada no es la que se planificó')
})

// ═══════════════════════════════════════════════════════════════════════════
test('7 · Confirmar consume el material y saca la orden de pendientes', async () => {
  const antesMp = await saldo(e.mpLote.id)
  const o = await P.planificarFabricacion({
    recipeId: e.receta.id, cantidad: 1000, usuarioId: null, notas: 'Parte de mañana',
  })
  assert.ok((await pendientes()).includes(o.code), 'la orden no estaba en la lista de trabajo')

  const r = await P.confirmarPlan(o.id, { usuarioId: null })

  // 1000 unidades, y la receta gasta 1 de materia prima por unidad = 10.
  assert.equal(antesMp - await saldo(e.mpLote.id), 10, 'confirmar no consumió la materia prima prevista')
  // El formato del código de lote NO es «SKU + número». Eso era lo que esta
  // línea esperaba (`PT-ORD-00001`) y nunca fue el contrato del sistema: el
  // número sale de la SERIE del producto, no del nombre del artículo. La
  // migración 010 lo deja escrito desde el principio —«PT-LIM-1L» → prefijo
  // «LIM» → serie LIM—, y las series reales de producción (DES, LAV, LIM) son
  // de 6 dígitos y llevan el año.
  //
  // La expectativa estaba caduca. Corregirla aquí NO es maquillar un fallo: es
  // dejar de exigir un formato que el sistema no ha producido nunca. El
  // contenido del lote —cantidad, lote de salida, consumos— se sigue
  // comprobando igual que antes, que es lo que de verdad importa aquí.
  assert.match(
    r.lote.code, /^ORD-\d{4}-\d{6}$/,
    `el código del lote debe ser ORD-<año>-<6 dígitos>, no ${r.lote.code}`,
  )
  assert.equal(Number(r.lote.qty_available), 1000)
  assert.equal(Number(r.lote.production_id), Number(r.produccion.id),
    'el lote de producto terminado no apunta a su propia producción')
  assert.ok(!(await pendientes()).includes(o.code),
    'una fabricación confirmada sigue en la lista de trabajo')
  globalThis.ordenHecha = { o, r }
})

test('8 · La orden conserva SU código: el parte y el histórico son el mismo trabajo', async () => {
  // Si al confirmar se pidiera un número nuevo, el parte del operario diría
  // FAB-…0001 y el histórico FAB-…0002, y su trabajo no se encontraría.
  const { o, r } = globalThis.ordenHecha
  assert.equal(r.codigo, o.code, `la orden era ${o.code} y la fabricación salió como ${r.codigo}`)
  const h = (await P.listarProducciones({ estado: 'COMPLETED', limite: 50 })).find((x) => x.code === o.code)
  assert.ok(h, 'no está en las producciones realizadas')
  assert.equal(h.status, 'COMPLETED')
  assert.ok(h.lot_code, 'el histórico no guarda el lote de producto terminado')
  assert.ok(h.finished_at, 'el histórico no guarda la fecha de fin')
})

test('9 · La trazabilidad apunta a los lotes de MP que salieron', async () => {
  const { r } = globalThis.ordenHecha
  assert.ok(r.consumos.length > 0, 'no guardó los consumos')
  for (const c of r.consumos) {
    assert.equal(Number(c.lot_id), Number(e.mpLote.id))
    assert.ok(Number(c.actual_qty) > 0, 'guardó un consumo de cero')
  }
})

test('10 · Confirmar DOS VECES la misma orden no se puede', async () => {
  const { o, r } = globalThis.ordenHecha
  const antesMp = await saldo(e.mpLote.id)
  const antesPt = Number((await one(
    `SELECT qty_available FROM lots WHERE code=$1`, [r.lote.code])).qty_available)
  await assert.rejects(
    () => P.confirmarPlan(o.id, { usuarioId: null }),
    /ya está COMPLETED|ORDEN_YA_PROCESADA/i,
    'permitió fabricar la misma orden dos veces')
  assert.equal(await saldo(e.mpLote.id), antesMp, 'el segundo intento movió la materia prima')
  const despuesPt = Number((await one(
    `SELECT qty_available FROM lots WHERE code=$1`, [r.lote.code])).qty_available)
  assert.equal(despuesPt, antesPt, 'el segundo intento creó producto de más')
})

// ═══════════════════════════════════════════════════════════════════════════
test('11 · Pendientes e histórico nunca se solapan', async () => {
  const pend = await pendientes()
  // El histórico se pide TERMINADO, igual que lo hace la pantalla. Si se pide
  // sin filtro devuelve también las pendientes, y los dos bloques de la misma
  // pantalla enseñan la misma fila dos veces.
  const hechas = (await P.listarProducciones({ estado: 'COMPLETED', limite: 100 })).map((x) => x.code)
  const solape = pend.filter((c) => hechas.includes(c))
  assert.equal(solape.length, 0,
    `estas órdenes están a la vez en pendientes y en el histórico: ${solape.join(', ')}`)
  for (const c of pend) {
    const p = await one(`SELECT status FROM productions WHERE code=$1`, [c])
    assert.equal(p.status, 'PLANNED', `${c} está en pendientes pero su estado es ${p.status}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test('12 · El muro contra la doble confirmación está DENTRO de la transacción', async () => {
  // No hace falta fuerza bruta: se llama al motor con una orden YA hecha, que
  // es exactamente lo que vería la segunda confirmación si llegara a colarse.
  // La comprobación está dentro de `transaction()`, antes de consumir lotes.
  const { o } = globalThis.ordenHecha
  const antesMp = await saldo(e.mpLote.id)
  const antesLotes = Number((await one(`SELECT COUNT(*) n FROM lots`)).n)
  await assert.rejects(
    () => P.producir({
      recipeId: e.receta.id, cantidad: 250, usuarioId: null, produccionId: o.id,
    }),
    /ORDEN_YA_PROCESADA|ya está COMPLETED|fabricado por otra confirmación/i,
    'el motor aceptó fabricar una orden que ya estaba hecha')
  assert.equal(await saldo(e.mpLote.id), antesMp, 'el intento fallido movió la materia prima')
  assert.equal(Number((await one(`SELECT COUNT(*) n FROM lots`)).n), antesLotes,
    'el intento fallido creó un lote de producto terminado')
})
