/**
 * API del catálogo: artículos, categorías, unidades y proveedores.
 *
 * Un solo catálogo para materias primas, envases y productos terminados. El
 * `category_kind` es lo que los distingue, no una tabla distinta: así no puede
 * aparecer una cuarta forma de representar un artículo.
 */

import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso, requiereAlguno, requiereAlgunoDe } from '../../security/permisos.js'
import { query, one, transaction } from '../../db/client.js'
import { siguienteCodigoProveedor, asegurarSerieDeFamilia } from '../../core/codigos.js'
import { sugerirSku } from '../../core/sku.js'

const router = Router()
const auth = requiereSesion({ query, one })

/**
 * Leer el catálogo exigía solo «tener sesión». Eso es fail-OPEN: un usuario al
 * que se le hubiera quitado el último permiso seguía viendo el catálogo
 * completo, con precios de compra incluidos, por mucho que el menú le ocultara
 * los enlaces. Menú oculto es cortesía; la comprobación es la garantía.
 *
 * Basta con permiso de lectura en CUALQUIERA de los tres catálogos, o en
 * inventario: quien mira existencias tiene que poder ver qué artículos hay.
 */
//
// Y `lots`, que faltaba. Un lote no se puede enseñar sin el artículo que
// contiene: la fila dice «Desinfectante 750 ml · lote PT-DES-00007 · caduca…».
// Con `lots:view` concedido y `products:view` NO —que es justo lo que tiene el
// rol de reparto— la pantalla de Lotes aparecía en el menú y al abrirla salía
// un 403. El permiso estaba bien; la ruta no lo aceptaba.
const verCatalogos = requiereAlguno(
  ['raw_materials', 'packaging', 'products', 'inventory', 'lots'],
  'view', 'ver el catálogo')
const verCatalogo = verCatalogos

/** Módulo de permiso según el tipo de artículo: cada quien ve y toca lo suyo. */
function moduloPorTipo(kind) {
  if (kind === 'RAW_MATERIAL') return 'raw_materials'
  if (kind === 'PACKAGING') return 'packaging'
  return 'products'
}

// ─── Artículos ───────────────────────────────────────────────────────────────

/**
 * GET /api/items
 * Sin permiso de módulo, devuelve solo los artículos. Para editar, hace falta
 * el permiso del módulo correspondiente, y eso se comprueba en cada escritura.
 */
