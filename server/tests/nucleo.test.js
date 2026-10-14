/**
 * Pruebas de las reglas de negocio.
 *
 * Cada comprobación es contra PostgreSQL real, con las migraciones aplicadas.
 * No hay mocks, no hay "debería funcionar": o el SQL hace lo que dice o falla.
 *
 * Estas pruebas cubren exactamente los fallos que hicieron inservible el
 * sistema anterior.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-fase-0-suficientemente-larga-1234567890'

const { baseDePrueba, comprobar, seccion, resumen, query, one, transaction,
        crearUsuario, crearItem } = await import('./banco.js')
const { moverStock, crearLoteConEntrada, planificarFefo, ErrorDeStock } =
  await import('../src/core/stock.js')

// Los errores de PGlite vienen con un volcado de pila gigante que tapa el
// resultado. Se deja solo el mensaje, que es lo que importa.
process.on('unhandledRejection', (e) => {
  console.error('\nERROR:', e?.message || String(e))
  process.exit(1)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · FASE 0 · PRUEBAS DEL NÚCLEO')
console.log('══════════════════════════════════════════════════════════════')

// El cliente de base de datos usa PGlite cuando no hay DATABASE_URL, así que
// basta con pedir una base limpia. No hay mocks: es PostgreSQL de verdad.
await baseDePrueba()

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. Estructura del catálogo: un solo maestro, sin columna de stock')

{
  const info = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'items' AND column_name IN ('stock','qty','quantity','existencia')`,
  )
  comprobar('La tabla items NO tiene columna de stock', info.length === 0,
    `encontradas: ${info.map((c) => c.column_name).join(', ')}`)

  const cats = await query('SELECT DISTINCT category_kind FROM items')
  comprobar('items admite los tres tipos de artículo',
    cats.length === 0 || cats.every((c) => ['RAW_MATERIAL', 'PACKAGING', 'FINISHED_GOOD'].includes(c.category_kind)))

  const tablasViejas = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('raw_materials','packaging','products','raw_material_lots','packaging_lots')`,
  )
  comprobar('No existen las tres tablas con stock del sistema anterior',
    tablasViejas.length === 0, `encontradas: ${tablasViejas.map((t) => t.table_name).join(', ')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. Libro mayor: el stock solo cambia por una función')

{
  const agua = await crearItem({ sku: 'RM-AGUA', name: 'Agua desionizada', kind: 'RAW_MATERIAL', minStock: 500, cost: 0.1 })
  const lote = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-0001', itemId: agua.id, lotKind: 'RAW_MATERIAL',
    initialQty: 5000, unitId: agua.unit_id, originType: 'MANUAL_RECEPTION',
  }))

  const s = await one('SELECT * FROM v_item_available WHERE item_id = $1', [agua.id])
  comprobar('Tras la entrada, el stock del artículo es el lote', Number(s.qty_on_hand) === 5000,
    `vi ${s.qty_on_hand}`)
  comprobar('El stock coincide con lo recibido, sin ningún campo duplicado',
    Number(s.qty_on_hand) === Number(s.qty_available) + Number(s.qty_reserved))

  const movs = await query('SELECT * FROM stock_movements WHERE lot_id = $1', [lote.id])
  comprobar('La entrada dejó un movimiento en el libro mayor', movs.length === 1)
  comprobar('El movimiento es de tipo recepción', movs[0].movement_type === 'RECEPTION')
  comprobar('El movimiento guarda el saldo posterior', Number(movs[0].balance_after) === 5000)

  // Consumo
  await transaction((tx) => moverStock(tx, {
    lotId: lote.id, qty: -1250, movimiento: 'PRODUCTION_CONSUMPTION',
    refType: 'PRODUCTION', refId: 1,
  }))
  const s2 = await one('SELECT * FROM v_item_available WHERE item_id = $1', [agua.id])
  comprobar('Tras consumir 1.250 L quedan 3.750', Number(s2.qty_on_hand) === 3750, `vi ${s2.qty_on_hand}`)

  const lote2 = await one('SELECT * FROM lots WHERE id = $1', [lote.id])
  comprobar('El lote guarda lo consumido además de lo disponible',
    Number(lote2.qty_consumed) === 1250 && Number(lote2.qty_available) === 3750)
  comprobar('Disponible + consumido = inicial (nada se pierde ni se inventa)',
    Number(lote2.qty_available) + Number(lote2.qty_consumed) === Number(lote2.initial_qty))

  // Agotar
  await transaction((tx) => moverStock(tx, { lotId: lote.id, qty: -3750, movimiento: 'PRODUCTION_CONSUMPTION', refType: 'PRODUCTION', refId: 2 }))
  const agotado = await one('SELECT * FROM lots WHERE id = $1', [lote.id])
  comprobar('Al llegar a cero el lote pasa a EXHAUSTED solo', agotado.status === 'EXHAUSTED', `estado ${agotado.status}`)

  const hist = await query('SELECT * FROM stock_movements WHERE lot_id=$1 ORDER BY id', [lote.id])
  comprobar('El libro mayor tiene los 3 movimientos', hist.length === 3)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. La base impide consumir de más (no es cortesía, es una restricción)')

{
  const mp = await crearItem({ sku: 'RM-ALCO', name: 'Alcohol', kind: 'RAW_MATERIAL', cost: 4.2 })
  const lote = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-0002', itemId: mp.id, lotKind: 'RAW_MATERIAL',
    initialQty: 100, unitId: mp.unit_id,
  }))

  let fallo = null
  try {
    await transaction((tx) => moverStock(tx, { lotId: lote.id, qty: -150, movimiento: 'PRODUCTION_CONSUMPTION', refType: 'PRODUCTION', refId: 9 }))
  } catch (e) { fallo = e }
  comprobar('Pedir más de lo que hay falla', fallo instanceof ErrorDeStock)
  comprobar('El error dice cuánta hay y cuánta se pide',
    fallo && /Existencias insuficientes/.test(fallo.message) && /100/.test(fallo.message) && /150/.test(fallo.message),
    fallo?.message)

  const despues = await one('SELECT * FROM lots WHERE id = $1', [lote.id])
  comprobar('Tras el fallo el lote sigue intacto (rollback)', Number(despues.qty_available) === 100)

  // Y la propia tabla lo impide, aunque se escriba a mano
  let errorBase = null
  try {
    await query('UPDATE lots SET qty_available = -1 WHERE id = $1', [lote.id])
  } catch (e) { errorBase = e }
  comprobar('Un UPDATE directo a cantidad negativa es rechazado por la base', Boolean(errorBase))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('4. La base se niega a saltarse el libro mayor')

{
  const mp = await crearItem({ sku: 'RM-FRAG', name: 'Fragancia', kind: 'RAW_MATERIAL' })
  const lote = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-0003', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 50, unitId: mp.unit_id,
  }))

  // La garantía de consumo único se apoya en stock_movement_keys
  const clave = 'DELIVERY:1:lot:' + lote.id
  const a = await transaction((tx) => moverStock(tx, {
    lotId: lote.id, qty: -10, movimiento: 'DELIVERY', refType: 'DELIVERY', refId: 1, clave,
  }))
  const b = await transaction((tx) => moverStock(tx, {
    lotId: lote.id, qty: -10, movimiento: 'DELIVERY', refType: 'DELIVERY', refId: 1, clave,
  }))
  comprobar('La primera entrega descuenta', a.duplicado === false && a.balanceAfter === 40)
  comprobar('La segunda entrega con la misma clave NO vuelve a descontar', b.duplicado === true)
  const final = await one('SELECT qty_available FROM lots WHERE id = $1', [lote.id])
  comprobar('El stock se descontó una sola vez (40, no 30)',
    Number(final.qty_available) === 40, `quedó ${final.qty_available}`)

  // Un lote retirado no se puede consumir
  await query(`UPDATE lots SET status='RETIRED', status_reason='Recall', status_changed_at=now() WHERE id=$1`, [lote.id])
  let fallo = null
  try {
    await transaction((tx) => moverStock(tx, { lotId: lote.id, qty: -5, movimiento: 'DELIVERY', refType: 'DELIVERY', refId: 2, clave: 'otra' }))
  } catch (e) { fallo = e }
  comprobar('No se puede servir de un lote RETIRADO', fallo instanceof ErrorDeStock && /RETIRED/.test(fallo.message), fallo?.message)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('5. Un ajuste sin motivo no se guarda')

{
  const mp = await crearItem({ sku: 'RM-COL', name: 'Colorante', kind: 'RAW_MATERIAL' })
  const lote = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-0004', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 20, unitId: mp.unit_id,
  }))

  let fallo = null
  try {
    await transaction((tx) => moverStock(tx, { lotId: lote.id, qty: 5, movimiento: 'ADJUSTMENT_IN', motivo: null }))
  } catch (e) { fallo = e }
  comprobar('Un ajuste sin motivo se rechaza', fallo instanceof ErrorDeStock && /motivo/.test(fallo.message))

  const ok = await transaction((tx) => moverStock(tx, {
    lotId: lote.id, qty: 5, movimiento: 'ADJUSTMENT_IN', motivo: 'Corrección de entrada de proveedor',
  }))
  comprobar('Con motivo, el ajuste se guarda', ok.balanceAfter === 25)

  let errorBase = null
  try {
    await query(`INSERT INTO stock_movements (lot_id,item_id,movement_type,qty,unit_id,balance_after,reason)
                VALUES ($1,$2,'ADJUSTMENT_IN',1,$3,1,NULL)`, [lote.id, mp.id, mp.unit_id])
  } catch (e) { errorBase = e }
  comprobar('Ni siquiera escribiendo a mano se puede insertar un ajuste sin motivo', Boolean(errorBase))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('6. Caducidad: el estado sigue a la fecha, sin Intervention humana')

{
  const mp = await crearItem({ sku: 'RM-CONC', name: 'Concentrado', kind: 'RAW_MATERIAL' })
  const pasado = new Date(Date.now() - 5 * 86400000).toISOString()
  const futuro = new Date(Date.now() + 120 * 86400000).toISOString()

  const caducado = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-CAD', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 10, unitId: mp.unit_id, expiryDate: pasado,
  }))
  comprobar('Un lote con caducidad pasada nace EXPIRED', caducado.status === 'EXPIRED', `estado ${caducado.status}`)

  const s = await one('SELECT * FROM v_item_available WHERE item_id = $1', [mp.id])
  comprobar('Un lote caducado NO suma existencias disponibles', Number(s.qty_on_hand) === 0, `vi ${s.qty_on_hand}`)

  const vivo = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'MP-VIVO', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 30, unitId: mp.unit_id, expiryDate: futuro,
  }))
  comprobar('Un lote vigente sigue ACTIVE', vivo.status === 'ACTIVE')
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('7. FEFO: se usa antes el lote que caduca antes, y se explica por qué')

{
  const mp = await crearItem({ sku: 'RM-FEFO', name: 'Material FEFO', kind: 'RAW_MATERIAL' })
  const d = (dias) => new Date(Date.now() + dias * 86400000).toISOString()

  await transaction((tx) => crearLoteConEntrada(tx, { code: 'F-LATE',  itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 100, unitId: mp.unit_id, expiryDate: d(200) }))
  await transaction((tx) => crearLoteConEntrada(tx, { code: 'F-EARLY', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 60,  unitId: mp.unit_id, expiryDate: d(30) }))
  await transaction((tx) => crearLoteConEntrada(tx, { code: 'F-NONE',  itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 40,  unitId: mp.unit_id, expiryDate: null }))

  const { plan, suficiente } = await planificarFefo(mp.id, 80)
  comprobar('Con 80 unidades el plan es suficiente', suficiente === true)
  comprobar('FEFO elige el lote que caduca antes',
    plan[0].code === 'F-EARLY', `eligió ${plan[0]?.code}`)
  comprobar('El plan explica el motivo de la elección',
    /Caduca/.test(plan[0].motivo), plan[0]?.motivo)
  comprobar('Si no alcanza, pasa al siguiente lote',
    plan.length === 2 && plan[1].code === 'F-LATE', `plan: ${plan.map((p) => p.code).join(' > ')}`)
  comprobar('Sin caducidad es la última opción',
    plan.find((p) => p.code === 'F-NONE') === undefined)

  const corto = await planificarFefo(mp.id, 9999)
  comprobar('Si no hay stock suficiente, lo dice con la cantidad que falta',
    corto.suficiente === false && corto.faltante > 0, `faltan ${corto.faltante}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('8. Permisos fail-closed en el backend')

{
  const { tienePermiso, rolesDe } = await import('../src/security/permisos.js')
  const admin = await crearUsuario('admin_prueba', 'ADMIN')
  const produccion = await crearUsuario('prod_prueba', 'PRODUCTION')
  const reparto = await crearUsuario('reparto_prueba', 'DELIVERY')
  const comercial = await crearUsuario('comercial_prueba', 'COMMERCIAL')

  comprobar('El administrador puede todo', await tienePermiso(admin.id, 'settings', 'delete'))
  comprobar('Producción puede fabricar', await tienePermiso(produccion.id, 'production', 'create'))
  comprobar('Producción NO puede borrar compras', !(await tienePermiso(produccion.id, 'purchases', 'delete')))
  comprobar('Producción NO puede gestionar usuarios', !(await tienePermiso(produccion.id, 'users', 'create')))

  comprobar('Reparto puede registrar entregas', await tienePermiso(reparto.id, 'deliveries', 'create'))
  comprobar('Reparto NO puede fabricar', !(await tienePermiso(reparto.id, 'production', 'create')))
  comprobar('Reparto NO puede tocar recetas', !(await tienePermiso(reparto.id, 'recipes', 'edit')))
  comprobar('Reparto NO puede cambiar inventario', !(await tienePermiso(reparto.id, 'inventory', 'edit')))
  comprobar('Reparto NO puede abrir retiradas', !(await tienePermiso(reparto.id, 'recalls', 'create')))

  comprobar('Comercial puede gestionar clientes', await tienePermiso(comercial.id, 'customers', 'edit'))
  comprobar('Comercial NO puede tocar recetas', !(await tienePermiso(comercial.id, 'recipes', 'edit')))
  comprobar('Comercial NO puede producir', !(await tienePermiso(comercial.id, 'production', 'create')))

  comprobar('Los roles se leen de la base', (await rolesDe(reparto.id)).includes('DELIVERY'))

  // Un usuario sin roles no puede nada: fail-closed
  const { hashPassword } = await import('../src/security/passwords.js')
  const hash = await hashPassword('contrasena-de-prueba-1')
  const huerfano = await one(
    `INSERT INTO users (username, full_name, password_hash) VALUES ('sin_rol','Sin rol',$1) RETURNING *`, [hash])
  comprobar('Un usuario sin roles no puede nada', !(await tienePermiso(huerfano.id, 'dashboard', 'view')))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('9. La auditoría no se puede tocar')

{
  await query(
    `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, outcome)
     VALUES (NULL,'sistema','TEST','prueba','1','SUCCESS')`,
  )
  let falloUpdate = null
  try { await query(`UPDATE audit_log SET action = 'MANIPULADO'`) } catch (e) { falloUpdate = e }
  comprobar('No se puede modificar el registro de auditoría', Boolean(falloUpdate))

  let falloDelete = null
  try { await query(`DELETE FROM audit_log`) } catch (e) { falloDelete = e }
  comprobar('No se puede borrar el registro de auditoría', Boolean(falloDelete))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('10. Una operación fallida no deja nada a medias')

{
  const mp = await crearItem({ sku: 'RM-TX', name: 'Material transaccional', kind: 'RAW_MATERIAL' })
  const lote = await transaction((tx) => crearLoteConEntrada(tx, {
    code: 'TX-0001', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 100, unitId: mp.unit_id,
  }))

  // Se consume parte y luego falla: tiene que revertirse TODO
  let fallo = null
  try {
    await transaction(async (tx) => {
      await moverStock(tx, { lotId: lote.id, qty: -60, movimiento: 'PRODUCTION_CONSUMPTION', refType: 'PRODUCTION', refId: 1 })
      await moverStock(tx, { lotId: lote.id, qty: -9999, movimiento: 'PRODUCTION_CONSUMPTION', refType: 'PRODUCTION', refId: 1 })
    })
  } catch (e) { fallo = e }
  comprobar('La operación falla', Boolean(fallo))

  const despues = await one('SELECT * FROM lots WHERE id = $1', [lote.id])
  comprobar('El lote conserva su cantidad: el primer consumo se revirtió',
    Number(despues.qty_available) === 100, `quedó ${despues.qty_available}`)

  const movs = await query('SELECT * FROM stock_movements WHERE lot_id = $1', [lote.id])
  comprobar('No quedó ningún movimiento del intento fallido', movs.length === 1, `hay ${movs.length}`)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('11. Contadores de lotes: calculados, no inventados')

{
  const mp = await crearItem({ sku: 'RM-CNT', name: 'Material para contadores', kind: 'RAW_MATERIAL' })
  const u = await one('SELECT id FROM units WHERE code = $1', ['L'])
  await transaction((tx) => crearLoteConEntrada(tx, { code: 'C-1', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 10, unitId: u.id }))
  await transaction((tx) => crearLoteConEntrada(tx, { code: 'C-2', itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 20, unitId: u.id }))

  const conteoPropio = async () => {
    const r = await one(
      `SELECT COUNT(*) FILTER (WHERE status='ACTIVE') a,
              COUNT(*) FILTER (WHERE status='EXHAUSTED') e, COUNT(*) t
       FROM lots WHERE item_id = $1`, [mp.id])
    return { a: Number(r.a), e: Number(r.e), t: Number(r.t) }
  }
  const antes = await conteoPropio()
  const antesVista = await one(`SELECT * FROM v_lot_counters WHERE lot_kind='RAW_MATERIAL'`)
  comprobar('El contador refleja los lotes creados', antes.a === 2 && antes.t === 2,
    `activos=${antes.a} total=${antes.t}`)
  // La vista agrupa por tipo de lote, así que compara con el recuento global.
  const globalReal = await one(
    `SELECT COUNT(*) FILTER (WHERE status='ACTIVE') a FROM lots WHERE lot_kind='RAW_MATERIAL'`)
  comprobar('La vista de contadores cuadra con el recuento real de la base',
    Number(antesVista.active) === Number(globalReal.a),
    `vista=${antesVista.active} real=${globalReal.a}`)

  // Agotar uno
  const l = await one(`SELECT id FROM lots WHERE code='C-1'`)
  await transaction((tx) => moverStock(tx, { lotId: l.id, qty: -10, movimiento: 'PRODUCTION_CONSUMPTION', refType: 'PRODUCTION', refId: 1 }))
  const despues = await conteoPropio()
  comprobar('Al consumirse, baja el de activos y sube el de agotados',
    despues.a === 1 && despues.e === 1, `activos=${despues.a} agotados=${despues.e}`)
  comprobar('El total de lotes no cambia', despues.t === antes.t)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('12. Semillas: sin datos de negocio falsos')

{
  const clientes = await one('SELECT COUNT(*) c FROM customers')
  const pedidos = await one('SELECT COUNT(*) c FROM sales_orders')
  // Aquí SÍ hay artículos, pero los crearon las pruebas de esta misma suite.
  // Lo que se comprueba es que la SEMILLA no aporte ninguno: se reejecuta
  // sobre una base limpia y se cuenta.
  const { exec } = await import('../src/db/client.js')
  // El instalador, no `migrar()` + `sembrar()`: la 035 tiene un guardián que
  // comprueba que quede algún comercial, y el comercial lo crea la semilla.
  // Sembrar despues de migrar entero hacia fallar el guardian antes de tiempo.
  const { instalarBase } = await import('../src/db/instalar.js')
  await exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await instalarBase({ silencioso: true })
  const trasSemilla = await one('SELECT COUNT(*) c FROM items')
  comprobar('No se siembran clientes de ejemplo', Number(clientes.c) === 0)
  comprobar('No se siembran pedidos de ejemplo', Number(pedidos.c) === 0)
  comprobar('La semilla NO crea artículos de negocio', Number(trasSemilla.c) === 0,
    `la semilla creó ${trasSemilla.c}`)
  const cats = await one('SELECT COUNT(*) c FROM item_categories')
  comprobar('La semilla solo crea categorías, no artículos', Number(cats.c) === 8)

  const roles = await query('SELECT code FROM roles ORDER BY code')
    //
    // Sin el número escrito.
    //
    // Estaba como «los 5 roles de partida», y cuando se añadió el de CAJA esta
    // comprobación falló. El fallo no era del sistema: el rol nuevo estaba
    // bien y lo que faltaba era una caja. Lo que estaba mal era una prueba que
    // contaba roles en vez de comprobarlos, y que solo sirve para avisar
    // cuando alguien añade algo que quizá no debía.
    //
    // Lo que importa no es cuántos hay, sino que estén TODOS los que la
    // aplicación usa, incluido el de caja: un reparto que entrega dinero tiene
    // que hacerlo con alguien, y ese alguien es un rol.
    //
    const esperados = ['ADMIN', 'PRODUCTION', 'ACCOUNTING', 'DELIVERY',
      'COMMERCIAL', 'CAJAJERO']
    const faltan = esperados.filter((c) => !roles.some((r) => r.code === c))
    comprobar('Los roles que la aplicación usa están creados',
      faltan.length === 0,
      faltan.length
        ? `faltan: ${faltan.join(', ')}`
        : `hay ${roles.length}: ${roles.map((r) => r.code).join(', ')}`)

  const zonas = await query(`SELECT count(*) c FROM zones WHERE kind='REGION'`)
  comprobar('Las regiones de Mali están cargadas como datos', Number(zonas[0].c) === 8, `hay ${zonas[0].c}`)

  const unidades = await query('SELECT count(*) c FROM units')
  comprobar('Las unidades de medida están cargadas', Number(unidades[0].c) >= 9, `hay ${unidades[0].c}`)

  const perms = await query('SELECT count(*) c FROM permissions')
    //
    // Y otra vez la cuenta, no el número.
    //
    // El módulo `cash` entró para que un repartidor no pudiera declarar
    // entregado su propio dinero, y con un 25 × 6 a mano esta prueba tenía que
    // romperse cada vez que se añadiera algo. Lo que dice —«existe un permiso
    // para cada módulo y para cada acción»— se puede decir sin escribir la
    // cuenta, y sigue diciendo la verdad mañana.
    //
    const { MODULOS, ACCIONES } = await import('../src/security/permisos.js')
    comprobar('Todos los módulos y acciones tienen permiso creado',
      Number(perms[0].c) === MODULOS.length * ACCIONES.length,
      `hay ${perms[0].c}, y son ${MODULOS.length} × ${ACCIONES.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
console.log('')

await (await import('../src/db/client.js')).closeDb()
process.exit(r.fallos ? 1 : 0)
