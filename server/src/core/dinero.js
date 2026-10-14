/**
 * EL DINERO, Y CÓMO SE GUARDA.
 *
 * Existe este fichero porque cada módulo de la aplicación tiene su manera
 * redondear —compras a dos decimales por línea, ventas a dos por línea, y la
 * base de datos a dos por columna— y los tres pierden lo mismo por sitios
 * distintos. Con volumen, eso es dinero que desaparece sin que ninguna
 * factura parezca estar mal.
 *
 * LA REGLA, EN UNA LÍNEA
 *
 *   Se guarda EXACTO. Se redondea AL PRESENTAR, y solo una vez.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ UN MÓDULO Y NO UNA FUNCIÓN SUELTA
 *
 * Redondear es tentador, rápido, y parece inocuo. Por eso hay querecogerlo en
 * un solo sitio y quitarlo de todos los demás. Una función `r2()` copiada en
 * cinco módulos es cinco reglas distintas con el mismo nombre, y en seis meses
 * no hay forma de saber cuál se ha copiado de cuál.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ CUENTAS ENTERAS Y NO DECIMALES
 *
 * `0.1 + 0.2` da `0.30000000000000004` en JavaScript. Y da
 * `0.30000000000000004` SIEMPRE, porque IEEE 754 representa los decimales en
 * binario de forma aproximada y siempre. No es un fallo de este código: es lo
 * que es aritmética en coma flotante.
 *
 * Con dos decimales nadie lo nota. Con cuatro, un pedido de 60.000 líneas de
 * 0,0001 acumula un error que ya no es ruido de último decimal, sino céntimos
 * que desaparecen de un total.
 *
 * Aquí no hay coma flotante en el camino crítico. Los importes viajan como
 * ENTEROS de diezmilésimas: 12,3456 FCFA son 123456. Sumar y restar enteros
 * es exacto, siempre, sin excepciones que recordar. Solo se vuelve a decimal
 * al final, al devolver el número.
 *
 * Y el orden importa: se guarda a la precisión de la COLUMNA y se redondea al
 * MOSTRAR. Redondear antes de guardar no es presentar: es decidir que ese
 * número es el bueno cuando todavía no existe.
 *
 * `NUMERIC` de PostgreSQL ya es exacto por el mismo motivo, y la base es
 * donde de verdad se guardan las cifras definitivas. Este módulo cubre el
 * camino de JavaScript, que es donde se calculan los totales antes de llegar
 * allí.
 *
 * Y el orden correcto es el inverso al intuitivo: primero se guarda a la
 * precisión de la COLUMNA y después se redondea para MOSTRAR. Al revés, el
 * redondeo happens antes de que exista el número que hay que redondear.
 */

import { one as dbOne } from '../db/client.js'

/**
 * TRES PRECISIONES DISTINTAS, Y NO ES QUE HAYA SIDO REDUNDANTE.
 *
 *   TRABAJO   8 decimales  — con lo que se calculan los documentos
 *   GUARDADO  4 decimales  — lo que caben en las columnas, NUMERIC(18,4)
 *   PANTALLA  0 en XOF     — lo que ve una persona
 *
 * La primera versión acumula a 4, igual que el guardado, y eso ya pierde: un
 * IVA del 21 % sobre 0,3702 da 0,077742, que a cuatro decimales se queda en
 * 0,0777. Se pierden 0,000042 POR LÍNEA, y en cien mil líneas son 4,2 FCFA.
 *
 * Es el mismo error del que=hacerse este módulo, pero con un sitio menos
 * donde esconderse. La cuenta tiene que ser MÁS precisa que la columna: si
 * no, al escribir se pierde lo que se ha calculado con más cuidado del
 * necesario, y no hay forma de recuperarlo porque nadie miró nunca.
 */
export const PRECISION_TRABAJO = 8
export const PRECISION_GUARDADO = 4
const FACTOR = 10 ** PRECISION_TRABAJO
const MAX_SEGURO = Number.MAX_SAFE_INTEGER

/**
 * Convierte un importe a enteros de diezmilésimas de trabajo.
 *
 * Devuelve un ENTERO, no un decimal: a partir de aquí ya no hay coma
 * flotante en el recorrido. Redondea en la frontera, que es el último punto
 * donde se puede hacerlo sin arrastrar error al resto de la cuenta.
 */
