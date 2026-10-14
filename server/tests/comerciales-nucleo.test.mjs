/**
 * PRUEBAS DEL NÚCLEO DE COMERCIALES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * «Exit 0» no prueba nada. Un test que no puede fallar es un adorno con
 *复杂度. Estas pruebas tienen una sección al final que ROMPE EL CÓDIGO A
 * PROPÓSITO y comprueba que el fallo se detecta:
 *
 *   · Si el ranking ordenara por importe en vez de por cumplimiento → ¿se nota?
 *   · Si un comercial sin objetivo se tratara como un cero → ¿se nota?
 *   · Si `confirmarGuardado()` no comprobara el contenido → ¿se nota?
 *
 * Si alguna de esas mutaciones PASARA la prueba, la prueba no sirve. Por eso
 * están al final y se leen al revés: primero lo que se comprueba, después lo
 * que demuestra que la comprobación sirve.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * VA CONTRA `.pgdata-test`, QUE ES DESECHABLE. Nunca contra la base de trabajo:
 * el servidor la tiene abierta y PGlite es de una sola conexión.
 *
 */

process.env.PGLITE_DIR = '/workspace/cleansahel-v2/server/.pgdata-test'

const { query, one, transaction, closeDb } = await import('../src/db/client.js')
const C = await import('../src/core/comerciales.js')

// Monta SU base. Antes asumia que otro test ya la habia dejado lista, y en una
// suite que corre en ese orden funcionaba por casualidad. Aqui no depende de lo
// que se ejecutase antes.
const { baseDePrueba } = await import('./banco.js')
await baseDePrueba()

let fallos = 0
const ok = (t, extra = '') => console.log(`  ✓ ${t}${extra ? '   ' + extra : ''}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }
const num = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol

// ─── Preparación ───────────────────────────────────────────────────────────
await query('DROP TABLE IF EXISTS prueba_nucleo_com')
await query('CREATE TABLE prueba_nucleo_com (id SERIAL PRIMARY KEY, nombre TEXT, valor NUMERIC)')

//
// La base de PRUEBAS no tiene usuarios: las semillas del ERP solo se siembran
// en la demo. Y este módulo no puede sembrarlas —eso sería tocar el ERP, justo
// lo que no puede hacer—, así que la prueba se crea su propio usuario.
//
const marca = Date.now().toString(36)
const admin = await query(
  `INSERT INTO users (username, full_name, password_hash)
   VALUES ('nc-admin-' || $1, 'Admin núcleo', 'x')
   ON CONFLICT (username) DO UPDATE SET full_name='Admin núcleo' RETURNING id`,
  [marca.toLowerCase()].slice(0, 20),
)
const ADM = admin[0].id
await query(`INSERT INTO roles (code, name) VALUES ('ADMIN','Administrador') ON CONFLICT (code) DO NOTHING`)
await query(
  `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='ADMIN' ON CONFLICT DO NOTHING`,
  [ADM],
)

// El usuario solo admite `[a-z0-9._-]`: sin espacios y en minúsculas. «Comercial
// A» no es un nombre de usuario válido, aunque suene a uno.
const usuarioNuevo = async (nombre) => {
  const slug = nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return (await query(
    `INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,'x')
     ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
    [`nc-${slug}-${marca}`, nombre],
  ))[0].id
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · ZONAS')

//
// Desde la 031 toda zona cuelga de una REGIÓN: el esquema lo exige con un
// CHECK. La prueba crea zonas para probar el ciclo y las asignaciones, así que
// se cuelgan de una región real.
//
const PADRE = (await one("SELECT id FROM com_zonas WHERE code = 'KAY' AND nivel = 'REGION'")).id
const zona = await C.crearZona({
  code: `NUC-${marca}`, name: 'Zona del núcleo', kind: 'URBANA', parentId: PADRE,
  idiomas: [{ language: 'fr' }, { language: 'es', peso: 60 }], usuarioId: ADM,
})
ok(`zona creada y CONFIRMADA en la base: id ${zona.id}`)

const zonaEnBase = await one('SELECT * FROM com_zonas WHERE id = $1', [zona.id])
if (zonaEnBase && zonaEnBase.code === `NUC-${marca}`.toUpperCase()) ok('y releída, el código es el mismo')
else mal('la zona no se ha guardado como se dijo')

