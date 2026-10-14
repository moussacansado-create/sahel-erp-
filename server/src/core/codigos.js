/**
 * Generación de códigos.
 *
 * En la aplicación anterior había tres algoritmos distintos para numerar
 * órdenes de producción, y dos generaban el mismo número desde sitios
 * diferentes. Aquí hay UNO por tipo de código, y todos se apoyan en un bloqueo
 * de fila para que dos peticiones simultáneas no produzcan el mismo número.
 */

/** Prefijos por tipo de artículo. */
const PREFIJOS = {
  RAW_MATERIAL: 'MP',
  PACKAGING: 'ENV',
  FINISHED_GOOD: 'PT',
}

/**
 * Siguiente código de lote para un tipo de artículo.
 * MP-0001, MP-0002… / ENV-0001… / PT-2026-0001…
 *
 * @param {object} tx  transacción
 * @param {string} tipo  RAW_MATERIAL | PACKAGING | FINISHED_GOOD
 * @param {boolean} conAnio  los productos terminados llevan el año
 */
/**
 * El siguiente código de LOTE, tomado de la serie que le toca.
 *
 *     DES-2026-000001      producto fabricado este año
 *     MP-00001             materia prima (serie sin año, si así se configuró)
 *
 * ── POR QUÉ UNA TABLA DE SERIES Y NO UN `MAX(code)` ──────────────────────────
 *
 * Sacar el siguiente con `MAX(code) ON lots` parece rápido y es una trampa:
 * depende de que nadie borre nunca un lote. Borrado el último, el contador
 * retrocede y el siguiente lote REPETIRÍA un código que ya existió. Aquí el
 * contador vive en `config_series`, y la base no deja que retroceda.
 *
 * ── LAS CUATRO GARANTÍAS ─────────────────────────────────────────────────────
 *
 * 1. **Concurrencia.** La reserva la hace `fn_siguiente_serie()`, un
 *    `UPDATE … RETURNING` atómico. Dos operarios pulsando «fabricar» a la vez
 *    reciben números distintos, y no depende de un mutex en JavaScript, que es
 *    justo lo que falla cuando hay dos procesos.
 *
 * 2. **No reutilización.** El año va EN el código cuando la serie lo lleva:
 *    `DES-2026-000001` y `DES-2027-000001` no pueden ser el mismo número ni
 *    aunque el contador se reinicie. Dentro de un año el contador solo sube.
 *
 * 3. **Reinicio anual.** Si el año cambia, el contador vuelve a 1 DENTRO del
 *    `ON CONFLICT`, en la misma sentencia atómica. No hay un `if` por delante
 *    que otro proceso pueda colarse.
 *
 * 4. **El pasado no se toca.** Esto solo decide el código de un lote NUEVO. Los
 *    antiguos guardan el suyo en `lots.code` y no se renumeran jamás.
 */
export async function siguienteCodigoLote(tx, tipo, opciones = {}) {
  const serie = opciones.serie || PREFIJOS[tipo]
  if (!serie) throw new Error(`Tipo de lote desconocido: ${tipo}`)
  const r = await tx.one('SELECT fn_siguiente_serie($1::text) AS s', [String(serie).toUpperCase()])
  if (!r?.s) {
    // Error CON CÓDIGO. El código importa porque es lo que distingue un 400
    // —«te falta esto, haz aquello»— de un 500, que en el móvil no dice nada y
    // en la cabeza del trabajador significa «la aplicación está caída».
    throw Object.assign(new Error(
      `La serie «${serie}» no existe. Créala en Configuración → Numeración `
      + 'antes de fabricar con ella.',
    ), { status: 409, codigo: 'SERIE_INEXISTENTE' })
  }
  const s = r.s
  const numero = String(s.valor).padStart(s.digitos, '0')
  return {
    code: s.con_anio ? `${s.prefijo}-${s.anio}-${numero}` : `${s.prefijo}-${numero}`,
    serie: s.serie, anio: s.anio, valor: s.valor,
  }
}

/** Solo la cadena, para donde no hace falta saber de qué serie salió. */
export async function siguienteCodigoLoteTexto(tx, tipo, opciones) {
  return (await siguienteCodigoLote(tx, tipo, opciones)).code
}

/** El número de ENTRADA, de su propia serie. */
export async function siguienteNumeroEntrada(tx) {
  const r = await tx.one('SELECT fn_siguiente_serie($1::text) AS s', ['ENT'])
  if (!r?.s) throw new Error('La serie de entradas no existe')
  return r.s.valor
}

