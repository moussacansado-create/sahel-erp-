/**
 * Permisos. Fail-closed.
 *
 * En la aplicación anterior las rutas de retirada solo pedían «sesión iniciada»,
 * así que un repartidor podía abrir y cerrar una retirada. Y la gestión de
 * permisos no tenía pantalla.
 *
 * Aquí hay tres reglas que no se negocian:
 *
 *   1. Sin token válido → 401. Siempre.
 *   2. Con token pero sin permiso para ese módulo+acción → 403.
 *   3. `admin` lo puede todo; el resto decide por su matriz de permisos.
 *
 * Ocultar un botón es cortesía. Impedir la operación es la garantía. Esta es la
 * segunda.
 */

import { query, one } from '../db/client.js'

/** Módulos y acciones que el sistema reconoce. */
export const MODULOS = [
  'dashboard', 'raw_materials', 'packaging', 'products', 'recipes', 'lots',
  'production', 'inventory', 'orders', 'customers', 'deliveries', 'commercial',
  'sales', 'purchases', 'suppliers', 'expenses', 'traceability', 'recalls',
  'history', 'alerts', 'cash', 'users', 'permissions', 'reports', 'zones', 'settings',
  // `rankings` tenía que estar aquí desde el principio de la 052. Sin él, la
  // fila de `role_permissions` existía en la base y el ADMIN pasaba los 403 del
  // servidor, pero `/auth/me` no le devolvía `rankings:edit`, la interfaz
  //使用的是 `A.puede` y le ocultaba el apartado entero.
  //
  // La mitad de la garantía vive en la base y la otra en esta lista, y por eso
  // tienen que coincidir. Un permiso que solo está en un sitio no existe.
  'rankings',
]

export const ACCIONES = ['view', 'create', 'edit', 'delete', 'approve', 'export']

