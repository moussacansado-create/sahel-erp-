/**
 * Datos minimos para las pruebas.
 *
 * NO es `seed-demo.mjs`: aquel script es destructivo (tira la base y la
 * vuelve a montar) y lleva un `RECREAR_DEMO=1` que lo frena. Un test no
 * puede llamar a eso.
 *
 * Aqui solo se CREA lo que la prueba necesita, sobre una base desechable.
 * Todo es idempotente: correrlo dos veces no duplica nada.
 *
 * Los tests antes apuntaban al servidor de la demo (puerto 10000) y dejaban
 * rastro en ella. Por eso la demo tenia clientes de prueba. Ahora cada test
 * levanta su propio servidor sobre su propia base.
 *
 * Aqui no hay precios bonitos ni historico de ventas. Hay lo justo para que
 * una lista no salga vacia. Las cifras de verdad las pone `instalarBase()`.
 */

import { query, one } from '../src/db/client.js'

/** La clave con la que entran los tests. Solo existe en la base de pruebas. */
export const CLAVE_DEMO = 'demo1234'

/**
 * Un usuario con su rol y la clave de las pruebas.
 *
 * Si ya existe no se toca, ni la contrasena: una prueba que haya cambiado
 * algo no debe encontrarse con otra cuenta al segundo uso.
 */
export async function usuarioDemo(username, rol, nombre = null) {
  const { hashPassword } = await import('../src/security/passwords.js')
  const ya = await one('SELECT id, username FROM users WHERE username = $1', [username])
  if (ya) {
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = $2 ON CONFLICT DO NOTHING`,
      [ya.id, rol],
    )
    return ya
  }
  const hash = await hashPassword(CLAVE_DEMO)
  const u = await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at, is_active)
     VALUES ($1,$2,$3, now(), TRUE) RETURNING id, username`,
    [username, nombre || username, hash],
  )
  const r = await one('SELECT id FROM roles WHERE code = $1', [rol])
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [u.id, r.id])
  return u
}

/** Un cliente con su codigo. Si ya existe, lo devuelve tal cual. */
export async function clienteDemo(nombre = 'Cliente de Prueba') {
  const ya = await one('SELECT id, code, name FROM customers WHERE name = $1', [nombre])
  if (ya) return ya
  const codigo = `PRUEBA-${nombre.replace(/\W/g, '').toUpperCase().slice(0, 10)}`
  return one(
    `INSERT INTO customers (code, name, is_active) VALUES ($1,$2,TRUE)
     RETURNING id, code, name`,
    [codigo, nombre],
  )
}

/**
 * Un articulo del tipo pedido. El precio es 1 a proposito: es relleno, no un
 * dato de negocio. Lo que la prueba necesita es que el articulo exista.
 */
export async function articuloDemo({ sku, name, kind = 'RAW_MATERIAL', cost = 1 }) {
  const ya = await one('SELECT id, sku, name FROM items WHERE sku = $1', [sku])
  if (ya) return ya
  const unidad = await one(`SELECT id FROM units WHERE code = 'L' LIMIT 1`)
  return one(
    `INSERT INTO items (sku, name, kind, base_unit_id, purchase_unit_id, standard_cost, is_active)
     VALUES ($1,$2,$3,$4,$4,$5,TRUE) RETURNING id, sku, name`,
    [sku, name, kind, unidad ? unidad.id : null, cost],
  )
}

/** Un comercial de prueba, con su usuario. */
export async function comercialDemo(nombre = 'comercial') {
  const u = await usuarioDemo(nombre, 'COMMERCIAL', nombre)
  const ya = await one('SELECT id FROM com_perfiles WHERE user_id = $1', [u.id])
  if (ya) return { usuario: u, perfil: ya }
  const zona = await one(`SELECT id FROM com_zonas WHERE nivel = 'REGION' ORDER BY id LIMIT 1`)
  const p = await one(
    `INSERT INTO com_perfiles (user_id, home_zona_id, hired_on, is_active)
     VALUES ($1,$2,CURRENT_DATE,TRUE) RETURNING id, user_id`,
    [u.id, zona ? zona.id : null],
  )
  return { usuario: u, perfil: p }
}

/** Un usuario por rol, como minimo. */
export async function genteDemo() {
  return {
    admin: await usuarioDemo('admin', 'ADMIN', 'Administrador'),
    reparto: await usuarioDemo('reparto', 'DELIVERY', 'Repartidor'),
    produccion: await usuarioDemo('produccion', 'PRODUCTION', 'Produccion'),
    comercial: await comercialDemo('comercial'),
  }
}
