// ═══════════════════════════════════════════════════════════════════════════
// COMISIONES MENSUALES · PRUEBA DE EXTREMO A EXTREMO
// ═══════════════════════════════════════════════════════════════════════════
//
// Se prueba contra la APLICACIÓN PÚBLICA, con el flujo REAL del ERP:
//
//   pedido → confirmar → entrega por la tarjeta del cliente → cobro
//
// y con DATOS AISLADOS: cliente nuestro, dos pedidos nuestros, cobros
// nuestros. Al final se anulan los pedidos. Las comisiones de prueba se
// quedan en el historial, que es justo lo que un sistema de comisiones
// tiene que conservar.
//
// ── LO QUE NO SE HACE ──────────────────────────────────────────────────────
//
// No se manda ningún importe al cobrar. El endpoint RECHAZA que el cliente
// mande el importe: lo calcula la base. Para tener un cobro PARCIAL se
// entrega parte del pedido, y lo pendiente de entregar es lo que queda por
// cobrar. Por eso el caso del parcial no se simula: se hace de verdad.
//
const URL = process.env.PUBLIC_URL || 'https://sahel-erp.onrender.com'
const U = process.env.TEST_USER || 'admin'
const P = process.env.TEST_PASS

let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

async function api(token, ruta, metodo = 'GET', cuerpo) {
  const r = await fetch(`${URL}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  const t = await r.text()
  let j = null
  try { j = t ? JSON.parse(t) : null } catch { j = { crudo: t.slice(0, 200) } }
  return { status: r.status, body: j }
}

async function login(u, p) {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  })
  const j = await r.json()
  if (!j.access) throw new Error(`No se ha podido entrar como ${u}: ${JSON.stringify(j).slice(0, 140)}`)
  return j.access
}

const MARCA = 'PRUEBA-COMISION'
const PERIODO = '2026-10'
const admin = await login(U, P)

let clienteId, comercialId, comToken, pedidoA, pedidoB, comisionId
let importeA = 0, importeB = 0, cobradoA = 0

try {
  // ── 0 · EL CLIENTE Y EL ARTÍCULO ───────────────────────────────────────
  const cl = await api(admin, '/api/customers')
  const clientes = cl.body?.customers || cl.body?.clientes || []
  let cliente = clientes.find((c) => String(c.name || '').includes(MARCA))
  if (!cliente) {
    const alta = await api(admin, '/api/customers', 'POST', {
      name: `${MARCA} cliente`, zone_id: 10, comercial_id: 4,
    })
    cliente = alta.body?.customer || alta.body?.cliente || alta.body
    if (!cliente?.id) throw new Error(`No se ha podido crear el cliente: ${JSON.stringify(alta.body).slice(0, 160)}`)
  }
  clienteId = cliente.id
  comercialId = cliente.comercial_id
  chk(!!clienteId, `R0 · cliente de prueba (${cliente.code}, comercial ${comercialId})`)

  const coms = await api(admin, '/api/comerciales')
  const todos = coms.body?.comerciales || coms.body || []
  const f = todos.find((x) => x.comercial_id === comercialId || x.id === comercialId)
  const comUser = f?.username
  chk(!!comUser, `R0b · el comercial tiene usuario (${comUser})`)
  if (comUser) {
    try { comToken = await login(comUser, process.env.TEST_PASS_COM || P) } catch { comToken = null }
    chk(!!comToken, `R0c · se ha entrado como el comercial`)
  }

  const items = await api(admin, '/api/items?limit=20')
  const arts = items.body?.items || items.body || []
  const art = arts.find((a) => Number(a.sale_price) > 0)
  chk(!!art, `R0d · artículo de venta (${art?.sku}, ${art?.sale_price})`)

  // ── 0 · LOS DOS PEDIDOS ─────────────────────────────────────────────────
  const mk = async (units) => {
    const r = await api(admin, '/api/orders', 'POST', {
      customerId: clienteId, lineas: [{ itemId: art.id, qty: units }], notas: MARCA,
    })
    if (r.status !== 201) throw new Error(`No se ha podido crear el pedido: ${JSON.stringify(r.body).slice(0, 180)}`)
    return (r.body.order || r.body.pedido || r.body).id
  }
  pedidoA = await mk(10)
  pedidoB = await mk(5)
  await api(admin, `/api/orders/${pedidoA}/confirmar`, 'POST', {})
  await api(admin, `/api/orders/${pedidoB}/confirmar`, 'POST', {})
  const detA = await api(admin, `/api/orders/${pedidoA}`)
  const detB = await api(admin, `/api/orders/${pedidoB}`)
  importeA = Number(detA.body?.total ?? 0)
  importeB = Number(detB.body?.total ?? 0)
  chk(importeA > 0 && importeB > 0, `R0e · dos pedidos con importe (${importeA}, ${importeB})`)

  // ── ENTREGA PARCIAL DEL PEDIDO A ────────────────────────────────────────
  // Se entrega la mitad. Lo que queda pendiente de entregar es lo que queda
  // por cobrar: ese es el COBRO PARCIAL, hecho de verdad.
  const linea = (detA.body?.lineas || [])[0]
  const media = Math.floor(Number(linea?.qty ?? 10) / 2)
  const ent = await api(admin, `/api/reparto/pedido/${pedidoA}/entregar`, 'POST', {
    clienteId, recibe: 'Prueba automatica',
    lineas: [{ lineId: linea?.id ?? linea?.line_id ?? null, qty: media }],
  })
  chk(ent.status === 201, `R0f · entrega parcial por la tarjeta (HTTP ${ent.status})`)

  // ── EL COBRO PARCIAL ────────────────────────────────────────────────────
  const cob = await api(admin, '/api/payments', 'POST', {
    pedidoId: pedidoA, metodo: 'CASH', referencia: MARCA,
  })
  chk(cob.status === 201 || cob.status === 200, `R4 · el cobro parcial se registra (HTTP ${cob.status})`)

  // El total del pedido NO cambia al cobrar: lo que cambia es lo PENDIENTE.
  // El importe cobrado sale del propio cobro, que es la verdad.
  const cobradoReal = Number(cob.body?.pago?.amount ?? cob.body?.amount
    ?? cob.body?.importe ?? cob.body?.pago?.importe ?? 0)
  const pendienteDeCobrar = importeA - cobradoReal
  chk(cobradoReal > 0 && pendienteDeCobrar > 0 && pendienteDeCobrar < importeA,
    `R4b · el cobro es PARCIAL: se cobran ${cobradoReal} de ${importeA}`)

  // Y un segundo cobro del MISMO pedido NO duplica: lo pendiente es lo que hay.
  const cob2 = await api(admin, '/api/payments', 'POST', {
    pedidoId: pedidoA, metodo: 'CASH', referencia: MARCA,
  })
  chk(cob2.status === 409 || cob2.status === 400 || cob2.status === 201,
    `R4c · el segundo cobro del mismo pedido se controla (HTTP ${cob2.status})`)
  chk(cob2.status === 409, `R4d · el segundo cobro se rechaza con 409 (HTTP ${cob2.status})`)

  // ── 1 · EL PORCENTAJE Y LA ESTIMACIÓN ──────────────────────────────────
  const pct = await api(admin, '/api/comisiones/porcentajes', 'POST', {
    comercial_id: comercialId, porcentaje: 3, vigente_desde: '2026-10-01', motivo: 'Prueba automatica',
  })
  chk(pct.status === 200, `R1 · porcentaje al 3 % (HTTP ${pct.status})`)

  const mi = await api(comToken || admin, `/api/comisiones/mi/${PERIODO}`)
  const calc = mi.body?.calculo
  chk(!!calc, `R1b · el calculo responde (${mi.status})`)
  chk(calc && Math.abs(Number(calc.base_cobrada) - pendienteDeCobrar) < 2,
    `R1c · la base cobrada es lo cobrado (${calc?.base_cobrada} ≈ ${pendienteDeCobrar})`)
  chk(calc && Math.abs(Number(calc.comision_estimada) - Math.round(pendienteDeCobrar * 0.03)) < 2,
    `R1d · comision = base × 3 % (${calc?.comision_estimada} ≈ ${Math.round(pendienteDeCobrar * 0.03)})`)
  chk(calc?.moneda === 'XOF', `R1e · en la moneda base (${calc?.moneda})`)

  // ── 3 · PENDIENTE Y COBRADO, APARTADOS ──────────────────────────────────
  chk(calc && Number(calc.base_pendiente) >= importeB,
    `R3 · lo pendiente va aparte (cobrado ${calc?.base_cobrada}, pendiente ${calc?.base_pendiente})`)

  // ── 2 · VARIOS PEDIDOS DEL MISMO MES ────────────────────────────────────
  chk(calc && (calc.pedidos || []).length >= 2,
    `R2 · los dos pedidos del mes se acumulan (${calc?.pedidos?.length})`)

  // ── 5 · EL COMERCIAL VE UNA ESTIMACIÓN PROVISIONAL ──────────────────────
  if (comToken) {
    const v = await api(comToken, `/api/comisiones/mi/${PERIODO}`)
    chk(v.status === 200, `R5 · el comercial ve su resumen (HTTP ${v.status})`)
    chk(v.body?.provisional === true, 'R5b · lo que ve es una estimación provisional')
    chk(!v.body?.comision?.comision_confirmada, 'R5c · NO ve comisión definitiva antes de confirmar')
  }

  // ── 6 · LA DEFINITIVA SOLO TRAS CONFIRMAR ───────────────────────────────
  const prep = await api(admin, '/api/comisiones/preparar', 'POST', { periodo: PERIODO })
  chk(prep.status === 200, `R6 · el administrador prepara el mes (HTTP ${prep.status})`)
  const g = (prep.body?.comisiones || []).find((c) => c.comercial_id === comercialId)
  chk(!!g, 'R6b · hay resumen guardado para el comercial')
  comisionId = g?.id

  const conf = await api(admin, `/api/comisiones/${comisionId}/confirmar`, 'POST', { nota: 'Prueba automatica' })
  chk(conf.status === 200, `R6c · el administrador confirma (HTTP ${conf.status})`)
  chk(Number(conf.body?.comision?.comision_confirmada) > 0, 'R6d · la comisión confirmada tiene importe')
  chk(conf.body?.comision?.confirmado_por != null, 'R6e · consta QUIEN confirmó')

  if (comToken) {
    const v = await api(comToken, `/api/comisiones/mi/${PERIODO}`)
    chk(v.body?.provisional === false, 'R6f · tras confirmar ve la DEFINITIVA')
    chk(v.body?.comision?.estado === 'CONFIRMADA_PENDIENTE_PAGO',
      `R6g · estado «confirmada, pendiente de pago» (${v.body?.comision?.estado})`)
  }

  // ── 7 · CAMBIAR EL PORCENTAJE NO TOCA UN MES CONFIRMADO ─────────────────
  const confirmada = Number(conf.body.comision.comision_confirmada)
  const pctBase = Number(conf.body.comision.porcentaje_confirmado)
  await api(admin, '/api/comisiones/porcentajes', 'POST', {
    comercial_id: comercialId, porcentaje: 9, vigente_desde: '2026-10-15', motivo: 'Revision posterior',
  })
  const tras = await api(admin, `/api/comisiones/${comisionId}`)
  chk(Number(tras.body?.comision?.comision_confirmada) === confirmada,
    `R7 · cambiar el porcentaje NO altera la confirmada (${confirmada})`)
  chk(Number(tras.body?.comision?.porcentaje_confirmado) === pctBase,
    `R7b · el porcentaje congelado sigue siendo ${pctBase}`)

  // ── 8 · CONFIRMAR Y PAGAR RESISTEN REPETICIONES ─────────────────────────
  const conf2 = await api(admin, `/api/comisiones/${comisionId}/confirmar`, 'POST', { nota: 'Repeticion' })
  chk(Number(conf2.body?.comision?.comision_confirmada) === confirmada,
    'R8 · confirmar dos veces no cambia el importe')
  const prep2 = await api(admin, '/api/comisiones/preparar', 'POST', { periodo: PERIODO })
  const g2 = (prep2.body?.comisiones || []).find((c) => c.id === comisionId)
  chk(Number(g2?.comision_confirmada) === confirmada, 'R8b · recalcular el mes no pisa la confirmada')

  const pago = await api(admin, `/api/comisiones/${comisionId}/pagar`, 'POST', {
    importe: confirmada, fecha: '2026-10-31', referencia: MARCA,
  })
  chk(pago.status === 200, `R8c · se registra el pago (HTTP ${pago.status})`)
  chk(pago.body?.comision?.estado === 'PAGADA', `R8d · estado PAGADA (${pago.body?.comision?.estado})`)
  const pagoSinImporte = await api(admin, `/api/comisiones/${comisionId}/pagar`, 'POST', { fecha: '2026-10-31' })
  chk(pagoSinImporte.status >= 400, `R8e · no se puede pagar sin importe (HTTP ${pagoSinImporte.status})`)

  // ── 9 · EL HISTORIAL ────────────────────────────────────────────────────
  const det = await api(admin, `/api/comisiones/${comisionId}`)
  chk(det.status === 200 && (det.body?.pagos?.length || 0) >= 1, 'R9 · el historial guarda el pago')
  chk((det.body?.auditoria?.length || 0) >= 2, `R9b · la auditoria guarda los cambios (${det.body?.auditoria?.length})`)

  // ── 10 · AISLAMIENTO ────────────────────────────────────────────────────
  if (comToken) {
    const l = await api(comToken, '/api/comisiones')
    const ajenas = (l.body?.comisiones || []).filter((c) => c.comercial_id !== comercialId)
    chk(ajenas.length === 0, `R10 · su listado solo tiene lo suyo (${ajenas.length} ajenas)`)
    // Pedir el resumen de OTRO comercial devuelve el SUYO, no el ajeno.
    const r = await api(comToken, `/api/comisiones/resumen/${PERIODO}?comercial_id=999`)
    const ajenos = (r.body?.resúmenes || []).filter((x) => x.comercial_id !== comercialId)
    chk(ajenos.length === 0, `R10b · pedir el resumen de otro devuelve el suyo (${ajenos.length} ajenos)`)
    // Y no puede confirmar, ni pagar, ni tocar porcentajes.
    const noConfirma = await api(comToken, `/api/comisiones/${comisionId}/confirmar`, 'POST', {})
    chk(noConfirma.status === 403, `R10c · el comercial NO confirma (HTTP ${noConfirma.status})`)
    const noPaga = await api(comToken, `/api/comisiones/${comisionId}/pagar`, 'POST', { importe: 1, fecha: '2026-10-31' })
    chk(noPaga.status === 403, `R10d · el comercial NO registra pagos (HTTP ${noPaga.status})`)
    const noConfigura = await api(comToken, '/api/comisiones/porcentajes', 'POST', {
      comercial_id: comercialId, porcentaje: 50, motivo: 'Me quiero dar mas',
    })
    chk(noConfigura.status === 403, `R10e · el comercial NO cambia porcentajes (HTTP ${noConfigura.status})`)
  }

  // ── 11 · LOS TOTALES COINCIDEN CON LOS MOVIMIENTOS ─────────────────────
  const cal = (await api(comToken || admin, `/api/comisiones/mi/${PERIODO}`)).body?.calculo
  const suma = (cal?.cobros || []).reduce((s, c) => s + Number(c.importe_base), 0)
  chk(Math.abs(suma - Number(cal?.base_cobrada)) < 2,
    `R11 · la base es la suma de los cobros del detalle (${suma} = ${cal?.base_cobrada})`)
  chk((cal?.cobros || []).every((c) => c.estado === 'VERIFIED'),
    'R11b · en la base solo entran los cobros VERIFICADOS')
} catch (e) {
  chk(false, `EXCEPCION · ${String(e.message).slice(0, 160)}`)
} finally {
  for (const pid of [pedidoA, pedidoB].filter(Boolean)) {
    await api(admin, `/api/orders/${pid}/anular`, 'POST', { motivo: MARCA })
  }
  console.log(`  · pedidos de prueba anulados: ${[pedidoA, pedidoB].filter(Boolean).join(', ')}`)
}

console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
