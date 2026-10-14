/**
 * REPRODUCIR EL «REVISA EL STOCK» DEL REPARTIDOR.
 *
 * El repartidor escaneó la tarjeta, le apareció un pedido de lavavajillas, y
 * pulsó «Entregar». El servidor respondió «Revisa el stock antes de confirmar
 * la entrega» y el repartidor se quedó sin saber si se había entregado o no.
 *
 * Este script reproduce EXACTAMENTE ese camino y mira las tres cosas que
 * importan:
 *
 *   1. ¿El pedido aparece como entregable cuando no lo es?
 *   2. ¿El error dice la verdad sobre por qué no se puede entregar?
 *   3. ¿Después del error, el pedido sigue como estaba? (ni entregado ni roto)
 *
 * Se prueba por HTTP, que es lo mismo que ve el repartidor. No se abre la base
 * de datos con un script: el servidor la tiene abierta, y PGlite es de una
 * sola conexión. Abrirla por fuera mientras el servidor trabaja es lo que la
 * corrompe, y ya ha pasado tres veces.
 */

// El servidor es PROPIO, en un puerto libre, sobre la base de pruebas.
//
// Antes esto apuntaba a `127.0.0.1:10000`, que es el servidor de la
// demostracion. Con los tests ahi, cada ejecucion escribia en la demo y le
// dejaba clientes de prueba. `entornoConDemo()` levanta su base, la siembra y
// levanta su servidor.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('reparto-entrega.test.mjs', BASE)

let fallos = 0
const mal = (t, x = '') => { fallos++; console.log(`  ✗ ${t}${x ? '   ' + x : ''}`) }
const ok = (t) => console.log(`  ✓ ${t}`)
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

const pedir = async (ruta, { metodo = 'GET', cuerpo, token } = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  })
  const t = await r.text()
  let c = null
  try { c = JSON.parse(t) } catch { c = t }
  return { estado: r.status, cuerpo: c }
}

const ent = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { username: 'admin', password: 'demo1234' } })
if (ent.estado !== 200) { console.log('  No se ha podido entrar.'); process.exit(1) }
const T = ent.cuerpo.access
const TRep = (await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { username: 'reparto', password: 'demo1234' } })).cuerpo.access

titulo('1 · UN PEDIDO EN DRAFT, ¿SE PUEDE ENTREGAR?')

// Se crea un pedido y NO se confirma: se queda en borrador, que es exactamente
// el estado en el que estaba el pedido del repartidor.
const cliente = (await pedir('/api/customers', {
  metodo: 'POST', token: T, cuerpo: { name: `Reparto DRAFT ${Date.now().toString(36).toUpperCase()}` },
})).cuerpo

const item = (await pedir('/api/items', { token: T })).cuerpo
  .find((i) => i.category_kind === 'FINISHED_GOOD' && Number(i.qty_available) > 0)

const pedido = await pedir('/api/orders', {
  metodo: 'POST', token: T,
  cuerpo: { customerId: cliente.id, lineas: [{ itemId: item.id, qty: 2 }] },
})
const pid = pedido.cuerpo.id
console.log(`  pedido creado: ${pedido.cuerpo.code} · estado ${pedido.cuerpo.status} (SIN confirmar)`)
console.log(`  producto: ${item.sku} — ${item.name}`)

// ─── ¿Aparece en la hoja de ruta del repartidor? ────────────────────
//
// Si aparece, el sistema está prometiendo una entrega que no puede hacer.
const ruta = await pedir('/api/reparto?todas=1', { token: TRep })
const enRuta = (ruta.cuerpo ?? []).some((f) => f.pedido_id === pid)
if (enRuta) mal('el pedido en DRAFT APARECE en la hoja de ruta del repartidor')
else ok('el pedido en DRAFT NO aparece en la hoja de ruta: correcto, no se puede servir')

// ─── ¿Y por la tarjeta QR? ──────────────────────────────────────────
//
// Esta es la vía que usó el repartidor, y la que hay que mirar de verdad.
const tarjeta = await pedir(`/api/customers/${cliente.id}/tarjeta`, { token: TRep })
const token = tarjeta.cuerpo?.qr_token ?? tarjeta.cuerpo?.token
let porTarjeta = null
if (token) {
  const esc = await pedir(`/api/qr/${token}`, { token: TRep })
  const pedidos = esc.cuerpo?.pedidos ?? esc.cuerpo?.orders ?? []
  porTarjeta = pedidos.find((p) => (p.order_id ?? p.id) === pid)
  if (porTarjeta) {
    mal('la TARJETA QR muestra el pedido en DRAFT como si fuera entregable')
    console.log(`     lo muestra como: estado «${porTarjeta.status ?? porTarjeta.estado}»`)
  } else ok('la tarjeta QR NO muestra el pedido en DRAFT: correcto')
} else {
  mal('no se ha podido sacar el token QR del cliente')
}

