import { readFileSync } from 'node:fs'
import { Client } from 'pg'
const d = JSON.parse(readFileSync('respaldos/respaldo-20261010-002958/datos.json', 'utf8'))
const c = new Client({ connectionString: 'postgresql://sahel@127.0.0.1:55432/destino' })
await c.connect()
let fallos = 0
// Un recorrido REAL por los datos: de cada pedido, a su cliente, sus lineas,
// su repayments y su cliente — como lo haria el programa, no como una cuenta.
const p = await c.query(`select o.id, o.code, o.customer_id, cu.code as cliente
  from sales_orders o left join customers cu on cu.id=o.customer_id
  where o.id in (select id from sales_orders limit 8) order by o.id`)
for (const o of p.rows) {
  const l = await c.query('select count(*)::int n from sales_order_lines where sales_order_id=$1', [o.id])
  const pay = await c.query('select count(*)::int n from payments where sales_order_id=$1', [o.id])
  const ok = o.cliente !== null
  if (!ok) { fallos++; console.log('  FALLA pedido ' + o.code + ' sin cliente') }
  else console.log('  · ' + o.code + ' → ' + o.cliente + ' · ' + l.rows[0].n + ' lineas · ' + pay.rows[0].n + ' cobros')
}
const huerf = await c.query(`select count(*)::int n from sales_order_lines l
  left join sales_orders o on o.id=l.sales_order_id where o.id is null`)
console.log('  · lineas sin pedido: ' + huerf.rows[0].n)
if (huerf.rows[0].n > 0) fallos++
const s = await c.query(`select count(*)::int n from (select distinct rp.role_id from role_permissions rp
  join roles r on r.id=rp.role_id) t`)
console.log('  · roles con permisos: ' + s.rows[0].n + ' de 7')
if (s.rows[0].n !== 7) fallos++
await c.end()
console.log(fallos === 0 ? '  RELACIONES OK' : '  ' + fallos + ' PROBLEMAS DE RELACION')
