// Formatos de venta — las cajas.
//
// UNA CAJA NO ES UN ARTÍCULO. No se fabrica, no entra por almacén, no tiene
// lote y no se descuenta. Es una forma de vender N botellas por un precio
// concreto. El almacén sigue contando botellas; esta tabla solo traduce
// entre lo que el cliente pide («2 cajas») y lo que la tienda tiene («24
// botellas»).
//
// Eso es lo que permite que todo lo demás siga igual: las reservas, las
// entregas y la trazabilidad leen la cantidad en unidades base de la línea
// del pedido, y aquí esa cantidad sigue siendo 24.
import { query, one, transaction } from '../db/client.js'
import { auditar } from './auditoria.js'

export class ErrorDeFormato extends Error {
  constructor(mensaje, codigo = 'FORMATO', estado = 400, detalle = undefined) {
    super(mensaje)
    this.name = 'ErrorDeFormato'
    this.codigo = codigo
    this.estado = estado
    this.detalle = detalle
  }
}

// ── LECTURA ─────────────────────────────────────────────────────────────────

/**
 * Formatos de un producto, o de todos si no se dice cuál.
 *
 * Por defecto solo los activos: Ajustes y el formulario de pedido enseñan
 * lo que se puede vender HOY. El histórico de un pedido no pasa por aquí —
 * lleva su propia copia en la línea, y por eso un formato desactivado sigue
 * saliendo en su albarán.
 */
export async function listarFormatos({ itemId = null, incluirInactivos = false } = {}) {
  const cond = []
  const args = []
  if (itemId != null) { args.push(itemId); cond.push(`f.item_id = $${args.length}`) }
  if (!incluirInactivos) cond.push('f.is_active')

  return query(
    `SELECT f.id, f.item_id, i.sku, i.name AS producto, f.name, f.units_per_format,
            f.price, f.tax_rate, f.is_active, f.archived_at,
            i.unit_id, i.unit_id AS base_unit_id,
            COALESCE(f.tax_rate, i.tax_rate) AS iva_efectivo,
            f.created_at, f.updated_at
       FROM sale_formats f
       JOIN items i ON i.id = f.item_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY i.name, f.units_per_format, f.name`,
    args)
}

export async function obtenerFormato(id) {
  const f = await one(
    `SELECT f.*, i.sku, i.name AS producto, i.category_kind
       FROM sale_formats f JOIN items i ON i.id = f.item_id
      WHERE f.id = $1`, [id])
  if (!f) throw new ErrorDeFormato(`El formato ${id} no existe`, 'FORMATO_INEXISTENTE', 404)
  return f
}

// ── ESCRITURA ───────────────────────────────────────────────────────────────

function validar(datos, { parcial = false } = {}) {
  const d = datos || {}
  const falta = (campo) => d[campo] === undefined && parcial
  if (!falta('name') && !(String(d.name ?? '').trim().length > 0)) {
    throw new ErrorDeFormato('El formato necesita un nombre, por ejemplo «Caja de 12».', 'NOMBRE_OBLIGATORIO')
  }
  if (!falta('units_per_format')) {
    const n = Number(d.units_per_format)
    if (!Number.isFinite(n) || n <= 0) {
      throw new ErrorDeFormato(
        'Las unidades por caja tienen que ser un número mayor que cero.',
        'UNIDADES_INVALIDAS')
    }
    if (!Number.isInteger(n)) {
      // Media botella no existe, y dejarla pasar acabaría con 1,5 botellas
      // desccontadas del almacén.
      throw new ErrorDeFormato(
        `«${d.units_per_format}» no es un número entero de unidades. Una caja no puede llevar media botella.`,
        'UNIDADES_NO_ENTERAS')
    }
  }
  if (d.price != null && Number(d.price) < 0) {
    throw new ErrorDeFormato('El precio de la caja no puede ser negativo.', 'PRECIO_INVALIDO')
  }
  if (d.tax_rate != null && Number(d.tax_rate) < 0) {
    throw new ErrorDeFormato('El IVA no puede ser negativo.', 'IVA_INVALIDO')
  }
}

/**
 * Crear un formato.
 *
 * Solo para producto terminado. Una caja de materia prima no tiene sentido:
 * no se vende suelta y el pedido ni siquiera la admite.
 */