/** Middleware: exige sesión. */
export function requiereSesion({ query, one }) {
  return async function auth(req, res, next) {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autenticado', codigo: 'NO_AUTENTICADO' })
    }
    try {
      const { default: jwt } = await import('jsonwebtoken')
      const config = (await import('../config/index.js')).default
      const payload = jwt.verify(header.slice(7), config.JWT_SECRET, {
        algorithms: ['HS256'],
        clockTolerance: config.ALLOWED_CLOCK_SKEW,
      })

      // El token no basta: el usuario debe seguir existiendo y activo.
      // Así, desactivar a alguien surte efecto sin esperar a que caduque su token.
      const usuario = await one(
        'SELECT id, username, full_name, is_active, locked_until FROM users WHERE id = $1',
        [payload.sub],
      )
      if (!usuario) {
        return res.status(401).json({ error: 'Usuario no encontrado', codigo: 'NO_AUTENTICADO' })
      }
      if (!usuario.is_active) {
        return res.status(401).json({ error: 'Cuenta desactivada', codigo: 'CUENTA_INACTIVA' })
      }
      if (usuario.locked_until && new Date(usuario.locked_until) > new Date()) {
        return res.status(401).json({ error: 'Cuenta bloqueada temporalmente', codigo: 'CUENTA_BLOQUEADA' })
      }

      // Y la sesión tampoco basta: tiene que existir y no estar revocada.
      // Sin esta comprobación, cerrar sesión o cambiar la contraseña no
      // impediría el acceso hasta que el token caducara (15 minutos).
      if (payload.sid) {
        const sesion = await one(
          `SELECT id FROM sessions
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
          [payload.sid, payload.sub],
        )
        if (!sesion) {
          return res.status(401).json({ error: 'Sesión cerrada o caducada', codigo: 'SESION_INVALIDA' })
        }
      }

      req.user = {
        id: usuario.id,
        username: usuario.username,
        fullName: usuario.full_name,
        sessionId: payload.sid,
      }
      // Los roles y permisos se leen de la base, nunca del token: si un permiso
      // cambia, surte efecto en la siguiente petición, no al renovar el token.
      req.roles = await rolesDe(usuario.id)
      req.permisos = await permisosDe(usuario.id, req.roles)
      // Los roles viajan TAMBIÉN dentro de `req.user`, porque es lo que se pasa
      // a las funciones de negocio. Sin ellos, `filtroDeAmbito` no sabe si
      // quien llama es un comercial y se limita a no filtrar nada: un fallo
      // que abre la puerta en silencio, sin error ni rastro.
      req.user.roles = req.roles
      next()
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Sesión expirada', codigo: 'TOKEN_EXPIRADO' })
      }
      return res.status(401).json({ error: 'Token inválido', codigo: 'TOKEN_INVALIDO' })
    }
  }
}

/** Middleware: además de sesión, permiso para módulo+acción. */
export function requierePermiso(modulo, accion) {
  if (!MODULOS.includes(modulo)) {
    throw new Error(`Módulo de permiso desconocido: ${modulo}`)
  }
  if (!ACCIONES.includes(accion)) {
    throw new Error(`Acción de permiso desconocida: ${accion}`)
  }
  return async function permiso(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado', codigo: 'NO_AUTENTICADO' })
    }
    const denegado = await tienePermiso(req.user.id, modulo, accion)
    if (!denegado) {
      await registrarAuditoria({
        tx: { query, one },
        userId: req.user.id,
        userName: req.user.username,
        accion: 'PERMISO_DENEGADO',
        entidad: modulo,
        entidadId: accion,
        outcome: 'DENIED',
        ip: req.ip,
      })
      return res.status(403).json({
        error: `No tienes permiso para ${accion} en ${modulo}`,
        codigo: 'PERMISO_DENEGADO',
      })
    }
    next()
  }
}


/**
 * Middleware: basta con UNO de los pares módulo:acción indicados.
 *
 * `requiereAlguno()` sirve cuando todos los módulos comparten la misma acción:
 * «ver recetas» es `recipes:view` O `production:view`. Pero hay casos en que lo
 * que abre la puerta es una combinación, y con un solo verbo no se expresa.
 *
 * El caso real: la lista de PROVEEDORES.
 *
 *   · quien gestiona proveedores      → `suppliers:view`
 *   · quien hace compras              → `purchases:view`
 *   · quien recibe mercancía          → `inventory:create`
 *
 * Este último es el que faltaba. El rol de producción tiene `inventory:create`
 * —recibe mercancía todos los días— pero no `suppliers:view`, así que la de
 * Entradas le salía en el menú y al abrirla, el selector de proveedor devolvía
 * un 403. No es que tuviera de más: le faltaba el permiso que hace falta para
 * hacer su trabajo, y el sistema no se lo daba porque no existe un módulo que
 * signifique «puede dar de alta mercancía».
 *
 * Ojo con lo que NO es esto: no es abrir una puerta de más. Los tres permisos
 * siguen siendo los mismos, y quien no tenga ninguno sigue sin ver nada. Solo
 * se acepta que un camino válido deje de cerrar por el simple hecho de que el
 * permiso que le corresponde está en otro módulo.
 *
 * @param {Array<[string,string]>|Function} pares  `[['suppliers','view'], …]`
 * @param {string} etiqueta                        para el mensaje de error
 */
export function requiereAlgunoDe(pares, etiqueta = 'la acción') {
  const resolver = typeof pares === 'function' ? pares : () => pares
  return async function permiso(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado', codigo: 'NO_AUTENTICADO' })
    }
    let lista
    try {
      lista = resolver(req)
    } catch (e) {
      return res.status(400).json({ error: e.message, codigo: 'PETICION_INVALIDA' })
    }
    const validos = Array.isArray(lista) ? lista.filter((p) => Array.isArray(p) && p.length === 2) : []
    // Fail-closed: una lista vacía o con mal forma deniega. Nunca «permite».
    if (!validos.length) {
      return res.status(403).json({ error: `No tienes permiso para ${etiqueta}`, codigo: 'PERMISO_DENEGADO' })
    }
    for (const [mod, acc] of validos) {
      if (ACCIONES.includes(acc) && await tienePermiso(req.user.id, mod, acc)) return next()
    }
    await registrarAuditoria({
      tx: { query, one },
      userId: req.user.id,
      userName: req.user.username,
      accion: 'PERMISO_DENEGADO',
      entidad: validos.map(([m, a]) => `${m}:${a}`).join('|'),
      entidadId: 'cualquiera',
      outcome: 'DENIED',
      ip: req.ip,
    })
    res.status(403).json({
      error: `No tienes permiso para ${etiqueta}. Necesitas uno de: `
        + validos.map(([m, a]) => `${m}:${a}`).join(', '),
      codigo: 'PERMISO_DENEGADO',
    })
  }
}

/**
 * Middleware: basta con permiso de UNO de los módulos indicados.
 *
 * Hace falta porque un mismo endpoint sirve para varias cosas: dar de alta una
 * materia prima lo puede hacer quien tenga `raw_materials:create`, pero dar de
 * alta un producto terminado, quien tenga `products:create`. La ruta no sabe de
 * antemano de qué se trata; el cuerpo de la petición sí.
 *
 * Módulos dinámicos: `resolverModulos(req)` devuelve la lista en el momento de
 * la petición. Si devuelve una lista vacía, se deniega: fail-closed.
 */
export function requiereAlguno(modulos, accion, etiqueta = 'la acción') {
  const resolver = typeof modulos === 'function' ? modulos : () => modulos
  return async function permiso(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado', codigo: 'NO_AUTENTICADO' })
    }
    let lista
    try {
      lista = resolver(req)
    } catch (e) {
      return res.status(400).json({ error: e.message, codigo: 'PETICION_INVALIDA' })
    }
    if (!Array.isArray(lista) || !lista.length) {
      return res.status(403).json({ error: `No tienes permiso para ${etiqueta}`, codigo: 'PERMISO_DENEGADO' })
    }
    for (const m of lista) {
      if (await tienePermiso(req.user.id, m, accion)) return next()
    }
    await registrarAuditoria({
      tx: { query, one },
      userId: req.user.id,
      userName: req.user.username,
      accion: 'PERMISO_DENEGADO',
      entidad: lista.join('|'),
      entidadId: accion,
      outcome: 'DENIED',
      ip: req.ip,
    })
    res.status(403).json({
      error: `No tienes permiso para ${accion} en ${lista.join(' o ')}`,
      codigo: 'PERMISO_DENEGADO',
    })
  }
}

/** ¿El usuario puede? Fail-closed: si no hay dato, no puede. */
export async function tienePermiso(usuarioId, modulo, accion) {
  const porRol = await one(
    `SELECT EXISTS (
       SELECT 1
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p        ON p.id = rp.permission_id
       WHERE ur.user_id = $1 AND p.module = $2 AND p.action = $3
     ) AS ok`,
    [usuarioId, modulo, accion],
  )
  if (porRol?.ok) return true

  // El administrador lo puede todo, sin excepción.
  const admin = await one(
    `SELECT EXISTS (
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = 'ADMIN'
     ) AS ok`,
    [usuarioId],
  )
  return Boolean(admin?.ok)
}

/** Roles de un usuario. */
export async function rolesDe(usuarioId) {
  return (await query(
    `SELECT r.code, r.name FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 ORDER BY r.code`,
    [usuarioId],
  )).map((r) => r.code)
}

/** Permisos efectivos: unión de los de todos sus roles. */
export async function permisosDe(usuarioId, roles = null) {
  const rs = roles || (await rolesDe(usuarioId))
  if (rs.includes('ADMIN')) {
    return MODULOS.flatMap((m) => ACCIONES.map((a) => `${m}:${a}`))
  }
  const filas = await query(
    `SELECT p.module, p.action
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [usuarioId],
  )
  return filas.map((f) => `${f.module}:${f.action}`)
}

/**
 * Permiso de ámbito: además del permiso general, el usuario solo puede tocar
 * lo que le corresponde. Un repartidor no ve pedidos que no son suyos; un
 * comercial no ve clientes de otro comercial.
 *
 * Devuelve el filtro SQL que hay que añadir, ya parametrizado.
 */
export function filtroDeAmbito(usuario, opciones) {
  const { esAdmin, ambitoComercial = true, ambitoEntregas = true } = opciones
  // `esAdmin` se puede pasar, pero si no lo pasan se usa la cuenta de roles.
  //
  // Antes esto era OBLIGATORIO y no lo pasó nadie: `filtroDeAmbito` no lo
  // llamaba ninguna ruta, así que el fallo no se veía. En cuanto el filtro se
  // usa de verdad, sale a la primera y el efecto es el contrario del que se
  // quiere: sin filtro, un comercial ve los clientes de la casa.
  const esAdminFinal = esAdmin || ((u) => Array.isArray(u?.roles) && u.roles.includes('ADMIN'))
  if (esAdminFinal(usuario)) return { sql: '', params: [] }

  if (ambitoEntregas) {
    // Repartidor: solo lo que se le ha asignado o creado.
    if (usuario.roles.includes('DELIVERY')) {
      return { sql: 'AND d.rep_id = $__N', params: [usuario.id] }
    }
  }
  if (ambitoComercial) {
    // Comercial: solo sus clientes y sus pedidos.
    if (usuario.roles.includes('COMMERCIAL')) {
      // `c.comercial_id` es un `com_perfiles.id` (migración 039), y aquí lo
      // que hay es un `users.id`. No son el mismo número, y usar uno contra
      // el otro no da «sin resultados»: da los clientes DEL COMERCIAL QUE
      // SEA, según por dónde caiga la coincidencia. Un filtro que se
      // equivoca de número no se ve: parece que funciona. Por eso se
      // resuelve por `user_id` y no por el identificador de la sesión.
      return {
        sql: 'AND c.comercial_id = (SELECT id FROM com_perfiles WHERE user_id = $__N)',
        params: [usuario.id],
      }
    }
  }
  return { sql: '', params: [] }
}

async function registrarAuditoria({ tx, userId, userName, accion, entidad, entidadId, outcome, ip }) {
  await tx.query(
    `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, outcome, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, userName, accion, entidad, String(entidadId ?? ''), outcome, ip || null],
  )
}
