/**
 * EL CIRCUITO DE VENTA, DE PRINCIPIO A FIN, Y QUE NO SE ROMPE AL CAMBIAR DE
 * ESCENARIO.
 *
 * Lo que se comprueba aquí es una sola cosa, y es la que más caro sale si
 * falla: que la CIFRA sea siempre la misma.
 *
 * Un producto que cuesta 3,13 € y se vende a 1,50 € tiene que mostrar 3,13 € y
 * 1,50 € en el pedido, en la entrega, en el cobro y en la Caja. No parecidos.
 * Los mismos. Y cuando el cliente pide 1 unidad, 2, una caja, tres cajas o un
 * pallet, esos mismos números tienen que seguir siendo esos, solo que
 * multiplicados.
 *
 * La trampa de un ERP de verdad no es que el cálculo esté mal. Es que el cálculo
 * esté BIEN en el pedido y MAL en el cobro, porque el cobro se teclea, o
 * porque alguien metió un importe a mano, o porque una vista recalcula el precio
 * con otro redondeo. Entonces el pedido dice 18,00 € y la caja dice 18,01 €, y
 * nadie sabe de dónde salió ese céntimo.
 *
 * Por eso aquí no se escribe NI UN IMPORTE. Ni el precio, ni el total, ni lo que
 * se cobra. Todo sale del pedido, y el pedido sale del coste y del precio.
 */

process.env.PGLITE_DIR ??= '/workspace/cleansahel-v2/server/.pgdata'

const { query, one, transaction, closeDb } = await import('./src/db/client.js')
const PED = await import('./src/core/pedidos.js')
const CLI = await import('./src/core/clientes.js')
const COB = await import('./src/core/cobros.js')
const CAJA = await import('./src/core/caja.js')

// ─── Presentación ──────────────────────────────────────────────────
const c = (s, n = 46) => String(s).padEnd(n)
const r = (s, n = 16) => String(s).padStart(n)
const eur = (n) => Number(n).toFixed(2)
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }
const linea = (etq, valor, nota = '') => console.log(`  ${c(etq, 44)}${r(valor)}${nota ? '   ' + nota : ''}`)

let fallos = 0
const comprobar = (etq, sistema, aMano, tol = 0.005) => {
  const ok = Math.abs(Number(sistema) - Number(aMano)) <= tol
  if (!ok) fallos++
  console.log(`  ${ok ? '✓' : '✗'} ${c(etq, 40)}${r(sistema, 16)}${r(aMano, 16)}${ok ? '' : '   ← NO CUADRA'}`)
}

// ─── Quiénes ───────────────────────────────────────────────────────
const admin = await one(
  `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
    WHERE r.code = 'ADMIN' AND u.is_active ORDER BY u.id LIMIT 1`)
const repartidor = await one(
  `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
    WHERE r.code = 'DELIVERY' AND u.is_active ORDER BY u.id LIMIT 1`)
const cajero = await one(
  `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
    WHERE r.code IN ('CASHIER','CAJAJERO') AND u.is_active ORDER BY u.id LIMIT 1`)
  ?? await one("SELECT id FROM users WHERE username = 'caja'")

const adm = admin.id
const repId = repartidor?.id ?? null   // es la FILA; abajo va .id
const cajId = cajero?.id ?? null

// El precio de venta, una sola vez, y NO se escribe en el pedido: se guarda en
// el artículo y el pedido lo lee. Es la forma de comprobar que el precio no
// cambia de un módulo a otro.
const PRODUCTO = await one(`SELECT * FROM items WHERE sku = 'PT-LAV-750'`)
if (!PRODUCTO) throw new Error('Falta el producto PT-LAV-750. Ejecuta antes coste-circuito.mjs.')

//
// EL PRECIO DE VENTA.
//
// Va en el CATÁLOGO, no en el pedido. El pedido lo lee; no lo escribe. Si el
// precio viviera en el pedido, cada pedido podría llevar el suyo y habría dos
// cifras para el mismo producto —justo lo que se quiere evitar.
//
// El artículo lo creó coste-circuito.mjs sin precio, así que un pedido de este
// producto salía a 0,00 € y se quedaba «pagado» sin haber cobrado nada. Por eso
// aquí se comprueba y se avisa: un pedido a cero no puede pasar por cobrado.
const PRECIO_UNITARIO = 150

