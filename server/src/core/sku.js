/**
 * SKU AUTOMÁTICO.
 *
 * Escribir el código a mano en cada alta es donde se cuelan los errores: dos
 * personas que teclean «RM-ALCOHOL» y «RM-ALCO-HOL», o el mismo material
 * creado dos veces con dos códigos distintos porque nadie se acordaba del
 * anterior. El código no lo escribe una persona: lo deduce del nombre, y la
 * persona solo lo rectifica si el nombre no lo cuenta.
 *
 * LA REGLA, entera y en una frase:
 *
 *   mayúsculas, sin acentos, sin signos raros → se quita la primera palabra
 *   que no aporte (de, la, el, de la…) → se pega la raíz de la primera
 *   palabra que queda → se corta a cinco letras → se le pone el prefijo del
 *   tipo → si ya existe, se añade -2, -3…
 *
 * Con esto salen los códigos que ya se usaban: «Colorante azul cosmético» da
 * COLOR (se le quita el -ANTE), «Fragancia limón» da FRAG (se le quita el
 * -ANCIA), «Agua desionizada» da AGUA (que ya cabía entero).
 *
 * Lo que NO hace, y es lo importante:
 *
 *   · No decide el tipo. Si la misma palabra sirve para un envase y para una
 *     materia prima, cada uno con su prefijo, son dos códigos distintos: el
 *     prefijo lo pone quien da de alta, no el nombre.
 *   · No adivina concentrations. «Alcohol isopropílico» y «Alcohol
 *     isopropílico 96 %» NO se funden: el segundo es otro artículo, con su
 *     código, y el -2 que aparezca en pantalla es una aviso para que la
 *     persona mire, no un Chin-guo que se acepto a ciegas.
 *   · No borra ni renumera. El SKU es PERMANENTE. Un artículo que ya tiene
 *     código lo conserva aunque le cambien el nombre; si el nombre cambia, el
 *     código se queda, porque el código es de lo que se imprimen las etiquetas
 *     y ya están repartidas.
 */

import { query } from '../db/client.js'

/** Prefijo de SKU por tipo de artículo. Es el del ARTÍCULO, no el del lote. */
export const PREFIJO_SKU = {
  RAW_MATERIAL: 'RM',
  PACKAGING: 'ENV',
  FINISHED_GOOD: 'PT',
}

/**
 * Palabras que no aportan nada al principio del nombre. «De», «la», «el» van a
 * ser las primeras palabras de la mitad de los articulos de una fabrica, y si
 * seeneratedaran todas acabariamos con codigos que empiezan por LA.
 */
const VACIAS = new Set([
  'DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'UN', 'UNA', 'UNOS', 'UNAS',
  'Y', 'E', 'O', 'U', 'EN', 'CON', 'PARA', 'POR', 'SIN', 'A', 'AL', 'LO',
])

/**
 * Terminaciones genéricas que se quitan para quedarse con la raíz.
 *
 * Solo se quitan si al quitarlas todavía quedan tres letras: sin ese margen,
 * «Sal» se convertiría en «S» y el código deja de decir nada.
 */
const TERMINACIONES = [
  'AMIENTO', 'IMIENTO', 'ANCIA', 'ENCIA', 'ACION', 'ANTE', 'ICO', 'ICA',
  'OSO', 'OSA', 'ADOR', 'ADORA', 'ACION',
]

const A_MIN = 3
const LARGO = 5

/** Mayusculas, sin acentos, sin enye, solo letras y numeros. */
export function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita las tildes combinantes
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** La raíz de una palabra: sin terminación genérica, con margen de seguridad. */
export function raiz(palabra) {
  let p = palabra
  for (const t of TERMINACIONES) {
    if (p.endsWith(t) && p.length - t.length >= A_MIN) { p = p.slice(0, -t.length); break }
  }
  // Sin terminacion que quitar, la palabra se recorta a cinco letras. Se
  // prefiere «ALCOH» a «ALCOHOL»: el SKU es corto a proposito, para que se lea
  // de un vistazo en una etiqueta y no se corte en una caja.
  if (p.length > LARGO) p = p.slice(0, LARGO)
  return p
}

/**
 * La palabra que manda: la primera con información, saltando las vacías y los
 * números sueltos («500 ml» no es el nombre de nada).
 */
function palabraClave(nombre) {
  for (const p of normalizar(nombre).split(' ')) {
    if (p.length < A_MIN) continue
    if (VACIAS.has(p)) continue
    if (/^[0-9.]+$/.test(p)) continue
    return p
  }
  return ''
}

/**
 * Propone un SKU para un nombre y un tipo. NO toca la base: es una función
 * pura, y por eso se puede probar sin base de datos ninguna.
 *
 * @param {string} nombre  «Alcohol isopropílico»
 * @param {string} kind    'RAW_MATERIAL' | 'PACKAGING' | 'FINISHED_GOOD'
 * @param {string[]} existentes  SKUs que ya hay en el catálogo
 * @returns {string} el código propuesto
 */
