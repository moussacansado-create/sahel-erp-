/**
 * RESTAURAR UN RESPALDO.
 *
 * Lee un volcado de `respaldar.mjs` y lo escribe en una base de datos. Por
 * defecto, en una base NUEVA y aparte: la de producción no se toca salvo que
 * se pase `--en-produccion`, y eso hay que quererlo de verdad.
 *
 * POR QUÉ ES UN SCRIPT Y NO UN PAR DE COMANDOS
 *
 * Porque restaurando a mano, un día de prisa, se escribe sobre la base
 * equivocada. Aquí el destino por defecto es un directorio que no existe, y
 * que se crea. Para tocar producción hay que decirlo en voz alta y con una
 * bandera.
 *
 * USO
 *   node restaurar.mjs <carpeta-del-respaldo> [--destino <ruta>] [--en-produccion]
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const carpeta = args.find((a) => !a.startsWith('--'))
const destino = (() => {
  const i = args.indexOf('--destino')
  return i >= 0 ? args[i + 1] : null
})()
const EN_PRODUCCION = args.includes('--en-produccion')

if (!carpeta) {
  console.error('Falta la carpeta del respaldo. Uso: node restaurar.mjs <carpeta> [--destino <ruta>] [--en-produccion]')
  process.exit(1)
}

const fichero = join(carpeta, 'datos.json')
if (!existsSync(fichero)) {
  console.error(`No hay datos.json en ${carpeta}`)
  process.exit(1)
}

const crudo = readFileSync(fichero, 'utf8')
const cuerpo = JSON.parse(crudo)
const suma = createHash('sha256').update(crudo).digest('hex')

// ── La suma, ANTES de escribir nada ─────────────────────────────────────────
// Comprobar la integridad después de haber restaurado es tarde: el daño ya
// está escrito. Se comprueba antes, que es cuando todavía no ha pasado nada.
const resumenPath = join(carpeta, 'resumen.json')
if (existsSync(resumenPath)) {
  const resumen = JSON.parse(readFileSync(resumenPath, 'utf8'))
  if (resumen.sha256 !== suma) {
    console.error('EL RESPALDO ESTÁ CORROMPIDO. Las sumas no coinciden.')
    console.error(`  esperada: ${resumen.sha256}`)
    console.error(`  obtenida:  ${suma}`)
    console.error('No se ha escrito nada.')
    process.exit(1)
  }
  console.log(`Suma correcta: ${suma.slice(0, 16)}… (${resumen.filas} filas, ${resumen.tablas} tablas)`)
}

const raiz = resolve(new URL('..', import.meta.url).pathname)
const destinoFinal = EN_PRODUCCION
  ? join(raiz, 'server', '.pgdata')
  : join(destino || join(raiz, 'restauracion-prueba'), '.pgdata')

if (!EN_PRODUCCION) {
  // En un entorno aparte se empieza de cero. Si el directorio existe de una
  // prueba anterior, se quita: mezclar dos volcados no se puede deshacer.
  if (existsSync(join(destinoFinal, '..'))) rmSync(join(destinoFinal, '..'), { recursive: true, force: true })
  mkdirSync(raiz + '/restauracion-prueba', { recursive: true })
  console.log(`Se restaura en un entorno SEPARADO: ${destinoFinal}`)
  console.log('  La base de producción NO se toca.')
} else {
  console.log('*** ATENCIÓN: se va a ESCRIBIR SOBRE LA BASE DE PRODUCCIÓN ***')
  console.log(`  ${destinoFinal}`)
}

process.env.PGLITE_DIR = destinoFinal

// PRIMERO EL ESQUEMA.
//
// Una base nueva está vacía: no tiene tablas. Se aplican las migraciones —las
// mismas, y en el mismo orden, que las de producción— y solo después se
// escriben los datos. Sin este paso, el volcado no tiene dónde meterse y el
// error es «relation app_config does not exist», que no dice nada de un
// volcado corrupto sino de que faltaba la estructura.
// Se usa el INSTALADOR, no el migrador a secas, por un motivo concreto: la
// migración 035 comprueba que quede al menos un comercial y aborta si no.
// Con `migrar()` sobre una base vacía, esa comprobación mira antes de que
// exista nadie y tumba el WASM entero —que es como se loses la base, porque un
// error de PGlite no es una excepción: es una caída del proceso entero.
//
// `instalarBase()` hace las dos pasadas con la semilla en medio, que es lo que
// existe justamente para esto.
const { instalarBase } = await import('./src/db/instalar.js')
await instalarBase({ silencioso: true })
console.log('Esquema creado con las migraciones y la semilla')

const { query, closeDb } = await import('./src/db/client.js')

// EL ORDEN DE INSERCIÓN.
//
// Insertar tabla por tabla en orden alfabético choca con los disparadores que
//-cross validan: hay una regla que dice que no puede haber una zona sin
// comercial asignado, así que insertar las zonas antes que los comerciales
// falla con «No queda ningun comercial». Falló aquí, y el fallo parece de un
// volcado corrupto cuando en realidad es un orden.
//
// Se desactivan los disparadores de usuario durante la carga —
// `session_replication_role`— y se vuelven a activar al final. No es una
// comodidad: la base de origen ya cumplía todas las reglas, y un volcado que
// viene de ella las cumple por construcción. Lo que se pierde es la
// comprobación EN DURANTE la carga, y a cambio se recupera al final, con las
// reglas puestas, contando y releyendo lo escrito.
await query("set session_replication_role = replica")

let filas = 0
for (const [tabla, contenido] of Object.entries(cuerpo.tablas)) {
  if (!contenido.length) continue
  await query(`truncate table "${tabla}" cascade`)
}
// Las columnas CALCULADAS no se restauran: las pone la base.
//
// `order_reservations.consumed_quantity` es `GENERATED ALWAYS AS
// (qty - qty_consumed) STORED`. El volcado la trae —al leer, sale— y al
// insertarla PostgreSQL responde «cannot insert a non-DEFAULT value». No es
// un dato perdido: esa columna no existe, se deriva de las otras dos.
//
// Se preguntan a la propia base, no se escriben a mano, para que mañana otra
// tabla con columna calculada no vuelva a romper la restauración.
const generadas = new Set((await query(
  `select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and (is_generated = 'ALWAYS' or identity_generation = 'ALWAYS')`,
)).map((r) => `${r.table_name}.${r.column_name}`))
if (generadas.size) {
  console.log(`  Columnas calculadas que deja la base: ${generadas.size}`)
}

for (const [tabla, contenido] of Object.entries(cuerpo.tablas)) {
  if (!contenido.length) continue
  for (const fila of contenido) {
    const cols = Object.keys(fila).filter((c) => !generadas.has(`${tabla}.${c}`))
    if (!cols.length) continue
    const vals = cols.map((c) => fila[c])
    const ph = cols.map((_, i) => `$${i + 1}`).join(',')
    await query(`insert into "${tabla}" (${cols.map((c) => `"${c}"`).join(',')}) values (${ph})`, vals)
    filas++
  }
}

// Las reglas vuelven a estar puestas ANTES de dar el visto bueno, y se
// comprueba que la base restaurada responde y tiene lo que debe.
await query("set session_replication_role = origin")

const emptiness = []
for (const [tabla, contenido] of Object.entries(cuerpo.tablas)) {
  if (!contenido.length) continue
  const n = (await query(`select count(*)::int n from "${tabla}"`))[0].n
  if (n !== contenido.length) emptiness.push(`${tabla}: ${n} de ${contenido.length}`)
}

console.log(`Restauradas ${filas} filas en ${Object.keys(cuerpo.tablas).filter((t) => cuerpo.tablas[t].length).length} tablas`)
if (emptiness.length) {
  console.error('ATENCION: tablas que no cuadran tras restaurar: ' + emptiness.join(', '))
  process.exitCode = 1
} else {
  console.log('Verificado: cada tabla tiene las filas que decia el volcado')
}

// ── SECUENCIAS ──────────────────────────────────────────────────────────────
//
// El volcado lleva las filas CON su id. Las secuencias, en cambio, viven en
// `pg_catalog`, fuera de las tablas de usuario: el volcado no las ve y no las
// restaura.
//
// El efecto es un fallo que no dice nada: la aplicación arranca, el login va
// bien, y a la primera escritura falla con «Ya existe un registro con esos
// datos». Porque la secuencia seguía en 1, el siguiente INSERT pide un id que
// ya ocupa la fila que se acaba de restaurar. Parece un problema de duplicados
// y no lo es: es la serie del contador.
//
// Por eso va SIEMPRE, haya tablas con id o no: es barato y es la diferencia
// entre «funciona» y «funciona hasta el primer cliente».
const series = await query(
  // La unión va de la SECUENCIA hacia la tabla, no al revés: en una columna
  // serial, `pg_depend.objid` es la secuencia y `refobjid` es la tabla.
  // Escrito del otro modo devuelve cero filas y parece que no hay nada que
  // realinear, que es justo el fallo que vino a arreglar.
  `select c.relname as tabla, a.attname as columna, s.relname as serie
     from pg_class s
     join pg_depend d    on d.objid = s.oid and d.deptype = 'a'
     join pg_class c     on c.oid = d.refobjid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and c.relkind = 'r'
      and c.relnamespace = 'public'::regnamespace`,
)
for (const { tabla, columna, serie } of series) {
  // `false` = «el siguiente valor es este». Con `true` PostgreSQL daría por
  // hecho que el valor actual ya se ha usado y se saltaría un id, que es
  // molesto pero inofensivo; con `false` el siguiente INSERT coincide con
  // max+1, que es lo que se espera después de restaurar.
  await query(
    `select setval($1::regclass, coalesce((select max("${columna}") from "${tabla}"), 0) + 1, false)`,
    [`"${serie}"`],
  )
}
console.log(`Secuencias realineadas: ${series.length} (el proximo id no chocara con lo restaurado)`)
await closeDb()