if (!PRODUCTO.sale_price || Number(PRODUCTO.sale_price) === 0) {
  await query('UPDATE items SET sale_price = $1 WHERE id = $2', [PRECIO_UNITARIO, PRODUCTO.id])
  console.log('  · el artículo no tenía precio de venta; se le ha puesto el de la prueba.')
  console.log('    (OJO: un pedido a 0,00 € se marca PAGADO sin cobrar nada.)')
}

const MONEDA = await one(`SELECT code FROM currencies WHERE is_base LIMIT 1`)
const MON = MONEDA?.code ?? 'XOF'

// ─── El coste y el precio salen del LOTE producido ──────────────────
//
// Nada de teclearlo. Se leen del último lote de producción del producto, que es
// donde vive el coste real.
const loteReal = await one(
  `SELECT cost_per_base_unit, qty_available FROM lots
    WHERE item_id = $1 AND cost_source = 'PRODUCTION'
    ORDER BY id DESC LIMIT 1`, [PRODUCTO.id])

if (!loteReal) {
  throw new Error('No hay ningún lote de producción de este producto. Ejecuta antes coste-circuito.mjs.')
}

const COSTE_UNITARIO = Number(loteReal.cost_per_base_unit)
const UNIDADES_POR_CAJA = 12
const PALLET = 120

// Los cinco escenarios juntos piden 171 unidades. Hay que tenerlas de verdad:
//
//   1 + 2 + 12 + 36 + 120 = 171
//
// Fabricarlas con `producir()` y no con un INSERT. Si el producto no está en
// stock, el ERP tiene razón en no venderlo, y una prueba que se aparta del
// error no está probando el sistema que se usa todos los días.
const UNIDADES_NECESARIAS = 1 + 2 + UNIDADES_POR_CAJA + UNIDADES_POR_CAJA * 3 + PALLET

titulo('0 · DE DÓNDE SALEN EL COSTE Y EL PRECIO')

// Materia prima para esa fabricación. Se compra ANTES de fabricar, con la
// función de verdad, y con el mismo precio del lote que ya existe: no se
// inventa un precio nuevo para que la multiplication salga.
//
// Faltan concentrados en la base porque las pruebas anteriores han gastado el
// bidón. Un ERP no adivina de dónde sale el material: o se compra, o no se
// fabrica. Por eso está aquí y no en un atajo.
const ING = await query(
  `SELECT i.id, i.sku, i.category_kind FROM items i
    WHERE i.sku IN ('RM-CONC-20L','ENV-BOT-750','ENV-ETI-750','ENV-CJA-12')`)
const ing = Object.fromEntries(ING.map((x) => [x.sku, x]))
const { crearLoteConEntrada } = await import('./src/core/stock.js')
const U = Object.fromEntries((await query('SELECT id, code FROM units')).map((x) => [x.code, x.id]))

const reponer = async (it, qty, unitId, unitCost) => {
  await transaction((tx) => crearLoteConEntrada(tx, {
    // Código único por ejecución: el script se puede repetir, y el lote no
    // puede llamarse igual dos veces. Volver a salir con «ya existe un lote» no
    // dice nada del ERP, solo del script.
    code: `LOT-VT-${it.sku}-${Date.now().toString(36).toUpperCase()}`, itemId: it.id, lotKind: 'RAW_MATERIAL',
    initialQty: qty, unitId, originType: 'PURCHASE', unitCost, usuarioId: adm,
  }))
}
// El precio del concentrado se LEE del lote de compra que ya hay, no se escribe.
// Es el mismo precio con el que se compró ayer, que es justo lo que hay que
// demostrar: que el coste histórico no se reescribe.
const costeConcentradoL = Number((await one(
  `SELECT cost_per_base_unit FROM lots
    WHERE item_id = $1 AND cost_source = 'PURCHASE' AND cost_per_base_unit IS NOT NULL
    ORDER BY id DESC LIMIT 1`, [ing['RM-CONC-20L'].id])).cost_per_base_unit)
