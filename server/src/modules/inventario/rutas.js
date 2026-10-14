/**
 * API de inventario: entradas, ajustes, reservas, estados de lote y consultas.
 *
 * El permiso se aplica en el BACKEND, ruta por ruta. Ocultar un botón es
 * cortesía; esto es la garantía. Un repartidor que escriba a mano la URL de una
 * entrada se encuentra con un 403, no con un 201.
 *
 * ORDEN DE MONTAJE: las rutas estáticas (/inventory/resumen, /inventory/
 * reservas, /inventory/movimientos) van ANTES de las parametrizadas
 * (/inventory/:itemId). En Express gana la primera que coincide, y si se
 * invirtieran, /inventory/reservas se interpretaría como "el artículo
 * llamado reservas" y devolvería 404.
 */

import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso, requiereAlguno } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import {
  registrarEntrada, registrarEntradasMasivas, ajustarInventario,
  reservar, liberarReserva, reservarInterno, cambiarEstadoLote,
  existenciasDe, listarExistencias, lotesDe, movimientos, planificar, resumenInventario,
} from '../../core/inventario.js'
import {
  FORMATOS, formatoValido, datosDeEntrada, imagenQr, resolverQr, registrarImpresion,
  impresionesDe, rotarToken, trazabilidad, listarEntradas,
} from '../../core/etiquetas.js'
import { htmlEtiqueta, catalogoFormatos } from '../../core/etiqueta-html.js'
import { idempotente } from '../../http/idempotencia.js'

const router = Router()
const auth = requiereSesion({ query, one })
// `/inventory` la abre quien tenga inventario… Y quien tenga LOTES.
//
// La razón es una y concreta: el rol de reparto y el de caja tienen
// `lots:view` y NO `inventory:view`. La pantalla de Lotes les sale en el menú
// —porque para eso lo tienen— y al abrirla, la ruta que la alimenta pedía
// `inventory:view` y contestaba 403. El permiso estaba bien; la ruta no lo
// aceptaba. Es el mismo fallo que se corrigió en el catálogo, y por la misma
// razón: una pantalla cuyo permiso de menú no es el permiso de su ruta.
const verInventario = requiereAlguno(['inventory', 'lots'], 'view', 'ver el inventario')

//
// El libro de movimientos también lo abre `lots:view`.
//
// Por qué, sin abrir de más: `stock_movements` NO tiene ninguna columna de
// precio ni de coste —son cantidades, lote, artículo, unidad y quién lo hizo—.
// Es decir, la información que sale de aquí es la del LOTE, no la del almacén en
// su valor contable. Los números que sí son financieros viven en otros sitios,
// y esos siguen cerrados a `inventory:view`: `/inventory` (valorización),
// `/inventory/resumen` y `/inventory/ajustes`.
//
// Sin esto, el rol de reparto —que tiene `lots:view` a propósito, para ver qué
// carga en el camión— veía la pantalla de Lotes en el menú y al abrirla
// reventaba con un 403.
//
// Fail-closed: sigue haciendo falta UNO de los dos. Quien no tenga ninguno de
// los dos sigue sin ver nada.
const verMovimientos = requiereAlguno(['inventory', 'lots'], 'view', 'ver los movimientos')
const editarInventario = requierePermiso('inventory', 'edit')
// La trazabilidad la necesita quien controla lotes (un retiro) y quien
// garantiza el producto (producción y trazabilidad).
const verTrazabilidad = requiereAlguno(
  ['lots', 'traceability', 'production', 'recalls'], 'view', 'ver trazabilidad')

/**
 * Recibir mercancía NO es crear la ficha del artículo.
 *
 * Dar de alta un material en el catálogo es un acto de ingeniería (decidir qué
 * existe, con qué ficha, a qué precio). Recibir 500 litros de ese material es un
 * acto de almacén. Meterlos en el mismo permiso obligaba a que o el almacén no
 * pudiera recibir, o que cualquiera con permiso de catálogo pudiera inventarse
 * receipts que nadie vio.
 *
 * Por eso la entrada exige `inventory:create`, y la ficha exige el permiso del
 * módulo que le toca: raw_materials, packaging o products.
 */
