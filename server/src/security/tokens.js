/**
 * Emisión y verificación de tokens.
 *
 * Dos tokens, con propósitos distintos:
 *
 *   · access  — corto (15 min). Va en la cabecera Authorization. Si se filtra,
 *               el daño dura poco.
 *   · refresh — largo (7 días). Solo se usa para pedir un access nuevo. En la
 *               base se guarda su HASH, nunca el token, así que leer la tabla
 *               de sesiones no permite suplantar a nadie.
 *
 * El `sid` (id de sesión) viaja dentro del access. Permite revocar el acceso
 * cerrando la sesión, sin esperar a que caduque.
 */

import { getDb } from '../db/client.js'
import jwt from 'jsonwebtoken'
import config from '../config/index.js'

const ALGORITMO = 'HS256'

/**
 * Emite un par de tokens y registra la sesión.
 * @param {object} db   cliente de base de datos
 * @param {object} user fila de users
 * @param {object} [meta] { ipAddress, userAgent }
 */
export async function emitirSesion(db, user, meta = {}) {
  const { randomUUID } = await import('node:crypto')
  const { hashToken } = await import('./passwords.js')

  const sessionId = randomUUID()
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresIn = config.ACCESS_TOKEN_TTL
  const ttlAcceso = enSegundos(expiresIn)
  const ttlSesion = enSegundos(config.REFRESH_TOKEN_TTL)

  const access = jwt.sign(
    { sub: user.id, username: user.username, fullName: user.full_name, sid: sessionId },
    config.JWT_SECRET,
    { algorithm: ALGORITMO, expiresIn, issuer: 'cleansahel', audience: 'cleansahel-api' },
  )

  // El refresh es un valor opaco, no un JWT: se puede revocar de verdad.
  const { tokenAleatorio } = await import('./passwords.js')
  const refresh = tokenAleatorio(48)

  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
    [sessionId, user.id, hashToken(refresh), meta.userAgent || null, meta.ipAddress || null, String(ttlSesion)],
  )

  return { access, refresh, sessionId, expiresIn: issuedAt + ttlAcceso }
}

/** Verifica un token de acceso. Lanza si es inválido o ha caducado. */
export function verificarAcceso(token) {
  return jwt.verify(token, config.JWT_SECRET, {
    algorithms: [ALGORITMO],
    issuer: 'cleansahel',
    audience: 'cleansahel-api',
    clockTolerance: config.ALLOWED_CLOCK_SKEW,
  })
}

/** Renueva el access de una sesión viva. El refresh se consume y se reemite. */
export async function renovarSesion(db, refreshToken, user, meta = {}) {
  const { hashToken } = await import('./passwords.js')
  const hash = hashToken(refreshToken)

  const sesion = await db.one(
    `SELECT * FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [hash],
  )
  if (!sesion) {
    // Un refresh desconocido significa dos cosas: caducó, o alguien intenta
    // reinventar una sesión. En ambos casos no se concede nada nuevo.
    return null
  }
  // Una sesión pertenece a un solo usuario. Si no cuadra, hay manipulación.
  if (sesion.user_id !== user.id) return null

  // El refresh es de un solo uso: se revoca el viejo y se crea otro.
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'RENOVADO' WHERE id = $1`,
    [sesion.id],
  )
  return emitirSesion(db, user, meta)
}

/** Revoca una sesión concreta. */
export async function revocarSesion(db, sessionId, motivo = 'LOGOUT') {
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, motivo],
  )
}

/** Revoca TODAS las sesiones de un usuario. Se usa al cambiar la contraseña. */
export async function revocarTodasLasSesiones(db, userId, motivo = 'PASSWORD_CHANGED') {
  const r = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [userId, motivo],
  )
  return r.length
}

/** Cierra las sesiones caducadas. Lo llama el planificador, no cada petición. */
export async function limpiarSesionesCaducadas(db = null) {
  // Antes esta función exigía que le pasaras la conexión, y el arranque la
  // llamaba sin nada: `Cannot read properties of undefined (reading 'query')`,
  // un error que no dice quién tenía que pasarle qué. Ahora usa la conexión
  // del módulo si no le dan otra, y quien sí se la pase sigue mandando.
  const c = db || await getDb()
  const r = await c.query(
    `DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`,
  )
  return r.length
}

/** Convierte '15m' / '7d' / '900' a segundos. */
function enSegundos(valor) {
  const n = Number(valor)
  if (Number.isFinite(n)) return n
  const m = String(valor).match(/^(\d+)([smhd])$/)
  if (!m) return 900
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]
  return Number(m[1]) * factor
}