/**
 * Siguiente código de lote de PRODUCTO TERMINADO, numerado por producto.
 *
 *   PT-DES-00001, PT-DES-00002…   (desinfectante)
 *   PT-LAV-00001, PT-LAV-00002…   (lavavajillas)
 *
 * El contador vive en `code_counters`, no en el histórico de lotes. Antes se
 * sacaba con MAX(code) sobre `lots`, lo que hacía que el número dependiera de
 * que nadie borrara nunca un lote: borrado el último, el contador retrocedía y
 * el siguiente lote repetía un código que ya había existido.
 *
 * El `INSERT … ON CONFLICT DO UPDATE` es atómico: dos producciones simultáneas
 * del mismo producto se serializan en esa fila. La segunda espera a que la
 * primera confirme, y si la primera falla y deshace, el número vuelve a estar
 * disponible — que es lo correcto, porque ese lote nunca existió.
 *
 * @param {object} tx  transacción
 * @param {number} itemId  producto terminado
 * @returns {Promise<string>}  código del lote
 */
export async function siguienteCodigoLoteProducto(tx, itemId) {
  const item = await tx.one('SELECT lot_prefix, sku, name FROM items WHERE id = $1', [itemId])
  if (!item) throw new Error(`Producto ${itemId} no existe`)

  // El prefijo explícito manda. Si no hay, se deduce del SKU, que es lo único
  // que siempre existe: «PT-DES-750» → «DES».
  //
  // Se deduce en lugar de fallar porque los productos los crea el alta de
  // ficha, que puede pasar por delante de la migración que rellena la columna.
  const deduced = String(item.sku).split('-')[1] || String(item.sku)
  // El prefijo se acota a 4, NO a 8. El código del lote lo exige
  // `lots_code_check`: `^[A-Z][A-Z0-9]{0,3}-...`. Con un SKU como
  // `PT-PRUEB-9` la serie deducida es `PRUEB` (5 letras) y el INSERT moría
  // con «violates check constraint lots_code_check», dejando la producción
  // confirmada a medias y sin lote de producto terminado. Ocho era un número
  // inventado que nadie comprobó contra la regla de la base.
  const prefijo = (item.lot_prefix || deduced).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
  if (prefijo.length < 2) {
    throw new Error(
      `No se puede numerar el lote de «${item.name}» (SKU ${item.sku}): no hay un `
      + 'prefijo legible. Fíjalo en la ficha del producto antes de fabricar.',
    )
  }
  if (!item.lot_prefix) {
    // Se guarda para que la próxima vez no haya que deducirlo otra vez, y para
    // que el código siga siendo el mismo aunque alguien cambie el SKU después.
    await tx.query('UPDATE items SET lot_prefix = $1 WHERE id = $2 AND lot_prefix IS NULL', [prefijo, itemId])
  }

  await asegurarSerieDeFamilia(tx, prefijo, item.name)
  const r = await siguienteCodigoLote(tx, 'PRODUCTO', { serie: prefijo })
  return r.code
}

/**
 * La serie de una familia de producto, creándola si no existe.
 *
 * El prefijo de un producto no es un rótulo: es el NOMBRE de su serie de
 * numeración. Y aquí estaba la trampa: se podía dar de alta un producto
 * `PT-JAB-1L` que a simple vista parecía perfecto, y tres pantallas después —al
 * meter stock— reventaba con un HTTP 500 y un «La serie JAB no existe» que no
 * dice ni qué hacer. La familia quedaba «creada» a medias, y quien lo veía
 * pensaba que el fallo era del almacén o del servidor.
 *
 * Aquí la serie se crea sola si falta, con el formato de las que ya existen
 * (6 dígitos, con el año). Crear una serie nueva NO toca ninguna de las
 * anteriores ni reinicia ningún contador: cada una lleva su propio.
 *
 * Si aun así no se puede crear —una familia con nombre raro, un fallo de
 * permisos— el error sale con su código, y quien lo vea recibe una instrucción
 * concreta en vez de un 500 mudo.
 */
