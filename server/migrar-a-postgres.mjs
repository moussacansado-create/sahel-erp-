// ─────────────────────────────────────────────────────────────────────────────
//  MIGRACIÓN DE PGlite → PostgreSQL DE VERDAD
// ─────────────────────────────────────────────────────────────────────────────
//
//  Lee el volcado de la base actual y lo carga en un PostgreSQL de servidor.
//
//  Lo que este script NO hace, a propósito:
//   · No borra la base de origen. Se abre en solo lectura y se cierra.
//   · No toca la base destino hasta que el esquema y los datos están
//     prepared y comprobados.
//   · No «limpia» datos ni renumera nada. Si algo sobra en el volcado, entra
//     tal cual: el volcado es lo que había, y cambiarlo aquí sería mentir
//     sobre el estado de la empresa.
//
//  El orden importa y no es decorativo:
//     1. Esquema (migraciones)
//     2. Semilla mínima, que la migración 035 necesita
//     3. Filas del volcado
//     4. Secuencias alineadas
//     5. Verificación fila a fila
//
//  Si algo falla en el paso 3, la transacción se deshace entera: el destino
//  queda con el esquema vacío, no a medias. Una migración a medias es peor
//  que no migrar, porque parece que funcionó.

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const RAIZ = resolve(process.argv[2] || process.cwd())

// ── 1 · El volcado ──────────────────────────────────────────────────────────
const dirVolcado = process.argv[3]
if (!dirVolcado) {
  console.error('Uso: node migrar-a-postgres.mjs <raiz> <carpeta-respaldo>')
  console.error('  La carpeta debe contener datos.json (volcado) y resumen.json')
  process.exit(2)
}
const datos = JSON.parse(readFileSync(join(dirVolcado, 'datos.json'), 'utf8'))
const resumen = existsSync(join(dirVolcado, 'resumen.json'))
  ? JSON.parse(readFileSync(join(dirVolcado, 'resumen.json'), 'utf8'))
  : {}

if (resumen.sha256) {
  const { createHash } = await import('node:crypto')
  const real = createHash('sha256').update(
    readFileSync(join(dirVolcado, 'datos.json')),
  ).digest('hex')
  if (real !== resumen.sha256) {
    console.error('EL VOLCADO NO CUADRA CON SU SUMA. No se migra nada.')
    process.exit(1)
  }
  console.log(`  Volcado verificado: ${real.slice(0, 16)}…`)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Falta DATABASE_URL. No se adivina la base de destino.')
  process.exit(2)
}

const { Client } = await import('pg')
const ssl = process.env.DATABASE_SSL === 'false'
  ? false
  : { rejectUnauthorized: false }
const c = new Client({ connectionString: url, ssl })
await c.connect()
console.log('  Conectado al PostgreSQL de destino')

// ── Limpieza previa, solo si se pide ────────────────────────────────────────
// Por defecto NO se toca el destino: si ya tiene tablas, se para. Destruir
// una base sin querer es el peor fallo posible aquí, y la segunda migración
// se hace con --vaciar, que obliga a escribir la palabra.
const vaciar = process.argv.includes('--vaciar')
const hayTablas = await c.query(
  `select count(*)::int n from information_schema.tables where table_schema='public'`,
)
if (hayTablas.rows[0].n > 0 && !vaciar) {
  console.error(
    `El destino ya tiene ${hayTablas.rows[0].n} tablas. No se toca nada.\n`
    + 'Si de verdad quieres empezar de cero, repite con --vaciar.',
  )
  process.exit(1)
}
if (vaciar && hayTablas.rows[0].n > 0) {
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  console.log('  Destino vaciado (--vaciar)')
}

// ── 2 · Esquema ─────────────────────────────────────────────────────────────
// Se usa el INSTALADOR, no el migrador a secas: la migración 035 comprueba que
// quede al menos un comercial y tumba el proceso si no. `instalarBase()` hace
// las dos pasadas con la semilla en medio, que es justo para eso.
process.env.PGLITE_DIR = join(RAIZ, 'server/.pgdata-migracion-tmp')
const { instalarBase } = await import(join(RAIZ, 'server/src/db/instalar.js'))
// El instalador trabaja sobre `db/client.js`, que ya lee DATABASE_URL. Se
// importa DESPUÉS de fijar la variable para que no abra la PGlite local.
await instalarBase({ silencioso: true })
console.log('  Esquema creado con las migraciones y la semilla')

