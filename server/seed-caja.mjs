/**
 * DATOS DE CAJA PARA LA DEMO
 *
 * La demo de la Fase 1 se quedaba en «no hay repartidores con nada que
 * entregar», que es la mejor forma de dejar una pantalla nueva sin probarla:
 * se abre, se ve vacía, y no se sabe si funciona o si no hay nada dentro.
 *
 * Aquí se dejan tres repartidores en las tres situaciones que importan:
 *
 *   · uno con cobros pendientes de entregar, y un traspaso YA CONCILIADO para
 *     que se vea el historial;
 *   · uno con cobros pero con uno sin verificar, que es la alerta real;
 *   · uno con un traspaso con DESCUADRE, que es lo que hay que revisar.
 *
 * Los importes son pequeños y redondos a propósito: si hay que mirar una
 * cifra, tiene que poder mirarse de un vistazo.
 *
 * Se ejecuta CON EL SERVIDOR PARADO, y no mientras está en marcha: PGlite no
 * admite dos procesos sobre el mismo directorio.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = process.env.JWT_SECRET || 'clave-de-demostracion-caja-1234567890'

const { query, one, closeDb } = await import('./src/db/client.js')
const { hashPassword } = await import('./src/security/passwords.js')

// El hash es el DEL PROYECTO, no `crypt()`.
//
// PGlite es PostgreSQL en WebAssembly y no trae pgcrypto: `gen_salt` no existe
// ahí y falla con un error de «function does not exist» que no dice nada de
// contraseñas. Aquí se usa `hashPassword()`, que es lo mismo que usa la
// aplicación, y por eso 'demo1234' sirve para entrar.
const HASH = await hashPassword('demo1234')

const adm = (await one(
  `SELECT id FROM users WHERE username = 'admin'`)).id
const reparto = (await one(
  `SELECT id FROM users WHERE username = 'reparto'`)).id

// El rol de caja es un usuario NUEVO: la caja es una persona, y si la demo
// usara el admin no se vería lo que significa que el receptor tenga nombre.
await query(
  `INSERT INTO users (username, full_name, password_hash, is_active)
   VALUES ('caja', 'Caja — Aïcha Traoré', $1, true)
   ON CONFLICT (username) DO NOTHING`, [HASH])
const caja = (await one(`SELECT id FROM users WHERE username = 'caja'`)).id
await query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT $1, id FROM roles WHERE code = 'CAJAJERO' ON CONFLICT DO NOTHING`, [caja])

//
// CLIENTES.
//
// `seed-demo.mjs` no crea clientes —su trabajo es usuarios, recetas y stock—,
// así que aquí se crean los mínimos. Sin ellos no hay ni un pedido, y sin un
// pedido no hay ni un cobro: una caja con la pantalla vacía.
//
const NOMBRES = [
  ['Boutique Diallo', 'Dakar Plateau'],
  ['Supermarché Keita', 'Dakar Almadies'],
  ['Épicerie Bamba', 'Thiès'],
  ['Hôtel Le Baobab', 'Saly'],
]
//
// Con `crearCliente()`, no con un INSERT.
//
// El `qr_token` se genera DENTRO de esa función, con 192 bits de entropía, y la
// columna es NOT NULL. Ni `gen_random_bytes` —PGlite no lo trae— ni un INSERT a
// mano: el token es lo que autoriza a ver los pedidos de un cliente desde la
// puerta de su casa, y no es un campo más.
//
const { crearCliente } = await import('./src/core/clientes.js')
for (const [nombre, direccion] of NOMBRES) {
  await crearCliente({
    name: nombre, companyName: nombre, address: direccion, phone: '+221 77 000 00 00',
  }, reparto)
}
const clientes = await query(`SELECT id, code, name FROM customers ORDER BY id LIMIT 6`)
if (clientes.length < 4) {
  console.log('  ⚠  No hay clientes suficientes en la demo. Lanza antes seed-demo.mjs.')
  await closeDb()
  process.exit(0)
}

//
// IDEMPOTENTE, Y POR CÓDIGO.
//
// La primera versión numeraldaba los pedidos con un contador en memoria, así
// que una segunda ejecución —y hubo varias, porque el script fallaba por cosas
// que no eran suyas— se comía `sales_orders_code_key` a mitad. Un seed que solo
// funciona la primera vez es un seed que se ejecuta una vez.
//
// Ahora se limpia lo suyo antes de empezar y los códigos llevan un sufijo fijo
// de demo. Volver a lanzarlo deja la base igual, no la llena de PED-C001…099.
//
//
// Se borra TODO lo monetario, no solo lo de este script.
//
// Con la limpieza limitada a `PED-CJAJA-%` se quedaban los pedidos de las
// ejecuciones anteriores, y el repartidor «llevaba» cobros de hace media hora
// además de los suyos. Lo de este seed es reproducible; lo de antes, no.
//
// No se tocan los datos de `seed-demo.mjs` —usuarios, recetas, stock, y nada
// de eso se borra—, sino los PEDIDOS, que no los crea el seed principal.
//
await query(`DELETE FROM payment_handoffs`)
await query(`DELETE FROM cash_handoffs`)
await query(`DELETE FROM deliveries`)
await query(`DELETE FROM payments`)
await query(`DELETE FROM order_reservations`)
await query(`DELETE FROM sales_order_lines`)
await query(`DELETE FROM sales_orders`)
await query(`UPDATE customers SET is_active = true`)

let n = 0
/** Un pedido de `euros` cobrado por `quien`, pendiente de entregar. */
async function cobro(quien, euros) {
  n += 1
  const cli = clientes[n % clientes.length]
  const o = (await one(
    `INSERT INTO sales_orders
       (code, customer_id, status, order_date, currency_code,
        subtotal, tax_rate, tax_amount, total, created_by)
     VALUES ($1,$2,'PREPARED',CURRENT_DATE,'XOF',$3,0.21,$4,$5,$6) RETURNING id`,
    [`PED-CJAJA-${String(n).padStart(3, '0')}`, cli.id, euros, euros * 0.21,
      euros * 1.21, reparto])).id
  await query(
    `INSERT INTO sales_order_lines
       (sales_order_id, item_id, qty, unit_id, unit_price, tax_rate, line_total)
     SELECT $1, i.id, 10, i.unit_id, $2, 0.21, $3
       FROM items i WHERE i.category_kind = 'FINISHED_GOOD' LIMIT 1`, [o, euros, euros * 10])
  await query(
    `INSERT INTO payments
       (sales_order_id, customer_id, collected_by, method, amount,
        currency_code, reference, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,'XOF',$6,$3, now() - ($7 || ' hours')::interval)`,
    [o, cli.id, quien,
      euros >= 100000 ? 'ORANGE_MONEY' : 'CASH',
      euros,
      euros >= 100000 ? `OM-DEMO-${n}` : null,
      String(n * 3)])
  return o
}

