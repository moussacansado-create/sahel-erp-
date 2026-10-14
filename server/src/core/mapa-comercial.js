/**
 * EL MAPA: Región → Zona → Comercial → Clientes.
 *
 * ── POR QUÉ ESTO NO ES UNA CONSULTA SUELTA ───────────────────────────────────
 *
 * Porque el mapa es lo primero que se mira para saber a quién llamar, y quien
 * lo mira NO es el jefe: es el comercial, en el móvil, en una tienda. Si la
 * respuesta sale de una consulta nueva cada vez, cada consulta es un sitio
 * donde olvidarse de filtrar por cartera y acabar enseñándole a un comercial
 * los clientes de otro. Por eso la construcción vive aquí, en un sitio, y las
 * rutas noFiltered.
 *
 * ── QUIÉN VE QUÉ ─────────────────────────────────────────────────────────────
 *
 *   · quien administra (ADMIN / JEFE_COMERCIAL): todas las zonas, todas las
 *     carteras y los clientes sin asignar;
 *   · un comercial: todas las zonas —el mapa es del territorio, no suyo— pero
 *     con los datos de contacto del responsable, y NÚNCA la cartera ajena.
 *
 * La cartera ajena no se oculta: no se consulta. Ocultar una fila es filtros
 * en la vista; no consultarla es no pedirla.
 */

import { query, one, transaction } from '../db/client.js'
import { tienePermiso as comprobarPermiso } from '../security/permisos.js'

/** El `com_perfiles.id` de quien está delante de la petición, o `null`. */
export async function perfilDe(usuarioId) {
  if (!usuarioId) return null
  return one('SELECT id, home_zona_id, is_active FROM com_perfiles WHERE user_id = $1', [usuarioId])
}

/**
 * ¿Quien pregunta administra el módulo comercial?
 *
 * NO sale de ocultar botones: sale de los mismos permisos que protegen las
 * escrituras. Si mañana se le da a un rol `commercial:create` sin ser
 * administrador, esta función lo sigue siendo y las escrituras se abren. Es lo
 * que evita que un comercial se conceda a sí mismo el poder de repartir zonas
 * tocando un permiso.
 */
export async function administraComerciales(usuario) {
  const roles = usuario?.roles || []
  if (roles.includes('ADMIN') || roles.includes('JEFE_COMERCIAL')) return true
  // `tienePermiso` de la seguridad pide el id de USUARIO, no el objeto entero.
  return comprobarPermiso(usuario.id, 'commercial', 'create')
}

/** Las zonas que puede llevar un comercial. Se comprueba aqui y en cada escritura. */
export async function zonasAutorizadas(perfilId) {
  if (!perfilId) return []
  const r = await query('SELECT zona_id FROM com_comercial_zonas WHERE comercial_id = $1 AND hasta IS NULL ORDER BY zona_id', [perfilId])
  return r.map((x) => x.zona_id)
}

/**
 * La zona que puede poner a un cliente. `null` significa «sin restricciones»,
 * que es lo que ve quien administra. Nunca significa «cualquiera» por descuido.
 */
export async function zonaPermitida(perfilId, zonaId) {
  if (perfilId === null) return true
  const dentro = await one(
    'SELECT 1 AS ok FROM com_comercial_zonas WHERE comercial_id = $1 AND zona_id = $2 AND hasta IS NULL', [perfilId, zonaId],
  )
  return dentro !== null
}

/**
 * El mapa entero, agrupado por región, con el responsable y sus clientes.
 *
 * `verClientes` es lo que separa a quien administra de un comercial: el
 * comercial recibe los RECUENTOS de todas las zonas —que son públicos, son
 * territorio— pero la lista de clientes, solo de las suyas. Los recuentos no
 * son datos de cartera: son cuántos hay en un sitio.
 */
