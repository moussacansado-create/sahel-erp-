/**
 * ETIQUETAS ADHESIVAS DE ALMACÉN.
 *
 * ── LO QUE ESTO NO ES ───────────────────────────────────────────────────────
 *
 * No es un módulo de entradas nuevo. Una entrada de almacén ya existe: es un
 * LOTE en `lots`, con su cantidad, su proveedor y sus movimientos. La etiqueta
 * es una VISTA de ese lote, y por eso puede reimprimirse todas las veces que
 * haga falta sin que el stock se entere. Imprimir no es recibir.
 *
 * ── LOS TRES IDENTIFICADORES, Y POR QUÉ NO SE MEZCLAN ───────────────────────
 *
 *   ENTRADA          `entrada_no`        Correlativo global, único, no se
 *                                        reutiliza. Es lo que escanea el QR.
 *                                        Nueve líneas de un albarán = nueve
 *                                        entradas = nueve números.
 *
 *   LOTE INTERNO     `lots.code`         Lo asigna Sahel al recibir. Es el que
 *                                        consume producción (`lot_id`).
 *
 *   LOTE FABRICANTE  `supplier_lot_code` Lo pone el proveedor. A menudo no
 *                                        existe, y entonces no se imprime.
 *
 * Confundirlos es el error caro: un lote equivocado en producción no se ve
 * hasta que el producto sale mal. Por eso cada uno tiene su sitio en la
 * etiqueta y su sitio en la API, y ninguno se deduce del otro.
 *
 * ── LO QUE NO SE INVENTA ────────────────────────────────────────────────────
 *
 * Ni un precio, ni un nombre de proveedor si no hay proveedor, ni una fecha de
 * caducidad inventada. Si un campo no existe, el campo no sale. Poner «—» o un
 * 0 es peor que no poner nada, porque un hueco se reconoce y un dato falso no.
 */
import { randomBytes } from 'node:crypto'
import { query, one, transaction } from '../db/client.js'
import QRCode from 'qrcode'

/** El prefijo del QR. Se lee a mano y separa entrada de tarjeta de cliente. */
export const PREFIJO_ETIQUETA = 'SA-'

/**
 * FORMATOS DE ETIQUETA.
 *
 * Los tres que se piden, en milímetros. Se miden en mm y no en píxeles porque
 * una impresora térmica decide el corte en milímetros, y «100 px» son 26,5 mm
 * o 37 mm según el DPI del driver. Escribir `@page { size: 50mm 30mm }` es lo
 * único que hace que el rollo salga bien en el dispositivo y también en el
 * selector de impresoras del sistema.
 */
export const FORMATOS = {
  // `compacto` decide la retícula: en una pegata de 50×30 no caben ocho
  // líneas seguidas de una en una. En vez de recortarlas —y perder el proveedor o
  // la caducidad sin que nadie se entere— se ponen en DOS COLUMNAS con letra
  // más pequeña. Todos los datos siguen saliendo; lo que cambia es cómo.
  '50x30': {
    ancho: 50, alto: 30, nombre: '50 × 30 mm', compacto: true,
    // UNA PEGATA DE 50×30 NO DA PARA OCHO CAMPOS. Medido: ocho filas a 5 pt
    // ocupan 185 px en una etiqueta de 113 px. Ponerlos todos y dejar que se
    // corten NO es una etiqueta pequeña: es una etiqueta rota que parece llena.
    //
    // Así que se enseña lo que identifica el material y se dice, en la hoja de
    // impresión, qué NO ha cabido. Preferible una pegata corta y legible a una
    // larga y cortada por la mitad.
    fichaCorta: ['Articulo', 'Cantidad', 'Recibido'],
    omitidos: ['Proveedor', 'Caducidad', 'Lote del fabricante'],
    cuerpo: 4.8, titulo: 4.8, altoQr: 0.23, altoCb: 3.2, pad: 0.9, hueco: 0.28,
  },
  '60x40': {
    ancho: 60, alto: 40, nombre: '60 × 40 mm', compacto: true,
    fichaCorta: ['Articulo', 'Cantidad', 'Recibido', 'Caducidad'],
    omitidos: ['Proveedor', 'Lote del fabricante'],
    cuerpo: 5.6, titulo: 6.2, altoQr: 0.23, altoCb: 3.8, pad: 1.0, hueco: 0.36,
  },
  '100x50': {
    ancho: 100, alto: 50, nombre: '100 × 50 mm', compacto: false,
    // Aquí sí caben todos: es la pegata grande, para cajas y para materiales
    // donde el proveedor y la caducidad importan.
    fichaCorta: null,
    omitidos: [],
    cuerpo: 6.8, titulo: 7.6, altoQr: 0.22, altoCb: 4.0, pad: 1.2, hueco: 0.28,
  },
}

