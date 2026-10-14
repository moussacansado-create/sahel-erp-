/**
 * COMPROBACIÓN DE LA MIGRACIÓN 028.
 *
 * Las nueve cosas que hay que demostrar, y se demuestran una por una. Las
 * que importan de verdad son dos:
 *
 *   · KIDAL ESTÁ SEPARADA DE GAO. Si dos demarcaciones acabaran con el mismo
 *     polígono o la misma fila, el mapa mentiría sobre dónde se vende.
 *
 *   · LOS NULL DE POTENCIAL SIGUEN SIENDO NULL. Es tentador «rellenarlos con
 *     cero para que la pantalla no muestre guiones», y ese es exactamente el
 *     movimiento que convierte «no lo sé» en «lo sé: no tiene». Esta prueba
 *     falla si alguien lo intenta.
 *
 */

process.env.JWT_SECRET = process.env.JWT_SECRET
  ?? 'clave-de-prueba-esto-no-es-real-1234567890123456789012345678901234567890'
process.env.PGLITE_DIR = '/workspace/cleansahel-v2/server/.pgdata-test'

const { query, one, closeDb } = await import('../src/db/client.js')

// Esta prueba monta SU base. Antes no lo hacia: asumia que otro test ya la
// habia dejado construida, y en una suite que corre en ese orden funcionaba por
// casualidad. Montarla aqui es lo que hace que el resultado no dependa de lo
// que se ejecutase antes.
const { baseDePrueba } = await import('./banco.js')
await baseDePrueba()