export function aEnteros(importe) {
  const n = Number(importe ?? 0)
  if (!Number.isFinite(n)) return 0
  // Se va por Math.round y no por truncado: 0,00005 redondeado a cuatro
  // decimales es 0,0001, y truncarlo daría 0. Un redondeo «hacia abajo» en un
  // importe es una pérdida de dinero con apariencia de exacta.
  const entero = Math.round(n * FACTOR)
  // Por encima de esto, guardar en un entero de JS empieza a perder los
  // decimales uno mismo (2^53). Con veinte dígitos de margen es inalcanzable
  // para un ERP de una empresa, pero se avisa en vez de dar un número falso.
  if (Math.abs(entero) > MAX_SEGURO) {
    throw new RangeError(
      `Importe fuera de rango para calcular en enteros: ${importe}. ` +
      `El máximo exacto es ${MAX_SEGURO / FACTOR}.`)
  }
  return entero
}

/** Vuelve de enteros de diezmilésimas de trabajo a número decimal. */
export function deEnteros(entero) {
  return entero / FACTOR
}

/**
 * Una cuenta que NO redondea por el camino.
 *
 * Todos los cálculos de un documento —líneas, descuentos, IVA, subtotal,
 * total— ocurren dentro de aquí y salen exactos. El redondeo, si lo hay, ocurre
 * DESPUÉS, una vez, sobre el resultado.
 *
 *   const cuenta = cuentaMonetaria()
 *   for (const linea of lineas) cuenta.suma(linea.base)
 *   cuenta.suma(linea.base * iva)
 *   cuenta.total()          // ← un solo número, ya redondeado si hace falta
 *
 * Suma, resta, multiplica por un factor y acumula subtotales, sin que ninguna
 * de esas operaciones pierda un decimal por el camino.
 */
export function cuentaMonetaria(moneda = null) {
  let total = 0

  const api = {
    moneda,

    /** Añade un importe. No redondea. */
    suma(importe) { total += aEnteros(importe); return api },
    /** Resta un importe. No redondea. */
    resta(importe) { total -= aEnteros(importe); return api },
    /** Multiplica TODO lo acumulado por un factor. No redondea. */
    // El factor también se pasa por enteros y se vuelve a bajar de escala. Si
    // se multiplicara en coma flotante, 0,21 × 3702000000 daría
    // 777419999.9999999 en lugar de 777420000, y el error entraría por la
    // puerta de atrás justo después de haberlo cerrado por la otra.
    escala(factor) { total = Math.round(total * aEnteros(factor) / FACTOR); return api },
    /** Añade el contenido de otra cuenta. No redondea. */
    anade(otra) { total += aEnteros(typeof otra === 'function' ? otra.total() : otra); return api },

    /** El total, en enteros de diezmilésimas de trabajo. Para seguir calculando. */
    entero() { return total },
    /** El total EXACTO de trabajo, en decimal. Para seguir calculando. */
    exacto() { return deEnteros(total) },
    /** El total con la precisión con la que se GUARDA. El último paso. */
    guardar() { return redondear(deEnteros(total), PRECISION_GUARDADO) },
    /** El total redondeado para presentarlo. Ver `redondearPara`. */
    total(decimales) {
      return decimales === undefined ? redondearPara(moneda, deEnteros(total))
        : redondear(deEnteros(total), decimales)
    },
  }
  return api
}

/** Suma una lista sin redondear ni un paso. */
export function sumaExacta(importes) {
  let total = 0
  for (const i of importes) total += aEnteros(i)
  return deEnteros(total)
}

/**
 * Redondeo explícito, para cuando de verdad toca.
 *
 * Se usa SOLO al presentar un documento o al cerrar un resultado final. Si te
 * pones a redondear aquí en medio de un cálculo, has vuelto a empezar.
 */
