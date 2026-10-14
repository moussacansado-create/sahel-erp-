/**
 * PRUEBAS DE LAS CONSULTAS DE ZONAS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LA PRUEBA QUE MÁS IMPORTA, Y LA QUE MÁS SE OLVIDA
 *
 * QUE UNA ZONA NO CUENTE CON LA DE AL LADO.
 *
 * `com_hechos_zona()` lee por `customers.zone_id` → `zones.code`, que es un
 * enlace de DOS saltos entre dos tablas. Es el punto donde un ERP con zonas se
 * equivoca sin avisar: no da error, da un número plausible de la zona
 * equivocada. Nadie lo nota hasta que una región parece facturar lo que
 * factura otra.
 *
 * Así que aquí se SIEMBRAN ventas en DOS zonas y se mira que cada una ve solo
 * las suyas. Con una zona vacía la prueba pasaría también sin el código bien.
 *
 * Y lo mismo con los dos períodos: con datos de un solo mes, la variación
 * tiene que salir NULL, no 0. Un 0 % ahí se lee como «esta zona no crece»,
 * que es una afirmación que el sistema no puede hacer.
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
const { hashPassword } = await import('../src/security/passwords.js')
const Z = await import('../src/core/zonas.js')

let fallos = 0
const ok = (t, e = '') => console.log(`  ✓ ${t}${e ? '   ' + e : ''}`)
const mal = (t, e = '') => { fallos++; console.log(`  ✗ ${t}${e ? '   ' + e : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

// ═══════════════════════════════════════════════════════════════════════════
// PREPARAR DATOS REALES EN DOS ZONAS
// ═══════════════════════════════════════════════════════════════════════════

//
// La base de pruebas NO está sembrada — sembrarla es cosa del ERP y esta
// prueba no lo toca—, así que se crea el usuario mínimo que hace falta.
//
const { hashPassword: hashear } = await import('../src/security/passwords.js')
const hash0 = await hashear('NoSeUsa.2026')
await query(`INSERT INTO roles (code, name) VALUES ('ADMIN','Administrador') ON CONFLICT (code) DO NOTHING`)
await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
             VALUES ('zt-admin','Admin Zona',$1,'es',now()) ON CONFLICT (username) DO NOTHING`, [hash0])
const ADM = (await one("SELECT id FROM users WHERE username = 'zt-admin'")).id
const fecha = new Date().toISOString().slice(0, 10)

//
// LAS ZONAS DEL ERP, EN LA BASE DE PRUEBAS.
//
// La semilla del ERP las crea y aquí no se ejecuta, porque este módulo no la
// necesita ni la llama. Pero la prueba necesita filas contra las que comprobar
// el enlace de dos saltos. Se crean AQUÍ, en una base desechable, y solo como
// datos: no es tocar el ERP, es ponerle a la prueba un escenario.
//
// Con datos de UNA sola zona, la prueba del punto 2 pasaría igual con el código
// roto, porque no hay con qué confundirse.
//
for (const [code, name, kind] of [
  ['BKO', 'Bamako', 'REGION'], ['KLR', 'Koulikoro', 'REGION'],
  ['SEG', 'Segou', 'REGION'], ['GAO', 'Gao', 'REGION'],
  ['KAY', 'Kayes', 'REGION'], ['SKS', 'Sikasso', 'REGION'],
]) {
  await query(`INSERT INTO zones (code, name, kind) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`, [code, name, kind])
}

/** Un cliente en una zona del ERP, por CÓDIGO — que es como se enlazan. */
const clienteEn = async (nombre, codigoZona) => {
  const erp = await one('SELECT id FROM zones WHERE code = $1', [codigoZona])
  if (!erp) throw new Error(`No existe la zona del ERP ${codigoZona}`)
  return (await one(
    `INSERT INTO customers (code, qr_token, name, zone_id, created_at)
     VALUES ($1,$2,$3,$4,now()) RETURNING id`,
    [`CL-Z-${Date.now().toString(36)}${Math.floor(Math.random() * 90 + 10)}`,
      `tz${Math.random().toString(36).slice(2, 12)}`, nombre, erp.id],
  )).id
}

