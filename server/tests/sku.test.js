/**
 * Pruebas del SKU automático. SIN NAVEGADOR y SIN BASE DE DATOS.
 *
 * `proponerSku` es una función pura: si esto pasa, el código que sale de ella
 * es el mismo en el servidor, en la pantalla y en el futuro. Y no gasta ni un
 * intento de login, que es lo que hace que se pueda ejecutar después de cada
 * cambio sin esperar quince minutos.
 *
 * Se ejecuta con: node server/tests/sku.test.js
 */
import assert from 'node:assert/strict'
import { proponerSku, mismoNombre, raiz, PREFIJO_SKU } from '../src/core/sku.js'

let pruebas = 0
let fallos = 0
const L = (ok, t) => {
  pruebas++
  if (!ok) fallos++
  console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t)
}

console.log('  EL PREFIJO DEPENDE DEL TIPO, NO DEL NOMBRE')
L(proponerSku('Agua', 'RAW_MATERIAL', []) === 'RM-AGUA', 'materia prima → RM-')
L(proponerSku('Agua', 'PACKAGING', []) === 'ENV-AGUA', 'envase → ENV-')
L(proponerSku('Agua', 'FINISHED_GOOD', []) === 'PT-AGUA', 'producto terminado → PT-')
assert.deepEqual(Object.keys(PREFIJO_SKU).sort(), ['FINISHED_GOOD', 'PACKAGING', 'RAW_MATERIAL'])
L(true, 'los tres tipos tienen prefijo')

console.log('\n  LA RAÍZ: QUITA LA TERMINACIÓN GENÉRICA')
L(raiz('COLORANTE') === 'COLOR', 'COLORANTE → COLOR')
L(raiz('FRAGANCIA') === 'FRAG', 'FRAGANCIA → FRAG')
L(raiz('SURFACTANTE') === 'SURFA', 'SURFACTANTE → SURFA')
L(raiz('AGUA') === 'AGUA', 'AGUA → AGUA (sin terminación que quitar)')

console.log('\n  NOMBRES REALES DE FÁBRICA')
const casos = [
  ['Alcohol isopropílico', 'RAW_MATERIAL', 'RM-ALCOH'],
  ['Agua desionizada', 'RAW_MATERIAL', 'RM-AGUA'],
  ['Colorante azul cosmético', 'RAW_MATERIAL', 'RM-COLOR'],
  ['Fragancia limón', 'RAW_MATERIAL', 'RM-FRAG'],
  ['Surfactante líquido', 'RAW_MATERIAL', 'RM-SURFA'],
  ['Ácido cítrico', 'RAW_MATERIAL', 'RM-ACIDO'],
  ['Éter etílico', 'RAW_MATERIAL', 'RM-ETER'],
  ['Botella 500 ml PET', 'PACKAGING', 'ENV-BOTEL'],
  ['Tapa 500 mm', 'PACKAGING', 'ENV-TAPA'],
  ['Desinfectante 750 ml', 'FINISHED_GOOD', 'PT-DESIN'],
  ['Limpiador multiusos 1 L', 'FINISHED_GOOD', 'PT-LIMPI'],
]
for (const [nombre, tipo, esperado] of casos) {
  L(proponerSku(nombre, tipo, []) === esperado,
    `«${nombre}» → ${esperado}`)
}

console.log('\n  LAS PALABRAS QUE NO DICEN NADA SE SALTAN')
L(proponerSku('de Alcohol', 'RAW_MATERIAL', []) === 'RM-ALCOH', '«de Alcohol» no empieza por DE')
L(proponerSku('la Color', 'RAW_MATERIAL', []) === 'RM-COLOR', '«la Color» no empieza por LA')
L(proponerSku('500 ml Botella', 'PACKAGING', []) === 'ENV-BOTEL', '«500 ml…» salta el número')