const permisoRecepcion = requierePermiso('inventory', 'create')

// ─── Consultas estáticas (antes de las parametrizadas) ───────────────────────

/** GET /api/inventory — existencias de todo el catálogo */
router.get('/inventory', auth, verInventario, asincrono(async (req, res) => {
  res.json(await listarExistencias({
    tipo: req.query.tipo || null,
    soloBajoMinimo: req.query.bajoMinimo === 'true',
    buscar: req.query.buscar || null,
  }))
}))

/** GET /api/inventory/resumen — el panel */
router.get('/inventory/resumen', auth, verInventario, asincrono(async (_req, res) => {
  res.json(await resumenInventario())
}))

/** GET /api/inventory/reservas */
router.get('/inventory/reservas', auth, verInventario, asincrono(async (req, res) => {
  res.json(await query(
    `SELECT r.*, i.sku, i.name AS item_name, u.symbol AS unit_symbol, so.code AS order_code,
            (r.sales_order_id IS NULL) AS es_retencion_interna
       FROM order_reservations r
       JOIN items i ON i.id = r.item_id
       JOIN units u ON u.id = r.unit_id
       LEFT JOIN sales_orders so ON so.id = r.sales_order_id
      WHERE ($1::text IS NULL OR r.status::text = $1)
        AND ($2::boolean IS FALSE
             OR r.status IN ('ACTIVE','ASSIGNED'))
      ORDER BY r.id DESC LIMIT 200`,
    [req.query.estado || null, req.query.vivas === '1'],
  ))
}))

/** GET /api/inventory/movimientos — el libro mayor, filtrable */
router.get('/inventory/movimientos', auth, verMovimientos, asincrono(async (req, res) => {
  res.json(await movimientos({
    loteId: req.query.loteId || null,
    itemId: req.query.itemId || null,
    tipo: req.query.tipo || null,
    limite: Math.min(Number(req.query.limite) || 100, 500),
  }))
}))

// ─── Entradas ────────────────────────────────────────────────────────────────

/** Carga el artículo que se va a mover. Antes de tocar nada. */
const cargarItem = asincrono(async (req, res, next) => {
  const itemId = req.body?.itemId
  if (!itemId) {
    return res.status(400).json({ error: 'Falta itemId', codigo: 'CAMPO_FALTANTE' })
  }
  const item = await one('SELECT * FROM items WHERE id = $1', [itemId])
  if (!item) return res.status(404).json({ error: 'Artículo no encontrado', codigo: 'NO_ENCONTRADO' })
  if (item.is_active === false) {
    return res.status(409).json({
      error: `${item.name} está archivado. Reactívalo antes de mover stock.`,
      codigo: 'ARTICULO_ARCHIVADO',
    })
  }
  req.item = item
  next()
})

/** POST /api/inventory/recepciones */
router.post('/inventory/recepciones', auth, idempotente('entrada-materiales'), cargarItem, permisoRecepcion, asincrono(async (req, res) => {
  const r = await registrarEntrada({ ...req.body, usuarioId: req.user.id })
  res.status(201).json({
    ok: true,
    lote: r.lote,
    stock: r.stock,
    mensaje: `Entrada registrada: ${r.lote.code}. Disponibles ahora ${r.stock.qty_available}.`,
  })
}))

/**
 * Un albarán puede traer varios artículos de distintos módulos, así que el
 * permiso se comprueba contra TODOS ellos, no solo contra el primero. Si el
 * usuario puede dar de alta materias primas pero no productos, un albarán con
 * ambos se rechaza entero.
 */
