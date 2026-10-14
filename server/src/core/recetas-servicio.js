/**
 * Servicio de recetas: crear y versionar.
 *
 * Aquí se vive la regla que más se olvida: una receta no se EDITA, se
 * DESACTIVA y se crea otra versión. ¿Por qué? Porque las producciones viejas
 * apuntan a la receta con la que se fabricaron, y si editas esa receta de
 * golpe, el histórico deja de explicar cómo se hizo aquel lote. Cambiar una
 * fórmula no es corregir una errata: es fabricar un producto distinto.
 */

import { query, one, transaction } from '../db/client.js'
import { siguienteCodigoReceta } from './codigos.js'
import { obtenerReceta, validarReceta } from './recetas.js'
import { ErrorDeInventario } from './inventario.js'

export async function crearReceta({ productId, code, name, version, baseQty, baseUnitId, instructions, lineas, usuarioId }) {
  return transaction(async (tx) => {
    const producto = await tx.one('SELECT * FROM items WHERE id = $1', [productId])
    if (!producto) throw new ErrorDeInventario('El producto no existe', 'PRODUCTO_NO_ENCONTRADO', 404)

    // Rellenar la unidad de la línea con la del artículo si no viene dada.
    const lineasCompletas = []
    for (const l of lineas) {
      const item = await tx.one('SELECT id, name, unit_id FROM items WHERE id = $1', [l.itemId])
      if (!item) throw new ErrorDeInventario(`El ingrediente ${l.itemId} no existe`, 'ARTICULO_NO_ENCONTRADO')
      lineasCompletas.push({ ...l, unitId: l.unitId || item.unit_id, itemName: item.name })
    }

    const receta = {
      product_id: productId,
      base_qty: baseQty,
      product_unit_id: producto.unit_id,
    }
    const problemas = validarReceta(receta, lineasCompletas)
    if (problemas.length) {
      throw new ErrorDeInventario(problemas.join('. '), 'RECETA_INVALIDA')
    }

    // Solo puede haber UNA receta activa por producto. Es lo que hace que «la
    // receta de este producto» sea una respuesta sin ambigüedad. Crear una
    // segunda NO la sustituye en silencio: una fórmula es un documento, y
    // cambiarla por sorpresa sería fabricar otra cosa sin que nadie lo pidiera.
    // Para cambiarla está `nuevaVersion`, que desactiva la anterior.
    const activa = await tx.one(
      `SELECT id, code, version FROM recipes WHERE product_id = $1 AND is_active LIMIT 1`,
      [productId])
    if (activa) {
      throw new ErrorDeInventario(
        `${producto.name} ya tiene una receta activa (${activa.code}, versión ${activa.version}). ` +
        'Edítala para crear una versión nueva en vez de añadir otra.',
        'YA_EXISTE_RECETA_ACTIVA', 409,
      )
    }

    // La versión se calcula sola: pedirla a mano es pedir que dos personas la
    // pidan a la vez y choquen. Se puede indicar, pero es opcional.
    const siguiente = await tx.one(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM recipes WHERE product_id = $1`,
      [productId])
    const versionFinal = version || Number(siguiente?.v || 1)

    const codigo = code || await siguienteCodigoReceta(tx)
    const nueva = await tx.one(
      `INSERT INTO recipes (code, product_id, name, version, base_qty, base_unit_id, is_active, instructions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)
       RETURNING *`,
      [codigo, productId, name || producto.name, versionFinal, baseQty, baseUnitId || producto.unit_id, instructions || null, usuarioId],
    )
    for (const l of lineasCompletas) {
      await tx.query(
        `INSERT INTO recipe_lines (recipe_id, item_id, qty_per_batch, unit_id, tolerance, is_critical, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [nueva.id, l.itemId, l.qtyPerBatch, l.unitId, l.tolerance || 0, l.isCritical !== false, l.notes || null],
      )
    }
    return obtenerReceta(nueva.id, tx)
  })
}

/**
 * Crea una versión nueva y desactiva la anterior.
 * La vieja se queda como estaba, con sus números, para siempre.
 */
export async function nuevaVersion(recipeId, { baseQty, instructions, lineas, usuarioId }) {
  return transaction(async (tx) => {
    const actual = await obtenerReceta(recipeId, tx)
    if (!actual) throw new ErrorDeInventario('La receta no existe', 'RECETA_NO_ENCONTRADO', 404)

    await tx.query('UPDATE recipes SET is_active = FALSE WHERE id = $1', [recipeId])

    const nueva = await tx.one(
      `INSERT INTO recipes (code, product_id, name, version, base_qty, base_unit_id, is_active, instructions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)
       RETURNING *`,
      [await siguienteCodigoReceta(tx), actual.product_id, actual.name, Number(actual.version) + 1,
       baseQty ?? Number(actual.base_qty), actual.base_unit_id, instructions ?? actual.instructions, usuarioId],
    )

    const lineasNuevas = lineas ?? actual.lineas.map((l) => ({
      itemId: l.item_id, qtyPerBatch: Number(l.qty_per_batch), unitId: l.unit_id,
      tolerance: Number(l.tolerance || 0), isCritical: l.is_critical, notes: l.notes, itemName: l.item_name,
    }))

    for (const l of lineasNuevas) {
      const itemId = l.itemId ?? l.item_id
      const qty = l.qtyPerBatch ?? l.qty_per_batch
      const unitId = l.unitId ?? l.unit_id
      const item = await tx.one('SELECT id, name, unit_id FROM items WHERE id = $1', [itemId])
      if (!item) throw new ErrorDeInventario(`El ingrediente ${itemId} no existe`, 'ARTICULO_NO_ENCONTRADO')
      const completada = {
        ...l, itemId, qtyPerBatch: Number(qty), unitId: unitId || item.unit_id, itemName: item.name,
      }
      const problemas = validarReceta(
        { product_id: actual.product_id, base_qty: baseQty ?? Number(actual.base_qty), product_unit_id: actual.base_unit_id },
        [completada],
      )
      if (problemas.length) throw new ErrorDeInventario(problemas.join('. '), 'RECETA_INVALIDA')
      await tx.query(
        `INSERT INTO recipe_lines (recipe_id, item_id, qty_per_batch, unit_id, tolerance, is_critical, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [nueva.id, itemId, completada.qtyPerBatch, completada.unitId,
         completada.tolerance || 0, completada.isCritical !== false, completada.notes || null],
      )
    }
    return obtenerReceta(nueva.id, tx)
  })
}
