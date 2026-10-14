/**
 * Migrador.
 *
 * Reglas:
 *   - Solo hacia adelante. No hay `down`; una migración aplicada no se deshace.
 *     Se corrige con una migración nueva.
 *   - Cada migración corre dentro de su propia transacción: si falla, no queda
 *     a medias.
 *   - El registro de qué se ha aplicado vive en la propia base, con el hash del
 *     contenido. Si alguien edita una migración ya aplicada, el migrador lo
 *     detecta y para en vez de dejar el esquema incoherente.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transaction, query, exec } from './client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'db', 'migrations')

/** Hash del contenido de un archivo, para detectar ediciones posteriores. */
async function hashFile(ruta) {
  const { createHash } = await import('node:crypto')
  const buf = await fs.readFile(ruta)
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

async function asegurarTablaRegistro() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `)
}

/**
 * Aplica todas las migraciones pendientes, en orden.
 * @returns {Promise<{aplicadas: string[], yaAplicadas: string[]}>}
 */
export async function migrar({ silencioso = false, hasta = null } = {}) {
  await asegurarTablaRegistro()

  const archivos = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()   // 001_, 002_, ... el prefijo numérico define el orden

  const aplicadas = []
  const yaAplicadas = []
  const registro = new Map(
    (await query('SELECT version, checksum FROM schema_migrations')).map((r) => [r.version, r.checksum]),
  )

  for (const archivo of archivos) {
    const version = archivo.replace(/\.sql$/, '')

    // PARADA A MEDIAS.
    //
    // Con `hasta` se aplican las migraciones HASTA esa versión, sin incluirla, y
    // se devuelve. Sirve para el instalador: hay un guardián (la 035) que
    // comprueba que quede algún comercial, y el comercial lo crea la semilla.
    // Si la semilla corre después de TODAS las migraciones, el guardián ya ha
    // mirado y falla en una base recién montada.
    //
    // No es un parche: es el orden correcto. La semilla va en medio.
    if (hasta && version === hasta) {
      if (!silencioso) console.log(`  → parando antes de ${version} (--hasta)`)
      return { aplicadas, yaAplicadas, paradaEn: version }
    }

    const checksum = await hashFile(path.join(MIGRATIONS_DIR, archivo))
    const previo = registro.get(version)

    if (previo) {
      if (previo !== checksum) {
        throw new Error(
          `La migración ${version} ya se aplicó pero su contenido cambió.\n` +
          `  aplicada: ${previo}\n  en disco : ${checksum}\n` +
          'Las migraciones son inmutables una vez aplicadas. Crea una migración nueva.',
        )
      }
      yaAplicadas.push(version)
      continue
    }

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, archivo), 'utf8')
    const t0 = Date.now()
    if (!silencioso) console.log(`  → aplicando ${version}…`)

    await transaction(async (tx) => {
      await tx.execScript(sql)   // una migración puede traer muchas sentencias
      await tx.query(
        'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
        [version, checksum, Date.now() - t0],
      )
    })
    aplicadas.push(version)
  }

  if (!silencioso) {
    console.log(`  migraciones: ${aplicadas.length} aplicadas, ${yaAplicadas.length} ya estaban`)
  }
  return { aplicadas, yaAplicadas }
}

/** Borra la base de pruebas. Solo se usa en el entorno de pruebas. */
export async function resetParaPruebas() {
  const tablas = await query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  `)
  await exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  return tablas.length
}
