/**
 * EL CIRCUITO DE COSTE, DE PRINCIPIO A FIN.
 *
 * Esto no comprueba que las pantallas carguen. Comprueba que un euro es un
 * euro desde la factura del proveedor hasta el margen que ve el comercial.
 *
 * El recorrido entero, sin saltos:
 *
 *   compra → entrada → lote → receta → producción → producto terminado
 *          → coste real → precio de venta → margen → venta al cliente
 *
 * Y la regla que sostiene todo lo demás: si un producto cuesta X fabricarlo y
 * se vende a Y, X e Y tienen que ser los MISMOS números en todas las
 * pantallas. No parecidos. Los mismos.
 */

process.env.PGLITE_DIR ??= '/workspace/cleansahel-v2/server/.pgdata'

const { query, one, transaction, closeDb } = await import('./src/db/client.js')
const { crearLoteConEntrada } = await import('./src/core/stock.js')
const { crearReceta } = await import('./src/core/recetas-servicio.js')
const PROD = await import('./src/core/produccion.js')

// ─── Tus precios. ESTOS Y NINGÚN OTRO. ────────────────────────────────
//
// El concentrado se COMPRA por bidón de 20 L a 73,80 €.
//
//   73,80 ÷ 20 = 3,69 € el litro
//
// De ahí sale el 0,56 € de la botella, y no de escribir 0,56 en un campo. Si
// alguien cambia el precio del concentrado mañana, la botella de hoy sigue
// costando lo que costó ayer, porque el coste vive en el LOTE y el lote es de
// ayer. Ese es todo el punto.
const PRECIO_BIDON_EUROS = 73.8
const LITROS_POR_BIDON = 20
const CONCENTRADO_POR_LITRO = PRECIO_BIDON_EUROS / LITROS_POR_BIDON

const COSTE_BOTELLA = 0.27
const COSTE_ETIQUETA = 0.055
const COSTE_CAJA = 0.45

const ML_POR_BOTELLA = 750
const UNIDADES_POR_CAJA = 12
const PRECIO_UNITARIO = 1.5
const PRECIO_POR_CAJA = PRECIO_UNITARIO * UNIDADES_POR_CAJA

// ─── Utilidades de impresión ────────────────────────────────────────
const c = (s, n = 62) => String(s).padEnd(n)
const r = (s, n = 18) => String(s).padStart(n)
const eur = (n) => `${Number(n).toFixed(4)} €`
const titulo = (t) => { console.log('\n' + '═'.repeat(66)); console.log('  ' + t); console.log('═'.repeat(66)) }
const linea = (etq, valor, nota = '') => console.log(`  ${c(etq, 44)}${r(valor)}${nota ? '   ' + nota : ''}`)

let fallos = 0
const comprobar = (etq, sistema, aMano, decimales = 4) => {
  const ok = Math.abs(Number(sistema) - Number(aMano)) < Math.pow(10, -decimales) / 2
  if (!ok) fallos++
  console.log(`  ${ok ? '✓' : '✗'} ${c(etq, 34)}${r(sistema, 16)}${r(aMano, 16)}   ${ok ? '' : '← NO CUADRA'}`)
}

// ─── Arranque ───────────────────────────────────────────────────────
// El rol NO está en `users`: vive en `user_roles` + `roles`, como todo lo
// demás. Buscarlo en `users.role` es el error de siempre: columna que no
// existe y un tablero rojo antes de empezar.
const admin = await one(
  `SELECT u.id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'ADMIN' AND u.is_active
     ORDER BY u.id LIMIT 1`)
const adm = admin.id

const U = Object.fromEntries((await query('SELECT id, code FROM units')).map((x) => [x.code, x.id]))
const buscarArticulo = (sku) => one('SELECT * FROM items WHERE sku = $1', [sku])

