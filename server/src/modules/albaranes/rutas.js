/**
 * API de albaranes.
 *
 * Los cuatro hechos del albarán son endpoints separados a propósito:
 *
 *   POST /api/albaranes                  → crear
 *   POST /api/albaranes/:id/imprimir     → imprimir  (NO entrega)
 *   POST /api/albaranes/:id/firmar       → firma del cliente (guarda la imagen)
 *   POST /api/albaranes/:id/entregar     → entrega   (exige firma previa)
 *
 * Que estén separados en cuatro llamadas, y no en una con un campo «estado»,
 * es lo que impide que imprimir por error marque el pedido como entregado.
 * Además, aunque alguien saltara esta capa, la base de datos lo rechaza: el
 * orden crear→imprimir→firmar→entregar está en CHECKs de la migración 010.
 */

import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso } from '../../security/permisos.js'
import { query, one, exec } from '../../db/client.js'

// El servicio trabaja contra una transacción y usa tres métodos. La capa de
// rutas le pasa el mismo envoltorio, para que dentro y fuera se hable igual.
const db = { query, one, exec }
import {
  crearAlbaran, imprimirAlbaran, firmarAlbaran, anotarPapelDevuelto,
  anularAlbaran, detalleAlbaran, listarAlbaranes,
} from '../../core/albaranes.js'
import { empresa as leerEmpresa } from '../../core/config.js'

const router = Router()
const auth = requiereSesion({ query, one })
const ver = requierePermiso('sales', 'view')
const crear = requierePermiso('sales', 'create')
const entregar = requierePermiso('deliveries', 'create')
const hacerEntregasAlbaran = requierePermiso('deliveries', 'create')

/** GET /api/albaranes */
router.get('/albaranes', auth, ver, asincrono(async (req, res) => {
  const filas = await listarAlbaranes(db, {
    salesOrderId: req.query.pedido ? Number(req.query.pedido) : null,
    status: req.query.estado || null,
  })
  res.json(filas)
}))

/** GET /api/albaranes/:id — el documento tal como se imprime */
router.get('/albaranes/:id', auth, ver, asincrono(async (req, res) => {
  res.json(await detalleAlbaran(db, Number(req.params.id)))
}))

/** GET /api/albaranes/:id/firma — la imagen de la firma, tal cual */
router.get('/albaranes/:id/firma', auth, ver, asincrono(async (req, res) => {
  const f = await one(
    `SELECT content_type, image FROM delivery_signatures WHERE albaran_id = $1`,
    [Number(req.params.id)],
  )
  if (!f) return res.status(404).json({ error: 'Este albarán todavía no está firmado' })
  res.set('Content-Type', f.content_type)
  res.set('Cache-Control', 'private, max-age=31536000, immutable')
  res.send(Buffer.from(f.image))
}))

/** POST /api/albaranes */
router.post('/albaranes', auth, crear, asincrono(async (req, res) => {
  const { pedidoId, deliveryId, copias, recipientName, observations, lineas } = req.body || {}
  if (!pedidoId) return res.status(400).json({ error: 'Falta el pedido del albarán' })
  res.status(201).json(await crearAlbaran(db, {
    salesOrderId: Number(pedidoId),
    deliveryId: deliveryId ? Number(deliveryId) : null,
    copies: copias ? Number(copias) : 2,
    recipientName: recipientName || null,
    observations: observations || null,
    // Lo que lleva este viaje. Si no se dice, se lleva todo lo servible.
    lineas: Array.isArray(lineas) && lineas.length ? lineas : null,
    userId: req.user.id,
  }))
}))

/**
 * POST /api/albaranes/:id/imprimir
 * Deja constancia de las copias. No toca el stock ni el estado del pedido: en el
 * almacén se imprime un albarán mucho antes de que nadie lo firme.
 */
router.post('/albaranes/:id/imprimir', auth, crear, asincrono(async (req, res) => {
  res.json(await imprimirAlbaran(db, {
    albaranId: Number(req.params.id),
    copies: req.body?.copias ? Number(req.body.copias) : null,
    userId: req.user.id,
  }))
}))

/**
 * POST /api/albaranes/:id/firmar
 * Recibe la firma como JSON { pngBase64 } para no arrastrar multipart por la
 * API. La imagen se guarda como binario en PostgreSQL, con su hash.
 */
router.post('/albaranes/:id/firmar', auth, entregar, asincrono(async (req, res) => {
  const { firmaBase64, signerName, width, height, contentType } = req.body || {}
  if (!firmaBase64) return res.status(400).json({ error: 'Falta la firma del cliente' })
  let image
  try {
    image = Buffer.from(String(firmaBase64).replace(/^data:[^;]+;base64,/, ''), 'base64')
  } catch {
    return res.status(400).json({ error: 'La firma no se ha podido leer' })
  }
  res.json(await firmarAlbaran(db, {
    albaranId: Number(req.params.id),
    signerName: signerName || null,
    image,
    contentType: contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    userId: req.user.id,
  }))
}))

/**
 * POST /api/albaranes/:id/entregar — RETIRADO
 *
 * EL ALBARÁN NO CONFIRMA LA ENTREGA.
 *
 * El albarán es el papel que acompaña la mercancía, donde el cliente firma y se
 * lo queda. El reparto funciona así: el repartidor se lleva el pedido y el
 * papel, el cliente firma EN PAPEL, y después el repartidor escanea la TARJETA
 * y pulsa «Entregar». El sistema registra la entrega en ese momento.
 *
 * Atar el cierre al documento obligaba al repartidor a abrir el pedido en el
 * móvil delante de la puerta, con el cliente esperando, para subir un dibujo
 * que ya estaba en papel. Y dejaba dos caminos distintos para confirmar la
 * misma entrega, que es justo lo que provoca que se descuadren.
 *
 * Ahora la entrega se confirma en:
 *
 *     POST /api/reparto/:pedidoId/entregar     (tarjeta QR)
 *
 * Se responde 409 en vez de borrar la ruta, para que un cliente antiguo reciba
 * una explicación y no un 404 a secas.
 */
router.post('/albaranes/:id/entregar', auth, hacerEntregasAlbaran, asincrono(async (req, res) => {
  const a = await db.one('SELECT code FROM albaranes WHERE id = $1', [Number(req.params.id)])
  res.status(409).json({
    error: `El albarán ${a?.code || ''} es un documento de papel: el cliente lo firma y se lo `
      + 'queda. La entrega se registra con la TARJETA del cliente: escanéala, elige el '
      + 'pedido y pulsa «Entregar».',
    codigo: 'ENTREGAR_POR_TARJETA',
  })
}))

/** POST /api/albaranes/:id/anular */
router.post('/albaranes/:id/anular', auth, crear, asincrono(async (req, res) => {
  res.json(await anularAlbaran(db, {
    albaranId: Number(req.params.id),
    motivo: req.body?.motivo,
    userId: req.user.id,
  }))
}))

/**
 * GET /api/config/empresa
 * Los datos de la empresa, para cualquier documento que los necesite.
 * No hay que pedirlos como parámetro de la URL: el cliente los lee una vez.
 */
router.get('/config/empresa', auth, asincrono(async (req, res) => {
  res.json(await leerEmpresa(db))
}))

export default router