router.get('/items', auth, verCatalogo, asincrono(async (req, res) => {
  const cond = []
  const params = []
  if (req.query.tipo) { params.push(req.query.tipo); cond.push(`i.category_kind = $${params.length}`) }
  if (req.query.activos === 'false') cond.push('i.is_active = false')
  else cond.push('i.is_active = true')
  //
  // `i.category_id` y no `ic.id`.
  //
  // Este filtro llevaba `ic.id` desde que se escribió, y `ic` no es el alias de
  // nadie: la consulta usa `i` para items, `u` para units, `c` para
  // item_categories y `s` para v_item_available. PostgreSQL contestaba
  // «missing FROM-clause entry for table "ic"» —un 500— en cuanto alguien
  // llamaba a `/api/items?categoria=3`.
  //
  // Se filtra por `i.category_id` y no por `c.id` por dos razones. La primera es
  // que la columna está en la tabla que se está filtrando, y decirla ahí no
  // obliga a mirar la consulta de JOIN para saber de dónde sale. La segunda es
  // que, como el JOIN a item_categories es LEFT, meter la condición en el WHERE
  // sobre `c` la convierte de hecho en un INNER: un artículo sin categoría
  // desaparecería de la lista, no porque no coincida, sino porque el filtro
  // antes de poder mirarla.
  //
  // Nadie lo notaba porque la web no usa este filtro —carga todos los artículos
  // y separa en memoria por `category_kind`—, así que el 500 solo salía al
  // llamarlo a mano. Un endpoint roto que no se usa sigue roto.
  //
  if (req.query.categoria) { params.push(req.query.categoria); cond.push(`i.category_id = $${params.length}`) }
  if (req.query.buscar) {
    params.push(`%${req.query.buscar}%`)
    cond.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})`)
  }
  const filas = await query(
    `SELECT i.*, u.code AS unit_code, u.symbol AS unit_symbol, u.dimension,
            c.name AS category_name,
            s.qty_on_hand, s.qty_reserved, s.qty_available, s.qty_quarantined,
            s.qty_expired, s.active_lots, s.is_below_min
       FROM items i
       JOIN units u ON u.id = i.unit_id
       LEFT JOIN item_categories c ON c.id = i.category_id
       LEFT JOIN v_item_available s ON s.item_id = i.id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY i.category_kind, i.name`,
    params,
  )
  res.json(filas)
}))

/** GET /api/items/:id */
/**
 * GET /api/items/sku-sugerido?nombre=…&tipo=…
 *
 * El código deducido del nombre, para que nadie lo teclee. Y dos avisos que
 * solo se pueden dar mirando el catálogo entero, no la pantalla:
 *
 *   · `existente` — el artículo ya está dado de alta con ese nombre. Se avisa
 *     para que se SELECCIONE el que hay, en vez de crear un segundo artículo
 *     con otro nombre y el mismo contenido.
 *   · `colision` — el código propuesto es el de otro artículo de OTRO nombre.
 *     Es el caso de «Alcohol 70 %» con «Alcohol 96 %» ya dado de alta: son dos
 *     artículos y el código tiene que separarlos.
 *
 * Se responde con permiso de LECTURA de catálogo, no de alta: teclear un
 * nombre para ver qué código saldría no crea nada, y obligar a tener permiso
 * de alta para solo mirar es un bother sin motivo.
 */
router.get('/items/sku-sugerido', auth, verCatalogo, asincrono(async (req, res) => {
  const nombre = String(req.query.nombre || '').trim()
  const tipo = String(req.query.tipo || '').trim()
  if (!nombre) return res.json({ sku: null, existente: null, colision: false })
  if (!moduloPorTipo(tipo)) {
    return res.status(400).json({ error: `Tipo de artículo desconocido: ${tipo}` })
  }
  res.json(await sugerirSku(nombre, tipo))
}))

/** POST /api/items */

router.get('/items/:id', auth, verCatalogo, asincrono(async (req, res) => {
  const item = await one(
    `SELECT i.*, u.code AS unit_code, u.symbol AS unit_symbol, u.dimension,
            c.name AS category_name,
            s.qty_on_hand, s.qty_reserved, s.qty_available, s.qty_quarantined,
            s.qty_expired, s.active_lots, s.is_below_min
       FROM items i
       JOIN units u ON u.id = i.unit_id
       LEFT JOIN item_categories c ON c.id = i.category_id
       LEFT JOIN v_item_available s ON s.item_id = i.id
      WHERE i.id = $1`,
    [req.params.id],
  )
  if (!item) return res.status(404).json({ error: 'Artículo no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(item)
}))

/**
 * Valida el tipo de artículo antes de nada: si no es válido, no tiene sentido
 * siquiera comprobar el permiso.
 */
function validarTipo(req, res, next) {
  const tipo = req.body?.category_kind ?? req.query?.category_kind
  if (!['RAW_MATERIAL', 'PACKAGING', 'FINISHED_GOOD'].includes(tipo)) {
    return res.status(400).json({
      error: 'category_kind debe ser RAW_MATERIAL, PACKAGING o FINISHED_GOOD',
      codigo: 'TIPO_INVALIDO',
    })
  }
  req.tipoArticulo = tipo
  next()
}

/** El permiso depende del tipo de artículo: cada módulo da de alta lo suyo. */
const permisoSegunTipo = requiereAlguno(
  (req) => [moduloPorTipo(req.tipoArticulo)], 'create', 'crear artículos')

router.post('/items', auth, validarTipo, permisoSegunTipo, asincrono(async (req, res) => {
  const b = req.body
  // El nombre es obligatorio y va ANTES que el codigo: sin nombre no hay nada
  // de que deducir el SKU, y un articulo sin nombre no sirve ni para buscarlo.
  if (!b.name || b.name.trim().length < 2) {
    return res.status(400).json({ error: 'Falta el nombre del artículo', codigo: 'NOMBRE_OBLIGATORIO' })
  }
  if (!b.unit_id) {
    return res.status(400).json({ error: 'Falta la unidad de medida', codigo: 'UNIDAD_OBLIGATORIA' })
  }

  // El SKU se DEDUCE aqui si no viene. Que la pantalla lo proponga es una
  // comodidad; que lo ponga el servidor es la garantia. Si el codigo se
  // exigiera aqui, bastaria con que alguien llame a la API a mano para volver
  // a tener articulos con el codigo tecleado a dedo, que es justo lo que esta
  // funcion viene a evitar.
  let sku = String(b.sku || '').trim().toUpperCase()
  if (!sku) sku = (await sugerirSku(b.name.trim(), req.tipoArticulo)).sku
  if (!sku || !/^[A-Z0-9][A-Z0-9._-]{2,30}$/.test(sku)) {
    return res.status(400).json({ error: 'El SKU debe ser 3-31 caracteres en mayusculas, con numeros, punto, guion o guion bajo' })
  }
  if (!b.name || b.name.trim().length < 2) {
    return res.status(400).json({ error: 'Falta el nombre del artículo', codigo: 'NOMBRE_OBLIGATORIO' })
  }
  if (!b.unit_id) {
    return res.status(400).json({ error: 'Falta la unidad de medida', codigo: 'UNIDAD_OBLIGATORIA' })
  }

  const item = await one(
    `INSERT INTO items
       (sku, name, category_kind, category_id, unit_id, base_unit_id, format_label,
        min_stock, max_stock, purchase_cost, sale_price, tax_rate, currency_code,
        track_lots, requires_expiry, shelf_life_days, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [sku, b.name.trim(), req.tipoArticulo, b.category_id || null, b.unit_id, b.base_unit_id || b.unit_id,
     b.format_label || null, b.min_stock || 0, b.max_stock || null,
     b.purchase_cost || 0, b.sale_price || 0, b.tax_rate ?? 0.21, b.currency_code || 'EUR',
     b.track_lots !== false, !!b.requires_expiry, b.shelf_life_days || null,
     b.notes || null, req.user.id],
  )
  // Una familia de producto terminado nace CON su serie.
  //
  // Antes no era así: se daba de alta `PT-JAB-1L`, la pantalla ponía «correcto»,
  // y el error salía tres pantallas después, al meter stock, con un 500 y un
  // «La serie JAB no existe». Una familia «creada» que luego no se puede
  // trabajar no está creada: está a medias, y lo descubre el de almacén, en el
  // momento de peor.
  //
  // Aquí se cierra en el alta: se deduce el mismo prefijo que usará la
  // numeración y se deja la serie lista. No se toca ninguna serie existente ni
  // ningún contador, así que los códigos antiguos no se mueven.
  let serieCreada = null
  const esTerminado = req.tipoArticulo === 'FINISHED_GOOD' || item.category_kind === 'FINISHED_GOOD'
  if (esTerminado) {
    const prefijo = String(item.lot_prefix || String(sku).split('-')[1] || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    if (prefijo.length >= 2) {
      serieCreada = await transaction((tx) => asegurarSerieDeFamilia(tx, prefijo, item.name))
      if (serieCreada.creada) {
        await query('UPDATE items SET lot_prefix = $1 WHERE id = $2 AND lot_prefix IS NULL',
          [prefijo, item.id]).catch(() => {})
      }
    }
  }

  await auditar(req.user.id, 'CREATE', 'items', item.id, { sku: item.sku, name: item.name, tipo: req.tipoArticulo })
  res.status(201).json({
    ...item,
    // Se le dice al que da de alta qué serie se ha creado, para que sepa que
    // la numeración de esa familia ya existe y no se la vuelva a crear.
    serie_creada: serieCreada && serieCreada.creada ? serieCreada.codigo : null,
  })
}))