const cargarAlbaran = asincrono(async (req, res, next) => {
  const lineas = req.body?.lineas
  if (!Array.isArray(lineas) || !lineas.length) {
    return res.status(400).json({
      error: 'Se esperaba { lineas: [...] } con al menos una entrada',
      codigo: 'ENTRADA_VACIA',
    })
  }
  if (lineas.length > 200) {
    return res.status(400).json({ error: 'Máximo 200 líneas por albarán', codigo: 'DEMASIADAS_LINEAS' })
  }
  const sinItem = lineas.findIndex((l) => !l?.itemId)
  if (sinItem >= 0) {
    return res.status(400).json({ error: `La línea ${sinItem + 1} no indica el artículo`, codigo: 'CAMPO_FALTANTE' })
  }
  const ids = [...new Set(lineas.map((l) => l.itemId))]
  const items = await query('SELECT id, category_kind, is_active FROM items WHERE id = ANY($1::int[])', [ids])
  const porId = new Map(items.map((i) => [i.id, i]))
  const desconocidos = ids.filter((id) => !porId.has(id))
  if (desconocidos.length) {
    return res.status(404).json({
      error: `Artículo no encontrado: ${desconocidos.join(', ')}`,
      codigo: 'NO_ENCONTRADO',
    })
  }
  const archivados = items.filter((i) => !i.is_active)
  if (archivados.length) {
    return res.status(409).json({
      error: `${archivados.length} artículo(s) del albarán están archivados`,
      codigo: 'ARTICULO_ARCHIVADO',
    })
  }
  req.lineas = lineas.map((l) => ({ ...l, category_kind: porId.get(l.itemId).category_kind }))
  next()
})

/** POST /api/inventory/recepciones/masivas — un albarán con varias líneas */
router.post('/inventory/recepciones/masivas', auth, idempotente('entrada-materiales-masiva'), cargarAlbaran, permisoRecepcion, asincrono(async (req, res) => {
  const lineas = req.lineas
  const lotes = await registrarEntradasMasivas(lineas, req.user.id, {
    numeroAlbaran: req.body?.numeroAlbaran || null,
    proveedorId: req.body?.proveedorId || null,
  })
  res.status(201).json({
    ok: true, lotes,
    mensaje: `${lotes.length} línea(s) del albarán registradas en una sola transacción.`,
  })
}))

// ─── Ajustes ─────────────────────────────────────────────────────────────────

/** POST /api/inventory/ajustes */
router.post('/inventory/ajustes', auth, idempotente('ajuste-inventario'), editarInventario, asincrono(async (req, res) => {
  const b = req.body || {}
  const r = await ajustarInventario({
    itemId: b.itemId ?? null,
    loteId: b.loteId ?? null,
    cantidad: b.cantidad,
    motivo: b.motivo,
    usuarioId: req.user.id,
  })
  res.json({
    ...r,
    mensaje: `${r.valorAnterior} ${r.cantidad > 0 ? '+' : ''}${r.cantidad} = ${r.valorNuevo}` +
      (r.movimientos.length > 1 ? ` (repartido en ${r.movimientos.length} lotes)` : ''),
  })
}))

// ─── Reservas ────────────────────────────────────────────────────────────────

/** POST /api/inventory/reservas */
router.post('/inventory/reservas', auth, idempotente('reserva'), editarInventario, asincrono(async (req, res) => {
  const b = req.body || {}
  let r
  if (b.orderId && b.orderLineId) {
    r = await reservar({
      orderId: b.orderId, orderLineId: b.orderLineId, itemId: b.itemId,
      cantidad: b.cantidad, usuarioId: req.user.id,
    })
  } else if (b.itemId) {
    r = await reservarInterno({
      itemId: b.itemId, cantidad: b.cantidad, motivo: b.motivo,
      holdType: b.holdType || 'OTHER', usuarioId: req.user.id,
    })
  } else {
    return res.status(400).json({ error: 'Falta itemId', codigo: 'CAMPO_FALTANTE' })
  }
  res.status(201).json({
    ok: true, reserva: r.reserva, stock: r.stock,
    mensaje: `Reservados ${b.cantidad}. Disponibles ahora ${r.stock.qty_available}. El stock físico no ha cambiado.`,
  })
}))

/** POST /api/inventory/reservas/:id/liberar */
router.post('/inventory/reservas/:id/liberar', auth, editarInventario, asincrono(async (req, res) => {
  const r = await liberarReserva({ reservaId: req.params.id, motivo: req.body?.motivo, usuarioId: req.user.id })
  res.json({ ...r, mensaje: `Reserva liberada: ${r.liberada} vuelven a estar disponibles.` })
}))

