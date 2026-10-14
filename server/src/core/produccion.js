/**
 * Producción: fabricar un producto terminado.
 *
 * Esto es el otro sistema de lotes. Si te parece un fichero más, mira la línea
 * de más abajo: la producción llama a `crearLoteConEntrada`, la MISMA función
 * que usa la recepción de mercancía. No hay dos formas de crear un lote. Un
 * lote nace SIEMPRE de esa función, venga de donde venga.
 *
 * Qué pasa en una producción, todo en UNA transacción:
 *
 *   1. Se planifica el consumo por caducidad (FEFO): primero lo que caduca
 *      antes. Se bloquean esos lotes con FOR UPDATE, en orden, para que dos
 *      producciones simultáneas no se peleen por el mismo lote.
 *   2. Se comprueba que hay existencias suficientes. Si no, NO se toca nada.
 *   3. Se registra la producción.
 *   4. Se consume cada lote: un movimiento de salida por lote, y se guarda en
 *      production_materials QUÉ lote se gastó y CUÁNTO. Eso es la trazabilidad.
 *   5. Se crea el lote de producto terminado y entra en stock como salida de
 *      producción.
 *
 * Si algo falla en el punto 4, el punto 5 tampoco ocurrió. No hay mitad.
 */

import { query, one, transaction } from '../db/client.js'
import { moverStock, crearLoteConEntrada, ErrorDeStock } from './stock.js'
import { siguienteCodigoProduccion, siguienteCodigoLoteProducto } from './codigos.js'
import { calcularNecesidades } from './recetas.js'
import { ErrorDeInventario } from './inventario.js'
import { auditar } from './auditoria.js'

/**
 * Simula una producción sin tocar nada.
 *
 * Es lo que la pantalla de producción enseña antes de que el operario confirme:
 * qué lotes se van a gastar, cuánto va a salir. Si falta materia prima, se ve
 * aquí, no a media fabricación.
 */
export async function planificarProduccion({ recipeId, cantidad, caducidad = null }) {
  return transaction(async (t) => {
    const plan = await calcularNecesidades(recipeId, cantidad, t)

    const lineas = []
    for (const l of plan.lineas) {
      // Cuánto hay de verdad, además de de qué lotes saldría. Sin esto la
      // pantalla enseñaba «Disponible 0» en todos los ingredientes: el campo
      // nunca se rellenaba y el operario veía un plan que parecía falso.
      const stock = await t.one(
        `SELECT qty_available FROM v_item_available WHERE item_id = $1`, [l.itemId],
      )
      const disponible = Number(stock?.qty_available ?? 0)
      const candidatos = await t.query(
        `SELECT lot_id, code, qty_available, unit_id, expiry_date
           FROM v_fefo_candidates
          WHERE item_id = $1 AND qty_available > 0
          ORDER BY priority`,
        [l.itemId],
      )
      let restante = l.qtyAConsumir
      const reparto = []
      if (process.env.TRAZA_PROD) console.log('    TRAZA', String(l.itemName).slice(0,26), 'restante', restante, 'candidatos', candidatos.length, JSON.stringify(candidatos.map(z=>[z.code, z.qty_available, z.unit_id])))
      for (const c of candidatos) {
        if (restante <= 1e-9) break
        // El disponible del lote, CONVERTIDO a la unidad que pide la línea.
        //
        // La misma conversión que en el plan, y por el mismo motivo: comparar
        // 20 L contra 9.000 ml da «faltan 8.980» con el almacén lleno. Y aquí
        // el error es peor, porque la producción se PARE: no es un número
        // raro en una pantalla, es una fábrica que no arranca.
        const disponibleLinea = l.unitId && c.unit_id && l.unitId !== c.unit_id
          ? Number((await t.one(
            `SELECT fn_convertir($1::numeric, $2::int, $3::int) AS v`,
            [c.qty_available, c.unit_id, l.unitId])).v)
          : Number(c.qty_available)
        const tomar = Math.min(restante, disponibleLinea)
        if (tomar <= 0) continue
        //
        // AQUÍ NO HAY QUE CONVERTIR NADA, y es importante que siga siendo así.
        //
        // `planificarProduccion` no mueve stock: enseña qué lotes se tocarían
        // y cuánto saldría de cada uno, en la unidad de la RECETA, que es la
        // que el operario tiene delante en la pantalla.
        //
        // Convertirlo a la unidad del lote aquí fue el error: además de
        // romper el arranque, habría hecho que el plan dijera «9 litros» donde
        // la receta dice «9.000 mililitros». El que convierte para el libro
        // mayor es `producir()`, que sí consume.
        //
        reparto.push({ lotId: c.lot_id, code: c.code, qty: Math.round(tomar * 10000) / 10000, caducidad: c.expiry_date })
        if (tomar <= 0) continue
        reparto.push({ lotId: c.lot_id, code: c.code, qty: tomar, caducidad: c.expiry_date })
        restante -= tomar
      }
      lineas.push({
        ...l,
        disponible,
        reparto,
        suficiente: restante <= 1e-9,
        falta: Math.max(restante, 0),
      })
    }

    return {
      ...plan,
      lineas,
      suficiente: lineas.every((l) => l.suficiente || !l.esCritica),
    }
  })
}

