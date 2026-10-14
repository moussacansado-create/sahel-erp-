/**
 * El conjunto de datos de demostracion, como FUNCION.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POR QUE ESTO ESTA SEPARADO DE `seed-demo.mjs`
 *
 * Porque el script de consola tira la base entera y la vuelve a montar, y hace
 * falta una barrera dura antes de hacerlo: el 5 de octubre de 2026 la demo se
 * recreo cinco veces y cada vez se llevo clientes y pedidos reales.
 *
 * Las pruebas necesitan esos MISMOS datos, pero no pueden tirar ninguna base.
 * Asi que la creacion vive aqui, y el script de consola se limita a decidir si
 * tira o no antes de llamarla.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * NO ES DESTRUCTIVA
 *
 * Esta funcion solo inserta. No hace DROP ni borra nada. Encima
 * `baseDePrueba()` ya deja la base limpia antes de que llegue aqui.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * OJO CON EL ALCANCE
 *
 * Los tests que la usan Apuntan a SU servidor, en un puerto libre, sobre la
 * base de pruebas. Nada de esto debe tocar `.pgdata`, que es la demo.
 */

/** Crea usuarios, proveedores, articulos, recetas, pedidos, entregas y caja. */
import { one, query, transaction, getDb } from '../src/db/client.js'
import { hashPassword } from '../src/security/passwords.js'

export async function sembrarDemo() {
  // El cuerpo viene de `seed-demo.mjs`, que resolvia sus imports con una
  // ruta absoluta. Aqui se calcula desde este propio fichero, para que el
  // modulo se pueda mover sin romperse.
  const B = new URL('..', import.meta.url).pathname
const hash = await hashPassword('demo1234')
// El nombre de usuario NO es el código del rol. Sin un roles nuevo, el almacén
// se queda con un usuario sin ningún permiso y el menú aparece vacío.
const USUARIOS = [
  ['admin',       'Administrador',        'ADMIN'],
  ['produccion',  'Jefatura Producción',  'PRODUCTION'],
  ['contabilidad','Contabilidad',         'ACCOUNTING'],
  ['reparto',     'Reparto',              'DELIVERY'],
  ['caja',        'Caja',                 'CAJAJERO'],
  ['comercial',   'Comercial',            'COMMERCIAL'],
]
for (const [u, nombre, rol] of USUARIOS) {
  const x = await one('INSERT INTO users (username, full_name, password_hash) VALUES ($1,$2,$3) RETURNING *', [u, nombre, hash])
  const r = await one('SELECT id FROM roles WHERE code = $1', [rol])
  if (!r) throw new Error(`No existe el rol ${rol}`)
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [x.id, r.id])
}
const L = (await one('SELECT id FROM units WHERE code=$1', ['L'])).id
const UD = (await one('SELECT id FROM units WHERE code=$1', ['UD'])).id
const KG = (await one('SELECT id FROM units WHERE code=$1', ['KG'])).id
const prov = await one(`INSERT INTO suppliers (code,name,contact_name,phone,email,country,payment_terms_days) VALUES ('PRO-0001','Química Sahel ML','Mamadou Traoré','+223 76 00 00 00','ventas@quimicasahel.ml','Malí',30) RETURNING *`)