let fallos = 0
const ok = (t, e = '') => console.log(`  ✓ ${t}${e ? '   ' + e : ''}`)
const mal = (t, e = '') => { fallos++; console.log(`  ✗ ${t}${e ? '   ' + e : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LAS NUEVE REGIONES')

const ESPERADAS = ['BKO', 'GAO', 'KAY', 'KDL', 'KLR', 'MPT', 'SEG', 'SKS', 'TOM']
const regiones = await query(
  `SELECT id, code, name, kind, latitude, longitude, poligono FROM com_zonas
    WHERE latitude IS NOT NULL ORDER BY code`)

if (regiones.length === 9) ok(`hay ${regiones.length} regiones reales`)
else mal(`hay ${regiones.length} regiones, esperaban 9`)

for (const codigo of ESPERADAS) {
  const z = regiones.find((r) => r.code === codigo)
  if (!z) { mal(`falta la región ${codigo}`); continue }
  const linea = `${z.code.padEnd(4)} ${z.name.padEnd(11)} [${Number(z.longitude).toFixed(2)}, ${Number(z.latitude).toFixed(2)}] ${String(z.poligono.length).padStart(3)} pts`
  ok(linea)
}

// ─── Cada una con centroide Y con polígono ─────────────────────────────────
const sinCentroide = regiones.filter((z) => z.latitude == null || z.longitude == null)
if (sinCentroide.length === 0) ok('las nueve tienen centroide')
else mal(`${sinCentroide.length} sin centroide: ${sinCentroide.map((z) => z.code).join(', ')}`)

const sinPoligono = regiones.filter((z) => !z.poligono || z.poligono.length < 4)
if (sinPoligono.length === 0) ok('las nueve tienen polígono cerrado')
else mal(`${sinPoligono.length} con polígono que no cierra`)

// El centroide tiene que caer DENTRO del país. Con la frontera alargada de
// Mali, el centro de la caja se sale; por eso se calculó del polígono.
const fuera = []
for (const z of regiones) {
  const dentro = z.poligono.some(([x, y], i) => {
    if (i === 0) return false
    const [ax, ay] = z.poligono[i - 1]; const [bx, by] = z.poligono[i]
  })
  // Comprobación por rayo horizontal: cuenta los cruces a la derecha.
  const [px, py] = [Number(z.longitude), Number(z.latitude)]
  let cruces = 0
  for (let i = 0; i < z.poligono.length; i++) {
    const [ax, ay] = z.poligono[i]
    const [bx, by] = z.poligono[(i + 1) % z.poligono.length]
    if ((ay > py) !== (by > py)) {
      const x = ax + ((py - ay) / (by - ay)) * (bx - ax)
      if (x > px) cruces++
    }
  }
  if (cruces % 2 !== 1) fuera.push(z.code)
}
if (fuera.length === 0) ok('el centroide de cada región cae DENTRO de su propio polígono')
else mal(`centroide fuera de su polígono: ${fuera.join(', ')}`)

// ─── Kidal separada de Gao ────────────────────────────────────────────────
titulo('2 · KIDAL, SUYA')

const kidal = regiones.find((z) => z.code === 'KDL')
const gao = regiones.find((z) => z.code === 'GAO')

if (!kidal || !gao) { mal('falta Kidal o Gao') } else {
  if (kidal.id !== gao.id) ok('Kidal y Gao son filas distintas')
  else mal('Kidal y GAO son la misma fila: se han fusionado')

  const mismoPoligono = JSON.stringify(kidal.poligono) === JSON.stringify(gao.poligono)
  if (!mismoPoligono) ok('y tienen polígonos distintos')
  else mal('Kidal y Gao comparten polígono')

  // Kidal está al norte del centro de Gao. Si estuvieran intercambiadas, el
  // mapa enseñaría Gao en el desierto alto y Kidal en el centro del país.
  if (Number(kidal.latitude) > Number(gao.latitude)) {
    ok(`Kidal al norte de Gao (${Number(kidal.latitude).toFixed(1)}° vs ${Number(gao.latitude).toFixed(1)}°)`)
  } else {
    mal('Kidal no está al norte de Gao: parecen intercambiadas')
  }
}

// ─── El potencial, NULL ────────────────────────────────────────────────────
titulo('3 · EL POTENCIAL SIGUE EN NULL')

const potencial = await query(
  `SELECT code, poblacion, comercios_estimados, clientes_potenciales, dificultad
     FROM com_zonas WHERE latitude IS NOT NULL ORDER BY code`)

const conAlgo = potencial.filter((z) =>
  z.poblacion != null || z.comercios_estimados != null
  || z.clientes_potenciales != null || z.dificultad != null)

if (conAlgo.length === 0) ok('las nueve tienen los CUATRO campos de potencial en NULL')
else mal(`${conAlgo.length} zonas tienen potencial puesto: ${conAlgo.map((z) => z.code).join(', ')}`)

const conCero = potencial.filter((z) =>
  z.poblacion === 0 || z.comercios_estimados === 0 || z.clientes_potenciales === 0)
if (conCero.length === 0) ok('y ninguno tiene un CERO disfrazado de dato')
else mal(`${conCero.length} con ceros: un cero es «lo sé: no tiene», no «no lo sé»`)

// Y que la ficha NO los convierta.
const ficha = await query('SELECT code, potencial_pendiente FROM com_ficha_zona() ORDER BY code')
if (ficha.every((f) => f.potencial_pendiente === true)) {
  ok('y la ficha marca potencial_pendiente = true en las nueve: la pantalla lo dirá')
} else {
  mal(`potencial_pendiente no es true en todas: ${JSON.stringify(ficha.filter((f) => !f.potencial_pendiente).map((f) => f.code))}`)
}

// ─── Un comercial en varias zonas ──────────────────────────────────────────
titulo('4 · UN COMERCIAL EN VARIAS ZONAS')

const cols = (await query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='com_comercial_zonas'")).map((c) => c.column_name)
for (const c of ['comercial_id', 'zona_id', 'es_principal', 'porcentaje', 'desde', 'hasta']) {
  if (cols.includes(c)) ok(`com_comercial_zonas.${c}`)
  else mal(`falta com_comercial_zonas.${c}`)
}

// La base de pruebas no está sembrada — sembrarla sería cosa del ERP—, así que
// la prueba se crea los dos usuarios que necesita.
const { hashPassword } = await import('../src/security/passwords.js')
const hash = await hashPassword('NoSeUsa.2026')
for (const [u, n] of [['t028-a', 'Comercial Prueba A'], ['t028-b', 'Comercial Prueba B']]) {
  await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
               VALUES ($1,$2,$3,'es',now()) ON CONFLICT (username) DO NOTHING`, [u, n, hash])
}
const u1 = (await one("SELECT id FROM users WHERE username = 't028-a'"))?.id
const u2 = (await one("SELECT id FROM users WHERE username = 't028-b'"))?.id
const p1 = (await one(
  `INSERT INTO com_perfiles (user_id, home_zona_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET is_active=TRUE RETURNING id`,
  [u1, kidal.id],
))?.id
const p2 = (await one(
  `INSERT INTO com_perfiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET is_active=TRUE RETURNING id`,
  [u2],
))?.id

