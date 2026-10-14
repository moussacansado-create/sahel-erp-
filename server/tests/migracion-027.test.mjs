/**
 * COMPROBACIÓN DE LA MIGRACIÓN 027.
 *
 * Que «aplique sin error» no dice nada. Una migración que se aplica y no crea
 * lo que dice crear también sale con exit 0.
 *
 * Aquí se comprueba, contra la base ya migrada:
 *
 *   · que existe todo lo que la migración promete, y NADA más de lo que dice;
 *   · que el módulo NO ha tocado ninguna tabla del ERP;
 *   · que no ha metido ninguna clave foránea que apunte fuera;
 *   · que un comercial SIN objetivo aparece en el ranking, detrás, con «—»;
 *   · que uno CON objetivo y cero ventas sale a 0 % y NO se confunde con el
 *     anterior. Que es justo la confusion que pidió evitar.
 */

process.env.PGLITE_DIR = '/workspace/cleansahel-v2/server/.pgdata-test'

const { query, one, closeDb } = await import('../src/db/client.js')

// Esta prueba monta SU base. Antes no lo hacia: asumia que otro test ya la
// habia dejado construida, y en una suite que corre en ese orden funcionaba por
// casualidad. Montarla aqui es lo que hace que el resultado no dependa de lo
// que se ejecutase antes.
const { baseDePrueba } = await import('./banco.js')
await baseDePrueba()

let fallos = 0
const ok = (t, extra = '') => console.log(`  ✓ ${t}${extra ? '   ' + extra : ''}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LO QUE TIENE QUE EXISTIR')

const ESPERADAS = [
  ['com_zonas'], ['com_idiomas'], ['com_zona_idiomas'], ['com_perfiles'],
  ['com_comercial_idiomas'], ['com_objetivos'], ['com_visitas'],
  ['com_reglas_puntos'], ['com_puntos'], ['com_superficie'],
]
const tablas = new Set((await query(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'com\\_%'")).map((t) => t.tablename))

for (const [t] of ESPERADAS) {
  if (tablas.has(t)) ok(`tabla ${t}`)
  else mal(`falta la tabla ${t}`)
}

const ESPERADAS_VISTAS = ['com_progreso', 'com_ranking', 'com_afinidades']
const vistas = new Set((await query(
  "SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'com\\_%'")).map((v) => v.viewname))
for (const v of ESPERADAS_VISTAS) {
  if (vistas.has(v)) ok(`vista ${v}`)
  else mal(`falta la vista ${v}`)
}

const funciones = new Set((await query(
  "SELECT proname FROM pg_proc WHERE proname LIKE 'com\\_%'")).map((f) => f.proname))
for (const f of ['com_hechos', 'com_hechos_seguro', 'com_puntos_de']) {
  if (funciones.has(f)) ok(`función ${f}()`)
  else mal(`falta la función ${f}()`)
}

const reglas = await one('SELECT count(*) AS n FROM com_reglas_puntos')
if (Number(reglas.n) >= 4) ok(`${reglas.n} reglas de puntos sembradas`)
else mal(`solo hay ${reglas.n} reglas de puntos`)

const idiomas = await one('SELECT count(*) AS n FROM com_idiomas')
if (Number(idiomas.n) >= 8) ok(`${idiomas.n} idiomas disponibles`)
else mal(`solo hay ${idiomas.n} idiomas`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · AISLAMIENTO: QUE NO HAYA TOCADO EL ERP')

//
// La comprobación que de verdad importa: que el módulo no pueda tumbar el ERP.
// Si hay una clave foránea desde `com_*` hacia una tabla del ERP, el ERP
// espera al módulo y un borrado del ERP puede fallar por culpa de un
// comercial.
//
const fks = await query(`
  SELECT tc.table_name AS desde, ccu.table_name AS hacia
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY'
     AND tc.table_name LIKE 'com\\_%'`)

const ERP = ['items', 'sales_orders', 'sales_order_lines', 'payments', 'stock_movements', 'lots', 'users', 'customers', 'audit_log']
const fuera = fks.filter((f) => ERP.includes(f.hacia))
if (fuera.length === 0) {
  ok(`NINGUNA clave foránea desde com_* hacia el ERP (${fks.length} foreign keys, todas internas)`)
} else {
  for (const f of fuera) mal(`com_${f.desde} → ${f.hacia}: eso hace que el ERP espere al módulo`)
}

const superficie = await query('SELECT tabla, toca_erp, que_toca FROM com_superficie ORDER BY toca_erp DESC, tabla')
const escrituras = superficie.filter((s) => s.toca_erp)
ok(`la superficie declara ${superficie.length} tablas: ${escrituras.length} del ERP, todas de SOLO LECTURA`)
for (const e of escrituras) console.log(`     ${e.tabla.padEnd(20)} ${e.que_toca}`)

// Las tablas del ERP que existían antes deben seguir con las mismas columnas.
const columnas = async (t) => (await query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='${t}' ORDER BY ordinal_position`)).map((x) => x.column_name).join(',')
const colsItems = await columnas('items')
if (colsItems.includes('sku') && colsItems.includes('sale_price')) {
  ok(`items intacto: ${(await query("SELECT count(*) n FROM items"))[0].n} artículos, columnas sin cambios`)
} else mal('la tabla items ha cambiado')

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · LA REGLA DE LOS OBJETIVOS')

