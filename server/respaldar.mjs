/**
 * RESPALDO DE LA BASE DE SAHEL.
 *
 * PIDE EL VOLCADO AL SERVIDOR, no lo saca él mismo.
 *
 * POR QUÉ NO SE ABRE LA BASE DESDE AQUÍ
 *
 * PGlite es un PostgreSQL DENTRO del proceso Node: un solo proceso, un solo
 * directorio. Un script que abre `.pgdata` mientras el servidor la tiene
 * abierta provoca un `Aborted()` del WebAssembly y deja la base marcada como
 * corrupta. Lo que se sabe de este proyecto: ha pasado tres veces.
 *
 * Es decir: el script de copia acababa ROMPIENDO lo que quería proteger. Se
 * cumplió de verdad la primera vez que se ejecutó, con el servidor en marcha.
 *
 * La solución es que el volcado lo haga quien ya tiene la base abierta — el
 * servidor—, y que este script solo recoja el resultado, lo firme y lo guarde.
 * Sin parar el servicio y sin dos instancias.
 *
 * El formato es lógico (JSON por tabla), no un `tar` del directorio: se puede
 * leer, comparar y restaurar en cualquier sitio, y va firmado con su sha256
 * para poder comprobar que no se corrompió por el camino.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ORIGEN = resolve(new URL('..', import.meta.url).pathname)
const BASE = process.env.SAHEL_URL || 'http://127.0.0.1:10000'
const USUARIO = process.env.SAHEL_USUARIO || 'admin'
const CLAVE = process.env.SAHEL_CLAVE || 'demo1234'
const DESTINO = process.env.RESPALDOS || join(ORIGEN, 'respaldos')
const CUANTAS_GUARDAR = Number(process.env.RESPALDOS_A_GUARDAR || 14)

const sello = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main() {
  const l = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USUARIO, password: CLAVE }),
  })
  if (!l.ok) throw new Error(`login devolvió ${l.status}${l.status === 429 ? ' (límite de intentos)' : ''}`)
  const { access } = await l.json()

  const r = await fetch(BASE + '/api/backup/volcado', { headers: { Authorization: 'Bearer ' + access } })
  if (!r.ok) throw new Error(`el volcado devolvió ${r.status}`)
  const crudo = await r.text()

  const suma = createHash('sha256').update(crudo).digest('hex')
  const datos = JSON.parse(crudo)

  const carpeta = join(DESTINO, `respaldo-${sello()}`)
  mkdirSync(carpeta, { recursive: true })
  writeFileSync(join(carpeta, 'datos.json'), crudo)
  writeFileSync(join(carpeta, 'resumen.json'), JSON.stringify({
    generado: datos.generado,
    sha256: suma,
    bytes: Buffer.byteLength(crudo),
    tablas: Object.keys(datos.tablas).length,
    filas: datos.filas,
    con_datos: Object.entries(datos.tablas).filter(([, v]) => v.length).map(([k, v]) => [k, v.length]),
  }, null, 2))

  console.log(`respaldo ${carpeta.split('/').pop()} · ${Object.keys(datos.tablas).length} tablas · ${datos.filas} filas · ${(Buffer.byteLength(crudo) / 1024).toFixed(1)} KiB`)

  // ── Rotación ──────────────────────────────────────────────────────────────
  // Sin esto, «copias automáticas» quiere decir un disco lleno dentro de seis
  // meses, que es la forma más común de que las copias dejen de hacerse.
  const antiguas = readdirSync(DESTINO)
    .filter((n) => n.startsWith('respaldo-'))
    .map((n) => ({ n, t: statSync(join(DESTINO, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const v of antiguas.slice(CUANTAS_GUARDAR)) {
    rmSync(join(DESTINO, v.n), { recursive: true, force: true })
    console.log(`  rotacion: se retira ${v.n}`)
  }
}

main().catch((e) => {
  console.error('FALLO EL RESPALDO:', e.message)
  process.exitCode = 1
})