if (p1 && p2) {
  // El comercial 2 en TRES zonas: principal + dos más.
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje) VALUES ($1,$2,TRUE,50)`, [p2, kidal.id])
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, porcentaje) VALUES ($1,$2,30)`, [p2, gao.id])
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, porcentaje) VALUES ($1,$2,20)`, [p2, regiones.find((z) => z.code === 'KLR').id])

  const suyas = await query('SELECT zona_id, es_principal, porcentaje FROM com_comercial_zonas WHERE comercial_id = $1 ORDER BY es_principal DESC', [p2])
  if (suyas.length === 3) ok('un comercial puede estar en 3 zonas a la vez')
  else mal(`tiene ${suyas.length} zonas,.he puesto 3`)
  if (suyas.filter((z) => z.es_principal).length === 1) ok('  → y solo UNA es principal')
  else mal('  → hay más de una principal, o ninguna')
  ok(`  → porcentajes: ${suyas.map((z) => z.porcentaje).join(' + ')} = ${suyas.reduce((a, z) => a + Number(z.porcentaje), 0)}%`)

  // Y una zona puede tener VARIOS comerciales. El segundo entra como NO
  // principal: la zona tiene un responsable y gente que la cubre.
  const mpt = regiones.find((z) => z.code === 'MPT')
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje) VALUES ($1,$2,FALSE,60)`, [p1, kidal.id])
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje) VALUES ($1,$2,TRUE,100)`, [p1, mpt.id])

  const deKidal = await query('SELECT es_principal FROM com_comercial_zonas WHERE zona_id = $1', [kidal.id])
  if (deKidal.length === 2) ok('una zona puede tener 2 comerciales')
  else mal(`Kidal tiene ${deKidal.length}, esperaba 2`)
  if (deKidal.filter((z) => z.es_principal).length === 1) ok('  → y UNO solo es responsable')
  else mal('  → Kidal no tiene exactamente un responsable')

  // Dos responsables en la MISMA zona: el índice lo tiene que impedir.
  try {
    await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal) VALUES ($1,$2,TRUE)`, [p2, kidal.id])
    mal('se ha permitido DOS responsables en la misma zona')
  } catch { ok('una zona NO puede tener dos responsables: `uniq_zona_responsable` lo impide') }

  // Dos veces la misma zona: no.
  try {
    await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id) VALUES ($1,$2)`, [p2, gao.id])
    mal('se ha permitido la misma zona dos veces para el mismo comercial')
  } catch { ok('un comercial NO puede llevar dos veces la misma zona') }
}

// ─── Objetivos de zona, separados de los de comercial ─────────────────────
titulo('5 · LOS OBJETIVOS, SEPARADOS')

const tablas = new Set((await query(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'com_objetivos%'")).map((t) => t.tablename))
if (tablas.has('com_objetivos')) ok('com_objetivos (por comercial, de la 027) sigue ahí')
else mal('com_objetivos ha desaparecido')
if (tablas.has('com_objetivos_zona')) ok('com_objetivos_zona (por zona, nueva)')
else mal('falta com_objetivos_zona')

// Mismo periodo, dos objetivos distintos: no se mezclan.
if (p2) {
  const hoy = new Date()
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0)

  const oCom = await one(
    `INSERT INTO com_objetivos (comercial_id, period_start, period_end, target_amount)
     VALUES ($1,$2,$3,123456) RETURNING id`,
    [p2, ini.toISOString().slice(0, 10), fin.toISOString().slice(0, 10)],
  )
  const oZona = await one(
    `INSERT INTO com_objetivos_zona (zona_id, period_start, period_end, target_amount)
     VALUES ($1,$2,$3,999999) RETURNING id`,
    [gao.id, ini.toISOString().slice(0, 10), fin.toISOString().slice(0, 10)],
  )

  // Son de TABLAS DISTINTAS, así que los ids pueden coincidir sin que sean la
  // misma fila. Lo que hay que mirar es que cada uno está en su tabla.
  const ambos = await one(`SELECT
      (SELECT count(*) FROM com_objetivos    WHERE id = $1) AS en_comercial,
      (SELECT count(*) FROM com_objetivos_zona WHERE id = $2) AS en_zona`, [oCom?.id, oZona?.id])
  if (Number(ambos?.en_comercial) === 1 && Number(ambos?.en_zona) === 1) {
    ok(`los dos objetivos conviven en tablas distintas: comercial #${oCom?.id} y zona #${oZona?.id}`)
  } else {
    mal(`objetivos mal repartidos: comercial ${JSON.stringify(ambos?.en_comercial)}, zona ${JSON.stringify(ambos?.en_zona)}`)
  }
  const sig = await one('SELECT count(*) n FROM com_objetivos_zona')
  if (Number(sig.n) === 1) ok('y com_objetivos_zona tiene UNO solo: los del comercial no se han colado aquí')
  else mal(`com_objetivos_zona tiene ${sig.n} filas`);

  // Los datos de un objetivo vacío en zona.
  try {
    await query(
      `INSERT INTO com_objetivos_zona (zona_id, period_start, period_end) VALUES ($1,$2,$3)`,
      [kidal.id, '2030-01-01', '2030-01-31'],
    )
    mal('una zona puede tener un objetivo que no mide nada')
  } catch { ok('un objetivo de zona vacío lo rechaza la BASE') }

  // La ficha de la zona lee el suyo, no el del comercial.
  const fichaGao = (await one("SELECT * FROM com_ficha_zona() WHERE code = 'GAO'"))
  if (Number(fichaGao?.target_amount) === 999999) ok('la ficha de la zona lee el objetivo DE LA ZONA (999.999)')
  else mal(`la ficha de la zona dice ${fichaGao?.target_amount}, esperaba 999999`)

  // Kidal no tiene objetivo propio, pero COMERCIAL sí. La ficha de ZONA no
  // puede coger el del comercial: si lo hiciera, Kidal saldría con un
  // objetivo que nadie le puso.
  const fichaKdl = (await one("SELECT * FROM com_ficha_zona() WHERE code = 'KDL'"))
  if (fichaKdl?.tiene_objetivo === false) {
    ok('Kidal sin objetivo PROPIO, aunque su comercial tenga el suyo')
  } else {
    mal(`Kidal dice tener objetivo ${fichaKdl?.tiene_objetivo} y el suyo es ${fichaKdl?.objetivo}`)
  }
  if (fichaKdl && fichaKdl.cumplimiento_pct === null) {
    ok(`Kidal sin objetivo: tiene_objetivo=${fichaKdl.tiene_objetivo}, cumplimiento=${fichaKdl.cumplimiento_pct} («${fichaKdl.cumplimiento_texto}»)`)
  } else {
    mal(`Kidal sin objetivo sale ${fichaKdl?.tiene_objetivo}/${fichaKdl?.cumplimiento_pct}`)
  }

  // Y la ficha dice cuántos comerciales tiene, leídos de la tabla de varias.
  if (Number(fichaKdl?.comerciales_asignados) === 2) ok(`Kidal declara ${fichaKdl.comerciales_asignados} comerciales`)
  else mal(`Kidal declara ${fichaKdl?.comerciales_asignados} comerciales, esperaba 2`)
}