/**
 * Ejecuta la producción. Consume lotes y crea el lote de producto terminado.
 *
 * @param {object} p
 * @param {number} p.recipeId     receta a seguir
 * @param {number} p.cantidad     cuántas unidades fabricar
 * @param {number} p.usuarioId
 * @param {string} [p.codigoLote] código concreto; si no, se genera
 */
export async function producir(p) {
  const {
    recipeId, cantidad, usuarioId,
    caducidad = null, codigoLote = null,
    machineId = null, plannedAt = null,
    notas = null,
    // Produce para un pedido. Guarda el vínculo en `productions.sales_order_id`
    // y, al salir el lote, lo aparta para ese pedido: la mercancía fabricada
    // queda comprometida desde el mismo instante, sin pasar por un alta manual.
    orderId = null,
    // Confirmar una orden YA PLANIFICADA. No se crea una producción nueva: se
    // completa la que el planificador dejó pendiente, conservando su código y su
    // fecha de planificación. Es el mismo trabajo que una producción directa,
    // pero usando la fila que ya existía.
    produccionId = null,
  } = p

  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) {
    throw new ErrorDeInventario('La cantidad a producir debe ser mayor que cero', 'CANTIDAD_INVALIDA')
  }

  return transaction(async (tx) => {
    // ── 0. Si es una ORDEN, se bloquea y se revalida AQUÍ DENTRO ──────────────
    //
    // Es el muro de verdad contra la doble confirmación. `confirmarPlan()`
    // comprueba el estado antes de llamar, pero esa lectura queda fuera de la
    // transacción: dos peticiones simultáneas pasarían las dos y fabricarían
    // dos veces, consumiendo la materia prima por duplicado.
    //
    // `FOR UPDATE` espera a que la otra termine. La que llega segunda vuelve a
    // leer la fila, ya actualizada, ve que no está `PLANNED` y se va con un
    // 409 sin haber tocado un solo lote.
    if (produccionId != null) {
      const orden = await tx.one(
        `SELECT id, code, status, started_at FROM productions WHERE id = $1 FOR UPDATE`,
        [produccionId])
      if (!orden) {
        throw new ErrorDeInventario('La orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
      }
      // `started_at` TIENE QUE ESTAR EN EL SELECT. Si no se pide, llega
      // `undefined`, y `undefined !== null` es `true`: la comprobación rechazaba
      // todas las órdenes, incluidas las perfectamente válidas.
      if (orden.status !== 'PLANNED' || orden.started_at !== null) {
        throw new ErrorDeInventario(
          `La orden ${orden.code} ya está ${orden.status}. No se fabrica dos veces.`,
          'ORDEN_YA_PROCESADA', 409)
      }
    }

    // ── 1. Plan ──────────────────────────────────────────────────────────────
    const plan = await calcularNecesidades(recipeId, Number(cantidad), tx)
    const receta = plan.receta
    const producto = await tx.one('SELECT * FROM items WHERE id = $1', [receta.product_id])
    if (!producto) throw new ErrorDeInventario('El producto de la receta no existe', 'PRODUCTO_NO_ENCONTRADO', 404)
    if (!producto.is_active) {
      throw new ErrorDeInventario(`El producto ${producto.name} está archivado`, 'PRODUCTO_ARCHIVADO')
    }

    // ── 2. Reparto por caducidad, con los lotes bloqueados ────────────────────
    // Se bloquean TODOS los lotes candidatos, en el MISMO orden, antes de
    // comprobar nada. Si dos producciones cogieran los lotes en orden distinto,
    // cada una esperaría al lote que la otra tiene y se Produce un interbloqueo.
    const preparacion = []
    for (const l of plan.lineas) {
      const candidatos = await tx.query(
        `SELECT lot_id, code, qty_available, unit_id, expiry_date
           FROM v_fefo_candidates
          WHERE item_id = $1 AND qty_available > 0
          ORDER BY priority`,
        [l.itemId],
      )
      for (const c of candidatos) {
        await tx.one('SELECT id FROM lots WHERE id = $1 FOR UPDATE', [c.lot_id])
      }
      let restante = l.qtyAConsumir
      const reparto = []
      if (process.env.TRAZA_PROD) console.log('    TRAZA', String(l.itemName).slice(0,26), 'restante', restante, 'candidatos', candidatos.length, JSON.stringify(candidatos.map(z=>[z.code, z.qty_available, z.unit_id])))
      for (const c of candidatos) {
        if (restante <= 1e-9) break
        // El disponible del lote, CONVERTIDO a la unidad que pide la línea.
        //
        // La misma conversión que en el plan, y por el mismo motivo: comparar
        // 20 L contra 9.000 ml da «faltan 8.980» con el almacén lleno. Y aquí
        // el error es peor que un número raro en una pantalla: es una fábrica
        // que no arranca con material que sí hay.
        const disponibleLinea = l.unitId && c.unit_id && l.unitId !== c.unit_id
          ? Number((await tx.one(
            `SELECT fn_convertir($1::numeric, $2::int, $3::int) AS v`,
            [c.qty_available, c.unit_id, l.unitId])).v)
          : Number(c.qty_available)
        const tomar = Math.min(restante, disponibleLinea)
        const paraMover = l.unitId && c.unit_id && l.unitId !== c.unit_id
          ? Number((await tx.one(
            `SELECT fn_convertir($1::numeric, $2::int, $3::int) AS v`,
            [tomar, l.unitId, c.unit_id])).v)
          : tomar
        if (tomar <= 0) continue
        // DOS CANTIDADES, NO UNA. Y POR ESO NO SON LA MISMA.
        //
        // `cantidadReceta` va en la unidad de la LÍNEA (ml), y es lo que
        // significa «se gastaron 9.000 mililitros»: es lo que lee la
        // trazabilidad y lo que multiplica el coste.
        //
        // `cantidadLote` va en la unidad del LOTE (L), y es lo que descuenta
        // el saldo: 9 L.
        //
        // Guardar solo una de las dos fue el bug: 9 con la etiqueta ML. Son
        // 0,0332 € de concentrado donde debía ser 33,21 €, y el número salía
        // limpio, sin un error que delatara nada.
        //
        // Es el mismo error de antes con una vuelta más: una cifra, dos
        // verdades, y una etiqueta para una y otra cosa.
        //
        reparto.push({
          lotId: c.lot_id,
          code: c.code,
          qty: Math.round(paraMover * 10000) / 10000,
          cantidadReceta: Math.round(tomar * 10000) / 10000,
          caducidad: c.expiry_date,
        })
        // SIN ESTA LÍNEA, NADA CUADRA Y NO SE NOTA.
        //
        // `restante` es lo que queda por gastar. Si no se resta, `falta` vale
        // siempre la cantidad entera, el error salta aunque el lote tenga 400
        // unidades, y la producción no arranca nunca aunque el almacén esté
        // lleno. Es el fallo más caro de los que no dan error: el sistema dice
        // que no hay material y lo dice con seguridad.
        restante -= tomar
      }
      preparacion.push({ linea: l, reparto, falta: Math.max(restante, 0) })
    }

    const insuficiente = preparacion.filter((p2) => p2.falta > 1e-9)
    const criticos = insuficiente.filter((p2) => p2.linea.esCritica)
    if (criticos.length) {
      throw new ErrorDeStock(
        'No hay materia prima suficiente para empezar la producción: ' +
        criticos.map((c) => `${c.linea.itemName} (faltan ${Math.round(c.falta * 10000) / 10000} ${c.linea.unitCode})`).join(', '),
        { recipeId, plan },
      )
    }
    if (insuficiente.length) {
      throw new ErrorDeStock(
        'Hay ingredientes fuera de tolerancia que no llegan: ' +
        insuficiente.map((c) => `${c.linea.itemName} (faltan ${Math.round(c.falta * 10000) / 10000} ${c.linea.unitCode})`).join(', '),
        { recipeId, plan },
      )
    }

    // ── 3. Registrar la producción ───────────────────────────────────────────
    // Al confirmar una orden YA PLANIFICADA se conserva SU código. Pedir otro
    // hacía que el parte de trabajo dijera FAB-…0007 y el histórico
    // FAB-…0008, y un operario con el papel en la mano no encontraría nunca su
    // trabajo. El número se asigna al planificar, no al confirmar.
    const existente = produccionId
      ? await tx.one(`SELECT id, code FROM productions WHERE id = $1`, [produccionId])
      : null
    const codigoProduccion = existente?.code || await siguienteCodigoProduccion(tx)
    const produccion = produccionId
      ? await tx.one(
        `UPDATE productions
            SET status='COMPLETED', actual_qty=$2, started_at=now(), finished_at=now(),
                machine_id=$3, operator_id=$4, notes=COALESCE($5, notes)
          WHERE id=$1 AND status='PLANNED' AND started_at IS NULL
          RETURNING *`,
        [produccionId, Number(cantidad), machineId, usuarioId, notas],
      )
      : await tx.one(
        `INSERT INTO productions
           (code, product_id, recipe_id, sales_order_id, status, planned_qty, actual_qty, unit_id,
            planned_at, started_at, finished_at, machine_id, operator_id, notes, created_by)
         VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6,$7,$8, now(), now(), $9,$10,$11,$12)
         RETURNING *`,
        [codigoProduccion, receta.product_id, recipeId, orderId,
         Number(cantidad), Number(cantidad),
         producto.unit_id, plannedAt || new Date().toISOString(), machineId, usuarioId, notas, usuarioId],
      )

    // Si el UPDATE de arriba no tocó fila, la orden ya no estaba `PLANNED`.
    //
    // Se comprueba AQUÍ, ANTES de consumir un solo lote, y al tirar el error se
    // deshace la transacción entera. Si se comprobara después, la mercancía ya
    // habría salido del almacén y el lote de producto terminado ya se habría
    // creado: el trabajo del otro se quedaría sin material.
    if (produccionId && !produccion) {
      throw new ErrorDeInventario(
        'La orden ya había sido fabricada por otra confirmación. No se fabrica dos veces.',
        'ORDEN_YA_PROCESADA', 409)
    }

    // ── 4. Consumir los lotes ────────────────────────────────────────────────
    // Un movimiento por lote. El libro mayor tiene que poder explicar que
    // salieron 30 de MP-00001 y 20 de MP-00002, no «salieron 50 de agua».
    const consumos = []
    for (const { linea, reparto } of preparacion) {
      for (const r of reparto) {
        await moverStock(tx, {
          lotId: r.lotId,
          qty: -r.qty,
          movimiento: 'PRODUCTION_CONSUMPTION',
          refType: 'PRODUCTION',
          refId: produccion.id,
          motivo: `Producción ${codigoProduccion} de ${producto.name}`,
          usuarioId,
        })
        // ESTA LÍNEA ES LA TRAZABILIDAD. Si algún día se rompe, se rompe aquí:
        // qué lote de qué materia prima entró en qué lote de qué producto.
        const consumo = await tx.one(
          `INSERT INTO production_materials
             (production_id, item_id, lot_id, recipe_line_id, theoretical_qty, actual_qty, unit_id, consumed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           RETURNING *`,
            [produccion.id, linea.itemId, r.lotId, linea.recipeLineId, linea.qtyTeorica, r.cantidadReceta, linea.unitId],
        )
        consumos.push({ ...consumo, itemName: linea.itemName, lotCode: r.code })
      }
    }

    // ── 5. Crear el lote de producto terminado ───────────────────────────────
    // MISMA función que usa la recepción. Un solo generador de lotes.
    const code = codigoLote || await siguienteCodigoLoteProducto(tx, receta.product_id)
    //
    // EL COSTE REAL, NO EL TEÓRICO.
    //
    // Los materiales ya están en `production_materials` —unas líneas más
    // arriba—, cada uno con SU lote. Así que el coste real ya está escrito, y
    // se le pide a la base: lo que se consumió de verdad, al coste de su lote,
    // con la unidad convertida.
    //
    // Antes esta línea llamaba a `costeUnitarioTeorico()`, que hacía
    // `qty_per_batch * items.purchase_cost`: cantidad por precio de catálogo,
    // sin mirar la unidad. Para el concentrado, 9.000 ml × 3,69 €/L son 33,21 €
    // y esa cuenta daba 33.210 €. Mil veces más, sin un solo error, y con un
    // beneficio inventado al final.
    //
    const coste = await costeUnitarioReal(tx, produccion.id)
    const lote = await crearLoteConEntrada(tx, {
      code,
      itemId: receta.product_id,
      lotKind: 'FINISHED_GOOD',
      initialQty: Number(cantidad),
      unitId: producto.unit_id,
      expiryDate: caducidad || caducidadCalculada(receta, producto),
      originType: 'PRODUCTION',
      originId: produccion.id,
      unitCost: coste,
      productionId: produccion.id,
      machineId,
      operatorId: usuarioId,
      usuarioId,
      notes: notas,
    })

    await tx.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, after_data, outcome)
       VALUES ($1,'PRODUCCION','productions',$2,$3,'SUCCESS')`,
      [usuarioId, produccion.id, JSON.stringify({
        codigo: codigoProduccion, lote: lote.code, producto: producto.sku,
        cantidad: Number(cantidad), consumos: consumos.length,
      })],
    )

    // ── 6. Si es para un pedido, lo apartado al salir de fábrica ──────────
    // Lo recién fabricado está comprometible desde el mismo instante. Apartarlo
    // aquí evita el hueco en el que el lote es mío de cualquiera y otro
    // pedido se lo lleva antes de que se prepare el reparto.
    let reservaPedido = null
    if (orderId) {
      const linea = await tx.one(
        `SELECT id FROM sales_order_lines
          WHERE sales_order_id = $1 AND item_id = $2
          ORDER BY (qty - qty_delivered) DESC, id LIMIT 1`,
        [orderId, receta.product_id])
      if (linea) {
        const pendiente = await tx.one(
          `SELECT COALESCE(SUM(qty - qty_consumed),0) viva
             FROM order_reservations
            WHERE order_line_id = $1 AND status IN ('ACTIVE','ASSIGNED')`, [linea.id])
        const falta = Math.max(Number(cantidad) - Number(pendiente.viva), 0)
        if (falta > 1e-9) {
          reservaPedido = await tx.one(
            `INSERT INTO order_reservations
               (sales_order_id, order_line_id, item_id, lot_id, qty, unit_id, status, hold_type, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE','ORDER',$7)
             RETURNING id, lot_id, qty`,
            [orderId, linea.id, receta.product_id, lote.id, falta, producto.unit_id, usuarioId])
        }
      }
    }

    return {
      produccion,
      lote,
      consumos,
      codigo: codigoProduccion,
      reservaPedido,
      stock: await existenciasDe(receta.product_id, tx),
    }
  })
}

/**
 * COSTE REAL POR UNIDAD, y si se sabe entero.
 *
 * `fn_costo_produccion` ya hace la cuenta difícil: convierte cada cantidad a la
 * unidad en que se compró AQUEL material y la multiplica por el coste de SU
 * lote. Aquí solo se divide entre lo que ha salido.
 *
 * Y se avisa de si el coste está COMPLETO. Un coste hecho con materiales de
 * los que no se sabe el precio es una parte, y una parte presentada como coste
 * es un margen que no existe.
 */
async function costeUnitarioReal(tx, produccionId) {
  const r = await tx.one(
    `SELECT coste_unitario, completa FROM fn_costo_produccion($1::bigint)`, [produccionId])
  if (!r) return 0
  return Number(r.coste_unitario || 0)
}


/** Caducidad = vida útil del producto en días, si la tiene. */
function caducidadCalculada(receta, producto) {
  const dias = Number(producto.shelf_life_days || 0)
  if (!dias) return null
  return new Date(Date.now() + dias * 86400000).toISOString()
}

async function existenciasDe(itemId, tx = null) {
  const ejecutar = tx || { one }
  return ejecutar.one(
    `SELECT qty_on_hand, qty_reserved, qty_available
       FROM v_item_available WHERE item_id = $1`,
    [itemId],
  )
}

/** Listar producciones con su producto y sus consumos resumidos. */
export async function listarProducciones({ estado = null, limite = 50 } = {}) {
  return query(
    `SELECT pr.*, p.name AS product_name, p.sku, p.format_label,
            (SELECT COUNT(*) FROM production_materials pm WHERE pm.production_id = pr.id) AS n_consumos,
            l.code AS lot_code
       FROM productions pr
       JOIN items p ON p.id = pr.product_id
       LEFT JOIN lots l ON l.production_id = pr.id
      WHERE ($1::text IS NULL OR pr.status::text = $1)
      ORDER BY pr.id DESC
      LIMIT $2`,
    [estado, limite],
  )
}

/** Una producción con el detalle de qué lotes se gastaron. */
export async function detalleProduccion(id) {
  const p = await one(
    `SELECT pr.*, i.name AS product_name, i.sku, i.format_label
       FROM productions pr JOIN items i ON i.id = pr.product_id
      WHERE pr.id = $1`,
    [id],
  )
  if (!p) return null
  const consumos = await query(
    `SELECT pm.*, l.code AS lot_code, i.name AS item_name, i.sku,
            u.code AS unit_code, l.expiry_date
       FROM production_materials pm
       JOIN lots l ON l.id = pm.lot_id
       JOIN items i ON i.id = pm.item_id
       JOIN units u ON u.id = pm.unit_id
      WHERE pm.production_id = $1
      ORDER BY i.name`,
    [id],
  )
  const lote = await one('SELECT * FROM lots WHERE production_id = $1', [id])
  return { ...p, consumos, lote }
}

// ═══════════════════════════════════════════════════════════════════════════
// ÓRDENES DE FABRICACIÓN
//
//   PLANIFICAR → PENDIENTE → FABRICAR → CONFIRMAR → HISTÓRICO
//
// Planificar NO consume nada. La fila existe con estado `PLANNED` y su código
// (`FAB-…`), pero el material sigue entero en el almacén. El consumo ocurre
// exactamente una vez, al confirmar, que es cuando el lote de producto
// terminado sale de fábrica.
//
// Si al planificar (o al llegar el día) falta material, la orden NO se cancela:
// se queda pendiente y enseña qué falta y cuánto. Cancelarla sola dejaría al
// planificador sin saber que hay un problema.
// ═══════════════════════════════════════════════════════════════════════════

/** Crea una orden pendiente. No toca el stock. */
export async function planificarFabricacion({
  recipeId, cantidad, usuarioId, notas = null, orderId = null, plannedAt = null,
}) {
  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) {
    throw new ErrorDeInventario('La cantidad a fabricar debe ser mayor que cero', 'CANTIDAD_INVALIDA')
  }
  return transaction(async (tx) => {
    const receta = await tx.one(
      `SELECT r.*, i.name AS product_name, i.is_active AS producto_activo, i.unit_id
         FROM recipes r JOIN items i ON i.id = r.product_id
        WHERE r.id = $1`, [recipeId])
    if (!receta) throw new ErrorDeInventario('La receta no existe', 'RECETA_NO_ENCONTRADA', 404)
    if (!receta.is_active) throw new ErrorDeInventario('La receta está desactivada', 'RECETA_INACTIVA')
    if (!receta.producto_activo) throw new ErrorDeInventario('El producto está archivado', 'PRODUCTO_ARCHIVADO')

    const code = await siguienteCodigoProduccion(tx)
    const fila = await tx.one(
      `INSERT INTO productions
         (code, product_id, recipe_id, sales_order_id, status, planned_qty, actual_qty, unit_id,
          planned_at, notes, created_by)
       VALUES ($1,$2,$3,$4,'PLANNED',$5,NULL,$6,$7,$8,$9)
       RETURNING *`,
      [code, receta.product_id, recipeId, orderId, Number(cantidad), receta.unit_id,
       plannedAt || new Date().toISOString(), notas, usuarioId],
    )
    await auditar(tx, {
      usuarioId, accion: 'PLANIFICAR_FABRICACION', entidad: 'productions', entidadId: fila.id,
      despues: { code: fila.code, producto: receta.product_name, cantidad: Number(cantidad) },
    })
    return { ...fila, product_name: receta.product_name }
  })
}

/**
 * Cambia la cantidad de una orden PENDIENTE.
 *
 * Solo mientras siga pendiente y sin empezar. En cuanto Producción confirma, la
 * cantidad queda fijada: es lo que da sentido a la trazabilidad, porque el lote
 * de producto terminado y los consumos tienen que poder explicarse contra una
 * cifra que no cambia por debajo.
 */
export async function editarPlan(productionId, { cantidad, notas = null }, usuarioId) {
  if (!Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) {
    throw new ErrorDeInventario('La cantidad a fabricar debe ser mayor que cero', 'CANTIDAD_INVALIDA')
  }
  return transaction(async (tx) => {
    const p = await tx.one(`SELECT * FROM productions WHERE id=$1 FOR UPDATE`, [productionId])
    if (!p) throw new ErrorDeInventario('La orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
    if (p.status !== 'PLANNED' || p.started_at) {
      throw new ErrorDeInventario(
        `La orden ${p.code} ya ha comenzado. Su cantidad queda fijada para no romper la trazabilidad.`,
        'ORDEN_YA_INICIADA', 409)
    }
    const d = await tx.one(
      `UPDATE productions SET planned_qty=$2, notes=COALESCE($3, notes) WHERE id=$1 RETURNING *`,
      [productionId, Number(cantidad), notas])
    await auditar(tx, {
      usuarioId, accion: 'EDITAR_ORDEN_FABRICACION', entidad: 'productions', entidadId: productionId,
      antes: { cantidad: Number(p.planned_qty) }, despues: { cantidad: Number(cantidad) },
    })
    return d
  })
}

/**
 * Qué material hace falta y qué hay. No escribe nada y no bloquea nada.
 *
 * Es lo que permite decir «⚠ Material insuficiente: faltan 5 L de concentrado»
 * sin tocar nada, y deja la orden viva para poder arreglarlo.
 */
export async function comprobarPlan(productionId) {
  return transaction(async (tx) => {
    const p = await tx.one(
      `SELECT pr.*, r.code AS recipe_code, r.name AS recipe_name, r.base_qty,
              i.name AS product_name, i.sku
         FROM productions pr
         LEFT JOIN recipes r ON r.id = pr.recipe_id
         LEFT JOIN items  i ON i.id = pr.product_id
        WHERE pr.id = $1`, [productionId])
    if (!p) throw new ErrorDeInventario('La orden no existe', 'ORDEN_NO_ENCONTRADA', 404)

    let lineas = []
    if (p.recipe_id) {
      const plan = await calcularNecesidades(p.recipe_id, Number(p.planned_qty), tx)
      lineas = plan.lineas
    }
    const faltan = lineas.filter((l) => Number(l.disponible) + 1e-9 < Number(l.qtyAConsumir))
    return {
      ...p,
      lineas,
      falta_material: faltan.length > 0,
      faltan: faltan.map((l) => ({
        nombre: l.itemName, falta: Math.max(Number(l.qtyAConsumir) - Number(l.disponible), 0),
        unidad: l.unitCode, disponible: Number(l.disponible), necesita: Number(l.qtyAConsumir),
      })),
    }
  })
}

/** Órdenes pendientes: lo que Producción tiene que fabricar. */
export async function listarOrdenesPendientes({ limite = 100 } = {}) {
  return query(
    `SELECT pr.id, pr.code, pr.planned_qty, pr.planned_at, pr.notes, pr.status,
            r.code AS recipe_code, r.name AS recipe_name,
            i.name AS product_name, i.sku, i.format_label
       FROM productions pr
       LEFT JOIN recipes r ON r.id = pr.recipe_id
       LEFT JOIN items   i ON i.id = pr.product_id
      WHERE pr.status = 'PLANNED' AND pr.started_at IS NULL
      ORDER BY pr.planned_at, pr.id
      LIMIT $1`,
    [limite],
  )
}

/**
 * Confirmar la fabricación. Aquí SÍ se consume el material y sale el lote.
 *
 * Es la misma función que `producir`, pero completando una fila existente.
 * Reversir y repetir una orden confirmada no la duplica: el estado ya no es
 * `PLANNED`, así que la segunda llamada se rechaza.
 */
export async function confirmarPlan(productionId, {
  usuarioId, caducidad = null, notas = null, machineId = null,
}) {
  // El estado se comprueba AQUÍ, FUERA de la transacción.
  //
  // Es una puerta, no un muro. Dos operarios pulsando «Confirmar» a la vez
  // leen los dos `PLANNED`, y los dos entran a `producir()`. En el móvil es
  // fácil: doble toque, o un reintento por red lenta.
  //
  // La comprobación que de verdad manda la hace `producir()`, dentro de su
  // transacción y con la fila bloqueada. Esta de aquí solo da el 409 rápido y
  // legible en el caso normal, que es el 99 % de las veces.
  const actual = await one(
    `SELECT id, code, recipe_id, status, planned_qty, started_at
       FROM productions WHERE id = $1`, [productionId])
  if (!actual) throw new ErrorDeInventario('La orden no existe', 'ORDEN_NO_ENCONTRADA', 404)
  if (actual.status !== 'PLANNED') {
    throw new ErrorDeInventario(
      `La orden ${actual.code} ya está ${actual.status}. No se fabrica dos veces.`,
      'ORDEN_YA_PROCESADA', 409)
  }
  return producir({
    recipeId: actual.recipe_id,
    cantidad: Number(actual.planned_qty),
    usuarioId, caducidad, notas, machineId,
    // El parámetro se llama `productionId`; el de `producir` es
    // `produccionId`. Confundirlos daba un 500 sin más explicación.
    produccionId: productionId,
  })
}