// ── 1 · Repartidor con dinero encima, y un traspaso YA CONCILIADO ──────────
const { abrirTraspaso, recibirDinero } = await import('./src/core/caja.js')

// Primero el reparto que YA se entregó, con las funciones de verdad.
//
// La primera versión de esta demo escribía el traspaso con un INSERT y un
// `expected_amount` de 15000 a mano. El guard de la migración 024 lo rechazó:
// decía que ese repartidor llevaba 154 000 y el traspaso respaldaba 15 000.
//
// Y tenía razón. Y esa es la mejor noticia posible de un guard: la demo que
// inventaba números es justo lo que un guard hecho para eso tiene que parar.
//
// Los datos de demostración se crean con `abrirTraspaso()` y `recibirDinero()`,
// que es lo mismo que hace la aplicación. Si el guard mañana cambia, la demo
// cambia con él, y deja de poder estar «bien puesta» y «desincronizada».
const rama = (await one(`SELECT id FROM users WHERE username = 'reparto'`)).id
const otro = (await one(
  `INSERT INTO users (username, full_name, password_hash, is_active)
   VALUES ('reparto2', 'Moussa Diakité', $1, true)
   ON CONFLICT (username) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
  [HASH])).id
await query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT $1, id FROM roles WHERE code = 'DELIVERY' ON CONFLICT DO NOTHING`, [otro])

await cobro(rama, 45000)
const viejo = await abrirTraspaso({
  handedBy: rama, receivedBy: caja, usuarioId: caja,
  nota: 'Entregado al final del recorrido',
})
await recibirDinero({ traspasoId: viejo.id, recibido: 45000, usuarioId: caja })

// Y ahora lo que queda encima, que es lo que la caja ve al entrar.
await cobro(rama, 32000)
const entrega = await abrirTraspaso({
  handedBy: rama, receivedBy: adm, usuarioId: adm, nota: 'Parte del pedido del mediodía',
})
//
// La caja cuenta 30 000 de 32 000: sobran 2 000.
//
// Y la nota dice 2 000, que es lo que de verdad falta. La primera versión
// ponía «sobran 200» con un traspaso de 32 000, y se veía al abrir la pantalla:
// un descuadre de 2 000 con una explicación que habla de 200. Es el mismo
// defecto del punto 2, en la letra pequeña: la cifra que hay que mirar y la
// cifra que la acompaña tienen que ser la misma, o la nota no sirve para nada.
//
await recibirDinero({
  traspasoId: entrega.id, recibido: 30000, usuarioId: adm,
  nota: 'Sobran 2 000: se le cayeron dos billetes de 1 000 al contarlos en la puerta.',
})

// Lo que le queda encima, DESPUÉS de haber entregado dos veces. Si no se
// añade nada más, `reparto` llega a la pantalla con la cuenta a cero, y una
// caja con un solo repartidor no enseña cómo se ve una fila con dinero.
await cobro(rama, 18500)
const lleva = (await one(`SELECT fn_por_entregar($1,'XOF') AS n`, [rama])).n

// ── 2 · Repartidor con un cobro SIN VERIFICAR ─────────────────────────────
await cobro(otro, 78000)
await cobro(otro, 24000)
await query(
  `UPDATE payments SET reference = 'OM-DEMO-SIN-VERIFICAR'
    WHERE id = (SELECT id FROM payments
                 WHERE collected_by = $1 AND status = 'PENDING' ORDER BY id LIMIT 1)`, [otro])

// ── 3 · Un traspaso CON DESCUADRE del segundo repartidor ──────────────────
const descuadre = await abrirTraspaso({
  handedBy: otro, receivedBy: caja, usuarioId: caja,
  nota: 'Parte del recorrido de la tarde',
})
await recibirDinero({
  traspasoId: descuadre.id, recibido: 78000, usuarioId: caja,
  nota: 'Faltan 5 500: el cliente dijo que había pagado por Orange Money '
    + 'y el comprobante no llegó. Se revisa con él antes de entregar.',
})
await cobro(otro, 24000)

console.log('  Datos de caja listos:')
console.log(`    · 'caja' (Aïcha Traoré) y 'reparto2' (Moussa Diakité), contraseña demo1234`)
console.log(`    · reparto lleva ${lleva} FCFA pendientes y un descuadre de 2 000 anotado`)
console.log(`    · reparto2 tiene un cobro por verificar y 102 000 FCFA sin entregar`)
await closeDb()
