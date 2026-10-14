/**
 * TODOS LOS IMPORTS DE LA WEB TIENEN QUE EXISTIR
 *
 * ── POR QUÉ ESTE FICHERO ──────────────────────────────────────────────────
 *
 * Porque un `import` de un nombre que no existe NO es un error de sintaxis.
 *
 *   `node --check web/js/escaner.js`  →  «correcto»
 *   el navegador                        →  «The requested module './ui.js'
 *                                          does not provide an export named
 *                                          'numero'»
 *
 * Y ese error tumba la aplicación ENTERA, no una parte: `app.js` es un módulo
 * que importa `escaner.js`, así que un solo nombre mal escrito deja la web sin
 * JavaScript, con el formulario pintado y el botón sin hacer nada. Es
 * exactamente lo que pasó: se abrió la URL, se vio el login, y no se pudo
 * entrar porque el botón no estaba conectado a nada.
 *
 * Las pruebas de navegador que ya había NO lo cazaron: usan la aplicación con
 * una base de pruebas y entran por la API, no abriendo la URL. El fallo estaba
 * en la resolución de módulos, que ocurre antes de que haya nada que probar.
 *
 * ── POR QUÉ ESTO ES UN TEST Y NO UN SCRIPT ────────────────────────────────
 *
 * Porque un script que se ejecuta una vez y se arregla una vez es un script que
 * vuelve a aparecer. Lo que hay aquí es un invariante: todo lo que se importa
 * se exporta. Si mañana alguien escribe `import { pepe } from './ui.js'`, esto
 * se pone rojo antes de que llegue a un móvil.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const aqui = path.dirname(fileURLToPath(import.meta.url))
const JS = path.join(aqui, '..', '..', 'web', 'js')

/** Todos los `.js` de la web, en orden estable. */
function ficheros(dir) {
  const salida = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) salida.push(...ficheros(p))
    else if (e.name.endsWith('.js')) salida.push(p)
  }
  return salida.sort()
}

/** Los nombres que un módulo EXPORTA, tal cual se pueden importar. */
function exportaDe(fichero) {
  const src = fs.readFileSync(fichero, 'utf8')
  const nombres = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    nombres.add(m[1])
  }
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    nombres.add(m[1])
  }
  // export { a, b as c }  —  y sus formas multilínea
  for (const m of src.matchAll(/^export\s*\{([\s\S]*?)\}/gm)) {
    for (const trozo of m[1].split(',')) {
      const t = trozo.trim()
      if (!t) continue
      const como = t.split(/\s+as\s+/)
      nombres.add((como[1] || como[0]).trim())
    }
  }
  if (/^export\s+default\b/m.test(src)) nombres.add('default')
  return nombres
}

const EXPORTES = new Map(ficheros(JS).map((f) => [f, exportaDe(f)]))
const REL = (f) => path.relative(JS, f).split(path.sep).join('/')

test('ningún módulo importa un nombre que no exista', () => {
  const rotos = []
  for (const f of ficheros(JS)) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'(\.[^']+)'/g)) {
      const destino = path.resolve(path.dirname(f), m[2])
      const tiene = EXPORTES.get(destino)
      if (!tiene) {
        rotos.push(`${REL(f)} importa de ${m[2]}, que no está`)
        continue
      }
      for (const trozo of m[1].split(',')) {
        const t = trozo.trim()
        if (!t) continue
        // `a as b` importa `a` y lo renombra a `b`
        const original = t.split(/\s+as\s+/)[0].trim()
        if (!tiene.has(original)) {
          rotos.push(`${REL(f)} importa «${original}» de ${m[2]}, que no lo exporta`)
        }
      }
    }
  }
  assert.deepEqual(rotos, [],
    `estos imports no existen, y CADA UNO tumba la web entera:\n    · ${rotos.join('\n    · ')}`)
})

