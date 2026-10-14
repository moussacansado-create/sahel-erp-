/**
 * FASE 3 · Recetas y producción.
 *
 * La prueba que pediste, entera y en orden:
 *
 *   MP → entrada → lote MP → receta → producción → consumo de lotes
 *      → lote de producto terminado → trazabilidad → stock → recargar
 *
 * Y después lo que importa más que ninguna otra cosa: que al REINICIAR el
 * proceso, todo siga ahí y cuadrando. Un sistema que funciona hasta que
 * reinicias no funciona.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-fase-3-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const B = new URL('..', import.meta.url).pathname
const { baseDePrueba, comprobar, seccion, resumen, query, one } =
  await import(`${B}/tests/banco.js`)
const { closeDb, getDb } = await import(`${B}src/db/client.js`)
const { hashPassword } = await import(`${B}src/security/passwords.js`)
const { createApp } = await import(`${B}src/app.js`)
const { request } = await import(`${B}/tests/supertest-helper.js`)

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · FASE 3 · RECETAS Y PRODUCCIÓN')
console.log('══════════════════════════════════════════════════════════════')

await baseDePrueba()
const app = createApp()

// ── Datos base ──
const hash = await hashPassword('clave-fase3-1')
const admin = await one('INSERT INTO users (username,full_name,password_hash) VALUES ($1,$2,$3) RETURNING *',
  ['admin', 'Administrador', hash])
await query('INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code=$2', [admin.id, 'ADMIN'])
const prod = await one('INSERT INTO users (username,full_name,password_hash) VALUES ($1,$2,$3) RETURNING *',
  ['produccion', 'Jefatura Producción', hash])
const rolProd = await one('SELECT id FROM roles WHERE code=$1', ['PRODUCTION'])
await query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [prod.id, rolProd.id])

const L = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
const UD = (await one('SELECT id FROM units WHERE code=$1', ['UD'])).id
const login = async (u) => (await request(app).post('/api/auth/login')
  .send({ username: u, password: 'clave-fase3-1' })).body.access
const TOK = { admin: await login('admin'), produccion: await login('produccion') }
const get = (r, t) => request(app).get(r).set('Authorization', `Bearer ${t || TOK.admin}`)
const post = (r, c, t) => request(app).post(r).set('Authorization', `Bearer ${t || TOK.admin}`).send(c)
const put = (r, c, t) => request(app).put(r).set('Authorization', `Bearer ${t || TOK.admin}`).send(c)

const crearItem = (sku, name, kind, unitId, min = 0, cost = 1, sale = 0) =>
  one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price,shelf_life_days)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,365) RETURNING *`, [sku, name, kind, unitId, min, cost, sale])

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. El recorrido entero, paso a paso')

let AGUA, SURF, TINTA, BOTELLA, LAVAVAJILLAS, RECETA, PRODUCCION, LOTE_PT

{
  // ── 1. Materias primas y envase ──
  AGUA = await crearItem('RM-AGUA', 'Agua desionizada', 'RAW_MATERIAL', L, 20000, 0.12)
  SURF = await crearItem('RM-SURF', 'Surfactante líquido', 'RAW_MATERIAL', L, 5000, 2.40)
  TINTA = await crearItem('RM-TINTA', 'Colorante azul', 'RAW_MATERIAL', L, 200, 18.00)
  BOTELLA = await crearItem('ENV-BOT-500', 'Botella 500 ml', 'PACKAGING', UD, 5000, 0.34)
  LAVAVAJILLAS = await crearItem('PT-LAV-500', 'Lavavajillas 500 ml', 'FINISHED_GOOD', UD, 1000, 0, 4.50)
  comprobar('Se crean las 5 piezas del catálogo', true)

  // ── 2. Entrada de materia prima → crea su lote ──
  const e1 = await post('/api/inventory/recepciones', { itemId: AGUA.id, cantidad: 30000, numeroAlbaran: 'ALB-F3-1' })
  comprobar('Entrada de agua: 200 → lote MP creado', e1.status === 201 && e1.body.lote.code.startsWith('MP-'),
    `${e1.status} ${e1.body.lote?.code}`)
  const loteAgua = e1.body.lote

  await post('/api/inventory/recepciones', { itemId: SURF.id, cantidad: 9000, numeroAlbaran: 'ALB-F3-1' })
  await post('/api/inventory/recepciones', { itemId: TINTA.id, cantidad: 400, numeroAlbaran: 'ALB-F3-1' })
  await post('/api/inventory/recepciones', { itemId: BOTELLA.id, cantidad: 20000, numeroAlbaran: 'ALB-ENV-1' })
  const trasEntradas = await get(`/api/inventory/${AGUA.id}`)
  comprobar('Las entradas suman stock real', Number(trasEntradas.body.qty_on_hand) === 30000,
    `${trasEntradas.body.qty_on_hand}`)

  // Un segundo lote de agua, que CADUCA ANTES que el primero. Sirve para
  // comprobar que la producción se lleva el que toca y no el primero que ve.
  const e2 = await post('/api/inventory/recepciones', {
    itemId: AGUA.id, cantidad: 5000, caducidad: '2027-01-31', numeroAlbaran: 'ALB-F3-2',
  })
  const loteAguaTardio = e2.body.lote

  // ── 3. Receta ──
  const r = await post('/api/recipes', {
    product_id: LAVAVAJILLAS.id,
    name: 'Lavavajillas concentrado 500 ml',
    base_qty: 1000,
    instructions: 'Agitar 10 minutos. Dejar reposar 4 horas antes de envasar.',
    lineas: [
      { item_id: AGUA.id, qty_per_batch: 0.8, unit_id: L },
      { item_id: SURF.id, qty_per_batch: 0.18, unit_id: L },
      { item_id: TINTA.id, qty_per_batch: 0.002, unit_id: L },
      { item_id: BOTELLA.id, qty_per_batch: 1000, unit_id: UD },
    ],
  })
  comprobar('Se crea la receta con sus 4 ingredientes', r.status === 201, `${r.status} ${r.body.error || ''}`)
  RECETA = r.body
  comprobar('La receta tiene código propio', RECETA.code?.startsWith('REC-'), RECETA.code)
  comprobar('Y guarda las 4 líneas', RECETA.lineas?.length === 4, `${RECETA.lineas?.length}`)

  // ── 4. Simular antes de fabricar ──
  const plan = await post('/api/productions/planificar', { recipeId: RECETA.id, cantidad: 500 })
  comprobar('Se puede SIMULAR una producción sin tocar nada', plan.status === 200, `${plan.status} ${plan.body.error || ''}`)
  comprobar('La simulación dice que hay suficiente', plan.body.suficiente === true)
  comprobar('Y qué lotes se usarían',
    plan.body.lineas.every((l) => Array.isArray(l.reparto)),
    'falta el reparto por lotes')
  // El campo `disponible` es lo que la pantalla enseña junto a cada ingrediente.
  // Una vez no se rellenó y el operario vio «Disponible 0» en todo.
  comprobar('Y cuánto hay disponible de cada ingrediente',
    plan.body.lineas.every((l) => Number.isFinite(Number(l.disponible))),
    JSON.stringify(plan.body.lineas.map((l) => l.disponible)))
  comprobar('Y son las existencias reales de la vista',
    plan.body.lineas.every((l) => Number(l.disponible) > 0),
    JSON.stringify(plan.body.lineas.map((l) => `${l.itemName}:${l.disponible}`)))
  const stockTrasSimular = await get(`/api/inventory/${AGUA.id}`)
  comprobar('…y al simular NO se ha movido nada', Number(stockTrasSimular.body.qty_on_hand) === 35000,
    `${stockTrasSimular.body.qty_on_hand}`)

  // ── 5. Producir ──
  const p = await post('/api/productions', { recipeId: RECETA.id, cantidad: 500, notas: 'Primera producción' })
  if (p.status !== 201) console.log('DIAG_PROD ' + p.status + ' :: ' + JSON.stringify(p.body).slice(0, 400))
  comprobar('La producción se ejecuta', p.status === 201, `${p.status} ${p.body.error || ''}`)
  PRODUCCION = p.body.produccion
  LOTE_PT = p.body.lote
  comprobar('Crea un lote de producto terminado con prefijo PT-',
    LOTE_PT?.code?.startsWith('PT-'), LOTE_PT?.code)
  comprobar('Con la cantidad exacta pedida', Number(LOTE_PT?.qty_available) === 500, `${LOTE_PT?.qty_available}`)
  comprobar('Y ese lote tiene fecha de caducidad calculada (vida útil 365 días)',
    !!LOTE_PT?.expiry_date, 'sin caducidad')

  // ── 6. Consumo: FEFO ──
  const consumos = p.body.consumos || []
  comprobar('La producción registra un consumo por LOTE consumido', consumos.length > 0, `${consumos.length}`)
  comprobar('Y guarda qué lote se gastó (trazabilidad)',
    consumos.every((c) => !!c.lot_id && !!c.actual_qty))

  const aguaGastada = consumos.filter((c) => c.item_id === AGUA.id)
  comprobar('Del agua tomó el lote que CADUCA ANTES (FEFO), no el primero',
    aguaGastada[0]?.lot_id === loteAguaTardio.id,
    `tomó ${aguaGastada[0]?.lotCode} (${aguaGastada[0]?.lot_id}) y el que caduca antes es ${loteAguaTardio.code} (${loteAguaTardio.id})`)

  // ── 7. Stock de salida ──
  const aguaDespues = await get(`/api/inventory/${AGUA.id}`)
  // La receta dice 0,8 L por cada 1000 unidades. Para 500 son 0,4 L. Entraron
  // 30000 + 5000 = 35000, así que quedan 34999,6.
  comprobar('El agua CONSUMIDA baja del stock (0,4 L de 35000)', Number(aguaDespues.body.qty_on_hand) === 34999.6,
    `${aguaDespues.body.qty_on_hand}`)

  const surf = await get(`/api/inventory/${SURF.id}`)
  comprobar('El surfactivo baja (0,09 L de 9000)', Number(surf.body.qty_on_hand) === 8999.91,
    `${surf.body.qty_on_hand}`)

  const bot = await get(`/api/inventory/${BOTELLA.id}`)
  comprobar('Las botellas BAJAN 500 (1 por unidad de producto)', Number(bot.body.qty_on_hand) === 19500,
    `${bot.body.qty_on_hand}`)

  const tinta = await get(`/api/inventory/${TINTA.id}`)
  comprobar('El colorante baja 0,001 L de 400', Number(tinta.body.qty_on_hand) === 399.999,
    `${tinta.body.qty_on_hand}`)

  const pt = await get(`/api/inventory/${LAVAVAJILLAS.id}`)
  comprobar('El producto terminado SUBE 500', Number(pt.body.qty_on_hand) === 500, `${pt.body.qty_on_hand}`)

  // ── 8. Un único movimiento por lote consumido ──
  const movs = await get('/api/inventory/movimientos?limite=200')
  const consumosMov = movs.body.filter((m) => m.movement_type === 'PRODUCTION_CONSUMPTION')
  comprobar('Cada consumo dejó UN movimiento en el libro mayor',
    consumosMov.length === consumos.length, `${consumosMov.length} movimientos vs ${consumos.length} consumos`)
  comprobar('Y los movimientos tienen saldo posterior coherente',
    consumosMov.every((m) => Number(m.balance_after) >= 0))

  const salidaMov = movs.body.find((m) => m.movement_type === 'PRODUCTION_OUTPUT')
  comprobar('La salida de producción está en el libro mayor', !!salidaMov, 'no aparece PRODUCTION_OUTPUT')

  // ── 9. Trazabilidad ──
  const detalle = await get(`/api/productions/${PRODUCCION.id}`)
  comprobar('La producción guarda sus consumos con nombre de lote', detalle.body.consumos.length === consumos.length)
  comprobar('Y se puede leer qué lote de qué MP se usó',
    detalle.body.consumos.every((c) => !!c.lot_code && !!c.item_name))
  comprobar('Y qué lote de producto terminó',
    !!detalle.body.lote?.code, 'sin lote de salida')

  // ── 10. El lote PT sabe de dónde viene ──
  const loteInfo = await get(`/api/lots/${LOTE_PT.id}/movimientos`)
  comprobar('El lote de producto tiene movimientos', loteInfo.body.movimientos.length >= 1)
  comprobar('El primero dice que es salida de PRODUCCIÓN, no recepción',
    loteInfo.body.movimientos[0].movement_type === 'PRODUCTION_OUTPUT',
    loteInfo.body.movimientos[0].movement_type)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. La trazabilidad, en las dos direcciones')

{
  // Hacia delante: producto terminado → qué lotes de MP se consumieron
  const haciaDelante = await query(
    `SELECT * FROM v_trace_forward WHERE finished_lot_id = $1`, [LOTE_PT.id])
  comprobar('Trazabilidad hacia delante: el lote PT lista sus ingredientes',
    haciaDelante.length > 0, 'v_trace_forward vacío')
  comprobar('Y cada fila dice qué lote de origen se consumió',
    haciaDelante.every((f) => !!f.source_lot_id), 'faltan lotes de origen')
  comprobar('Y nombra la producción y el lote terminado',
    haciaDelante.every((f) => !!f.production_code && f.finished_lot_code === LOTE_PT.code))

  // Hacia atrás: una MP → qué PT salió de ella.
  // Se comprueba sobre production_materials, que es el enlace real. La vista
  // v_trace_backward arranca por delivery_lines —necesita entregas, que son la
  // Fase 5—, así que hoy estaría vacía aunque la trazabilidad funcionase.
  const loteAguaTardio = await one(
    `SELECT id, code FROM lots WHERE lot_kind='RAW_MATERIAL' ORDER BY id DESC LIMIT 1`)
  const haciaAtras = await query(
    `SELECT pm.lot_id AS origen, pm.actual_qty, pr.code AS produccion, pt.code AS producto
       FROM production_materials pm
       JOIN productions pr ON pr.id = pm.production_id
       JOIN lots pt ON pt.production_id = pr.id AND pt.lot_kind = 'FINISHED_GOOD'
      WHERE pm.lot_id = $1`,
    [loteAguaTardio.id])
  comprobar('Trazabilidad hacia atrás: desde una MP se ve qué PT se fabricó',
    haciaAtras.length > 0, `${loteAguaTardio.code} no lleva a ningún producto`)
  comprobar('Y con qué cantidad se consumió',
    haciaAtras.every((b) => Number(b.actual_qty) > 0))
  comprobar('Y qué producción lo usó',
    haciaAtras.every((b) => b.producto === LOTE_PT.code))

  const nb = await one('SELECT COUNT(*) c FROM v_trace_backward')
  comprobar('v_trace_backward está vacía, y por el motivo correcto: no hay entregas todavía',
    Number(nb.c) === 0, `${nb.c} filas`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. Un lote, un solo sistema')

{
  const todos = await query('SELECT code, lot_kind, origin_type FROM lots ORDER BY id')
  const mp = todos.filter((l) => l.lot_kind === 'RAW_MATERIAL')
  const pt = todos.filter((l) => l.lot_kind === 'FINISHED_GOOD')
  comprobar('Todos los lotes de MP nacen de una RECEPCIÓN',
    mp.every((l) => ['MANUAL_RECEPTION', 'PURCHASE', 'RECEPTION'].includes(l.origin_type) || !l.origin_type),
    [...new Set(mp.map((l) => l.origin_type))].join(','))
  comprobar('Todos los de producto terminan nacen de PRODUCCIÓN',
    pt.every((l) => l.origin_type === 'PRODUCTION'), [...new Set(pt.map((l) => l.origin_type))].join(','))

  const sinLot = await query(
    `SELECT COUNT(*) c FROM lots WHERE lot_kind = 'FINISHED_GOOD' AND production_id IS NULL`)
  comprobar('Ningún lote de producto terminado existe sin su producción', Number(sinLot[0].c) === 0)

  // No hay tabla de lotes paralela.
  const tab = await query("SELECT tablename FROM pg_tables WHERE schemaname='public'")
  const paralelas = tab.map((t) => t.tablename).filter((n) => /lot/i.test(n) && n !== 'lots')
  comprobar('Solo existe UNA tabla de lotes', paralelas.length === 0, `además: ${paralelas.join(', ')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('4. Fallos: si algo falla, no queda nada a medias')

{
  const antes = await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA.id])
  const prodAntes = await one('SELECT COUNT(*) c FROM productions')

  // Receta que pide más de lo que hay
  const mala = await post('/api/recipes', {
    product_id: LAVAVAJILLAS.id, base_qty: 1000,
    lineas: [{ item_id: AGUA.id, qty_per_batch: 999, unit_id: L }],
  })
  // El producto ya tiene la receta de la sección 1. Crear otra debe fallar con
  // un mensaje que explique el porqué, no con un «duplicado» sin más.
  comprobar('No se admite una segunda receta activa para el mismo producto',
    mala.status === 409 && /receta activa/i.test(mala.body.error || ''),
    `${mala.status} ${mala.body.error || ''}`)

  // Para el resto de la sección hace falta un producto SIN receta. Se usa el
  // producto de la receta mala, que nunca llegó a crearse: se crea con otro.
  const otro = await one('INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,purchase_cost,sale_price,shelf_life_days) VALUES ($1,$2,$3,$4,$4,0,9.9,365) RETURNING *',
    ['PT-X', 'Producto de prueba', 'FINISHED_GOOD', UD])
  // Un ingrediente ESCASO de verdad: 10 L en almacén, la receta pide 100.
  const escaso = await crearItem('RM-ESCASO', 'Aditivo escaso', 'RAW_MATERIAL', L, 0, 50)
  await post('/api/inventory/recepciones', { itemId: escaso.id, cantidad: 10, numeroAlbaran: 'ALB-F3-X' })
  const mala2 = await post('/api/recipes', {
    product_id: otro.id, base_qty: 1000,
    lineas: [{ item_id: escaso.id, qty_per_batch: 100, unit_id: L }],
  })
  comprobar('Un producto sin receta SÍ puede tener la suya', mala2.status === 201,
    `${mala2.status} ${mala2.body.error || ''}`)
  const intento = await post('/api/productions', { recipeId: mala2.body.id, cantidad: 500 })
  comprobar('Producir sin existencias suficientes FALLA', intento.status >= 400, `status ${intento.status}`)
  comprobar('Y el error dice QUÉ falta y CUÁNTO',
    /Aditivo escaso/.test(intento.body.error || '') && /40/.test(intento.body.error || ''),
    intento.body.error?.slice(0, 120))

  const despues = await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA.id])
  const prodDespues = await one('SELECT COUNT(*) c FROM productions')
  comprobar('El stock NO ha cambiado', Number(despues.qty_on_hand) === Number(antes.qty_on_hand))
  comprobar('No se ha creado ninguna producción', Number(prodDespues.c) === Number(prodAntes.c))
  const lotes = await one('SELECT COUNT(*) c FROM lots WHERE origin_type=$1', ['PRODUCTION'])
  comprobar('Y ningún lote de producto terminado huérfano', Number(lotes.c) === 1, `${lotes.c}`)

  // Cantidades inválidas
  for (const [desc, cuerpo, esperado] of [
    ['cantidad cero', { recipeId: RECETA.id, cantidad: 0 }, 400],
    ['cantidad negativa', { recipeId: RECETA.id, cantidad: -5 }, 400],
    ['receta inexistente', { recipeId: 999999, cantidad: 100 }, 404],
  ]) {
    const r = await post('/api/productions', cuerpo)
    comprobar(`Producción con ${desc} se rechaza`, r.status === esperado, `esperado ${esperado}, recibido ${r.status}`)
  }

  // Recetas imposibles
  const vacia = await post('/api/recipes', { product_id: LAVAVAJILLAS.id, base_qty: 100, lineas: [] })
  comprobar('Una receta sin ingredientes se rechaza', vacia.status === 400)

  const baseCero = await post('/api/recipes', { product_id: LAVAVAJILLAS.id, base_qty: 0, lineas: [{ item_id: AGUA.id, qty_per_batch: 1, unit_id: L }] })
  comprobar('Una receta con cantidad base cero se rechaza', baseCero.status === 400)

  const seConsume = await post('/api/recipes', {
    product_id: LAVAVAJILLAS.id, base_qty: 100,
    lineas: [{ item_id: LAVAVAJILLAS.id, qty_per_batch: 1, unit_id: UD }],
  })
  comprobar('Un producto no puede ser ingrediente de sí mismo', seConsume.status === 400,
    `status ${seConsume.status}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('5. Versionado de recetas: el histórico no se toca')

{
  const v1 = RECETA
  const v2 = await put(`/api/recipes/${RECETA.id}`, {
    base_qty: 1000,
    lineas: [
      { item_id: AGUA.id, qty_per_batch: 0.7, unit_id: L },
      { item_id: SURF.id, qty_per_batch: 0.2, unit_id: L },
      { item_id: BOTELLA.id, qty_per_batch: 1000, unit_id: UD },
    ],
  })
  if (v2.status !== 200) console.log('DIAG_V2 ' + v2.status + ' :: ' + JSON.stringify(v2.body).slice(0, 300))
  comprobar('Al editar una receta se crea una VERSIÓN NUEVA', v2.status === 200, `${v2.status} ${v2.body.error || ''}`)
  comprobar('Con número de versión mayor', Number(v2.body.version) === Number(v1.version) + 1,
    `${v1.version} → ${v2.body.version}`)
  comprobar('Y código distinto', v2.body.code !== v1.code, v2.body.code)

  const v1Ahora = await get(`/api/recipes/${RECETA.id}`)
  comprobar('La versión 1 sigue existiendo intacta', v1Ahora.status === 200)
  comprobar('Con sus 4 ingredientes originales', v1Ahora.body.lineas.length === 4, `${v1Ahora.body.lineas.length}`)
  comprobar('Pero ya no está activa', v1Ahora.body.is_active === false)

  const activa = await get(`/api/products/${LAVAVAJILLAS.id}/receta`)
  comprobar('Y la activa es la nueva', Number(activa.body.id) === Number(v2.body.id))

  // La producción vieja sigue apuntando a la receta vieja
  const prod = await get(`/api/productions/${PRODUCCION.id}`)
  comprobar('La producción anterior SIGUE apuntando a la receta con la que se hizo',
    Number(prod.body.recipe_id) === Number(RECETA.id), `apunta a ${prod.body.recipe_id}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('6. Permisos')

{
  const casos = [
    ['GET', '/api/recipes', null, TOK.produccion, 200, 'producción SÍ ve las recetas'],
    ['GET', '/api/recipes', null, TOK.admin, 200, 'admin SÍ ve las recetas'],
    ['GET', '/api/productions', null, TOK.produccion, 200, 'producción SÍ ve las producciones'],
  ]
  for (const [m, r, c, t, esperado, desc] of casos) {
    const x = await request(app)[m.toLowerCase()](r).set('Authorization', `Bearer ${t}`)
    comprobar(desc, x.status === esperado, `esperado ${esperado}, recibido ${x.status}`)
  }

  const sinSesion = await request(app).get('/api/recipes')
  comprobar('Sin sesión no se ven las recetas', sinSesion.status === 401)

  // Un usuario sin permiso de producción no puede lanzar una fabricación
  const otro = await one('INSERT INTO users (username,full_name,password_hash) VALUES ($1,$2,$3) RETURNING *',
    ['comercial', 'Comercial', hash])
  const rolCom = await one('SELECT id FROM roles WHERE code=$1', ['COMMERCIAL'])
  await query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [otro.id, rolCom.id])
  const tCom = (await request(app).post('/api/auth/login').send({ username: 'comercial', password: 'clave-fase3-1' })).body.access

  const lanzar = await post('/api/productions', { recipeId: RECETA.id, cantidad: 10 }, tCom)
  comprobar('Un comercial NO puede lanzar una producción', lanzar.status === 403, `status ${lanzar.status}`)

  const ver = await get('/api/productions', tCom)
  comprobar('Ni ver las producciones', ver.status === 403, `status ${ver.status}`)

  const denegados = await query(
    `SELECT * FROM audit_log WHERE action='PERMISO_DENEGADO' AND entity_type='production'`)
  comprobar('Y el intento queda auditado', denegados.length > 0, `${denegados.length}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('7. Cuadre final: los números cuadran')

{
  // Se compara por TIPO DE LOTE. Sumar la salida de producción junto con las
  // recepciones mezcla dos universos: un lote de producto no es un lote de MP.
  const cuadra = await one(
    `SELECT
       (SELECT COALESCE(SUM(l.qty_available),0) FROM lots l WHERE l.lot_kind='RAW_MATERIAL') AS mp,
       (SELECT COALESCE(SUM(l.qty_available),0) FROM lots l WHERE l.lot_kind='FINISHED_GOOD') AS pt,
       (SELECT COALESCE(SUM(m.qty),0) FROM stock_movements m JOIN lots l ON l.id=m.lot_id
         WHERE l.lot_kind='RAW_MATERIAL' AND m.movement_type='PRODUCTION_CONSUMPTION') AS consumido,
       (SELECT COALESCE(SUM(m.qty),0) FROM stock_movements m JOIN lots l ON l.id=m.lot_id
         WHERE l.lot_kind='RAW_MATERIAL' AND m.qty > 0) AS recibido,
       (SELECT COALESCE(SUM(m.qty),0) FROM stock_movements m WHERE m.movement_type='PRODUCTION_OUTPUT') AS producido`,
  )
  comprobar('Las entradas menos los consumos = existencias de MP',
    Math.abs(Number(cuadra.recibido) + Number(cuadra.consumido) - Number(cuadra.mp)) < 0.01,
    `${cuadra.recibido} + ${cuadra.consumido} vs ${cuadra.mp}`)

  const produc = await one(`SELECT qty_available FROM lots WHERE code=$1`, [LOTE_PT.code])
  comprobar('Lo producido en el libro mayor = existencias de PT',
    Math.abs(Number(cuadra.producido) - Number(produc.qty_available)) < 0.01)

  const negativos = await one('SELECT COUNT(*) c FROM lots WHERE qty_available < 0')
  comprobar('Ningún lote con existencias negativas', Number(negativos.c) === 0)

  const imposibles = await one('SELECT COUNT(*) c FROM lots WHERE qty_available + qty_consumed > initial_qty + 0.001')
  comprobar('Ningún lote donde lo disponible + lo consumido supere lo recibido', Number(imposibles.c) === 0)

  const huerfanos = await one(
    `SELECT COUNT(*) c FROM production_materials pm
      WHERE NOT EXISTS (SELECT 1 FROM lots l WHERE l.id = pm.lot_id)`)
  comprobar('Ningún consumo apunta a un lote inexistente', Number(huerfanos.c) === 0)

  const sinConsumo = await one(
    `SELECT COUNT(*) c FROM productions pr
      WHERE pr.status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM production_materials pm WHERE pm.production_id = pr.id)`)
  comprobar('Ninguna producción terminada sin consumos registrados', Number(sinConsumo.c) === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('8. Recargar y reiniciar: los datos siguen ahí')

{
  // Recargar la aplicación
  const app2 = createApp()
  const trasRecarga = await request(app2).get(`/api/productions/${PRODUCCION.id}`)
    .set('Authorization', `Bearer ${TOK.admin}`)
  comprobar('Tras recargar la aplicación, la producción sigue', trasRecarga.status === 200, `${trasRecarga.status}`)
  comprobar('Con sus consumos', trasRecarga.body.consumos?.length > 0)
  comprobar('Y su lote de producto', !!trasRecarga.body.lote?.code, trasRecarga.body.lote?.code)

  // Reiniciar el proceso: cerrar y volver a abrir la base
  const EXPECT = {
    prodId: PRODUCCION.id, loteCode: LOTE_PT.code,
    agua: 34999.6, lavavajillas: 500, botellas: 19500,
    consumos: (await get(`/api/productions/${PRODUCCION.id}`)).body.consumos.length,
  }
  await closeDb()
  await getDb()

  const prodDespues = await get(`/api/productions/${EXPECT.prodId}`)
  comprobar('Tras REINICIAR el proceso, la producción sigue ahí',
    prodDespues.status === 200, `${prodDespues.status}`)
  comprobar('Y sus consumos también', prodDespues.body.consumos?.length === EXPECT.consumos,
    `${prodDespues.body.consumos?.length} vs ${EXPECT.consumos}`)
  comprobar('Con el MISMO lote de producto', prodDespues.body.lote?.code === EXPECT.loteCode,
    `${prodDespues.body.lote?.code} vs ${EXPECT.loteCode}`)

  const s1 = await get(`/api/inventory/${AGUA.id}`)
  const s2 = await get(`/api/inventory/${LAVAVAJILLAS.id}`)
  const s3 = await get(`/api/inventory/${BOTELLA.id}`)
  comprobar('El stock de MP sigue en 34999,6', Number(s1.body.qty_on_hand) === EXPECT.agua, `${s1.body.qty_on_hand}`)
  comprobar('El de producto terminado en 500', Number(s2.body.qty_on_hand) === EXPECT.lavavajillas, `${s2.body.qty_on_hand}`)
  comprobar('Y el de botellas en 19500', Number(s3.body.qty_on_hand) === EXPECT.botellas, `${s3.body.qty_on_hand}`)

  const movs = await get('/api/inventory/movimientos?limite=200')
  comprobar('El libro mayor conserva todos los movimientos', movs.body.length >= 6, `${movs.body.length}`)

  // Y la trazabilidad sigue siendo consultable
  const tz = await query('SELECT * FROM v_trace_forward WHERE finished_lot_id = $1', [LOTE_PT.id])
  comprobar('Y la trazabilidad se puede volver a leer', tz.length > 0, 'vacía')
}

const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
await closeDb()
process.exit(r.fallos ? 1 : 0)
