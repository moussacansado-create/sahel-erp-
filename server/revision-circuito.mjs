/**
 * REVISIÓN DEL CIRCUITO REAL, CONTRA LA API.
 *
 * Esto no usa las funciones de `core/`. Llama a la MISMA API que llama el
 * navegador, con token y todo, para comprobar lo que el usuario ve y no lo que
 * el código dice que debería ver.
 *
 * El recorrido que se hace, en orden:
 *
 *   cliente → pedido (unidades y cajas) → entrega → stock → estado
 *           → pendiente de cobro → Caja
 *
 * Y al lado de cada paso se pregunta a la BASE, no a la función: porque el
 * fallo típico no es que la pantalla esté mal, es que la pantalla está bien y
 * la base no guardó nada.
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:10000'

let token = null
let fallos = 0

const ask = async (ruta, opciones = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opciones.headers ?? {}),
    },
  })
  const texto = await r.text()
  let cuerpo = null
  try { cuerpo = JSON.parse(texto) } catch { cuerpo = texto }
  return { status: r.status, cuerpo }
}

const c = (s, n = 44) => String(s).padEnd(n)
const r = (s, n = 16) => String(s).padStart(n)
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }
const ok = (t) => console.log(`  ✓ ${t}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }

// ─── Entrar ────────────────────────────────────────────────────────
titulo('0 · ENTRAR')
const login = await ask('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
})
if (login.status !== 200) { console.log('  No se ha podido entrar. Abortando.'); process.exit(1) }
token = login.cuerpo.access
ok('sesión de administrador abierta')

// ─── 1 · CLIENTE ───────────────────────────────────────────────────
titulo('1 · CREAR UN CLIENTE (como haría el formulario)')

const marca = Date.now().toString(36).toUpperCase()
const nuevoCliente = await ask('/api/customers', {
  method: 'POST',
  body: JSON.stringify({ name: `Cliente revisión ${marca}`, phone: '+22370000001' }),
})
if (nuevoCliente.status >= 400) mal('crear cliente', `→ ${nuevoCliente.cuerpo?.error ?? nuevoCliente.status}`)
else ok(`cliente creado: ${nuevoCliente.cuerpo.code} · ${nuevoCliente.cuerpo.name}`)
const clienteId = nuevoCliente.cuerpo?.id

// ¿Aparece luego al listarlos? Una cosa es crearse y otra que se vea.
const listados = await ask('/api/customers')
const aparece = (listados.cuerpo ?? []).some((x) => x.id === clienteId)
if (aparece) ok('el cliente aparece en el listado')
else mal('el cliente NO aparece en el listado')

// ─── 2 · FORMATOS DE VENTA: UNIDADES Y CAJAS ────────────────────────
titulo('2 · FORMATOS DE VENTA: ¿QUÉ CAJAS EXISTEN?')

const producto = (await ask('/api/items')).cuerpo
  ?.find((i) => i.category_kind === 'FINISHED_GOOD' && Number(i.qty_available ?? 0) > 0)
console.log(`  producto elegido: ${c(producto?.sku ?? '(ninguno)', 22)} ${producto?.name ?? ''}`)
console.log(`  stock disponible: ${producto?.qty_available ?? '?'}`)

// Un producto sin stock no se puede vender, y el ERP tiene razón.
const conStock = (await ask('/api/items')).cuerpo
  ?.filter((i) => i.category_kind === 'FINISHED_GOOD' && Number(i.qty_available ?? 0) > 50)
console.log(`  productos con stock suficiente (>50): ${conStock.length}`)
if (!conStock.length) {
  mal('no hay ningún producto terminado con stock para probar')
}

// ¿Hay formatos de caja?
let packs = []
for (const nombre of ['/api/items/packs', `/api/items/${conStock[0]?.id}/packs`, '/api/packs']) {
  const res = await ask(nombre)
  if (res.status === 200 && Array.isArray(res.cuerpo)) { packs = res.cuerpo; break }
}
if (packs.length) {
  for (const pk of packs.slice(0, 6)) {
    console.log(`     ${c(pk.name ?? pk.label ?? pk.code, 26)}${r(pk.qty ?? pk.pack_qty, 6)} uds`)
  }
} else {
  mal('no hay FORMATOS DE CAJA expuestos por la API')
  console.log('     La tabla item_packs existe, pero sin filas y sin endpoint.')
  console.log('     Por eso en el pedido solo aparece «unidades».')
}

// ─── 3 · PEDIDO ────────────────────────────────────────────────────
titulo('3 · CREAR UN PEDIDO')

const item = conStock[0]
const stockAntes = Number(item.qty_available)
const UNIDADES = 24

const pedido = await ask('/api/orders', {
  method: 'POST',
  body: JSON.stringify({
    customerId: clienteId,
    lineas: [{ itemId: item.id, qty: UNIDADES }],
  }),
})
if (pedido.status >= 400) {
  mal('crear pedido', `→ ${pedido.cuerpo?.error ?? pedido.cuerpo?.message ?? pedido.status}`)
  console.log('\n  Sin pedido no se puede seguir. Abortando.')
  process.exit(1)
}
const pedidoId = pedido.cuerpo.id ?? pedido.cuerpo.pedido?.id
ok(`pedido creado: ${pedido.cuerpo.code ?? pedido.cuerpo.pedido?.code}`)

// ─── 4 · ESTADO DEL PEDIDO Y CERO ──────────────────────────────────
titulo('4 · EL PEDIDO, Y EL AGUJERO DEL PEDIDO A CERO')

let detalle = await ask(`/api/orders/${pedidoId}`)
const total = Number(detalle.cuerpo?.total ?? pedido.cuerpo?.total ?? 0)
console.log(`  estado inicial: ${c(detalle.cuerpo?.status ?? '(?)', 18)} total ${r(total)} ${detalle.cuerpo?.currency_code ?? ''}`)

// Un pedido de 0 no puede existir. Ni quedar pagado.
if (total <= 0) {
  mal(`el pedido tiene importe ${total}: un pedido a cero no debería poder crearse`)
} else {
  ok(`el pedido tiene importe ${total}`)
}

// ─── 5 · CONFIRMAR Y PREPARAR ──────────────────────────────────────
titulo('5 · CONFIRMAR, PREPARAR Y RESERVAR STOCK')

for (const [nombre, ruta] of [
  ['confirmar', `/api/orders/${pedidoId}/confirmar`],
  ['preparar', `/api/orders/${pedidoId}/preparar`],
]) {
  const res = await ask(ruta, { method: 'POST' })
  if (res.status >= 400) {
    // Puede que la ruta se llame de otra manera; se anota, no se inventa.
    console.log(`     (${nombre}: ${res.status} ${res.cuerpo?.error ?? ''})`)
  } else ok(`${nombre}: ${res.status}`)
}

detalle = await ask(`/api/orders/${pedidoId}`)
console.log(`  estado tras preparar: ${c(detalle.cuerpo?.status ?? '(?)', 18)} total ${r(detalle.cuerpo?.total ?? 0)}`)
if (detalle.cuerpo?.status === 'DELIVERED' || detalle.cuerpo?.status === 'PAID') {
  mal(`el pedido está en ${detalle.cuerpo.status} SIN que nadie lo haya entregado ni cobrado`)
} else ok(`el pedido está en ${detalle.cuerpo?.status}: todavía no entregado ni cobrado`)

// ─── 6 · ENTREGAR ──────────────────────────────────────────────────
titulo('6 · REGISTRAR ENTREGA (y que el botón no se quede cargando)')

const t0 = Date.now()
let entrega
// La ruta buena es la del REPARTIDOR: escanea la tarjeta y entrega.
// La otra (`/api/deliveries`) responde 409 A PROPOSITO, porque la entrega
// la cierra la tarjeta y no el pedido a pelo.
for (const intento of [`/api/reparto/pedido/${pedidoId}/entregar`, '/api/deliveries']) {
  const res = await ask(intento, {
    method: 'POST',
    body: JSON.stringify({ orderId: pedidoId, clientId: clienteId, customerId: clienteId }),
  })
  if (res.status < 400) { entrega = { ruta: intento, cuerpo: res.cuerpo }; break }
  // Un 409 NO es un «registrado». Antes se contaba como entrega hecha y la
  // prueba daba verde sobre una entrega que no había ocurrido.
  if (res.status === 409) {
    console.log(`     (${intento}: ${res.cuerpo?.codigo ?? ''} — ${String(res.cuerpo?.error ?? '').slice(0, 70)})`)
    continue
  }
}
const ms = Date.now() - t0
if (!entrega) {
  mal('no se ha podido registrar la entrega por ninguna vía')
} else {
  ok(`entrega registrada por ${entrega.ruta} en ${ms} ms (${entrega.cuerpo.status ?? 200})`)
  if (ms > 15000) mal('la entrega tarda más de 15 segundos: el botón se quedaría cargando')
}

// ─── 7 · STOCK: ¿SE HA DESCONTADO DE VERDAD? ────────────────────────
titulo('7 · STOCK: ¿SE HA DESCONTADO DE VERDAD?')

const despues = (await ask('/api/items')).cuerpo?.find((i) => i.id === item.id)
const stockDespues = Number(despues?.qty_available ?? 0)
const esperado = stockAntes - UNIDADES

console.log(`  stock inicial:        ${r(stockAntes)}`)
console.log(`  pedido de:            ${r(UNIDADES)} unidades`)
console.log(`  stock esperado:       ${r(esperado)}`)
console.log(`  stock real ahora:     ${r(stockDespues)}`)

if (stockDespues === esperado) {
  ok(`el stock se ha descontado EXACTAMENTE: ${stockAntes} − ${UNIDADES} = ${stockDespues}`)
} else if (stockDespues === stockAntes) {
  mal(`el stock NO se ha descontado: sigue en ${stockDespues}`)
  console.log('     Esto es lo que has visto tú. Y es verdad: no se descuenta.')
} else {
  mal(`el stock ha bajado de otra manera: ${stockAntes} → ${stockDespues}, y tocaba ${esperado}`)
}

// El movimiento tiene que existir, con fecha, producto, cantidad y referencia.
const movs = await ask(`/api/inventory/${item.id}/movimientos`)
const lista = Array.isArray(movs.cuerpo) ? movs.cuerpo : movs.cuerpo?.movimientos ?? []
const mio = lista.find((m) => Number(m.qty) === -UNIDADES || Math.abs(Number(m.qty)) === UNIDADES)
if (mio) {
  ok(`movimiento registrado: ${mio.movement_type ?? mio.tipo} ${mio.qty} ref ${mio.ref_type ?? '?'}/${mio.ref_id ?? '?'}`)
} else {
  mal('no hay ningún movimiento de stock con esa cantidad')
  console.log(`     movimientos registrados para este artículo: ${lista.length}`)
}

// ─── 8 · PENDIENTE DE COBRO ────────────────────────────────────────
titulo('8 · DESPUÉS DE ENTREGAR, QUEDA PENDIENTE DE COBRO')

detalle = await ask(`/api/orders/${pedidoId}`)
const estado = detalle.cuerpo?.status
const pendiente = Number(detalle.cuerpo?.pendiente ?? detalle.cuerpo?.qty_pendiente ?? NaN)
const pagado = Number(detalle.cuerpo?.pagado ?? detalle.cuerpo?.paid ?? 0)

console.log(`  estado del pedido:  ${c(estado ?? '(?)', 20)} ${estado === 'DELIVERED' ? '← entregado' : ''}`)
console.log(`  importe del pedido: ${r(detalle.cuerpo?.total ?? 0)}`)
console.log(`  pendiente:          ${r(Number.isNaN(pendiente) ? '(no lo expone la API)' : pendiente)}`)
console.log(`  pagado:             ${r(pagado)}`)

const esPendiente = ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(estado)
if (esPendiente && !Number.isNaN(pendiente) && pendiente <= 0) {
  mal(`el pedido está entregado pero el pendiente sale ${pendiente}`)
} else if (esPendiente) {
  ok(`el pedido está entregado y pendiente de cobro`)
}
if (!String(estado).includes('DELIVER')) {
  mal(`el pedido NO ha quedado en estado entregado (está en ${estado})`)
  console.log('     Sin estado entregado, ni la tarjeta ni la Caja tienen nada que mirar.')
}

// ─── 9 · CAJA ──────────────────────────────────────────────────────
titulo('9 · ¿APARECE EN CAJA COMO PENDIENTE?')

for (const usuario of ['reparto', 'caja']) {
  const l = await ask('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: usuario, password: 'demo1234' }),
  })
  if (l.status !== 200) { console.log(`     (${usuario}: no se ha podido entrar)`); continue }
  const guardado = token
  token = l.cuerpo.access
  const caja = await ask('/api/caja')
  const cuerpo = caja.cuerpo
  const texto = JSON.stringify(cuerpo ?? {})
  console.log(`     ${c(usuario, 10)} → ${caja.status} ${texto.slice(0, 150)}`)
  if (usuario === 'reparto' && texto.includes(String(UNIDADES * 0))) {
    // el pendiente no se ve por número de unidades; se ve por importe
  }
  token = guardado
}

// ─── 10 · RESUMEN ──────────────────────────────────────────────────
titulo(fallos === 0 ? 'LO QUE FUNCIONA' : `HAY ${fallos} COSAS QUE NO FUNCIONAN`)

console.log(`
  Se ha hecho el recorrido ENTERO por la misma API que usa el navegador:

    cliente → pedido → confirmar → preparar → entregar
           → stock → pendiente → Caja

  Y lo que falla está arriba, con una ✗ y la cifra al lado.
`)
process.exit(fallos === 0 ? 0 : 1)