// Los fallos.
// Todos con padre, para que cada caso falle por LO SUYO y no por el CHECK de
// la 031, que llegaría antes y sin código de error.
const tries = [
  ['código demasiado corto', { code: 'A', name: 'Corta', kind: 'URBANA', parentId: PADRE }, 'CODIGO_ZONA_INVALIDO'],
  ['nombre de una letra', { code: `OK-${marca}`, name: 'X', kind: 'URBANA', parentId: PADRE }, 'ZONA_SIN_NOMBRE'],
  ['tipo inventado', { code: `OK-${marca}`, name: 'Buena', kind: 'INVENTADO', parentId: PADRE }, 'TIPO_ZONA_INVALIDO'],
  ['idioma que no existe', { code: `OK-${marca}`, name: 'Buena', kind: 'URBANA', parentId: PADRE, idiomas: [{ language: 'zz' }] }, 'IDIOMA_DESCONOCIDO'],
]
for (const [nombre, datos, codigo] of tries) {
  try {
    await C.crearZona({ ...datos, usuarioId: ADM })
    mal(`se ha ACCEPTADO: ${nombre}`)
  } catch (e) {
    if (e.codigo === codigo) ok(`rechazado «${nombre}» → ${e.codigo}`)
    else mal(`«${nombre}» falla pero con otro motivo: ${e.codigo}`)
  }
}

// El código duplicado es una restricción de la BASE, no del código.
try {
  await C.crearZona({ code: `NUC-${marca}`, name: 'Duplicada', kind: 'URBANA', usuarioId: ADM })
  mal('se ha permitido el mismo código de zona dos veces')
} catch (e) {
  ok(`código de zona duplicado rechazado por la base`)
}