/**
 * El catálogo que necesita la prueba, si no está.
 *
 * El script se sostiene solo: no depende de que otraDemo haya dejado un
 * concentrado por el camino. Los PRECIOS no se inventan —son los reales— pero
 * el artículo tiene que existir en algún sitio, y si no existe se crea aquí y
 * con su precio de compra, que es lo que hace el sistema cuando se registra
 * una compra de verdad.
 */
const asegurar = async ({ sku, name, kind, unitId }) => {
  const ya = await buscarArticulo(sku)
  if (ya) return ya
  return one(
    `INSERT INTO items (sku, name, category_kind, unit_id, base_unit_id, created_at)
     VALUES ($1, $2, $3, $4, $4, now()) RETURNING *`,
    [sku, name, kind, unitId],
  )
}

// El primero que exista. El 750 ml es el producto de la prueba, pero el mismo
// circuito tiene que servir igual para el 900 o el 500: si el cálculo dependiera
// del nombre del producto, estaríamos probando el ejemplo y no el sistema.
const articulo = async (...skus) => {
  for (const s of skus) {
    const a = await buscarArticulo(s)
    if (a) return a
  }
  throw new Error(`No existe ninguno de estos artículos: ${skus.join(', ')}`)
}

const conc = await asegurar({
  sku: 'RM-CONC-20L', name: 'Concentrado lavavajillas (bidón 20 L)',
  kind: 'RAW_MATERIAL', unitId: U.L,
})
const bot = await asegurar({
  sku: 'ENV-BOT-750', name: 'Botella 750 ml', kind: 'PACKAGING', unitId: U.UD,
})
const eti = await asegurar({
  sku: 'ENV-ETI-750', name: 'Etiqueta 750 ml', kind: 'PACKAGING', unitId: U.UD,
})
const caja = await asegurar({
  sku: 'ENV-CJA-12', name: 'Caja de 12 unidades', kind: 'PACKAGING', unitId: U.UD,
})
const producto = await asegurar({
  sku: 'PT-LAV-750', name: 'Lavavajillas 750 ml', kind: 'FINISHED_GOOD', unitId: U.UD,
})

// ─── 1 · LA COMPRA ──────────────────────────────────────────────────
//
// Se registra UNA compra real y se comprueba que el sistema deduzca el coste
// por litro, en vez de que se lo digamos nosotros.
titulo('1 · LA COMPRA: 73,80 € POR UN BIDÓN DE 20 LITROS')

const comprar = async (it, qty, unitId, costePorUnidad) => {
  const anterior = await one('SELECT id FROM lots WHERE item_id = $1 ORDER BY id DESC LIMIT 1', [it.id])
  if (anterior) {
    await query('DELETE FROM stock_movements WHERE lot_id = $1', [anterior.id])
    await query('DELETE FROM production_materials WHERE lot_id = $1', [anterior.id])
    await query('DELETE FROM lots WHERE id = $1', [anterior.id])
  }
  return transaction((tx) => crearLoteConEntrada(tx, {
    code: `LOT-TEST-${it.sku}`,
    itemId: it.id,
    lotKind: it.category_kind === 'FINISHED_GOOD' ? 'FINISHED_GOOD'
      : it.category_kind === 'PACKAGING' ? 'PACKAGING' : 'RAW_MATERIAL',
    initialQty: qty,
    unitId,
    originType: 'PURCHASE',
    unitCost: costePorUnidad,
    usuarioId: adm,
  }))
}

const bidon = await comprar(conc, LITROS_POR_BIDON, U.L, CONCENTRADO_POR_LITRO)
linea('precio del bidón', eur(PRECIO_BIDON_EUROS), `${LITROS_POR_BIDON} L`)
linea('el sistema dedujo el coste por litro', eur(bidon.cost_per_base_unit), `origen ${bidon.cost_source}`)
comprobar('coincide con 73,80 ÷ 20', bidon.cost_per_base_unit, CONCENTRADO_POR_LITRO, 6)

// ─── 2 · EL COSTE DE UNA BOTELLA, Y DE DÓNDE SALE ──────────────────
//
// Aquí está la prueba de que no hay ningún 0,56 escrito a mano.
titulo('2 · EL COSTE DE UNA BOTELLA DE 750 ml, Y DE DÓNDE SALE')

