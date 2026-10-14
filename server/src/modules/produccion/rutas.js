/**
 * API de recetas y producción.
 *
 * Permisos:
 *   recetas     → ver / crear / editar (producción y compras lo necesitan)
 *   production  → ver / crear / editar (y es quien lanza una fabricación)
 *
 * `recipes:view` NO es un permiso: las recetas sonSecretas de fabricación, y
 * cualquiera que haga una orden de producción las va a ver igual. Se usa
 * `recipes:view`, que es lo que dice la matriz de roles.
 */

import { Router } from 'express'
import { idempotente } from '../../http/idempotencia.js'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso, requiereAlguno } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import {
  obtenerReceta, calcularNecesidades, planificarNecesidades,
  validarReceta, recetaActivaDe,
} from '../../core/recetas.js'
import {
  producir, planificarProduccion, listarProducciones, detalleProduccion,
  planificarFabricacion, editarPlan, comprobarPlan, listarOrdenesPendientes, confirmarPlan,
} from '../../core/produccion.js'

const router = Router()
const auth = requiereSesion({ query, one })
const verRecetas = requiereAlguno(['recipes', 'production'], 'view', 'ver recetas')
const editarRecetas = requiereAlguno(['recipes', 'production'], 'edit', 'editar recetas')
const lanzarProduccion = requiereAlguno(['production'], 'create', 'lanzar producción')

// ─── Recetas ────────────────────────────────────────────────────────────────

/** GET /api/recipes */
router.get('/recipes', auth, verRecetas, asincrono(async (req, res) => {
  const recetas = await query(
    `SELECT r.*, p.name AS product_name, p.sku, p.format_label,
            (SELECT COUNT(*) FROM recipe_lines l WHERE l.recipe_id = r.id) AS n_lineas
       FROM recipes r JOIN items p ON p.id = r.product_id
      WHERE ($1::int IS NULL OR r.product_id = $1)
      ORDER BY p.name, r.version DESC`,
    [req.query.producto ? Number(req.query.producto) : null],
  )
  res.json(recetas)
}))

/** GET /api/recipes/:id */
router.get('/recipes/:id', auth, verRecetas, asincrono(async (req, res) => {
  res.json(await obtenerReceta(req.params.id))
}))

/** POST /api/recipes — crear receta con sus líneas, en una transacción */
router.post('/recipes', auth, editarRecetas, asincrono(async (req, res) => {
  const b = req.body || {}
  if (!b.product_id) return res.status(400).json({ error: 'Falta el producto de la receta', codigo: 'CAMPO_FALTANTE' })
  if (!Number.isFinite(Number(b.base_qty)) || Number(b.base_qty) <= 0) {
    return res.status(400).json({ error: 'La cantidad base debe ser mayor que cero', codigo: 'BASE_INVALIDA' })
  }
  const lineas = Array.isArray(b.lineas) ? b.lineas : []
  if (!lineas.length) {
    return res.status(400).json({ error: 'La receta necesita al menos un ingrediente', codigo: 'RECETA_VACIA' })
  }

  const servicio = await import('../../core/recetas-servicio.js')
  const receta = await servicio.crearReceta({
    productId: Number(b.product_id),
    code: b.code || null,
    name: b.name || null,
    // La versión se calcula sola si no se indica: pedirla a mano es pedir un conflicto.
    version: b.version ?? null,
    baseQty: Number(b.base_qty),
    baseUnitId: b.base_unit_id ? Number(b.base_unit_id) : null,
    instructions: b.instructions || null,
    lineas: lineas.map((l) => ({
      itemId: Number(l.item_id),
      qtyPerBatch: Number(l.qty_per_batch),
      unitId: l.unit_id ? Number(l.unit_id) : null,
      tolerance: l.tolerance !== undefined ? Number(l.tolerance) : 0,
      isCritical: l.is_critical !== false,
      notes: l.notes || null,
    })),
    usuarioId: req.user.id,
  })
  res.status(201).json(receta)
}))

/** PUT /api/recipes/:id — desactivar la anterior y crear una versión nueva */
router.put('/recipes/:id', auth, editarRecetas, asincrono(async (req, res) => {
  const b = req.body || {}
  const servicio = await import('../../core/recetas-servicio.js')
  const receta = await servicio.nuevaVersion(Number(req.params.id), {
    baseQty: b.base_qty !== undefined ? Number(b.base_qty) : null,
    instructions: b.instructions ?? null,
    lineas: Array.isArray(b.lineas) ? b.lineas.map((l) => ({
      itemId: Number(l.item_id),
      qtyPerBatch: Number(l.qty_per_batch),
      unitId: l.unit_id ? Number(l.unit_id) : null,
      tolerance: l.tolerance !== undefined ? Number(l.tolerance) : 0,
      isCritical: l.is_critical !== false,
      notes: l.notes || null,
    })) : null,
    usuarioId: req.user.id,
  })
  res.json(receta)
}))

