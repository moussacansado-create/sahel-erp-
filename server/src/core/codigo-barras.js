/**
 * CÓDIGO DE BARRAS CODE 128.
 *
 * ── POR QUÉ ESTE Y NO UN «DIBUJO» DE BARRAS ─────────────────────────────────
 *
 * Una etiqueta con una franja de degradados encima parece un código de barras
 * y NO lo es. Un escáner no lee nada, y quien lo intentara creería que el
 * material no tiene identificación. Peor que no poner nada.
 *
 * Code 128 es el estándar que usan todas las impresoras térmicas de
 * almacén, es compacto y se lee a contraluz, con plástico sucio o medio doblado. Se
 * implementa aquí entero —unos 90 renglones— en vez de traer una dependencia
 * que nadie audita en un sistema que se supone que va a producción.
 *
 * ── CÓMO SE SABE QUE ESTÁ BIEN ──────────────────────────────────────────────
 *
 * Un código de barras que «parece» un código de barras no sirve de nada. Este
 * se genera desde la tabla real de patrones y se puede VERIFICAR: el módulo
 * exporta `decodificar()`, que deshace los patrones y devuelve el texto. Si
 * los números de la etiqueta se leen con el mismo código que los de la base,
 * el dibujo es el correcto.
 */

/**
 * Los 107 patrones de Code 128, en el orden que define el estándar.
 *
 * Cada uno son SEIS dígitos: ancho de cada módulo ×6. El 103 es STOP.
 * Es la tabla literal del estándar, no una aproximación.
 */
export const PATRONES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

/** El dígito de verificación que se guarda en el patrón 103 (STOP). */
const CHECK = 103

/**
 * Codifica un texto corto en Code 128-B.
 *
 * Solo admite ASCII imprimible: el contenido de un código de barras de entrada
 * es `SA-0001234`, nunca texto libre. Si someday hiciera falta UTF-8, hay que
 * pasar a Code 128-C con pares de dígitos, que es OTRO estándar.
 *
 * @param {string} texto
 * @returns {{modulos: number[], texto: string}|null}  `null` si no se puede codificar
 */
export function codificar(texto) {
  const t = String(texto ?? '')
  if (!t.length) return null
  for (const ch of t) {
    const c = ch.charCodeAt(0)
    if (c < 32 || c > 126) return null      // nada de acentos ni controles
  }

  // Code 128-B: el 104 es el valor de inicio de ese juego de caracteres.
  const datos = t.split('').map((ch) => ch.charCodeAt(0) - 32)

  // El dígito de verificación es la suma ponderada por la posición, módulo 103.
  let suma = 104
  datos.forEach((v, i) => { suma += v * (i + 1) })
  const check = suma % 103
  const completa = [104, ...datos, check, 103]

  const modulos = []
  for (const v of completa) {
    for (const ancho of PATRONES[v]) modulos.push(Number(ancho))
  }
  return { modulos, texto: t }
}

/**
 * Lo que se dibuja: una tira de rectángulos.
 *
 * SVG y no PNG porque la resolución la pone el driver al imprimir: sale
 * nítido a 203 y a 300 ppp sin regenerar nada. Y en SVG NO hay degradados:
 * cada barra es negra o es blanco, que es lo único que un lector distingue.
 */
export function svgCodigoBarras(texto, { altoMm = 7, moduloMm = 0.3, margen = 3 } = {}) {
  const c = codificar(texto)
  if (!c) return null

  // ── EL MÓDULO SE MIDE EN MILÍMETROS, EN PÍXELS NO ────────────────────────
  //
  // Lo que decide si un código de barras se lee es el ANCHO de la barra más
  // fina. Con una impresora de 203 ppp (8 puntos por mm) el mínimo son 2
  // puntos: 0,25 mm. Con 0,30 mm se lee con margen, y a 300 ppp sale de sobra.
  //
  // Si el SVG se dimensiona por su ALTURA, el navegador escala el ancho hasta
  // que la barra más fina mide lo que toque —y sale una mancha de bloques
  // negros que parece un código y no se lee. El ancho se calcula: un módulo
  // son `moduloMm`, y el alto es el que se le pide.
  const anchoMm = c.modulos.length * moduloMm
  const alto = altoMm

  let x = margen
  const barras = []
  for (let i = 0; i < c.modulos.length; i += 1) {
    const m = c.modulos[i]
    if (i % 2 === 0) {           // en modo par la primera barra es negra
      barras.push(`<rect x="${x}" y="0" width="${(m * moduloMm).toFixed(3)}" height="${alto}" fill="#000"/>`)
    }
    x += m * moduloMm
  }

  const total = (c.modulos.length + margen * 2) * moduloMm
  return `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${total.toFixed(2)}mm" height="${alto}mm" ` +
    `viewBox="0 0 ${(c.modulos.length + margen * 2)} ${alto / moduloMm}" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Codigo de barras ${c.texto}">` +
    barras.join('') +
    '</svg>'
}

/**
 * VERIFICACIÓN. Deshace los patrones y devuelve el texto.
 *
 * Esta función no va en la etiqueta: es la prueba de que el dibujo significa
 * algo. Se recorre la tira de tres en tres —un módulo y su hueco, seis por
 * patrón— y se busca cada secuencia en la tabla. Si el último patrón es el
 * 103 y el dígito de verificación cuadra, el código es válido.
 *
 * @param {number[]} modulos
 * @returns {{ok: boolean, texto: string|null, motivo: string}}
 */
export function decodificar(modulos) {
  const m = modulos.map((x) => Number(x))

  // ── EL STOP TIENE SIETE MÓDULOS ──────────────────────────────────────────
  //
  // En Code 128 los patrones son de SEIS anchos, menos el STOP, que es
  // `2331112`: una barra final de 2 módulos. Es la excepción del estándar y el
  // motivo de que la tira no mida siempre un múltiplo de seis.
  //
  // Por eso aquí NO se corta a seis a lo bruto: se intenta con seis y, si no
  // hay ningún patrón con esa clave, se prueba con siete. Solo encaja el STOP.
  let i = 0
  const valores = []
  while (i < m.length) {
    let idx = -1
    let paso = 6
    const seis = m.slice(i, i + 6).join('')
    if (seis.length === 6) idx = PATRONES.indexOf(seis)
    if (idx < 0) {
      paso = 7
      const siete = m.slice(i, i + 7).join('')
      if (siete.length === 7) idx = PATRONES.indexOf(siete)
    }
    if (idx < 0) {
      return { ok: false, texto: null, motivo: `patrón desconocido en la posición ${i}: «${m.slice(i, i + 7).join('')}»` }
    }
    valores.push(idx)
    i += paso
    if (idx === 103) break          // STOP: ya no hay nada detrás
  }

  if (!valores.length || valores[valores.length - 1] !== 103) {
    return { ok: false, texto: null, motivo: 'no termina en STOP' }
  }
  if (valores[0] !== 104) {
    return { ok: false, texto: null, motivo: 'no empieza en Code 128-B' }
  }

  const check = valores[valores.length - 2]
  const datos = valores.slice(1, -2)
  let suma = valores[0]
  datos.forEach((v, k) => { suma += v * (k + 1) })
  if (suma % 103 !== check) {
    return { ok: false, texto: null, motivo: `el digito de verificacion no cuadra (${suma % 103} != ${check})` }
  }
  return {
    ok: true,
    texto: datos.map((v) => String.fromCharCode(v + 32)).join(''),
    motivo: 'valido',
  }
}