// ─── Consultas parametrizadas ────────────────────────────────────────────────

/** GET /api/inventory/:itemId — existencias de un artículo */
// ═══════════════════════════════════════════════════════════════════════════
// ETIQUETAS ADHESIVAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Recepción e impresión son DOS permisos distintos, y no por purismo:
//
// · Registrar una entrada mete dinero y cantidad en el almacén. Es de quien
//   responde de que el material está ahí.
// · Imprimir una pegata no mueve una sola unidad. Es de quien tiene la
//   impresora delante.
//
// Aun así, se pide `inventory:create` para imprimir: quien puede recibir, puede
// etiquetar. El caso contrario —poder imprimir sin poder recibir— no aporta nada
// y abre la puerta a gastar rollos por todo el almacén.
//
// Y lo que NO hace ninguna de estas rutas: tocar stock, costes o movimientos.
// `/imprimir` solo escribe en `lot_etiquetas`, que es una bitácora.

/** La etiqueta imprimible en HTML, medida en milímetros. */
router.get('/inventory/lotes/:id/etiqueta', auth, permisoRecepcion, asincrono(async (req, res) => {
  const fmt = formatoValido(req.query.formato) || '60x40'
  const datos = await datosDeEntrada(req.params.id)
  if (!datos) return res.status(404).json({ error: 'Esa entrada no existe.', codigo: 'NO_ENCONTRADO' })
  const copias = req.query.copias ? Math.min(200, Math.max(1, Number(req.query.copias) || 1)) : 1
  res.type('html').send(htmlEtiqueta(datos, fmt,copias))
}))

/** El QR suelto, para cuando se quiere la imagen y no la pegata entera. */
router.get('/inventory/lotes/:id/qr.png', auth, verInventario, asincrono(async (req, res) => {
  const datos = await datosDeEntrada(req.params.id)
  if (!datos) return res.status(404).json({ error: 'Esa entrada no existe.', codigo: 'NO_ENCONTRADO' })
  res.type('png').send(await imagenQr(datos.token, { tamano: Number(req.query.tamano) || 300 }))
}))

/** Datos de una entrada, para la vista previa sin volver a imprimir. */
router.get('/inventory/entradas/:loteId', auth, verInventario, asincrono(async (req, res) => {
  const t = await trazabilidad(Number(req.params.loteId))
  if (!t) return res.status(404).json({ error: 'Esa entrada no existe.', codigo: 'NO_ENCONTRADO' })
  res.json(t)
}))

/** Los tres tamaños, con sus medidas. La pantalla no los inventa. */
router.get('/inventory/etiqueta/formatos', auth, verInventario, asincrono(async (req, res) => {
  res.json(catalogoFormatos())
}))

/** Dejar constancia de una impresión. NO es un efecto sobre el stock. */
router.post('/inventory/lotes/:id/etiqueta/imprimir', auth, permisoRecepcion, asincrono(async (req, res) => {
  const r = await registrarImpresion({
    loteId: req.params.id,
    formato: req.body?.formato,
    copias: req.body?.copias,
    usuarioId: req.user.id,
    reimpresion: !!req.body?.reimpresion,
  })
  res.status(201).json(r)
}))

/** Historial de impresiones de una entrada. */
router.get('/inventory/lotes/:id/etiqueta/impresiones', auth, verInventario, asincrono(async (req, res) => {
  res.json(await impresionesDe(req.params.id))
}))

/** Rotar el token: invalida las pegatas viejas SIN tocar el lote. */
router.post('/inventory/lotes/:id/etiqueta/rotar', auth, permisoRecepcion, asincrono(async (req, res) => {
  try {
    res.json(await rotarToken(req.params.id))
  } catch (e) {
    res.status(404).json({ error: e.message, codigo: e.codigo || 'NO_ENCONTRADO' })
  }
}))

/** Todas las entradas con su etiqueta, para reimprimir desde el historial. */
router.get('/inventory/entradas', auth, verInventario, asincrono(async (req, res) => {
  res.json(await listarEntradas({ limite: req.query.limite, buscar: req.query.buscar || null }))
}))