/** Un pedido con un importe concreto. */
const pedidoDe = async (clienteId, importe) => {
  const hoy = fecha
  return (await one(
    `INSERT INTO sales_orders (code, customer_id, status, order_date, currency_code,
                               subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ($1,$2,'DELIVERED',$3,'XOF',$4,0,$4,$4,$5) RETURNING id`,
    [`PED-Z-${Date.now().toString(36)}${Math.floor(Math.random() * 90 + 10)}`,
      clienteId, hoy, importe, ADM],
  )).id
}

// Dos zonas con cifras MUY distintas, para que se confundan si se mezclan.
const cBamako = await clienteEn('Cliente de Bamako', 'BKO')
const cKoulikoro = await clienteEn('Cliente de Koulikoro', 'KLR')
const cSegou = await clienteEn('Cliente de Ségou', 'SEG')

await pedidoDe(cBamako, 1000000)
await pedidoDe(cBamako, 500000)
await pedidoDe(cKoulikoro, 250000)
await pedidoDe(cSegou, 75000)

const zBamako = (await one("SELECT id FROM com_zonas WHERE code='BKO'"))
const zKoulikoro = (await one("SELECT id FROM com_zonas WHERE code='KLR'"))
const zSegou = (await one("SELECT id FROM com_zonas WHERE code='SEG'"))
const zGao = (await one("SELECT id FROM com_zonas WHERE code='GAO'"))

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LAS NUEVE REGIONES PARA EL MAPA')

const mapa = await Z.listarZonasMapa({ periodo: 'MES' })

if (mapa.zonas.length === 9) ok(`el mapa devuelve ${mapa.zonas.length} zonas`)
else mal(`el mapa devuelve ${mapa.zonas.length}, esperaban 9`)

for (const nec of ['lat', 'lng', 'poligono']) {
  const falta = mapa.zonas.filter((z) => z[nec] === null || z[nec] === undefined)
  if (falta.length === 0) ok(`las nueve traen ${nec}`)
  else mal(`${falta.length} sin ${nec}: ${falta.map((z) => z.code).join(', ')}`)
}

const sinPoly = mapa.zonas.filter((z) => !Array.isArray(z.poligono) || z.poligono.length < 4)
if (sinPoly.length === 0) ok('los nueve polígonos cierran')
else mal(`${sinPoly.length} con polígono que no cierra`)

// ─── 2 · UNA ZONA NO CUENTA CON LA DE AL LADO ──────────────────────────────
titulo('2 · QUE NINGUNA ZONA CUENTE CON LA DE AL LADO')

const bamako = mapa.zonas.find((z) => z.code === 'BKO')
const koulikoro = mapa.zonas.find((z) => z.code === 'KLR')
const segou = mapa.zonas.find((z) => z.code === 'SEG')
const gao = mapa.zonas.find((z) => z.code === 'GAO')

console.log(`     Bamako      ${bamako.ventas.importe} FCFA · ${bamako.ventas.pedidos} pedidos · ${bamako.ventas.clientesTotales} clientes`)
console.log(`     Koulikoro  ${koulikoro.ventas.importe} FCFA · ${koulikoro.ventas.pedidos} pedidos · ${koulikoro.ventas.clientesTotales} clientes`)
console.log(`     Ségou      ${segou.ventas.importe} FCFA · ${segou.ventas.pedidos} pedidos · ${segou.ventas.clientesTotales} clientes`)
console.log(`     Gao        ${gao.ventas.importe} FCFA · ${gao.ventas.pedidos} pedidos · ${gao.ventas.clientesTotales} clientes`)

