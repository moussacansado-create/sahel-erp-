/**
 * Arranque.
 *
 * El orden importa: primero la configuración (que aborta si falta un secreto),
 * luego las migraciones, luego las semillas, y solo después se acepta tráfico.
 * Un servicio que arranca con el esquema sin migrar es un servicio que falla
 * en producción a las tres de la mañana.
 */

import config from './config/index.js'
import { migrar } from './db/migrador.js'
import { sembrar } from './db/semillas.js'
import { limpiarSesionesCaducadas } from './security/tokens.js'
import { createApp } from './app.js'
import { closeDb } from './db/client.js'

async function arrancar() {
  console.log('▸ comprobando el esquema…')
  // El INSTALADOR, no `migrar()` a secas.
  //
  // La migración 035 comprueba que quede al menos un comercial y se niega a
  // seguir si no hay ninguno. Con `migrar()` sobre una base vacía, esa
  // comprobación se ejecuta antes de que exista nadie, y el arranque se queda
  // ahí con «No queda ningun comercial» —que además no explica que el problema
  // es que la base está en blanco—.
  //
  // `instalarBase()` hace las dos pasadas con la semilla en medio, que es
  // exactamente para eso. Y trae la semilla y el usuario inicial de paso, así
  // que este arranque no puede quedar a medias: o la base se monta entera, o
  // no se toca.
  //
  // En una base ya montada, el instalador no hace nada nuevo: comprueba y sigue.
  //
  // El import va AQUÍ, dentro de la función, y no arriba del todo. `instalar.js`
  // y `index.js` comparten `db/client.js`; cargarlo en el grafo de imports lo
  // deja a medio inicializar, y el arranque falla con «schema_migrations does
  // not exist», un error que no dice absolutamente nada del problema real.
  const { instalarBase, realinearSecuencias } = await import('./db/instalar.js')
  await instalarBase({ silencioso: true })
  // Antes de que inserte nadie. Una secuencia desfasada hace que cada alta
  // reviente con un 409 «Ya existe un registro con esos datos» que no dice
  // la verdad: no hay duplicado, el contador simplemente va por detrás.
  try {
    const seqs = await realinearSecuencias()
    console.log(`▸ ${seqs} secuencias realineadas`)
  } catch (e) {
    console.log(`▸ no se pudieron realinear las secuencias: ${e.message}`)
  }

  console.log('▸ verificando datos del sistema…')
  await sembrar()

  // Un usuario inicial: se crea SOLO si no hay ninguno y solo si el entorno
  // proporciona la contraseña. Nunca con una clave inventada.
  await asegurarUsuarioInicial()

  console.log('▸ limpiando sesiones caducadas…')
  const caducadas = await limpiarSesionesCaducadas()
  if (caducadas) console.log(`  ${caducadas} sesión(es) caducada(s) eliminada(s)`)

  const app = createApp()
  const servidor = app.listen(config.PORT, () => {
    console.log('')
    console.log(`  ✓ CleanSahel ERP escuchando en el puerto ${config.PORT}`)
    console.log(`    entorno : ${config.NODE_ENV}`)
    console.log(`    base    : ${config.DATABASE_URL ? 'PostgreSQL de servidor' : 'PostgreSQL local (PGlite)'}`)
    console.log('')
  })

  const apagar = async (senal) => {
    console.log(`\n  Cerrando por ${senal}…`)
    servidor.close(async () => {
      await closeDb()
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => apagar('SIGTERM'))
  process.on('SIGINT', () => apagar('SIGINT'))
}

/**
 * Crea el primer administrador si la tabla está vacía.
 * La contraseña viene del entorno. Si no está, avisa y NO crea nada: es
 * preferible quedarse sin acceso a tener una credencial conocida.
 */
async function asegurarUsuarioInicial() {
  const { query: q, transaction } = await import('./db/client.js')
  const { hashPassword } = await import('./security/passwords.js')
  const { tokenAleatorio } = await import('./security/passwords.js')

  const total = await q('SELECT COUNT(*) c FROM users')
  if (Number(total[0].c) > 0) return

  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  const nombre = process.env.ADMIN_NAME || 'Administrador'

  if (!password) {
    console.warn('')
    console.warn('  ⚠ No hay ningún usuario en la base.')
    console.warn('    Crea el primero con: ADMIN_PASSWORD=... npm run crear-admin')
    console.warn('')
    return
  }

  await transaction(async (tx) => {
    const hash = await hashPassword(password)
    const u = await tx.one(
      `INSERT INTO users (username, email, full_name, password_hash, must_change_password, password_changed_at)
       VALUES ('admin', $1, $2, $3, TRUE, now()) RETURNING id`,
      [email || null, nombre, hash],
    )
    const rol = await tx.one(`SELECT id FROM roles WHERE code = 'ADMIN'`)
    await tx.query('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,NULL)', [u.id, rol.id])
  })
  console.log(`  ✓ Usuario administrador creado (${email || 'sin email'}). Debe cambiar la contraseña al entrar.`)
}

arrancar().catch((e) => {
  console.error('\n  ✗ No se pudo arrancar:')
  console.error(`    ${e.message}`)
  process.exit(1)
})