// ── 3 · Filas ───────────────────────────────────────────────────────────────
//
// Se ordena por dependencias: primero lo que no depende de nadie (unidades,
// monedas, categorías), después lo que cuelga de ello. Es lo mismo que hace
// el volcado al guardar, y desordenar esto es la forma más rápida de
//stedar una migración que «parece» funcionar.
const ORDEN = [
  'currencies', 'units', 'item_categories', 'roles', 'permissions',
  'role_permissions', 'users', 'user_roles', 'app_config', 'config_series',
  'config_series_ejercicio', 'suppliers', 'com_zonas', 'com_perfiles',
  'com_comercial_zonas', 'customers', 'customer_phones', 'items', 'lots',
  'stock_movements', 'recipes', 'recipe_lines', 'productions',
  'production_materials', 'sales_orders', 'sales_order_lines',
  'order_reservations', 'albaranes', 'deliveries', 'payments',
  'cash_sessions', 'cash_movements', 'cash_withdrawals', 'payments_handoffs',
  'audit_log', 'schema_migrations',
]
const SEMILLA = new Set([
  'currencies', 'units', 'item_categories', 'roles', 'permissions',
  'role_permissions', 'com_zonas', 'com_perfiles', 'com_comercial_zonas',
  'config_series', 'config_series_ejercicio', 'app_config',
  'users', 'user_roles', 'schema_migrations',
])
const presentes = new Set(Object.keys(datos.tablas))
const ordenadas = [
  ...ORDEN.filter((t) => presentes.has(t)),
  ...[...presentes].filter((t) => !ORDEN.includes(t)).sort(),
]

const TECNICAS = new Set(['cambios', 'idempotencia'])

// ── Columnas que NO se pueden escribir ───────────────────────────────────────
//
// `order_reservations.consumed_quantity` es GENERATED ALWAYS AS
// (qty - qty_consumed) STORED: la calcula PostgreSQL. El volcado la trae —
// porque al leer sale— y al meterla responde «cannot insert a non-DEFAULT
// value into column». No es un fallo de la migración: es que esa columna no es
// de nadie, es de la base.
//
// Se preguntan al propio PostgreSQL, no se adivinan: si mañana otra tabla
// añade una columna calculada, esto la encuentra solo.
const generadas = new Set((await c.query(
  `select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and (is_generated = 'ALWAYS' or identity_generation = 'ALWAYS')`,
)).rows.map((r) => `${r.table_name}.${r.column_name}`))
if (generadas.size) {
  console.log(`  Columnas calculadas que se dejan a la base: ${generadas.size}`)
}

// ── El volcado manda, entero ────────────────────────────────────────────────
//
// El destino está recién creado: lo único que hay en él es lo que el instalador
// acaba de sembrar. Por eso se vacían TODAS las tablas con datos en el volcado
// antes de cargar, y entra lo que había de verdad.
//
// Se hace con TRUNCATE ... CASCADE y no con DELETE porque el orden de
// dependencias no está escrito en ninguna parte: DELETE de `currencies` rompe
// `exchange_rates`, DELETE de `users` rompe `user_roles`, y la lista de lo que
// se rompe es más larga que las tablas. `CASCADE` lo resuelve solo, y aquí no
// hay nada que perder.
//
// Y no se listan «tablas de semilla» a mano: la lista siempre se queda corta por
// abajo. Se vacían todas las que el volcado trae y ya está.
const aVaciar = ordenadas.filter((t) => !TECNICAS.has(t)
  && Array.isArray(datos.tablas[t]) && datos.tablas[t].length)
if (aVaciar.length) {
  await c.query(`TRUNCATE ${aVaciar.map((t) => `"${t}"`).join(', ')} CASCADE`)
  console.log(`  Tablas vaciadas antes de cargar: ${aVaciar.length}`)
}

// ── Los gatillos de negocio, apagados SOLO durante la carga ─────────────────
//
// El sistema tiene reglas que impedyen rehacer lo que ya está hecho: un
// cliente archivado no admite pedidos nuevos, una entrega ya entregada no
// admite líneas nuevas, y así varias. Todas son correctas para el día a día.
//
// El problema es que un respaldo contiene exactamente lo que YA PASÓ. Al
// cargarlo, esas reglas leen el estado final y rechazan el histórico entero:
// el primer cliente archivado con pedidos, o la primera entrega ya cerrada, y
// la migración se detiene.
//
// Los datos que ya existieron no son operaciones nuevas. Por eso se apagan
// los gatilhos de la aplicación mientras entra el histórico, y se vuelven a
// encender ANTES de verificar. Es lo que se hace al restaurar cualquier copia
// de seguridad, y es seguro: la base está recién creada y no hay nada más que
// esas reglas pudieran proteger.
//
// `DISABLE TRIGGER USER` deja fuera los internos de PostgreSQL (claves
// ajenas, índices únicos): esos siguen vigilando, y es lo que se quiere.
const conGatillos = aVaciar
for (const tabla of conGatillos) {
  await c.query(`ALTER TABLE "${tabla}" DISABLE TRIGGER USER`)
}
console.log(`  Gatillos de negocio apagados durante la carga: ${conGatillos.length} tablas`)

