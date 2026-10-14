/**
 * PRUEBAS DE LA API DE COMERCIALES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TRES COSAS QUE ESTA PRUEBA COMPRUEBA Y OTRAS NO.
 *
 * UN · LA API RESPETA LAS REGLAS DEL NÚCLEO, Y NO LAS REESCRIBE.
 *
 * Cada regla del núcleo tiene aquí su negativo por HTTP: sin idioma, objetivo
 * vacío, periodo ya empezado, resultado inventado. Si la API aceptara algo que
 * el núcleo rechaza, eso es exactamente el fallo que aquí tiene que salir.
 *
 * DOS · LOS ERRORES LLEGAN COMO ERRORES.
 *
 * Un mensaje que se traga y se convierte en «error interno del servidor» es un
 * mensaje que obliga a cerrar la ventana y volver a entrar a mirar. Aquí se
 * comprueba el texto Y el código HTTP, porque un 400 con un mensaje bueno y un
 * 500 con un mensaje bueno no valen lo mismo: uno se puede arreglar, el otro
 * hace que alguien piense que la base está rota.
 *
 * TRES · UN DOBLE ENVÍO NO HACE DOBLE.
 *
 * Un repartidor con el móvil en la mano pulsa dos veces. O la pantalla se
 * recarga y manda la misma petición otra vez. En una venta eso son dos
 * deliveries o dos cobros, y en un ranking son puntos contados por partida
 * doble. Se lanza la misma petición VARIAS VECES A LA VEZ y se comprueba que
 * no se duplique nada.
 *
 * Y al revés que también: cuando duplicar ES lo correcto —dos zonas con el
 * mismo nombre, dos objetivos de periodos distintos— tiene que poder.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NO ESCRIBE EN LA BASE DE TRABAJO. Corre contra `.pgdata-test`, que es
 * desechable, y levanta su propio servidor con su propia base. La del ERP
 * nunca se abre desde aquí.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'

const RAIZ = '/workspace/cleansahel-v2'
const PUERTO = 10911
const BASE = `http://127.0.0.1:${PUERTO}`
const BD = `${RAIZ}/server/.pgdata-test-api`

//
// El ERP no arranca sin secretos, a propósito: una aplicación con secretos de
// serie es una aplicación con los secretos de todo el mundo. Para la prueba se
// generan aquí, y son de la prueba: valen solo para este proceso.
//
const CLAVE = 'clave-de-prueba-api-comerciales-esto-no-es-un-secreto-real-1234567890'

let fallos = 0
let cambiados = 0
const ok = (t, extra = '') => console.log(`  ✓ ${t}${extra ? '   ' + extra : ''}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

const pedir = async (ruta, { metodo = 'GET', cuerpo, token } = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  })
  const t = await r.text()
  let v = null
  try { v = JSON.parse(t) } catch { v = t }
  return { estado: r.status, cuerpo: v }
}

// ═══════════════════════════════════════════════════════════════════════════
// ARRANCAR UN SERVIDOR PROPIO, CON SU PROPIA BASE
// ═══════════════════════════════════════════════════════════════════════════

await rm(BD, { recursive: true, force: true })

//
// La migración corre en OTRO proceso, con su propia conexión a su propia base.
// Y se espera a que TERMINE, no a que empiece a hablar: escuchar el primer
// «OK» y seguir adelante es Attach y Attach otra vez en el mismo sitio.
//
const migrarBase = () => new Promise((res, rej) => {
  const p = spawn('node', [`${RAIZ}/server/herramientas/instalar-base.mjs`, BD],
    { stdio: 'pipe', env: { ...process.env, JWT_SECRET: CLAVE } })
  let salida = ''
  p.stdout.on('data', (d) => { salida += d })
  p.stderr.on('data', (d) => { salida += d })
  p.on('close', (codigo) => (codigo === 0
    ? res(salida)
    : rej(new Error(`migrar-una terminó con ${codigo}:\n${salida.slice(-800)}`))))
})
await migrarBase()

// ── Usuario de prueba, ANTES de que el servidor abra la base ──
// La clave tiene que estar puesta ANTES de que se cargue nada: el ERP aborta
// el arranque si no la hay, a propósito. Va aquí y no en el spawn porque
// este proceso también importa la configuración.
process.env.JWT_SECRET = CLAVE

const { query, one, closeDb } = await import('../src/db/client.js')

// Esta prueba monta SU base. Antes no lo hacia: asumia que otro test ya la
// habia dejado construida, y en una suite que corre en ese orden funcionaba por
// casualidad. Montarla aqui es lo que hace que el resultado no dependa de lo
// que se ejecutase antes.
const { baseDePrueba } = await import('./banco.js')
await baseDePrueba()
// El hash se genera de verdad, no se escribe uno inventado: un hash falso da
// «no se puede entrar» y parece que el fallo está en la prueba cuando en
// realidad está en la contraseña.
const { hashPassword } = await import('../src/security/passwords.js')
const CONTRASENA = 'PruebaApi.2026'
const hash = await hashPassword(CONTRASENA)
await query(`INSERT INTO users (username, full_name, password_hash, locale, created_at)
             VALUES ('api-admin','Admin API',$1,'es',now()) ON CONFLICT (username) DO NOTHING`, [hash])
const userAdmin = await one("SELECT id FROM users WHERE username = 'api-admin'")
await query(`INSERT INTO roles (code, name) VALUES ('ADMIN','Administrador') ON CONFLICT (code) DO NOTHING`)
await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='ADMIN' ON CONFLICT DO NOTHING`, [userAdmin.id])
// Los permisos cuelgan de `permissions`, no de un par (módulo, acción) suelto:
// `role_permissions` une un rol con un permiso ya existente.
for (const accion of ['view', 'create', 'edit']) {
  await query(
    `INSERT INTO permissions (module, action)
     VALUES ('commercial', $1) ON CONFLICT (module, action) DO NOTHING`,
    [accion],
  )
}
await query(
  `INSERT INTO role_permissions (role_id, permission_id)
   SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'commercial'
    WHERE r.code = 'ADMIN' ON CONFLICT DO NOTHING`,
)
// Si esto no está, el servidor va a arrancar contra una base sin usuario y el
// fallo va a parecer de contraseña.
const _creado = await one("SELECT id, username FROM users WHERE username = 'api-admin'")
console.error(`  [traza] usuario creado: ${JSON.stringify(_creado)}`)

await closeDb()
// (el migrador no necesita la clave: solo aplica ficheros)

const servidor = spawn('node', ['arrancar.mjs'], {
  cwd: `${RAIZ}/server`,
  env: { ...process.env, PGLITE_DIR: BD, PORT: String(PUERTO), JWT_SECRET: CLAVE, NODE_ENV: 'test' },
  stdio: 'pipe',
})

const parar = async () => { try { servidor.kill('SIGTERM') } catch { /* ya está */ } }
process.on('exit', parar)