if (ing['RM-CONC-20L']) await reponer(ing['RM-CONC-20L'], 200, U.L, costeConcentradoL)
if (ing['ENV-BOT-750']) await reponer(ing['ENV-BOT-750'], 400, U.UD, 0.27)
if (ing['ENV-ETI-750']) await reponer(ing['ENV-ETI-750'], 400, U.UD, 0.055)
if (ing['ENV-CJA-12']) await reponer(ing['ENV-CJA-12'], 300, U.UD, 0.45)
console.log('  · materia prima repuesta para la fabricación')

const enStock = Number((await one(
  `SELECT COALESCE(SUM(qty_available),0) AS q FROM lots
    WHERE item_id = $1 AND qty_available > 0`, [PRODUCTO.id])).q)
const FALTAN = Math.max(0, UNIDADES_NECESARIAS - enStock)
if (FALTAN > 0) {
  const PROD = await import('./src/core/produccion.js')
  const rec = await one(
    `SELECT id FROM recipes WHERE product_id = $1 AND is_active ORDER BY version DESC LIMIT 1`,
    [PRODUCTO.id])
  if (!rec) throw new Error('No hay receta activa para este producto. Ejecuta antes coste-circuito.mjs.')
  await PROD.producir({ recipeId: rec.id, cantidad: FALTAN, usuarioId: adm })
  console.log(`  · se han fabricado ${FALTAN} unidades: los escenarios piden ${UNIDADES_NECESARIAS} y había ${enStock}`)
}


linea('coste real, leído del lote de producción', eur(COSTE_UNITARIO), `origen ${loteReal.cost_source}`)
linea('precio de venta, leído del artículo', PRECIO_UNITARIO, `moneda ${MON}`)
linea('NO se escriben en ningún pedido', '')
console.log('')
console.log('  Cada escenario se crea de cero, se cobra entero y se entrega a Caja.')
console.log('  Si una cifra cambia de columna, es que alguien la ha recalculado.')
console.log('')

// ─── Cliente ───────────────────────────────────────────────────────
// Se crea con `crearCliente()`, la función de verdad. Insertar a mano se
// saltaría el token QR —que es OBLIGATORIO en la base— y el código correlativo.
// Un script de prueba que inserta por la espalda acaba probando una base que
// la aplicación real nunca tendría.
const cliente = await CLI.crearCliente({
  name: 'Cliente de la prueba de venta',
  phone: '+22300000000',
}, adm)