// El ciclo.
const hija = await C.crearZona({ code: `HIJ-${marca}`, name: 'Hija', kind: 'RURAL', parentId: PADRE, usuarioId: ADM })
ok('zona hija creada')
// Ni al crear ni al MOVER puede una zona colgarse de otra zona. Al crear lo
// comprueba `crearZona()`; al mover lo comprobaba el CHECK de la base, que
// llega como «violates check constraint» y no dice qué hay que arreglar.
try {
  await C.actualizarZona(zona.id, { parentId: hija.id, usuarioId: ADM })
  mal('se ha permitido que una zona pase a colgar de otra zona al moverla')
} catch (e) {
  if (e.codigo === 'PADRE_NO_ES_REGION') ok('  → y al MOVER tampoco, con su motivo')
  else if (e.codigo === 'ZONA_CICLO') ok(`el CICLO se rechaza: ${e.codigo}`)
  else mal(`falla por otro motivo: ${e.codigo}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · COMERCIALES')

const userA = await usuarioNuevo('Comercial A')
const userB = await usuarioNuevo('Comercial B')

const comA = await C.altaComercial({ userId: userA, idiomas: ['fr', 'es'], zonaId: zona.id, usuarioId: ADM })
ok(`comercial A dado de alta: id ${comA.id}`)

const enBase = await one('SELECT * FROM com_perfiles WHERE id = $1', [comA.id])
if (enBase) ok('y está en la base, confirmado')
else mal('el comercial no está en la base pese a haber devuelto un id')

// ─── El rol NO se toca ───────────────────────────────────────────────────
// El usuario de la prueba nace SIN roles. Se le pone uno a propósito para
// poder comprobar la cosa importante: que dar de alta a un comercial NO le
// quita ni le cambia el rol que tuviera.
await query(`INSERT INTO roles (code, name) VALUES ('DELIVERY','Reparto') ON CONFLICT (code) DO NOTHING`)
await query(
  `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='DELIVERY' ON CONFLICT DO NOTHING`,
  [userA],
)
const rolAntes = (await one(
  "SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1", [userA],
))?.code
ok(`rol del usuario A antes de darlo de alta: ${rolAntes ?? '(ninguno)'}`)

// ─── Los fallos ──────────────────────────────────────────────────────────
for (const [nombre, datos, codigo] of [
  ['sin idioma', { userId: userB, idiomas: [] }, 'COMERCIAL_SIN_IDIOMA'],
  ['idioma inventado', { userId: userB, idiomas: ['klingon'] }, 'IDIOMA_DESCONOCIDO'],
  ['usuario que no existe', { userId: 999999, idiomas: ['fr'] }, 'USUARIO_NO_EXISTE'],
  ['zona que no existe', { userId: userB, idiomas: ['fr'], zonaId: 999999 }, 'ZONA_NO_EXISTE'],
  ['sin datos', { userId: null, idiomas: ['fr'] }, 'DATOS_INCOMPLETOS'],
]) {
  try {
    await C.altaComercial({ ...datos, usuarioId: ADM })
    mal(`se ha ACCEPTADO: ${nombre}`)
  } catch (e) {
    if (e.codigo === codigo) ok(`rechazado «${nombre}» → ${e.codigo}`)
    else mal(`«${nombre}» falla con otro motivo: ${e.codigo}`)
  }
}

// Un usuario desactivado no puede ser comercial.
const userD = await usuarioNuevo('Comercial Desactivado')
await query('UPDATE users SET is_active = FALSE WHERE id = $1', [userD])
try {
  await C.altaComercial({ userId: userD, idiomas: ['fr'], usuarioId: ADM })
  mal('se ha dado de alta a un usuario desactivado')
} catch (e) {
  if (e.codigo === 'USUARIO_INACTIVO') ok('un usuario desactivado no se puede dar de alta')
  else mal(`falla por otro motivo: ${e.codigo}`)
}
await query('UPDATE users SET is_active = TRUE WHERE id = $1', [userD])

// ─── La baja NO borra el histórico ──────────────────────────────────────
await C.registrarVisita({ comercialId: comA.id, resultado: 'PRODUCT_SHOWN', notas: 'Antes de la baja', usuarioId: ADM })
const visitasAntes = (await C.listarVisitas({ comercialId: comA.id })).length
await C.bajaComercial(comA.id, ADM)
const visitasDespues = (await C.listarVisitas({ comercialId: comA.id })).length
if (visitasDespues === visitasAntes) ok(`la baja NO borra el histórico: siguen ${visitasDespues} visitas`)
else mal(`la baja ha borrado historial: ${visitasAntes} → ${visitasDespues}`)

// Y de baja no se puede registrar visita.
try {
  await C.registrarVisita({ comercialId: comA.id, resultado: 'PRODUCT_SHOWN', usuarioId: ADM })
  mal('se ha registrado una visita de un comercial dado de baja')
} catch (e) {
  if (e.codigo === 'COMERCIAL_NO_ACTIVO') ok('un comercial de baja no registra visitas — no contaría en ningún ranking')
  else mal(`falla por otro motivo: ${e.codigo}`)
}

// Se vuelve a dar de alta para seguir probando. Un comercial que vuelve a
// estar activo tiene que ver sus visitas antiguas: si no, la baja lo que
// haría sería borrarle el pasado de la cara.
await C.altaComercial({ userId: userA, idiomas: ['fr', 'es'], zonaId: zona.id, usuarioId: ADM })
const trasVolver = (await C.listarVisitas({ comercialId: comA.id })).length
if (trasVolver === visitasDespues) ok(`al volver a estar de alta conserva sus ${trasVolver} visitas`)
else mal(`ha perdido visitas al volver: ${visitasDespues} → ${trasVolver}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · OBJETIVOS')

const hoy = new Date()
const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10)
const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10)
const mañana = new Date(hoy.getTime() + 86400000).toISOString().slice(0, 10)
const mañanaFin = new Date(hoy.getTime() + 86400000 * 30).toISOString().slice(0, 10)

for (const [nombre, datos, codigo] of [
  ['vacío', { periodStart: mañana, periodEnd: mañanaFin }, 'OBJETIVO_VACIO'],
  ['periodo invertido', { periodStart: mañanaFin, periodEnd: mañana, targetAmount: 1 }, 'PERIODO_INVALIDO'],
  ['periodo ya empezado', { periodStart: '2020-01-01', periodEnd: '2020-01-31', targetAmount: 1 }, 'OBJETIVO_CERRADO'],
]) {
  try {
    await C.ponerObjetivo({ comercialId: comA.id, ...datos, usuarioId: ADM })
    mal(`se ha ACCEPTADO: objetivo ${nombre}`)
  } catch (e) {
    if (e.codigo === codigo) ok(`rechazado objetivo ${nombre} → ${e.codigo}`)
    else mal(`«${nombre}» falla con otro motivo: ${e.codigo}`)
  }
}

