/**
 * SEGUIMIENTOS: tareas con vida propia.
 *
 * Lo que NO hace, y por qué:
 *
 *   · no borra nada: una tarea se completa o se cancela con su motivo;
 *   · no toca clientes, pedidos, pagos ni Caja: una tarea es un recordatorio,
 *     y un recordatorio que además mueve dinero es un cobro encubierto;
 *   · no reparte carteras: `asignado_a` se elige, no se deduce de mirar al
 *     cliente. Si se dedujera, registrar una tarea sería otra forma de
 *     apropiarse de un cliente.
 *
 * El estado `VENCIDA` / `PROXIMA` / `A_TIEMPO` NO se guarda: se calcula en
 * `v_com_seguimientos` con la fecha de hoy. Guardarlo sería un dato que se
 * queda viejo solo y nadie actualiza.
 */

import { transaction, one, query } from '../db/client.js'
import { ErrorComercial } from './comerciales.js'

const PRIORIDADES = ['BAJA', 'NORMAL', 'ALTA', 'URGENTE']
const fallo = (m, c, e = 400, d = {}) => new ErrorComercial(m, { codigo: c, estado: e, detalle: d })

/**
 * Crear una tarea.
 *
 * `responsable_id` (la foto) sale del cliente. `asignado_a` (quién la hace
 * AHORA) es opcional y NO se rellena solo: que el dueño del cliente no sea
 * quien tiene que llamar mañana es un hecho normal, y deducirlo sería
 * inventar.
 */
export async function crearSeguimiento({
  usuarioId, clienteId = null, titulo, descripcion = null, motivo = null,
  prioridad = 'NORMAL', venceEn = null, asignadoA = null,
  visitaId = null, incidenciaId = null,
}) {
  if (!titulo || !titulo.trim()) {
    throw fallo('La tarea necesita un título. «Seguir con el cliente» no dice qué hacer.', 'TITULO_OBLIGATORIO')
  }
  if (!PRIORIDADES.includes(prioridad)) {
    throw fallo(`Prioridad desconocida: ${prioridad}.`, 'PRIORIDAD_INVALIDA', 400, { prioridades: PRIORIDADES })
  }

  return transaction(async (tx) => {
    let responsable = null
    if (clienteId != null) {
      const c = await tx.one('SELECT id, comercial_id FROM customers WHERE id = $1', [clienteId])
      if (!c) throw fallo(`No existe el cliente ${clienteId}.`, 'CLIENTE_NO_EXISTE', 404)
      responsable = c.comercial_id ?? null
    }
    // Un comercial sin perfil no puede tener tareas propias; el admin sí puede
    // crearlas y asignarlas a quien sea.
    const f = await tx.one(
      `INSERT INTO com_seguimientos
         (cliente_id, responsable_id, asignado_a, creada_por, titulo, descripcion,
          motivo, prioridad, vence_en, visita_id, incidencia_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [clienteId, responsable, asignadoA, usuarioId, titulo.trim(),
        descripcion?.trim() ?? null, motivo?.trim() ?? null, prioridad,
        venceEn ?? null, visitaId ?? null, incidenciaId ?? null],
    )
    return { ...f }
  })
}

/** Atender o cancelar. Los dos exigen decir qué pasó. */
export async function cerrarSeguimiento({ id, usuarioId, resultado, cancelar = false, motivoCancelacion = null }) {
  return transaction(async (tx) => {
    const t = await tx.one('SELECT * FROM com_seguimientos WHERE id = $1 FOR UPDATE', [id])
    if (!t) throw fallo(`No existe la tarea ${id}.`, 'SEGUIMIENTO_NO_EXISTE', 404)
    if (t.estado === 'COMPLETADA') {
      throw fallo('Esa tarea ya está completada y no se puede volver a tocar.', 'SEGUIMIENTO_CERRADO', 409)
    }
    if (cancelar) {
      if (!motivoCancelacion || !motivoCancelacion.trim()) {
        throw fallo('Por qué se cancela. Sin motivo, desaparece.', 'MOTIVO_CANCELACION_OBLIGATORIO')
      }
      const f = await tx.one(
        `UPDATE com_seguimientos
            SET cancelada_at = now(), motivo_cancelacion = $2
          WHERE id = $1 RETURNING *`,
        [id, motivoCancelacion.trim()],
      )
      return { ...f }
    }
    if (!resultado || !resultado.trim()) {
      throw fallo(
        'Escribe qué se hizo. Una tarea atendida sin decir nada no sirve para '
        + 'recordar por qué se cerró.',
        'RESULTADO_OBLIGATORIO',
      )
    }
    const f = await tx.one(
      `UPDATE com_seguimientos
          SET estado = 'COMPLETADA', completada_at = now(), resultado = $2, cerrada_por = $3
        WHERE id = $1 RETURNING *`,
      [id, resultado.trim(), usuarioId],
    )
    return { ...f }
  })
}

/** El filtro de cartera va aquí, no en la pantalla. */
export async function listarSeguimientos({ clienteId = null, asignadoA = undefined, situacion = null, limite = 200 } = {}) {
  const cond = []
  const p = []
  const pon = (v) => { p.push(v); return `$${p.length}` }
  if (clienteId != null) cond.push(`s.cliente_id = ${pon(clienteId)}`)
  if (asignadoA === null) cond.push('s.asignado_a IS NULL')
  else if (asignadoA !== undefined) cond.push(`s.asignado_a = ${pon(asignadoA)}`)
  if (situacion) cond.push(`s.situacion = ${pon(situacion)}`)
  p.push(Math.min(Number(limite) || 200, 500))
  const base = `FROM v_com_seguimientos s ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
    ORDER BY (s.estado = 'PENDIENTE') DESC, s.vence_en NULLS LAST, s.id DESC LIMIT $${p.length}`
  const filtradas = await query(
    `SELECT s.* ${base}`, p,
  )
  if (!situacion) return filtradas
  // `situacion` no existe en la tabla: es una columna calculada de la vista, y
  // filtrar por ella en el WHERE no está permitido. Se filtra en memoria.
  return filtradas.filter((x) => x.situacion === situacion)
}