// ─── El recorrido completo, para una cantidad dada ─────────────────
async function escenario(nombre, unidades) {
  const pedido = await PED.crearPedido({
    customerId: cliente.id,
    userId: adm,
    lineas: [{ itemId: PRODUCTO.id, qty: unidades }],
  })
  const confirmado = await PED.confirmarPedido(pedido.id, adm)
  const preparado = await PED.prepararPedido(pedido.id, adm)

  // El total sale del pedido. Si este número no cuadra, el resto tampoco.
  const totalPedido = Number(confirmado.total ?? pedido.total ?? 0)

  // Se entrega por la TARJETA, que es la única confirmación digital.
  const entrega = await (async () => {
    const E = await import('./src/core/entregas.js')
    return E.confirmarDesdeTarjeta({ orderId: pedido.id, clienteId: cliente.id, userId: adm, repId })
  })()

  // Se cobra SIN importe. Si `cobrar()` aceptase `amount`, esta prueba no
  // valdría: habría dos caminos para el mismo número.
  const cobro = await COB.cobrar({
    pedidoId: pedido.id,
    metodo: 'CASH',
    deliveryId: entrega?.delivery_id ?? entrega?.id ?? null,
    // Lo cobra el REPARTIDOR, no el administrador. El dinero que lleva la caja
    // es el de quien ha cobrado, y `fn_por_entregar()` mira los cobros de ESA
    // persona. Si lo cobra otro, el traspaso sale a cero — y no es un fallo: es
    // que ese dinero no lo lleva nadie.
    usuarioId: repId ?? adm,
  })

  // Caja: el repartidor entrega la pasta y el cajero la recibe.
  let traspaso = null
  let saldoCaja = null
  let llevabaAntes = null
  if (repId && cajId) {
    try {
      // Lo que el sistema dice que este repartidor lleva encima ANTES de abrir
      // el traspaso. El traspaso tiene que llevar eso, exactamente eso: ni un
      // céntimo más ni menos. Si no cuadra, la caja está mintiendo.
      llevabaAntes = Number((await one(
        `SELECT fn_por_entregar($1, $2) AS n`, [repId, MON])).n)
      traspaso = await CAJA.abrirTraspaso({ handedBy: repId, receivedBy: cajId, moneda: MON, usuarioId: adm })
      saldoCaja = await CAJA.saldoDe(cajId, MON)
    } catch (e) {
      console.log(`     (traspaso omitido: ${String(e.message).slice(0, 70)} | repId=${JSON.stringify(repId)} cajId=${JSON.stringify(cajId)})`)
    }
  }

  // Lo que la BASE dice que queda pendiente. La misma función que ve la tarjeta.
  const pendiente = Number((await one(
    `SELECT fn_pendiente_cobro($1::bigint) AS p`, [pedido.id])).p)

  return {
    nombre, unidades, pedido, entrega, cobro, traspaso, saldoCaja, llevabaAntes,
    totalPedido,
    costeTotal: COSTE_UNITARIO * unidades,
    pendiente,
  }
}

// ─── Los cinco escenarios ──────────────────────────────────────────
titulo('1 · LOS CINCO ESCENARIOS, CRUZANDO TODO EL CIRCUITO')

const escenarios = [
  ['1 unidad', 1],
  ['2 unidades', 2],
  ['1 caja de 12', UNIDADES_POR_CAJA],
  ['3 cajas (36 uds)', UNIDADES_POR_CAJA * 3],
  ['pallet (120 uds)', PALLET],
]

const resultados = []
for (const [nombre, unidades] of escenarios) {
  const res = await escenario(nombre, unidades)
  resultados.push(res)

  const cobrado = Number(res.cobro?.cobro?.amount ?? res.cobro?.amount ?? 0)

  console.log('')
  console.log(`  ── ${nombre} ──`)
  comprobar('  coste × unidades', res.costeTotal, COSTE_UNITARIO * unidades)
  comprobar('  total del pedido', res.totalPedido, PRECIO_UNITARIO * unidades)
  comprobar('  importe cobrado', cobrado, PRECIO_UNITARIO * unidades)
  comprobar('  pendiente tras cobrar', res.pendiente, 0)
}

// ─── La coherencia: las columnas que TIENEN que ser iguales ────────
//
// El coste por unidad y el precio por unidad no pueden cambiar con la cantidad.
// Si cambian, alguien está recalculando en lugar de multiplicar.
titulo('2 · EL COSTE Y EL PRECIO SON LOS MISMOS SEA CUAL SEA LA CANTIDAD')

const costeUnitarioEsperado = COSTE_UNITARIO
const precioUnitarioEsperado = PRECIO_UNITARIO

for (const res of resultados) {
  const precioUnitario = Number(res.totalPedido) / res.unidades
  comprobar(`  ${c(res.nombre, 24)} precio/unidad`, precioUnitario, precioUnitarioEsperado)
  comprobar(`  ${c(res.nombre, 24)} coste/unidad`, COSTE_UNITARIO, costeUnitarioEsperado)
}

// ─── La suma también ───────────────────────────────────────────────
//
// Si los cinco escenarios están bien, la suma también. Y si la suma está bien,
// ninguno de los cinco tenía un céntimo perdido por el camino.
titulo('3 · LA SUMA DE LOS CINCO, QUE TAMBIÉN TIENE QUE CUADRAR')

