// Aplica TODAS las migraciones sobre la base que se le pase por parámetro.
//
// Existe para que una prueba pueda levantar SU PROPIA base y su propio
// servidor. La base de trabajo del ERP nunca se abre desde una prueba: el
// servidor la tiene abierta y PGlite es de una sola conexión.
process.env.PGLITE_DIR = process.argv[2]
if (!process.env.PGLITE_DIR) {
  console.error('  Falta la ruta de la base.')
  process.exit(1)
}
const { migrar } = await import('../src/db/migrador.js')
await migrar({ silencioso: true })
console.log('  OK migrada:', process.env.PGLITE_DIR)
const { closeDb } = await import('../src/db/client.js')
await closeDb()