console.log('\n  CUANDO EL CÓDIGO YA ESTÁ TOMADO')
const ya = ['RM-ALCOH', 'RM-AGUA', 'RM-AGUA-2', 'ENV-BOTEL']
L(proponerSku('Alcohol isopropílico 96%', 'RAW_MATERIAL', ya) === 'RM-ALCOH-96',
  'concentración distinta → la concentración va DENTRO del código, no numerada')
L(proponerSku('Alcohol isopropílico', 'RAW_MATERIAL', [...ya, 'RM-ALCOH-96']) === 'RM-ALCOH-2',
  'sin concentración y sin sitio libre → se numera')
L(proponerSku('Agua', 'RAW_MATERIAL', ya) === 'RM-AGUA-3', 'nombre corto ya tomado → el siguiente libre')
L(proponerSku('Botella 500 ml PET', 'PACKAGING', ya) === 'ENV-BOTEL-2', 'el mismo envase → numerado')
L(proponerSku('Alcohol isopropílico', 'RAW_MATERIAL', [...ya, 'RM-ALCOH-2']) === 'RM-ALCOH-3',
  'busca el primer libre, no el segundo')

console.log('\n  NUNCA UN CÓDIGO QUE LA BASE RECHACE')
// El CHECK de items.sku es ^[A-Z0-9][A-Z0-9._-]{2,30}$: tres a treinta y un
// caracteres. Un nombre demasiado corto no puede producir menos de tres.
const checkSku = /^[A-Z0-9][A-Z0-9._-]{2,30}$/
for (const nombre of ['x', '', '  ', '1', 'la', 'A', 'de', '@@@', '!!!', 'ÁÉÍÓÚ', '   a   b  ']) {
  const s = proponerSku(nombre, 'RAW_MATERIAL', [])
  L(checkSku.test(s), `${JSON.stringify(nombre).padEnd(14)} → ${s.padEnd(10)} cumple el CHECK`)
}

console.log('\n  EL CÓDIGO ES PERMANENTE: cambiar el nombre no lo cambia')
L(proponerSku('Alcohol isopropílico', 'RAW_MATERIAL', ['RM-ALCOH']) === 'RM-ALCOH-2',
  'el mismo nombre con el código ya tomado propone el siguiente, nunca reutiliza el mismo')

console.log('\n  DOS MATERIALES PARECIDOS NO SE FUNDEN')
L(mismoNombre('Alcohol 70%', 'Alcohol 96%') === false, '70 % y 96 % son artículos distintos')
L(mismoNombre('Agua desionizada', 'Agua') === false, '«Agua desionizada» y «Agua» son distintos')
L(proponerSku('Alcohol 70%', 'RAW_MATERIAL', ['RM-ALCOH']) === 'RM-ALCOH-70'
  && proponerSku('Alcohol 96%', 'RAW_MATERIAL', ['RM-ALCOH']) === 'RM-ALCOH-96',
  'y reciben códigos distintos, con la concentración dentro')
L(proponerSku('Botella 500 ml', 'PACKAGING', ['ENV-BOTEL']) !== 'ENV-BOT-500',
  'el tamaño NO va en el código: es el formato, no lo que distingue el artículo')
L(proponerSku('Alcohol isopropílico 96,5 %', 'RAW_MATERIAL', []) === 'RM-ALCOH-96.5',
  'con decimales también')

console.log('\n  LA COMPARACIÓN POR NOMBRE IGNORA LO QUE ESCRIBIR DISTINTO')
L(mismoNombre('Alcohol isopropílico', 'alcohol  isopropilico') === true, 'acentos, mayúsculas y espacios')
L(mismoNombre('Agua', 'AGUA') === true, 'mayúsculas')
L(mismoNombre('', 'Agua') === false, 'un nombre vacío no es ningún material')
L(mismoNombre('', '') === false, 'dos vacíos tampoco')

console.log('')
if (fallos) {
  console.log(`  ${fallos} FALLO(S) de ${pruebas}`)
  process.exitCode = 1
} else {
  console.log(`  ${pruebas} pruebas, 0 fallos`)
}