/**
 * Carga el artículo de la URL. Middleware aparte para que el permiso dinámico
 * pueda encadenarse: primero se lee el tipo, después se comprueba el permiso.
 */
const cargarItem = asincrono(async (req, res, next) => {
  const item = await one('SELECT * FROM items WHERE id = $1', [req.params.id])
  if (!item) return res.status(404).json({ error: 'Artículo no encontrado', codigo: 'NO_ENCONTRADO' })
  req.item = item
  next()
})

const permisoEdicion = requiereAlguno((req) => [moduloPorTipo(req.item.category_kind)], 'edit', 'editar artículos')
const permisoBorrado = requiereAlguno((req) => [moduloPorTipo(req.item.category_kind)], 'delete', 'archivar artículos')

/** PUT /api/items/:id */
router.put('/items/:id', auth, cargarItem, permisoEdicion, asincrono(async (req, res) => {
  const b = req.body || {}
  if (b.name !== undefined && (!b.name || b.name.trim().length < 2)) {
    return res.status(400).json({ error: 'El nombre no puede quedar vacío', codigo: 'NOMBRE_INVALIDO' })
  }
  if (b.min_stock !== undefined && b.min_stock !== null && Number(b.min_stock) < 0) {
    return res.status(400).json({ error: 'El mínimo no puede ser negativo', codigo: 'MINIMO_INVALIDO' })
  }
  if (b.sale_price !== undefined && b.sale_price !== null && Number(b.sale_price) < 0) {
    return res.status(400).json({ error: 'El precio de venta no puede ser negativo', codigo: 'PRECIO_INVALIDO' })
  }

  const item = await one(
    `UPDATE items SET
       name = COALESCE($2, name),
       category_id = COALESCE($3, category_id),
       format_label = COALESCE($4, format_label),
       min_stock = COALESCE($5, min_stock),
       max_stock = $6,
       purchase_cost = COALESCE($7, purchase_cost),
       sale_price = COALESCE($8, sale_price),
       tax_rate = COALESCE($9, tax_rate),
       track_lots = COALESCE($10, track_lots),
       requires_expiry = COALESCE($11, requires_expiry),
       shelf_life_days = $12,
       notes = $13,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name?.trim() || null, b.category_id ?? null, b.format_label ?? null,
     b.min_stock ?? null, b.max_stock ?? null, b.purchase_cost ?? null, b.sale_price ?? null,
     b.tax_rate ?? null, b.track_lots ?? null, b.requires_expiry ?? null,
     b.shelf_life_days ?? null, b.notes ?? null],
  )
  await auditar(req.user.id, 'UPDATE', 'items', item.id, {
    min_stock: req.item.min_stock, sale_price: req.item.sale_price, name: req.item.name,
  }, { min_stock: item.min_stock, sale_price: item.sale_price, name: item.name })
  res.json(item)
}))

/**
 * DELETE /api/items/:id
 * Archiva, no borra. Un artículo con existencias o con historia tiene que
 * seguir existiendo, o el histórico deja de tener sentido.
 */
router.delete('/items/:id', auth, cargarItem, permisoBorrado, asincrono(async (req, res) => {
  const stock = await one('SELECT qty_on_hand FROM v_item_stock WHERE item_id = $1', [req.params.id])
  const conStock = Number(stock?.qty_on_hand || 0) > 0
  await one(
    `UPDATE items SET is_active = $2, archived_at = CASE WHEN $2 THEN archived_at ELSE now() END,
            updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, conStock],
  )
  await auditar(req.user.id, conStock ? 'ARCHIVE_BLOCKED_STOCK' : 'ARCHIVE', 'items', req.params.id,
    { is_active: true }, { is_active: !conStock })
  res.json({
    ok: true,
    is_active: !conStock,
    mensaje: conStock
      ? `No se puede archivar: ${req.item.name} tiene ${stock.qty_on_hand} en existencias.`
      : `${req.item.name} archivado. Su historial se conserva.`,
  })
}))

