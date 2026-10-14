/**
 * Hash de contraseñas.
 *
 * argon2id cuando está disponible; bcrypt como alternativa. Lo importante no es
 * el algoritmo sino que:
 *   - nunca se registra ni se compara en claro
 *   - la comparación es de tiempo constante
 *   - el hash lleva su parámetros dentro, para poder subirlos sin rehashear
 */

import crypto from 'node:crypto'
import config from '../config/index.js'

let argon2 = null
try {
  argon2 = (await import('argon2')).default
} catch {
  // bcryptjs es una dependencia de respaldo: funciona sin compilación nativa.
}

export async function hashPassword(contrasena) {
  if (!contrasena || contrasena.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres')
  }
  if (argon2) {
    return argon2.hash(contrasena, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    })
  }
  const bcrypt = (await import('bcryptjs')).default
  return bcrypt.hash(contrasena, config.BCRYPT_COST)
}

export async function verifyPassword(contrasena, hash) {
  if (!contrasena || !hash) return false
  try {
    if (hash.startsWith('$argon2')) return await argon2.verify(hash, contrasena)
    const bcrypt = (await import('bcryptjs')).default
    return await bcrypt.compare(contrasena, hash)
  } catch {
    return false
  }
}

/** Token opaco para QR de cliente y sesiones. No es un JWT. */
export function tokenAleatorio(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Hash de un token para guardarlo en la base. Nunca se guarda el original. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Comparación en tiempo constante, para no filtrar información por tiempos. */
export function igualEnTiempoConstante(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}