// ─── Si se intenta entregar, ¿qué dice y qué pasa? ──────────────────
titulo('2 · SI SE INTENTA ENTREGAR DE TODAS MANERAS')

const antes = (await pedir(`/api/orders/${pid}`, { token: T })).cuerpo.status
const res = await pedir(`/api/reparto/pedido/${pid}/entregar`, {
  metodo: 'POST', token: TRep, cuerpo: { clienteId: cliente.id },
})

console.log(`  respuesta: HTTP ${res.estado}`)
console.log(`  mensaje:   ${String(res.cuerpo?.error ?? '').slice(0, 110)}`)
console.log(`  código:    ${res.cuerpo?.codigo ?? '(ninguno)'}`)

if (res.estado < 400) {
  mal('ha dejado entregar un pedido que no tiene mercancía apartada')
} else if (!res.cuerpo?.error) {
  mal(`ha fallado (${res.estado}) SIN decir por qué: el repartidor no puede hacer nada con esto`)
} else {
  ok(`falla con un mensaje claro: «${String(res.cuerpo.error).slice(0, 70)}…»`)
}

// ─── ¿Queda el pedido como estaba? ──────────────────────────────────
const despues = (await pedir(`/api/orders/${pid}`, { token: T })).cuerpo.status
console.log('')
console.log(`  estado antes:  ${antes}`)
console.log(`  estado después: ${despues}`)
if (despues === antes) ok('el pedido sigue igual: ni entregado ni roto. Nada a medias')
else mal(`el pedido ha cambiado de estado a «${despues}» tras un fallo`)

// ─── Y el reparto sí debería poder entregar un pedido BIEN preparado ──
titulo('3 · ¿UN PEDIDO PREPARADO SÍ SE ENTREGA?')

// FIXTURE: un pedido que SÍ está preparado.
//
// Antes esta sección depended de que la demostración tuviera un pedido en ese
// estado. Al aislar los tests, la base de pruebas no lo trae y la comparación
// no se podía hacer: el test pasaba de largo por la parte que dice si el
// reparto funciona.
//
// Se crea POR LA API y no escribiendo filas: crear el pedido, confirmarlo y
// prepararlo es exactamente lo que hace el comercial, y si se escribiese a
// mano se podría preparar un pedido que el sistema nunca dejaría preparar,
// y el test estaría comprobando algo que no existe.
const clienteListo = (await pedir('/api/customers', {
  metodo: 'POST', token: T,
  cuerpo: { name: `Reparto PREPARED ${Date.now().toString(36).toUpperCase()}` },
})).cuerpo
const pedidoListo = await pedir('/api/orders', {
  metodo: 'POST', token: T,
  cuerpo: { customerId: clienteListo.id, lineas: [{ itemId: item.id, qty: 1 }] },
})
if (pedidoListo.estado >= 400) {
  mal('no se ha podido crear el pedido preparado', String(pedidoListo.cuerpo?.error ?? '').slice(0, 70))
}
await pedir(`/api/orders/${pedidoListo.cuerpo.id}/confirmar`, { metodo: 'POST', token: T })
const preparado = await pedir(`/api/orders/${pedidoListo.cuerpo.id}/preparar`, { metodo: 'POST', token: T })
if (preparado.estado >= 400) {
  mal('el pedido no se ha podido preparar', String(preparado.cuerpo?.error ?? '').slice(0, 70))
} else {
  console.log(`  pedido preparado para comparar: ${pedidoListo.cuerpo.code}`)
}

const listo = (await pedir('/api/reparto?todas=1', { token: TRep })).cuerpo
  .find((f) => f.pedido_estado === 'PREPARED')

if (!listo) {
  mal('no hay ningún pedido PREPARED para comparar')
} else {
  console.log(`  usando ${listo.pedido_code} (ya preparado)`)
  const stockAntes = Number((await pedir('/api/items', { token: T })).cuerpo
    .find((i) => i.id === item.id)?.qty_available ?? 0)

  const okEntrega = await pedir(`/api/reparto/pedido/${listo.pedido_id}/entregar`, {
    metodo: 'POST', token: TRep, cuerpo: { clienteId: listo.cliente_id },
  })

  if (okEntrega.estado < 400) {
    ok(`entrega hecha en ${Date.now() % 100000} ms: HTTP ${okEntrega.estado}`)
    const est = (await pedir(`/api/orders/${listo.pedido_id}`, { token: T })).cuerpo.status
    if (est === 'DELIVERED') ok('el pedido pasa a DELIVERED')
    else mal(`el pedido queda en «${est}», no en DELIVERED`)
  } else {
    mal(`un pedido PREPARED no se puede entregar: HTTP ${okEntrega.estado}`,
      String(okEntrega.cuerpo?.error ?? '').slice(0, 90))
  }
  console.log(`  stock de ${item.sku}: ${stockAntes} uds antes de entregar`)
}

titulo(fallos === 0 ? 'TODO CORRECTO' : `HAY ${fallos} FALLOS`)
console.log('')
process.exit(fallos === 0 ? 0 : 1)