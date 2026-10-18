// ═══════════════════════════════════════════════════════════════════════════
// COMISIONES MENSUALES · API
// ═══════════════════════════════════════════════════════════════════════════
//
// AQUÍ NO HAY CÁLCULO. Todo el cálculo y todas las reglas viven en
// `core/comisiones.js`, que es donde se prueban.
//
// LO QUE SÍ HACE ESTA CAPA, Y NO ES TRIVIAL:
//
//  1 · PERMISO. Fail-closed. Si no tienes permiso, 403 y punto. Ocultar el
//      botón no es seguridad: el botón no es la puerta, la API lo es.
//
//  2 · EL RECORTE DEL COMERCIAL. Un comercial que pide las comisiones de
//      otro NO recibe un 403: recibe las SUYAS. El corte se hace AQUÍ, en el
//      servidor, comparando con el comercial del token. Si el recorte se
//      hiciera en la interfaz, bastaría con abrir las herramientas de
//      desarrollo y cambiar una llamada.
//
//  3 · LOS ESTADOS. Solo el administrador prepara, confirma y registra
//      pagos. El comercial solo lee.
//
import { Router } from 'express'
import { requiereSesion, requiereAlgunoDe, tienePermiso } from '../../security/permisos.js'
import { one, query } from '../../db/client.js'
import {
  calcular, confirmarComision, descartarComision, detalle, historialPorcentajes, listar,
  periodoDe, ponerPorcentaje, prepararMes, porcentajeVigente, rangoDelPeriodo,
  registrarPago,
} from '../../core/comisiones.js'

const rutas = Router()

/**
 * Un error de dominio NO es un 500. «No hay porcentaje aplicable» o «el pago
 * necesita su fecha» son respuestas al que pregunta, no fallos del servidor.
 * Un 500 mudo deja a la persona mirando una pantalla en blanco sin saber si
 * ha hecho algo mal.
 */
function dominio(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      // Un error SIN código es un error de dominio: «el importe tiene que ser
      // mayor que cero», «no hay porcentaje aplicable». Es una respuesta a
      // quien pregunta, no un fallo del servidor. Solo lo que de verdad es
      // inesperado (un TypeError, un fallo de base de datos) es un 500.
      const inesperado = e instanceof TypeError || e instanceof ReferenceError
        || e.name === 'DatabaseError' || e.code === 'ECONNREFUSED'
      const estado = e.estado || e.status || (inesperado ? 500 : 400)
      if (estado >= 500) {
        console.error('[comisiones]', e)
        return res.status(500).json({ error: 'Error interno del servidor', codigo: 'ERROR_INTERNO' })
      }
      res.status(estado).json({ error: e.message, codigo: e.codigo || 'COMISION_INVALIDA' })
    }
  }
}
const auth = requiereSesion({ query, one })

const VER = requiereAlgunoDe([['commissions', 'view']], 'ver las comisiones')
const CONFIGURAR = requiereAlgunoDe([['commissions', 'create']], 'configurar los porcentajes')
const CONFIRMAR = requiereAlgunoDe([['commissions', 'approve']], 'confirmar las comisiones')
const PAGAR = requiereAlgunoDe([['commissions', 'edit']], 'registrar los pagos')

const id = (v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) {
    const e = new Error('Identificador no válido.')
    e.codigo = 'PETICION_INVALIDA'
    e.estado = 400
    throw e
  }
  return n
}

/**
 * El `comercial_id` —el de `com_perfiles`, que es el canónico— del usuario
 * que está haciendo la petición.
 */
async function comercialDe(userId) {
  return one('SELECT id FROM com_perfiles WHERE user_id = $1 AND is_active LIMIT 1', [userId])
}

/**
 * A quién puede ver esta persona.
 *
 * El que administra ve a todos. El comercial ve a uno: el suyo. Y si no
 * tiene cartera —un cajero, un administrador que no es comercial— no ve ninguna
 * comisión, porque no tiene ninguna.
 */
async function alcance(req, res) {
  const administra = await tienePermiso(req.user.id, 'commissions', 'approve')
  if (administra) return { comercialId: null, administra: true }
  const c = await comercialDe(req.user.id)
  if (!c) {
    res.status(403).json({
      error: 'No tienes una cartera comercial: no hay comisiones que ver.',
      codigo: 'SIN_CARTERA',
    })
    return null
  }
  return { comercialId: c.id, administra: false }
}

// ── EL LISTADO ─────────────────────────────────────────────────────────────
rutas.get('/comisiones', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  const comercialId = req.query.comercial_id && a.administra
    ? id(req.query.comercial_id)
    : a.comercialId
  const filas = await listar({
    comercialId: comercialId ?? undefined,
    anio: req.query.anio ? String(req.query.anio) : undefined,
    estado: req.query.estado ? String(req.query.estado) : undefined,
  })
  res.json({ comisiones: filas })
})

// ── EL RESUMEN DE UN MES, POR COMERCIAL ─────────────────────────────────────
//
// El resumen que el administrador revisa antes de confirmar. Trae el
// cálculo, el detalle de cobros y el detalle de pedidos: todo lo que hace
// falta para mirar las cifras y decidir.
//
rutas.get('/comisiones/resumen/:periodo', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  const periodo = String(req.params.periodo || '')
  const { desde, hasta } = rangoDelPeriodo(periodo)
  const guardadas = await listar({ comercialId: a.comercialId ?? undefined })
  const delMes = guardadas.filter((c) => c.periodo === periodo)

  // El comercial solo pide el suyo. El que administra pide el que le digan.
  const pedidos = a.administra && req.query.comercial_id
    ? [id(req.query.comercial_id)]
    : (a.comercialId ? [a.comercialId] : delMes.map((c) => c.comercial_id))

  const resúmenes = []
  for (const cid of pedidos) {
    const calc = await calcular(cid, periodo)
    const guardada = delMes.find((c) => c.comercial_id === cid) || null
    resúmenes.push({
      comercial_id: cid,
      comercial_nombre: guardada?.comercial_nombre
        || (await one('SELECT u.full_name FROM com_perfiles cp JOIN users u ON u.id = cp.user_id WHERE cp.id = $1', [cid]))?.full_name
        || `Comercial ${cid}`,
      periodo,
      calculo: calc,
      comision: guardada,
    })
  }
  res.json({
    periodo,
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
    resumenes,
  })
})

