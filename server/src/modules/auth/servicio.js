/**
 * Servicio de autenticación.
 *
 * No hay nada de esto en las rutas: aquí vive la lógica y las rutas solo la
 * llaman. Así la lógica se puede probar sin levantar HTTP.
 */

import { transaction, query, one } from '../../db/client.js'
import config from '../../config/index.js'
import { verifyPassword, hashPassword, hashToken } from '../../security/passwords.js'
import { emitirSesion, renovarSesion, revocarSesion, revocarTodasLasSesiones } from '../../security/tokens.js'

export class ErrorDeAuth extends Error {
  constructor(mensaje, codigo, estado = 401) {
    super(mensaje)
    this.name = 'ErrorDeAuth'
    this.codigo = codigo
    this.estado = estado
  }
}

/**
 * Intenta iniciar sesión.
 *
 * Todos los fallos devuelven el MISMO mensaje a propósito: si distingue
 * "usuario no existe" de "contraseña incorrecta", un atacante puede enumerar
 * qué usuarios hay. El detalle real va al registro de intentos, no al cliente.
 */
export async function iniciarSesion({ username, password, ipAddress, userAgent }) {
  if (!username || !password) {
    throw new ErrorDeAuth('Usuario y contraseña son obligatorios', 'CAMPOS_FALTANTES', 400)
  }

  // ─── Paso 1: comprobar credenciales (solo lectura) ───
  const user = await one(
    `SELECT id, username, full_name, email, password_hash, is_active,
            failed_attempts, locked_until, must_change_password
       -- Se entra con el email o con el usuario. El alta obliga a poner email
       -- en la practica, y obligar a recordar el identificador aparte del email
       -- con el que todos se registran en cualquier otro sitio es una barrera
       -- sin motivo. Un email no puede repetir: hay indice unico debajo.
       FROM users
        WHERE lower(username) = lower($1)
           OR (email IS NOT NULL AND lower(email) = lower($1))`,
    [username],
  )

  if (!user) {
    // Mismo mensaje que una contraseña mala, para no permitir enumerar qué
    // cuentas existen.
    await registrarFallo({ username, ipAddress, userAgent, userId: null, motivo: 'USUARIO_DESCONOCIDO' })
    throw new ErrorDeAuth('Usuario o contraseña incorrectos', 'CREDENCIALES_INVALIDAS')
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutos = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000)
    throw new ErrorDeAuth(`Cuenta bloqueada. Inténtalo de nuevo en ${minutos} minuto(s).`, 'CUENTA_BLOQUEADA', 423)
  }

  if (!user.is_active) {
    await registrarFallo({ username, ipAddress, userAgent, userId: user.id, motivo: 'CUENTA_INACTIVA' })
    throw new ErrorDeAuth('La cuenta está desactivada. Contacta con un administrador.', 'CUENTA_INACTIVA', 403)
  }

  const correcta = await verifyPassword(password, user.password_hash)

  // ─── Paso 2: fallo, registrado FUERA de la transacción que se deshace ───
  //
  // No es obvio: si el contador se incrementara dentro de una transacción que
  // después lanza, el propio error lo revertiría y el bloqueo por fuerza bruta
  // no ocurriría nunca. Parece funcionar y no protege de nada.
  if (!correcta) {
    const { bloquear } = await registrarFallo({
      username, ipAddress, userAgent, userId: user.id, motivo: 'CONTRASENA_INCORRECTA',
    })
    if (bloquear) {
      throw new ErrorDeAuth(
        `Demasiados intentos fallidos. Cuenta bloqueada ${config.LOCK_MINUTES} minutos.`,
        'CUENTA_BLOQUEADA', 423,
      )
    }
    throw new ErrorDeAuth('Usuario o contraseña incorrectos', 'CREDENCIALES_INVALIDAS')
  }

  // ─── Paso 3: acceso correcto ───
  return transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    )
    await registrarIntento(tx, { username, ipAddress, userAgent, userId: user.id, successful: true, reason: null })
    await auditar(tx, {
      userId: user.id, userName: user.username, accion: 'LOGIN',
      entidad: 'users', entidadId: user.id, outcome: 'SUCCESS', ip: ipAddress, userAgent,
    })
    const tokens = await emitirSesion(tx, user, { ipAddress, userAgent })
    return {
      ...tokens,
      // Permite al cliente ofrecer "cerrar este dispositivo" sin cerrar todas.
      sesion: { id: tokens.sessionId },
      usuario: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        email: user.email,
        mustChangePassword: user.must_change_password,
      },
    }
  })
}

/**
 * Registra un intento fallido y actualiza el contador, en su PROPIA
 * transacción, para que sobreviva al error que va a lanzar quien la llama.
 */