/** Resolver un QR escaneado. Devuelve el identificador, NUNCA los datos. */
router.post('/inventory/etiqueta/escanear', auth, verInventario, asincrono(async (req, res) => {
  try {
    res.json(await resolverQr(req.body?.codigo))
  } catch (e) {
    res.status(404).json({ error: e.message, codigo: e.codigo || 'QR_NO_RECONOCIDO' })
  }
}))

router.get('/inventory/:itemId', auth, verInventario, asincrono(async (req, res) => {
  const stock = await existenciasDe(req.params.itemId)
  if (!stock) return res.status(404).json({ error: 'Artículo no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(stock)
}))

/** GET /api/inventory/:itemId/plan?cantidad= — qué lotes se tocarían, sin tocarlos */
router.get('/inventory/:itemId/plan', auth, verInventario, asincrono(async (req, res) => {
  const cantidad = Number(req.query.cantidad)
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: 'Falta la cantidad a planificar', codigo: 'CANTIDAD_INVALIDA' })
  }
  res.json(await planificar(req.params.itemId, cantidad))
}))

/** GET /api/items/:itemId/lots — lotes de un artículo */
router.get('/items/:itemId/lots', auth, requierePermiso('lots', 'view'), asincrono(async (req, res) => {
  res.json(await lotesDe(req.params.itemId, { incluirAgotados: req.query.agotados !== 'false' }))
}))

// ─── Lotes ───────────────────────────────────────────────────────────────────

/** GET /api/lots/:id — ficha completa de un lote */
router.get('/lots/:id', auth, requierePermiso('lots', 'view'), asincrono(async (req, res) => {
  const lote = await one(
    `SELECT l.*, i.sku, i.name AS item_name, i.category_kind, u.code AS unit_code,
            s.code AS supplier_name, p.code AS production_code
       FROM lots l
       JOIN items i ON i.id = l.item_id
       JOIN units u ON u.id = l.unit_id
       LEFT JOIN suppliers s ON s.id = l.supplier_id
       LEFT JOIN productions p ON p.id = l.production_id
      WHERE l.id = $1`,
    [req.params.id],
  )
  if (!lote) return res.status(404).json({ error: 'Lote no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(lote)
}))

/**
 * Trazabilidad de un lote: de dónde viene.
 *
 * Un lote de producto terminado dice qué lotes concretos de materia prima se
 * consumieron, cuántos, y en qué producción. Esa fila en `production_materials`
 * es el vínculo; esta vista es solo su lectura.
 */
router.get('/trazabilidad/lote/:id/adelante', auth, verTrazabilidad, asincrono(async (req, res) => {
  res.json(await query(
    `SELECT v.* FROM v_trace_forward v
      WHERE v.finished_lot_id = $1
      ORDER BY v.source_lot_code`,
    [req.params.id],
  ))
}))

/** Trazabilidad inversa: en qué entregas ha salido este lote. */
router.get('/trazabilidad/lote/:id/atras', auth, verTrazabilidad, asincrono(async (req, res) => {
  res.json(await query(
    `SELECT v.* FROM v_trace_backward v
      WHERE v.finished_lot_id = $1 OR v.source_lot_id = $1
      ORDER BY v.delivered_at DESC`,
    [req.params.id],
  ))
}))

/** GET /api/lots/:id/movimientos — historia completa de un lote */
router.get('/lots/:id/movimientos', auth, requierePermiso('lots', 'view'), asincrono(async (req, res) => {
  const lote = await one('SELECT * FROM lots WHERE id = $1', [req.params.id])
  if (!lote) return res.status(404).json({ error: 'Lote no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json({ lote, movimientos: await movimientos({ loteId: req.params.id, limite: 500 }) })
}))

/** PUT /api/lots/:id/estado — bloquear, poner en cuarentena o retirar */
router.put('/lots/:id/estado', auth, requierePermiso('lots', 'edit'), asincrono(async (req, res) => {
  const { estado, motivo } = req.body || {}
  const r = await cambiarEstadoLote({
    loteId: req.params.id, estado, motivo, usuarioId: req.user.id,
  })
  res.json({ ...r, mensaje: `Lote en estado ${estado}.` })
}))

export default router