export function redondear(importe, decimales = 2) {
  const n = Number(importe ?? 0)
  if (!Number.isFinite(n)) return 0
  const f = 10 ** decimales
  //
  // EL SIGNO SE APLICA AL FINAL, NO AL PRINCIPIO.
  //
  // La versión anterior sumaba `Number.EPSILON` al número y redondeaba:
  //
  //   1,005 + EPSILON → 1,0050000000000001 → ×100 → 100,5      → 1,01  ✅
  //   −1,005 + EPSILON → −1,0049999999999999 → ×100 → −100,499… → −1,00 ❌
  //
  // El EPSILON empuja en una sola dirección, así que arreglaba los positivos y
  // rompía los negativos. Y no es un error de un céntimo en un caso raro: es
  // un redondeo que va siempre al mismo lado. Cada descuento, cada devolución,
  // cada nota de crédito se redondearía a favor de la casa, y la diferencia
  // se acumularía exactamente igual que se acumulaba el error de antes, pero
  // en la dirección contraria y por el motivo opuesto.
  //
  // Se redondea la MAGNITUD y se devuelve el signo aparte. El medio se va al
  // medio, venga del signo que venga.
  //
  const signo = n < 0 ? -1 : 1
  return signo * Math.round((Math.abs(n) + Number.EPSILON) * f) / f
}

/**
 * Cuántos decimales se muestran en cada moneda.
 *
 * XOF: ninguno. El franco CFA no se usa con céntimos, y enseña una cifra con
 * dos decimales sería fingir una precisión que el dinero no tiene.
 * EUR: dos, que es lo que usa cualquier factura en euros.
 */
export const DECIMALES_POR_MONEDA = { XOF: 0, EUR: 2 }

/** Redondea un importe como se presenta en esa moneda. */
export function redondearPara(moneda, importe) {
  return redondear(importe, DECIMALES_POR_MONEDA[moneda] ?? 2)
}

// ═══════════════════════════════════════════════════════════════════════════
// LA TASA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LA tasa que había en una fecha dada.
 *
 * Se LEE de la tabla, nunca se calcula ni se supone. Si no hay tasa para ese
 * día, no hay tasa: el documento no sale. Devolver «la última conocida» o
 * «1 por si acaso» produciría documentos falsos con toda la apariencia de
 * buenos, y ese es el peor sitio posible para un error de dinero.
 */
export async function tasaEn(monedaOrigen, fecha, tx = null) {
  const fila = await (tx ? tx.one : dbOne)(
    `SELECT rate FROM exchange_rates
      WHERE from_code = $1 AND to_code = $2 AND effective_from <= $3::date
      ORDER BY effective_from DESC LIMIT 1`,
    [monedaOrigen, 'XOF', fecha])
  if (!fila) {
    const e = new Error(
      `No hay tipo de cambio de ${monedaOrigen} a XOF para el ${String(fecha).slice(0, 10)}. ` +
      `Sin tasa no hay documento: emitirlo con una cifra inventada sería falsear un papel.`)
    e.codigo = 'TASA_INEXISTENTE'
    e.estado = 422
    throw e
  }
  return Number(fila.rate)
}

/**
 * LA conversión. Una sola, y todos los módulos pasan por aquí.
 *
 * `1,50 EUR × 655,957 = 983,9355 FCFA`, y eso es exactamente lo que se guarda:
 * sin redondear. El «984 FCFA» que verá el cliente es cosa de la
 * presentación, y se calcula DESPUÉS, sobre el total del documento.
 *
 * El resultado se guarda con la tasa que se ha usado. Un documento emitido
 * hoy conserva hoy su tasa mañana, aunque la tabla tenga otra para ese día.
 * Un papel no se reescribe porque se mueva el mercado.
 */
export function aXof(importe, tasa) {
  const exacta = cuentaMonetaria('XOF')
  exacta.suma(importe).escala(tasa)
  return { importe: exacta.exacto(), tasa: Number(tasa), moneda: 'XOF' }
}

/**
 * Cuánto se ha perdido —o ganado— al redondear para mostrar.
 *
 * Se anota, no se tira. Un total redondeado que no cuadra con la suma de sus
 * líneas es un documento que parece equivocado; esta cifra es la que explica
 * la diferencia, y la que revisa un contable cuando algo no le sale.
 */
export function diferenciaDeRedondeo(exacto, redondeado) {
  return Number((redondeado - exacto).toFixed(PRECISION_TRABAJO))
}