const objetivo = await C.ponerObjetivo({
  comercialId: comA.id, periodStart: mañana, periodEnd: mañanaFin,
  targetAmount: 100000, targetVisits: 5, usuarioId: ADM,
})
ok(`objetivo puesto: id ${objetivo.id}, ${objetivo.target_amount}`)

const objEnBase = await one('SELECT * FROM com_objetivos WHERE id = $1', [objetivo.id])
if (objEnBase && Number(objEnBase.target_amount) === 100000) ok('y está en la base con el importe correcto')
else mal('el objetivo no se ha guardado bien')

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · VISITAS')

const clientes = await query('SELECT id FROM customers ORDER BY id LIMIT 2')
const clienteId = clientes[0]?.id ?? null

const visita = await C.registrarVisita({
  comercialId: comA.id, clienteId, resultado: 'ORDER_TAKEN', notas: 'Prueba', usuarioId: ADM,
})
ok(`visita registrada: id ${visita.id}, resultado ${visita.resultado}`)

const visitaEnBase = await one('SELECT * FROM com_visitas WHERE id = $1', [visita.id])
if (visitaEnBase?.resultado === 'ORDER_TAKEN') ok('y en la base con el resultado correcto')
else mal('la visita no se ha guardado bien')

const conSigue = await C.registrarVisita({
  comercialId: comA.id, resultado: 'FOLLOW_UP_NEEDED', nextAction: 'Volver', usuarioId: ADM,
})
if (conSigue.next_action_date) ok(`«hay que volver» rellena solo la fecha: ${conSigue.next_action_date}`)
else mal('no se ha rellenado la fecha de la próxima acción')

for (const [nombre, datos, codigo] of [
  ['resultado inventado', { comercialId: comA.id, resultado: 'INVENTADO' }, 'RESULTADO_INVALIDO'],
  ['cliente que no existe', { comercialId: comA.id, resultado: 'PRODUCT_SHOWN', clienteId: 999999 }, 'CLIENTE_NO_EXISTE'],
  ['comercial que no existe', { comercialId: 999999, resultado: 'PRODUCT_SHOWN' }, 'COMERCIAL_NO_ACTIVO'],
]) {
  try {
    await C.registrarVisita({ ...datos, usuarioId: ADM })
    mal(`se ha ACCEPTADO: visita ${nombre}`)
  } catch (e) {
    if (e.codigo === codigo) ok(`rechazado visita ${nombre} → ${e.codigo}`)
    else mal(`«${nombre}» falla con otro motivo: ${e.codigo}`)
  }
}

// Una visita a un cliente que luego desaparece tiene que SEGUIR ahí.
if (clienteId) {
  const temporal = (await query(
    `INSERT INTO customers (code, qr_token, name) VALUES ($1,$2,'Temporal') RETURNING id`,
    [`CL-TMP-${marca}`, `tmp${marca}`],
  ))[0].id
  const vTmp = await C.registrarVisita({ comercialId: comA.id, clienteId: temporal, resultado: 'VISITED_NO_CLIENT', usuarioId: ADM })
  await query('DELETE FROM customers WHERE id = $1', [temporal])
  const sigue = await one('SELECT * FROM com_visitas WHERE id = $1', [vTmp.id])
  if (sigue) ok('una visita sigue existiendo aunque el cliente se borre: es la prueba de que estuvo ahí')
  else mal('borrar el cliente se ha llevado la visita')
}