const art = [
  ['RM-AGUA', 'Agua desionizada',            'RAW_MATERIAL', L,  20000,  0.12, null,   0],
  ['RM-SURF', 'Surfactante líquido',         'RAW_MATERIAL', L,   5000,  2.40, null,   0],
  ['RM-ALCO', 'Alcohol isopropílico 96%',    'RAW_MATERIAL', L,   3000,  3.10, null,   0],
  ['RM-COLOR','Colorante azul cosmético',    'RAW_MATERIAL', L,    200, 18.00, null,   0],
  ['RM-FRAG', 'Fragancia limón',             'RAW_MATERIAL', L,    150, 24.00, null,   0],
  ['ENV-BOT-500',  'Botella 500 ml PET',      'PACKAGING', UD,  5000,  0.34, '500 ml', 0],
  ['ENV-TAP-500',  'Tapa 500 mm',             'PACKAGING', UD,  5000,  0.12, '500 ml', 0],
  ['ENV-ETI-500',  'Etiqueta lava-vajillas',  'PACKAGING', UD,  8000,  0.05, '500 ml', 0],
  ['ENV-CJA-12',   'Caja de 12 unidades',     'PACKAGING', UD,  1000,  0.45, '12 uds', 0],
  ['PT-LAV-500', 'Lavavajillas 500 ml',       'FINISHED_GOOD', UD, 2000, 1.80, '500 ml', 4.50],
  ['PT-LIM-1L',  'Limpiador multiusos 1 L',   'FINISHED_GOOD', UD, 1200, 2.40, '1 L',    5.00],
  ['PT-DES-750', 'Desinfectante 750 ml',      'FINISHED_GOOD', UD,  800, 3.10, '750 ml', 6.50],
]
// La moneda NO se pone aquí.
//
// Estaba en 'EUR' a mano, y era el resto visible de una configuración que ya no
// existe: la base de la empresa es XOF desde `currencies.is_base`, y los
// artículos de un catálogo que factura en francos no pueden llevar el euro
// puesto uno a uno.
//
// Se omite a propósito, para que el artículo tome la moneda de la base por el
// DEFAULT de la columna. Si algún día el default se cambia, estos 12 productos
// lo siguen sin tener que editarse, que es justo lo que se quiere de un dato
// de configuración.
for (const [sku, name, kind, u, min, cost, fmt, sale] of art) {
  await one(`INSERT INTO items (sku,name,category_kind,unit_id,base_unit_id,min_stock,purchase_cost,sale_price,format_label,tax_rate)
    VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,0.21)`, [sku, name, kind, u, min, cost, sale, fmt])
}
const m = await import(`${B}/src/core/inventario.js`)
const admin = (await one('SELECT id FROM users WHERE username=$1', ['admin'])).id
const prod = (await one('SELECT id FROM users WHERE username=$1', ['produccion'])).id
const mp = async (sku) => (await one('SELECT id FROM items WHERE sku=$1', [sku])).id

await m.registrarEntrada({ itemId: await mp('RM-AGUA'), cantidad: 24000, caducidad: '2028-12-31', numeroAlbaran: 'ALB-2026-001', proveedorId: prov.id, costeUnitario: 0.12, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('RM-SURF'), cantidad: 6200, caducidad: '2027-09-30', numeroAlbaran: 'ALB-2026-001', proveedorId: prov.id, costeUnitario: 2.40, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('RM-ALCO'),  cantidad: 3400, caducidad: '2027-08-31', numeroAlbaran: 'ALB-2026-001', proveedorId: prov.id, costeUnitario: 3.10, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('RM-COLOR'), cantidad: 180,  caducidad: '2027-06-30', numeroAlbaran: 'ALB-2026-001', proveedorId: prov.id, costeUnitario: 18.00, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('RM-FRAG'),  cantidad: 140,  caducidad: '2027-06-30', numeroAlbaran: 'ALB-2026-001', proveedorId: prov.id, costeUnitario: 24.00, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('ENV-BOT-500'),  cantidad: 18000, numeroAlbaran: 'ALB-ENV-014', proveedorId: prov.id, costeUnitario: 0.34, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('ENV-TAP-500'),  cantidad: 18000, numeroAlbaran: 'ALB-ENV-014', proveedorId: prov.id, costeUnitario: 0.12, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('ENV-ETI-500'),  cantidad: 22000, numeroAlbaran: 'ALB-ENV-014', proveedorId: prov.id, costeUnitario: 0.05, usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('ENV-CJA-12'),   cantidad: 2000,  numeroAlbaran: 'ALB-ENV-014', proveedorId: prov.id, costeUnitario: 0.45, usuarioId: prod })

// Productos: un poco de stock por entrada y un par de ajustes
await m.registrarEntrada({ itemId: await mp('PT-LAV-500'), cantidad: 3400, caducidad: '2028-03-31', numeroAlbaran: 'FAB-2026-0001', usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('PT-LIM-1L'),  cantidad: 1450, caducidad: '2028-03-31', numeroAlbaran: 'FAB-2026-0001', usuarioId: prod })
await m.registrarEntrada({ itemId: await mp('PT-DES-750'), cantidad: 210,  caducidad: '2028-03-31', numeroAlbaran: 'FAB-2026-0001', usuarioId: prod })
await m.ajustarInventario({ itemId: await mp('PT-LAV-500'), cantidad: -46, motivo: 'Rotura de envase en línea 3', usuarioId: prod })
await m.ajustarInventario({ itemId: await mp('RM-FRAG'),  cantidad: -8,  motivo: 'Merma por evaporación en el almacén', usuarioId: prod })