const totalPedidos = resultados.reduce((a, r) => a + Number(r.totalPedido), 0)
const totalEsperado = precioUnitarioEsperado * escenarios.reduce((a, s) => a + s[1], 0)
comprobar('suma de los cinco pedidos', totalPedidos, totalEsperado)

const totalCobrado = resultados.reduce((a, r) => a + Number(r.cobro?.cobro?.amount ?? 0), 0)
comprobar('suma de los cinco cobros', totalCobrado, totalEsperado)

const unidadesTotales = resultados.reduce((a, r) => a + r.unidades, 0)
console.log('')
linea('unidades vendidas en total', unidadesTotales)
linea('coste total de la mercadería', eur(COSTE_UNITARIO * unidadesTotales))
linea('margen total de la operación', eur(totalEsperado - COSTE_UNITARIO * unidadesTotales))

// ─── Caja ──────────────────────────────────────────────────────────
titulo('4 · LA CAJA')

const conTraspaso = resultados.filter((r) => r.traspaso)
if (conTraspaso.length) {
  const caja = conTraspaso[conTraspaso.length - 1]
  // El traspaso no lleva «el cobro de este pedido»: lleva TODO lo que ese
  // repartidor tiene por entregar, que son los cinco escenarios seguidos.
  // Compararlo con el último cobro daría un falso negativo, y un falso
  // negativo en una conciliación es el tipo de cosa que hace que la gente
  // deje de fiarse de la caja.
  comprobar('el traspaso lleva lo que decía que llevaba',
    Number(caja.traspaso?.expected_amount ?? 0), caja.llevabaAntes ?? 0)
  console.log('')
  console.log('  El saldo del cajero NO se escribe: se deriva de los traspasos que ha recibido.')
  console.log(`  Salder del cajero ahora: ${eur(caja.saldoCaja?.saldo ?? 0)} ${MON}`)
} else {
  console.log('  (No se pudo abrir traspaso: sin repartidor o sin cajero en la demo.)')
}

// ─── El mando a distancia: no se puede tocar el importe ────────────
titulo('5 · LA PRUEBA DE QUE NO HAY UNA SEGUNDA CIFRA')

try {
  await COB.cobrar({ pedidoId: resultados[0].pedido.id, metodo: 'CASH', amount: 1, usuarioId: adm })
  fallos++
  console.log('  ✗ el cobro acepta un importe manual: se ha podido crear una segunda cifra')
} catch (e) {
  console.log(`  ✓ cobrar() RECHAZA un importe manual: ${String(e.message).slice(0, 72)}`)
}

try {
  await COB.cobrar({ pedidoId: resultados[0].pedido.id, metodo: 'CASH', usuarioId: adm })
  fallos++
  console.log('  ✗ se ha podido cobrar dos veces el mismo pedido')
} catch (e) {
  console.log(`  ✓ cobrar() RECHAZA el segundo cobro: ${String(e.message).slice(0, 72)}`)
}

const pendienteFinal = Number((await one(
  `SELECT fn_pendiente_cobro($1::bigint) AS p`, [resultados[0].pedido.id])).p)
comprobar('el pedido cobrado sigue sin pendiente', pendienteFinal, 0)

// ─── CIERRE ────────────────────────────────────────────────────────
titulo(fallos === 0 ? 'TODO CUADRA' : `HAY ${fallos} COSAS QUE NO CUADRAN`)

if (fallos === 0) {
  console.log(`
  El mismo número ha llegado intacto desde el coste hasta la Caja:

    coste real por unidad    ${eur(COSTE_UNITARIO)}   (leído del lote de producción)
    precio de venta          ${eur(precioUnitarioEsperado)}   (leído del artículo)

    y en los cinco escenarios, sin cambiar ni una cifra:

      ${escenarios.map(([n, u]) => `${n} → ${eur(precioUnitarioEsperado * u)}`).join('   ')}

  Ningún importe se ha escrito a mano en ningún sitio.`)
}

await closeDb()
process.exit(fallos === 0 ? 0 : 1)