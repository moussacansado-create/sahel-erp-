/**
 * Recetas: qué hace falta para fabricar un producto.
 *
 * Una receta dice qué materias primas y qué envases hacen falta para obtener
 * `base_qty` de un producto. NO dice de qué lote se saca cada cosa: eso lo
 * decide el almacén, por caducidad, en el momento de producir.
 *
 * Esa separación es deliberada. Si la receta guardara el lote, habría que
 * editarla cada vez que se acaba un lote, y nadie lo haría.
 */

import { query, one, transaction } from '../db/client.js'
import { ErrorDeInventario } from './inventario.js'

/** Lee una receta con sus líneas, validada y ordenada. */
export async function obtenerReceta(recipeId, tx = null) {
  const ejecutar = tx || { one, query }
  const receta = await ejecutar.one(
    `SELECT r.*, p.name AS product_name, p.sku AS product_sku,
            p.unit_id AS product_unit_id, p.format_label
       FROM recipes r
       JOIN items p ON p.id = r.product_id
      WHERE r.id = $1`,
    [recipeId],
  )
  if (!receta) {
    throw new ErrorDeInventario('La receta no existe', 'RECETA_NO_ENCONTRADA', 404)
  }
  const lineas = await ejecutar.query(
    `SELECT l.id, l.item_id, l.qty_per_batch, l.unit_id, l.tolerance, l.is_critical, l.notes,
            i.name AS item_name, i.sku, i.category_kind, i.unit_id AS item_unit_id,
            u.code AS unit_code, u.symbol AS unit_simbolo,
            -- EL STOCK, CONVERTIDO A LA UNIDAD DE LA LÍNEA (ver fn_convertir).
            --
            COALESCE(fn_convertir(st.qty_on_hand, i.unit_id, l.unit_id), 0) AS qty_disponible
       FROM recipe_lines l
       JOIN items i ON i.id = l.item_id
       JOIN units u ON u.id = l.unit_id
       LEFT JOIN v_item_available st ON st.item_id = l.item_id
      WHERE l.recipe_id = $1
      ORDER BY i.category_kind, i.name`,
    [recipeId],
  )
  return { ...receta, lineas }
}

/**
 * Cuánto hace falta de cada línea para fabricar `cantidad`.
 *
 * Devuelve el cálculo teórico, no el consumo real: el consumo real depende de
 * los lotes que haya, y eso lo decide el almacén. Aquí se le enseña al
 * operario lo que va a necesitar ANTES de empezar, para que pueda ver que
 * falta algo mientras todavía tiene tiempo deBringlo.
 */
export async function calcularNecesidades(recipeId, cantidad, tx = null) {
  //
  // EL STOCK DE CADA LÍNEA, EN LA UNIDAD DE ESA LÍNEA.
  //
  // `qty_on_hand` es lo que hay en la unidad del ARTÍCULO, y la receta pide en
  // la unidad de la LÍNEA. Son cosas distintas: el concentrado vive en litros
  // y la receta lo pide en mililitros.
  //
  // Sin convertirlo, 40 L se comparaban contra 9.000 ml y salía «faltan 8.960
  // MIL» con el almacén lleno. No es un error de redondeo: es una fábrica que
  // no arranca con material que sí hay, y al revés, material que no hay que se
  // da por bueno.
  //
  const receta = await obtenerReceta(recipeId, tx)
  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) {
    throw new ErrorDeInventario('La cantidad a producir debe ser mayor que cero', 'CANTIDAD_INVALIDA')
  }
  if (!receta.base_qty || Number(receta.base_qty) <= 0) {
    throw new ErrorDeInventario('La receta no define una cantidad base válida', 'RECETA_INVALIDA')
  }

  const factor = Number(cantidad) / Number(receta.base_qty)
  const lineas = receta.lineas.map((l) => {
    const teorico = Number(l.qty_per_batch) * factor
    // La cantidad real que se consumirá se redondea hacia ARRIBA a la unidad
    // mínima del inventario (4 decimales, como los lotes). Redondear hacia
    // abajo dejaría fracciones que no se pueden retirar de ningún lote.
    const consumo = Math.ceil(teorico * 10000) / 10000
    const tolerancia = Number(l.tolerance || 0)
    return {
      recipeLineId: l.id,
      itemId: l.item_id,
      itemName: l.item_name,
      sku: l.sku,
      categoryKind: l.category_kind,
      unitId: l.unit_id,
      unitCode: l.unit_code,
      qtyTeorica: teorico,
      qtyAConsumir: consumo,
      // Dentro de la tolerancia, la cantidad es opcional: el lote puede faltar
      // sinerializer la producción entera. Fuera, es obligatoria o no se produce.
      esCritica: l.is_critical && !(tolerancia > 0 && consumo <= teorico * (1 + tolerancia)),
      tolerancia,
      // Cuántas unidades hay de verdad de este ingrediente.
      //
      // ESTE CAMPO FALTABA. Sin él, `Number(l.disponible)` daba `NaN`, y
      // `NaN < necesita` es `false`: la comprobación de material decía «hay
      // material suficiente» cuando en realidad no había ni un envase. La
      // pantalla llegó a decir «hay material» enseñando 0 al lado.
      disponible: Number(l.qty_disponible ?? 0),
      notas: l.notes,
    }
  })
  return { receta, factor, cantidad: Number(cantidad), lineas }
}

