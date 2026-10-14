/**
 * EL FILTRO POR CATEGORÍA DE `GET /api/items`
 *
 * Un 500. De los que no se ven.
 *
 * La condición del filtro era `ic.id = $n`, y `ic` no era el alias de nadie: la
 * consulta usa `i` para items, `u` para units, `c` para item_categories y `s`
 * para v_item_available. PostgreSQL contestaba «missing FROM-clause entry for
 * table "ic"» en cuanto alguien llamaba a `/api/items?categoria=3`.
 *
 * No se notaba porque la web NO USA este filtro: la página de catálogo carga
 * todos los artículos y los separa en memoria por `category_kind`. Así que el
 * 500 solo aparecía al llamar al endpoint a mano —o al integrarlo algo externo—,
 * que es la forma más discreta de tener un endpoint roto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE NO SE HA IDO A TOCAR
 *
 * El arreglo son cuatro palabras: `ic.id` pasa a ser `i.category_id`. Nada más.
 * La web sigue filtrando en memoria, `/items` sigue sin necesitar sesión de
 * lectura para devolver la lista, y los catálogos siguen siendo tres pestañas
 * de la misma pantalla. Aquí solo se comprueba que un endpoint que dice filtrar
 * por categoría, filtra por categoría.
 */

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-categoria-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const {
  baseDePrueba, comprobar, seccion, resumen, query, one, closeDb,
} = await import('./banco.js')
const { createApp } = await import('../src/app.js')
const { request } = await import('./supertest-helper.js')
const { hashPassword } = await import('../src/security/passwords.js')

let app = null
let token = null
let u = null

await baseDePrueba()
app = createApp()

//
// EL USUARIO LO CREA ESTA PRUEBA, NO LA SEMILLA.
//
// `baseDePrueba()` levanta el ESQUEMA, no los datos de demostración: aquí no
// existe ningún `admin` con contraseña `demo1234`, y pedirlo con esas
// credenciales devuelve CREDENCIALES_INVALIDAS y deja `token` en `undefined`.
//
// Se crea lo justo que hace falta, con su propia contraseña, igual que hace
// `auth.test.js`. Es deliberado: dos pruebas de cosas distintas no deben
// depender la una de la otra ni del contenido de los datos de demo.
//
const CONTRA = 'categoria-items-prueba-1'
await one(
  `INSERT INTO users (username, full_name, password_hash, password_changed_at)
   VALUES ('items_admin', 'Prueba de artículos', $1, now())`,
  [await hashPassword(CONTRA)])
await query(
  `INSERT INTO user_roles (user_id, role_id)
   SELECT (SELECT id FROM users WHERE username = 'items_admin'),
          (SELECT id FROM roles WHERE code = 'ADMIN')`)

const sesion = await request(app)
  .post('/api/auth/login')
  .send({ username: 'items_admin', password: CONTRA })
token = sesion.body.access

u = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id

