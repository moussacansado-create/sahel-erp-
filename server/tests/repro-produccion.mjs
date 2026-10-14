// Reproducción AISLADA del fallo de confirmación de producción.
//
// Usa la base de pruebas (`.pgdata-test`), nunca la de trabajo. Si aquí
// funciona, el problema estaba en los datos que dejaron mis pruebas; si falla
// aquí también, es código y hay que arreglarlo.
import { query, one, transaction, closeDb } from '../src/db/client.js'
import { migrar } from '../src/db/migrador.js'
import { sembrar } from '../src/db/semillas.js'

const fallos = []
const L = (ok, m) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${m}`); if (!ok) fallos.push(m) }

await migrar({ silencioso: true })
await sembrar()

const { crearItem } = await import('../src/core/items.js').catch(() => ({ crearItem: null }))
const prod = await import('../src/core/produccion.js')
const inv = await import('../src/core/stock.js')
const rec = await import('../src/core/recetas-servicio.js')

const u = await one('SELECT id FROM units ORDER BY id LIMIT 1')
const cat = await one(
  `INSERT INTO item_categories (code, name, category_kind)
   VALUES ('REPRO','Reproduccion','FINISHED_GOOD') ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`)

async function nuevoArticulo(nombre, kind) {
  return one(
    `INSERT INTO items (sku,name,category_kind,category_id,unit_id,purchase_cost,sale_price)
     VALUES ($1,$2,$3,$4,$5,100,500) RETURNING *`,
    [`PT-${nombre}-${Date.now().toString().slice(-4)}`, nombre, kind, cat.id, u.id])
}

console.log('\n  ══ REPRODUCCIÓN AISLADA · confirmación de producción ══\n')

// Tres producciones seguidas, con datos nuevos cada vez. Si solo falla la
// segunda o la tercera, el problema no es la primera y se nota.
for (let vuelta = 1; vuelta <= 3; vuelta++) {
  const mp = await nuevoArticulo(`MP-REP-${vuelta}`, 'RAW_MATERIAL')
  const pt = await nuevoArticulo(`PT-REP-${vuelta}`, 'FINISHED_GOOD')

  // Existencias de la materia prima, por la vía normal de almacén.
  const ent = await transaction((tx) => inv.crearLoteConEntrada(tx, {
    code: `RPT${vuelta}-${new Date().getFullYear()}-${(900000 + vuelta).toString()}`,
    itemId: mp.id, lotKind: 'RAW_MATERIAL', initialQty: 100,
    unitId: u.id, originType: 'MANUAL_RECEPTION', originId: null, usuarioId: 1,
  }).catch((e) => ({ error: String(e.message).slice(0, 130) })))
  L(!ent.error, `v${vuelta} · entrada${ent.error ? ': ' + ent.error : ''}`)
    if (ent.error) {
      const m2 = /check constraint "([^"]+)"/.exec(ent.error)
      if (m2) console.log('      >>> RESTRICCION: ' + m2[1])
    }

  const r = await rec.crearReceta({
    productId: pt.id, name: `Receta REP ${vuelta}`, baseQty: 1,
    lineas: [{ itemId: mp.id, qtyPerBatch: 2, unitId: u.id }], usuarioId: 1,
  }).catch((e) => ({ error: String(e.message).slice(0, 70) }))
  if (r.error) { L(false, `v${vuelta} · receta: ${r.error}`); continue }
  L(true, `v${vuelta} · receta creada (${r.receta?.id ?? r.id})`)

  const plan = await prod.planificarFabricacion({
    recipeId: r.receta?.id ?? r.id, cantidad: 10, usuarioId: 1,
  }).catch((e) => ({ error: String(e.message).slice(0, 70) }))
  if (plan.error) { L(false, `v${vuelta} · planificación: ${plan.error}`); continue }
  const pid = plan.produccion?.id ?? plan.plan?.id ?? plan.id
  L(!!pid, `v${vuelta} · producción planificada (${pid})`)

  const conf = await prod.confirmarPlan(pid, { usuarioId: 1 })
    .catch((e) => ({ error: String(e.message).slice(0, 90), code: e.codigo }))

  if (conf.error) {
    L(false, `v${vuelta} · CONFIRMACIÓN FALLÓ: ${conf.error}`)
    // Ahora el detalle de verdad: qué se intentó insertar y por qué se rechazó.
    try {
      const info = await one(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name='lots' ORDER BY ordinal_position`)
      console.log('      · columnas de lots: ' + info.column_name)
    } catch {}
    continue
  }

  const p = conf.produccion || conf
  L(p.status === 'COMPLETED', `v${vuelta} · confirmada (${p.code}, ${p.status})`)

  // LO QUE DE VERDAD IMPORTA: ¿hay existencias de producto terminado?
  const stock = await one(
    `SELECT COALESCE(SUM(qty_available),0)::numeric(14,4) AS disp, COUNT(*)::int AS lotes,
            COALESCE(SUM(initial_qty),0)::numeric(14,4) AS inicial
       FROM lots WHERE item_id = $1 AND status <> 'RETIRADO'`, [pt.id])
  L(Number(stock.disp) === 10,
    `v${vuelta} · existencias: ${stock.disp} de 10 pedidas (${stock.lotes} lote/s)`)
  L(Number(stock.inicial) === 10, `v${vuelta} · nada duplicado: inicial ${stock.inicial}`)

  const movs = await one(
    `SELECT COUNT(*)::int n FROM stock_movements WHERE lot_id IN (SELECT id FROM lots WHERE item_id=$1)`, [pt.id])
  L(movs.n >= 1, `v${vuelta} · movimiento de inventario registrado (${movs.n})`)
}

console.log(`\n  ${fallos.length === 0 ? 'REPRODUCE OK: la confirmación funciona con datos limpios' : `${fallos.length} FALLOS`}`)
console.log('  · base usada: base de pruebas, no la de trabajo\n')
await closeDb()
process.exit(fallos.length ? 1 : 0)