/** GET /api/recipes/:id/necesidades?cantidad= */
router.get('/recipes/:id/necesidades', auth, verRecetas, asincrono(async (req, res) => {
  const cantidad = Number(req.query.cantidad)
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: 'Falta la cantidad', codigo: 'CANTIDAD_INVALIDA' })
  }
  res.json(await planificarNecesidades(req.params.id, cantidad))
}))

// ─── Producción ─────────────────────────────────────────────────────────────

/** GET /api/productions */
router.get('/productions', auth, requierePermiso('production', 'view'), asincrono(async (req, res) => {
  res.json(await listarProducciones({ estado: req.query.estado || null, limite: Number(req.query.limite) || 50 }))
}))

/**
 * ÓRDENES PENDIENTES · GET /api/productions/pendientes
 *
 * Lo que Producción tiene que fabricar HOY. Es una lista de trabajo, no un
 * histórico: una orden confirmada no sale aquí, sale en `/api/productions`.
 */
router.get('/productions/pendientes', auth, requiereAlguno(['production', 'recipes'], 'view', 'ver órdenes de fabricación'), asincrono(async (req, res) => {
  res.json(await listarOrdenesPendientes({ limite: Number(req.query.limite) || 100 }))
}))

/**
 * PLANIFICAR · POST /api/productions/plan
 *
 * Crea una orden pendiente. NO consume material ni toca el stock: eso pasa al
 * confirmar, que es cuando la mercancía sale de fábrica.
 */
router.post('/productions/plan', auth, idempotente('produccion'), requierePermiso('recipes', 'edit'), asincrono(async (req, res) => {
  const { recipeId, cantidad, notas, orderId, plannedAt } = req.body || {}
  res.status(201).json(await planificarFabricacion({
    recipeId: Number(recipeId), cantidad: Number(cantidad),
    notas: notas || null, orderId: orderId ? Number(orderId) : null,
    plannedAt: plannedAt || null, usuarioId: req.user.id,
  }))
}))

/**
 * COMPROBAR · GET /api/productions/:id/plan
 *
 * Qué material hace falta y qué hay. No escribe nada, así que se puede llamar
 * para avisar de que faltan 5 L sin tocar la orden.
 */
router.get('/productions/:id/plan', auth, requiereAlguno(['production', 'recipes'], 'view', 'comprobar plan'), asincrono(async (req, res) => {
  res.json(await comprobarPlan(Number(req.params.id)))
}))

/** EDITAR la cantidad, solo mientras siga pendiente. */
router.put('/productions/:id/plan', auth, requierePermiso('recipes', 'edit'), asincrono(async (req, res) => {
  res.json(await editarPlan(Number(req.params.id), req.body || {}, req.user.id))
}))

/**
 * CONFIRMAR · POST /api/productions/:id/confirmar
 *
 * Aquí SÍ se consume el material y sale el lote de producto terminado. La
 * orden desaparece de la lista de pendientes y queda en las realizadas.
 */
router.post('/productions/:id/confirmar', auth, requierePermiso('production', 'create'), asincrono(async (req, res) => {
  res.json(await confirmarPlan(Number(req.params.id), {
    usuarioId: req.user.id, caducidad: req.body?.caducidad || null,
    notas: req.body?.notas || null, machineId: req.body?.machineId || null,
  }))
}))

/** GET /api/productions/:id */
router.get('/productions/:id', auth, requierePermiso('production', 'view'), asincrono(async (req, res) => {
  const p = await detalleProduccion(req.params.id)
  if (!p) return res.status(404).json({ error: 'Producción no encontrada', codigo: 'NO_ENCONTRADO' })
  res.json(p)
}))

/** POST /api/productions/planificar — simulación, no toca nada */
router.post('/productions/planificar', auth, requierePermiso('production', 'view'), asincrono(async (req, res) => {
  const b = req.body || {}
  res.json(await planificarProduccion({
    recipeId: Number(b.recipeId ?? b.recipe_id),
    cantidad: Number(b.cantidad),
    caducidad: b.caducidad || null,
  }))
}))

/** POST /api/productions — lanzar la fabricación */
router.post('/productions', auth, lanzarProduccion, asincrono(async (req, res) => {
  const b = req.body || {}
  const r = await producir({
    recipeId: Number(b.recipeId ?? b.recipe_id),
    cantidad: Number(b.cantidad),
    caducidad: b.caducidad || null,
    codigoLote: b.codigoLote || b.codigo_lote || null,
    machineId: b.machineId ? Number(b.machineId) : null,
    notas: b.notas || null,
    usuarioId: req.user.id,
  })
  res.status(201).json({
    ok: true,
    produccion: r.produccion,
    lote: r.lote,
    consumos: r.consumos,
    mensaje: `Producción ${r.codigo}: lote ${r.lote.code} con ${r.lote.qty_available} unidades. ` +
      `Se consumieron ${r.consumos.length} lote(s) de materia prima.`,
  })
}))

/** GET /api/products/:id/receta — la receta activa de un producto */
router.get('/products/:id/receta', auth, verRecetas, asincrono(async (req, res) => {
  const receta = await recetaActivaDe(Number(req.params.id))
  if (!receta) return res.json(null)
  res.json(await obtenerReceta(receta.id))
}))

export default router
