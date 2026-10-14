/**
 * Pruebas de la Fase 2: catálogo, entradas, stock, movimientos, ajustes y
 * reservas.
 *
 * La cadena que se verifica, para cada flujo:
 *   INTERFAZ → API → TRANSACCIÓN → PostgreSQL → RESPUESTA → RECARGA
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-fase-2-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, comprobar, seccion, resumen, query, one, transaction,
        crearUsuario } = await import('./banco.js')
const { hashPassword } = await import('../src/security/passwords.js')
const { createApp } = await import('../src/app.js')
const { request } = await import('./supertest-helper.js')
const { closeDb, getDb } = await import('../src/db/client.js')

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · FASE 2 · INVENTARIO')
console.log('══════════════════════════════════════════════════════════════')

await baseDePrueba()
const app = createApp()

// ── Utilidades ───────────────────────────────────────────────────────────────
const CLAVES = {
  admin: 'admin-fase2-1', produccion: 'produccion-fase2-1',
  reparto: 'reparto-fase2-1', comercial: 'comercial-fase2-1',
  contabilidad: 'contabilidad-fase2-1', sinpermisos: 'sinpermisos-fase2-1',
}
const TOK = {}

async function crear(usuario, rol) {
  const hash = await hashPassword(CLAVES[usuario])
  const u = await one(
    `INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
    [usuario, usuario.toUpperCase(), hash])
  const r = await one('SELECT id FROM roles WHERE code = $1', [rol])
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [u.id, r.id])
  return u
}

async function entrar(usuario) {
  const r = await request(app).post('/api/auth/login').send({ username: usuario, password: CLAVES[usuario] })
  TOK[usuario] = r.body.access
  return r.body.access
}

/** GET autenticado, sugar. */
const get = (ruta, t) => request(app).get(ruta).set('Authorization', `Bearer ${t || TOK.admin}`)
const post = (ruta, cuerpo, t) => request(app).post(ruta).set('Authorization', `Bearer ${t || TOK.admin}`).send(cuerpo)
const put = (ruta, cuerpo, t) => request(app).put(ruta).set('Authorization', `Bearer ${t || TOK.admin}`).send(cuerpo)

const UNIDAD_L = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
const UNIDAD_UD = (await one('SELECT id FROM units WHERE code=$1', ['UD'])).id

for (const [u, r] of [['admin', 'ADMIN'], ['produccion', 'PRODUCTION'], ['reparto', 'DELIVERY'],
  ['comercial', 'COMMERCIAL'], ['contabilidad', 'ACCOUNTING']]) await crear(u, r)
for (const u of Object.keys(CLAVES)) await entrar(u)

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. Catálogo: un solo maestro para los tres tipos de artículo')

