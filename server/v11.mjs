import { PGlite } from '@electric-sql/pglite'
const db = await PGlite.create({ dataDir: './server/.pgdata' })
const q = async (s) => (await db.query(s)).rows
const tablas = await q(`SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)
console.log('\n═══ TABLAS (' + tablas.length + ') ═══')
console.log(tablas.map(t => t.table_name).join('  '))
const cols = await q(`SELECT table_name, column_name, data_type
  FROM information_schema.columns WHERE table_schema='public'
    AND table_name IN ('customers','sales_orders','sales_order_lines','order_reservations',
                       'deliveries','delivery_lines','productions','lots','audit_log')
  ORDER BY table_name, ordinal_position`)
console.log('\n═══ COLUMNAS CLAVE ═══')
let cur = ''
for (const c of cols) {
  if (c.table_name !== cur) { cur = c.table_name; console.log('\n▸ ' + cur) }
  console.log('    ' + c.column_name.padEnd(28) + c.data_type)
}
const tipos = await q(`SELECT t.typname, string_agg(e.enumlabel, ' | ' ORDER BY e.enumsortorder) vals
  FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY 1 ORDER BY 1`)
console.log('\n═══ TIPOS ENUM (estados) ═══')
for (const t of tipos) console.log('  ' + t.typname.padEnd(28) + t.vals)
const vistas = await q(`SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1`)
console.log('\n═══ VISTAS (' + vistas.length + ') ═══\n  ' + vistas.map(v=>v.table_name).join('  '))
await db.close()
