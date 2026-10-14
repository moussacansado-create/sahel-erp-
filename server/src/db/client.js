/**
 * Cliente de base de datos.
 *
 * Una sola puerta de entrada a PostgreSQL. Ningún módulo abre su propia
 * conexión: así el pool, los timeouts y la instrumentación son los mismos en
 * todas partes.
 *
 * La app se conecta a:
 *   - PGlite (PostgreSQL compilado a WASM) en desarrollo y en las pruebas
 *   - Un PostgreSQL normal en producción
 *
 * La diferencia está solo en el driver; el SQL es idéntico, que es el punto.
 */

let db = null

/** Devuelve la conexión, creándola la primera vez. */
export async function getDb() {
  if (db) return db
  const url = process.env.DATABASE_URL
  if (url) {
    const { Pool } = await import('pg')
    db = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    db = await PGlite.create({ dataDir: process.env.PGLITE_DIR || './.pgdata' })
  }
  return db
}

/** Cierra la conexión. Se usa al apagar y entre pruebas. */
export async function closeDb() {
  if (!db) return
  const c = db
  db = null
  if (typeof c.end === 'function') await c.end()
  else if (typeof c.close === 'function') await c.close()
}

/**
 * Consulta que devuelve filas.
 * @param {string} text  SQL CON PARAMETROS ($1, $2...). Nunca valores pegados.
 * @param {Array}  params
 */
export async function query(text, params = []) {
  const c = await getDb()
  const r = await c.query(text, params)
  return r.rows
}

/** Consulta que devuelve una sola fila, o undefined. */
export async function one(text, params = []) {
  const rows = await query(text, params)
  return rows[0]
}

/** Consulta que devuelve un escalar. */
export async function scalar(text, params = []) {
  const r = await one(text, params)
  if (!r) return undefined
  return Object.values(r)[0]
}

/**
 * Ejecuta SQL sin parámetros. Para DDL y scripts de migración.
 * En PGlite el canal simple admite varias sentencias; en pg hay que envueltas
 * en una transacción.
 */
export async function exec(text) {
  const c = await getDb()
  if (esPglite(c)) return c.exec(text)
  const client = await c.connect()
  try {
    await client.query('BEGIN')
    await client.query(text)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Ejecuta una función dentro de una transacción.
 *
 * ESTA ES LA ÚNICA FORMA DE ESCRIBIR EN LA BASE DE DATOS. Si la función lanza,
 * se hace ROLLBACK completo. Es lo que garantiza que no queden operaciones a
 * medias: un lote de producto sin su consumo, un pedido sin su reserva, una
 * entrega que descontó a medias.
 *
 * Las transacciones NO se anidan: se pasa el cliente a las funciones internas
 * para que compartan la misma conexión y el mismo contexto.
 *
 * @param {(tx: {query: Function, one: Function, exec: Function}) => Promise<any>} fn
 */
export async function transaction(fn) {
  const c = await getDb()
  if (esPglite(c)) {
    return c.transaction(async (tx) => fn(wrap(tx)))
  }
  const client = await c.connect()
  try {
    await client.query('BEGIN')
    const r = await fn(wrap(client))
    await client.query('COMMIT')
    return r
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* la conexión ya está caída */ }
    throw e
  } finally {
    client.release()
  }
}

/** Normaliza el cliente de la transacción a la misma interfaz que el pool. */
function wrap(client) {
  return {
    query: async (text, params) => (await client.query(text, params)).rows,
    one: async (text, params) => (await client.query(text, params)).rows[0],
    exec: async (text) => { await client.query(text) },
    execScript: async (text) => {
      // Varios sentencias seguidas: el protocolo de PostgreSQL no lo admite en
      // una consulta preparada, así que se usa el canal simple.
      if (typeof client.exec === 'function') return client.exec(text)
      return client.query(text)
    },
  }
}

/**
 * ¿Es PGlite o un Pool de pg?
 * Se detecta por capacidades, no por el nombre de la clase: el bundle está
 * minificado y `constructor.name` no es fiable.
 */
function esPglite(c) {
  return typeof c.exec === 'function' && typeof c.transaction === 'function'
}