async function registrarFallo({ username, ipAddress, userAgent, userId, motivo }) {
  return transaction(async (tx) => {
    if (userId) {
      const fila = await tx.one('SELECT failed_attempts FROM users WHERE id = $1 FOR UPDATE', [userId])
      const intentos = Number(fila?.failed_attempts ?? 0) + 1
      const bloquear = intentos >= Number(config.MAX_FAILED_ATTEMPTS)
      await tx.query(
        'UPDATE users SET failed_attempts = $2, locked_until = $3 WHERE id = $1',
        [userId, intentos, bloquear ? new Date(Date.now() + Number(config.LOCK_MINUTES) * 60000) : null],
      )
      await registrarIntento(tx, { username, ipAddress, userAgent, userId, successful: false, reason: motivo })
      return { intentos, bloquear }
    }
    await registrarIntento(tx, { username, ipAddress, userAgent, userId: null, successful: false, reason: motivo })
    return { intentos: 0, bloquear: false }
  })
}

/** Renueva el token de acceso con el de refresco. */
export async function renovar({ refreshToken, ipAddress, userAgent }) {
  if (!refreshToken) {
    throw new ErrorDeAuth('Falta el token de refresco', 'REFRESH_AUSENTE', 400)
  }
  return transaction(async (tx) => {
    const hash = hashToken(refreshToken)
    const sesion = await tx.one(
      `SELECT s.user_id FROM sessions s
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hash],
    )
    if (!sesion) {
      throw new ErrorDeAuth('Sesión no válida o caducada', 'REFRESH_INVALIDO')
    }
    const user = await tx.one(
      `SELECT id, username, full_name, email, must_change_password
         FROM users WHERE id = $1 AND is_active`,
      [sesion.user_id],
    )
    if (!user) {
      // El usuario se desactivó o borró: la sesión cae con él.
      throw new ErrorDeAuth('Sesión no válida', 'REFRESH_INVALIDO')
    }
    const nuevo = await renovarSesion(tx, refreshToken, user, { ipAddress, userAgent })
    if (!nuevo) throw new ErrorDeAuth('Sesión no válida o caducada', 'REFRESH_INVALIDO')
    return nuevo
  })
}

/** Cierra la sesión actual. */
export async function cerrarSesion({ userId, sessionId, ipAddress, userAgent }) {
  return transaction(async (tx) => {
    if (sessionId) await revocarSesion(tx, sessionId, 'LOGOUT')
    else await revocarTodasLasSesiones(tx, userId, 'LOGOUT')
    await auditar(tx, {
      userId, userName: null, accion: 'LOGOUT', entidad: 'sessions',
      entidadId: sessionId || userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
    })
    return { ok: true }
  })
}

/**
 * Cambia la contraseña del propio usuario.
 * Revoca TODAS las sesiones: si el cambio viene de un robo de credenciales,
 * el atacante pierde el acceso también.
 */
export async function cambiarPassword({ userId, actual, nueva, sessionId, ipAddress, userAgent }) {
  return transaction(async (tx) => {
    const user = await tx.one('SELECT id, username, password_hash, full_name FROM users WHERE id = $1', [userId])
    if (!user) throw new ErrorDeAuth('Usuario no encontrado', 'NO_ENCONTRADO', 404)

    if (!(await verifyPassword(actual, user.password_hash))) {
      await auditar(tx, {
        userId, userName: user.username, accion: 'PASSWORD_CHANGE', entidad: 'users',
        entidadId: userId, outcome: 'DENIED', ip: ipAddress, userAgent,
      })
      throw new ErrorDeAuth('La contraseña actual no es correcta', 'CONTRASENA_ACTUAL_INVALIDA')
    }
    validarNueva(nueva, actual)

    const hash = await hashPassword(nueva)
    await tx.query(
      `UPDATE users SET password_hash = $2, password_changed_at = now(),
              must_change_password = FALSE WHERE id = $1`,
      [userId, hash],
    )
    const revocadas = await revocarTodasLasSesiones(tx, userId, 'PASSWORD_CHANGED')
    // Se reabre la sesión desde la que se ha hecho el cambio, para que el
    // usuario no se quede fuera de su propia cuenta.
    if (sessionId) {
      const tokens = await emitirSesion(tx, user, { ipAddress, userAgent })
      await auditar(tx, {
        userId, userName: user.username, accion: 'PASSWORD_CHANGE', entidad: 'users',
        entidadId: userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
      })
      return { ok: true, sesionesRevocadas: revocadas, ...tokens }
    }
    await auditar(tx, {
      userId, userName: user.username, accion: 'PASSWORD_CHANGE', entidad: 'users',
      entidadId: userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
    })
    return { ok: true, sesionesRevocadas: revocadas }
  })
}

/** Crea un usuario. Solo lo llama un administrador. */
/**
 * Crea un usuario con la contrasena que elige quien lo crea.
 *
 * `must_change_password` va en FALSE a proposito: antes se ponia en TRUE y se
 * obligaba a cambiar la contrasena en el primer acceso, lo que convertia cada
 * alta en un trabajo extra para el usuario nuevo. Si es el administrador quien
 * la establece, ese cambio ya no hace falta: nadie tendra que inventarse otra.
 */
export async function crearUsuario({ username, email, fullName, password, roles, locale = 'es', actorId, ipAddress, userAgent }) {
  validarNueva(password, null, username)
  return transaction(async (tx) => {
    const existe = await tx.one('SELECT id FROM users WHERE lower(username) = lower($1)', [username])
    if (existe) throw new ErrorDeAuth(`El usuario "${username}" ya existe`, 'USUARIO_DUPLICADO', 409)

    const hash = await hashPassword(password)
    const u = await tx.one(
      `INSERT INTO users (username, email, full_name, password_hash, locale,
                           must_change_password, password_changed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,FALSE, now(), $6)
       RETURNING id, username, email, full_name, locale, is_active, must_change_password, created_at`,
      [username, email || null, fullName, hash, locale, actorId],
    )
    await asignarRoles(tx, u.id, roles || [], actorId)
    await auditar(tx, {
      userId: actorId, userName: null, accion: 'CREATE', entidad: 'users',
      entidadId: u.id, outcome: 'SUCCESS', ip: ipAddress, userAgent,
      despues: { username: u.username, roles },
    })
    return u
  })
}

/** Sustituye los roles de un usuario. */
export async function cambiarRoles({ userId, roles, actorId, actorName, ipAddress, userAgent }) {
  return transaction(async (tx) => {
    const antes = await tx.query('SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [userId])
    await tx.query('DELETE FROM user_roles WHERE user_id = $1', [userId])
    await asignarRoles(tx, userId, roles, actorId)
    await auditar(tx, {
      userId: actorId, userName: actorName, accion: 'CHANGE_ROLES', entidad: 'users',
      entidadId: userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
      antes: { roles: antes.map((a) => a.code) }, despues: { roles },
    })
    return { ok: true, roles }
  })
}

/** Activa o desactiva un usuario. Desactivar no borra nada. */
export async function cambiarEstado({ userId, activo, actorId, actorName, ipAddress, userAgent }) {
  return transaction(async (tx) => {
    const u = await tx.one('SELECT id, username, is_active FROM users WHERE id = $1', [userId])
    if (!u) throw new ErrorDeAuth('Usuario no encontrado', 'NO_ENCONTRADO', 404)
    if (u.id === actorId && !activo) {
      throw new ErrorDeAuth('No puedes desactivar tu propia cuenta', 'AUTODESACTIVACION', 400)
    }
    await tx.query('UPDATE users SET is_active = $2 WHERE id = $1', [userId, activo])
    if (!activo) await revocarTodasLasSesiones(tx, userId, 'USER_DISABLED')
    await auditar(tx, {
      userId: actorId, userName: actorName, accion: activo ? 'ACTIVATE' : 'DEACTIVATE',
      entidad: 'users', entidadId: userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
      antes: { is_active: u.is_active }, despues: { is_active: activo },
    })
    return { ok: true, is_active: activo }
  })
}

/** Desbloquea a un usuario y le pone el contador a cero. */
export async function desbloquear({ userId, actorId, actorName, ipAddress, userAgent }) {
  await transaction(async (tx) => {
    await tx.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId])
    await auditar(tx, {
      userId: actorId, userName: actorName, accion: 'UNLOCK', entidad: 'users',
      entidadId: userId, outcome: 'SUCCESS', ip: ipAddress, userAgent,
    })
  })
  return { ok: true }
}

// ─── Auxiliares ─────────────────────────────────────────────────────────────

async function asignarRoles(tx, userId, roles, actorId) {
  for (const codigo of roles) {
    const r = await tx.one('SELECT id FROM roles WHERE code = $1', [codigo])
    if (!r) throw new ErrorDeAuth(`Rol desconocido: ${codigo}`, 'ROL_DESCONOCIDO', 400)
    await tx.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, r.id, actorId],
    )
  }
}

function validarNueva(password, actual, username = null) {
  const problemas = []
  if (!password || password.length < 8) problemas.push('debe tener al menos 8 caracteres')
  if (password && !/[A-Za-z]/.test(password)) problemas.push('debe incluir al menos una letra')
  if (password && !/[0-9]/.test(password)) problemas.push('debe incluir al menos un número')
  if (password && password.toLowerCase().includes(String(username || '').toLowerCase()) && username) {
    problemas.push('no puede contener el nombre de usuario')
  }
  if (actual && password === actual) problemas.push('debe ser distinta de la actual')
  if (problemas.length) {
    throw new ErrorDeAuth(`La contraseña ${problemas.join(', ')}`, 'CONTRASENA_DEBIL', 400)
  }
}

async function registrarIntento(tx, { username, ipAddress, userAgent, userId, successful, reason }) {
  await tx.query(
    `INSERT INTO login_attempts (username, user_id, successful, ip_address, user_agent, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [username, userId || null, successful, ipAddress || null, userAgent || null, reason],
  )
}

async function auditar(tx, { userId, userName, accion, entidad, entidadId, outcome, ip, userAgent, antes, despues }) {
  await tx.query(
    `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id,
                            before_data, after_data, outcome, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [userId, userName, accion, entidad, String(entidadId ?? ''),
     antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null,
     outcome, ip || null, userAgent || null],
  )
}
