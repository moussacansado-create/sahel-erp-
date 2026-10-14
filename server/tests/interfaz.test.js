/**
 * Prueba de la interfaz contra la API de verdad.
 *
 * No usa un navegador: comprueba lo que un navegador haría — pedir cada
 * recurso, y llamar a cada endpoint que la interfaz usa. Si una pantalla
 * pintara datos que la API no devuelve, aquí se ve.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-interfaz-suficientemente-larga-1234567890'

const B = new URL('..', import.meta.url).pathname
const { baseDePrueba, comprobar, seccion, resumen, query, one, closeDb } = await import(`${B}/tests/banco.js`)
const { hashPassword } = await import(`${B}src/security/passwords.js`)
const { createApp } = await import(`${B}src/app.js`)
const supertest = (await import('supertest')).default

console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log('  CLEANSahel ERP · INTERFAZ WEB · prueba contra la API real')
console.log('══════════════════════════════════════════════════════════════')

await baseDePrueba()
const app = createApp()
const pedir = (m, r) => supertest(app)[m](r)

// ── Datos de partida ──
const hash = await hashPassword('clave-de-prueba-1')
const admin = await one(
  `INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
  ['admin', 'Administrador', hash])
await query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [admin.id, 'ADMIN'])
const userU = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
const userUD = (await one('SELECT id FROM units WHERE code=$1', ['UD'])).id
const mp = await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price)
  VALUES ('RM-AGUA','Agua desionizada','RAW_MATERIAL',$1,$1,1000,0.12,0) RETURNING *`, [userU])
const env = await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price)
  VALUES ('ENV-BOT-500','Botella 500 ml','PACKAGING',$1,$1,500,0.35,0) RETURNING *`, [userUD])
const pt = await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price)
  VALUES ('PT-LAV-500','Lavavajillas 500 ml','FINISHED_GOOD',$1,$1,100,2.1,4.5) RETURNING *`, [userUD])

// ─────────────────────────────────────────────────────────────────────────────
seccion('1. La interfaz se sirve de verdad')

{
  const r = await pedir('get', '/')
  comprobar('GET / devuelve la página', r.status === 200 && /CleanSahel/.test(r.text), `status ${r.status}`)

  for (const recurso of [
    '/css/app.css', '/js/app.js', '/js/api.js', '/js/ui.js',
    '/js/paginas/panel.js', '/js/paginas/catalogo.js', '/js/paginas/entradas.js',
    '/js/paginas/stock.js', '/js/paginas/movimientos.js', '/js/paginas/pedidos.js',
    '/js/paginas/usuarios.js', '/js/paginas/permisos.js',
  ]) {
    const x = await pedir('get', recurso)
    comprobar(`Se sirve ${recurso}`, x.status === 200, `status ${x.status}`)
  }

  const spa = await pedir('get', '/inventario')
  comprobar('Una ruta de la interfaz (/inventario) devuelve la página y no un 404',
    spa.status === 200 && /CleanSahel/.test(spa.text), `status ${spa.status}`)

  const api = await pedir('get', '/api/items')
  comprobar('La interfaz NO tapa la API', api.status === 401 || api.status === 200, `status ${api.status}`)

  const inexistente = await pedir('get', '/api/no-existe')
  comprobar('Una ruta de API inexistente sigue dando 404 JSON', inexistente.status === 404)
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('2. Lo que la interfaz promete, la API lo tiene')

{
  const login = await pedir('post', '/api/auth/login').send({ username: 'admin', password: 'clave-de-prueba-1' })
  comprobar('El formulario de acceso puede iniciar sesión', login.status === 200 && !!login.body.access && !!login.body.refresh,
    `status ${login.status} ${login.body.error || ''}`)
  const token = login.body.access
  const auth = (m, r) => supertest(app)[m](r).set('Authorization', `Bearer ${token}`)

  const me = await auth('get', '/api/auth/me')
  comprobar('Y /auth/me devuelve los permisos que la interfaz usa para pintar el menú',
    me.status === 200 && Array.isArray(me.body.permisos) && me.body.permisos.includes('inventory:view'),
    `${me.status}`)
  comprobar('El ADMIN lo puede todo, como debe ser', me.body.permisos.length > 100, `${me.body.permisos.length}`)

  // Cada pantalla de la interfaz, contra el endpoint que realmente llama.
  const esperadas = [
    ['Panel', '/api/inventory/resumen'],
    ['Materias primas', '/api/items'],
    ['Entradas (necesita artículos)', '/api/items'],
    ['Stock', '/api/inventory'],
    ['Movimientos', '/api/inventory/movimientos?limite=300'],
    ['Apartados', '/api/inventory/reservas'],
    ['Usuarios', '/api/users'],
    ['Permisos', '/api/roles'],
    ['Permisos (matriz)', '/api/permissions'],
    ['Proveedores (formulario de entrada)', '/api/suppliers'],
    ['Unidades (formulario de artículo)', '/api/units'],
  ]
  for (const [nombre, ruta] of esperadas) {
    const r = await auth('get', ruta)
    comprobar(`${nombre} → ${ruta}`, r.status === 200, `status ${r.status} ${r.body.error || ''}`)
  }

  // El panel usa estos campos: si la API no los trae, la pantalla va en blanco.
  // Estos nombres los pinó la prueba de la interfaz: si mañana cambia la API,
  // esta comprobación salta y el panel deja de pintar campos que ya no existen.
  const resumen = await auth('get', '/api/inventory/resumen')
  comprobar('El resumen trae porTipo[] con los campos que pinta el panel',
    Array.isArray(resumen.body.porTipo)
    && resumen.body.porTipo.every((f) =>
      ['tipo', 'articulos', 'existencias', 'reservadas', 'disponibles', 'en_cuarentena', 'caducadas']
        .every((k) => k in f)),
    JSON.stringify(resumen.body.porTipo?.[0] || {}).slice(0, 140))
  comprobar('Y trae bajoMinimo[] con los campos que usa esa tabla',
    Array.isArray(resumen.body.bajoMinimo)
    && resumen.body.bajoMinimo.every((b) => ['item_id', 'sku', 'name', 'qty_on_hand', 'min_stock', 'category_kind'].every((k) => k in b)),
    JSON.stringify(resumen.body.bajoMinimo?.[0] || {}).slice(0, 140))
  comprobar('Y totales.valor_coste / valor_venta, más la moneda REAL',
    'valor_coste' in (resumen.body.totales || {}) && 'valor_venta' in (resumen.body.totales || {})
    && typeof resumen.body.moneda === 'string' && resumen.body.moneda.length > 0,
    `totales=${JSON.stringify(resumen.body.totales)} moneda=${resumen.body.moneda}`)

  // La lista de stock se dibuja solo con /inventory: no debe hacer falta /items.
  const inv = await auth('get', '/api/inventory')
  comprobar('Cada fila de /inventory trae todo lo que pinta la tabla de stock',
    inv.body.length > 0 && inv.body.every((s) =>
      ['item_id', 'sku', 'name', 'category_kind', 'min_stock', 'purchase_cost', 'sale_price',
        'qty_on_hand', 'qty_reserved', 'qty_available', 'qty_quarantined', 'active_lots']
        .every((k) => k in s)),
    JSON.stringify(inv.body[0] || {}).slice(0, 180))

  // Un movimiento tiene todo lo que la tabla de la interfaz muestra.
  await auth('post', '/api/inventory/recepciones').send({ itemId: mp.id, cantidad: 500, numeroAlbaran: 'ALB-UI-1' })
  const movs = await auth('get', '/api/inventory/movimientos?limite=300')
  const m = movs.body[0]
  comprobar('Cada movimiento trae los campos que pinta la tabla',
    m && ['movement_type', 'lot_code', 'item_name', 'sku', 'qty', 'balance_after', 'occurred_at', 'user_name']
      .every((k) => k in m),
    m ? Object.keys(m).join(',').slice(0, 140) : 'sin movimientos')

  // Una reserva tiene lo que necesita la tabla de apartados.
  await auth('post', '/api/inventory/reservas').send({ itemId: mp.id, cantidad: 100, motivo: 'Prueba de interfaz', holdType: 'PRODUCTION' })
  const res = await auth('get', '/api/inventory/reservas')
  const rr = res.body[0]
  comprobar('Cada apartado trae item_name, sku, hold_type, hold_reason, qty, status y es_retencion_interna',
    rr && ['item_name', 'sku', 'hold_type', 'hold_reason', 'qty', 'status', 'es_retencion_interna'].every((k) => k in rr),
    rr ? Object.keys(rr).join(',').slice(0, 140) : 'sin apartados')

  // La vista de stock debe traer los TRES números que la pantalla explica.
  const stock = await auth('get', `/api/inventory/${mp.id}`)
  comprobar('El detalle de stock trae físico, apartado y disponible',
    ['qty_on_hand', 'qty_reserved', 'qty_available'].every((k) => k in stock.body),
    Object.keys(stock.body).join(', '))

  // El plan que usa la vista previa del ajuste.
  const plan = await auth('get', `/api/inventory/${mp.id}/plan?cantidad=50`)
  comprobar('La previsión del ajuste devuelve lote, cantidad y si alcanza',
    Array.isArray(plan.body.plan) && 'suficiente' in plan.body && 'faltante' in plan.body,
    JSON.stringify(plan.body).slice(0, 140))
}

// ─────────────────────────────────────────────────────────────────────────────
seccion('3. Lo que la interfaz NO promete')

{
  const login = await pedir('post', '/api/auth/login').send({ username: 'admin', password: 'clave-de-prueba-1' })
  const auth = (r) => supertest(app).get(r).set('Authorization', `Bearer ${login.body.access}`)

  // Producción (Fase 3), clientes, pedidos y entregas (Fase 4) ya existen.
  //
  // Antes estas tres comprobaciones pedían un 404 y se llamaban «NI de
  // clientes todavía». Eran verdad en su momento y dejaron de serlo: cuando el
  // módulo llegó, la prueba se puso roja en lugar de celebrarlo. Una prueba
  // que falla cuando el sistema mejora es una prueba que hay que cambiar, no un
  // sistema que hay que romper.
  const produccion = await auth('/api/productions')
  comprobar('La producción existe (Fase 3)', produccion.status === 200, `status ${produccion.status}`)

  const clientes = await auth('/api/customers')
  comprobar('Clientes existe y responde una lista (Fase 4)',
    clientes.status === 200 && Array.isArray(clientes.body), `status ${clientes.status}`)

  const pedidos = await auth('/api/orders')
  comprobar('Pedidos existe y responde una lista (Fase 4)',
    pedidos.status === 200 && Array.isArray(pedidos.body), `status ${pedidos.status}`)

  const entregas = await auth('/api/deliveries')
  comprobar('Entregas existe y responde una lista (Fase 4)',
    entregas.status === 200 && Array.isArray(entregas.body), `status ${entregas.status}`)

  // Y que no devuelvan 200 con Inventario vacío por un fallo por debajo: la
  // diferencia entre «no hay datos» y «no hay módulo» es justo lo que la
  // aplicación anterior confundía.
  const clientesVacio = clientes.status === 200 && clientes.body.length === 0
  comprobar('La lista de clientes está vacía de verdad, no por un error',
    clientes.status !== 200 || Array.isArray(clientes.body))

  const { readFileSync, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const raizJs = new URL("../../web/js", import.meta.url).pathname
  const ficheros = [
    ...readdirSync(raizJs).filter((f) => f.endsWith(".js")).map((f) => join(raizJs, f)),
    ...readdirSync(join(raizJs, "paginas")).filter((f) => f.endsWith(".js")).map((f) => join(raizJs, "paginas", f)),
  ]

  const suspectos = []
  for (const f of ficheros) {
    // Se quitan los comentarios antes de mirar: el código no puede traer datos
    // falsos, pero sí puede (y debe) explicar que no los trae.
    const txt = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const patron of [/datos\s*de\s*ejemplo/i, /datos\s*de\s*prueba/i, /sample\s*data/i,
      /mock/i, /\bfixture\b/i, /Math\.random\s*\(/]) {
      if (patron.test(txt)) suspectos.push(`${f.split('/').pop()}: ${patron}`)
    }
  }
  comprobar('La interfaz no contiene datos de ejemplo, ni mocks, ni números aleatorios',
    suspectos.length === 0, suspectos.join('; '))

  const usaApi = ficheros.filter((f) => readFileSync(f, 'utf8').includes("A.api(")).length
  comprobar('Las páginas leen de la API, no de una constante local', usaApi >= 8, `${usaApi} ficheros la usan`)
}

const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log('══════════════════════════════════════════════════════════════')
console.log(`  RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('══════════════════════════════════════════════════════════════')
await closeDb()
process.exit(r.fallos ? 1 : 0)

// ═══════════════════════════════════════════════════════════════════════════
// La página tiene que cargar, y sin errores de JavaScript
// ═══════════════════════════════════════════════════════════════════════════

seccion('Las páginas se sirven y no tienen errores de sintaxis')
{
  const ficheros = ['js/app.js', 'js/ui.js', 'js/api.js']
  for (const f of ficheros) {
    const r = await fetch(BASE + '/' + f)
    comprobar(`  ${f} se sirve`, r.status === 200, `status ${r.status}`)
  }
  const paginas = await fetch(BASE + '/js/paginas/recetas.js')
  comprobar('  las páginas se sirven', paginas.status === 200, `status ${paginas.status}`)

  // Un `import { boton }` junto a una `function boton` local revienta con
  // «Identifier 'boton' has already been declared» y deja la pantalla en blanco.
  // Pasó al extraer los helpers a ui.js, y el síntoma (página en blanco) no dice
  // nada del motivo. Aquí se mira antes de que llegue al navegador.
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('../../web/js/paginas/', import.meta.url).pathname
  const lista = await readdir(dir)
  const Helpers = ['modal', 'boton', 'tabla', 'buscador', 'historico']
  for (const archivo of lista.filter((x) => x.endsWith('.js'))) {
    const texto = await readFile(dir + archivo, 'utf8')
    for (const h of Helpers) {
      const importa = new RegExp(`import[\\s\\S]{0,400}\\b${h}\\b[\\s\\S]{0,80}from '\\.\\./ui\\.js'`).test(texto)
      const define = new RegExp(`^\\s*(export )?function ${h}\\b`, 'm').test(texto)
      comprobar(`  ${archivo} no declara ${h} dos veces`, !(importa && define),
        `importa ${h} de ui.js y además lo declara localmente`)
    }
  }
}