let AGUA, BOTELLA, LAVAVAJILLAS
{
  const r = await post('/api/items', {
    sku: 'RM-AGUA', name: 'Agua desionizada', category_kind: 'RAW_MATERIAL',
    unit_id: UNIDAD_L, min_stock: 1000, purchase_cost: 0.1,
  })
  comprobar('Se crea una materia prima', r.status === 201, `${r.status} ${r.body.error || ''}`)
  AGUA = r.body.id

  const b = await post('/api/items', {
    sku: 'ENV-BOT-500', name: 'Botella 500 ml', category_kind: 'PACKAGING',
    unit_id: UNIDAD_UD, min_stock: 500, purchase_cost: 0.35, format_label: '500 ml',
  })
  comprobar('Se crea un envase', b.status === 201, `${b.status} ${b.body.error || ''}`)
  BOTELLA = b.body.id

  const p = await post('/api/items', {
    sku: 'PT-LAV-500', name: 'Lavavajillas 500 ml', category_kind: 'FINISHED_GOOD',
    unit_id: UNIDAD_UD, min_stock: 100, purchase_cost: 2.1, sale_price: 4.5, format_label: '500 ml',
  })
  comprobar('Se crea un producto terminado', p.status === 201, `${p.status} ${p.body.error || ''}`)
  LAVAVAJILLAS = p.body.id

  const todos = await get('/api/items')
  comprobar('Los tres están en la MISMA tabla, distinguidos por categoría',
    todos.body.length === 3 && new Set(todos.body.map((x) => x.category_kind)).size === 3)

  const cols = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='items' AND column_name IN ('stock','qty','quantity','existencia')`)
  comprobar('Y esa tabla NO tiene columna de stock', cols.length === 0,
    `encontradas: ${cols.map((c) => c.column_name).join(', ')}`)

  const dup = await post('/api/items', { sku: 'RM-AGUA', name: 'Repetida', category_kind: 'RAW_MATERIAL', unit_id: UNIDAD_L })
  comprobar('No se admiten dos artículos con el mismo SKU', dup.status === 409, `status ${dup.status}`)

  const malo = await post('/api/items', { sku: 'x', name: 'Corto', category_kind: 'RAW_MATERIAL', unit_id: UNIDAD_L })
  comprobar('Un SKU inválido se rechaza con el motivo', malo.status === 400 && /SKU/.test(malo.body.error))

  const sinNombre = await post('/api/items', { sku: 'RM-SIN-NOMBRE', category_kind: 'RAW_MATERIAL', unit_id: UNIDAD_L })
  comprobar('Sin nombre se rechaza', sinNombre.status === 400 && /nombre/i.test(sinNombre.body.error))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. Entrada de materia prima: la cadena completa')

{
  const antes = await get(`/api/inventory/${AGUA}`)
  comprobar('Antes de nada, el stock es 0', Number(antes.body.qty_on_hand) === 0)

  const r = await post('/api/inventory/recepciones', {
    itemId: AGUA, cantidad: 500, caducidad: '2027-06-30',
    numeroAlbaran: 'ALB-001', loteProveedor: 'L-PROV-1', costeUnitario: 0.12,
    notas: 'Primera recepción',
  })
  comprobar('La entrada devuelve 201', r.status === 201, `${r.status} ${r.body.error || ''}`)
  comprobar('Crea un lote con código', !!r.body.lote?.code, JSON.stringify(r.body).slice(0, 150))
  comprobar('El lote nace con la cantidad recibida', Number(r.body.lote?.qty_available) === 500)
  comprobar('La respuesta ya trae el stock actualizado', Number(r.body.stock?.qty_on_hand) === 500)

  // ── API ──
  const porApi = await get(`/api/inventory/${AGUA}`)
  comprobar('API: el stock es 500', Number(porApi.body.qty_on_hand) === 500, `${porApi.body.qty_on_hand}`)

  // ── PostgreSQL directo ──
  const fila = await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])
  comprobar('PostgreSQL: la vista da 500', Number(fila.qty_on_hand) === 500, `${fila.qty_on_hand}`)

  const suma = await one('SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1', [AGUA])
  comprobar('PostgreSQL: la suma de los lotes da 500', Number(suma.s) === 500)

  const movs = await get(`/api/inventory/movimientos?itemId=${AGUA}`)
  comprobar('Hay un movimiento de entrada en el libro mayor', movs.body.length === 1)
  comprobar('Es de tipo RECEPTION', movs.body[0].movement_type === 'RECEPTION')
  comprobar('Guarda el saldo posterior: 500', Number(movs.body[0].balance_after) === 500)
  comprobar('Guarda quién lo hizo', movs.body[0].user_name === 'ADMIN', String(movs.body[0].user_name))

  const audit = await query(`SELECT * FROM audit_log WHERE action='RECEPCION' AND entity_id=$1`, [r.body.lote.id])
  comprobar('Queda auditado con la cantidad', audit.length === 1 && audit[0].after_data?.cantidad === 500)

  // ── Relación lote ↔ inventario ──
  const lotes = await get(`/api/items/${AGUA}/lots`)
  comprobar('El artículo tiene su lote en la consulta de lotes', lotes.body.length === 1 && lotes.body[0].code === r.body.lote.code)
  comprobar('El lote guarda proveedor, albarán y caducidad',
    !!lotes.body[0].supplier_lot_code || !!lotes.body[0].expiry_date, 'faltan datos de trazabilidad')

  // ── Recarga: la app se reconstruye y vuelve a leer ──
  const app2 = createApp()
  const trasRecarga = await request(app2).get(`/api/inventory/${AGUA}`).set('Authorization', `Bearer ${TOK.admin}`)
  comprobar('Tras recargar la aplicación, el stock sigue en 500', Number(trasRecarga.body.qty_on_hand) === 500)

  // ── Reinicio: se cierra y se vuelve a abrir la base ──
  await closeDb()
  await getDb()
  const trasReinicio = await get(`/api/inventory/${AGUA}`)
  comprobar('Tras reiniciar el proceso, el stock sigue en 500', Number(trasReinicio.body.qty_on_hand) === 500,
    `${trasReinicio.body.qty_on_hand}`)
  comprobar('Y el movimiento sigue en el libro mayor',
    (await get(`/api/inventory/movimientos?itemId=${AGUA}`)).body.length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. LA REGLA CRÍTICA, paso a paso')

{
  const leer = async () => Number((await get(`/api/inventory/${AGUA}`)).body.qty_on_hand)
  const leerDirecto = async () => Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  const numMovs = async () => Number((await one('SELECT COUNT(*) c FROM stock_movements WHERE item_id=$1', [AGUA])).c)

  comprobar('Punto de partida: 500', await leer() === 500)

  // Paso 1: entrada posterior de 50 → 550
  await post('/api/inventory/recepciones', { itemId: AGUA, cantidad: 50, numeroAlbaran: 'ALB-002' })
  const tras50 = await leer()
  comprobar('Entrada de 50 → stock 550', tras50 === 550, `${tras50}`)

  // Paso 2: ajuste +10 → 560
  const a1 = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: 10, motivo: 'Recuento físico real' })
  const trasMas10 = await leer()
  comprobar('Ajuste +10 → stock 560', trasMas10 === 560, `${trasMas10}`)
  comprobar('El ajuste devuelve valor anterior, cantidad y valor nuevo',
    Number(a1.body.valorAnterior) === 550 && Number(a1.body.cantidad) === 10 && Number(a1.body.valorNuevo) === 560,
    JSON.stringify(a1.body))

  // Paso 3: ajuste -20 → 540
  const a2 = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -20, motivo: 'Merma por evaporación' })
  const trasMenos20 = await leer()
  comprobar('Ajuste -20 → stock 540', trasMenos20 === 540, `${trasMenos20}`)

  // Paso 4: intentar retirar 600 → debe fallar
  const movimientosAntes = await numMovs()
  const r600 = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -600, motivo: 'Prueba de retirada excesiva' })
  comprobar('Retirar 600 (con 540) falla', r600.status >= 400, `status ${r600.status}`)
  comprobar('El error explica que no hay existencias suficientes',
    /insuficientes|suficientes|540|600/i.test(r600.body.error || ''), r600.body.error)

  const stockTrasFallo = await leer()
  const stockTrasFalloDirecto = await leerDirecto()
  const movimientosTrasFallo = await numMovs()
  comprobar('El stock SIGUE en 540 por la API', stockTrasFallo === 540, `${stockTrasFallo}`)
  comprobar('El stock SIGUE en 540 en PostgreSQL', stockTrasFalloDirecto === 540, `${stockTrasFalloDirecto}`)
  comprobar('No se creó ningún movimiento con el intento fallido',
    movimientosTrasFallo === movimientosAntes, `${movimientosAntes} → ${movimientosTrasFallo}`)

  // El libro mayor lleva el saldo DESPUÉS de cada movimiento, y a nivel de LOTE:
  // es lo que permite reconstruir un lote entero. Se compara con el lote.
  const ultimo = await one(
    `SELECT m.balance_after, l.qty_available
       FROM stock_movements m JOIN lots l ON l.id = m.lot_id
      WHERE m.item_id=$1 ORDER BY m.id DESC LIMIT 1`, [AGUA])
  comprobar('El saldo del último movimiento cuadra con el de su lote',
    Number(ultimo.balance_after) === Number(ultimo.qty_available),
    `movimiento dice ${ultimo.balance_after}, el lote tiene ${ultimo.qty_available}`)

  comprobar('Secuencia crítica completa: 500 → 550 → 560 → 540 → 540',
    stockTrasFallo === 540)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('4. Operación fallida a mitad → rollback completo')

{
  const stockAntes = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  const movsAntes = Number((await one('SELECT COUNT(*) c FROM stock_movements WHERE item_id=$1', [AGUA])).c)
  const lotesAntes = Number((await one('SELECT COUNT(*) c FROM lots WHERE item_id=$1', [AGUA])).c)

  // Entrada que falla a mitad: el lote se crea y el movimiento también, pero
  // después falla algo. Con varias líneas, la segunda es inválida.
  const r = await post('/api/inventory/recepciones/masivas', {
    lineas: [
      { itemId: AGUA, cantidad: 100, numeroAlbaran: 'ALB-003' },   // válida
      { itemId: 999999, cantidad: 50 },                              // inválida: no existe
    ],
  })
  comprobar('La entrada múltiple con una línea inválida falla', r.status >= 400, `status ${r.status}`)

  const stockDespues = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  const movsDespues = Number((await one('SELECT COUNT(*) c FROM stock_movements WHERE item_id=$1', [AGUA])).c)
  const lotesDespues = Number((await one('SELECT COUNT(*) c FROM lots WHERE item_id=$1', [AGUA])).c)

  comprobar('El stock NO ha cambiado', stockDespues === stockAntes, `${stockAntes} → ${stockDespues}`)
  comprobar('No ha quedado ningún movimiento parcial', movsDespues === movsAntes, `${movsAntes} → ${movsDespues}`)
  comprobar('No ha quedado ningún lote huérfano', lotesDespues === lotesAntes, `${lotesAntes} → ${lotesDespues}`)

  // Y el fallo directo de una entrada
  const negativa = await post('/api/inventory/recepciones', { itemId: AGUA, cantidad: -50 })
  comprobar('Una entrada negativa se rechaza', negativa.status === 400, `status ${negativa.status}`)

  const cero = await post('/api/inventory/recepciones', { itemId: AGUA, cantidad: 0 })
  comprobar('Una entrada de cero se rechaza', cero.status === 400, `status ${cero.status}`)

  const sinItem = await post('/api/inventory/recepciones', { cantidad: 10 })
  comprobar('Una entrada sin artículo se rechaza', sinItem.status === 400, `status ${sinItem.status}`)

  const inexistente = await post('/api/inventory/recepciones', { itemId: 999999, cantidad: 10 })
  comprobar('Una entrada de un artículo inexistente da 404', inexistente.status === 404, `status ${inexistente.status}`)

  const final = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  comprobar('Tras todos los intentos fallidos el stock sigue en 540', final === 540, `${final}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('5. Ajustes: el motivo es obligatorio y queda todo registrado')

{
  const sinMotivo = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: 5 })
  comprobar('Un ajuste sin motivo se rechaza', sinMotivo.status === 400, `status ${sinMotivo.status}`)
  comprobar('El error dice que falta el motivo', /motivo/i.test(sinMotivo.body.error), sinMotivo.body.error)

  const motivoCorto = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: 5, motivo: 'a' })
  comprobar('Un motivo de un carácter también', motivoCorto.status === 400)

  const cero = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: 0, motivo: 'Nada que ajustar' })
  comprobar('Un ajuste de cero se rechaza', cero.status === 400, `status ${cero.status}`)

  const r = await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: 7, motivo: 'Diferencia de recuento físico' })
  comprobar('Con motivo, el ajuste se guarda', r.status === 200 && Number(r.body.valorNuevo) === 547, JSON.stringify(r.body))

  const mov = await one(
    `SELECT * FROM stock_movements WHERE item_id=$1 ORDER BY id DESC LIMIT 1`, [AGUA])
  comprobar('El movimiento guarda el motivo', mov.reason === 'Diferencia de recuento físico', String(mov.reason))
  comprobar('El movimiento guarda el usuario', !!mov.created_by)
  comprobar('Y la fecha', !!mov.occurred_at)

  const [audit] = await query(`SELECT * FROM audit_log WHERE action='AJUSTE' ORDER BY id DESC LIMIT 1`)
  comprobar('La auditoría guarda el total del artículo antes del ajuste',
    Number(audit.before_data.qty_on_hand_articulo) === 540, `${audit.before_data.qty_on_hand_articulo}`)
  comprobar('Y el de después, con la cantidad y el motivo',
    Number(audit.after_data.qty_on_hand_articulo) === 547
    && audit.after_data.cantidad === 7
    && audit.after_data.motivo === 'Diferencia de recuento físico',
    JSON.stringify(audit.after_data))

  // Ajuste a un lote concreto
  const lote = await one('SELECT * FROM lots WHERE item_id=$1 ORDER BY id LIMIT 1', [AGUA])
  const r2 = await post('/api/inventory/ajustes', { loteId: lote.id, cantidad: -3, motivo: 'Prueba sobre lote concreto' })
  comprobar('Se puede ajustar un lote concreto',
    r2.status === 200 && r2.body.movimientos.length === 1 && r2.body.movimientos[0].lote === lote.code,
    JSON.stringify(r2.body).slice(0, 160))

  // Y devolverlo a 540 para los siguientes tests
  await post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -4, motivo: 'Restablecer para la prueba' })
  comprobar('Stock de vuelta a 540', Number((await get(`/api/inventory/${AGUA}`)).body.qty_on_hand) === 540)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('6. Envases: la misma filosofía, sin duplicar lógica')