export async function asegurarSerieDeFamilia(tx, prefijo, nombreProducto = '') {
  // El código de lote solo admite un prefijo de UNA a CUATRO letras: el CHECK
  // de `lots.code` es `^[A-Z][A-Z0-9]{0,3}-[A-Z0-9][A-Z0-9-]{0,29}$`, y el
  // `-` que separa el prefijo del año cuenta como el cuarto carácter.
  //
  // Sin este recorte, una familia de cinco letras («Jabón» → `JABON`) se daba de
  // alta, parecía correcta, y al meter stock moría con un error de regla del
  // sistema que no decía de qué. Las familias reales (`DES`, `LAV`, `LIM`) son
  // de tres y por eso nunca se había visto.
  //
  // Se recorta a cuatro, que es lo que el sistema admite, y no a tres: cuatro es
  // el máximo real y recortarlo más tiraría información sin motivo.
  const codigo = String(prefijo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
  if (codigo.length < 2) return { creada: false, codigo: null }

  const existe = await tx.one('SELECT codigo FROM config_series WHERE codigo = $1', [codigo])
  if (existe) return { creada: false, codigo: existe.codigo }

  await tx.query(
    `INSERT INTO config_series (codigo, nombre, clase, prefijo, digitos, con_anio, ultimo_valor, anio)
     VALUES ($1, $2, 'PRODUCTO', $1, 6, true, 0, NULL)
     ON CONFLICT (codigo) DO NOTHING`,
    [codigo, `Serie de la familia ${codigo}`],
  )
  return { creada: true, codigo }
}

/** Siguiente código de albarán: ALB-2026-0001 */
export async function siguienteCodigoAlbaran(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ALB'])
  const anio = new Date().getFullYear()
  const fila = await tx.one(
    `SELECT code FROM albaranes WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [`ALB-${anio}-%`],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `ALB-${anio}-${String(siguiente).padStart(4, '0')}`
}

/** Siguiente código de orden de producción: FAB-2026-0001 */
export async function siguienteCodigoProduccion(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['FAB'])
  const anio = new Date().getFullYear()
  const fila = await tx.one(
    `SELECT code FROM productions WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [`FAB-${anio}-%`],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `FAB-${anio}-${String(siguiente).padStart(4, '0')}`
}

/** Siguiente código de pedido de venta: PED-2026-0001 */
export async function siguienteCodigoPedido(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['PED'])
  const anio = new Date().getFullYear()
  const fila = await tx.one(
    `SELECT code FROM sales_orders WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [`PED-${anio}-%`],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `PED-${anio}-${String(siguiente).padStart(4, '0')}`
}

/** Siguiente código de compra: COM-2026-0001 */
export async function siguienteCodigoCompra(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['COM'])
  const anio = new Date().getFullYear()
  const fila = await tx.one(
    `SELECT code FROM purchase_orders WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [`COM-${anio}-%`],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `COM-${anio}-${String(siguiente).padStart(4, '0')}`
}

/** Siguiente código de entrega: ENT-2026-0001 */
export async function siguienteCodigoEntrega(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ENT'])
  const anio = new Date().getFullYear()
  const fila = await tx.one(
    `SELECT code FROM deliveries WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [`ENT-${anio}-%`],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `ENT-${anio}-${String(siguiente).padStart(4, '0')}`
}

/**
 * Siguiente código de cliente: CL-00001.
 *
 * CINCO dígitos, con la C y la L. Es el formato de siempre —el de la aplicación
 * antigua y el de los albaranes ya archivados— y se unificó aquí para que no
 * convivan «CLI-0007» y «CL-00007» en el mismo sistema.
 *
 * Se cuentan solo los que YA TIENEN los cinco dígitos. Antes se contaba la
 * cifra del final de cualquier cosa que se pareciera, y como `CLI-0010` tiene
 * cuatro, un `CL-00007` antiguo y un `CLI-0009` nuevo producían una lista
 * imposible de ordenar. Ahora el número sale de los `CL-#####` de verdad.
 */
export async function siguienteCodigoCliente(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['CLI'])
  const fila = await tx.one(
    `SELECT MAX(NULLIF(regexp_replace(code, '^CL-', ''), '')::bigint) AS ultimo
       FROM customers WHERE code ~ '^CL-[0-9]{5}$'`,
  )
  const siguiente = Number(fila?.ultimo || 0) + 1
  return `CL-${String(siguiente).padStart(5, '0')}`
}

/** Siguiente código de proveedor: PRO-0001 */
export async function siguienteCodigoProveedor(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['PRO'])
  const fila = await tx.one(
    `SELECT code FROM suppliers ORDER BY length(code) DESC, code DESC LIMIT 1`,
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `PRO-${String(siguiente).padStart(4, '0')}`
}

/**
 * Siguiente código de receta: REC-0001, REC-0002…
 * Las recetas no llevan el producto en el código: una misma fórmula puede
 * tener varias versiones, y el código tiene que ser único para el histórico.
 */
export async function siguienteCodigoReceta(tx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['REC'])
  const fila = await tx.one(
    `SELECT code FROM recipes WHERE code LIKE $1 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    ['REC-%'],
  )
  const siguiente = fila?.code ? Number(String(fila.code).match(/(\d+)$/)?.[1] || 0) + 1 : 1
  return `REC-${String(siguiente).padStart(4, '0')}`
}
