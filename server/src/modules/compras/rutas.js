/**
 * API de COMPRAS.
 *
 * Todo lo que se expone aquí está dentro del módulo de Compras. Lo único que
 * toca de otros sitios es `core/inventario.js`, y solo para LLAMARLO: Compras
 * no modifica ese motor ni el de stock.
 *
 * Permisos, los mismos que en el resto de la aplicación:
 *   · ver la lista y las órdenes  → `purchases:view`
 *   · crear y enviar órdenes      → `purchases:create`
 *   · ANOTAR que no se pudo       → `purchases:create`
 *   · EDITAR una orden ya enviada→ `purchases:edit`
 *   · ver la pantalla             → `purchases:view`
 *
 * Y un permiso que no es el de compras, porque recibir mercancía ES sacar
 * mercancía del almacén: `inventory:create`. Quien escribe una orden de compra
 * no puede por eso entrar en almacén, y quien entra en almacén no puede
 * Receive. Son dosryn responsibilities distintas y hacen falta las dos.
 */

import { Router } from 'express'
import { query, one } from '../../db/client.js'
import { requiereSesion, requierePermiso } from '../../security/permisos.js'
import { asincrono } from '../../http/middlewares.js'
import { auditar } from '../../core/auditoria.js'
import {
  crearOrden, listarOrdenes, obtenerOrden,
  enviarOrden, recibirOrden, anularOrden, resumenCompras,
  fichaProveedor, listarProveedores,
} from '../../core/compras.js'

const router = Router()
const auth = requiereSesion({ query, one })
const db = { query, one }

const ver = requierePermiso('purchases', 'view')
const crear = requierePermiso('purchases', 'create')
const editar = requierePermiso('purchases', 'edit')
// Recibir es también sacar del almacén: sin esto, cualquiera que pueda pedir
// PODRÍA meter mercancía sin que nadie del almacén lo haya visto pasar.
const recibir = requierePermiso('inventory', 'create')

/** GET /api/purchases — la lista de trabajo. */
router.get('/purchases', auth, ver, asincrono(async (_req, res) => {
  res.json(await listarOrdenes({}, db))
}))

/** GET /api/purchases/resumen — los números de arriba, sin traer todo. */
router.get('/purchases/resumen', auth, ver, asincrono(async (_req, res) => {
  res.json(await resumenCompras(db))
}))

/** GET /api/purchases/:id — la orden con sus líneas y de dónde salió cada lote. */
router.get('/purchases/:id', auth, ver, asincrono(async (req, res) => {
  res.json(await obtenerOrden(db, Number(req.params.id)))
}))

// ═══════════════════════════════════════════════════════════════════════════
// PROVEEDORES, VISTOS DESDE COMPRAS
//
// El maestro del proveedor —alta y edición— vive en el catálogo, que es donde
// están desde la Fase 2. Aquí solo se lee: qué nos ha traído este proveedor,
// cuánto, a qué precio y con qué caducidades. Es la misma información contada
// de otra forma, no una copia.
//
// Y por qué pide `purchases:view` y no `suppliers:view`: esta ficha NO es el
// catálogo del proveedor, es su historial de compra. Quien puede ver un
// proveedor en el catálogo no tiene por qué ver lo que le hemos pagado.
//
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/suppliers/compras — el listado con los números de cada uno. */
router.get('/suppliers/compras', auth, ver, asincrono(async (req, res) => {
  res.json(await listarProveedores(
    { soloActivos: req.query.todos !== '1' }, db))
}))

/** GET /api/suppliers/compras/:id — la ficha entera. */
router.get('/suppliers/compras/:id', auth, ver, asincrono(async (req, res) => {
  res.json(await fichaProveedor(Number(req.params.id), db))
}))

/** POST /api/purchases — alta en borrador. NO toca el almacén. */
router.post('/purchases', auth, crear, asincrono(async (req, res) => {
  const orden = await crearOrden({ ...req.body, userId: req.user.id })
  res.status(201).json(orden)
}))

/** PUT /api/purchases/:id — cambiar las líneas, SOLO en borrador. */
router.put('/purchases/:id', auth, editar, asincrono(async (req, res) => {
  const id = Number(req.params.id)
  const actual = await obtenerOrden(db, id)
  if (actual.status !== 'DRAFT') {
    return res.status(409).json({
      error: `La orden ${actual.code} ya no está en borrador. `
        + 'Si el proveedor cambió algo, anúlala y crea otra: reescribir una orden '
        + 'enviada rompe lo que el proveedor cree que aceptó.',
      codigo: 'ORDEN_NO_EDITABLE',
    })
  }
  // Rehacer la orden desde cero es más simple y más seguro que parchear líneas
  // sueltas: el código, los totales y la auditoría se rehacen enteros.
  const nueva = await crearOrden({
    supplierId: req.body.supplierId ?? actual.supplier_id,
    expectedDate: req.body.expectedDate ?? actual.expected_date,
    notes: req.body.notes ?? actual.notes,
    lineas: req.body.lineas || actual.lineas.map((l) => ({
      itemId: l.item_id, qtyOrdered: l.qty_ordered, unitCost: l.unit_cost,
      supplierLotCode: l.supplier_lot_code, expiryDate: l.expiry_date, notes: l.notes,
    })),
    userId: req.user.id,
  })
  await auditar(db, {
    usuarioId: req.user.id, accion: 'UPDATE', entidad: 'purchase_orders', entidadId: id,
    antes: { code: actual.code }, despues: { replacedBy: nueva.code },
  })
  res.json(nueva)
}))

/** POST /api/purchases/:id/enviar — borrador → pedida. Compromiso con el proveedor. */
router.post('/purchases/:id/enviar', auth, crear, asincrono(async (req, res) => {
  res.json(await enviarOrden(Number(req.params.id), {
    userId: req.user.id,
    expectedDate: req.body?.expectedDate || null,
  }))
}))

/**
 * POST /api/purchases/:id/recibir — AQUÍ ENTRA LA MERCANCÍA.
 *
 * Llama al motor de entradas del almacén. No hay un camino de stock paralelo:
 * la mercancía de una compra entra por la misma puerta que una apertura o un
 * ajuste, y por eso hereda la trazabilidad por lotes sin inventar nada.
 */
router.post('/purchases/:id/recibir', auth, recibir, asincrono(async (req, res) => {
  res.status(201).json(await recibirOrden(Number(req.params.id), {
    lineas: req.body?.lineas || [],
    invoiceRef: req.body?.invoiceRef || null,
    notes: req.body?.notes || null,
    token: req.body?.token || null,
    userId: req.user.id,
  }))
}))

/** POST /api/purchases/:id/anular — y solo si no ha entrado nada. */
router.post('/purchases/:id/anular', auth, crear, asincrono(async (req, res) => {
  res.json(await anularOrden(Number(req.params.id), {
    motivo: req.body?.motivo, userId: req.user.id,
  }))
}))

export default router
