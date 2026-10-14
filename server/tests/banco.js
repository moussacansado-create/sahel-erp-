/**
 * Banco de pruebas.
 *
 * Cada prueba arranca con una base PostgreSQL limpia, aplica TODAS las
 * migraciones y siembra lo mínimo. Nada de la aplicación anterior, nada de
 * producción: aquí solo se prueba lo nuevo.
 */

// ANTES de nada: las pruebas usan una base APARTE.
//
// Compartían `./.pgdata` con el servidor de demostración, y `baseDePrueba()`
// hace DROP SCHEMA. Bastaba con lanzar la suite para borrar los datos de trabajo
// y encontrarse un login que no funciona, sin explicación aparente.
process.env.PGLITE_DIR = process.env.PGLITE_TEST_DIR || './.pgdata-test'

// La clave de las pruebas, aqui y no en cada test.
//
// `src/config` EXIGE `JWT_SECRET` y no tiene valor de reserva a proposito: en
// la aplicacion anterior si lo tenia, y por eso un despliegue se podia quedar
// con una clave que cualquiera adivina. Aqui se pone una unica vez, para que
// ningun test tenga que acordarse, y con `||=` para que una clave de verdad
// siga mandando sobre esta.
const CLAVE_PRUEBAS = 'clave-de-pruebas-interfaz-suficientemente-larga-1234567890'
// Se respeta la del entorno SOLO si es utilizable. `src/config` exige 32
// caracteres y aborta si no, y con un `||=` a secas una clave corta de fuera
// (un `JWT_SECRET=x` al lanzar, por ejemplo) se colaba y tumbaba toda la suite
// con un error que no dice nada de los tests.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = CLAVE_PRUEBAS
}

const { PGlite } = await import('@electric-sql/pglite')
import { query, one, transaction, closeDb, getDb, exec } from '../src/db/client.js'
import { instalarBase } from '../src/db/instalar.js'

/** Contadores globales de la ejecución. */
const estado = { ok: 0, fallos: 0, mensajes: [] }

export function resumen() {
  return estado
}