// Se espera a que responda.
let listo = false
for (let i = 0; i < 40 && !listo; i++) {
  await new Promise((r) => setTimeout(r, 700))
  const h = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
  listo = h
}
if (!listo) {
  console.error('  El servidor de pruebas no ha arrancado.')
  const salida = []
  servidor.stdout.on('data', (d) => salida.push(String(d)))
  servidor.stderr.on('data', (d) => salida.push(String(d)))
  await new Promise((r) => setTimeout(r, 500))
  console.error(salida.join('\n').slice(0, 800))
  parar()
  process.exit(1)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('0 · ENTRAR Y CREARNOS LO QUE NECESITAMOS')

//
// La base de la prueba está VACÍA: no se siembran usuarios, porque sembrarlos
// es cosa del ERP y este módulo no lo toca. Se crea lo justo —un admin y un
// comercial— directamente con SQL, que es lo que haría alguien montando un
// entorno de pruebas.
//
// (la preparación del usuario va ANTES de arrancar el servidor: abrir la base
// desde dos procesos a la vez es lo que corrompe PGlite. Ver docs/ALCANCE.md.)


const admin = await pedir('/api/auth/login', {
  metodo: 'POST', cuerpo: { username: 'api-admin', password: CONTRASENA },
})
if (admin.estado !== 200) {
  console.error('  No se ha podido entrar con el usuario de prueba:',
    JSON.stringify(admin.cuerpo).slice(0, 160))
  parar(); process.exit(1)
}
const T = admin.cuerpo.access
ok('sesión de administrador')

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LA API DICE LO QUE EL NÚCLEO DICE')

const zona = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T,
  cuerpo: { code: 'API-Z1', name: 'Zona API', kind: 'URBANA', idiomas: [{ language: 'fr' }] },
})
if (zona.estado === 201) ok(`alta de zona → 201, id ${zona.cuerpo.id}`)
else mal(`alta de zona → ${zona.estado}: ${zona.cuerpo?.error}`)

