// Recorrido REAL por los datos migrados: de cada pedido a su cliente, sus
// lineas y sus cobros. Contar filas dice cuántas hay; esto dice si entre ellas
// hay sentido.
import { Client } from 'pg'
const c = new Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
let fallos = 0
const p = await c.query(`select o.id, o.code, cu.code as cliente
  from sales_orders o left join customers cu on cu.id=o.customer_id
  order by o.id limit 6`)
for (const o of p.rows) {
  const l = await c.query('select count(*)::int n from sales_order_lines where sales_order_id=$1', [o.id])
  const pay = await c.query('select count(*)::int n from payments where sales_order_id=$1', [o.id])
  if (!o.cliente) { fallos++; console.log('  FALLA ' + o.code + ' sin cliente') }
  else console.log('  · ' + o.code + ' → ' + o.cliente + ' · ' + l.rows[0].n + ' lineas · ' + pay.rows[0].n + ' cobros')
}
const h1 = await c.query('select count(*)::int n from sales_order_lines l left join sales_orders o on o.id=l.sales_order_id where o.id is null')
const h2 = await c.query('select count(*)::int n from payments p left join customers c on c.id=p.customer_id where p.customer_id is not null and c.id is null')
const h3 = await c.query('select count(*)::int n from lots l left join items i on i.id=l.item_id where i.id is null')
console.log('  · lineas huerfanas: ' + h1.rows[0].n + ' · cobros huerfanos: ' + h2.rows[0].n + ' · lotes huerfanos: ' + h3.rows[0].n)
fallos += h1.rows[0].n + h2.rows[0].n + h3.rows[0].n
const rp = await c.query('select count(distinct role_id)::int n from role_permissions')
console.log('  · roles con permisos: ' + rp.rows[0].n + ' de 7')
if (rp.rows[0].n !== 7) fallos++
await c.end()
console.log(fallos === 0 ? '  RELACIONES OK' : '  ' + fallos + ' PROBLEMAS')
process.exit(fallos ? 1 : 0)