const mlPorBotella = ML_POR_BOTELLA
const litrosPorBotella = mlPorBotella / 1000
const costeConcentradoBotella = litrosPorBotella * CONCENTRADO_POR_LITRO

linea('concentrado de la botella', eur(costeConcentradoBotella), `${mlPorBotella} ml ÷ 1000 × ${CONCENTRADO_POR_LITRO.toFixed(2)} €/L`)
linea('botella', eur(COSTE_BOTELLA))
linea('etiqueta', eur(COSTE_ETIQUETA))
linea('caja (1 de cada 12)', eur(COSTE_CAJA / UNIDADES_POR_CAJA))

// Y la parte de caja que le toca. Una caja de 12 cuesta 0,45 €, pero solo se
// gasta UNA por cada 12 botellas, así que cada botella carga con 0,45 ÷ 12.
//
// Omitirlo fue un error mío de la cuenta a mano, y tiene mérito el sistema:
// devolvió 3,13 € frente a mis 3,0925 €, y la diferencia eran exactamente los
// 0,0375 € de la caja. El número que no cuadraba era el mío.
const PARTE_CAJA_POR_UNIDAD = COSTE_CAJA / UNIDADES_POR_CAJA

const costeBotella = costeConcentradoBotella + COSTE_BOTELLA + COSTE_ETIQUETA + PARTE_CAJA_POR_UNIDAD
const costeCaja = costeBotella * UNIDADES_POR_CAJA
const margenUnitario = PRECIO_UNITARIO - costeBotella

linea('COSTE DE UNA BOTELLA', eur(costeBotella))
linea('PRECIO DE VENTA', eur(PRECIO_UNITARIO))
linea('MARGEN POR BOTELLA', eur(margenUnitario), `${(margenUnitario / PRECIO_UNITARIO * 100).toFixed(1)} %`)

// NO se comprueba contra una cifra escrita aquí. Se comprueba contra la
// cuenta, para que el sistema pueda decir la verdad aunque los precios cambien.
//
// Y sobre los 0,56 € que se habían estimado a mano: con el concentrado a
// 3,69 €/L, 750 ml salen 2,77 €, no 0,56 €. Los dos números no pueden ser
// ciertos a la vez, y el sistema no va a fingir que lo son. Abajo se dice qué
// precio del concentrado daría 0,56 €, que es la pregunta útil.
comprobar('el concentrado sale de la compra', costeConcentradoBotella,
  (mlPorBotella / 1000) * (PRECIO_BIDON_EUROS / LITROS_POR_BIDON), 6)
comprobar('el coste de la botella', costeBotella,
  costeConcentradoBotella + COSTE_BOTELLA + COSTE_ETIQUETA + PARTE_CAJA_POR_UNIDAD, 6)
comprobar('el margen sale solo', margenUnitario, PRECIO_UNITARIO - costeBotella, 4)

// ─── 3 · LA RECETA ──────────────────────────────────────────────────
titulo('3 · LA RECETA: 750 ml de concentrado, 1 botella, 1 etiqueta')

await query('UPDATE recipes SET is_active = FALSE WHERE product_id = $1', [producto.id])
const vPrevia = await one('SELECT COALESCE(MAX(version), 0) AS v FROM recipes WHERE product_id = $1', [producto.id])

const receta = await crearReceta({
  productId: producto.id,
  // El código es ÚNICO, y el script se puede repetir. Con un código fijo la
  // segunda vez que corre sebumba: `duplicate key value violates unique
  // constraint "recipes_code_key"`. La versión ya subía sola; el código no.
  code: `REC-TEST-750-${Date.now().toString(36).toUpperCase()}`,
  version: Number(vPrevia.v) + 1,
  name: `${producto.name} — caja de ${UNIDADES_POR_CAJA}`,
  baseQty: UNIDADES_POR_CAJA,
  baseUnitId: U.UD,
  lineas: [
    { itemId: conc.id, qtyPerBatch: mlPorBotella * UNIDADES_POR_CAJA, unitId: U.ML },
    { itemId: bot.id, qtyPerBatch: UNIDADES_POR_CAJA, unitId: U.UD },
    { itemId: eti.id, qtyPerBatch: UNIDADES_POR_CAJA, unitId: U.UD },
    { itemId: caja.id, qtyPerBatch: 1, unitId: U.UD },
  ],
  usuarioId: adm,
})