export function formatoValido(f) {
  return FORMATOS[f] ? f : null
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TOKEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El token es un identificador, no un dato. Sale de `crypto.randomBytes`, no de
 * la base: PGlite no trae `gen_random_bytes` y, más importante, generar el QR
 * no debería poder escribir en `lots` sin permiso de escritura.
 *
 * Si el lote aún no tiene token se le asigna. Es la ÚNICA escritura que hace
 * este módulo sobre un lote, y no toca stock, costes, movimientos ni ninguna
 * otra columna: solo añade la pegatina.
 */
export async function tokenDe(loteId, { crear = true } = {}) {
  const l = await one('SELECT etiqueta_token FROM lots WHERE id = $1::int', [loteId])
  if (!l) return null
  if (l.etiqueta_token) return l.etiqueta_token
  if (!crear) return null
  const nuevo = 'et' + randomBytes(9).toString('hex')
  const r = await query(
    `UPDATE lots SET etiqueta_token = $2
      WHERE id = $1::int AND etiqueta_token IS NULL RETURNING etiqueta_token`,
    [loteId, nuevo],
  )
  // Si otro proceso se adelantó, se usa el suyo: la carrera no rompe nada.
  return r.length ? r[0].etiqueta_token : (await one('SELECT etiqueta_token FROM lots WHERE id = $1::int', [loteId]))?.etiqueta_token
}

/**
 * Rotar el token invalida las pegatas viejas. Es lo que se hace cuando un rollo
 * se pierde en un almacén: se cambia la pegatina, NO el lote. El material sigue
 * siendo el mismo y su historial no se toca.
 */
export async function rotarToken(loteId) {
  const nuevo = 'et' + randomBytes(9).toString('hex')
  const r = await query(
    `UPDATE lots SET etiqueta_token = $2 WHERE id = $1::int RETURNING id, entrada_no, code`,
    [loteId, nuevo],
  )
  if (!r.length) throw Object.assign(new Error('Ese lote no existe.'), { codigo: 'NO_ENCONTRADO' })
  return { entradaNo: r[0].entrada_no, token: nuevo }
}

export function contenidoQr(token) {
  return `${PREFIJO_ETIQUETA}${token}`
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS DATOS DE LA ETIQUETA
// ═══════════════════════════════════════════════════════════════════════════

const TIPO_MATERIAL = {
  RAW_MATERIAL: 'Materia prima',
  PACKAGING: 'Material de embalaje',
  FINISHED_GOOD: 'Producto terminado',
}

export function tipoDeLote(lotKind) {
  return TIPO_MATERIAL[lotKind] || lotKind || 'Material'
}

/**
 * Los datos de UNA entrada, tal y como están en la base.
 *
 * `cantidadRecibida` es `initial_qty`: lo que ENTRÓ, no lo que queda. La
 * diferencia entre las dos cosas es la diferencia entre auditar una entrada y
 * auditar el almacén entero, y por eso la pegatina dice lo primero.
 */
export async function datosDeEntrada(loteId) {
  const f = await one(
    `SELECT l.id, l.entrada_no, l.code AS lote_interno, l.supplier_lot_code, l.lot_kind, l.production_id,
            l.initial_qty AS cantidad_recibida, l.qty_available,
            l.qty_consumed, l.received_at, l.expiry_date, l.invoice_ref,
            l.status, l.manufactured_at, l.unit_cost,
            i.id AS item_id, i.sku, i.name AS articulo, i.category_kind,
            u.name AS unidad, u.symbol AS unidad_simbolo,
            s.name AS proveedor,
            (SELECT full_name FROM users WHERE id = l.created_by) AS recibido_por
       FROM lots l
       JOIN items i ON i.id = l.item_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.id = $1::int`,
    [loteId],
  )
  if (!f) return null
  if (!f.entrada_no) {
    throw Object.assign(
      new Error('Esta entrada no tiene número asignado: es anterior a las etiquetas y aún no se ha numerado.'),
      { codigo: 'SIN_NUMERO_ENTRADA' },
    )
  }
  const token = await tokenDe(loteId)

  // ── QUÉ IDENTIFICATOR ES EL PRINCIPAL, SEGÚN EL TIPO DE LOTE ─────────────
  //
  // En un lote de PRODUCTO TERMINADO, lo que identifica la unidad es el LOTE DE
  // FABRICACIÓN, no el número de entrada. Una botella no «entró»: se fabricó, y
  // su número es el de la partida que salió de fábrica. Poner el número de
  // entrada como cabecera obligaba a buscar un documento de recepción para
  // encontrar un lote de producción, que es dar la vuelta dos veces.
  //
  // En materia prima y envase sí manda la entrada, porque es una recepción.
  const esProducto = f.lot_kind === 'FINISHED_GOOD'
  const principal = esProducto ? f.lote_interno : f.entrada_no

  return {
    entradaNo: f.entrada_no,
    // Los TRES identificadores, con su nombre. Nunca uno en el hueco del otro.
    numeroEntrada: f.entrada_no,
    loteInterno: f.lote_interno,
    // Lo que va en grande en la pegata. El QR y el código de barras lo usan
    // también, así que el escáner lleva justo al registro que se está viendo.
    identificadorPrincipal: principal,
    principalEsLote: esProducto,
    claseLote: f.lot_kind,
    loteFabricante: f.supplier_lot_code || null,
    sku: f.sku,
    articulo: f.articulo,
    tipoMaterial: tipoDeLote(f.lot_kind),
    cantidadRecibida: f.cantidad_recibida,
    unidad: f.unidad || f.unidad_simbolo || '',
    restante: f.qty_available,
    recibidoEn: f.received_at,
    caducidad: f.expiry_date,
    fabricanteEn: f.manufactured_at,
    proveedor: f.proveedor || null,
    albaran: f.invoice_ref || null,
    estado: f.status,
    unitCost: f.unit_cost,
    itemId: f.item_id,
    loteId: f.id,
    token,
    contenidoQr: contenidoQr(token),
  }
}

/** Solo el QR. El token no lleva PII: ni nombre, ni precio, ni proveedor. */
export async function imagenQr(token, { tamano = 300 } = {}) {
  if (!token) throw Object.assign(new Error('Esta entrada todavía no tiene etiqueta.'), { codigo: 'SIN_TOKEN' })
  return QRCode.toBuffer(contenidoQr(token), {
    type: 'png',
    errorCorrectionLevel: 'H',   // 30 % de tolerancia: sucia, mojada, plegada
    margin: 1,
    scale: 1,
    width: tamano,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// ESCANEO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Qué hay detrás de un QR de etiqueta.
 *
 * Devuelve el `lote_id` y la entrada, NUNCA los datos. Los datos salen del
 * endpoint de la ficha, que aplica los permisos de quien pregunta. Así, escanear
 * una etiqueta en el pasillo no regala el precio del material a quien no puede
 * verlo, aunque tenga la pegatina en la mano.
 */
export async function resolverQr(escaneado) {
  const limpio = String(escaneado || '').trim()
  const token = limpio.startsWith(PREFIJO_ETIQUETA) ? limpio.slice(PREFIJO_ETIQUETA.length) : limpio
  if (!/^et[0-9a-f]{18}$/i.test(token)) {
    throw Object.assign(new Error('Ese código no es una etiqueta de almacén.'), { codigo: 'QR_NO_RECONOCIDO' })
  }
  const l = await one(
    `SELECT id, entrada_no, code, lot_kind, status
       FROM lots WHERE etiqueta_token = $1`,
    [token],
  )
  if (!l) {
    throw Object.assign(
      new Error('Esa etiqueta no corresponde a ninguna entrada. Puede ser de una etiqueta antigua que se rotó.'),
      { codigo: 'ETIQUETA_ROTADA' },
    )
  }
  return { loteId: l.id, entradaNo: l.entrada_no, loteInterno: l.code, tipo: tipoDeLote(l.lot_kind), estado: l.status }
}

// ═══════════════════════════════════════════════════════════════════════════
// BITÁCORA DE IMPRESIONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dejar constancia de que alguien imprimió.
 *
 * Es lo ÚNICO que hace imprimir. No entra en `stock_movements`, no toca
 * `qty_available`, no recalcula costes. Reimprimir cien veces deja cien filas
 * aquí y el stock sigue igual, que es exactamente lo que tiene que pasar.
 */
export async function registrarImpresion({ loteId, formato, copias = 1, usuarioId = null, reimpresion = false }) {
  const f = formatoValido(formato)
  if (!f) throw Object.assign(new Error('Ese tamaño de etiqueta no existe.'), { codigo: 'FORMATO_INVALIDO' })
  const n = Math.max(1, Math.min(200, Number(copias) || 1))
  return transaction(async (tx) => {
    const lote = await tx.one('SELECT id, entrada_no FROM lots WHERE id = $1::int', [loteId])
    if (!lote) throw Object.assign(new Error('Esa entrada no existe.'), { codigo: 'NO_ENCONTRADO' })
    const r = await tx.one(
      `INSERT INTO lot_etiquetas (lote_id, entrada_no, formato, copias, reimpresion, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, lote_id, entrada_no, formato, copias, reimpresion, creado_at`,
      [loteId, lote.entrada_no, f, n, !!reimpresion, usuarioId],
    )
    return r
  })
}

export async function impresionesDe(loteId) {
  return query(
    `SELECT e.id, e.entrada_no, e.formato, e.copias, e.reimpresion, e.creado_at,
            COALESCE(u.full_name, '—') AS usuario
       FROM lot_etiquetas e
       LEFT JOIN users u ON u.id = e.usuario_id
      WHERE e.lote_id = $1::int
      ORDER BY e.creado_at DESC`,
    [loteId],
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAZABILIDAD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * De dónde viene una entrada y en qué se ha consumido.
 *
 * El identificador de la entrada NO cambia nunca por consumirse: si un lote de
 * materia prima entra en tres producciones, sigue siendo el MISMO lote con el
 * MISMO número de entrada. Lo que se multiplica son los movimientos, y eso es
 * lo que tiene que pasar.
 *
 * La producción se saca por el propio movimiento (`ref_type`/`ref_id`), no
 * adivinando: la tabla real se llama `productions`, no `production_orders`.
 */
export async function trazabilidad(loteId) {
  const entrada = await datosDeEntrada(loteId)
  if (!entrada) return null

  const movimientos = await query(
    `SELECT m.id, m.movement_type, m.qty, m.balance_after, m.occurred_at,
            m.ref_type, m.ref_id, m.reason,
            COALESCE(u.full_name, '—') AS usuario
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.created_by
      WHERE m.lot_id = $1::int
      ORDER BY m.occurred_at DESC, m.id DESC`,
    [loteId],
  )

  // Las producciones que han CONSUMIDO este lote. `productions.id` es lo que
  // El movimiento guarda en `ref_id` cuando `ref_type` es producción.
  // ── DE DÓNDE VIENE EL LOTE ───────────────────────────────────────────────
  //
  // La fuente es `lots.production_id`, NO los movimientos. Un lote de
  // producción lleva su origen en la propia fila; deducirlo de los
  // movimientos falla en cuanto el lote se consume entero y ya no queda ningún
  // movimiento que lo nombre, que es justo cuando más falta hace saber de
  // dónde salió.
  const porLote = new Set()
  // `entrada.loteId` viene de la ficha del lote; su origen está en la fila.
  const origen = await one('SELECT production_id FROM lots WHERE id = $1::int', [loteId])
  if (origen && origen.production_id) porLote.add(Number(origen.production_id))
  for (const m of movimientos) {
    if (m.ref_id && /PRODUC/i.test(m.movement_type || '')) porLote.add(Number(m.ref_id))
  }
  const ids = [...porLote]
  const producciones = ids.length
    ? await query(
      `SELECT id, code, created_at, status FROM productions
        WHERE id = ANY($1::int[]) ORDER BY created_at DESC`, [ids],
    )
    // Sin `catch`: si esta consulta falla, la trazabilidad devuelve MIENTROS y
    // parece que el lote no tiene origen. Un error visible se arregla; un
    // hueco silencioso se acabuda creyendo.
    : []

  const porId = new Map(producciones.map((p) => [p.id, p.code]))

  // ── HACIA ATRÁS: DE DÓNDE VIENE ──────────────────────────────────────────
  //
  // Un lote de producto terminado tiene que poder explicar de qué materias
  // primas y de qué envases salió. No se deduce del movimiento: se saca de la
  // CONSUMICIÓN de la producción que lo fabricó, que es donde el sistema dejó
  // anotado qué lote entró y cuánto.
  const haciaAtras = []
  if (producciones.length) {
    // La tabla de producciones se llama `productions`, no `production_orders`.
    // Y se une por `item_id` —el material—, no por el `lot_id` del producto: el
    // punto de este recorrido es saber QUÉ materia prima entró, no releer el
    // lote que estamos consultando.
    const filas = await query(
      `SELECT po.code AS produccion, po.id AS produccion_id,
              pm.lot_id AS lote_consumido, pm.actual_qty AS cantidad,
              l.code AS lote_interno, l.lot_kind, l.supplier_lot_code,
              i.sku, i.name AS articulo, i.category_kind AS clase
         FROM production_materials pm
         JOIN productions po ON po.id = pm.production_id
         LEFT JOIN lots l ON l.id = pm.lot_id
         LEFT JOIN items i ON i.id = pm.item_id
        WHERE pm.production_id = ANY($1::int[])
        ORDER BY i.category_kind, i.sku`,
      [producciones.map((p) => p.id)],
    )
    for (const f of filas) {
      haciaAtras.push({
        ...f,
        tipo: f.lot_kind || 'MATERIAL',
      })
    }
  }

  return {
    ...entrada,
    movimientos: movimientos.map((m) => ({
      ...m,
      produccion: (m.ref_id && porId.get(m.ref_id)) || null,
    })),
    producciones,
    // Lo que este lote CONSUMIÓ para fabricar lo de arriba.
    entradas: haciaAtras,
    impresiones: await impresionesDe(loteId),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORIAL DE ENTRADAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Las entradas con su etiqueta, para volver a imprimir desde el historial.
 *
 * `puede_imprimir` no se deduce: viene de que el usuario tenga `inventory:create`.
 * Se calcula en SQL para que la lista y los permisos no puedan discrepar.
 */
export async function listarEntradas({ limite = 100, buscar = null } = {}) {
  return query(
    `SELECT l.id, l.entrada_no, l.code AS lote_interno, l.supplier_lot_code, l.lot_kind,
            l.lot_kind, l.initial_qty, l.qty_available, l.received_at, l.expiry_date,
            l.etiqueta_token, i.sku, i.name AS articulo, s.name AS proveedor,
            (SELECT count(*)::int FROM lot_etiquetas e WHERE e.lote_id = l.id) AS impresiones,
            (SELECT max(e.creado_at) FROM lot_etiquetas e WHERE e.lote_id = l.id) AS ultima_impresion
       FROM lots l
       JOIN items i ON i.id = l.item_id
       LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.entrada_no IS NOT NULL
        -- El lote del FABRICANTE también se busca. Aparece en la pegata, así que
        -- quien lo tiene delante tiene que poder encontrar la entrada por él: si
        -- el proveedor pone LOTE-2024-88 en una caja y el sistema no lo encuentra,
        -- la etiqueta sirve de poco.
        -- El comodín va AQUÍ, dentro del SQL, y no en el JavaScript de quien
        -- llama. ILIKE 'PT-DES' compara la cadena ENTERA: los cinco lotes
        -- PT-DES-00001…00005 existían y la búsqueda devolvía cero. Con
        -- comodines, «PT-DES» los encuentra, y supplier_lot_code deja de
        -- ser un campo que se puede buscar sin acertar la cadena entera.
          AND ($2::text IS NULL OR i.name ILIKE $2 OR i.sku ILIKE $2
               OR l.code ILIKE $2 OR l.supplier_lot_code ILIKE $2
               OR l.invoice_ref ILIKE $2 OR s.name ILIKE $2
               OR CAST(l.entrada_no AS text) ILIKE $2)
      ORDER BY l.received_at DESC NULLS LAST, l.id DESC
      LIMIT $1::int`,
    [Math.min(Number(limite) || 100, 500),
      // El término llega con `%` para que «PT-DES» encuentre «PT-DES-00001».
      // Sin esto la búsqueda solo acierta cuando se escribe el código entero.
      buscar ? `%${String(buscar).trim()}%` : null],
  ).then((filas) => filas.map((f) => ({
    ...f,
    tipoMaterial: tipoDeLote(f.lot_kind),
    hayToken: !!f.etiqueta_token,
  })))
}

/**
 * Las series de lotes, tal como se ven en Configuración.
 *
 * Se lee de `config_series` y no de una lista escrita en el código: si mañana
 * se crea una serie nueva desde la pantalla, aquí aparece sola, y la etiqueta
 * y la numeración usan la MISMA definición en vez de dos que se separan.
 */
export async function listarSeriesCompleto() {
  return query(
    `SELECT codigo, nombre, clase, prefijo, digitos, con_anio, anio, ultimo_valor, is_active
       FROM config_series ORDER BY clase, codigo`,
  )
}