export function comprobar(nombre, condicion, detalle = '') {
  if (condicion) {
    estado.ok++
    estado.mensajes.push(`  ✅ ${nombre}`)
  } else {
    estado.fallos++
    estado.mensajes.push(`  ❌ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
  }
  return Boolean(condicion)
}

export function seccion(titulo) {
  estado.mensajes.push('')
  estado.mensajes.push(`▸ ${titulo}`)
}

/** Base limpia con migraciones y semillas aplicadas. */
export async function baseDePrueba() {
  const db = await getDb()

  //
  // SOLO SE TIRA EL ESQUEMA SI HAY ALGO QUE TIRAR.
  //
  // `DROP SCHEMA public CASCADE` sobre un esquema que ya no existe deja a
  // PGlite con la caché de tipos apuntando a OIDs que acaban de morir, y la
  // siguiente consulta revienta con «cache lookup failed for type 311724».
  // No es un fallo de la migración: es que no había nada que borrar y aun así
  // se borró.
  //
  // Cuando la carpeta de la base de pruebas no existe —la primera vez, o tras
  // borrarla a mano— PGlite crea el esquema vacío. Preguntar antes de tirar es
  // la diferencia entre una suite que arranca sola y una que hay que arreglar
  // borrando la carpeta a mano.
  const hay = await one(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`)
  if (Number(hay.n) > 0) {
    await exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  }

  // El instalador mete la semilla EN MEDIO: hay un guardián dentro de las
  // migraciones (la 035) que comprueba que quede algún comercial, y la
  // semilla es la que lo crea. Correr todas y sembrar después miraba el
  // guardián antes de tiempo, y como el fallo tumba el WASM de PGlite
  // entero, se caía la base y con ella todas las pruebas.
  await instalarBase({ silencioso: true })
  return db
}

/**
 * Un servidor propio, en un puerto libre, sobre la base de PRUEBAS.
 *
 * Para que un test no apunte a `127.0.0.1:10000`, que es el servidor de la
 * demo y su base de verdad. Con los tests apuntando ahi, cada ejecucion
 * escribia en la demo: por eso tenia clientes de prueba.
 *
 * Puerto 0 = el sistema elige uno libre. Dos tests a la vez no se pisan.
 *
 * @returns {Promise<{app: object, base: string, cerrar: () => Promise<void>}>}
 */
export async function servidorDePrueba() {
  const { createApp } = await import('../src/app.js')
  const app = createApp()
  const servidor = await new Promise((c) => { const s = app.listen(0, '127.0.0.1', () => c(s)) })
  return {
    app,
    base: `http://127.0.0.1:${servidor.address().port}`,
    async cerrar() { await new Promise((c) => servidor.close(c)) },
  }
}

/**
 * Base limpia + servidor propio + gente con la que entrar.
 *
 * Es el arranque de los tests que hablan con la API, en vez de tres imports
 * sueltos y una constante con el puerto de la demo.
 *
 * @returns {Promise<{base: string, gente: object, cerrar: () => Promise<void>}>}
 */
export async function entornoDePrueba() {
  await baseDePrueba()
  const { genteDemo } = await import('./datos-demo.mjs')
  const gente = await genteDemo()
  const srv = await servidorDePrueba()
  return { base: srv.base, gente, cerrar: srv.cerrar }
}

/**
 * Base limpia + datos de demo + servidor propio. Para los tests de API.
 *
 * El orden importa: primero la base, despues los datos, despues el servidor.
 * Al reves, el servidor abriria la base antes de estar sembrada.
 *
 * Este es el arranque que deben usar los tests que hablan con la API. En
 * particular, NINGUNO debe apuntar a `127.0.0.1:10000`: ese es el servidor de
 * la demostracion, y escribir ahi deja clientes de prueba en la demo.
 *
 * @returns {Promise<{base: string, gente: object, cerrar: () => Promise<void>}>}
 */
export async function entornoConDemo() {
  await baseDePrueba()
  const { sembrarDemo } = await import('./semilla-demo.mjs')
  await sembrarDemo()
  // Un comercial CON perfil, CON zona y CON idiomas.
  //
  // Sin esto, la semilla de demostración no deja ningún comercial: ella crea
  // usuarios, pero un usuario no es un comercial hasta que tiene fila en
  // `com_perfiles`. Los tests que editan la ficha encontraban con una lista
  // vacía, y una lista vacía no falla: no hay nada que comprobar.
  const { comercialDemo } = await import('./datos-demo.mjs')
  await comercialDemo()
  const srv = await servidorDePrueba()
  return { base: srv.base, cerrar: srv.cerrar }
}

/**
 * Falla si `url` apunta al servidor de la demostracion.
 *
 * No es un adorno: es la ultima red antes de que una prueba escriba en la
 * base de la demo. El fallo se ve en el nombre del test, no tres dias
 * despues en una lista de clientes que no cuadra.
 *
 * @param {string} nombreDelTest
 * @param {string} url
 */
export function noEsLaDemo(nombreDelTest, url) {
  if (/:10000\b/.test(String(url))) {
    throw new Error(
      `El test ${nombreDelTest} apunta al puerto 10000, que es el servidor de la ` +
      'demostracion. Los tests usan su propio servidor: `entornoConDemo()` o ' +
      '`servidorDePrueba()`.',
    )
  }
}

/** Crea un usuario con un rol y devuelve su id. */
export async function crearUsuario(username, rol) {
  const { hashPassword } = await import('../src/security/passwords.js')
  const hash = await hashPassword('contrasena-de-prueba-1')
  const u = await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ($1,$2,$3, now()) RETURNING *`,
    [username, username, hash],
  )
  const r = await one('SELECT id FROM roles WHERE code = $1', [rol])
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [u.id, r.id])
  return u
}

/** Alta de un artículo de prueba. */
export async function crearItem({ sku, name, kind, unitId, unitCode = 'L', minStock = 0, cost = 1 }) {
  const u = await one('SELECT id FROM units WHERE code = $1', [unitCode])
  return one(
    `INSERT INTO items (sku, name, category_kind, unit_id, min_stock, purchase_cost, sale_price)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [sku, name, kind, u.id, minStock, cost],
  )
}

// `exec` y `closeDb` se reexportan porque hay pruebas que necesitan SQL
// directo (para comprobar que la BASE rechaza lo que el código no debería
// dejar pasar nunca) y cerrar la conexión al terminar.
export { query, one, transaction, exec, closeDb, PGlite }