test('todos los ficheros JS de la web son sintácticamente válidos', () => {
  const { execFileSync } = require('node:child_process')
  const malos = []
  for (const f of ficheros(JS)) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
    } catch (e) {
      malos.push(`${REL(f)}: ${String(e.stderr).split('\n').slice(0, 2).join(' ')}`)
    }
  }
  assert.deepEqual(malos, [], `ficheros con errores de sintaxis:\n    · ${malos.join('\n    · ')}`)
})

//
// ── LOS QUE SE IMPORTAN Y NO SE USAN ──────────────────────────────────────
//
// El caso real fue `numero` en `escaner.js`: importado y nunca usado. No
// rompe nada hoy, pero un nombre que se importa sin usar es un nombre que un
// día se borra del módulo, y entonces sí rompe todo.
//
// Aquí NO se comprueba que no haya ninguno, porque hay 57 y son de hace
// tiempo: 57 pruebas rojas que nadie va a mirar, y un test que nadie
// mira es un test que se ignora.
//
// Lo que se comprueba es que no se AÑADAN más. Es una lista de referencia: lo
// que hay hoy se acepta, lo que aparezca mañana, no.
//
// Si algún día se limpian esos 57, se acorta la lista y se es un poco más
// estricto. Un invariante que solo se relaja nunca llega a valer para nada.
//
const YA_PASAN = new Set([
  "app.js importa «$» de ./ui.js y no lo usa",
  "paginas/albaranes.js importa «entero» de ../ui.js y no lo usa",
  "paginas/albaranes.js importa «lienzoFirma» de ../firma.js y no lo usa",
  "paginas/catalogo.js importa «cargando» de ../ui.js y no lo usa",
  "paginas/catalogo.js importa «entero» de ../ui.js y no lo usa",
  "paginas/clientes.js importa «buscador» de ../ui.js y no lo usa",
  "paginas/clientes.js importa «historico» de ../ui.js y no lo usa",
  "paginas/clientes.js importa «vacio» de ../ui.js y no lo usa",
  "paginas/cobros.js importa «panel» de ../ui.js y no lo usa",
  "paginas/compras.js importa «buscador» de ../ui.js y no lo usa",
  "paginas/entradas.js importa «estado» de ../ui.js y no lo usa",
  "paginas/entradas.js importa «fecha» de ../ui.js y no lo usa",
  "paginas/pedidos.js importa «vacio» de ../ui.js y no lo usa",
  "paginas/produccion.js importa «protegido» de ../ui.js y no lo usa",
  "paginas/recetas.js importa «fechaHora» de ../ui.js y no lo usa",
  "paginas/recetas.js importa «fecha» de ../ui.js y no lo usa",
  "paginas/stock.js importa «entero» de ../ui.js y no lo usa",
  "paginas/stock.js importa «fecha» de ../ui.js y no lo usa",
  "paginas/tarjeta.js importa «panel» de ../ui.js y no lo usa",
])

test('no se AÑADEN imports sin usar nuevos', () => {
  const nuevos = []
  for (const f of ficheros(JS)) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'(\.[^']+)'/g)) {
      const cuerpo = src.slice(m.index + m[0].length)
      for (const trozo of m[1].split(',')) {
        const t = trozo.trim()
        if (!t) continue
        const partes = t.split(/\s+as\s+/)
        const alias = (partes[1] || partes[0]).trim()
        if (!cuerpo.match(new RegExp(`\\b${alias}\\b`, 'g'))) {
          const linea = `${REL(f)} importa «${alias}» de ${m[2]} y no lo usa`
          if (!YA_PASAN.has(linea)) nuevos.push(linea)
        }
      }
    }
  }
  assert.deepEqual(nuevos, [],
    `imports sin usar NUEVOS (los ${YA_PASAN.size} que ya había se aceptan, y `
    + 'si se limpian hay que acortar la lista):\n    · ' + nuevos.join('\n    · '))
})
