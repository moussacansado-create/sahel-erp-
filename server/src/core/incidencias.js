/**
 * INCIDENCIAS COMERCIALES DE CLIENTES.
 *
 * ── POR QUÉ ESTE ARCHIVO Y NO EL DE REPARTO ────────────────────────────────
 *
 * `incidents` (005) cuelga de `deliveries` y habla de repartos. Aquí cuelga de
 * `customers` y habla de tiendas. No comparten ni una columna útil, así que no
 * se tocan ni se mezclan: una incidencia de reparto no se resuelve en este
 * módulo, y una comercial no se repara.
 *
 * ── LA REGLA QUE IMPORTA ───────────────────────────────────────────────────
 *
 * Registrar una incidencia NO reparte clientes, NO crea pedidos, NO toca pagos
 * ni Caja. Abre un registro y ya está. Si someday una incidencia debe generar
 * un pedido, será una acción aparte, explícita y con su propia comprobación: si
 * colara de paso, un comercial podría quedarse con una cartera entera
 * «comunicando problemas».
 */

import { transaction, one, query } from '../db/client.js'
import { ErrorComercial } from './comerciales.js'

const TIPOS = [
  'PEDIDO_NO_LLEGADO', 'FALTA_MERCANCIA', 'CALIDAD',
  'PRECIO_O_FACTURA', 'SERVICIO', 'COMERCIAL', 'OTRO',
]
const ESTADOS = ['ABIERTA', 'EN_CURSO', 'ESPERA', 'RESUELTA']
const GRAVEDADES = ['BAJA', 'NORMAL', 'ALTA', 'URGENTE']

const fallo = (mensaje, codigo, estado = 400, detalle = {}) =>
  new ErrorComercial(mensaje, { codigo, detalle, estado })

/**
 * Abrir una incidencia.
 *
 * `registrada_por` sale de `usuarioId`, que es la sesión: nunca del cuerpo. Si
 * se leyera de ahí, mandar `registrada_por: 1` firmaría la incidencia del
 * administrador con el nombre de otro.
 *
 * `responsable_id` y `comercial_id` se LEEN del cliente y se COPIAN. Copiar es
 * una foto; cambiar sería repartir, y repartir desde aquí sería la vía más
 * fácil de quedarse con la cartera ajena.
 */