// Una categoría POR TIPO: `item_categories` es única por (category_kind, name),
// así que dos categorías con el mismo nombre pero de tipos distintos sí
// conviven. De paso, el filtro se prueba con artículos de tipos diferentes:
// si el filtro fuera en realidad un filtro por tipo disfrazado, aquí se nota.
const catLimpieza = (await one(
  `INSERT INTO item_categories (category_kind, code, name)
   VALUES ('RAW_MATERIAL', 'LIM-DEMO', 'Limpieza')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).id
const catEnvases = (await one(
  `INSERT INTO item_categories (category_kind, code, name)
   VALUES ('PACKAGING', 'ENV-DEMO', 'Envases')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).id

const mpLimpio = (await one(
  `INSERT INTO items (sku, name, category_kind, unit_id, category_id, lot_prefix)
   VALUES ('CAT-DEMO-MP', 'Detergente demo', 'RAW_MATERIAL', $1, $2, 'CD')
   RETURNING id`, [u, catLimpieza])).id
const mpEnvaso = (await one(
  `INSERT INTO items (sku, name, category_kind, unit_id, category_id, lot_prefix)
   VALUES ('CAT-DEMO-ENV', 'Botella demo', 'PACKAGING', $1, $2, 'CD')
   RETURNING id`, [u, catEnvases])).id
// Un artículo SIN categoría, que es el caso que distingue una cosa de otra.
const mpSuelto = (await one(
  `INSERT INTO items (sku, name, category_kind, unit_id, lot_prefix)
   VALUES ('CAT-DEMO-NO', 'Sin categoría demo', 'RAW_MATERIAL', $1, 'CD')
   RETURNING id`, [u])).id

// ═══════════════════════════════════════════════════════════════════════════

seccion('Filtrar por categoría devuelve filas, no un 500')

{
  const r = await request(app)
    .get(`/api/items?categoria=${catLimpieza}`)
    .set('Authorization', `Bearer ${token}`)

  comprobar('responde 200 y no peta el servidor', r.status === 200,
    `status ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`)

  // Si el servidor devuelve un error en vez de una lista, esto NO es un array
  // y `.map` revienta la prueba entera con una excepción. Una prueba que se
  // cuelga no informa: hay que sacar las conclusiones primero y leer `ids` solo
  // cuando hay algo que leer.
  const esLista = Array.isArray(r.body)
  const ids = esLista ? r.body.map((x) => x.id) : []
  comprobar('devuelve el artículo de esa categoría', ids.includes(mpLimpio),
    `llegaron ${ids.length} ids`)
  comprobar('y NO devuelve los de otras categorías', !ids.includes(mpEnvaso))
  comprobar('ni los que no tienen ninguna', !ids.includes(mpSuelto),
    'un artículo sin categoría no es un artículo de la categoría X')
  comprobar('el artículo devuelto trae su `category_name`', esLista && r.body[0]?.category_name === 'Limpieza',
    `vino ${JSON.stringify(r.body?.[0]?.category_name)}`)
}

seccion('Una categoría vacía devuelve lista vacía, y no es un error')

{
  const vacia = (await one(
    `INSERT INTO item_categories (category_kind, code, name)
     VALUES ('FINISHED_GOOD', 'VACIA-DEMO', 'Vacía')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).id
  const r = await request(app)
    .get(`/api/items?categoria=${vacia}`)
    .set('Authorization', `Bearer ${token}`)
  comprobar('una categoría sin artículos devuelve [] y 200',
    r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    `status ${r.status}, ${JSON.stringify(r.body).slice(0, 80)}`)
}

seccion('Las dos categorías se distinguen entre sí')

{
  const a = await request(app).get(`/api/items?categoria=${catLimpieza}`)
    .set('Authorization', `Bearer ${token}`)
  const b = await request(app).get(`/api/items?categoria=${catEnvases}`)
    .set('Authorization', `Bearer ${token}`)
  const idsA = Array.isArray(a.body) ? a.body.map((x) => x.id) : []
  const idsB = Array.isArray(b.body) ? b.body.map((x) => x.id) : []
  comprobar('cada filtro devuelve lo suyo', idsA.includes(mpLimpio) && idsB.includes(mpEnvaso))
  comprobar('y no se solapan', !idsA.includes(mpEnvaso) && !idsB.includes(mpLimpio))
}

seccion('Un id de categoría que no existe no inventa filas')

{
  const r = await request(app).get('/api/items?categoria=999999')
    .set('Authorization', `Bearer ${token}`)
  comprobar('devuelve [] en vez de error o de un 500', r.status === 200 &&
    Array.isArray(r.body) && r.body.length === 0, `status ${r.status}`)
}

seccion('Filtrar por categoría se puede COMBINAR con los otros filtros')

{
  // Porque el filtro vive en la misma lista de condiciones que los demás, y esa
  // lista es la que se fue a starear. Si mañana alguien escribe mal uno de los
  // demás, este es el sitio donde se nota.
  const r = await request(app).get(`/api/items?categoria=${catLimpieza}&tipo=RAW_MATERIAL`)
    .set('Authorization', `Bearer ${token}`)
  // Si el servidor devuelve un error en vez de una lista, esto NO es un array
  // y `.map` revienta la prueba entera con una excepción. Una prueba que se
  // cuelga no informa: hay que sacar las conclusiones primero y leer `ids` solo
  // cuando hay algo que leer.
  const esLista = Array.isArray(r.body)
  const ids = esLista ? r.body.map((x) => x.id) : []
  comprobar('categoría + tipo devuelven la intersección',
    r.status === 200 && ids.includes(mpLimpio) && !ids.includes(mpEnvaso),
    `status ${r.status}`)

  // Y el filtro de búsqueda de texto, que también se suma a la misma cadena.
  const b = await request(app).get(`/api/items?categoria=${catLimpieza}&buscar=Detergente`)
    .set('Authorization', `Bearer ${token}`)
  comprobar('categoría + búsqueda textual también',
    b.status === 200 && Array.isArray(b.body) && b.body.map((x) => x.id).includes(mpLimpio),
    `status ${b.status}`)

  // Y `tipo=RAW_MATERIAL` a secas, que no dependía del bug pero comparte la
  // misma condición: se comprueba que sigue bien al tocar la línea de al lado.
  const t = await request(app).get('/api/items?tipo=RAW_MATERIAL')
    .set('Authorization', `Bearer ${token}`)
  comprobar('el filtro por tipo sigue funcionando',
    t.status === 200 && Array.isArray(t.body) &&
    t.body.every((x) => x.category_kind === 'RAW_MATERIAL'),
    `status ${t.status}`)
}

seccion('El endpoint no pide permiso de más')

{
  // Filtrar el catálogo es LEER. Si este filtro empezara a pedir algo más que
  // ver el catálogo, alguien no podría mirar un artículo desde una pantalla
  // donde el permiso es distinto. No se ha tocado el middleware, y esta es la
  // prueba de que sigue igual.
  const r = await request(app).get('/api/items')
  comprobar('sin sesión NO se listan (401)', r.status === 401, `status ${r.status}`)

  const conSesion = await request(app).get('/api/items')
    .set('Authorization', `Bearer ${token}`)
  comprobar('con sesión sí (200)', conSesion.status === 200)
}

await closeDb()

const r = resumen()
console.log(r.mensajes.join('\n'))
console.log('')
console.log(`    RESULTADO: ${r.ok} correctas, ${r.fallos} fallidas`)
console.log('')
if (r.fallos > 0) process.exitCode = 1
