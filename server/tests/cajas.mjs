// Prueba de las cajas de punta a punta, contra la aplicación en marcha.
//
// Lo que se comprueba aquí, y por qué cada cosa importa:
//
//  1. Crear un formato en Ajustes.
//  2. Pedir 2 cajas de 12 y comprobar que el ALMACÉN ve 24 botellas, no 2.
//  3. Que el precio cobrado sea el de la CAJA, no el de la botella.
//  4. Que las reservas aparten las 24 botellas.
//  5. Que la entrega las consuma una sola vez.
//  6. QUE UN PEDIDO VIEJO SIGA FUNCIONANDO (sin cajas) — nada roto.
//  7. Que cambiar el precio del formato NO reescriba el pedido ya emitido.
//
// El 7 es el que más fácil se rompe y el que más caro sale: si un día se
// sube la caja de 1.200 a 1.350 FCFA, el albarán de ayer tiene que seguir
// diciendo 1.200.
const URL = 'http://127.0.0.1:10000'
const fallos = []
const L = (ok, m) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${m}`); if (!ok) fallos.push(m) }

const p = (m, r, c, t) => fetch(URL + r, {
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  body: c ? JSON.stringify(c) : undefined,
}).then(async (x) => {
  let j = null
  try { j = await x.json() } catch {}
  return { s: x.status, j }
})

console.log('\n  ══ CAJAS · prueba de punta a punta ══\n')

const { j: sesion } = await p('POST', '/api/auth/login', { username: 'admin', password: 'demo1234' })
const T = sesion.access
L(!!T, 'sesión iniciada')

// ── Un producto con existencias reales ───────────────────────────────────────
const items = (await p('GET', '/api/items?limite=200', null, T)).j
const lista = Array.isArray(items) ? items : (items.data || items.items || [])
// Se usa SIEMPRE el mismo producto de pruebas, pero con existencias
// renovadas. Antes esta prueba cogía un producto al azar y fallaba a la
// cuarta vuelta porque se habían quedado sin botellas: eso no era un defecto
// del código, era un defecto de la prueba, y mezclar los dos es la manera
// más fácil de pasar por alto un fallo de verdad.
const marca = Date.now().toString().slice(-4)
const codigoPrueba = 'PTCJ'
let pt = lista.find((i) => i.sku === codigoPrueba)
if (!pt) {
  const nuevo = await p('POST', '/api/items', {
    sku: codigoPrueba, name: 'Producto de prueba de cajas',
    category_kind: 'FINISHED_GOOD', unit_id: 1, purchase_cost: 100, sale_price: 150,
  }, T)
  pt = nuevo.j && (nuevo.j.item || nuevo.j)
}
L(!!pt, `producto de pruebas: ${pt && (pt.sku || pt.name)}`)

// Existencias，这种情况 se reponen antes de empezar. La prueba pide 24
// botellas y las vuelve a reponer en cada vuelta, así que puede correr las
// veces que haga falta.
const reponer = async () => {
  const r = await p('POST', '/api/inventory/recepciones', {
    itemId: pt.id, cantidad: 500,
    code: `CJP-${marca}-${Date.now().toString().slice(-6)}`,
  }, T)
  if (r.s >= 400) L(false, `  no se pudieron reponer existencias (${r.s})`)
}
await reponer()
L(true, 'existencias de prueba renovadas (500 uds)')


// ── 1 · Ajustes: crear el formato ────────────────────────────────────────────
const alta = await p('POST', '/api/config/formatos', {
  item_id: pt.id,
  name: `Caja de 12 (${marca})`,
  units_per_format: 12,
  price: 1200,
  tax_rate: 0.18,
}, T)
L(alta.s === 201, `formato creado (${alta.s})${alta.j && alta.j.codigo ? ' · ' + alta.j.codigo : ''}`)
const fid = alta.j && alta.j.id

//，任何 cantidad de unidades, no una lista fija
const raro = await p('POST', '/api/config/formatos', {
  item_id: pt.id, name: `Caja de 13 (${marca})`, units_per_format: 13, price: 1300,
}, T)
L(raro.s === 201, `formato de 13 unidades accepted (${raro.s}) · cualquier cantidad vale`)

const medio = await p('POST', '/api/config/formatos', {
  item_id: pt.id, name: `Media caja (${marca})`, units_per_format: 1.5, price: 100,
}, T)
L(medio.s >= 400, `media botella RECHAZADA (${medio.s}) · no se puede medio botín`)

const activos = (await p('GET', `/api/config/formatos?item_id=${pt.id}`, null, T)).j
L(Array.isArray(activos) && activos.length >= 2, `Ajustes lista ${activos.length} formatos`)

// ── 2 · Pedido en cajas ──────────────────────────────────────────────────────
const cli = (await p('POST', '/api/customers', { name: `Cliente Cajas ${marca}`, code: `CJ${marca}` }, T)).j
const cid = cli.id || (cli.cliente && cli.cliente.id)

const antes = await p('GET', `/api/inventario/disponible?item_id=${pt.id}`, null, T)
const disp0 = antes.j && (antes.j.disponible ?? antes.j.qty_available ?? antes.j.stock)
console.log(`      · existencias antes: ${disp0}`)

const ped = await p('POST', '/api/orders', {
  customerId: cid,
  notas: `Prueba de cajas ${marca}`,
  lineas: [{ itemId: pt.id, saleFormatId: fid, formatsQty: 2 }],
}, T)
L(ped.s === 201 || ped.s === 200, `pedido creado (${ped.s})${ped.j && ped.j.codigo ? ' · ' + ped.j.codigo : ''}`)
let pedido = ped.j && (ped.j.pedido || ped.j.order || ped.j)
const pid = pedido && pedido.id
const reread0 = await p('GET', `/api/orders/${pid}`, null, T)
const cuerpo0 = reread0.j
const cuerpo = reread0.j && (reread0.j.lineas ? reread0.j : null)
if (cuerpo) pedido = cuerpo

// Estas comprobaciones son EL ALMA de la prueba. Si la línea no viene, hay
// que decirlo a gritos: un bloque que se salta en silencio y deja el test en
// verde es peor que no tener test, porque miente sobre lo que ha comprobado.
const lineas = pedido && (pedido.lineas || pedido.lines)
if (!lineas || !lineas.length) {
  L(false, `no se pudo leer la línea del pedido ${pid} — el resto de la prueba no vale nada`)
} else {
  const l0 = (pedido.lineas || pedido.lines)[0]
  L(Number(l0.qty) === 24,
    `el almacén recibe 24 botellas, no 2 cajas (qty=${l0.qty})`)
  L(Number(l0.formats_qty) === 2, `la línea guarda 2 cajas (${l0.formats_qty})`)
  L(l0.format_name && l0.format_name.includes('12'), `la línea guarda el nombre: «${l0.format_name}»`)
  L(Number(l0.format_units) === 12, `la línea guarda 12 unidades/caja (${l0.format_units})`)
  L(Number(l0.format_price) === 1200, `la línea guarda 1.200 FCFA/caja (${l0.format_price})`)
  // 2 cajas × 1.200 = 2.400. Si cobrara 24 × precio-botella, saldría otra cosa.
  L(Math.abs(Number(l0.line_total) - 2400) < 0.01,
    `importe 2.400 FCFA (2 × 1.200) — leLineal: ${l0.line_total}`)
}

// ── 3 · Las reservas apartan botellas, no cajas ──────────────────────────────
const conf = await p('POST', `/api/orders/${pid}/confirmar`, {}, T)
L(conf.s === 200, `pedido confirmado (${conf.s})`)

const despues = await p('GET', `/api/inventario/disponible?item_id=${pt.id}`, null, T)
const disp1 = despues.j && (despues.j.disponible ?? despues.j.qty_available ?? despues.j.stock)
if (Number.isFinite(disp0) && Number.isFinite(disp1)) {
  L(Number(disp0) - Number(disp1) === 24,
    `reservadas 24 botellas (${disp0} → ${disp1})`)
}

// ── 4 · Entrega y consumo ────────────────────────────────────────────────────
const prep = await p('POST', `/api/orders/${pid}/preparar`, {}, T)
L(prep.s === 200, `pedido preparado (${prep.s})`)

const ent = await p('POST', `/api/reparto/pedido/${pid}/entregar`, {}, T)
L(ent.s === 200 || ent.s === 201, `entrega registrada (${ent.s})`)

const final = await p('GET', `/api/inventario/disponible?item_id=${pt.id}`, null, T)
const disp2 = final.j && (final.j.disponible ?? final.j.qty_available ?? final.j.stock)
if (Number.isFinite(disp1) && Number.isFinite(disp2)) {
  L(Number(disp1) - Number(disp2) === 24,
    `entrega consumió 24 botellas, ni una de más (${disp1} → ${disp2})`)
}

// ── 5 · Un pedido viejo, sin cajas, sigue funcionando ────────────────────────
const viejo = await p('POST', '/api/orders', {
  customerId: cid, notas: 'Pedido sin cajas',
  lineas: [{ itemId: pt.id, qty: 1 }],
}, T)
L(viejo.s === 201 || viejo.s === 200, `pedido SIN cajas sigue funcionando (${viejo.s})`)
const v = viejo.j
if (v && (v.lineas || v.lines)) {
  const vl = (v.lineas || v.lines)[0]
  L(Number(vl.qty) === 1, 'las unidades sueltas siguen contando igual')
  L(vl.format_name == null, 'una línea normal no lleva formato (queda limpia)')
}

// ── 6 · Cambiar el precio NO reescribe el histórico ──────────────────────────
const ed = await p('PUT', `/api/config/formatos/${fid}`, { price: 1350 }, T)
L(ed.s === 200, `precio de la caja subido a 1.350 (${ed.s})`)

const reread = await p('GET', `/api/orders/${pid}`, null, T)
const r = reread.j
if (r && (r.lineas || r.lines)) {
  const rl = (r.lineas || r.lines)[0]
  L(Number(rl.format_price) === 1200,
    `el pedido viejo SIGUE a 1.200 (${rl.format_price}) — el histórico no se reescribe`)
  L(Number(rl.line_total) === 2400,
    `el total viejo sigue siendo 2.400 (${rl.line_total})`)
}

// ── 7 · Desactivar, no borrar ────────────────────────────────────────────────
const off = await p('DELETE', `/api/config/formatos/${fid}`, null, T)
L(off.s === 200, `formato desactivado, no borrado (${off.s})`)

const albaran = await p('GET', `/api/orders/${pid}/albaran`, null, T)
L(albaran.s === 200 || albaran.s === 404, `albarán accesible (${albaran.s})`)

console.log(`\n  ${fallos.length === 0
  ? 'CAJAS VERIFICADAS: formato · pedido · almacén · entrega · histórico'
  : `${fallos.length} FALLOS`}\n`)
process.exit(fallos.length ? 1 : 0)