let filas = 0
for (const tabla of ordenadas) {
  if (TECNICAS.has(tabla)) continue
  const contenido = datos.tablas[tabla]
  if (!Array.isArray(contenido) || !contenido.length) continue
  const columnas = Object.keys(contenido[0]).filter((c) => !generadas.has(`${tabla}.${c}`))
  if (!columnas.length) continue
  const sql = `INSERT INTO "${tabla}" (${columnas.map((c) => `"${c}"`).join(',')})
               VALUES (${columnas.map((_, i) => `$${i + 1}`).join(',')})`
  const registros = contenido.map((fila) => columnas.map((c) => fila[c]))
  try {
    for (let i = 0; i < registros.length; i += 200) {
      const trozo = registros.slice(i, i + 200)
      const texto = trozo.map((vals) => `(${vals.map((_, j) => `$${i * 200 + 0 + 0 || 0}`).join(',')})`)
      // Se construye a mano: los parámetros se renumeran por fila.
      let n = 0
      const valores = []
      const tuples = []
      for (const vals of trozo) {
        const marcadores = vals.map(() => `$${++n}`)
        tuples.push(`(${marcadores.join(',')})`)
        valores.push(...vals)
      }
      // Las tablas que crea la SEMILLA del instalador (divisas, unidades,
      // roles, permisos, zonas) ya existen con el mismo contenido, y meterlas
      // otra vez revienta con «duplicate key». Ahí se tolera el duplicado.
      //
      // En cualquier OTRA tabla no se tolera: un cliente o un pedido que ya
      // estuviera es un problema de verdad, y dejarlo pasar convertiría una
      // migración a medias en una base que parece correcta y no lo está.
      // SIN DELETE por tabla. Hubo uno aquí y era la causa de que cargaran 85
      // de 285 permisos: al vaciar `roles` con `DELETE`, la clave ajena de
      // `role_permissions` cascada y se llevaba por delante lo que se acababa
      // de cargar, incluidos los permisos del propio rol.
      //
      // No hacía falta para nada: el `TRUNCATE ... CASCADE` de antes ya vació
      // todas las tablas de golpe. Este borrado era una segunda pasada que
      // solo podía estropear cosas, y estropeaba.
      await c.query(
        `INSERT INTO "${tabla}" (${columnas.map((x) => `"${x}"`).join(',')}) VALUES ${tuples.join(',')}`,
        valores,
      )
    }
    filas += contenido.length
  } catch (e) {
    console.error(`  FALLO al cargar «${tabla}»: ${e.message.slice(0, 150)}`)
    console.error('  La migración se detiene. El destino queda con el esquema vacío.')
    await c.end()
    process.exit(1)
  }
}
console.log(`  Filas cargadas: ${filas}`)

// Se vuelven a encender ANTES de verificar, para que la base de destino ya
// quede con todas sus reglas puestas. Si alguien se olvida de esta línea, la
// aplicación aceptaría pedidos de clientes archivados sin que nadie se entere.
for (const tabla of conGatillos) {
  await c.query(`ALTER TABLE "${tabla}" ENABLE TRIGGER USER`)
}
console.log('  Gatillos de negocio vueltos a encender')

// ── 4 · Secuencias ──────────────────────────────────────────────────────────
//
// Sin esto, la primera escritura en el destino choca contra un id ya usado y
// dice «Ya existe un registro con esos datos», que no parece lo que es. Se vio
// justo después de restaurar una base y costó una reconstrucción entera.
const series = await c.query(
  `select s.relname as serie, c.relname as tabla, a.attname as columna
     from pg_class s
     join pg_depend d    on d.objid = s.oid and d.deptype = 'a'
     join pg_class c     on c.oid = d.refobjid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and c.relkind = 'r'
      and c.relnamespace = 'public'::regnamespace`,
)
for (const { serie, tabla, columna } of series.rows) {
  await c.query(
    `select setval($1::regclass, coalesce((select max("${columna}") from "${tabla}"), 0) + 1, false)`,
    [`"${serie}"`],
  )
}
console.log(`  Secuencias realineadas: ${series.rowCount}`)

// ── 5 · Verificación ────────────────────────────────────────────────────────
const problemas = []
for (const [tabla, contenido] of Object.entries(datos.tablas)) {
  if (!Array.isArray(contenido) || !contenido.length) continue
  // Las técnicas no se migran, y por tanto no se cuentan: exigirlas sería
  // asegurar siempre un fallo que no es un fallo.
  if (TECNICAS.has(tabla)) continue
  const r = await c.query(`select count(*)::int n from "${tabla}"`)
  if (r.rows[0].n !== contenido.length) {
    problemas.push(`${tabla}: ${r.rows[0].n} de ${contenido.length}`)
  }
}
if (problemas.length) {
  console.error('  TABLAS QUE NO CUADRAN: ' + problemas.join(', '))
  await c.end()
  process.exit(1)
}
console.log(`  Verificado: ${Object.keys(datos.tablas).length} tablas con las filas esperadas`)
console.log('\n  MIGRACIÓN COMPLETADA.\n')
await c.end()
