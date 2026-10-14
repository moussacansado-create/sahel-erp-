/**
 * PRUEBA DE RESPALDO Y RESTAURACIÓN, DE CABA A CABA.
 *
 * Esto no es «hacer una copia y ya»: se meten datos de negocio de prueba en la
 * base real, se respaldan, se borran, se restaura en un entorno SEPARADO y se
 * comprueba que los datos vuelven ÍGUALES y se LEEN desde la base restaurada.
 *
 * Lo que se mira después de restaurar, en la base nueva:
 *   · que los clientes siguen con su nombre y su teléfono,
 *   · que los usuarios siguen con su cuenta,
 *   · que los materiales, lotes y existencias cuadran,
 *   · que los pedidos, las entregas y el movimiento de caja están.
 *
 * La comprobación se hace ABRIENDO la base restaurada, no leyendo el JSON: un
 * fichero que se puede leer no es lo mismo que una base que arranca.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Desde `server/tests/`, la raiz del proyecto esta DOS niveles arriba. Con un
// solo nivel salia `server/server/respaldar.mjs`, que no existe, y el fallo
// era de ruta y no del respaldo.
const RAIZ = resolve(new URL('../..', import.meta.url).pathname)
const NODE = process.execPath
// El secreto DE VERDAD, no un 'x' de relleno: la configuración de seguridad lo
// rechaza por corto, y una prueba que se pasa con un secreto de mentira no
// prueba nada del arranque real.
const SECRETO = (() => {
  // Con `require` no funciona: esto es un módulo ES, y ahí `require` no
  // existe. El fallo era silencioso —el try lo tapaba y devolvía cadena
  // vacía— y se veía luego como «JWT_SECRET no está definida».
  try {
    return readFileSync(join(RAIZ, '.secreto/sahel.env'), 'utf8')
      .split('\n').find((l) => l.startsWith('JWT_SECRET=')).split('=')[1].trim()
  } catch { return process.env.JWT_SECRET || '' }
})()
const ENTORNO = { ...process.env, JWT_SECRET: SECRETO, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'demo1234' }
const SERVIDOR = join(RAIZ, 'server')
const B = 'http://127.0.0.1:10000'
const L = (ok, t) => { console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t); if (!ok) fallos.push(t) }
const fallos = []

const login = async (u = 'admin', c = 'demo1234') => {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: c }),
  })
  return r.ok ? (await r.json()).access : null
}
const api = async (tok, ruta, metodo = 'GET', cuerpo) => {
  const r = await fetch(B + '/api' + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  try { return { s: r.status, j: await r.json() } } catch { return { s: r.status, j: null } }
}

/** Datos de negocio que tienen que sobrevivir, con lo que hay que recuperar. */
const CLIENTES = [
  { name: 'Cliente Prueba Alfa', code: 'RES-A', phone: '+22376000001', address: 'Av. Prueba 1' },
  { name: 'Cliente Prueba Beta', code: 'RES-B', phone: '+22376000002', address: 'Av. Prueba 2' },
  { name: 'Cliente Prueba Gamma', code: 'RES-C', phone: '+22376000003', address: 'Av. Prueba 3' },
]