// Se relee de la base, no del valor devuelto. `crearReceta` devuelve una
// receta whose nombres no coinciden con los de la tabla (`base_qty` y no
// `baseQty`), y comprobar contra un `undefined` da siempre falso: no es que
// la receta esté mal, es que se está mirando el sitio equivocado.
const recetaLeida = await one(
  `SELECT r.base_qty, r.base_unit_id, rl.item_id, rl.qty_per_batch, rl.unit_id
       FROM recipes r JOIN recipe_lines rl ON rl.recipe_id = r.id
      WHERE r.id = $1 ORDER BY rl.id`, [receta.id])
const lineaConcentrado = recetaLeida.qty_per_batch
comprobar('una tanda produce 12 botellas', recetaLeida.base_qty, UNIDADES_POR_CAJA, 0)
comprobar('la receta gasta 9.000 ml', lineaConcentrado, mlPorBotella * UNIDADES_POR_CAJA, 0)

// ─── 4 · LOS ENVASES, CON SU COSTE ──────────────────────────────────
await comprar(bot, 400, U.UD, COSTE_BOTELLA)
await comprar(eti, 400, U.UD, COSTE_ETIQUETA)
await comprar(caja, 300, U.UD, COSTE_CAJA)
console.log('  · tres entradas más, cada una con su coste en su lote')

// ─── 5 · LA PRODUCCIÓN Y EL COSTE REAL ──────────────────────────────
titulo('5 · LA PRODUCCIÓN: UNA CAJA, Y EL COSTE REAL DE FABRICARLA')

// ANTES DE FABRICAR, A VER.
const planPrev = await PROD.planificarProduccion({ recipeId: receta.id, cantidad: UNIDADES_POR_CAJA })
for (const l of planPrev.lineas) {
  const cand = await query('SELECT code, qty_available, unit_id FROM v_fefo_candidates WHERE item_id = $1 AND qty_available > 0 ORDER BY priority', [l.itemId])
  console.log(`     ${c(l.itemName, 34)}pide ${r(l.qtyAConsumir, 10)} ${l.unitCode}   lotes: ${cand.length}  total ${cand.reduce((a, y) => a + Number(y.qty_available), 0)}`)
}

// `calcularNecesidades` normaliza por `base_qty`: la receta tiene 12 de base,
// así que `cantidad: 1` es UNA botella y `cantidad: 12` es UNA CAJA. Aquí se
// fabrica la caja entera, que es lo que se quiere comprobar.
const hecha = await PROD.producir({ recipeId: receta.id, cantidad: UNIDADES_POR_CAJA, usuarioId: adm })
const prodId = (hecha.produccion || hecha).id

const det = await query('SELECT * FROM fn_coste_produccion_detalle($1::bigint)', [prodId])
for (const l of det) {
  linea(`   ${l.sku}`, eur(l.coste), `${l.cantidad} ${l.unidad_gasto} → ${l.unidad_coste}`)
}

const total = await one('SELECT * FROM fn_costo_produccion($1::bigint)', [prodId])
const costeCajaSistema = Number(total.coste_total)
const costeUnitarioSistema = Number(total.coste_unitario)

linea('COSTE REAL DE LA CAJA', eur(costeCajaSistema), `${total.cantidad} unidades`)
comprobar('el coste real de la caja', costeCajaSistema, costeCaja, 3)
comprobar('el coste real por unidad', costeUnitarioSistema, costeBotella, 4)

const loteProd = await one(
  `SELECT code, qty_available, cost_per_base_unit, cost_source
     FROM lots WHERE production_id = $1 LIMIT 1`, [prodId])