export async function abrirIncidencia({
  usuarioId, clienteId = null, comercialId = null, comunicadaPor = null,
  tipo, descripcion, gravedad = 'NORMAL', zonaId = null,
  proximaAccion = null, fechaSeguimiento = null,
}) {
  if (!TIPOS.includes(tipo)) {
    throw fallo(`Tipo de incidencia desconocido: ${tipo}.`, 'TIPO_INVALIDO', 400, { tipos: TIPOS })
  }
  if (!descripcion || !descripcion.trim()) {
    throw fallo('Escribe qué ha pasado. Una incidencia sin descripción no dice nada.', 'DESCRIPCION_OBLIGATORIA')
  }
  if (!GRAVEDADES.includes(gravedad)) {
    throw fallo(`Gravedad desconocida: ${gravedad}.`, 'GRAVEDAD_INVALIDA', 400, { gravedades: GRAVEDADES })
  }

  return transaction(async (tx) => {
    let responsable = null
    let zona = zonaId
    if (clienteId != null) {
      const c = await tx.one(
        'SELECT id, comercial_id, zone_id FROM customers WHERE id = $1', [clienteId],
      )
      if (!c) throw fallo(`No existe el cliente ${clienteId}.`, 'CLIENTE_NO_EXISTE', 404)
      // El responsable se COPIA. Si el cliente no tiene, se queda NULL: no se
      // inventa un dueño, y la incidencia sigue siendo válida sin él.
      responsable = c.comercial_id ?? null
      zona = zona ?? c.zone_id ?? null
    }

    // Quién la lleva. Por defecto, el dueño del cliente; si no hay, quien la
    // abre. Nunca «nadie», porque una incidencia sin responsable no se atiende.
    const lleva = comercialId ?? responsable ?? null

    const fila = await tx.one(
      `INSERT INTO com_incidencias
         (cliente_id, comercial_id, responsable_id, zona_id,
          registrada_por, comunicada_por, tipo, descripcion, gravedad,
          proxima_accion, fecha_seguimiento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [clienteId, lleva, responsable, zona,
        usuarioId, comunicadaPor ?? usuarioId, tipo, descripcion.trim(), gravedad,
        proximaAccion ?? null, fechaSeguimiento ?? null],
    )
    return { ...fila }
  })
}

/** Mover la incidencia de estado. Resolver exige decir qué se hizo. */
export async function cambiarEstado({ id, usuarioId, estado, resolucion = null, proximaAccion = null, fechaSeguimiento = null }) {
  if (!ESTADOS.includes(estado)) {
    throw fallo(`Estado desconocido: ${estado}.`, 'ESTADO_INVALIDO', 400, { estados: ESTADOS })
  }
  return transaction(async (tx) => {
    const antes = await tx.one('SELECT * FROM com_incidencias WHERE id = $1 FOR UPDATE', [id])
    if (!antes) throw fallo(`No existe la incidencia ${id}.`, 'INCIDENCIA_NO_EXISTE', 404)

    if (estado === 'RESUELTA' && (!resolucion || !resolucion.trim())) {
      // El CHECK de la tabla también lo impide, pero aquí el mensaje dice qué
      // hacer en lugar de soltar un error de integridad.
      throw fallo(
        'Escribe qué se hizo para resolverla. Una incidencia cerrada sin '
        + 'resolución no sirve de nada dentro de seis meses.',
        'RESOLUCION_OBLIGATORIA',
      )
    }

    // El disparador de la tabla impide reabrir, cambiar el cliente o la
    // identidad. Sus errores son reglas de negocio, no fallos del servidor: sin
    // esto salían como 500 y quien lo veía pensaba que se había roto algo.
    if (antes.estado === 'RESUELTA' && estado !== 'RESUELTA') {
      throw fallo(
        'La incidencia ya está resuelta y no se puede reabrir. Si el problema '
        + 'vuelve, se abre otra incidencia nueva.',
        'INCIDENCIA_RESUELTA', 409,
      )
    }

    const f = await tx.one(
      `UPDATE com_incidencias
          SET estado = $2,
              resolucion = CASE WHEN $2 = 'RESUELTA' THEN $3 ELSE resolucion END,
              resuelta_at = CASE WHEN $2 = 'RESUELTA' THEN now() ELSE resuelta_at END,
              resuelta_por = CASE WHEN $2 = 'RESUELTA' THEN $4 ELSE resuelta_por END,
              proxima_accion = COALESCE($5, proxima_accion),
              fecha_seguimiento = COALESCE($6, fecha_seguimiento)
        WHERE id = $1
      RETURNING *`,
      [id, estado, resolucion?.trim() ?? null, usuarioId, proximaAccion ?? null, fechaSeguimiento ?? null],
    )
    return { ...f }
  })
}

/**
 * Listar. El filtro de cartera va AQUÍ y no en la pantalla: un comercial que
 * abre las incidencias de otro se lleva además quién tiene qué problema, que
 * es información de su competencia.
 */
export async function listarIncidencias({ clienteId = null, comercialId = null, estado = null, limite = 100 } = {}) {
  const cond = []
  const p = []
  const pon = (v) => { p.push(v); return `$${p.length}` }
  if (clienteId != null) cond.push(`i.cliente_id = ${pon(clienteId)}`)
  if (comercialId != null) cond.push(`i.comercial_id = ${pon(comercialId)}`)
  if (estado != null) cond.push(`i.estado = ${pon(estado)}`)
  p.push(Math.min(Number(limite) || 100, 500))
  return query(
    `SELECT i.*, c.name AS cliente, c.code AS cliente_code,
            u.full_name AS registrada_por_nombre,
            cu.full_name AS comunicada_por_nombre,
            cu2.username AS comercial,
            z.name AS zona
       FROM com_incidencias i
       LEFT JOIN customers c ON c.id = i.cliente_id
       LEFT JOIN users u ON u.id = i.registrada_por
       LEFT JOIN users cu ON cu.id = i.comunicada_por
       LEFT JOIN com_perfiles cp ON cp.id = i.comercial_id
       -- El nombre del comercial esta en users, no en com_perfiles:
       -- ese guarda el perfil, no la cuenta. De ahi el JOIN de mas.
       LEFT JOIN users cu2 ON cu2.id = cp.user_id
       LEFT JOIN com_zonas z ON z.id = i.zona_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY i.creado_at DESC
      LIMIT $${p.length}`,
    p,
  )
}