export async function crearFormato(datos, usuarioId) {
  validar(datos)
  return transaction(async (tx) => {
    const item = await tx.query(
      `SELECT id, sku, name, category_kind FROM items WHERE id = $1`, [datos.item_id])
    const art = item[0]
    if (!art) throw new ErrorDeFormato(`El artículo ${datos.item_id} no existe`, 'ARTICULO_INEXISTENTE', 404)
    if (art.category_kind !== 'FINISHED_GOOD') {
      throw new ErrorDeFormato(
        `${art.name} es materia prima o envase. Las cajas se configuran sobre producto terminado.`,
        'NO_ES_PRODUCTO_TERMINADO')
    }

    const yaExiste = await tx.query(
      `SELECT 1 FROM sale_formats WHERE item_id = $1 AND name = $2`, [datos.item_id, datos.name])
    if (yaExiste.length) {
      throw new ErrorDeFormato(
        `«${datos.name}» ya está configurado para ${art.name}. Edítalo en vez de duplicarlo.`,
        'FORMATO_DUPLICADO', 409)
    }

    const creado = await tx.query(
      `INSERT INTO sale_formats
         (item_id, name, units_per_format, price, tax_rate, is_active)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE))
       RETURNING *`,
      [datos.item_id, String(datos.name).trim(), datos.units_per_format,
        datos.price ?? null, datos.tax_rate ?? null,
        datos.is_active === false ? false : null])

    await auditar(tx, {
      usuarioId, accion: 'formato_venta.crear', entidad: 'sale_format',
      entidadId: creado[0].id, datos: { ...datos },
    })
    return creado[0]
  })
}

/**
 * Editar un formato.
 *
 * OJO CON LO QUE NO TOCA: cambiar el precio o las unidades NO reescribe los
 * pedidos ya emitidos. Cada línea guardó su propia copia (format_price,
 * format_units, format_name) el día que se pidió, así que un albarán de hace
 * un año sigue saliendo con el precio de entonces. Esto solo cambia lo que se
 * vending a partir de ahora.
 */
export async function editarFormato(id, datos, usuarioId) {
  validar(datos, { parcial: true })
  return transaction(async (tx) => {
    const antes = await tx.query('SELECT * FROM sale_formats WHERE id = $1', [id])
    if (!antes.length) throw new ErrorDeFormato(`El formato ${id} no existe`, 'FORMATO_INEXISTENTE', 404)

    const actualizado = await tx.query(
      `UPDATE sale_formats
          SET name            = COALESCE($2, name),
              units_per_format = COALESCE($3, units_per_format),
              price           = $4,
              tax_rate        = $5,
              is_active       = COALESCE($6, is_active),
              archived_at     = CASE WHEN $6 = FALSE THEN now() ELSE NULL END,
              updated_at      = now()
        WHERE id = $1
        RETURNING *`,
      [id, datos.name == null ? null : String(datos.name).trim(),
        datos.units_per_format ?? null,
        datos.price === undefined ? antes[0].price : datos.price,
        datos.tax_rate === undefined ? antes[0].tax_rate : datos.tax_rate,
        datos.is_active === undefined ? null : datos.is_active])

    await auditar(tx, {
      usuarioId, accion: 'formato_venta.editar', entidad: 'sale_format',
      entidadId: id, datos: { antes, despues: actualizado[0] },
    })
    return actualizado[0]
  })
}

/**
 * Desactivar. Nunca borrar.
 *
 * Un formato que estuvo en un pedido impreso no puede desaparecer: el
 * albarán que salió de la impresora seguiría nombrándolo. La base además
 * lo impide con un trigger; aquí está el camino amable.
 */
export async function desactivarFormato(id, usuarioId) {
  return transaction(async (tx) => {
    const f = await tx.query('SELECT * FROM sale_formats WHERE id = $1', [id])
    if (!f.length) throw new ErrorDeFormato(`El formato ${id} no existe`, 'FORMATO_INEXISTENTE', 404)
    if (!f[0].is_active) return f[0]

    const upd = await tx.query(
      `UPDATE sale_formats
          SET is_active = FALSE, archived_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`, [id])
    await auditar(tx, {
      usuarioId, accion: 'formato_venta.desactivar', entidad: 'sale_format',
      entidadId: id, datos: { nombre: f[0].name },
    })
    return upd[0]
  })
}

// ── TRADUCCIÓN ──────────────────────────────────────────────────────────────

/**
 * Resolver una línea de pedido que se ha pedido en cajas.
 *
 * Devuelve las botellas — que es lo que va a `qty` y lo que entiende el
 * almacén — y la foto del formato para guardarla en la línea. Si el formato
 * no existe, no se avergüenza deprices: se dice con nombre y número, porque
 * «la caja 7 no existe» a las nueve de la mañana no ayuda a nadie.
 */
export function traducirCaja(formato, cajas) {
  const n = Number(cajas)
  if (!Number.isFinite(n) || n <= 0) {
    throw new ErrorDeFormato(
      'La cantidad de cajas tiene que ser mayor que cero.', 'CAJAS_INVALIDAS')
  }
  const unidades = n * Number(formato.units_per_format)
  return {
    unidades,                 // 2 cajas de 12 -> 24 botellas
    cajas: n,
    // El precio de una caja. Si el formato no trae precio propio, se usa el
    // de la ficha del producto, que es lo que se hacía siempre.
    precioCaja: formato.price != null ? Number(formato.price) : null,
    foto: {
      id: formato.id,
      nombre: formato.name,
      unidades: Number(formato.units_per_format),
      precio: formato.price != null ? Number(formato.price) : null,
    },
  }
}
