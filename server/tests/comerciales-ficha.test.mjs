/**
 * CRITERIOS 26 A 35 · LA FICHA DEL COMERCIAL
 *
 * Diez criterios que la especificación pidió para esta fase. Cada uno tiene su
 * comprobación, y algunos tienen un caso que DEBERÍA FALLAR para que la
 * comprobación signifique algo.
 *
 * Va contra el NÚCLEO, contra la BASE DE PRUEBAS. La prueba de integración
 * contra el servidor real es otra cosa, y va aparte.
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
const { hashPassword } = await import('../src/security/passwords.js')
const F = await import('../src/core/comerciales-ficha.js')

let fallos = 0
const ok = (t, e = '') => console.log(`  ✓ ${t}${e ? '   ' + e : ''}`)
const mal = (t, e = '') => { fallos++; console.log(`  ✗ ${t}${e ? '   ' + e : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }
const num = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol

// ─── Datos de prueba ─────────────────────────────────────────────────────────
const hash = await hashPassword('NoSeUsa.2026')
const marca = Date.now().toString(36).toUpperCase()
for (const [u, n] of [['f26a', 'Ficha A'], ['f26b', 'Ficha B'], ['f26c', 'Ficha C']]) {
  await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
               VALUES ($1,$2,$3,'es',now()) ON CONFLICT (username) DO NOTHING`,
    [u, n, hash])
}
// `await` dentro de una flecha NO asíncrona es un error de sintaxis: por eso.
const uid = async (n) => (await one('SELECT id FROM users WHERE username = $1', [n])).id

const region = (await one("SELECT id, code, name FROM com_zonas WHERE codigo = 'KAY'".replace('codigo', 'code')))

// Tres zonas, todas dentro de Kayes.
const zA = (await one(
  `INSERT INTO com_zonas (code,name,kind,parent_id,nivel) VALUES ($1,'Zona A','URBANA',$2,'ZONA') RETURNING id`,
  [`F26-A${marca}`, region.id])).id
const zB = (await one(
  `INSERT INTO com_zonas (code,name,kind,parent_id,nivel) VALUES ($1,'Zona B','RURAL',$2,'ZONA') RETURNING id`,
  [`F26-B${marca}`, region.id])).id
const zC = (await one(
  `INSERT INTO com_zonas (code,name,kind,parent_id,nivel) VALUES ($1,'Zona C','URBANA',$2,'ZONA') RETURNING id`,
  [`F26-C${marca}`, region.id])).id

// Cada comercial con SU zona principal: dos pueden cubrir la misma zona, pero
// solo uno puede ser su responsable, o el mapa no sabria cual marcar.
const alta = async (u, zona = zA) => (await one(
  `INSERT INTO com_perfiles (user_id, home_zona_id, hired_on) VALUES ($1,$2,'2024-01-01')
   ON CONFLICT (user_id) DO UPDATE SET home_zona_id = EXCLUDED.home_zona_id RETURNING id`, [await uid(u), zA]))
const pA = await alta('f26a')
const pB = await alta('f26b', zB)
const pC = await alta('f26c', zC)

// A trabaja en TRES zonas. B solo en la primera. C en una.
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
             VALUES ($1,$2,TRUE,50,CURRENT_DATE), ($1,$3,FALSE,30,CURRENT_DATE), ($1,$4,FALSE,20,CURRENT_DATE)`,
  [pA.id, zA, zB, zC])
// B cubre la Zona A, la de A, pero sin ser su responsable. Es justo el caso
// del punto 28: que compartir zona no haga desaparecer a nadie.
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
             VALUES ($1,$2,FALSE,50,CURRENT_DATE)`, [pB.id, zA])
await query(`INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
             VALUES ($1,$2,TRUE,100,CURRENT_DATE)`, [pC.id, zC])

// ═══════════════════════════════════════════════════════════════════════════
titulo('26 · TODAS SUS ZONAS, NO SOLO `home_zona_id`')

const fichaA = await F.fichaComercial(pA.id)
if (fichaA.estructura.zonas.length === 3) ok('A tiene 3 zonas')
else mal(`A tiene ${fichaA.estructura.zonas.length}, esperaban 3`)

if (fichaA.estructura.zonas.some((z) => z.id !== fichaA.comercial.homeZonaId)) {
  ok(`  → y NO solo la principal (home=${fichaA.comercial.homeZonaId})`)
} else {
  mal('  → solo sale la zona principal')
}
const sumaPct = fichaA.estructura.zonas.reduce((a, z) => a + Number(z.porcentaje), 0)
if (num(sumaPct, 100)) ok(`  → los porcentajes suman ${sumaPct} %`)
else mal(`  → suman ${sumaPct} %, no 100`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('27 · CADA ZONA MUESTRA SU REGIÓN')

if (fichaA.estructura.zonas.every((z) => z.region === 'Kayes')) ok('las tres dicen que son de Kayes')
else mal(`regiones: ${JSON.stringify(fichaA.estructura.zonas.map((z) => z.region))}`)

const regionIdEsperado = (await one("SELECT id FROM com_zonas WHERE code = 'KAY'")).id
if (fichaA.estructura.zonas.every((z) => z.regionId === regionIdEsperado)) {
  ok(`  → y con el MISMO id de región (${regionIdEsperado}), no uno inventado`)
} else {
  mal('  → algún regionId no es el de Kayes')
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('28 · VARIOS COMERCIALES EN LA MISMA ZONA, SIN QUE NINGUNO DESAPAREZCA')

const enZonaA = await F.comercialesDeZona(zA)
if (enZonaA.length === 2) ok('la Zona A tiene 2 comerciales')
else mal(`la Zona A tiene ${enZonaA.length}, esperaban 2`)

const nombres = enZonaA.map((c) => c.full_name).sort()
if (nombres.includes('Ficha A') && nombres.includes('Ficha B')) ok(`  → están los dos: ${nombres.join(', ')}`)
else mal(`  → faltan: ${nombres.join(', ')}`)

if (enZonaA.filter((c) => c.es_principal).length === 1) ok('  → y UNO solo es responsable')
else mal('  → hay más de un responsable, o ninguno')

// Y el que tiene tres zonas no se pierde por compartir la principal con otro.
const fichaB = await F.fichaComercial(pB.id)
if (fichaB.estructura.zonas.length === 1) ok('Ficha B conserva su zona aunque A sea el responsable de la misma')
else mal(`Ficha B tiene ${fichaB.estructura.zonas.length} zonas`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('29 Y 30 · LOS CLIENTES, EN DOS APARTADOS Y SIN MEZCLAR')

// Un cliente asignado A, uno asignado a B, y uno sin comercial.
const cli = async (nombre, comercialUserId) => (await one(
  `INSERT INTO customers (code, qr_token, name, comercial_id, zone_id)
   VALUES ($1,$2,$3,$4,NULL) RETURNING id`,
  [`CL-F26-${nombre}-${marca}`, `f26${marca}${nombre}`.slice(0, 24), nombre,
    comercialUserId == null ? null : await uid(comercialUserId)])).id

const asignadoA = await cli('Asignado-A', 'f26a')
const asignadoB = await cli('Asignado-B', 'f26b')
const sinComercial = await cli('Sin-comercial', null)

// Con clientes de verdad en la base de pruebas.
const fichaConDatos = await F.fichaComercial(pA.id)
const enAsignados = fichaConDatos.estructura.clientesAsignados.map((c) => c.id)
const enZonasLista = fichaConDatos.estructura.clientesDeZonas.map((c) => c.id)

if (enAsignados.includes(asignadoA)) ok('el cliente asignado a A sale en ASIGNADOS')
else mal('el cliente de A no sale en asignados')
if (enAsignados.includes(asignadoB)) mal('el cliente de B se ha colado en los asignados de A')
else ok('  → el de B NO se ha colado')
if (enAsignados.includes(sinComercial)) mal('un cliente sin comercial aparece como asignado')
else ok('  → y el que no tiene comercial tampoco')

// 30 · NADIE se vuelve «de la zona» por estar asignado.
if (!enZonasLista.includes(asignadoA)) ok('  → y el de A tampoco se duplica como «de la zona»')
else mal('  → el cliente asignado aparece en los DOS apartados')

//
// Y si un cliente está en la zona de A pero es de B, sale como de zona.
//
// `customers.zone_id` apunta a la tabla `zones` DEL ERP, y las zonas de aquí
// son de `com_zonas`. El puente es el CÓDIGO, y para la prueba hace falta una
// fila equivalente en el ERP.
//
// ESO ES EXACTAMENTE LA CONEXIÓN QUE PIDE LA FASE 3. Aquí se crea solo para
// poder comprobar el criterio 30, y en la prueba, no en el ERP.
//
const erpA = (await one(
  `INSERT INTO zones (code, name, kind) VALUES ($1,$2,'REGION')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  [`F26-A${marca}`, 'Zona A (ERP)'])).id

const cliEnZona = (await one(
  `INSERT INTO customers (code, qr_token, name, comercial_id, zone_id)
   VALUES ($1,$2,'De-otra-zona-en-la-de-A',$3,$4) RETURNING id`,
  [`CL-F26-DZ-${marca}`, `f26dz${marca}x`.slice(0, 24), await uid('f26b'), erpA])).id

const ficha2 = await F.fichaComercial(pA.id)
const comoDeZona = ficha2.estructura.clientesDeZonas.find((c) => c.id === cliEnZona)
if (comoDeZona && comoDeZona.origen === 'DE_ZONA' && comoDeZona.esPropio === false) {
  ok(`un cliente en la zona de A pero de B sale como «DE_ZONA», no asignado`)
} else {
  mal(`un cliente de la zona de A: ${JSON.stringify(comoDeZona)?.slice(0, 80)}`)
}
if (!ficha2.estructura.clientesAsignados.some((c) => c.id === cliEnZona)) {
  ok('  → y NO como asignado a A, que es de B')
} else {
  mal('  → y aparece también como asignado a A: eso sería inventar una cartera')
}
if (comoDeZona?.comercialNombre === 'Ficha B') ok(`  →Dice su dueño real: ${comoDeZona.comercialNombre}`)
else mal(`  → su comercial sale ${comoDeZona?.comercialNombre}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('31 · SIN RELACIÓN FIABLE CLIENTE → ZONA, NO SE INVENTA')

const sinNada = await F.fichaComercial(pC.id)
if (sinNada.estructura.clientesDeZonasDisponibles === false) ok('declara que no hay clientes de zona disponibles')
else mal('declara que sí, sin tener datos')

if (sinNada.estructura.motivoSinClientesDeZona) {
  ok(`  → y explica por qué: «${String(sinNada.estructura.motivoSinClientesDeZona).slice(0, 70)}…»`)
} else {
  mal('  → y no explica por qué: una lista vacía sin motivo parece un fallo')
}

if (sinNada.estructura.motivoSinClientesAsignados) {
  ok(`  → y también el de asignados: «${String(sinNada.estructura.motivoSinClientesAsignados).slice(0, 60)}…»`)
} else {
  mal('  → no explica por qué no hay asignados')
}

// Y ninguna función ha escrito en customers.
//
// Los clientes que hay son EXACTAMENTE los tres que la prueba ha creado a
// mano. Si la ficha hubiera rellenado un `comercial_id` o un `zone_id` por su
// cuenta, saldrían clientes nuevos o con valores que nadie puso.
//
const antesDeLaFicha = new Set([asignadoA, asignadoB, sinComercial, cliEnZona])
const todosAhora = (await query(
  `SELECT id, comercial_id, zone_id FROM customers WHERE code LIKE 'CL-F26-%'`))
if (todosAhora.length === 4) ok('hay 4 clientes: los 4 que la prueba creó a mano')
else mal(`hay ${todosAhora.length}: la ficha ha creado clientes`)

const tocados = todosAhora.filter((c) => !antesDeLaFicha.has(c.id))
if (tocados.length === 0) ok('  → ninguno creado por la ficha')
else mal(`  → la ficha ha creado ${tocados.length}`)

// Y que los que tienen comercial siguen teniendo EXACTAMENTE el que la
// prueba les puso: ni uno más, ni uno menos.
const conComAsignado = todosAhora.filter((c) => c.comercial_id != null)
if (conComAsignado.length === 3) ok('  → y los 3 con comercial siguen siendo los que la prueba asignó')
else mal(`  → hay ${conComAsignado.length} con comercial`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('32 · UN COMERCIAL QUE NO EXISTE, ERROR CONTROLADO')

for (const [n, id] of [['inexistente', 999999], ['id no numérico', 'abc'], ['id cero', 0]]) {
  try {
    await F.fichaComercial(id)
    mal(`${n}: ha devuelto algo en vez de un error`)
  } catch (e) {
    if (e.codigo && e.estado >= 400 && e.estado < 500) {
      ok(`${n} → ${e.estado} ${e.codigo}: «${String(e.message).slice(0, 48)}»`)
    } else {
      mal(`${n} → error sin código o con estado raro: ${e.codigo}/${e.estado}`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('33 · LOS FILTROS TOCAN LO TEMPORAL Y SOLO LO TEMPORAL')

const mes = await F.fichaComercial(pA.id, { periodo: 'MES' })
const anio = await F.fichaComercial(pA.id, { periodo: 'ANIO' })
const personal = await F.fichaComercial(pA.id, {
  periodo: 'PERSONALIZADO', desde: '2020-01-01', hasta: '2020-01-31',
})

for (const [nombre, f] of [['mes', mes], ['año', anio], ['personalizado', personal]]) {
  if (f.estructura.zonas.length === 3) ok(`${nombre}: sigue con sus 3 zonas`)
  else mal(`${nombre}: le quedan ${f.estructura.zonas.length} zonas`)

  if (f.comercial.nombre === mes.comercial.nombre) ok(`  → y con el mismo nombre (${f.comercial.nombre})`)
  else mal(`  → el nombre cambia con el periodo`)
}

// Y lo temporal SÍ cambia.
if (personal.metricas.visitas !== mes.metricas.visitas) {
  ok(`  → las visitas SÍ cambian: mes ${mes.metricas.visitas}, 2020 ${personal.metricas.visitas}`)
} else {
  ok(`  → las visitas de 2020 son 0, como no hay datos de entonces`)
}
if (personal.periodo.desde === '2020-01-01') ok(`  → y el periodo devuelto es el que se pidió`)
else mal(`  → devuelve ${personal.periodo.desde}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('34 · LAS MÉTRICAS VIENEN DE LAS FUNCIONES, NO DE OTRO CÁLCULO')

const comercialId = pA.id
const h = await one('SELECT * FROM com_hechos($1::int, $2::date, $3::date)', [comercialId, mes.periodo.desde, mes.periodo.hasta])
const pt = await one('SELECT com_puntos_de($1::int, $2::date, $3::date) AS p', [comercialId, mes.periodo.desde, mes.periodo.hasta])

if (num(mes.metricas.ventas, h.importe)) ok(`ventas = com_hechos(): ${mes.metricas.ventas}`)
else mal(`ventas ${mes.metricas.ventas} vs com_hechos ${h.importe}`)
if (num(mes.metricas.visitas, h.visitas)) ok(`visitas = com_hechos(): ${mes.metricas.visitas}`)
else mal(`visitas ${mes.metricas.visitas} vs ${h.visitas}`)
if (num(mes.metricas.puntos, pt.p)) ok(`puntos = com_puntos_de(): ${mes.metricas.puntos}`)
else mal(`puntos ${mes.metricas.puntos} vs ${pt.p}`)

// Y sin objetivo, el guion — no un cero.
const sinObj = await F.fichaComercial(pC.id, { periodo: 'MES' })
if (sinObj.metricas.cumplimientoTexto === '—') ok(`sin objetivo → «${sinObj.metricas.cumplimientoTexto}», no 0 %`)
else mal(`sin objetivo sale «${sinObj.metricas.cumplimientoTexto}»`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('35 · LAS RESTRICCIONES DE LA FASE 1 SIGUEN EN PIE')

const nivelIncoherente = await query(
  `SELECT count(*) AS n FROM com_zonas
    WHERE (nivel = 'REGION' AND parent_id IS NOT NULL) OR (nivel = 'ZONA' AND parent_id IS NULL)`)
if (Number(nivelIncoherente[0].n) === 0) ok('ninguna zona con nivel incoherente')
else mal(`${nivelIncoherente[0].n} zonas con nivel incoherente`)

const dosResponsables = await query(
  `SELECT zona_id, count(*) AS n FROM com_comercial_zonas
    WHERE es_principal AND hasta IS NULL GROUP BY zona_id HAVING count(*) > 1`)
if (dosResponsables.length === 0) ok('ninguna zona con dos responsables')
else mal(`zonas con dos responsables: ${dosResponsables.map((z) => z.zona_id).join(', ')}`)

const dosPrincipales = await query(
  `SELECT comercial_id, count(*) AS n FROM com_comercial_zonas
    WHERE es_principal AND hasta IS NULL GROUP BY comercial_id HAVING count(*) > 1`)
if (dosPrincipales.length === 0) ok('ningún comercial con dos zonas principales')
else mal('comerciales con dos principales: ' + dosPrincipales.map((z) => z.comercial_id).join(', '))

const nueve = await one("SELECT count(*) AS n FROM com_zonas WHERE nivel = 'REGION'")
if (Number(nueve.n) === 9) ok('siguen siendo 9 regiones')
else mal(`hay ${nueve.n} regiones`)

// ═══════════════════════════════════════════════════════════════════════════
// Limpieza
// ═══════════════════════════════════════════════════════════════════════════
await query(`DELETE FROM customers WHERE code LIKE 'CL-F26-%'`)
await query('DELETE FROM com_comercial_zonas WHERE comercial_id = ANY($1::int[])', [[pA.id, pB.id, pC.id]])
await query('DELETE FROM com_perfiles WHERE id = ANY($1::int[])', [[pA.id, pB.id, pC.id]])
await query('DELETE FROM com_zonas WHERE code LIKE $1', [`F26-%${marca}`])
await query('DELETE FROM zones WHERE id = $1', [erpA])
await query('DELETE FROM users WHERE username = ANY($1::text[])', [['f26a', 'f26b', 'f26c']])

titulo(fallos === 0 ? 'LOS CRITERIOS 26 A 35 ESTÁN VERIFICADOS' : `HAY ${fallos} FALLOS`)
console.log('')
await closeDb()
process.exit(fallos === 0 ? 0 : 1)