/**
 * El grano fino, cuando el nombre lo trae: la concentración.
 *
 * «Alcohol isopropílico» y «Alcohol isopropílico 96 %» empiezan por la misma
 * palabra, así que la raíz les daba el mismo código: dos artículos distintos
 * con el mismo SKU, que es justo el lío que el SKU automático tenía que
 * evitar. Con el porcentaje dentro del código —RM-ALCOH-96 y RM-ALCOH-70— cada
 * material tiene el suyo, y se leen solos en una etiqueta.
 *
 * Solo se mira el PORCENTAJE, no cualquier número. «Botella 500 ml» no lleva
 * el 500 dentro porque el 500 es el formato, no lo que distingue una botella de
 * otra; si metiéramos cualquier número, dos botellas de 500 ml de distinto
 * proveedor acabarían con códigos distintos, y eso no es lo que hace a un
 * artículo distinto de otro.
 */
export function grano(nombre) {
  const m = String(nombre || '').match(/(\d{1,3})(?:[.,](\d{1,2}))?\s*%/)
  if (!m) return ''
  return m[2] ? m[1] + '.' + m[2] : m[1]
}

export function proponerSku(nombre, kind, existentes = []) {
  const prefijo = PREFIJO_SKU[kind] || 'ART'
  const ya = new Set(existentes.map((s) => String(s).toUpperCase()))
  const clave = palabraClave(nombre)
  // La base tiene que CUMPLIR el CHECK de la base — `[A-Z0-9][A-Z0-9._-]{2,30}`,
  // o sea tres caracteres como mínimo. Con un nombre de una letra, «RM» se
  // queda en dos y PostgreSQL lo rechaza con un 23502 en el INSERT, que es un
  // error de servidor por culpa de un nombre. Si no hay palabra clave, se dice
  // con el propio código: RM-NUEVO, que además dice en mayúsculas que aquí no
  // había nada que deducir.
  const fino = grano(nombre)
  const sufijo = clave ? raiz(clave) : 'NUEVO'
  const base = fino ? `${prefijo}-${sufijo}-${fino}` : `${prefijo}-${sufijo}`
  if (!ya.has(base)) return base
  // Ya hay uno igual. No se inventa un código raro: se numeran, que es lo que
  // un humano haría, y la pantalla avisa para que compruebe si es el mismo
  // artículo o uno nuevo.
  for (let n = 2; n < 200; n++) {
    const cand = `${base}-${n}`
    if (!ya.has(cand)) return cand
  }
  return `${base}-${Date.now()}`
}

/**
 * Compara dos nombres ignorando mayúsculas, acentos, espacios y signos.
 *
 * Es lo que permite decir «este material YA EXISTE, selecciónalo» en vez de
 * dejar que se cree un segundo artículo con otro nombre y el mismo contenido.
 */
export function mismoNombre(a, b) {
  const x = normalizar(a).replace(/ /g, '')
  const y = normalizar(b).replace(/ /g, '')
  return x.length > 0 && x === y
}

/**
 * Lo que la pantalla necesita al teclear el nombre: un código propuesto, si el
 * artículo ya existe de verdad, y si el código propuesto choca con otro.
 *
 * Se comparan los nombres aquí y no en el navegador, porque el catálogo entero
 * no cabe en la pantalla y la comparación tiene que ser contra la base.
 */
export async function sugerirSku(nombre, kind) {
  const limpio = String(nombre || '').trim()
  if (!limpio) return { sku: null, existente: null, colision: false }

  const items = await query(
    'SELECT id, sku, name, category_kind FROM items WHERE is_active = true',
  )
  const delTipo = items.filter((i) => i.category_kind === kind)

  // El nombre manda, no el código: si ya existe un artículo con ese nombre, se
  // devuelve cuál es para que la persona lo SELECCIONE en vez de crear un
  // segundo igual con otro código.
  const existente = delTipo.find((i) => mismoNombre(i.name, limpio)) || null

  // Y siempre se propone un código, también con el catálogo vacío: el primer
  // artículo de la vida es justo cuando más lo necesita. Cuándo llamar a esto
  // —al teclear, al perder el foco— lo decide la pantalla, no el servidor.
  const sugerido = proponerSku(limpio, kind, items.map((i) => i.sku))

  return {
    sku: sugerido,
    existente: existente ? { id: existente.id, sku: existente.sku, name: existente.name } : null,
    // Choca si el código propuesto es el de OTRO artículo con otro nombre. Es
    // el caso de «Alcohol 70 %» cuando ya existe «Alcohol 96 %»: son dos
    // artículos y el código tiene que distinguirlos, no igualarlos.
    colision: !!(sugerido && !existente
      && items.some((i) => i.sku === sugerido && !mismoNombre(i.name, limpio))),
  }
}
