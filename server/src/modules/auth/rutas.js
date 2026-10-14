/**
 * Rutas de autenticación.
 *
 * Tres operaciones, y solo tres. No hay ninguna más que devuelva una sesión:
 * ni por código, ni por enlace, ni por un parámetro en la URL. Esa fue
 * exactamente la puerta trasera de la aplicación anterior.
 */

import { Router } from 'express'
import { asincrono, limiteDeAcceso, limiteDeRefresco } from '../../http/middlewares.js'
import { requiereSesion } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import { iniciarSesion, renovar, cerrarSesion, cambiarPassword, ErrorDeAuth } from './servicio.js'

const router = Router()
const auth = requiereSesion({ query, one })

/** POST /api/auth/login */
router.post('/auth/login', limiteDeAcceso(), asincrono(async (req, res) => {
  const { username, password } = req.body || {}
  const r = await iniciarSesion({
    username, password,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** POST /api/auth/refresh */
// El límite de acceso NO va aquí.
//
// `limiteDeAcceso` está pensado para frenar a alguien probando contraseñas:
// 10 intentos cada 15 minutos por IP y usuario. En una sesión normal ese
// límite no protege de nada, y en el refresco rompe la aplicación a diario:
// la renovación se llama sola en CADA carga de página, así que un trabajador
// que recarga el navegador diez veces en media hora se encuentra con un 429 y
// vuelve a la pantalla de acceso.
//
// Y lo que es peor: al fallar, el navegador Borra el token de refresco, así
// que el 429 no solo expulsa, que además obliga a volver a escribir la
// contraseña. Un fallo pasajero de la red se convertía en perder la sesión.
//
// El token de refresco es una cadena opaca y aleatoria: probar uno es tan
// inútil como adivinarlo, y por debajo tiene su propia caducidad y su propia
// revocación. Este endpoint lleva su propio margen, mucho más alto, para que
// un fallo temporal no eche a nadie.
router.post('/auth/refresh', limiteDeRefresco(), asincrono(async (req, res) => {
  const { refreshToken } = req.body || {}
  const r = await renovar({
    refreshToken,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** POST /api/auth/logout */
router.post('/auth/logout', auth, asincrono(async (req, res) => {
  await cerrarSesion({
    userId: req.user.id,
    sessionId: req.user.sessionId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json({ ok: true })
}))

/** GET /api/auth/me — quién soy y qué puedo hacer */
router.get('/auth/me', auth, asincrono(async (req, res) => {
  const u = await one(
    `SELECT id, username, email, full_name, locale, must_change_password, last_login_at
       FROM users WHERE id = $1`,
    [req.user.id],
  )
  if (!u) return res.status(401).json({ error: 'Usuario no encontrado', codigo: 'NO_AUTENTICADO' })
  res.json({
    usuario: {
      id: u.id,
      username: u.username,
      email: u.email,
      fullName: u.full_name,
      locale: u.locale,
      mustChangePassword: u.must_change_password,
      lastLoginAt: u.last_login_at,
    },
    roles: req.roles,
    permisos: req.permisos,
    sesion: { id: req.user.sessionId },
  })
}))

/** POST /api/auth/cambiar-contrasena */
router.post('/auth/cambiar-contrasena', auth, asincrono(async (req, res) => {
  const { actual, nueva } = req.body || {}
  const r = await cambiarPassword({
    userId: req.user.id,
    actual, nueva,
    sessionId: req.user.sessionId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** POST /api/auth/sesiones — revocar TODAS las sesiones propias */
router.post('/auth/sesiones/revocar-todas', auth, asincrono(async (req, res) => {
  const { revocarTodasLasSesiones } = await import('../../security/tokens.js')
  const { transaction } = await import('../../db/client.js')
  const n = await transaction((tx) => revocarTodasLasSesiones(tx, req.user.id, 'USER_REVOKED_ALL'))
  res.json({ ok: true, revocadas: n })
}))

export default router
