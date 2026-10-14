import { Client } from 'pg'
const c = new Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const m = await c.query("select p.module||':'||p.action k from role_permissions rp join permissions p on p.id=rp.permission_id join roles r on r.id=rp.role_id where r.code='PRODUCTION' and p.module in ('inventory','lots','purchases','suppliers','orders','production','recipes') order by 1")
process.stdout.write('MODS ' + JSON.stringify(m.rows.map(x=>x.k)) + '\n')
await c.end()