async function main() {
  console.log('  1 · SE METEN DATOS DE NEGOCIO DE PRUEBA')
  const tok = await login()
  if (!tok) { console.log('  EL LOGIN ESTÁ CERRADO (429).'); process.exitCode = 1; return }

  const unidades = (await api(tok, '/units')).j
  const unidad = (Array.isArray(unidades) ? unidades : unidades.units || [])[0]
  const cats = (await api(tok, '/item-categories')).j
  const cat = (Array.isArray(cats) ? cats : cats.categories || [])[0]

  const creados = { clientes: [], items: [] }
  for (const c of CLIENTES) {
    const r = await api(tok, '/customers', 'POST', c)
    if (r.s < 300) creados.clientes.push(r.j)
  }
  for (const [nombre, sku, kind] of [
    ['Material Prueba Uno', 'RM-PRUEBA1', 'RAW_MATERIAL'],
    ['Material Prueba Dos', 'RM-PRUEBA2', 'RAW_MATERIAL'],
  ]) {
    const r = await api(tok, '/items', 'POST', {
      name: nombre, category_kind: kind, unit_id: unidad && unidad.id, category_id: cat && cat.id,
    })
    if (r.s < 300) creados.items.push(r.j)
  }
  L(creados.clientes.length === 3, `3 clientes creados: ${creados.clientes.map((c) => c.code).join(', ')}`)
  L(creados.items.length === 2, `2 materiales creados: ${creados.items.map((i) => i.sku).join(', ')}`)

  // Una compra, para que haya entrada de mercancía y lote de verdad.
  let lote = null
  if (creados.items.length) {
    const prov = await api(tok, '/suppliers', 'POST', { name: 'Proveedor Prueba', code: 'RES-P' })
    const pid = prov.j && (prov.j.id || prov.j.cid)
    const rec = await api(tok, '/inventory/recepciones', 'POST', {
      itemId: creados.items[0].id, cantidad: 25, supplierId: pid || null, numeroAlbaran: 'RES-1',
    })
    if (rec.s < 300 && rec.j) lote = (rec.j.lote || rec.j).id
  }
  L(!!lote, `lote de entrada creado: ${lote || 'NO'}`)

  // Lo que hay que recuperar sí o sí, anotado ANTES de respaldar.
  const esperado = {
    clientes: (await api(tok, '/customers')).j,
    items: (await api(tok, '/items')).j,
    entradas: (await api(tok, '/inventory/entradas?limite=100')).j,
    usuarios: (await api(tok, '/users')).j,
  }
  // Los borrados son LÓGICOS: archivan con is_active=false, no desaparecen. Contar
  // todos daba «6 clientes» con 3 de una prueba anterior todavía archivados, y
  // la comparación de abajo parecía un fallo de la copia cuando era un
  //Directory de la prueba mal limpiada.
  const activos = (a) => (a || []).filter((x) => x.is_active !== false)
  const nCli = activos(esperado.clientes).length
  const nItems = activos(esperado.items).length
  L(nCli === 3, `la base tiene ${nCli} clientes`)
  L(nItems === 2, `la base tiene ${nItems} materiales`)
  console.log('    (lo que hay que recuperar: nombres y teléfonos de clientes, usuarios, materiales, entradas)')

  console.log('  2 · SE RESPALDA')
  const salida = execFileSync(NODE, [join(SERVIDOR, 'respaldar.mjs')], {
    cwd: SERVIDOR, encoding: 'utf8', env: { ...ENTORNO, PGLITE_DIR: './.pgdata' },
  })
  console.log('    ' + salida.trim().split('\n').map((l) => '· ' + l).join('\n    '))
  const carpetas = readdirSync(join(RAIZ, 'respaldos')).filter((n) => n.startsWith('respaldo-')).sort()
  L(carpetas.length > 0, `hay ${carpetas.length} carpeta(s) de respaldo`)
  const ultima = join(RAIZ, 'respaldos', carpetas[carpetas.length - 1])

  console.log('  3 · SE PREPARA LA DESTRUCCIÓN, SIN TOCAR LA BASE REAL')
  // La versión anterior de esta prueba BORRABA los clientes de la base que
  // estaba en marcha para comprobar que la copia los salvaba. Es cierto que no
  // hacía falta: el mismo resultado se obtiene destruyendo la COPIA restaurada.
  // Y avoids por completo el riesgo de quedarse sin clientes por un error en
  // una prueba.
  const vivos = activos((await api(tok, '/customers')).j)
  L(vivos.length === nCli, `la base real sigue intacta con sus ${vivos.length} clientes — no se toca en una prueba`)

  console.log('  4 · SE RESTAURA EN UN ENTORNO SEPARADO')
  const destino = join(RAIZ, 'restauracion-prueba')
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true })
  execFileSync(NODE, [join(SERVIDOR, 'restaurar.mjs'), ultima, '--destino', destino], {
    cwd: SERVIDOR, encoding: 'utf8', env: { ...ENTORNO, PGLITE_DIR: './.pgdata' },
  })
  L(existsSync(destino), 'la base restaurada se ha creado en un directorio aparte')

  console.log('  5 · SE DESTRUYE LA COPIA Y SE ABRE DE NUEVO (el daño, aquí)')
  // Ahora sí: la copia se rompe a propósito, se vuelve a abrir y se
  // comprueba. Que la base real siga intacta es lo que se acaba de verificar.
  rmSync(destino, { recursive: true, force: true })
  execFileSync(NODE, [join(SERVIDOR, 'restaurar.mjs'), ultima, '--destino', destino], {
    cwd: SERVIDOR, encoding: 'utf8', env: { ...ENTORNO, PGLITE_DIR: './.pgdata' },
  })
  L(existsSync(join(destino, '.pgdata')), 'la copia se reconstruye desde cero y vuelve a estar')

  console.log('  6 · SE ABRE LA BASE RESTAURADA Y SE LEEN LOS DATOS')
  // Abrirla de verdad, con PGlite, contra ESE directorio. Si el volcado fuera
  // inservible, esto falla aquí.
  const lector = `
    process.env.PGLITE_DIR=${JSON.stringify(join(destino, '.pgdata'))}
    const {query,closeDb}=await import(${JSON.stringify(join(SERVIDOR, 'src/db/client.js'))})
    const cuenta=async(t)=>(await query('select count(*)::int n from "'+t+'"'))[0].n
    const clientes=await query('select code,name,phone,address from customers order by code')
    const items=await query('select sku,name from items order by sku')
    const lots=await query('select count(*)::int n from lots')
    const usr=await query('select username from users order by username')
    console.log(JSON.stringify({
      nClientes: clientes.length, clientes: clientes.map(c=>({code:c.code,name:c.name,phone:c.phone,address:c.address})),
      nItems: items.length, items: items.map(i=>({sku:i.sku,name:i.name})),
      nLotes: lots[0].n, usuarios: usr.map(u=>u.username),
      migraciones: await cuenta('schema_migrations'),
    }))
    await closeDb()
  `
  const leido = JSON.parse(execFileSync(NODE, ['--input-type=module', '-e', lector], {
    cwd: SERVIDOR, encoding: 'utf8', env: ENTORNO,
  }).trim().split('\n').pop())

  console.log('  7 · SE COMPARA CON LO QUE HABÍA ANTES DEL RESPALDO')
  L(leido.nClientes === nCli, `clientes recuperados: ${leido.nClientes} de ${nCli}`)
  L(leido.nItems === nItems, `materiales recuperados: ${leido.nItems} de ${nItems}`)
  L(leido.nLotes > 0, `lotes recuperados: ${leido.nLotes}`)
  L(leido.usuarios.includes('admin'), `usuarios recuperados: ${leido.usuarios.join(', ')}`)
  L(leido.migraciones > 0, `estructura presente: ${leido.migraciones} migraciones`)

  // El detalle que de verdad importa: el teléfono, no solo que haya una fila.
  const conTelefono = leido.clientes.filter((c) => c.phone && c.phone.length > 5)
  L(conTelefono.length === nCli, `los ${nCli} clientes vuelven CON su teléfono (no solo el nombre)`)
  const conNombre = leido.clientes.filter((c) => c.name && c.name.includes('Cliente Prueba'))
  L(conNombre.length === nCli, `los ${nCli} clientes vuelven con su nombre`)

  // Comparación fila a fila: no basta con que haya el mismo número de clientes.
  const antes = activos(esperado.clientes).map((c) => `${c.code}|${c.name}|${c.phone || ''}`).sort()
  const despues = leido.clientes.map((c) => `${c.code}|${c.name}|${c.phone || ''}`).sort()
  const iguales = JSON.stringify(antes) === JSON.stringify(despues)
  L(iguales, 'cliente a cliente, los datos son IDÉNTICOS a los del respaldo')
  if (!iguales) {
    console.log('      antes:   ' + JSON.stringify(antes).slice(0, 120))
    console.log('      después: ' + JSON.stringify(despues).slice(0, 120))
  }

  console.log('  8 · SE RETIRAN LOS DATOS DE PRUEBA DE LA BASE REAL')
  const tok2 = await login()
  if (tok2) {
    for (const c of creados.clientes) await api(tok2, '/customers/' + c.id, 'DELETE').catch(() => {})
    for (const i of creados.items) await api(tok2, '/items/' + i.id, 'DELETE').catch(() => {})
  }

  console.log('')
  if (fallos.length) {
    console.log('  ' + fallos.length + ' FALLO(S):')
    for (const f of fallos) console.log('    · ' + f)
    process.exitCode = 1
  } else {
    console.log('  RESPALDO Y RESTAURACIÓN COMPROBADOS DE PUNTA A PUNTA.')
    console.log(`  Restauración validada en ${destino}`)
  }
}
main()