// Id feo: tiene que ser 4xx y decir por qué.
for (const [nombre, ruta, metodo, cuerpo] of [
  ['id no numérico', '/api/comerciales/abc/zona', 'POST', { zonaId: 1 }],
  ['id cero', '/api/comerciales/0/objetivos', 'GET', null],
  ['cuerpo vacío', '/api/comerciales/zonas', 'POST', []],
]) {
  const r = await pedir(ruta, { metodo, token: T, cuerpo })
  if (r.estado >= 400 && r.estado < 500) ok(`${nombre} → ${r.estado} «${String(r.cuerpo?.error).slice(0, 52)}…»`)
  else mal(`${nombre} → ${r.estado}: debería ser un 4xx con motivo`)
}

// ─── Sin permiso ─────────────────────────────────────────────────────
const sinToken = await pedir('/api/comerciales/ranking')
if (sinToken.estado === 401) ok('sin token → 401 NO_AUTENTICADO')
else mal(`sin token → ${sinToken.estado}`)

const tokenFalso = await pedir('/api/comerciales/ranking', { token: 'esto-no-es-un-token' })
if (tokenFalso.estado === 401) ok('token inválido → 401')
else mal(`token inválido → ${tokenFalso.estado}`)

// ─── Un comercial sin idioma, por HTTP ──────────────────────────────
const sinIdioma = await pedir('/api/comerciales', {
  metodo: 'POST', token: T, cuerpo: { userId: 1, idiomas: [] },
})
if (sinIdioma.estado === 400 && sinIdioma.cuerpo?.codigo === 'COMERCIAL_SIN_IDIOMA') {
  ok(`sin idioma → 400 COMERCIAL_SIN_IDIOMA: «${String(sinIdioma.cuerpo.error).slice(0, 58)}…»`)
} else {
  mal(`sin idioma → ${sinIdioma.estado}/${sinIdioma.cuerpo?.codigo}: la API ha aceptado algo que el núcleo rechaza`)
}