// ─── Consultas de apoyo ──────────────────────────────────────────────────────

router.get('/units', auth, verCatalogos, asincrono(async (_req, res) => {
  res.json(await query('SELECT * FROM units WHERE is_active ORDER BY dimension, code'))
}))

router.get('/item-categories', auth, asincrono(async (req, res) => {
  const params = req.query.tipo ? [req.query.tipo] : []
  res.json(await query(
    `SELECT * FROM item_categories WHERE is_active
      ${params.length ? 'AND category_kind = $1' : ''} ORDER BY category_kind, name`,
    params,
  ))
}))

// ─── Proveedores ─────────────────────────────────────────────────────────────

// La lista de proveedores la necesita quien recibe mercancía, no solo quien la
// gestiona. Sin esto, el rol de producción tenía la pantalla de Entradas en el
// menú y un 403 en cuanto intentaba elegir de dónde viene el lote.
const verProveedores = requiereAlgunoDe([
  ['suppliers', 'view'], ['purchases', 'view'], ['inventory', 'create'],
], 'ver los proveedores')

router.get('/suppliers', auth, verProveedores, asincrono(async (req, res) => {
  res.json(await query(
    `SELECT s.*, z.name AS zone_name FROM suppliers s
      LEFT JOIN zones z ON z.id = s.zone_id
      WHERE ($1::boolean IS NULL OR s.is_active = $1) ORDER BY s.name`,
    [req.query.activos === 'false' ? false : null],
  ))
}))