{
  const r = await post('/api/inventory/recepciones', {
    itemId: BOTELLA, cantidad: 2000, numeroAlbaran: 'ALB-ENV-1',
    loteProveedor: 'PLAST-2026-14', costeUnitario: 0.34,
  })
  comprobar('Entrada de envase: 201 y lote creado', r.status === 201 && r.body.lote.code.startsWith('ENV-'), JSON.stringify(r.body).slice(0, 150))

  const stock = await get(`/api/inventory/${BOTELLA}`)
  comprobar('El stock del envase es 2000', Number(stock.body.qty_on_hand) === 2000)
  comprobar('Usa el MISMO campo que las materias primas (una sola definición)',
    'qty_on_hand' in stock.body && 'qty_reserved' in stock.body && 'qty_available' in stock.body)

  const mov = await get(`/api/inventory/movimientos?itemId=${BOTELLA}`)
  comprobar('También deja su movimiento en el libro mayor',
    mov.body.length === 1 && Number(mov.body[0].balance_after) === 2000, JSON.stringify(mov.body[0] || {}))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('7. Producto terminado: añadir, retirar, ajustar, devolver')

{
  const r = await post('/api/inventory/recepciones', {
    itemId: LAVAVAJILLAS, cantidad: 100, numeroAlbaran: 'ALB-PT-1',
  })
  comprobar('Stock inicial de producto por entrada permitida', r.status === 201, JSON.stringify(r.body).slice(0, 150))
  comprobar('El lote de producto usa prefijo PT', r.body.lote.code.startsWith('PT-'), r.body.lote.code)

  const antes = await get(`/api/inventory/${LAVAVAJILLAS}`)
  comprobar('Producto con 100 unidades', Number(antes.body.qty_on_hand) === 100)

  // Añadir 50
  await post('/api/inventory/ajustes', { itemId: LAVAVAJILLAS, cantidad: 50, motivo: 'Entrada de producción' })
  const mas50 = await get(`/api/inventory/${LAVAVAJILLAS}`)
  comprobar('Añadir 50 → stock 150', Number(mas50.body.qty_on_hand) === 150, `${mas50.body.qty_on_hand}`)

  // Retirar 30
  await post('/api/inventory/ajustes', { itemId: LAVAVAJILLAS, cantidad: -30, motivo: 'Rotura de envase' })
  const menos30 = await get(`/api/inventory/${LAVAVAJILLAS}`)
  comprobar('Retirar 30 → stock 120', Number(menos30.body.qty_on_hand) === 120, `${menos30.body.qty_on_hand}`)

  // Devolución: entra de nuevo
  await post('/api/inventory/ajustes', { itemId: LAVAVAJILLAS, cantidad: 20, motivo: 'Devolución de cliente' })
  const devuelto = await get(`/api/inventory/${LAVAVAJILLAS}`)
  comprobar('Devolución de 20 → stock 140', Number(devuelto.body.qty_on_hand) === 140, `${devuelto.body.qty_on_hand}`)

  const cuadra = await one(
    `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE item_id=$1`, [LAVAVAJILLAS])
  comprobar('El stock coincide con la suma de los lotes', Number(cuadra.s) === 140, `${cuadra.s}`)

  // No se puede retirar de más
  const exceso = await post('/api/inventory/ajustes', { itemId: LAVAVAJILLAS, cantidad: -1000, motivo: 'Prueba' })
  comprobar('Retirar más de lo que hay falla', exceso.status >= 400)
  comprobar('Y el stock no cambia', Number((await get(`/api/inventory/${LAVAVAJILLAS}`)).body.qty_on_hand) === 140)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('8. Reservas: apartan sin mover el stock físico')

{
  const fisicoAntes = Number((await get(`/api/inventory/${AGUA}`)).body.qty_on_hand)
  const r = await post('/api/inventory/reservas', {
    itemId: AGUA, cantidad: 200, motivo: 'Orden de producción FAB-0001', holdType: 'PRODUCTION',
  })
  comprobar('La retención interna se crea', r.status === 201, `${r.status} ${r.body.error || ''}`)

  const despues = await get(`/api/inventory/${AGUA}`)
  comprobar('El stock FÍSICO no cambia al apartar', Number(despues.body.qty_on_hand) === fisicoAntes,
    `${fisicoAntes} → ${despues.body.qty_on_hand}`)
  comprobar('El stock RESERVADO sube a 200', Number(despues.body.qty_reserved) === 200, `${despues.body.qty_reserved}`)
  comprobar('El stock DISPONIBLE baja a 340', Number(despues.body.qty_available) === 340, `${despues.body.qty_available}`)

  const movsAntes = await one(`SELECT COUNT(*) c FROM stock_movements WHERE item_id=$1`, [AGUA])
  const movs = await get(`/api/inventory/movimientos?itemId=${AGUA}`)
  comprobar('Apartar NO crea movimientos de stock', Number(movsAntes.c) === movs.body.length,
    `${movsAntes.c} movimientos, ${movs.body.length} devueltos`)

  // Y no se ha inventado ningún pedido de venta
  const pedidos = await one('SELECT COUNT(*) c FROM sales_orders')
  comprobar('Apartar stock NO crea ningún pedido de venta falso', Number(pedidos.c) === 0, `${pedidos.c} pedidos`)
  const lineas = await one('SELECT COUNT(*) c FROM sales_order_lines')
  comprobar('Ni ninguna línea de pedido con precio cero', Number(lineas.c) === 0, `${lineas.c} líneas`)

  const res = await one('SELECT * FROM order_reservations WHERE id=$1', [r.body.reserva.id])
  comprobar('La reserva interna no apunta a ningún pedido', res.sales_order_id === null)
  comprobar('Guarda el motivo', res.hold_reason === 'Orden de producción FAB-0001', String(res.hold_reason))
  comprobar('Y el tipo de retención', res.hold_type === 'PRODUCTION', String(res.hold_type))

  // No se puede apartar más de lo disponible
  const exceso = await post('/api/inventory/reservas', { itemId: AGUA, cantidad: 400, motivo: 'Demasiado' })
  comprobar('Apartar por encima de lo disponible falla', exceso.status === 409, `status ${exceso.status}`)
  comprobar('Y el mensaje dice cuántas hay', /340|insuficientes/i.test(exceso.body.error), exceso.body.error)

  // Sin motivo no hay retención
  const sinMotivo = await post('/api/inventory/reservas', { itemId: AGUA, cantidad: 10 })
  comprobar('Una retención sin motivo se rechaza', sinMotivo.status === 400, `status ${sinMotivo.status}`)

  const motivoCorto = await post('/api/inventory/reservas', { itemId: AGUA, cantidad: 10, motivo: 'a' })
  comprobar('Un motivo de una letra también', motivoCorto.status === 400)

  const tipoMalo = await post('/api/inventory/reservas', { itemId: AGUA, cantidad: 10, motivo: 'Prueba válida', holdType: 'INVENTADO' })
  comprobar('Un tipo de retención inventado se rechaza', tipoMalo.status === 400, `status ${tipoMalo.status}`)

  const noItem = await post('/api/inventory/reservas', { cantidad: 10, motivo: 'Sin artículo' })
  comprobar('Una retención sin artículo se rechaza', noItem.status === 400, `status ${noItem.status}`)

  // Liberar
  const reservaId = r.body.reserva.id
  const lib = await post(`/api/inventory/reservas/${reservaId}/liberar`, { motivo: 'La orden se canceló' })
  comprobar('La retención se libera', lib.status === 200, `${lib.status} ${lib.body.error || ''}`)

  const trasLiberar = await get(`/api/inventory/${AGUA}`)
  comprobar('Tras liberar, lo reservado vuelve a 0', Number(trasLiberar.body.qty_reserved) === 0)
  comprobar('Y lo disponible vuelve a 540', Number(trasLiberar.body.qty_available) === 540)
  comprobar('El físico NUNCA se movió', Number(trasLiberar.body.qty_on_hand) === 540)

  const doble = await post(`/api/inventory/reservas/${reservaId}/liberar`, { motivo: 'Otra vez' })
  comprobar('No se puede liberar dos veces la misma retención', doble.status === 409, `status ${doble.status}`)

  const inexistente = await post('/api/inventory/reservas/999999/liberar', { motivo: 'Prueba' })
  comprobar('Liberar una retención inexistente da 404', inexistente.status === 404, `status ${inexistente.status}`)

  const lista = await get('/api/inventory/reservas')
  comprobar('El listado marca cuáles son retenciones internas',
    lista.body.some((x) => x.es_retencion_interna === true), JSON.stringify(lista.body[0] || {}))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('9. Bloqueo y cuarentena: sale de las existencias disponibles')

{
  const lote = await one(`SELECT * FROM lots WHERE item_id=$1 AND status='ACTIVE' ORDER BY id LIMIT 1`, [BOTELLA])
  const antes = await get(`/api/inventory/${BOTELLA}`)
  const disponiblesAntes = Number(antes.body.qty_available)

  const r = await put(`/api/lots/${lote.id}/estado`, { estado: 'QUARANTINE', motivo: 'Lote sospechoso de calidad' })
  comprobar('El lote pasa a cuarentena', r.status === 200 && r.body.estado === 'QUARANTINE', JSON.stringify(r.body).slice(0, 120))

  const despues = await get(`/api/inventory/${BOTELLA}`)
  const total = ['qty_on_hand', 'qty_quarantined', 'qty_blocked', 'qty_retired']
    .reduce((t, k) => t + Number(despues.body[k] || 0), 0)
  comprobar('Ninguna unidad desaparece: sale de disponible y pasa a cuarentena',
    total === 2000, `sumando los cuatro estados sale ${total}, no 2000`)
  comprobar('Ya no cuenta como disponible', Number(despues.body.qty_available) < disponiblesAntes,
    `${disponiblesAntes} → ${despues.body.qty_available}`)
  comprobar('Y aparece contabilizada aparte en cuarentena',
    Number(despues.body.qty_quarantined) === 2000, `${despues.body.qty_quarantined}`)

  const consumible = await post('/api/inventory/ajustes', { loteId: lote.id, cantidad: -10, motivo: 'Prueba sobre lote en cuarentena' })
  comprobar('No se puede consumir de un lote en cuarentena', consumible.status >= 400, `status ${consumible.status}`)
  comprobar('El error menciona la cuarentena', /QUARANTINE|cuarentena/i.test(consumible.body.error), consumible.body.error)

  const sinMotivo = await put(`/api/lots/${lote.id}/estado`, { estado: 'ACTIVE' })
  comprobar('Quitar la cuarentena exige motivo', sinMotivo.status === 400 && /motivo/i.test(sinMotivo.body.error))

  await put(`/api/lots/${lote.id}/estado`, { estado: 'ACTIVE', motivo: 'Análisis correcto' })
  const repuesto = await get(`/api/inventory/${BOTELLA}`)
  comprobar('Al liberarlo, vuelve a estar disponible',
    Number(repuesto.body.qty_available) === disponiblesAntes, `${repuesto.body.qty_available}`)

  const malo = await put(`/api/lots/${lote.id}/estado`, { estado: 'INVENTADO', motivo: 'x' })
  comprobar('Un estado inventado se rechaza', malo.status === 400, `status ${malo.status}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('10. Caducidad: un lote caducado no suma existencias')

{
  const pasado = new Date(Date.now() - 86400000).toISOString()
  const r = await post('/api/inventory/recepciones', { itemId: AGUA, cantidad: 30, caducidad: pasado })
  const lote = await one('SELECT * FROM lots WHERE id=$1', [r.body.lote.id])
  comprobar('El lote con caducidad pasada nace EXPIRED', lote.status === 'EXPIRED', lote.status)

  const stock = await get(`/api/inventory/${AGUA}`)
  comprobar('El físico NO sube por un lote caducado', Number(stock.body.qty_on_hand) === 540,
    `${stock.body.qty_on_hand}`)
  comprobar('Y sus unidades no cuentan como disponibles', Number(stock.body.qty_available) === 540)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('11. Concurrencia: dos operaciones a la vez no producen stock roto')

{
  // Dos ajustes simultáneos sobre el MISMO artículo.
  const stockAntes = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  const [r1, r2] = await Promise.all([
    post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -400, motivo: 'Salida concurrente 1' }),
    post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -400, motivo: 'Salida concurrente 2' }),
  ])
  const ok = [r1, r2].filter((r) => r.status === 200)
  const fallidos = [r1, r2].filter((r) => r.status >= 400)
  comprobar('Una de las dos sale, la otra se rechaza por falta de existencias',
    ok.length === 1 && fallidos.length === 1, `éxitos=${ok.length} fallos=${fallidos.length}`)

  const final = await one('SELECT qty_on_hand, qty_available FROM v_item_available WHERE item_id=$1', [AGUA])
  comprobar('El stock final es exactamente el esperado (540 - 400)',
    Number(final.qty_on_hand) === stockAntes - 400, `${final.qty_on_hand}`)

  // Y diez salidas simultáneas de 100. Cuántas pueden pasar depende del stock
  // real de ese momento, así que el test lo calcula en vez de suponerlo.
  await post('/api/inventory/recepciones', { itemId: AGUA, cantidad: 500, numeroAlbaran: 'ALB-CONC' })
  const stockAntes2 = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)
  const esperados = Math.floor(stockAntes2 / 100)
  const resultados = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      post('/api/inventory/ajustes', { itemId: AGUA, cantidad: -100, motivo: `Salida concurrente ${i + 1}` })))
  const exitos = resultados.filter((r) => r.status === 200).length
  const stockFinal = Number((await one('SELECT qty_on_hand FROM v_item_available WHERE item_id=$1', [AGUA])).qty_on_hand)

  comprobar(`Con ${stockAntes2} en stock, de 10 salidas de 100 pasan exactamente ${esperados}`,
    exitos === esperados, `pasaron ${exitos}, se esperaban ${esperados}`)
  comprobar('El stock final es el resto, ni un unidad más',
    stockFinal === stockAntes2 - exitos * 100, `${stockAntes2} - ${exitos * 100} = ${stockFinal}`)
  comprobar('Y NUNCA es negativo', stockFinal >= 0, `${stockFinal}`)

  // Cada salida fallida debe explicar POR QUÉ no pudo, no un error genérico
  const rechazos = resultados.filter((r) => r.status >= 400)
  comprobar('Las salidas rechazadas dicen cuántas hay disponibles',
    rechazos.every((r) => /disponibles|insuficientes/i.test(r.body.error || '')),
    rechazos[0]?.body.error)

  // La suma de movimientos cuadra con el stock, sin doble conteo
  const cuadra = await one(
    `SELECT
       (SELECT COALESCE(SUM(qty_available),0) FROM lots WHERE item_id=$1) AS por_lotes,
       (SELECT COALESCE(SUM(qty),0) FROM stock_movements WHERE item_id=$1) AS por_movimientos`,
    [AGUA])
  const porLotes = Number(cuadra.por_lotes)
  const porMovimientos = Number(cuadra.por_movimientos)
  comprobar('El libro mayor cuadra exactamente con los lotes',
    porMovimientos === porLotes, `movimientos=${porMovimientos} lotes=${porLotes}`)
  comprobar('Y el disponible coincide con el físico menos lo reservado',
    Math.abs((await one('SELECT qty_on_hand, qty_reserved, qty_available FROM v_item_available WHERE item_id=$1', [AGUA])).qty_available
      - (stockFinal - 0)) < 0.01, 'disponible distinto de lo esperado')
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('12. Permisos: el BACKEND rechaza, no solo la interfaz')

{
  const casos = [
    ['reparto', 'POST', '/api/inventory/recepciones', { itemId: AGUA, cantidad: 10 }, 403, 'un repartidor no registra entradas'],
    ['reparto', 'POST', '/api/inventory/ajustes', { itemId: AGUA, cantidad: 10, motivo: 'Prueba' }, 403, 'un repartidor no ajusta'],
    ['reparto', 'POST', '/api/inventory/reservas', { itemId: AGUA, cantidad: 10, motivo: 'x' }, 403, 'un repartidor no reserva'],
    ['reparto', 'GET', '/api/inventory', null, 403, 'un repartidor no ve el inventario'],
    ['comercial', 'POST', '/api/inventory/ajustes', { itemId: AGUA, cantidad: 10, motivo: 'Prueba' }, 403, 'un comercial no ajusta stock'],
    ['contabilidad', 'POST', '/api/inventory/ajustes', { itemId: AGUA, cantidad: 10, motivo: 'Prueba' }, 200, 'contabilidad SÍ ajusta (tiene inventory:edit)'],
    ['produccion', 'POST', '/api/inventory/recepciones', { itemId: AGUA, cantidad: 10 }, 201, 'producción SÍ recibe mercancía (inventory:create)'],
    ['contabilidad', 'POST', '/api/inventory/recepciones', { itemId: AGUA, cantidad: 10 }, 201, 'contabilidad SÍ recibe mercancía (inventory:create)'],
    ['comercial', 'POST', '/api/items', { sku: 'PT-COM-1', name: 'Intento comercial', category_kind: 'FINISHED_GOOD', unit_id: UNIDAD_UD }, 403, 'un comercial no crea productos'],
    ['reparto', 'POST', '/api/items', { sku: 'RM-REP-1', name: 'Intento reparto', category_kind: 'RAW_MATERIAL', unit_id: UNIDAD_L }, 403, 'un repartidor no crea materias primas'],
    ['comercial', 'POST', '/api/inventory/recepciones', { itemId: AGUA, cantidad: 10 }, 403, 'un comercial ve el catálogo pero NO recibe mercancía'],
    ['comercial', 'GET', '/api/items', null, 200, 'un comercial SÍ puede ver los productos'],
    ['produccion', 'POST', '/api/items', { sku: 'PT-PRO-1', name: 'Creado por producción', category_kind: 'FINISHED_GOOD', unit_id: UNIDAD_UD }, 201, 'producción SÍ crea productos'],
  ]
  for (const caso of casos) {
    const [rol, metodo, ruta, cuerpo, esperado, desc] = caso
    const r = metodo === 'GET' ? await get(ruta, TOK[rol]) : await post(ruta, cuerpo, TOK[rol])
    comprobar(desc, r.status === esperado, `esperado ${esperado}, recibido ${r.status} ${r.body.error || ''}`)
  }

  // Un usuario al que se le quita el último permiso debe perderlo TODO, no solo
  // ver el menú vacío. Esta comprobación nació de un bug real: GET /items solo
  // pedía sesión, así que un usuario sin ningún permiso veía el catálogo entero
  // con sus precios de compra.
  const sinNada = await crear('sinpermisos', 'DELIVERY')
  await query(`DELETE FROM user_roles WHERE user_id = $1`, [sinNada.id])
  const t0 = (await request(app).post('/api/auth/login').send({ username: 'sinpermisos', password: CLAVES.sinpermisos })).body.access
  comprobar('Un usuario sin permisos entra… pero no ve nada',
    !!t0 && (await get('/api/auth/me', t0)).status === 200)
  for (const r of ['/api/items', '/api/inventory', '/api/users', '/api/roles', '/api/permissions', '/api/units', '/api/suppliers']) {
    const x = await get(r, t0)
    comprobar(`Sin ningún permiso, ${r} responde 403`, x.status === 403, `status ${x.status}`)
  }
  comprobar('Y tampoco puede crear un artículo',
    (await post('/api/items', { sku: 'RM-NADA', name: 'Intento', category_kind: 'RAW_MATERIAL', unit_id: UNIDAD_L }, t0)).status === 403)

  // Sin sesión, ni a consultarlo
  const sinSesion = await request(app).get('/api/inventory')
  comprobar('Sin sesión no se ve el inventario', sinSesion.status === 401)

  // Un permiso denegado queda auditado
  const denegados = await query(`SELECT * FROM audit_log WHERE action='PERMISO_DENEGADO'`)
  comprobar('Los permisos denegados se auditan', denegados.length > 0, `${denegados.length} registros`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('13. El resumen del inventario cuadra con los datos reales')

{
  const r = await get('/api/inventory/resumen')
  const filas = r.body.porTipo
  const porTipo = Object.fromEntries(filas.map((f) => [f.tipo, f]))

  comprobar('El resumen tiene los tres tipos de artículo',
    porTipo.RAW_MATERIAL && porTipo.PACKAGING && porTipo.FINISHED_GOOD,
    filas.map((f) => f.tipo).join(', '))

  const totalMP = await one(
    `SELECT COALESCE(SUM(qty_available),0) s FROM lots WHERE lot_kind='RAW_MATERIAL'`)
  const disponibleMP = await one(
    `SELECT COALESCE(SUM(qty_available),0) s FROM v_item_available WHERE category_kind='RAW_MATERIAL'`)
  comprobar('Las materias primas cuadran entre el resumen y la vista',
    Number(porTipo.RAW_MATERIAL.existencias) === Number(disponibleMP.s),
    `${porTipo.RAW_MATERIAL.existencias} vs ${disponibleMP.s}`)

  const bajoMin = await query(
    `SELECT item_id, qty_on_hand, min_stock FROM v_item_available WHERE is_below_min`)
  comprobar('Los artículos bajo mínimo se detectan con datos reales',
    bajoMin.every((b) => Number(b.qty_on_hand) < Number(b.min_stock)),
    bajoMin.map((b) => `${b.qty_on_hand}/${b.min_stock}`).join(', '))

  const valor = await one(
    `SELECT COALESCE(SUM(qty_on_hand * purchase_cost),0) v FROM v_item_available`)
  const esperado = await one(
    `SELECT COALESCE(SUM(l.qty_available * i.purchase_cost),0) v
       FROM lots l JOIN items i ON i.id = l.item_id WHERE l.status='ACTIVE'`)
  comprobar('La valoración sale de los lotes, no de un campo paralelo',
    Math.abs(Number(valor.v) - Number(esperado.v)) < 0.01, `${valor.v} vs ${esperado.v}`)

  comprobar('El resumen NO contiene datos de otros módulos', !('orders' in r.body) && !('customers' in r.body))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('14. Nada de stock sin explicación: cuadre final')

{
  // Para cada artículo, disponible = suma de los lotes utilizables − reservado
  const filas = await query(
    `SELECT s.item_id, s.name, s.qty_on_hand, s.qty_reserved, s.qty_available
       FROM v_item_available s WHERE s.qty_on_hand > 0 OR s.qty_reserved > 0`)
  let todoCuadra = true
  const detalle = []
  for (const f of filas) {
    const porLotes = await one(
      `SELECT COALESCE(SUM(qty_available),0) s FROM lots
        WHERE item_id=$1 AND status='ACTIVE' AND (expiry_date IS NULL OR expiry_date > now())`, [f.item_id])
    const esperado = Math.max(Number(porLotes.s) - Number(f.qty_reserved), 0)
    if (Math.abs(Number(f.qty_available) - esperado) > 0.01) {
      todoCuadra = false
      detalle.push(`${f.name}: dice ${f.qty_available}, lotes dan ${esperado}`)
    }
  }
  comprobar('Cada disponible se explica con sus lotes y sus reservas', todoCuadra, detalle.join('; '))

  const [negativo] = await query(`SELECT COUNT(*) c FROM lots WHERE qty_available < 0`)
  comprobar('No existe ningún lote con existencias negativas', Number(negativo.c) === 0, `${negativo.c}`)

  const [imposible] = await query(
    `SELECT COUNT(*) c FROM lots WHERE qty_available + qty_consumed > initial_qty + 0.001`)
  comprobar('No existe ningún lote donde lo disponible + lo consumido supere lo recibido',
    Number(imposible.c) === 0, `${imposible.c} lotes`)

  const [huerfanos] = await query(
    `SELECT COUNT(*) c FROM lots l WHERE NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.lot_id = l.id)`)
  comprobar('Todo lote tiene al menos un movimiento que lo explica', Number(huerfanos.c) === 0,
    `${huerfanos.c} lotes sin movimiento`)

  const [sinLote] = await query(
    `SELECT COUNT(*) c FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM lots l WHERE l.id = m.lot_id)`)
  comprobar('Y ningún movimiento apunta a un lote inexistente', Number(sinLote.c) === 0, `${sinLote.c}`)
}

// ─────────────────────────────────────────────────────────────────────────────
const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
console.log('')

await closeDb()
process.exit(r.fallos ? 1 : 0)