// Retenciones internas: producción y control de calidad
await m.reservarInterno({ itemId: await mp('RM-SURF'), cantidad: 1200, motivo: 'Orden de producción FAB-2026-0002', holdType: 'PRODUCTION', usuarioId: prod })
await m.reservarInterno({ itemId: await mp('ENV-BOT-500'), cantidad: 4000, motivo: 'Orden de producción FAB-2026-0002', holdType: 'PRODUCTION', usuarioId: prod })
await m.reservarInterno({ itemId: await mp('PT-DES-750'), cantidad: 60, motivo: 'Muestra para control de calidad', holdType: 'QUALITY', usuarioId: prod })


// ── Recetas y producción ────────────────────────────────────────────────────
const { crearReceta } = await import(`${B}/src/core/recetas-servicio.js`)
const { producir } = await import(`${B}/src/core/produccion.js`)

const LAV = await mp('PT-LAV-500')
const LIM = await mp('PT-LIM-1L')
const AGU = await mp('RM-AGUA')
const SUR = await mp('RM-SURF')
const ALC = await mp('RM-ALCO')
const COL = await mp('RM-COLOR')
const FRA = await mp('RM-FRAG')
const BOT = await mp('ENV-BOT-500')
const TAP = await mp('ENV-TAP-500')
const ETI = await mp('ENV-ETI-500')

const recetaLav = await crearReceta({
  productId: LAV, name: 'Lavavajillas concentrado 500 ml', baseQty: 1000,
  instructions: 'Agitar 10 minutos. Dejar reposar 4 horas antes de envasar.',
  lineas: [
    { itemId: AGU, qtyPerBatch: 0.80, unitId: L,  tolerance: 0.02, isCritical: true },
    { itemId: SUR, qtyPerBatch: 0.18, unitId: L,  tolerance: 0.02, isCritical: true },
    { itemId: COL, qtyPerBatch: 0.002, unitId: L, tolerance: 0.10, isCritical: false },
    { itemId: BOT, qtyPerBatch: 1000, unitId: UD, tolerance: 0, isCritical: true },
    { itemId: TAP, qtyPerBatch: 1000, unitId: UD, tolerance: 0, isCritical: true },
    { itemId: ETI, qtyPerBatch: 1000, unitId: UD, tolerance: 0, isCritical: true },
  ],
  usuarioId: prod,
})
const recetaLim = await crearReceta({
  productId: LIM, name: 'Limpiador multiusos 1 L', baseQty: 1000,
  instructions: 'Disolver, filtrar y envasar.',
  lineas: [
    { itemId: AGU, qtyPerBatch: 0.85, unitId: L, tolerance: 0.02, isCritical: true },
    { itemId: SUR, qtyPerBatch: 0.12, unitId: L, tolerance: 0.02, isCritical: true },
    { itemId: FRA, qtyPerBatch: 0.01, unitId: L, tolerance: 0.05, isCritical: false },
  ],
  usuarioId: prod,
})

// Dos producciones del mismo producto: la segunda coge de lo que dejó la
// primera. Ahí es donde se ve que el FEFO funciona de verdad.
await producir({ recipeId: recetaLav.id, cantidad: 1800, usuarioId: prod, notas: 'Partida del día 14' })
await producir({ recipeId: recetaLav.id, cantidad: 1600, usuarioId: prod, notas: 'Partida del día 15' })
await producir({ recipeId: recetaLim.id, cantidad: 900,  usuarioId: prod, notas: 'Partida del día 15' })



// Un lote en cuarentena, para que se vea el estado
// En cuarentena un lote que sigue estando físicamente ahí pero no se puede usar.
// Se elige el de fragancia: la producción de limpiador la necesita, así que este
// es justo el caso que hay que ver — sale de las disponibles sin desaparecer.
const loteEnCuarentena = await one(
  `SELECT id FROM lots WHERE item_id=$1 ORDER BY id DESC LIMIT 1`, [await mp('RM-FRAG')])
await m.cambiarEstadoLote({
  loteId: loteEnCuarentena.id, estado: 'QUARANTINE',
  motivo: 'Lote pendiente de análisis de laboratorio', usuarioId: prod,
})
}
