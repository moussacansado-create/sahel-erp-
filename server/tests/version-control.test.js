/**
 * ¿ESTÁ EL CÓDIGO DENTRO DEL REPOSITORIO?
 *
 * Una línea de más en `.gitignore` puede dejar Git mirando hacia otro lado sin
 * que se note NADA: lo que ya estaba versionado sigue ahí, los tests pasan, la
 * aplicación funciona, y lo único que ha cambiado es que los ficheros NUEVOS
 * ya no se registran.
 *
 * Eso es exactamente lo que pasó con un `server/` a secas. La intención era
 * apartar la base de pruebas —y eso lo hace `server/.pgdata/`—, pero la línea
 * entera dejó de seguir todo lo que se crease por debajo del servidor. Todo lo
 * viejo parecía estar a salvo y, en realidad, lo único a salvo era lo viejo.
 *
 * Este test compara lo que hay en disco con lo que Git sigue, y falla si
 * aparece un fichero que Git no está mirando.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '../..')

const IGNORADOS = new Set(['node_modules', '.git', '.pgdata', '.pgdata-test',
  '.pgdata-test2', '.pgdata-suite3'])

function todoBajo(dir, salida = []) {
  for (const nombre of readdirSync(dir)) {
    if (IGNORADOS.has(nombre)) continue
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) todoBajo(ruta, salida)
    else salida.push(relative(RAIZ, ruta).split(sep).join('/'))
  }
  return salida
}

test('Git sigue TODOS los ficheros de código que hay en disco', () => {
  const enDisco = [
    ...todoBajo(join(RAIZ, 'server/src')),
    ...todoBajo(join(RAIZ, 'server/tests')),
    ...todoBajo(join(RAIZ, 'db/migrations')),
  ].filter((f) => /\.(js|mjs|sql)$/.test(f))

  const versionados = new Set(execFileSync('git', ['ls-files'], {
    cwd: RAIZ, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).split('\n').map((s) => s.trim()).filter(Boolean))

  const invisibles = enDisco.filter((f) => !versionados.has(f))
  assert.deepEqual(invisibles, [],
    `Git NO está siguiendo estos ficheros. Si existen en el disco pero no en el\n` +
    `repositorio, no se pierden al reiniciar el sandbox: no se guardan NUNCA.\n` +
    `Suele ser una regla demasiado amplia en .gitignore — ¿un \`server/\` a secas?\n` +
    invisibles.map((f) => `  · ${f}`).join('\n'))
})

test('el .gitignore no tapa directorios enteros del proyecto', () => {
  const reglas = readFileSync(join(RAIZ, '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)

  // Directorios de código que NUNCA deben estar ignorados en bloque. Cada uno
  // es un módulo entero que dejaría de existir para Git de un día para otro.
  const intocables = ['server/', 'server/src/', 'server/tests/', 'web/', 'db/',
    'db/migrations/', 'docs/', 'scripts/']

  const culpables = reglas.filter((r) => intocables.includes(r) ||
    intocables.some((d) => r.replace(/\/$/, '') === d.replace(/\/$/, '') && r.endsWith('/')))
  assert.deepEqual(culpables, [],
    `Estas reglas de .gitignore tapan módulos enteros del proyecto:\n` +
    culpables.map((r) => `  · ${r}`).join('\n') +
    `\nPara apartar una base usa la ruta completa (\`server/.pgdata/\`), nunca el padre.`)
})

test('el arranque del servidor existe y arranca desde server/', () => {
  // Recordatorio silencioso, no comprobación real: el servidor de demostración
  // tiene que arrancarse SIEMPRE desde `server/`. Si se arranca desde la raíz,
  // PGlite abre `../.pgdata` y el login falla con CREDENCIALES_INVALIDAS sin
  // decir por qué.
  assert.ok(existsSync(join(RAIZ, 'server/arrancar.mjs')),
    'server/arrancar.mjs tiene que seguir ahí')
})