// ── LO MÍO ─────────────────────────────────────────────────────────────────
//
// La pantalla del comercial: su estimación provisional mientras el mes está
// abierto, y su comisión confirmada cuando ya la hay.
//
rutas.get('/comisiones/mi/:periodo', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  if (!a.comercialId) {
    return res.status(403).json({
      error: 'No tienes una cartera comercial.', codigo: 'SIN_CARTERA',
    })
  }
  const periodo = String(req.params.periodo || '')
  const calc = await calcular(a.comercialId, periodo)
  const guardada = await one(
    'SELECT * FROM com_comisiones WHERE comercial_id = $1 AND periodo = $2',
    [a.comercialId, periodo],
  )
  res.json({
    comercial_id: a.comercialId,
    periodo,
    calculo: calc,
    comision: guardada,
    // Antes de confirmar, lo que hay es una estimación. Después, una
    // comisión confirmada con su estado de pago. El comercial NUNCA ve una
    // cifra provisional donde la definitiva: cada uno en su sitio.
    provisional: !guardada?.comision_confirmada,
  })
})

// ── EL DETALLE ─────────────────────────────────────────────────────────────
rutas.get('/comisiones/:id', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  const d = await detalle(id(req.params.id))
  if (!d) return res.status(404).json({ error: 'Esa comisión no existe.', codigo: 'NO_ENCONTRADO' })
  if (!a.administra && d.comision.comercial_id !== a.comercialId) {
    // No se dice «no existe», que sería dar información de más. Se dice lo
    // mismo que si no hubiera nada.
    return res.status(404).json({ error: 'Esa comisión no existe.', codigo: 'NO_ENCONTRADO' })
  }
  res.json(d)
})

// ── PREPARAR EL MES ────────────────────────────────────────────────────────
//
// El administrador pide el resumen. Se recalcula lo provisional. Lo ya
// confirmado no se toca: por eso es idempotente.
//
rutas.post('/comisiones/preparar', auth, CONFIRMAR, dominio(async (req, res) => {
  const periodo = String(req.body?.periodo || periodoDe(new Date()))
  const r = await prepararMes(periodo, req.user.id)
  res.json(r)
}))

// ── CONFIRMAR ──────────────────────────────────────────────────────────────
rutas.post('/comisiones/:id/confirmar', auth, CONFIRMAR, dominio(async (req, res) => {
  const c = await confirmarComision(id(req.params.id), req.user.id, req.body?.nota)
  res.json({ comision: c })
}))

// ── REGISTRAR EL PAGO ──────────────────────────────────────────────────────
rutas.post('/comisiones/:id/pagar', auth, PAGAR, dominio(async (req, res) => {
  const r = await registrarPago(id(req.params.id), {
    importe: req.body?.importe,
    fecha: req.body?.fecha,
    referencia: req.body?.referencia,
    nota: req.body?.nota,
  }, req.user.id)
  res.json(r)
}))

// ── LOS PORCENTAJES ────────────────────────────────────────────────────────
rutas.get('/comisiones/porcentajes', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  if (!a.administra) {
    // El comercial solo ve el suyo, y su historial. No los de los demás.
    const p = await porcentajeVigente(a.comercialId)
    res.json({ porcentajes: p ? [p] : [] })
    return
  }
  const filas = await query(
    `SELECT p.*, cp.user_id, u.full_name AS comercial_nombre
       FROM com_comision_porcentajes p
       JOIN com_perfiles cp ON cp.id = p.comercial_id
       JOIN users u ON u.id = cp.user_id
      ORDER BY u.full_name, p.vigente_desde DESC`,
  )
  res.json({ porcentajes: filas })
})

rutas.get('/comisiones/porcentajes/:comercialId', auth, VER, async (req, res) => {
  const a = await alcance(req, res)
  if (!a) return
  const cid = id(req.params.comercialId)
  if (!a.administra && cid !== a.comercialId) {
    return res.status(404).json({ error: 'No existe.', codigo: 'NO_ENCONTRADO' })
  }
  res.json({ porcentajes: await historialPorcentajes(cid) })
})

rutas.post('/comisiones/porcentajes', auth, CONFIGURAR, dominio(async (req, res) => {
  const p = await ponerPorcentaje({
    comercialId: id(req.body?.comercial_id),
    porcentaje: req.body?.porcentaje,
    vigenteDesde: req.body?.vigente_desde,
    motivo: req.body?.motivo,
    usuarioId: req.user.id,
  })
  res.json({ porcentaje: p })
}))

// ── DESCARTAR UN RESUMEN ───────────────────────────────────────────────────
//
// El administrador se ha equivocado al confirmar. Se devuelve el mes a
// revisión y queda escrito quién, cuándo y por qué. No se borra nada.
//
rutas.post('/comisiones/:id/descartar', auth, CONFIRMAR, dominio(async (req, res) => {
  const c = await descartarComision(id(req.params.id), req.user.id, req.body?.motivo)
  res.json({ comision: c })
}))

export default rutas
