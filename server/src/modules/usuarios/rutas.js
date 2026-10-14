/**
 * Rutas de usuarios y roles. Solo para ADMIN.
 *
 * Cada ruta lleva `requierePermiso`, así que aunque alguien llegue aquí con un
 * token de repartidor, el backend le responde 403. Ocultar el menú no es la
 * garantía; esto sí.
 */

import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import { crearUsuario, cambiarRoles, cambiarEstado, desbloquear, ErrorDeAuth } from '../auth/servicio.js'

const router = Router()
const auth = requiereSesion({ query, one })
const adminUsuarios = (accion) => requierePermiso('users', accion)

/** GET /api/users — lista con sus roles, sin hashes de contraseña. */
router.get('/users', auth, adminUsuarios('view'), asincrono(async (req, res) => {
  const filas = await query(
    `SELECT u.id, u.username, u.email, u.full_name, u.locale, u.is_active,
            u.must_change_password, u.failed_attempts, u.locked_until,
            u.last_login_at, u.created_at,
            COALESCE(json_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE ($1::boolean IS NULL OR u.is_active = $1)
      GROUP BY u.id
      ORDER BY u.full_name`,
    [req.query.activos === 'true' ? true : req.query.activos === 'false' ? false : null],
  )
  res.json(filas)
}))

/** GET /api/users/:id */
router.get('/users/:id', auth, adminUsuarios('view'), asincrono(async (req, res) => {
  const u = await one(
    `SELECT u.id, u.username, u.email, u.full_name, u.locale, u.is_active,
            u.must_change_password, u.failed_attempts, u.locked_until,
            u.last_login_at, u.password_changed_at, u.created_at,
            COALESCE(json_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1
      GROUP BY u.id`,
    [req.params.id],
  )
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(u)
}))

