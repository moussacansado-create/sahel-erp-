/** CLI de migración: `npm run migrate` */
import { migrar } from './migrador.js'
import { sembrar } from './semillas.js'
import { closeDb } from './client.js'

try {
  console.log('▸ aplicando migraciones…')
  await migrar()
  console.log('▸ sembrando datos del sistema…')
  await sembrar()
  console.log('  ✓ esquema al día')
  await closeDb()
  process.exit(0)
} catch (e) {
  console.error(`  ✗ ${e.message}`)
  await closeDb().catch(() => {})
  process.exit(1)
}
