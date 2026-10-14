/**
 * ALGUNOS COMERCIALES PARA PODER MIRAR LA PANTALLA.
 *
 * Usa `core/comerciales.js`, o sea la misma puerta que la API. No inserta
 * filas a mano: si esto escribiera directamente en `com_perfiles`, la pantalla
 * podría enseñar algo que el sistema nunca haría.
 *
 * NO toca el ERP. Solo crea usuarios (para poder entrar) y filas `com_*`.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  ?? 'clave-de-prueba-esto-no-es-real-1234567890123456789012345678901234567890'
process.env.PGLITE_DIR = process.env.PGLITE_DIR ?? '/workspace/cleansahel-v2/server/.pgdata'

const { query, one, closeDb } = await import('../src/db/client.js')
const { hashPassword } = await import('../src/security/passwords.js')
const C = await import('../src/core/comerciales.js')

//
// IDEMPOTENTE DE VERDAD.
//
// La primera versión comprobaba si había comerciales, pero las zonas se crean
// ANTES que ellos: si el script se caía a mitad, la segunda ejecución se
// moría en la primera zona por el código duplicado y no llegaba a comprobar
// nada. Ahora cada zona se busca antes de crearla.
//
const zonaPorCodigo = async (code, name, kind, idiomas) => {
  const ya = await one('SELECT * FROM com_zonas WHERE code = $1', [code])
  if (ya) return ya
  return C.crearZona({ code, name, kind, idiomas, usuarioId: admin.id })
}

const hash = await hashPassword('demo1234')

// ─── Usuarios ──────────────────────────────────────────────────────────────
// Se usan los usuarios que YA existen: 'comercial' y 'reparto'. La API y el
// módulo hablan con el sistema de usuarios del ERP, no con uno paralelo.
const admin = await one("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.code='ADMIN' ORDER BY u.id LIMIT 1")

// Permiso de ver Comerciales para quien lo tenga por rol.
for (const accion of ['view', 'create', 'edit']) {
  await query(`INSERT INTO permissions (module, action) VALUES ('commercial',$1) ON CONFLICT (module, action) DO NOTHING`, [accion])
}
await query(`
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module='commercial'
   WHERE r.code IN ('ADMIN','COMMERCIAL') ON CONFLICT DO NOTHING`)

// ─── Zonas ─────────────────────────────────────────────────────────────────
const zonas = []
for (const [code, name, kind, idiomas] of [
  ['DKR', 'Dakar Plateau', 'URBANA', [{ language: 'fr', peso: 90 }]],
  ['THS', 'Thies', 'RURAL', [{ language: 'fr', peso: 70 }]],
  ['KLB', 'Koulikoro', 'RURAL', [{ language: 'bm', peso: 100 }]],
]) {
  zonas.push(await zonaPorCodigo(code, name, kind, idiomas))
}
console.log(`  · ${zonas.length} zonas`)

// ─── Comerciales ────────────────────────────────────────────────────────────
const comerciales = [
  { username: 'comercial', full: 'Fatoumata Diallo', idiomas: ['fr', 'es'], zona: zonas[0], hired: '2024-03-01' },
  { username: 'reparto', full: 'Ibrahim Sow', idiomas: ['fr', 'bm'], zona: zonas[1], hired: '2024-09-15' },
  { username: 'reparto2', full: 'Awa Traore', idiomas: ['bm', 'ff'], zona: zonas[2], hired: '2025-02-01' },
]

const hechos = []
for (const c of comerciales) {
  const u = await one('SELECT id FROM users WHERE username = $1', [c.username])
  if (!u) { console.log(`  · ${c.username}: no existe como usuario, se salta`); continue }
  const p = await C.altaComercial({
    userId: u.id, idiomas: c.idiomas, zonaId: c.zona?.id ?? null,
    hiredOn: c.hired, usuarioId: admin.id,
  })
  hechos.push({ ...c, perfil: p, esNuevo: true })
}
console.log(`  · ${hechos.length} comerciales dados de alta`)

// Los objetivos y las visitas solo se crean la PRIMERA vez. Repetirlos cada
// vez que se arranca el módulo inflaría el ranking sin que nadie lo pidiera.

// ─── Objetivos del mes en curso ────────────────────────────────────────────
// Uno tiene objetivo; otro NO, a propósito: es lo que hay que ver en la
// pantalla, el «—» en vez de un 0 % que no significa nada.
const hoy = new Date()
const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10)
const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10)

await query(
  `INSERT INTO com_objetivos (comercial_id, period_start, period_end, target_amount, target_visits, notes)
   VALUES ($1,$2::date,$3::date,800000,12,'Pedir en la plaza y en el mercado')`,
  [hechos[0].perfil.id, primero, fin],
)
console.log('  · 1 objetivo puesto (el otro comercial NO tiene, a propósito)')

// ─── Visitas ───────────────────────────────────────────────────────────────
const clientes = await query('SELECT id FROM customers ORDER BY id LIMIT 4')
for (const [i, c] of clientes.entries()) {
  const resultado = ['ORDER_TAKEN', 'FOLLOW_UP_NEEDED', 'PRODUCT_SHOWN', 'NO_INTEREST'][i % 4]
  await C.registrarVisita({
    comercialId: hechos[0].perfil.id,
    clienteId: c.id,
    resultado,
    notas: resultado === 'ORDER_TAKEN' ? 'Pedido de dos cajas, vuelve el mes que viene'
      : resultado === 'FOLLOW_UP_NEEDED' ? 'Quiere probar el nuevo antes de decidir'
        : resultado === 'PRODUCT_SHOWN' ? 'Le enseñé las dos referencias'
          : 'Dice que ya tiene proveedor',
    nextAction: resultado === 'FOLLOW_UP_NEEDED' ? 'Volver con muestras' : null,
    usuarioId: admin.id,
  })
}
for (const c of hechos.slice(1)) {
  await C.registrarVisita({
    comercialId: c.perfil.id, resultado: 'PRODUCT_SHOWN', notas: 'Primera visita a la zona',
    usuarioId: admin.id,
  })
}
console.log(`  · ${clientes.length + hechos.length - 1} visitas registradas`)

await closeDb()
console.log('  demo de comerciales lista')