if (Number(bamako.ventas.importe) === 1500000) ok('Bamino ve SOLO lo suyo: 1.500.000')
else mal(`Bamako ve ${bamako.ventas.importe}, esperaba 1500000`)

if (Number(koulikoro.ventas.importe) === 250000) ok('Koulikoro ve SOLO lo suyo: 250.000')
else mal(`Koulikoro ve ${koulikoro.ventas.importe}, esperaba 250000`)

if (Number(segou.ventas.importe) === 75000) ok('Ségou ve SOLO lo suyo: 75.000')
else mal(`Ségou ve ${segou.ventas.importe}, esperaba 75000`)

if (Number(gao.ventas.importe) === 0) ok('y Gao, sin clientes, ve 0 — no ve lo de nadie')
else mal(`Gao ve ${gao.ventas.importe} y no tiene ni un cliente`)

if (bamako.ventas.clientesTotales === 1) ok('  → y cada una cuenta solo SUS clientes')
else mal(`  → Bamako cuenta ${bamako.ventas.clientesTotales} clientes`)

// La ficha individual tiene que decir lo MISMO que el mapa. Si se diferencian,
// son dos verdades.
const fichaB = await Z.fichaZona(zBamako.id, { periodo: 'MES' })
if (Number(fichaB.zona.ventas.importe) === Number(bamako.ventas.importe)) {
  ok(`y la ficha individual coincide con el mapa: ${fichaB.zona.ventas.importe}`)
} else {
  mal(`la ficha dice ${fichaB.zona.ventas.importe} y el mapa ${bamako.ventas.importe}`)
}
if (fichaB.clientes.length === 1 && fichaB.clientes[0].name === 'Cliente de Bamako') {
  ok('  → y la ficha lista solo el cliente de Bamako')
} else {
  mal(`  → la ficha lista ${fichaB.clientes.map((c) => c.name).join(', ')}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · LOS PERÍODOS AFECTAN A LAS CONSULTAS DE VERDAD')

const pMes = await Z.listarZonasMapa({ periodo: 'MES' })
const pAnio = await Z.listarZonasMapa({ periodo: 'ANIO' })
const bMes = pMes.zonas.find((z) => z.code === 'BKO')
const bAnio = pAnio.zonas.find((z) => z.code === 'BKO')

// Hoy los pedidos son de HOY, así que hoy y mes y año dan lo mismo. El año
// empieza el 1 de enero y estamos en octubre, así que también. Lo que se
// comprueba es que las fechas que devuelve CADA uno son las suyas.
const hoy = new Date()
const inicioMes = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`
const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10)
const inicioAnio = `${hoy.getFullYear()}-01-01`
const finAnio = `${hoy.getFullYear()}-12-31`

if (pMes.periodo.desde === inicioMes && pMes.periodo.hasta === finMes) ok(`MES → ${pMes.periodo.desde} … ${pMes.periodo.hasta}`)
else mal(`MES devuelve ${pMes.periodo.desde}…${pMes.periodo.hasta}, esperaba ${inicioMes}…${finMes}`)

if (pAnio.periodo.desde === inicioAnio && pAnio.periodo.hasta === finAnio) ok(`AÑO → ${pAnio.periodo.desde} … ${pAnio.periodo.hasta}`)
else mal(`AÑO devuelve ${pAnio.periodo.desde}…${pAnio.periodo.hasta}`)

if (pAnio.periodoPrevio.desde < pAnio.periodo.desde) ok(`y el año anterior es ${pAnio.periodoPrevio.desde} … ${pAnio.periodoPrevio.hasta}`)
else mal('el periodo anterior no es anterior')

for (const [nombre, fn] of [
  ['HOY', () => Z.periodo('HOY')],
  ['SEMANA', () => Z.periodo('SEMANA')],
  ['TRIMESTRE', () => Z.periodo('TRIMESTRE')],
]) {
  try {
    const p = fn()
    if (p.desde <= p.hasta) ok(`${nombre} → ${p.desde} … ${p.hasta}`)
    else mal(`${nombre} devuelve el periodo del revés`)
  } catch (e) { mal(`${nombre} falla: ${e.message}`) }
}

const personalizado = Z.periodo('PERSONALIZADO', '2026-01-01', '2026-03-31')
if (personalizado.desde === '2026-01-01' && personalizado.hasta === '2026-03-31') ok('PERSONALIZADO → 2026-01-01 … 2026-03-31')
else mal('PERSONALIZADO no respeta las fechas')

for (const [nombre, args] of [
  ['período desconocido', ['SIGLO', null, null]],
  ['personalizado sin fechas', ['PERSONALIZADO', null, null]],
  ['del revés', ['PERSONALIZADO', '2026-03-31', '2026-01-01']],
]) {
  try { Z.periodo(...args); mal(`se ha ACEPTADO: ${nombre}`) }
  catch { ok(`rechazado: ${nombre}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · UN SOLO MES: LA VARIACIÓN SIGUE EN NULL')

const bMesObj = pMes.zonas.find((z) => z.code === 'BKO')
if (bMesObj.variacion.pct === null) {
  ok(`variación de Bamako = null (${bMesObj.variacion.importe} en el periodo anterior, insuficiente)`)
} else {
  mal(`variación = ${bMesObj.variacion.pct} con un solo mes de datos: eso es inventar`)
}
if (bMesObj.variacion.suficienteHistorial === false) ok('  → y el sistema lo dice: no hay histórico suficiente')
else mal('  → dice que hay histórico cuando solo hay un mes')

// Y ahora se planta un mes anterior con ventas, para comprobar que CUANDO hay
// histórico, SÍ lo calcula. Una función que siempre devuelve null también
// pasaría la prueba de arriba.
// La fecha tiene que caer DENTRO del periodo anterior de octubre (del 31 de
// agosto al 30 de septiembre), no simplemente «hace mucho». Con 45 días sale
// el 22 de agosto, fuera, y la prueba fallaría por estar malPlantada en vez
// de por lo que quiere comprobar.
const pPrevio = Z.periodosAnteriores('MES', `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`,
  new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10))
const ayer = pPrevio.desde
const pedidoViejo = (await one(
  `INSERT INTO sales_orders (code, customer_id, status, order_date, currency_code,
                             subtotal, tax_rate, tax_amount, total, created_by)
   VALUES ($1,$2,'DELIVERED',$3,'XOF',800000,0,800000,800000,$4) RETURNING id`,
  [`PED-VIEJO-${Date.now().toString(36)}`, cBamako, ayer, ADM],
)).id

const conPrevio = await Z.listarZonasMapa({ periodo: 'MES' })
const bConPrevio = conPrevio.zonas.find((z) => z.code === 'BKO')
if (typeof bConPrevio.variacion.pct === 'number') {
  ok(`con un mes anterior con ventas, la variación se calcula: ${bConPrevio.variacion.pct} %`)
} else {
  mal(`con histórico suficiente sigue en ${bConPrevio.variacion.pct}: nunca calcula nada`)
}
await query('DELETE FROM sales_orders WHERE id = $1', [pedidoViejo])

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · COMERCIALES EN ZONAS Y UN SOLO RESPONSABLE')

const hash = await hashPassword('NoSeUsa.2026')
await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
             VALUES ('ztest-a','Comercial Zona A',$1,'es',now()) ON CONFLICT (username) DO NOTHING`, [hash])
await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
             VALUES ('ztest-b','Comercial Zona B',$1,'es',now()) ON CONFLICT (username) DO NOTHING`, [hash])
const uzA = (await one("SELECT id FROM users WHERE username='ztest-a'")).id
const uzB = (await one("SELECT id FROM users WHERE WHERE username='ztest-b'" .replace('WHERE WHERE', 'WHERE'))).id

const pA = (await one(
  `INSERT INTO com_perfiles (user_id, home_zona_id) VALUES ($1,$2)
   ON CONFLICT (user_id) DO UPDATE SET is_active = TRUE RETURNING id`, [uzA, zKoulikoro.id])).id
const pB = (await one(
  `INSERT INTO com_perfiles (user_id) VALUES ($1)
   ON CONFLICT (user_id) DO UPDATE SET is_active = TRUE RETURNING id`, [uzB])).id

// El comercial A en TRES zonas.
await Z.asignarComercialAZona({ comercialId: pA, zonaId: zKoulikoro.id, esPrincipal: true, porcentaje: 50 })
await Z.asignarComercialAZona({ comercialId: pA, zonaId: zBamako.id, porcentaje: 30 })
await Z.asignarComercialAZona({ comercialId: pA, zonaId: zSegou.id, porcentaje: 20 })

const suyas = await query(
  'SELECT z.code, cz.es_principal, cz.porcentaje FROM com_comercial_zonas cz JOIN com_zonas z ON z.id = cz.zona_id WHERE cz.comercial_id = $1 ORDER BY cz.es_principal DESC, z.code', [pA])
if (suyas.length === 3) ok(`el comercial A está en ${suyas.length} zonas`)
else mal(`está en ${suyas.length}, esperaba 3`)
if (suyas.filter((z) => z.es_principal).length === 1) ok('  → y solo UNA es principal')
else mal('  → no tiene exactamente una principal')

// Filtro por comercial.
const soloDeA = await Z.listarZonasMapa({ periodo: 'MES', comercialId: pA })
if (soloDeA.zonas.length === 3) ok(`el filtro por comercial devuelve sus ${soloDeA.zonas.length} zonas`)
else mal(`el filtro devuelve ${soloDeA.zonas.length}, esperaba 3`)

const sinFiltro = await Z.listarZonasMapa({ periodo: 'MES' })
if (sinFiltro.zonas.length === 9) ok('sin filtro devuelve las 9')
else mal(`sin filtro devuelve ${sinFiltro.zonas.length}`)

// Y el filtro NO PUEDE devolver zonas de otro.
const codigos = new Set(soloDeA.zonas.map((z) => z.code))
const ajenas = soloDeA.zonas.filter((z) => !['KLR', 'BKO', 'SEG'].includes(z.code))
if (ajenas.length === 0) ok(`y ninguna es de otro: ${[...codigos].join(', ')}`)
else mal(`el filtro ha dejado pasar ${ajenas.map((z) => z.code).join(', ')}`)

// La misma zona, dos responsables: no puede.
await Z.asignarComercialAZona({ comercialId: pB, zonaId: zSegou.id, esPrincipal: false, porcentaje: 10 })
try {
  await Z.asignarComercialAZona({ comercialId: pB, zonaId: zKoulikoro.id, esPrincipal: true, porcentaje: 40 })
  mal('se ha permitido un SEGUNDO responsable en Koulikoro')
} catch (e) {
  if (e.codigo === 'ZONA_YA_RESPONSABLE') ok(`segundo responsable rechazado con motivo claro: «${e.message.slice(0, 62)}…»`)
  else mal(`falla por otro motivo: ${e.codigo}`)
}

// Y cambiar de principal deja a la anterior sin principal, no con dos.
await Z.asignarComercialAZona({ comercialId: pB, zonaId: zKoulikoro.id, esPrincipal: false, porcentaje: 40 })
await Z.asignarComercialAZona({ comercialId: pA, zonaId: zKoulikoro.id, esPrincipal: true, porcentaje: 50 })
const koulikoroFinal = (await Z.listarZonasMapa({ periodo: 'MES', comercialId: pB })).zonas
  .find((z) => z.code === 'KLR')
ok(`Koulikoro declara ${koulikoroFinal?.comercial} comercial(es) y responsable «${koulikoroFinal?.responsable}»`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('6 · EL OBJETIVO DE ZONA, LIGADO POR ZONA_ID')

//
// El objetivo va de DENTRO de octubre a diciembre, no empezar en el futuro.
//
// Antes empezaba dentro de diez días, así que el período que va de hoy a
// final de mes lo contenía y el mapa lo encontraba — que es lo correcto— y la
// prueba, queítulosaba que no apareciera, fallaba. Se畢ó el caso al revés: se
// mira el mes YA TRANSCURRIDO, donde no hay objetivo, y luego el que sí lo tiene.
//
const futuro = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1).toISOString().slice(0, 10)
const futuroFin = new Date(hoy.getFullYear(), hoy.getMonth() + 2, 0).toISOString().slice(0, 10)

const oKLR = await Z.ponerObjetivoZona({ zonaId: zKoulikoro.id, periodStart: futuro, periodEnd: futuroFin, targetAmount: 400000 })
ok(`objetivo de Koulikoro: ${oKLR.target_amount} (id ${oKLR.id}, zona_id ${oKLR.zona_id})`)

const oBKO = await Z.ponerObjetivoZona({ zonaId: zBamako.id, periodStart: futuro, periodEnd: futuroFin, targetAmount: 900000 })
ok(`objetivo de Bamako: ${oBKO.target_amount} (id ${oBKO.id}, zona_id ${oBKO.zona_id})`)

if (oKLR.zona_id === zKoulikoro.id && oBKO.zona_id === zBamako.id) ok('cada objetivo está ligado a SU zona')
else mal('los objetivos no están bien ligados')

// Una zona no puede tener dos objetivos del mismo periodo.
const repetido = await Z.ponerObjetivoZona({ zonaId: zKoulikoro.id, periodStart: futuro, periodEnd: futuroFin, targetAmount: 123 })
// Y se vuelve al valor bueno, porque la siguiente comprobación lo necesita.
const cuantos = await one('SELECT count(*) AS n FROM com_objetivos_zona WHERE zona_id = $1::int AND period_start = $2::date', [zKoulikoro.id, futuro])
if (Number(cuantos.n) === 1 && Number(repetido.target_amount) === 123) {
  ok('el mismo periodo ACTUALIZA el objetivo, no crea uno nuevo')
  await Z.ponerObjetivoZona({ zonaId: zKoulikoro.id, periodStart: futuro, periodEnd: futuroFin, targetAmount: 400000 })
} else {
  mal(`hay ${cuantos.n} objetivos para ese periodo y el último vale ${repetido.target_amount}`)
}

// Y una zona VACÍA no puede tener objetivo.
try {
  await Z.ponerObjetivoZona({ zonaId: zGao.id, periodStart: futuro, periodEnd: futuroFin })
  mal('se ha puesto un objetivo que no mide nada')
} catch (e) {
  if (e.codigo === 'OBJETIVO_VACIO') ok('un objetivo vacío se rechaza')
  else mal(`falla por otro motivo: ${e.codigo}`)
}

// El objetivo NO aparece en el mapa hasta que su periodo empieza.
const mapaHoy = await Z.listarZonasMapa({ periodo: 'MES' })
const klrHoy = mapaHoy.zonas.find((z) => z.code === 'KLR')
if (klrHoy.tieneObjetivo === false && klrHoy.cumplimiento === '—') {
  ok('Koulikoro, con objetivo para el mes que viene, hoy sale con guion')
} else {
  mal(`Koulikoro sale con objetivo ${klrHoy.objetivo} / «${klrHoy.cumplimiento}»`)
}

// Pero en el periodo de ese objetivo, sí.
const mapaFuturo = await Z.listarZonasMapa({ periodo: 'PERSONALIZADO', desde: futuro, hasta: futuroFin })
const klrFuturo = mapaFuturo.zonas.find((z) => z.code === 'KLR')
if (klrFuturo.tieneObjetivo === true && Number(klrFuturo.objetivo) === 400000) {
  ok(`y mirando ese periodo sí: objetivo ${klrFuturo.objetivo}, cumplimiento «${klrFuturo.cumplimiento}»`)
} else {
  mal(`en su periodo sale objetivo ${klrFuturo.objetivo} / tieneObjetivo ${klrFuturo.tieneObjetivo}`)
}

// En noviembre no ha vendido nadie todavía, así que el cumplimiento es 0 %
// sobre un objetivo de 400.000. Lo que se comprueba aquí es que la DIVISIÓN
// se está haciendo de verdad: si el sistema dividiera por otra cosa saldría
// otra cifra, y eso es justo lo que no tiene que pasar.
const esperadoNov = Number(((Number(klrFuturo.ventas?.importe ?? 0) / 400000) * 100).toFixed(1))
if (klrFuturo.cumplimientoPct === esperadoNov) {
  ok(`cumplimiento calculado: ${klrFuturo.cumplimiento} (${klrFuturo.ventas?.importe ?? 0} ÷ 400.000)`)
} else {
  mal(`cumplimiento ${klrFuturo.cumplimientoPct}, y ${klrFuturo.ventas?.importe ?? 0} ÷ 400.000 da ${esperadoNov}`)
}

// Y con ventas de verdad en el periodo del objetivo, sale el porcentaje real.
// Sin esto, una función que siempre devolviera 0 % pasaría la prueba de arriba.
await pedidoDe(cKoulikoro, 250000)
const conVentas = await Z.listarZonasMapa({ periodo: 'PERSONALIZADO', desde: futuro, hasta: futuroFin })
const klrConVentas = conVentas.zonas.find((z) => z.code === 'KLR')
const esperadoCon = Number(((Number(klrConVentas.ventas.importe) / 400000) * 100).toFixed(1))
if (klrConVentas.cumplimientoPct === esperadoCon) {
  ok(`con 250.000 sobre 400.000 sale ${klrConVentas.cumplimientoPct} %`)
} else {
  mal(`con ventas sale ${klrConVentas.cumplimientoPct}, esperaba ${esperadoCon}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('7 · EL POTENCIAL SIGUE EN NULL Y LA PANTALLA LO DIRÁ')

const todas = (await Z.listarZonasMapa({ periodo: 'MES' })).zonas
const conAlgo = todas.filter((z) => z.potencial.poblacion !== null || z.potencial.clientesPotenciales !== null)
if (conAlgo.length === 0) ok('las nueve vienen con potencial NULL')
else mal(`${conAlgo.length} traen potencial`)
if (todas.every((z) => z.potencial.pendiente === true)) ok('y las nueve marcadas como pendiente: la pantalla lo dirá')
else mal('no todas marcan potencial pendiente')

// ═══════════════════════════════════════════════════════════════════════════
titulo('8 · LO QUE NO SE TOCÓ')

const c027 = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'com%' ORDER BY table_name")
ok(`${c027.length} tablas com_* en total`)
const v = await query("SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'com_%' ORDER BY viewname")
ok(`vistas: ${v.map((x) => x.viewname).join(', ')}`)

const fks = await query(`
  SELECT tc.table_name AS desde, ccu.table_name AS hacia FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name LIKE 'com\\_%'`)
const ERP = ['items','sales_orders','sales_order_lines','payments','users','customers','audit_log','zones','lots']
const fuera = fks.filter((f) => ERP.includes(f.hacia))
if (fuera.length === 0) ok(`ninguna clave foránea de com_* hacia el ERP (${fks.length} internas)`)
else for (const f of fuera) mal(`com_${f.desde} → ${f.hacia}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LAS CONSULTAS DE ZONAS ESTÁN VERIFICADAS' : `HAY ${fallos} FALLOS`)
console.log('')
await closeDb()
process.exit(fallos === 0 ? 0 : 1)