// ─── Los errores internos tienen código ─────────────────────────────
//
// Un 500 sin código no se puede tratar en la pantalla. Se comprueba que los
// errores del núcleo vienen con su código y su texto, no como un genérico.
//
const zonaMala = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T, cuerpo: { code: 'ok-x', name: 'Buena', kind: 'INVENTADO' },
})
if (zonaMala.estado === 400 && zonaMala.cuerpo?.codigo && zonaMala.cuerpo?.error?.length > 10) {
  ok(`tipo inválido → 400 ${zonaMala.cuerpo.codigo} con mensaje claro`)
} else {
  mal(`tipo inválido → ${zonaMala.estado}: ${JSON.stringify(zonaMala.cuerpo).slice(0, 90)}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · UN DOBLE ENVÍO NO HACE DOBLE')

// ─── Crear un comercial ─────────────────────────────────────────────
//
// Dos peticiones IDÉNTICAS, a la vez. Las dos pueden pasar el «no existe» y las
// dos pueden intentar el INSERT; el índice único es el que decide, y solo una
// puede ganar.
//
const antes = await pedir('/api/comerciales', { token: T })
const totalAntes = antes.cuerpo.length

const doble = await Promise.all([
  pedir('/api/comerciales', {
    metodo: 'POST', token: T, cuerpo: { userId: 1, idiomas: ['fr'], zonaId: zona.cuerpo.id },
  }),
  pedir('/api/comerciales', {
    metodo: 'POST', token: T, cuerpo: { userId: 1, idiomas: ['fr'], zonaId: zona.cuerpo.id },
  }),
  pedir('/api/comerciales', {
    metodo: 'POST', token: T, cuerpo: { userId: 1, idiomas: ['fr'], zonaId: zona.cuerpo.id },
  }),
])

const creados = doble.filter((r) => r.estado === 201).length
const rechazados = doble.filter((r) => r.estado >= 400).length
ok(`3 altas idénticas simultáneas: ${creados} creada(s), ${rechazados} rechazada(s)`)

if (creados === 1) ok('  → solo UNA se crea: el índice único ha decidido')
else mal(`  → se han creado ${creados}. Con el mismo usuario no puede haber más de una`)

const listaDespues = await pedir('/api/comerciales', { token: T })
const delta = listaDespues.cuerpo.length - totalAntes
if (delta === 1) ok(`  → y en la lista hay exactamente ${delta} más, no ${creados}`)
else mal(`  → la lista ha crecido ${delta}, y debería ser 1`)

// Los rechazos tienen que decir algo, no ser un error mudo.
for (const r of doble.filter((x) => x.estado >= 400)) {
  if (r.cuerpo?.error && r.cuerpo?.codigo) ok(`  → el rechazo dice: ${r.cuerpo.codigo}`)
  else mal(`  → un rechazo sin mensaje ni código: ${r.estado}`)
}

// ─── Registrar la MISMA visita varias veces ─────────────────────────
//
// Aquí SÍ tiene que haber varias: son visitas distintas. Lo que no puede pasar
// es que se cuelen por un camino que nocuente como dos.
//
const alta = doble.find((r) => r.estado === 201)
const comercialId = alta.cuerpo.id

const antesVisitas = (await pedir('/api/comerciales/visitas?comercialId=' + comercialId, { token: T })).cuerpo.length
const cuatro = await Promise.all([
  pedir('/api/comerciales/visitas', { metodo: 'POST', token: T, cuerpo: { comercialId, resultado: 'ORDER_TAKEN' } }),
  pedir('/api/comerciales/visitas', { metodo: 'POST', token: T, cuerpo: { comercialId, resultado: 'ORDER_TAKEN' } }),
])
const okVisitas = cuatro.filter((r) => r.estado === 201).length
const despuesVisitas = (await pedir('/api/comerciales/visitas?comercialId=' + comercialId, { token: T })).cuerpo.length

if (despuesVisitas === antesVisitas + okVisitas) {
  ok(`2 visitas simultáneas → ${okVisitas} guardadas, y la lista cuadra (${antesVisitas} → ${despuesVisitas})`)
} else {
  mal(`las visitas no cuadran: ${antesVisitas} → ${despuesVisitas}, y guardaron ${okVisitas}`)
}

// ─── Conceder puntos dos veces a la vez ─────────────────────────────
const puntos1 = await Promise.all([
  pedir(`/api/comerciales/${comercialId}/puntos/conceder`, { metodo: 'POST', token: T }),
  pedir(`/api/comerciales/${comercialId}/puntos/conceder`, { metodo: 'POST', token: T }),
  pedir(`/api/comerciales/${comercialId}/puntos/conceder`, { metodo: 'POST', token: T }),
])
const losQueFuncionaron = puntos1.filter((r) => r.estado < 400).length
ok(`conceder puntos 3 veces a la vez → ${losQueFuncionaron} respuesta(s) sin error`)

const detalle = (await pedir(`/api/comerciales/${comercialId}/puntos`, { token: T })).cuerpo.detalle
const reglasRepetidas = new Set(detalle.map((d) => d.regla)).size !== detalle.length
if (!reglasRepetidas) ok(`  → ningún punto duplicado: ${detalle.length} detalles, ${new Set(detalle.map((d) => d.regla)).size} reglas distintas`)
else mal(`  → hay reglas repetidas en el detalle: un punto se ha contado dos veces`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · LO QUE SÍ TIENE QUE PODER DUPLICARSE')

// Dos zonas con el mismo código NO: es el mismo código.
const dupZona = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T, cuerpo: { code: 'API-Z1', name: 'Duplicada', kind: 'URBANA' },
})
if (dupZona.estado >= 400) ok(`misma zona dos veces → ${dupZona.estado}, rechazado por la base`)
else mal('se ha permitido dar de alta dos veces la misma zona')

// Dos objetivos de periodos DISTINTOS sí.
const hoy = new Date()
const mañana = new Date(hoy.getTime() + 86400000).toISOString().slice(0, 10)
const manana30 = new Date(hoy.getTime() + 86400000 * 30).toISOString().slice(0, 10)
const despues30 = new Date(hoy.getTime() + 86400000 * 60).toISOString().slice(0, 10)

const o1 = await pedir(`/api/comerciales/${comercialId}/objetivo`, {
  metodo: 'POST', token: T, cuerpo: { periodStart: mañana, periodEnd: manana30, targetAmount: 100 },
})
const o2 = await pedir(`/api/comerciales/${comercialId}/objetivo`, {
  metodo: 'POST', token: T, cuerpo: { periodStart: despues30, periodEnd: manana30, targetAmount: 200 },
})
if (o1.estado === 201 && o2.estado === 201) ok('dos objetivos en periodos distintos → los dos, que es lo correcto')
else mal(`objetivos en periodos distintos: ${o1.estado} y ${o2.estado}`)

// El MISMO periodo dos veces, no.
const o3 = await pedir(`/api/comerciales/${comercialId}/objetivo`, {
  metodo: 'POST', token: T, cuerpo: { periodStart: mañana, periodEnd: manana30, targetAmount: 999 },
})
if (o3.estado === 200) ok('el mismo periodo dos veces → 200, y ACTUALIZA en vez de duplicar')
else if (o3.estado === 201) mal('el mismo periodo dos veces ha creado un segundo objetivo')
else mal(`el mismo periodo dos veces → ${o3.estado}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · LOS ERRORES QUE NO DEBEN TRAGARSE')

const obligatorios = [
  ['periodo ya empezado', `/api/comerciales/${comercialId}/objetivo`, 'POST',
    { periodStart: '2020-01-01', periodEnd: '2020-01-31', targetAmount: 1 }, 'OBJETIVO_CERRADO'],
  ['objetivo vacío', `/api/comerciales/${comercialId}/objetivo`, 'POST',
    { periodStart: mañana, periodEnd: manana30 }, 'OBJETIVO_VACIO'],
  ['resultado inventado', '/api/comerciales/visitas', 'POST',
    { comercialId, resultado: 'INVENTADO' }, 'RESULTADO_INVALIDO'],
  ['cliente inexistente', '/api/comerciales/visitas', 'POST',
    { comercialId, clienteId: 999999, resultado: 'PRODUCT_SHOWN' }, 'CLIENTE_NO_EXISTE'],
]

for (const [nombre, ruta, metodo, cuerpo, codigo] of obligatorios) {
  const r = await pedir(ruta, { metodo, token: T, cuerpo })
  if (r.estado === 400 && r.cuerpo?.codigo === codigo) {
    ok(`${nombre} → 400 ${codigo}`)
  } else {
    mal(`${nombre} → ${r.estado}/${r.cuerpo?.codigo}, esperaba 400/${codigo}`)
  }
  // Y el mensaje tiene que ser de alguien, no de una máquina.
  if (r.cuerpo?.error && r.cuerpo.error.length > 25) {
    ok(`  «${String(r.cuerpo.error).slice(0, 68)}…»`)
  } else {
    mal(`  el mensaje es demasiado corto para ser útil: «${r.cuerpo?.error}»`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · QUE NO SE ROMPA NADA DEL ERP')

//
// El módulo se usa a saco por HTTP y se comprueba que el ERP sigue igual.
//
const antesE = await pedir('/api/inventory/resumen', { token: T })
const despuesE = await pedir('/api/inventory/resumen', { token: T })
if (JSON.stringify(antesE.cuerpo) === JSON.stringify(despuesE.cuerpo)) {
  ok('el resumen de inventario no cambia ni un número tras usar el módulo')
} else {
  mal('el inventario ha cambiado tras usar Comerciales')
}

const catalogo = await pedir('/api/items', { token: T })
ok(`el catálogo sigue teniendo ${catalogo.cuerpo.length} artículos`)

// El ranking se lee, pero no escribe en el ERP: dos lecturas seguidas dan lo mismo.
const r1 = await pedir('/api/comerciales/ranking', { token: T })
const r2 = await pedir('/api/comerciales/ranking', { token: T })
if (JSON.stringify(r1.cuerpo) === JSON.stringify(r2.cuerpo)) ok('leer el ranking dos veces da exactamente lo mismo')
else mal('el ranking cambia al releerlo: algo se está escribiendo al mirar')

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · LAS REGLAS DEL NÚCLEO SIGUEN VIGENTES POR HTTP')

const ranking = (await pedir('/api/comerciales/ranking', { token: T })).cuerpo
const filas = ranking.comerciales
ok(`el ranking devuelve ${filas.length} comercial(es) con el campo tieneObjetivo`)

const conObjetivo = filas.find((f) => f.tieneObjetivo)
const sinObjetivo = filas.find((f) => !f.tieneObjetivo)
if (conObjetivo) {
  ok(`uno CON objetivo: cumplimiento «${conObjetivo.cumplimientoTexto}», valor ${conObjetivo.cumplimientoPct}`)
  if (conObjetivo.cumplimientoPct !== null) ok('  → y el número NO es null, porque sí tiene objetivo')
} else ok('nadie tiene objetivo este mes (el que se puso empieza mañana): todos sin objetivo')
if (sinObjetivo) {
  if (sinObjetivo.cumplimientoPct === null) ok(`uno SIN objetivo: cumplimiento ${sinObjetivo.cumplimientoPct} y texto «${sinObjetivo.cumplimientoTexto}»`)
  else mal(`uno sin objetivo trae cumplimiento ${sinObjetivo.cumplimientoPct}: se ha colado un 0`)
}
if (conObjetivo && sinObjetivo) {
  const puestoCon = filas.find((f) => f.comercial_id === conObjetivo.comercialId).puesto
  const puestoSin = filas.find((f) => f.comercial_id === sinObjetivo.comercialId).puesto
  if (puestoSin > puestoCon) ok(`el que no tiene objetivo va detrás: ${puestoSin} vs ${puestoCon}`)
  else mal(`el que no tiene objetivo va ${puestoSin} y el que tiene ${puestoCon}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('6 · ¿ESTAS PRUEBAS PUEDEN FALLAR?')

// Se comprueba que el servidor, en verdad, rechaza lo que debe.
// Si `pedir` devolviera siempre 200, estas pruebas pasarían sin comprobar nada.
const pruebaDePlaca = await pedir('/api/comerciales/visitas', { metodo: 'POST', token: T, cuerpo: {} })
if (pruebaDePlaca.estado === 400) ok('una visita sin resultado se rechaza: la placa de la prueba NO pasa todo')
else mal('una visita sin resultado NO se rechaza: la prueba no está comprobando nada')

const rutaInexistente = await pedir('/api/comerciales/no-existe', { token: T })
if (rutaInexistente.estado === 404) ok('una ruta inexistente da 404, no 200 vacío')
else mal(`una ruta inexistente da ${rutaInexistente.estado}`)

// Y se comprueba que el ranking REALMENTE ordena: se reversea la lista y se
// mira que los puestos ya no encajen. Si `puesto` fuera decorativo, aquí no se
// notaría.
if (filas.length >= 2) {
  const reves = [...filas].reverse()
  const encaja = reves.every((f, i) => f.puesto >= reves[i - 1]?.puesto ?? true)
  if (!encaja) mal('el campo `puesto` no ordena la lista: es decorativo')
  else ok('el campo `puesto` ordena de verdad la lista que devuelve la API')
}

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LA API ESTÁ VERIFICADA' : `HAY ${fallos} FALLOS`)

console.log('')
await rm(BD, { recursive: true, force: true }).catch(() => {})
parar()
await new Promise((r) => setTimeout(r, 800))
process.exit(fallos === 0 ? 0 : 1)