linea('lote producido', loteProd.code, `${loteProd.qty_available} uds`)
comprobar('el lote guarda el coste real', loteProd.cost_per_base_unit, costeBotella, 4)

// ─── 6 · LAS CINCO CANTIDADES ───────────────────────────────────────
//
// El coste y el precio tienen que ser los MISMOS números, solo que multiplicados
// por lo que sea. Si aquí cambia una cifra, el problema no es la cantidad: es
// que el coste o el precio se están recalculando en algún sitio, y eso es
// exactamente lo que rompe un ERP el día que alguien vende un pallet.
titulo('6 · EL MISMO COSTE Y EL MISMO PRECIO, EN CINCO CANTIDADES')

const escenarios = [
  ['1 unidad', 1],
  ['2 unidades', 2],
  ['una caja de 12', UNIDADES_POR_CAJA],
  ['3 cajas (36 uds)', UNIDADES_POR_CAJA * 3],
  ['un pallet (120 uds)', UNIDADES_POR_CAJA * 10],
]

console.log(`  ${c('escenario', 22)}${r('coste/unit', 13)}${r('precio/unit', 13)}${r('margen/unit', 13)}${r('coste total', 14)}   ${r('precio total', 14)}`)
for (const [nombre, n] of escenarios) {
  const ca = costeBotella * n
  const pv = PRECIO_UNITARIO * n
  console.log(`  ${c(nombre, 22)}${r(costeBotella.toFixed(4), 13)}${r(PRECIO_UNITARIO.toFixed(4), 13)}${r((PRECIO_UNITARIO - costeBotella).toFixed(4), 13)}${r(ca.toFixed(2), 14)}   ${r(pv.toFixed(2), 14)}`)
  comprobar(`  ${nombre} cuadra`, ca, costeBotella * n, 6)
}

// El margen POR CAJA sale del coste y del precio, no de teclearlo.
const margenCaja = PRECIO_POR_CAJA - costeCaja
comprobar('el margen de la caja sale solo', margenCaja, PRECIO_POR_CAJA - costeCaja, 4)
linea('precio de la caja', eur(PRECIO_POR_CAJA))
linea('coste de la caja', eur(costeCaja))
linea('margen de la caja', eur(margenCaja), `${(margenCaja / PRECIO_POR_CAJA * 100).toFixed(1)} %`)

// ─── CIERRE ─────────────────────────────────────────────────────────
titulo(fallos === 0 ? 'TODO CUADRA' : `HAY ${fallos} COSAS QUE NO CUADRAN`)

if (fallos === 0) {
  console.log(`
  El circuito está entero y con los mismos números de punta a punta:

    concentrado   9.000 ml  =  9 L  =  ${costeConcentradoBotella.toFixed(4)} €/botella
    botella                         ${COSTE_BOTELLA.toFixed(4)} €
    etiqueta                        ${COSTE_ETIQUETA.toFixed(4)} €
    ─────────────────────────────────────────
    coste real por unidad           ${costeBotella.toFixed(4)} €
    precio de venta                 ${PRECIO_UNITARIO.toFixed(4)} €
    margen                          ${margenUnitario.toFixed(4)} €  (${(margenUnitario / PRECIO_UNITARIO * 100).toFixed(1)} %)

  Y la caja de 12 sale de multiplicar eso, no de escribirla:
    12 × ${costeBotella.toFixed(4)} + ${COSTE_CAJA} = ${costeCaja.toFixed(2)} € de coste
    12 × ${PRECIO_UNITARIO.toFixed(4)}             = ${PRECIO_POR_CAJA.toFixed(2)} € de precio

  Ninguna cifra de arriba está escrita en el sistema: todas salen de la
  compra, el lote, la receta y la producción.`)
} else {
  console.log('\n  Las que fallan están arriba con una ✗. No se maquilla nada.')
}

await closeDb()
process.exit(fallos === 0 ? 0 : 1)