// ─── El aislamiento sigue ─────────────────────────────────────────────────
titulo('6 · AISLAMIENTO Y LO QUE NO SE TOCÓ')

const fks = await query(`
  SELECT tc.table_name AS desde, ccu.table_name AS hacia
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name LIKE 'com\\_%'`)
const ERP = ['items', 'sales_orders', 'sales_order_lines', 'payments', 'stock_movements', 'lots', 'users', 'customers', 'audit_log', 'zones']
const fksFuera = fks.filter((f) => ERP.includes(f.hacia))
if (fksFuera.length === 0) ok(`ninguna clave foránea de com_* hacia el ERP (${fks.length} internas)`)
else for (const f of fksFuera) mal(`com_${f.desde} → ${f.hacia}`)

// Las de la 027 siguen intactas.
const c027 = await query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('com_zonas','com_perfiles','com_objetivos','com_visitas','com_reglas_puntos','com_puntos')")
if (c027.length === 6) ok(`las 6 tablas de la 027 siguen ahí`)
else mal(`faltan tablas de la 027: ${6 - c027.length}`)

const v027 = await query(
  "SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname IN ('com_ranking','com_progreso','com_afinidades')")
if (v027.length === 3) ok('las 3 vistas de la 027 siguen ahí')
else mal(`faltan vistas de la 027: ${3 - v027.length}`)

// ─── Limpieza ─────────────────────────────────────────────────────────────
await query('DELETE FROM com_objetivos_zona')
await query('DELETE FROM com_objetivos')
await query('DELETE FROM com_comercial_zonas')
await query('DELETE FROM com_perfiles')
await query('DELETE FROM com_visitas')

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LA 028 ESTÁ CORRECTA' : `HAY ${fallos} FALLOS`)
console.log('')
await closeDb()
process.exit(fallos === 0 ? 0 : 1)