/** POST /api/users */
router.post('/users', auth, adminUsuarios('create'), asincrono(async (req, res) => {
  const b = req.body || {}
  const u = await crearUsuario({
    username: b.username,
    email: b.email,
    fullName: b.fullName,
    password: b.password,
    roles: b.roles || [],
    locale: b.locale || 'es',
    actorId: req.user.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.status(201).json(u)
}))

/** PUT /api/users/:id/roles */
router.put('/users/:id/roles', auth, adminUsuarios('edit'), asincrono(async (req, res) => {
  const { roles } = req.body || {}
  if (!Array.isArray(roles)) {
    return res.status(400).json({ error: 'Se esperaba una lista de roles', codigo: 'FORMATO_INVALIDO' })
  }
  const r = await cambiarRoles({
    userId: req.params.id,
    roles,
    actorId: req.user.id,
    actorName: req.user.username,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** PUT /api/users/:id/estado */
router.put('/users/:id/estado', auth, adminUsuarios('edit'), asincrono(async (req, res) => {
  const { activo } = req.body || {}
  if (typeof activo !== 'boolean') {
    return res.status(400).json({ error: 'Se esperaba { activo: true|false }', codigo: 'FORMATO_INVALIDO' })
  }
  const r = await cambiarEstado({
    userId: req.params.id,
    activo,
    actorId: req.user.id,
    actorName: req.user.username,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** POST /api/users/:id/desbloquear */
router.post('/users/:id/desbloquear', auth, adminUsuarios('edit'), asincrono(async (req, res) => {
  const r = await desbloquear({
    userId: req.params.id,
    actorId: req.user.id,
    actorName: req.user.username,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json(r)
}))

/** DELETE /api/users/:id — desactivar, no borrar. */
router.delete('/users/:id', auth, adminUsuarios('delete'), asincrono(async (req, res) => {
  const r = await cambiarEstado({
    userId: req.params.id,
    activo: false,
    actorId: req.user.id,
    actorName: req.user.username,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
  res.json({ ...r, mensaje: 'Usuario desactivado. Su historial se conserva.' })
}))

// ─── Roles y permisos ────────────────────────────────────────────────────────

/** GET /api/roles */
router.get('/roles', auth, adminUsuarios('view'), asincrono(async (_req, res) => {
  const roles = await query('SELECT id, code, name, description, is_system FROM roles ORDER BY code')
  res.json(roles)
}))

/** GET /api/roles/:code/usuarios */
router.get('/roles/:code/usuarios', auth, adminUsuarios('view'), asincrono(async (req, res) => {
  const filas = await query(
    `SELECT u.id, u.username, u.full_name, u.is_active
       FROM users u JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = $1 ORDER BY u.full_name`,
    [req.params.code],
  )
  res.json(filas)
}))

/** GET /api/permissions — la matriz completa, para pintarla en la interfaz. */
router.get('/permissions', auth, requierePermiso('permissions', 'view'), asincrono(async (_req, res) => {
  const { MODULOS, ACCIONES } = await import('../../security/permisos.js')
  const asignadas = await query(
    `SELECT r.code AS rol, p.module, p.action
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id`,
  )
  const matriz = {}
  for (const a of asignadas) {
    matriz[a.rol] ||= {}
    matriz[a.rol][`${a.module}:${a.action}`] = true
  }
  const roles = await query('SELECT code, name FROM roles ORDER BY code')
  res.json({
    modulos: MODULOS,
    acciones: ACCIONES,
    roles: roles.map((r) => ({ ...r, permisos: matriz[r.code] || {} })),
  })
}))

/** PUT /api/roles/:code/permisos — solo ADMIN puede tocar la matriz. */
router.put('/roles/:code/permisos', auth, requierePermiso('permissions', 'edit'), asincrono(async (req, res) => {
  //
  // SE ACEPTA LA LISTA Y EL MAPA.
  //
  // El contrato de siempre es el mapa `{"orders:view": true, …}`: es lo que
  // devuelve GET /permissions y lo que decía el mensaje de error. Pero la
  // pantalla de la matriz lo mandaba como lista `["orders:view", …]`, y eso era
  // un 400 que salía justo después de arreglar el fallo de la carga: en cuanto
  // se despreciaba una casilla y se pulsaba «Guardar cambios».
  //
  // Aceptar las dos formas cuesta cuatro líneas y quita un modo de fallo entero:
  // que la matriz se quede a medio guardar y nadie entienda por qué.
  //
  // Un permiso NO se pierde nunca por esto: se borra todo y se reescribe desde
  // lo que el usuario acaba de marcar en pantalla.
  const { permisos } = req.body || {}
  const aGrabar = Array.isArray(permisos)
    ? Object.fromEntries(permisos.filter(Boolean).map((c) => [String(c), true]))
    : permisos
  if (!aGrabar || typeof aGrabar !== 'object') {
    return res.status(400).json({
      error: 'Se esperaba { permisos: { "modulo:accion": true } } '
        + 'o una lista de "modulo:accion"',
      codigo: 'PETICION_INVALIDA',
    })
  }

  const { transaction } = await import('../../db/client.js')
  const n = await transaction(async (tx) => {
    const rol = await tx.one('SELECT id, code FROM roles WHERE code = $1', [req.params.code])
    if (!rol) throw new ErrorDeAuth(`Rol desconocido: ${req.params.code}`, 'ROL_DESCONOCIDO', 404)
    if (rol.code === 'ADMIN') {
      throw new ErrorDeAuth('Los permisos del administrador no se modifican: tiene todos', 'ROL_PROTEGIDO', 400)
    }
    await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [rol.id])
    let insertados = 0
    for (const clave of Object.keys(aGrabar)) {
      if (aGrabar[clave] !== true) continue
      const [modulo, accion] = clave.split(':')
      const p = await tx.one('SELECT id FROM permissions WHERE module = $1 AND action = $2', [modulo, accion])
      if (!p) continue
      await tx.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [rol.id, p.id],
      )
      insertados++
    }
    await tx.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, after_data, outcome)
       VALUES ($1,$2,'UPDATE_PERMISSIONS','roles',$3,$4,'SUCCESS')`,
      [req.user.id, req.user.username, rol.code, JSON.stringify(permisos)],
    )
    return insertados
  })
  res.json({ ok: true, permisos: n })
}))

export default router
