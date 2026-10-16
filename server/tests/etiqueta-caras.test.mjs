// Las DOS CARAS de la etiqueta, de punta a punta.
//
// No se mira el código: se mira el HTML que sale. Una etiqueta trasera que se
// genera con el texto dentro en la variable y no en el papel es un fallo que
// no se ve hasta que alguien la pega en una caja, y por eso la prueba R12
// busca las cadenas LITERALES en el HTML generado. Si el campo está en el
// array y no aparece en la salida, esto falla igual.
import { htmlEtiqueta, plantillaDeUnaEtiqueta } from '../src/core/etiqueta-html.js'
import { resolverCaras, faltaDeUnaCara } from '../src/core/etiquetas.js'

const base = {
  loteId: 1, loteInterno: 'PT-X-2026-000001', numeroEntrada: 1,
  sku: 'PT-LAVAV', articulo: 'Lavavajillas Sahel', unidad: 'Mililitro',
  cantidad: 12, identificadorPrincipal: 'PT-X-2026-000001',
}
const t1 = {
  face: 'TRASERA', lista: true,
  modo_uso: 'Diluir en agua caliente.',
  composicion: 'Agua y tensioactivos aniónicos.',
  dosificacion: '10 ml por litro de agua.',
}
const t2 = { face: 'TRASERA', lista: false, modo_uso: null, composicion: null, dosificacion: null }
const d = { face: 'DELANTERA', lista: true, titulo: 'Lavavajillas Sahel' }

const n = (h) => (h.split('class="et').length - 1)
let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

// ── DELANTERA ───────────────────────────────────────────────────────────────
const hD = htmlEtiqueta(base, '60x40', 1, [d])
chk(hD.includes('Lavavajillas Sahel'), 'R1 · la delantera lleva el nombre del producto')
chk(!hD.includes('Diluir') && !hD.includes('tensioactivos'), 'R1b · la delantera NO lleva texto de uso')

// ── TRASERA ─────────────────────────────────────────────────────────────────
const hT = htmlEtiqueta(base, '60x40', 1, [t1])
chk(hT.includes('Diluir en agua caliente.'), 'R2 · la trasera imprime el modo de uso')
chk(hT.includes('Agua y tensioactivos aniónicos.'), 'R2b · la trasera imprime la composición')
chk(hT.includes('10 ml por litro de agua.'), 'R2c · la trasera imprime la dosificación')
chk(hT.includes('PT-X-2026-000001'), 'R3 · la trasera conserva el código de lote')

// ── LAS DOS ─────────────────────────────────────────────────────────────────
const hB = htmlEtiqueta(base, '60x40', 1, [d, t1])
chk(n(hB) === 2, 'R4 · LAS_DOS produce 2 etiquetas')
chk(hB.includes('Diluir en agua caliente.') && hB.includes('Lavavajillas Sahel'),
  'R4b · LAS_DOS trae el contenido de las dos caras')

// ── COPIAS Y FORMATOS ───────────────────────────────────────────────────────
chk(n(htmlEtiqueta(base, '60x40', 3, [d])) === 3, 'R5 · tres copias = tres etiquetas')
chk(n(htmlEtiqueta(base, '60x40', 1)) === 1 && htmlEtiqueta(base, '60x40', 1).includes('Lavavajillas Sahel'),
  'R6 · sin parámetros: una etiqueta, como antes')
chk(hD.includes('width:60mm') && hD.includes('height:40mm')
  && hT.includes('width:60mm') && hT.includes('height:40mm'),
  'R7 · 60×40 en las dos caras, sin cambiar medidas')
const h50 = htmlEtiqueta(base, '50x30', 1, [t1])
chk(h50.includes('width:50mm') && h50.includes('height:30mm'),
  'R7b · 50×30 mantiene sus propias medidas')

// ── LA TRASERA INCOMPLETA ───────────────────────────────────────────────────
chk(faltaDeUnaCara(t2).length > 0 && !resolverCaras([d, t2], 'TRASERA').ok,
  'R8 · la trasera incompleta NO se imprime')
chk(resolverCaras([d, t2], 'DELANTERA').ok,
  'R9 · la delantera sí se imprime aunque la trasera esté rota')
chk(n(htmlEtiqueta(base, '60x40', 2, [d, t1])) === 4, 'R10 · LAS_DOS con 2 copias = 4 etiquetas')

// ── R12 · LA COMPROBACIÓN QUE FALLA SI EL TEXTO NO LLEGA AL PAPEL ──────────
//
// `faltaDeUnaCara` dice qué falta. Esta dice si lo que dice llegó AL HTML.
// Con el array bien y el filtro mal, la etiqueta PASA el control de campos y
// sale en blanco: por eso hace falta mirar la salida, no solo la entrada.
const obligatoria = ['Modo de uso', 'Composicion', 'Dosificacion']
const fueraDeLaTrasera = obligatoria.filter((campo) => {
  const valor = t1[campo.toLowerCase().replace(' ', '_') === 'modo_de_uso' ? 'modo_uso'
    : campo === 'Composicion' ? 'composicion' : 'dosificacion']
  return valor && !hT.includes(valor)
})
chk(fueraDeLaTrasera.length === 0,
  `R12 · los campos obligatorios de la trasera aparecen en el HTML (faltan: ${fueraDeLaTrasera.join(', ') || 'ninguno'})`)

// ── R13 · SIN RECURSIÓN ─────────────────────────────────────────────────────
//
// Si `plantillaDeUnaEtiqueta` llamara a `htmlEtiqueta`, pedir una etiqueta
// serait un RangeError. Con muchas etiquetas y muchas copias también.
let recursiva = false
try {
  htmlEtiqueta(base, '60x40', 40, [d, t1])
} catch (e) { recursiva = /Maximum call stack/.test(String(e.message)) }
chk(!recursiva, 'R13 · 40 copias × 2 caras sin desbordar la pila')

console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