router.get('/suppliers/:id', auth, requierePermiso('suppliers', 'view'), asincrono(async (req, res) => {
  const s = await one(
    `SELECT s.*, z.name AS zone_name FROM suppliers s LEFT JOIN zones z ON z.id = s.zone_id WHERE s.id = $1`,
    [req.params.id],
  )
  if (!s) return res.status(404).json({ error: 'Proveedor no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(s)
}))

router.post('/suppliers', auth, requierePermiso('suppliers', 'create'), asincrono(async (req, res) => {
  const b = req.body || {}
  if (!b.name || b.name.trim().length < 2) {
    return res.status(400).json({ error: 'Falta el nombre del proveedor', codigo: 'NOMBRE_OBLIGATORIO' })
  }
  const p = await transaction(async (tx) => {
    const code = b.code || await siguienteCodigoProveedor(tx)
    return tx.one(
      `INSERT INTO suppliers (code, name, contact_name, phone, email, country, tax_id, address,
                              zone_id, payment_terms_days, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [code, b.name.trim(), b.contact_name || null, b.phone || null, b.email || null,
       b.country || 'Mali', b.tax_id || null, b.address || null, b.zone_id || null,
       b.payment_terms_days || 0, b.notes || null, req.user.id],
    )
  })
  await auditar(req.user.id, 'CREATE', 'suppliers', p.id, { name: p.name, code: p.code })
  res.status(201).json(p)
}))

router.put('/suppliers/:id', auth, requierePermiso('suppliers', 'edit'), asincrono(async (req, res) => {
  const b = req.body || {}
  const p = await one(
    `UPDATE suppliers SET name = COALESCE($2,name), contact_name = COALESCE($3,contact_name),
            phone = COALESCE($4,phone), email = COALESCE($5,email), country = COALESCE($6,country),
            tax_id = COALESCE($7,tax_id), address = COALESCE($8,address),
            payment_terms_days = COALESCE($9,payment_terms_days), notes = COALESCE($10,notes),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, b.name?.trim() || null, b.contact_name ?? null, b.phone ?? null, b.email ?? null,
     b.country ?? null, b.tax_id ?? null, b.address ?? null, b.payment_terms_days ?? null, b.notes ?? null],
  )
  if (!p) return res.status(404).json({ error: 'Proveedor no encontrado', codigo: 'NO_ENCONTRADO' })
  res.json(p)
}))

async function auditar(usuarioId, accion, entidad, entidadId, antes, despues) {
  await query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_data, after_data, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS')`,
    [usuarioId, accion, entidad, String(entidadId), antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null],
  )
}

export default router