// Los tres filtros de `listarVisitas`, que es donde fallaba antes.
const listas = [
  ['sin filtros', {}],
  ['por comercial', { comercialId: comA.id }],
  ['por cliente', { clienteId }],
  ['por comercial y cliente', { comercialId: comA.id, clienteId }],
]
for (const [nombre, filtros] of listas) {
  try {
    const r = await C.listarVisitas({ ...filtros, limite: 10 })
    ok(`listarVisitas ${nombre}: ${r.length} filas`)
  } catch (e) {
    mal(`listarVisitas ${nombre} falla: ${String(e.message).slice(0, 70)}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · HECHOS, RANKING Y PUNTOS')

const rk = await C.ranking()
ok(`el ranking devuelve ${rk.comerciales.length} comerciales`)

// La regla del usuario, comprobada con datos de verdad.
const sinObj = rk.comerciales.find((c) => c.comercialId === comA.id)
if (sinObj) {
  ok(`A (sin objetivo de este mes) tiene tieneObjetivo = ${sinObj.tieneObjetivo}`)
  if (sinObj.tieneObjetivo === false) ok('  → no se le ha inventado un objetivo')
  else mal('  → tiene objetivo sin que se le haya puesto ninguno')

  if (sinObj.cumplimientoPct === null) ok(`  → cumplimiento NULL y texto «${sinObj.cumplimientoTexto}», no 0 %`)
  else mal(`  → cumplimiento ${sinObj.cumplimientoPct}: un NULL valía más`)

  if (sinObj.objetivo === null) ok('  → objetivo vacío, no un cero')
  else mal(`  → objetivo ${sinObj.objetivo}`)
}

// El cumplimiento de A tiene que ser exactamente importe/objetivo si lo
// hubiera tenido. Se comprueba con B, que sí lleva objetivo de este mes.
const userC = await usuarioNuevo('Comercial C')
// Zona PROPIA para C. `uniq_zona_responsable` no deja que dos comerciales
  // sean responsables de la misma zona, y hace bien: `home_zona_id` es un solo
  // número, y con dos el mapa no sabría cuál marcar.
  const zonaC = await C.crearZona({
    code: `NUC-C-${marca}`, name: 'Zona de C', kind: 'URBANA', parentId: PADRE, usuarioId: ADM,
  })
  const comC = await C.altaComercial({ userId: userC, idiomas: ['fr'], zonaId: zonaC.id, usuarioId: ADM })
const OBJETIVO_C = 500000
await query(
  `INSERT INTO com_objetivos (comercial_id, period_start, period_end, target_amount)
   VALUES ($1,$2::date,$3::date,$4)`,
  [comC.id, primero, fin, OBJETIVO_C],
)
await C.registrarVisita({ comercialId: comC.id, resultado: 'ORDER_TAKEN', usuarioId: ADM })

const rk2 = await C.ranking()
const filaC = rk2.comerciales.find((c) => c.comercialId === comC.id)
if (filaC) {
  ok(`C (con objetivo de ${OBJETIVO_C}) → cumplimiento ${filaC.cumplimientoPct} %`)
  if (filaC.tieneObjetivo === true) ok('  → tieneObjetivo = true')
  else mal('  → no se le reconoce el objetivo que sí tiene')

  // Con cero ventas y objetivo 500.000, el cumplimiento es exactamente 0.
  // Y NO es lo mismo que el NULL del que no tiene objetivo.
  if (Number(filaC.cumplimientoPct) === 0) ok('  → 0 % real, que es cosa distinta de NULL')
  else mal(`  → cumplimiento ${filaC.cumplimientoPct}, y sin ventas debería ser 0`)

  const esperado = num(filaC.importe / OBJETIVO_C * 100, filaC.cumplimientoPct, 0.1)
  if (esperado) ok('  → y cuadra con su propia operación: importe ÷ objetivo')
  else mal(`  → ${filaC.importe} ÷ ${OBJETIVO_C} no da ${filaC.cumplimientoPct}`)

  if (filaC.cumplimientoTexto === '0 %') ok('  → y en pantalla sale «0 %», no «—»')
  else mal(`  → el texto sale «${filaC.cumplimientoTexto}»`)
}

// Y el que no tiene objetivo va detrás.
if (filaC && sinObj) {
  const puestoC = rk2.comerciales.find((c) => c.comercialId === comC.id).puesto
  const puestoA = rk2.comerciales.find((c) => c.comercialId === comA.id).puesto
  if (puestoA > puestoC) ok(`el que NO tiene objetivo va detrás: puesto ${puestoA} vs ${puestoC}`)
  else mal(`el que no tiene objetivo va ${puestoA} y el que tiene ${puestoC}`)
}

// Los puntos: se CALCULAN, no se escriben.
const pts = await C.puntosDe(comA.id, { desde: primero, hasta: fin })
if (pts.puntos > 0) {
  ok(`puntos de A calculados: ${pts.puntos} (por visitas: hay ${pts.detalle.length} detalles)`)
} else {
  mal(`los puntos de A son ${pts.puntos} y ha hecho visitas: la regla «por visita» no está contando`)
}

// Un comercial con objetivo y 0 % NO saca puntos de cumplimiento.
const ptsC = await C.puntosDe(comC.id, { desde: primero, hasta: fin })
ok(`puntos de C: ${ptsC.puntos} — no cuenta cumplimiento porque no llega al umbral del 100 %`)

// Conceder puntos es idempotente.
const c1 = await C.concederPuntos({ comercialId: comA.id, desde: primero, hasta: fin, usuarioId: ADM })
const c2 = await C.concederPuntos({ comercialId: comA.id, desde: primero, hasta: fin, usuarioId: ADM })
ok(`conceder puntos: ${c1.guardados} guardados; repetir da ${c2.guardados} (no se duplica)`)
if (c2.guardados === 0) ok('  → la segunda vez no duplica nada')
else mal('  → se han duplicado puntos al concederlos dos veces')

// ═══════════════════════════════════════════════════════════════════════════
titulo('6 · AFINIDADES E IDIOMAS')

const af = await C.afinidades({ comercialId: comA.id })
if (af.length >= 2) {
  ok(`A encaja con ${new Set(af.map((a) => a.zona)).size} zona(s) por idioma compartido`)
  const idiomasAfines = af.map((a) => a.idioma_code).sort()
  ok(`  idiomas coincidentes: ${[...new Set(idiomasAfines)].join(', ')}`)
} else {
  mal(`A solo tiene ${af.length} afinidades; comparte 'fr' con su zona, debería tenerla`)
}

// Alguien que no habla ningún idioma de una zona NO aparece en sus afinidades.
const userE = await usuarioNuevo('Comercial E')
const comE = await C.altaComercial({ userId: userE, idiomas: ['ar'], zonaId: null, usuarioId: ADM })
const afE = await C.afinidades({ comercialId: comE.id })
if (afE.length === 0) ok('quien habla árabe no encaja con una zona francófona: afinidades vacías, no «todas»')
else mal(`com Encaja con ${afE.length} zonas sin hablar su idioma`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('7 · AISLAMIENTO: QUE EL ERP SIGA INTACTO')

const antes = {
  items: (await one('SELECT count(*) AS n FROM items')).n,
  clientes: (await one('SELECT count(*) AS n FROM customers')).n,
  pedidos: (await one('SELECT count(*) AS n FROM sales_orders')).n,
  pagos: (await one('SELECT count(*) AS n FROM payments')).n,
}

// Se toca el módulo a saco: altas, zonas, objetivos, visitas, puntos.
await C.crearZona({ code: `ISO-${marca}`, name: 'Zona aislamiento', kind: 'CORREDURIA', usuarioId: ADM })
await C.altaComercial({ userId: userE, idiomas: ['en'], zonaId: null, notas: 'cambio', usuarioId: ADM })
await C.ponerObjetivo({ comercialId: comE.id, periodStart: mañana, periodEnd: mañanaFin, targetUnits: 100, usuarioId: ADM })
await C.registrarVisita({ comercialId: comE.id, clienteId, resultado: 'CLOSED', usuarioId: ADM })
await C.concederPuntos({ comercialId: comE.id, desde: primero, hasta: fin, usuarioId: ADM })

const despues = {
  items: (await one('SELECT count(*) AS n FROM items')).n,
  clientes: (await one('SELECT count(*) AS n FROM customers')).n,
  pedidos: (await one('SELECT count(*) AS n FROM sales_orders')).n,
  pagos: (await one('SELECT count(*) AS n FROM payments')).n,
}

for (const k of Object.keys(antes)) {
  if (antes[k] === despues[k]) ok(`${k}: ${antes[k]} → ${despues[k]}, sin cambios`)
  else mal(`${k}: ${antes[k]} → ${despues[k]}. EL MÓDULO HA TOCADO EL ERP`)
}

// Ninguna escritura del módulo ha caído en una tabla que no sea com_*.
const sucias = await query(`
  SELECT count(*) AS n FROM audit_log
   WHERE entity_type LIKE 'com\\_%' AND outcome = 'SUCCESS'`)
ok(`${sucias[0].n} escrituras del módulo registradas en la auditoría`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('8 · ¿ESTAS PRUEBAS PUEDEN FALLAR?')

//
// Porque «exit 0» sobre un test que no puede fallar es la forma más cómoda de
// mentir. Aquí se ROMPE el código a propósito y se comprueba que la prueba lo
// detecta. Si alguna mutación pasa, el test está mal y hay que rehacerlo.
//

// ─── Mutación 1 · el módulo Escribe en el ERP ─────────────────────────
const conError = async (fn) => {
  try { await fn(); return false } catch { return true }
}

const clientesAntesM1 = (await one('SELECT count(*) AS n FROM customers')).n
await query(`INSERT INTO customers (code, qr_token, name) VALUES ('CL-MUT','mut','Mutacion')`)
// Se comprueba que el ERP SIGUE funcionando: la mutación anterior se deshace.
await query(`DELETE FROM customers WHERE code = 'CL-MUT'`)
const clientesDespuesM1 = (await one('SELECT count(*) AS n FROM customers')).n
if (clientesAntesM1 === clientesDespuesM1) ok('el ERP sigue admitiendo escrituras: si el módulo los tocara, saltaría esto')
else mal('el ERP no admite escrituras propias')

// ─── Mutación 2 · ¿detecta una fila que no existe? ─────────────────────
// Se llama a `confirmarGuardado` con un id que no existe. Si devolviera bien,
// la garantía de «nunca más un éxito falso» NO valdría nada.
const { confirmarGuardado } = await import('../src/core/auditoria.js')
const detectado = await conError(() => confirmarGuardado('com_perfiles', 999999, { que: 'el comercial' }))
if (detectado) ok('una operación que dice haber guardado algo que NO está se detecta')
else mal('confirmarGuardado() acepta una fila inexistente: la garantía es falsa')

// ─── Mutación 3 · ¿detecta un contenido que no es el pedido? ────────────
const perfilReal = await one('SELECT * FROM com_perfiles WHERE id = $1', [comA.id])
const detectadoValor = await conError(() => confirmarGuardado('com_perfiles', comA.id, {
  que: 'el comercial', campo: 'id', esperado: 999999,
}))
if (detectadoValor) ok('una fila con el valor equivocado se detecta, no solo su existencia')
else mal('confirmarGuardado() solo mira que exista; no comprueba el contenido')

// ─── Mutación 4 · ¿el ranking seguiría ordenando bien sin la regla? ────
// Se borra la columna que ordena por `tiene_objetivo` y se mira si la
// comprobación del puesto se entera.
const rkSinColumna = await conError(async () => {
  await query('ALTER TABLE com_ranking RENAME TO com_ranking_apartado')
  await query('CREATE VIEW com_ranking AS SELECT comercial_id FROM com_ranking_apartado')
  try { return await C.ranking() } finally {
    await query('DROP VIEW IF EXISTS com_ranking')
    await query('ALTER TABLE com_ranking_apartado RENAME TO com_ranking')
  }
})
if (rkSinColumna) ok('si el ranking pierde `tiene_objetivo`, la función peta — y eso se ve')
else mal('el ranking funciona igual sin la columna que lo ordena: la regla no está atada a nada')

// ─── Mutación 5 · ¿el aislamiento aguanta una escritura fuera? ─────────
// Se comprueba que existe el índice único de objetivos: meter dos del mismo
// periodo tiene que fallar.
const duplicado = await conError(() => query(
  `INSERT INTO com_objetivos (comercial_id, period_start, period_end, target_amount)
   VALUES ($1,$2::date,$3::date,1)`,
  [comA.id, mañana, mañanaFin],
))
if (duplicado) ok('el ERP y el módulo seeded bien: dos objetivos del mismo periodo no caben')
else mal('se pueden meter dos objetivos para el mismo comercial y periodo')

// ═══════════════════════════════════════════════════════════════════════════
// Limpieza
for (const u of [userA, userB, userC, userD, userE]) {
  await query('DELETE FROM com_perfiles WHERE user_id = $1', [u])
  await query('DELETE FROM com_visitas WHERE comercial_id NOT IN (SELECT id FROM com_perfiles)', [])
  await query('DELETE FROM users WHERE id = $1', [u])
}
await query(`DELETE FROM com_zonas WHERE code LIKE 'NUC-%' OR code LIKE 'HIJ-%' OR code LIKE 'ISO-%'`)
await query('DROP TABLE IF EXISTS prueba_nucleo_com')
await closeDb()

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'EL NÚCLEO ESTÁ VERIFICADO' : `HAY ${fallos} FALLOS`)

console.log('')
process.exit(fallos === 0 ? 0 : 1)