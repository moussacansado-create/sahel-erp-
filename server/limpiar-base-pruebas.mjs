/**
 * LIMPIEZA TOTAL DE LA BASE DE PRUEBAS.
 *
 * Una sola transacción: o sale todo o no sale nada. Y el ORDEN de borrado no
 * se escribe a mano, se calcula con las claves ajenas reales — se ha fallado
 * tres veces seguidas adivinándolo (payment_handoffs cuelga de cash_handoffs,
 * com_reglas_puntos cuelga de com_rankings…), y cada fallo es un 23503.
 *
 * Lo que NO se toca: estructura, migraciones, configuración, roles, permisos,
 * series de numeración, geografía y la cuenta de administrador.
 */
process.env.PGLITE_DIR = './.pgdata'
const { query, transaction, closeDb } =
  await import('/workspace/cleansahel-v2/server/src/db/client.js')

// Qué se vacía. Solo esto.
const A_VACIAR = [
  'sessions', 'login_attempts',
  'payments', 'payment_handoffs', 'cash_handoffs', 'cash_withdrawals',
  'cash_movements', 'cash_sessions',
  'com_incidencias', 'com_seguimientos', 'com_visitas', 'com_puntos',
  'com_objetivos', 'com_rankings', 'com_reglas_puntos', 'point_rules',
  'alerts', 'com_comercial_zonas', 'com_perfiles',
  'order_reservations', 'delivery_lines', 'deliveries',
  'delivery_signatures', 'albaran_lines', 'albaran_events', 'albaranes',
  'sales_order_lines', 'sales_orders', 'customers',
  'production_materials', 'productions', 'recipe_lines', 'recipes',
  'lot_etiquetas', 'stock_movements', 'stock_movement_keys', 'lots',
  'items', 'suppliers',
]

// Disparadores que impiden BORRAR, a propósito: esas filas no se tocan en
// operación normal. Para un vaciado hay que apartarlos un momento y devolverlos
// puestos al final, o la base se quedaría sin su red de seguridad.
const APARTAR = [
  //  es la FUNCIÓN que llama este disparador, no otro
  // disparador: aparece en el error del 23001 pero no en el catálogo. Por eso
  // va aquí el del catálogo.
  ['audit_log', 'trg_audit_no_update'],
  ['com_incidencias', 'incidencia_no_se_borra'],
  ['com_seguimientos', 'seguimiento_no_se_borra'],
  ['cash_withdrawals', 'retirada_no_se_toca'],
  ['cash_movements', 'movimiento_no_se_toca'],
]

const cat = (await query(
  "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
)).map((x) => x.table_name)
const real = A_VACIAR.filter((t) => cat.includes(t))
const noExisten = A_VACIAR.filter((t) => !cat.includes(t))

// El orden, de hijos a padres, salido de las claves ajenas y no de mi cabeza.
const fks = (await query(
  "select c.relname hijo, cl.relname padre from pg_constraint con"
  + " join pg_class c on c.oid = con.conrelid"
  + " join pg_class cl on cl.oid = con.confrelid"
  + " where con.contype = 'f'",
)).map((x) => [x.hijo, x.padre])

const orden = []
const puesto = new Set()
// Para vaciar `t` antes, hay que haber vaciado antes todo lo que la APUNTA:
// o sea, sus hijos. `fks` trae pares [hijo, padre], así que los hijos de `t`
// son las filas cuyo segundo elemento es `t`. Ir al revés es lo que salía:
// `customers` intentaba vaciarse antes que `sales_orders`, que la referencia.
const meter = (t, fondo = new Set()) => {
  if (puesto.has(t) || fondo.has(t)) return
  fondo.add(t)
  for (const [hijo, padre] of fks) if (padre === t && real.includes(hijo)) meter(hijo, fondo)
  fondo.delete(t)
  if (!puesto.has(t)) { puesto.add(t); orden.push(t) }
}
for (const t of real) meter(t)

const admin = (await query("select id,username from users where username='admin'"))[0]
if (!admin) {
  console.log('  NO HAY ADMINISTRADOR. Abortando sin tocar nada.')
  process.exit(1)
}

const antes = {}
for (const t of orden) antes[t] = (await query('select count(*)::int n from "' + t + '"'))[0].n

console.log('  admin conservado: #' + admin.id + ' ' + admin.username)
console.log('  ' + orden.length + ' tablas a vaciar, en orden de hijos a padres')
if (noExisten.length) console.log('  no existen: ' + noExisten.join(', '))

const salida = await transaction(async (tx) => {
  for (const [tabla, tg] of APARTAR) {
    if (tabla === 'audit_log' || real.includes(tabla)) {
      await tx.query('alter table "' + tabla + '" disable trigger "' + tg + '"')
    }
  }

  const n = {}
  for (const t of orden) {
    n[t] = (await tx.query('delete from "' + t + '"')).rowsAffected
  }

  // Usuarios: fuera todos menos admin, con sus asignaciones de rol. Los ROLES se
  // quedan, que es lo que permite crear después las cuentas de cada trabajador.
  const rolesFuera = (await tx.query(
    'delete from user_roles where user_id <> $1 returning user_id', [admin.id],
  )).rowsAffected
  const usersFuera = (await tx.query(
    "delete from users where id <> $1 and username <> 'admin' returning id", [admin.id],
  )).rowsAffected

  // La auditoría es rastro de las pruebas. Se vacía el HISTORIAL; la tabla y su
  // disparador de append-only se quedan, así que a partir de ahora lo que se
  // escriba en ella es de verdad.
  const auditoria = (await tx.query('delete from audit_log')).rowsAffected

  // Contadores de serie a cero. Ya no hay ningún registro al que pertenezcan,
  // así que no se renumera nada: no se rellena ningún hueco. El primer lote de
  // la vida vuelve a ser el número uno, que es lo que quiere empezar de cero.
  const series = (await tx.query('delete from config_series_ejercicio')).rowsAffected
  const contadores = (await tx.query('delete from code_counters')).rowsAffected

  // Y la red se vuelve a poner: una base sin sus disparadores de inmutabilidad
  // es una base donde el siguiente que pruebe puede romper lo que la aplicación
  // da por hecho.
  for (const [tabla, tg] of APARTAR) {
    if (tabla === 'audit_log' || real.includes(tabla)) {
      await tx.query('alter table "' + tabla + '" enable trigger "' + tg + '"')
    }
  }

  return { n, usersFuera, rolesFuera, auditoria, series, contadores }
})

console.log('  BARRIDO:')
for (const t of orden) if (antes[t] > 0) console.log('    ' + String(antes[t]).padStart(5) + ' -> 0   ' + t)
console.log('  usuarios fuera: ' + salida.usersFuera + ' · asignaciones de rol fuera: ' + salida.rolesFuera)
console.log('  auditoría vaciada: ' + salida.auditoria + ' filas')
console.log('  contadores de serie a cero: ' + salida.series + ' ejercicio(s) + ' + salida.contadores + ' contador(es)')
await closeDb()