export async function mapa({ perfilId = null, verClientes = true, soloZonas = null } = {}) {
  // El filtro de zona se ARMA en vez de pasarse con un NULL: pasar `null` a
  // `$1::int[]` no castea en PGlite y revienta la consulta entera. Un filtro
  // que rompe la llamada no es un filtro queoomita datos: es uno que nadie ve.
  const conFiltro = Array.isArray(soloZonas) && soloZonas.length > 0
  const zonas = await query(
    `SELECT id, code, name, kind, nivel, parent_id, latitude, longitude, is_active,
            clientes, clientes_con_comercial,
            responsable_id, responsable_usuario, responsable_nombre, responsable_email
       FROM v_mapa_zona
      ${conFiltro ? 'WHERE id = ANY($1::int[])' : ''}
      ORDER BY kind, code`,
    conFiltro ? [soloZonas] : [],
  )

  // Clientes: solo de las zonas que el que pregunta puede ver en detalle.
  const cartera = perfilId === null
    ? null
    : (await query(
      `SELECT c.id, c.code, c.name, c.zone_id, c.comercial_id, c.phone, c.address,
              u.full_name AS comercial_nombre
         FROM customers c
         LEFT JOIN com_perfiles p ON p.id = c.comercial_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE c.comercial_id = $1 AND c.is_active
        ORDER BY c.name`,
      [perfilId],
    ))

  // El teléfono vive en com_perfiles, no en users: se trae en la misma pasada.
  const telefonos = await query(
    `SELECT p.id, p.phone FROM com_perfiles p WHERE p.is_active`,
  )
  const tel = new Map(telefonos.map((x) => [x.id, x.phone]))

  const porZona = new Map()
  for (const c of cartera || []) {
    if (!porZona.has(c.zone_id)) porZona.set(c.zone_id, [])
    porZona.get(c.zone_id).push({
      id: c.id, code: c.code, name: c.name, phone: c.phone, address: c.address,
      comercial: c.comercial_nombre,
    })
  }

  const zonasConDetalle = zonas.map((z) => ({
    ...z,
    // El teléfono de contacto del responsable es lo que permite llamar desde
    // esa zona. Sin zonas asignadas no hay responsable, y se dice así de claro.
    responsable_telefono: z.responsable_id ? (tel.get(z.responsable_id) || null) : null,
    clientes: verClientes ? (porZona.get(z.id) || []) : null,
  }))

  const regiones = zonasConDetalle.filter((z) => z.kind === 'REGION' || z.nivel === 'REGION')
  const grupos = new Map()
  for (const r of regiones) grupos.set(r.id, { ...r, zonas: [] })
  for (const z of zonasConDetalle) {
    if (z.kind === 'REGION' || z.nivel === 'REGION') continue
    const padre = grupos.get(z.parent_id)
    if (padre) padre.zonas.push(z)
  }

  return {
    regiones: [...grupos.values()],
    zonas: zonasConDetalle,
    // Lo que NO se puede ver desde aquí, dicho en voz alta. Que la pantalla
    // pueda escribir «13 clientes sin asignar · no visibles para ti» y no
    // tenga que inventarlo mirando un número que no cuadra.
    alcance: perfilId === null ? 'ADMIN' : 'COMERCIAL',
  }
}

