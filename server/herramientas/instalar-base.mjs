// Monta una base desde cero, con la semilla en el sitio correcto.
//
// Igual que `migrar-una.mjs`, pero usando `instalarBase()`: las migraciones
// hasta el guardian de la 035, la semilla, y el resto. Correr solo
// `migrar()` falla en una base vacia, porque el guardian mira los comerciales
// antes de que la semilla los haya creado.
//
// Los tests que levantan SU PROPIA base en un subproceso usan esto.
process.env.PGLITE_DIR = process.argv[2]
if (!process.env.PGLITE_DIR) {
  console.error('  Falta la ruta de la base.')
  process.exit(1)
}
const { instalarBase } = await import('../src/db/instalar.js')
await instalarBase({ silencioso: true })
console.log('  OK instalada:', process.env.PGLITE_DIR)
const { closeDb } = await import('../src/db/client.js')
await closeDb()
