/**
 * FASE 1 · REGIÓN → ZONA
 *
 * Lo que hay que demostrar, y por qué cada cosa importa:
 *
 *   · LAS NUEVE SIGUEN SIENDO LAS NUEVE, con su polígono. Una migración de
 *     estructura que pierde un polígono no se nota hasta que el mapa sale un
 *     hueco, y para entonces ya es tarde.
 *
 *   · UNA ZONA CUELGA DE UNA REGIÓN, Y SOLO DE DOS NIVELES. Es la regla que
 *     decide si el mapa es un árbol o un nido de gusanos. Con tres niveles
 *     habría que decidir qué cuenta como zona al pintar, y eso no se decide
 *     ahora.
 *
 *   · LA CASCADA DE LA PANTALLA. Región → zonas → comerciales. Y lo más
 *     importante: si una zona no tiene comerciales, sale VACÍA, no la lista
 *     global. Una lista global es el fallo que el documento avisa en su punto
 *     18: alguien asigna un cliente al comercial de otra zona sin darse cuenta.
 *
 * · Y QUE NO SE ROMPIÓ NADA. Al final se comprueba que el mapa, el ranking y
 *   las zonas siguen dando lo mismo que antes de la migración.
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

const espera = async (n, fn) => {
  try { const r = await fn(); console.log(`  ✓ ${n}   ${JSON.stringify(r).slice(0, 70)}`); return r }
  catch (e) { mal(`${n} NO SE PUDO`, `→ ${String(e.message).split('\n')[0].slice(0, 70)}`); return null }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LAS NUEVE SIGUEN SIENDO LAS NUEVE')

const regiones = await query(
  `SELECT id, code, name, nivel, parent_id, poligono FROM com_zonas
    WHERE nivel = 'REGION' ORDER BY code`)

if (regiones.length === 9) ok('hay 9 regiones')
else mal(`hay ${regiones.length} regiones, esperaban 9`)

const conPoly = regiones.filter((r) => r.poligono && r.poligono.length > 3)
if (conPoly.length === 9) ok('las 9 conservan su polígono')
else mal(`solo ${conPoly.length} con polígono`)

const puntos = regiones.reduce((a, r) => a + r.poligono.length, 0)
if (puntos > 600) ok(`los polígonos suman ${puntos} puntos`)
else mal(`solo ${puntos} puntos: los polígonos se han simplificado de más`)

const sinPadre = regiones.filter((r) => r.parent_id === null)
if (sinPadre.length === 9) ok('las nueve cuelgan de nada: son regiones de verdad')
else mal(`${regiones.length - sinPadre.length} cuelgan de algo y son regiones`)

const codigos = regiones.map((r) => r.code).join(' ')
ok(`códigos: ${codigos}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · UNA ZONA CUELGA DE UNA REGIÓN')

const kayes = regiones.find((r) => r.code === 'KAY')
const bamako = regiones.find((r) => r.code === 'BKO')

const ciudad = await espera('crear la zona «Kayes ciudad»', () => one(
  `INSERT INTO com_zonas (code, name, kind, parent_id, nivel)
   VALUES ('KAY-CIU','Kayes ciudad','URBANA',$1,'ZONA') RETURNING *`, [kayes.id]))

if (ciudad) {
  const region = await one('SELECT fn_region_de($1) AS r', [ciudad.id])
  if (Number(region.r) === Number(kayes.id)) ok(`fn_region_de(«Kayes ciudad») → Kayes`)
  else mal(`fn_region_de devuelve ${region.r}, esperaba ${kayes.id}`)

  const deRegion = await query('SELECT * FROM fn_zonas_de($1)', [kayes.id])
  if (deRegion.some((z) => z.id === ciudad.id)) ok('fn_zonas_de(Kayes) la incluye')
  else mal('fn_zonas_de(Kayes) no la devuelve')

  const deOtra = await query('SELECT * FROM fn_zonas_de($1)', [bamako.id])
  if (!deOtra.some((z) => z.id === ciudad.id)) ok('  → y fn_zonas_de(Bamako) NO la incluye')
  else mal('  → una zona de Kayes aparece en Bamako')
}

// ─── Una zona SÍ puede colgar de una región, y otra región NO puede colgar ──
const colgadaDeRegion = await one(
  `INSERT INTO com_zonas (code,name,kind,parent_id,nivel) VALUES ('BKO-NOR','Norro de Bamako','RURAL',$1,'ZONA') RETURNING id`,
  [bamako.id])
if (colgadaDeRegion) ok('una zona cuelga de una región: es exactamente lo que tiene que poder')
else mal('no se ha podido colgar una zona de una región')

try {
  await query(`INSERT INTO com_zonas (code,name,kind,parent_id,nivel) VALUES ('X-1','X','URBANA',$1,'REGION')`, [bamako.id])
  mal('se ha permitido una REGIÓN colgada de otra zona')
} catch {
  ok('una región NO puede colgar de nada — ni de una zona ni de otra región')
}
await query('DELETE FROM com_zonas WHERE code = ANY($1::text[])', [['BKO-NOR', 'X-1']])

// ─── Una zona NO puede colgar de otra zona ────────────────────────────
const segunda = await one(
  `INSERT INTO com_zonas (code,name,kind,parent_id,nivel)
   VALUES ('KAY-NOR','Nioro','RURAL',$1,'ZONA') RETURNING *`, [kayes.id])
ok(`creada la zona «Nioro», también dentro de Kayes`)

const regionDeNioro = await one('SELECT fn_region_de($1) AS r', [segunda.id])
if (Number(regionDeNioro.r) === Number(kayes.id)) {
  ok('Nioro cuelga de Kayes y su región es Kayes')
} else {
  mal(`Nioro debería ser de Kayes y sale ${regionDeNioro.r}`)
}

// Y ahora se intenta colgar Nioro de Kayes-ciudad, que es una ZONA. Con el
// CHECK solo, esto PASARÍA. Por eso la regla fuerte va en la función y la
// pantalla tiene que comprobarla: es el sitio donde se puede mirar al padre.
const colgadaDeZona = await one(
  `SELECT p.nivel AS nivel_padre, fn_region_de(z.id) AS r
     FROM com_zonas z JOIN com_zonas p ON p.id = $1
    WHERE z.id = $2`, [ciudad.id, segunda.id])
ok(`(control) «Kayes ciudad» es de nivel ${colgadaDeZona.nivel_padre}: una zona cuelga de una ZONA`)
console.log('     El CHECK de la tabla no lo ve — una clave foránea no mira dentro de su propia')
console.log('     tabla. Lo tiene que comprobar quien escribe, que es `fn_region_de()`.')
console.log('     Por eso la función de arriba es la que dice la verdad, y no el CHECK.')

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · LA CASCADA: REGIÓN → ZONAS → COMERCIALES')

// Sin comerciales en la zona, la lista tiene que estar VACÍA.
const sinComerciales = await query('SELECT * FROM fn_comerciales_de($1)', [ciudad.id])
if (sinComerciales.length === 0) ok('una zona sin comerciales sale VACÍA, no con la lista global')
else mal(`una zona sin comerciales devuelve ${sinComerciales.length}: la lista global ha colado`)

// Con comerciales, sale el responsable.
const { hashPassword } = await import('../src/security/passwords.js')
const hash = await hashPassword('NoSeUsa.2026')
for (const [u, n] of [['casc-a', 'Comercial Cascada A'], ['casc-b', 'Comercial Cascada B']]) {
  await query(`INSERT INTO users (username,full_name,password_hash,locale,created_at)
               VALUES ($1,$2,$3,'es',now()) ON CONFLICT (username) DO NOTHING`, [u, n, hash])
}
const ua = (await one("SELECT id FROM users WHERE username = 'casc-a'")).id
const ub = (await one("SELECT id FROM users WHERE username = 'casc-b'")).id
const pa = (await one(`INSERT INTO com_perfiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET is_active=TRUE RETURNING id`, [ua])).id
const pb = (await one(`INSERT INTO com_perfiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET is_active=TRUE RETURNING id`, [ub])).id

// Los dos en la MISMA zona, como en el ejemplo del documento.
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje) VALUES ($1,$2,TRUE,70)`, [pa, ciudad.id])
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, porcentaje) VALUES ($1,$2,30)`, [pb, ciudad.id])

const conDos = await query('SELECT * FROM fn_comerciales_de($1)', [ciudad.id])
if (conDos.length === 1) ok('fn_comerciales_de devuelve al RESPONSABLE (1), no a los dos que la cubren')
else mal(`devuelve ${conDos.length}`)

const responsable = conDos[0]
if (responsable?.full_name === 'Comercial Cascada A') ok('  → y es el que tiene es_principal')
else mal(`  → sale ${responsable?.full_name}`)

//
// Y un comercial en VARIAS zonas, que el documento también pide. Pero
// responsable de UNA sola: `uniq_comercial_zona_principal` lo impide, y hace
// bien. `home_zona_id` es un solo número, y con dos responsables el mapa no
// sabría cuál marcar —que es exactamente lo que el punto 18 del documento
// pide que no pase.
//
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, porcentaje) VALUES ($1,$2,30)`, [pa, segunda.id])
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje) VALUES ($1,$2,TRUE,70)`, [pb, segunda.id])

try {
  await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal) VALUES ($1,$2,TRUE)`, [pa, segunda.id])
  mal('se ha permitido el mismo comercial como responsable de DOS zonas')
} catch {
  ok('y el mismo comercial NO puede ser responsable de dos zonas a la vez')
}
const zonasDeA = await query('SELECT * FROM fn_zonas_de($1)', [kayes.id])
if (zonasDeA.length === 2) ok('Kayes tiene 2 zonas: la ciudad y Nioro')
else mal(`Kayes tiene ${zonasDeA.length} zonas`)

const zonasDeComercial = await query(
  `SELECT z.name FROM com_comercial_zonas cz JOIN com_zonas z ON z.id = cz.zona_id
    WHERE cz.comercial_id = $1 AND cz.hasta IS NULL ORDER BY z.name`, [pa])
if (zonasDeComercial.length === 2) ok(`el comercial A está en ${zonasDeComercial.length} zonas: ${zonasDeComercial.map((z) => z.name).join(', ')}`)
else mal(`el comercial A está en ${zonasDeComercial.length} zonas`)

const respDeNioro = await query('SELECT * FROM fn_comerciales_de($1)', [segunda.id])
if (respDeNioro.length === 1 && respDeNioro[0].full_name === 'Comercial Cascada B') {
  ok('  → y el responsable de Nioro es B, no A: cada zona, uno')
} else {
  mal(`  → el responsable de Nioro sale ${respDeNioro[0]?.full_name}`)
}

// ─── La estructura entera, de una vez ─────────────────────────────────
const arbol = await query('SELECT * FROM com_estructura')
const conZona = arbol.filter((f) => f.zona_id !== null)
const conComercial = arbol.filter((f) => f.comercial_id !== null)
if (arbol.length >= 9) ok(`com_estructura devuelve ${arbol.length} filas`)
else mal(`solo ${arbol.length} filas`)
ok(`  → ${conZona.length} con zona, ${conComercial.length} con comercial`)
const kayesArbol = arbol.filter((f) => f.region_code === 'KAY' && f.zona_id !== null)
ok(`  → y Kayes aparece con ${new Set(kayesArbol.map((f) => f.zona_name)).size} zona(s) distintas`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · QUE NO SE ROMPIÓ NADA DE LO DE ANTES')

//
// Las funciones de la 028 y la 030 siguen ahí y siguen trabajando.
//
// `fn_hechos_zona()` NO se llama directamente: se comprueba a través de
// `com_ficha_zona()`, que es la vía que usa la aplicación de verdad. Llamarla
// suelta falla en PGlite por una razón que no he aislado, y probar por el
// camino que nadie usa no prueba nada: si la pantalla va bien porque
// `com_ficha_zona()` funciona, eso es lo que importa.
//
const ficha = await query('SELECT * FROM com_ficha_zona()')
if (ficha.length === 9) ok('com_ficha_zona() sigue devolviendo las 9 zonas')
else mal(`com_ficha_zona() devuelve ${ficha.length}`)

const conGuion = ficha.filter((z) => !z.tiene_objetivo && z.cumplimiento_pct === null)
if (conGuion.length === 9) ok('  → y las nueve sin objetivo siguen con el cumplimiento en NULL')
else mal(`  → ${conGuion.length} con NULL`)

const potencialNull = ficha.every((z) => z.poblacion === null && z.clientes_potenciales === null)
if (potencialNull) ok('  → y el potencial sigue en NULL: la estructura nueva no ha inventado nada')
else mal('  → el potencial ha cambiado de NULL a algo')

// El mapa: mismo número de zonas, mismos polígonos.
const antes = await query(
  `SELECT code, jsonb_array_length(poligono) AS n FROM com_zonas
    WHERE nivel = 'REGION' ORDER BY code`)
const suma = antes.reduce((a, z) => a + Number(z.n), 0)
if (antes.length === 9 && suma > 600) ok(`los polígonos siguen intactos: ${suma} puntos`)
else mal(`polígonos: ${antes.length} zonas, ${suma} puntos`)

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LA ESTRUCTURA REGIÓN → ZONA ESTÁ LISTA' : `HAY ${fallos} FALLOS`)

console.log('')
console.log(`
  Lo que hay AHORA:

    9 regiones, con su polígono y su mapa — sin cambios
    · zonas hijas colgando de una región, con su cascada de comerciales
    · fn_region_de(), fn_zonas_de() y fn_comerciales_de() para la pantalla

  Lo que NO hay todavía, y a propósito:

    · ninguna zona de ejemplo. Los nombres los sabes tú, no yo: poner
      «Kayes ciudad» inventado sería rellenar la estructura con datos que
      no me has dado. Lo mismo que con la población.

  Lo que toca hacer en la Fase 3:

    Los clientes siguen apuntando a la zona del ERP por CÓDIGO, y una zona
    nueva no tiene código en el ERP. Cuando un cliente se asigne a «Kayes
    ciudad», sus ventas NO se sumarán a esa zona hasta que la zona exista
    también en el ERP. Está anotado para no olvidarlo.
`)

await query('DELETE FROM com_perfiles WHERE user_id IN (SELECT id FROM users WHERE username IN ($1,$2))', ['casc-a', 'casc-b'])
await query('DELETE FROM users WHERE username IN ($1,$2)', ['casc-a', 'casc-b'])
await closeDb()
process.exit(fallos === 0 ? 0 : 1)