/**
 * Qué hay realmente disponible de cada línea, y de qué lotes saldría.
 *
 * No reserva nada ni bloquea nada: es una simulación. La reserva real la hace
 * la producción al confirmar, dentro de la misma transacción.
 */
export async function planificarNecesidades(recipeId, cantidad, tx = null) {
  const plan = await calcularNecesidades(recipeId, cantidad, tx)
  const lineas = []
  for (const l of plan.lineas) {
    const stock = await existenciasDe(l.itemId, tx)
    //
    // EL DISPONIBLE, CONVERTIDO A LA UNIDAD QUE PIDE LA RECETA.
    //
    // Aquí se comparaban dos números en dos unidades distintas: lo que hay en
    // el almacén —en la unidad del artículo— y lo que la receta pide —en la
    // unidad de la línea—. Con el concentrado en litros y la receta en
    // mililitros, 20 L se comparaban contra 9.000 ml y salía «faltan 8.960 ML»
    // para un almacén lleno.
    //
    // No es un matiz de redondeo: es un almacén con producto que el sistema
    // dice que no tiene, y una máquina que no arranca por material que sí hay.
    //
    const disponible = await enUnidadDe(tx, l.itemId, l.unitId, stock?.qty_available ?? 0)
    const lotes = await lotesPorCaducidad(l.itemId, tx)
    lineas.push({
      ...l,
      disponible,
      suficiente: disponible + 1e-9 >= l.qtyAConsumir,
      lotes: lotes.map((x) => ({ lotId: x.lot_id, code: x.code, qty: Number(x.qty_available), caducidad: x.expiry_date })),
    })
  }
  return {
    ...plan,
    lineas,
    suficiente: lineas.every((l) => l.suficiente || !l.esCritica),
    faltan: lineas.filter((l) => !l.suficiente).map((l) => ({
      itemId: l.itemId, nombre: l.itemName, falta: l.qtyAConsumir - l.disponible, critico: l.esCritica,
    })),
  }
}

  /**
   * Una cantidad del almacén, DICHA en la unidad que se va a comparar.
   *
   * Sin esto se comparan litros con mililitros, y un almacén lleno parece
   * vacío. Y el resultado se dice EN SU UNIDAD, porque un número sin unidad al
   * lado de otro número con otra unidad son dos números que parecen lo mismo y
   * no lo son.
   */
  async function enUnidadDe(tx, itemId, unitPedida, cantidad) {
    const ejecutar = tx || { one }
    if (!unitPedida) return Number(cantidad)
    const r = await ejecutar.one(
      `SELECT fn_convertir($1::numeric, COALESCE(base_unit_id, unit_id), $2::int) AS v
         FROM items WHERE id = $3::int`,
      [cantidad, unitPedida, itemId],
    )
    return Number(r?.v ?? cantidad)
  }

/** Lotes utilizables de un artículo, por orden de caducidad (FEFO). */
async function lotesPorCaducidad(itemId, tx = null) {
  const ejecutar = tx || { query }
  return ejecutar.query(
    `SELECT lot_id, code, qty_available, expiry_date
       FROM v_fefo_candidates
      WHERE item_id = $1 AND qty_available > 0
      ORDER BY priority`,
    [itemId],
  )
}

async function existenciasDe(itemId, tx = null) {
  const ejecutar = tx || { one }
  return ejecutar.one(
    `SELECT qty_on_hand, qty_reserved, qty_available
       FROM v_item_available WHERE item_id = $1`,
    [itemId],
  )
}

/**
 * Comprueba que una receta sea coherente ANTES de poder usarla.
 * Una receta que consume más de lo que produce no es una receta: es un error
 * de tecleo que se descubre el día que falta materia prima.
 */
export function validarReceta(receta, lineas) {
  const problemas = []
  const cantidadDe = (l) => Number(l.qtyPerBatch ?? l.qty_per_batch)
  const itemIdDe = (l) => l.itemId ?? l.item_id
  const criticoDe = (l) => l.isCritical ?? l.is_critical ?? true

  if (!receta.product_id) problemas.push('La receta no tiene producto asociado')
  if (!Number.isFinite(Number(receta.base_qty)) || Number(receta.base_qty) <= 0) {
    problemas.push('La cantidad base debe ser mayor que cero')
  }
  if (!lineas.length) problemas.push('La receta no tiene ninguna línea de ingredientes')

  const vistos = new Set()
  for (const l of lineas) {
    const id = itemIdDe(l)
    const nombre = l.itemName || l.item_name || id
    if (vistos.has(id)) problemas.push(`El artículo ${nombre} está repetido`)
    vistos.add(id)
    if (id === receta.product_id) {
      problemas.push('Un producto no puede ser ingrediente de sí mismo')
    }
    if (!Number.isFinite(cantidadDe(l)) || cantidadDe(l) <= 0) {
      problemas.push(`Cantidad inválida para ${nombre}`)
    }
    if (criticoDe(l) === false && !Number.isFinite(cantidadDe(l))) {
      problemas.push(`Unidad inválida para ${nombre}`)
    }
  }
  return problemas
}

/** ¿Existe ya una receta activa para este producto? */
export async function recetaActivaDe(productId, tx = null) {
  const ejecutar = tx || { one }
  return ejecutar.one(
    `SELECT * FROM recipes WHERE product_id = $1 AND is_active ORDER BY version DESC LIMIT 1`,
    [productId],
  )
}