/** Cuántos clientes tiene cada comercial, con los sin asignar aparte. */
export async function carteras() {
  return query(
    `SELECT comercial_id, username, nombre, sin_asignar, clientes, clientes_activos
       FROM v_cartera_comercial
      ORDER BY sin_asignar, clientes DESC`,
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ASIGNAR ZONAS A UN COMERCIAL
//
// Solo quien administra. Y no por oculto-boton: la ruta pide `commercial:create`,
// que no tiene el comercial, y aquí además se vuelve a comprobar.
//
// Un comercial con CERO zonas es una situación legítima —recién creado, sin
// reparto— y por eso `com_comercial_zonas` no pone mínimo uno. Lo que no puede
// pasar es que un comercial tenga zonas que nadie le ha dado.
// ══════════════════════════════════════════════════════════════════════════

/** Asignar (o quitar) zonas a un comercial. `zonaIds` es la lista final. */
export async function asignarZonas(perfilId, zonaIds, usuarioId, base = null) {
  const deseadas = [...new Set((zonaIds || []).map(Number))]
  for (const z of deseadas) {
    const existe = await one('SELECT 1 AS ok FROM com_zonas WHERE id = $1', [z])
    if (!existe) throw new Error(`La zona ${z} no existe`)
  }
  return transaction(async (tx) => {
    // Cerrar las viejas en vez de borrarlas: esta tabla tiene `desde`/`hasta`
    // para eso mismo. Borrar el pasado para que el presente cuadre.
    await tx.query('UPDATE com_comercial_zonas SET hasta = CURRENT_DATE WHERE comercial_id = $1 AND hasta IS NULL', [perfilId])
    for (const z of deseadas) {
      await tx.query(
        `INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal)
         VALUES ($1,$2,$3)`,
        [perfilId, z, base !== null && z === Number(base)],
      )
    }
    // `zonasDe()` usa el `query` DEL MÓDULO, y llamarlo aquí abre una segunda
    // conexión a PGlite mientras la primera tiene la transacción abierta. PGlite
    // solo admite una: la petición se queda esperando para siempre, sin error y
    // sin rastro. Dentro de una transacción, TODO por `tx`.
    return tx.query(
      `SELECT z.id, z.code, z.name, z.kind, z.nivel, c.es_principal
         FROM com_comercial_zonas c JOIN com_zonas z ON z.id = c.zona_id
        WHERE c.comercial_id = $1 AND c.hasta IS NULL
        ORDER BY z.kind, z.code`,
      [perfilId],
    )
  })
}

export async function zonasDe(perfilId) {
  return query(
    `SELECT z.id, z.code, z.name, z.kind, z.nivel, c.es_principal
       FROM com_comercial_zonas c JOIN com_zonas z ON z.id = c.zona_id
      WHERE c.comercial_id = $1 AND c.hasta IS NULL
      ORDER BY z.kind, z.code`,
    [perfilId],
  )
}

// ══════════════════════════════════════════════════════════════════════════
// LAS ZONAS QUE PUEDO USAR
//
// El desplegable del formulario de clientes se llena con esto. No con «todas las
// zonas»: si se ofrecieran todas, el comercial elegiría una que el backend le
// va a rechazar, y el rechazo parecería un fallo del sistema en lugar de una
// consecuencia de no tener esa zona.
//
// La lista se decide AQUÍ, en el servidor, con la misma regla que aplica
// `limitarCartera()`. Que las dos coincidan no es casualidad: si el desplegable
// y la validación tuvieran criterios distintos, habría momentos en que se
// aceptara una zona que el formulario no ofrecía, y momentos en que se
// rechazara una que sí ofrecía.
// ══════════════════════════════════════════════════════════════════════════

export async function zonasQuePuedoUsar(perfilId, gestiona) {
  if (gestiona) {
    return query(
      `SELECT z.id, z.code, z.name, z.kind, z.nivel,
              (r.name) AS region,
              pz.u_nombre AS responsable
         FROM com_zonas z
         LEFT JOIN com_zonas r ON r.id = z.parent_id
         LEFT JOIN LATERAL (
           SELECT u.full_name AS u_nombre
             FROM com_comercial_zonas c
             JOIN com_perfiles p ON p.id = c.comercial_id AND p.is_active
             JOIN users u ON u.id = p.user_id
            WHERE c.zona_id = z.id AND c.hasta IS NULL
              AND NOT EXISTS (SELECT 1 FROM com_comercial_zonas o
                               WHERE o.zona_id = c.zona_id AND o.hasta IS NULL AND o.id < c.id)
            LIMIT 1
         ) pz ON TRUE
        WHERE z.is_active
        ORDER BY z.kind, z.code`,
    )
  }
  if (!perfilId) return []
  return query(
    `SELECT z.id, z.code, z.name, z.kind, z.nivel, (r.name) AS region
       FROM com_comercial_zonas c
       JOIN com_zonas z ON z.id = c.zona_id
       LEFT JOIN com_zonas r ON r.id = z.parent_id
      WHERE c.comercial_id = $1 AND c.hasta IS NULL AND z.is_active
      ORDER BY z.kind, z.code`,
    [perfilId],
  )
}