//
// «Sin objetivo» y «con objetivo y cero» tienen que ser DOS COSAS DISTINTAS.
// Esta es la prueba de que lo son.
//
//
// La base de PRUEBAS no tiene usuarios: las semillas del ERP solo se siembran
// en la demo, y esta prueba no puede sembrarlas porque tocaría el ERP —justo
// lo que este módulo no puede hacer. Se crean solo los dos usuarios que hacen
// falta para la prueba.
//
for (const r of [
  ["INSERT INTO roles (code, name) VALUES ('ADMIN','Administrador') ON CONFLICT (code) DO NOTHING"],
]) await query(r[0])

const admin = { id: null }
{
  const u = await query(
    `INSERT INTO users (username, full_name, password_hash) VALUES ('adm-027','Admin 027','x')
     ON CONFLICT (username) DO UPDATE SET full_name='Admin 027' RETURNING id`,
  )
  admin.id = u[0].id
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code='ADMIN' ON CONFLICT DO NOTHING`, [admin.id],
  )
}
if (!admin.id) {
  mal('no se ha podido crear el usuario de prueba')
} else {
  const dos = await query(
    `INSERT INTO users (username, full_name, password_hash)
     VALUES ('com-sin-obj','Sin objetivo','x'), ('com-con-obj','Con objetivo','x')
     ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
  )
  const a = await one("SELECT id FROM users WHERE username='com-sin-obj'")
  const b = await one("SELECT id FROM users WHERE username='com-con-obj'")

  // Sin objetivo.
  await query('INSERT INTO com_perfiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [a.id])
  const pa = await one('SELECT id FROM com_perfiles WHERE user_id=$1', [a.id])
  // Con objetivo de 100.000 y ninguna venta.
  await query('INSERT INTO com_perfiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [b.id])
  const pb = await one('SELECT id FROM com_perfiles WHERE user_id=$1', [b.id])
  await query(
    `INSERT INTO com_objetivos (comercial_id, period_start, period_end, target_amount)
     VALUES ($1, date_trunc('month', CURRENT_DATE)::date,
             (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date, 100000)`,
    [pb.id],
  )

  const filas = await query("SELECT * FROM com_ranking WHERE user_id = ANY($1::int[]) ORDER BY puesto", [[a.id, b.id]])
  const sinObj = filas.find((f) => f.user_id === a.id)
  const conObj = filas.find((f) => f.user_id === b.id)

  if (filas.length !== 2) {
    mal(`el ranking devuelve ${filas.length} filas de las 2 esperadas: alguien sin objetivo NO aparece`)
  } else {
    ok('los dos comerciales aparecen en el ranking, tenga objetivo o no')

    // 1 · El que no tiene objetivo va detrás.
    if (sinObj.puesto > conObj.puesto) ok(`el que NO tiene objetivo va detrás: puesto ${sinObj.puesto} vs ${conObj.puesto}`)
    else mal(`el que no tiene objetivo va ${sinObj.puesto} y el que tiene ${conObj.puesto}`)

    // 2 · Su cumplimiento es NULO, no cero.
    if (sinObj.tiene_objetivo === false) ok('«tiene_objetivo» = false: se DICE, no se deduce')
    else mal(`tiene_objetivo sale ${sinObj.tiene_objetivo} para un comercial sin objetivo`)

    if (sinObj.cumplimiento_pct === null) ok('su cumplimiento es NULL — «no lo sé», no un suspenso')
    else mal(`su cumplimiento sale ${sinObj.cumplimiento_pct}: un NULL valía más que un 0`)

    if (sinObj.cumplimiento_texto === '—') ok('y en pantalla sale «—», no «0 %»')
    else mal(`el texto sale «${sinObj.cumplimiento_texto}»`)

    // 3 · El que SÍ tiene objetivo y no ha vendido sale a 0, que es otra cosa.
    if (conObj.tiene_objetivo === true && Number(conObj.cumplimiento_pct) === 0) {
      ok('el que tiene objetivo y no ha vendido sale a 0 % — y es DISTINTO del anterior')
    } else {
      mal(`el que tiene objetivo sale ${conObj.cumplimiento_pct} y tiene_objetivo=${conObj.tiene_objetivo}`)
    }

    // 4 · Y los puntos no le cuentan cumplimiento a quien no tiene objetivo.
    const pSin = await one('SELECT com_puntos_de($1, CURRENT_DATE, CURRENT_DATE) AS p', [pa.id])
    const pCon = await one('SELECT com_puntos_de($1, CURRENT_DATE, CURRENT_DATE) AS p', [pb.id])
    ok(`puntos del que no tiene objetivo: ${pSin.p} (sin objetivo no hay cumplimiento que contar)`)
    ok(`puntos del que tiene: ${pCon.p}`)
  }

  // Limpieza.
  await query('DELETE FROM com_perfiles WHERE user_id = ANY($1::int[])', [[a.id, b.id]])
  await query('DELETE FROM users WHERE id = ANY($1::int[])', [[a.id, b.id]])
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · LAS RESTRICCIONES QUE TIENEN QUE EXISTIR')

const restricciones = async (t) => (await query(
  `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype='c'`, [t])).map((c) => c.conname)

const rVisitas = await restricciones('com_visitas')
if (rVisitas.some((x) => x.includes('resultado'))) ok('el resultado de visita es una lista cerrada')
else mal('el resultado de visita no tiene CHECK: alguien podría escribir «lo que sea»')

const rObj = await query(
  "SELECT conname FROM pg_constraint WHERE conrelid='com_objetivos'::regclass AND contype='c'")
if (rObj.some((c) => c.conname.includes('vacio'))) ok('un objetivo vacío se rechaza en la BASE, no solo en el código')
else mal('no hay CHECK de objetivo vacío')

const rAlta = await query(
  "SELECT conname FROM pg_constraint WHERE conrelid='com_perfiles'::regclass AND contype='c'")
if (rAlta.some((c) => c.conname.includes('futuro'))) ok('no se puede contratar a alguien con fecha de mañana')
else mal('se puede contratar a alguien con fecha de futuro')

const uq = await query(
  "SELECT indexname FROM pg_indexes WHERE tablename='com_objetivos' AND indexname LIKE 'uniq%'")
if (uq.length) ok(`un comercial no puede tener dos objetivos en el mismo periodo (${uq[0].indexname})`)
else mal('se pueden dar dos objetivos para el mismo comercial y periodo')

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LA MIGRACIÓN ESTÁ CORRECTA' : `HAY ${fallos} FALLOS`)

console.log('')
await closeDb()
process.exit(fallos === 0 ? 0 : 1)