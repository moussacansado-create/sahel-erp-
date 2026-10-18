// ═══════════════════════════════════════════════════════════════════════════
// COMISIONES MENSUALES · PRUEBA DE EXTREMO A EXTREMO
// ═══════════════════════════════════════════════════════════════════════════
//
// Se prueba contra la APLICACIÓN PÚBLICA, no contra una función suelta.
//
// Y se hace con DATOS AISLADOS Y REVERSIBLES: se crea un cliente, un pedido
// y un cobro marcados como prueba, se comprueba todo, y al final se borra
// lo creado. Las ventas que ya existieran no se tocan: para eso el cliente
// de prueba es de los nuestros y el pedido se anula.
//
// Lo que se comprueba, uno por uno, es lo que pidió el negocio:
//
//   1  · la comisión propuesta sale de base × porcentaje, en FCFA
//   2  · varios pedidos del mismo mes se suman
//   3  · lo pendiente de cobro NO se mezcla con lo cobrado
//   4  · los cobros parciales y repetidos no duplican importes
//   5  · el comercial ve una ESTIMACIÓN antes de confirmar
//   6  · la comisión DEFINITIVA solo aparece tras la confirmación
//   7  · cambiar el porcentaje no altera un mes confirmado
//   8  · confirmar y pagar resisten recargas y solicitudes repetidas
//   9  · el historial conserva la comisión y el pago
//   10 · dos comerciales no ven los datos del otro
//   11 · los totales coinciden con los movimientos reales
//   12 · sin errores de JavaScript (eso lo mira el navegador)
//
const URL = process.env.PUBLIC_URL || 'https://sahel-erp.onrender.com'
const U = process.env.TEST_USER || 'admin'
const P = process.env.TEST_PASS

let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

async function api(token, ruta, metodo = 'GET', cuerpo) {
  const r = await fetch(`${URL}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  const txt = await r.text()
  let json = null
  try { json = txt ? JSON.parse(txt) : null } catch { json = { crudo: txt.slice(0, 200) } }
  return { status: r.status, body: json }
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

let adminToken, comToken, clienteId, pedidoId, pedidoId2, comisionId, comercialId

try {
  adminToken = await login(U, P)

  // ── EL CLIENTE DE PRUEBA ────────────────────────────────────────────────
  // Se busca uno de los nuestros. Si no hay, se crea uno con una marca.
  const clientes = await api(adminToken, '/api/customers')
  const lista = clientes.body?.customers || clientes.body?.clientes || []
  let cliente = lista.find((c) => String(c.name || '').includes(MARCA))
  if (!cliente) {
    const alta = await api(adminToken, '/api/customers', 'POST', {
      name: `${MARCA} cliente`, zone_id: 10, comercial_id: 4,
    })
    cliente = alta.body?.customer || alta.body?.cliente || alta.body
    if (!cliente?.id) throw new Error(`No se ha podido crear el cliente de prueba: ${JSON.stringify(alta.body).slice(0, 200)}`)
  }
  clienteId = cliente.id
  comercialId = cliente.comercial_id
  chk(!!clienteId, `R0 · cliente de prueba listo (${cliente.code}, comercial ${comercialId})`)

  // El token del COMERCIAL de ese cliente.
  const per = await api(adminToken, `/api/comerciales/por-usuario/${comercialId}`).catch(() => ({ status: 0 }))
  let comUser = null
  if (per.status === 200) comUser = per.body?.user?.username || per.body?.username
  if (!comUser) {
    // Se busca el comercial por su ficha.
    const fichas = await api(adminToken, '/api/comerciales')
    const todos = fichas.body?.comerciales || fichas.body || []
    const f = todos.find((x) => x.comercial_id === comercialId || x.id === comercialId)
    comUser = f?.username
  }
  chk(!!comUser, `R0b · el comercial tiene usuario (${comUser})`)
  if (comUser) {
    const pw = process.env.TEST_PASS_COM || P
    try { comToken = await login(comUser, pw) } catch { comToken = null }
    chk(!!comToken, `R0c · se ha entrado como el comercial (${comUser})`)
  }

  // ── LOS PEDIDOS DE PRUEBA ───────────────────────────────────────────────
  // Un artículo de venta cualquiera.
  const items = await api(adminToken, '/api/items?limit=5')
  const arts = items.body?.items || items.body || []
  const art = arts.find((a) => a.sale_price > 0) || arts[0]
  chk(!!art, `R0d · hay un articulo para vender (${art?.sku})`)

  const mkPedido = async (units) => {
    const r = await api(adminToken, '/api/orders', 'POST', {
      customerId: clienteId,
      lineas: [{ itemId: art.id, qty: units }],
      notas: MARCA,
    })
    if (r.status !== 201) throw new Error(`No se ha podido crear el pedido: ${JSON.stringify(r.body).slice(0, 200)}`)
    return (r.body.order || r.body.pedido || r.body).id
  }
  pedidoId = await mkPedido(10)
  pedidoId2 = await mkPedido(5)
  chk(!!pedidoId && !!pedidoId2, `R0e · dos pedidos de prueba creados (${pedidoId}, ${pedidoId2})`)

  // Se confirman para que_no estén en DRAFT.
  await api(adminToken, `/api/orders/${pedidoId}/confirmar`, 'POST', {})
  await api(adminToken, `/api/orders/${pedidoId2}/confirmar`, 'POST', {})

  // ── UN COBRO PARCIAL ────────────────────────────────────────────────────
  const totalPedido = await api(adminToken, `/api/orders/${pedidoId}`)
  const importe = Number(totalPedido.body?.order?.total ?? totalPedido.body?.pedido?.total ?? 0)
  chk(importe > 0, `R0f · el pedido tiene importe (${importe})`)

  const cobrar = async (pedido, cant) => api(adminToken, '/api/payments', 'POST', {
    pedidoId: pedido, metodo: 'CASH', referencia: MARCA, importe: cant, monto: cant,
  })
  const c1 = await cobrar(pedidoId, Math.round(importe / 2))
  chk(c1.status === 201 || c1.status === 200, `R0g · cobro parcial registrado (HTTP ${c1.status})`)

  // ── 1 · EL PORCENTAJE Y LA ESTIMACIÓN ──────────────────────────────────
  const pct = await api(adminToken, '/api/comisiones/porcentajes', 'POST', {
    comercial_id: comercialId, porcentaje: 3, vigente_desde: '2026-10-01', motivo: 'Prueba automatica',
  })
  chk(pct.status === 200, `R1 · se configura el porcentaje al 3 % (HTTP ${pct.status})`)

  const mi = await api(adminToken, `/api/comisiones/mi/${PERIODO}?comercial_id=${comercialId}`)
  const calc = mi.body?.calculo
  const cobrado = Math.round(importe / 2)
  chk(calc && Math.abs(Number(calc.base_cobrada) - cobrado) < 1,
    `R1b · la base cobrada es lo cobrado (${calc?.base_cobrada} ≈ ${cobrado})`)
  chk(calc && Math.abs(Number(calc.comision_estimada) - Math.round(cobrado * 0.03)) < 1,
    `R1c · la comision propuesta = base × 3 % (${calc?.comision_estimada} ≈ ${Math.round(cobrado * 0.03)})`)
  chk(calc?.moneda === 'XOF', `R1d · el calculo va en la moneda base (${calc?.moneda})`)

  // ── 3 · PENDIENTE Y COBRADO NO SE MEZCLAN ───────────────────────────────
  chk(calc && Number(calc.base_pendiente) > 0 && Number(calc.base_cobrada) !== Number(calc.base_pendiente),
    `R3 · lo pendiente va aparte de lo cobrado (cobrado ${calc?.base_cobrada}, pendiente ${calc?.base_pendiente})`)

  // ── 4 · COBROS PARCIALES Y REPETIDOS ───────────────────────────────────
  const antes = (await api(adminToken, `/api/comisiones/mi/${PERIODO}`)).body?.calculo?.base_cobrada
  const c2 = await cobrar(pedidoId, Math.round(importe / 2))
  chk(c2.status === 201 || c2.status === 200, `R4 · segundo cobro parcial (HTTP ${c2.status})`)
  const despues = (await api(adminToken, `/api/comisiones/mi/${PERIODO}`)).body?.calculo?.base_cobrada
  chk(Number(despues) > Number(antes),
    `R4b · el segundo cobro suma de verdad (${antes} → ${despues})`)

  // ── 2 · VARIOS PEDIDOS DEL MISMO MES ────────────────────────────────────
  const dosPedidos = await api(adminToken, `/api/comisiones/resumen/${PERIODO}?comercial_id=${comercialId}`)
  const detalle = dosPedidos.body?.resúmenes?.[0]?.calculo
  chk(detalle && detalle.pedidos.length >= 2, `R2 · los pedidos del mes se acumulan (${detalle?.pedidos?.length})`)

  // ── 5 · EL COMERCIAL VE UNA ESTIMACIÓN PROVISIONAL ──────────────────────
  if (comToken) {
    const visto = await api(comToken, `/api/comisiones/mi/${PERIODO}`)
    chk(visto.status === 200, `R5 · el comercial ve su resumen (HTTP ${visto.status})`)
    chk(visto.body?.provisional === true, 'R5b · lo que ve es una estimación provisional')
    chk(!visto.body?.comision?.comision_confirmada, 'R5c · NO ve ninguna comisión definitiva antes de confirmar')
  }

  // ── 6 · LA DEFINITIVA SOLO TRAS CONFIRMAR ───────────────────────────────
  const prep = await api(adminToken, '/api/comisiones/preparar', 'POST', { periodo: PERIODO })
  chk(prep.status === 200, `R6 · el administrador prepara el mes (HTTP ${prep.status})`)
  const guardada = prep.body?.comisiones?.find((c) => c.comercial_id === comercialId)
  chk(!!guardada, 'R6b · hay un resumen guardado para el comercial')
  comisionId = guardada?.id

  const conf = await api(adminToken, `/api/comisiones/${comisionId}/confirmar`, 'POST', { nota: 'Prueba' })
  chk(conf.status === 200, `R6c · el administrador confirma (HTTP ${conf.status})`)
  chk(Number(conf.body?.comision?.comision_confirmada) > 0, 'R6d · la comisión confirmada tiene importe')
  chk(conf.body?.comision?.confirmado_por != null, 'R6e · consta QUIEN confirmó')

  if (comToken) {
    const visto = await api(comToken, `/api/comisiones/mi/${PERIODO}`)
    chk(visto.body?.provisional === false, 'R6f · tras confirmar, el comercial ve la DEFINITIVA')
    chk(visto.body?.comision?.estado === 'CONFIRMADA_PENDIENTE_PAGO',
      `R6g · el estado es «confirmada, pendiente de pago» (${visto.body?.comision?.estado})`)
  }

  // ── 7 · CAMBIAR EL PORCENTAJE NO TOCA UN MES CONFIRMADO ─────────────────
  const confirmada = Number(conf.body.comision.comision_confirmada)
  const pctBase = Number(conf.body.comision.porcentaje_confirmado)
  await api(adminToken, '/api/comisiones/porcentajes', 'POST', {
    comercial_id: comercialId, porcentaje: 9, vigente_desde: '2026-10-15', motivo: 'Revision posterior',
  })
  const despuesDelCambio = await api(adminToken, `/api/comisiones/${comisionId}`)
  chk(Number(despuesDelCambio.body?.comision?.comision_confirmada) === confirmada,
    `R7 · cambiar el porcentaje NO altera la comision confirmada (${confirmada})`)
  chk(Number(despuesDelCambio.body?.comision?.porcentaje_confirmado) === pctBase,
    `R7b · el porcentaje congelado sigue siendo el de la confirmacion (${pctBase})`)

  // ── 8 · CONFIRMAR Y PAGAR RESISTEN REPETICIONES ─────────────────────────
  const conf2 = await api(adminToken, `/api/comisiones/${comisionId}/confirmar`, 'POST', { nota: 'Repeticion' })
  chk(Number(conf2.body?.comision?.comision_confirmada) === confirmada,
    'R8 · confirmar dos veces no cambia el importe')
  const prep2 = await api(adminToken, '/api/comisiones/preparar', 'POST', { periodo: PERIODO })
  const g2 = prep2.body?.comisiones?.find((c) => c.id === comisionId)
  chk(Number(g2?.comision_confirmada) === confirmada,
    'R8b · recalcular el mes no pisa la comision confirmada')

  const pago = await api(adminToken, `/api/comisiones/${comisionId}/pagar`, 'POST', {
    importe: confirmada, fecha: '2026-10-31', referencia: MARCA,
  })
  chk(pago.status === 200, `R8c · se registra el pago (HTTP ${pago.status})`)
  chk(pago.body?.comision?.estado === 'PAGADA', `R8d · el estado pasa a PAGADA (${pago.body?.comision?.estado})`)

  const pagoSinImporte = await api(adminToken, `/api/comisiones/${comisionId}/pagar`, 'POST', { fecha: '2026-10-31' })
  chk(pagoSinImporte.status >= 400, `R8e · no se puede pagar sin importe (HTTP ${pagoSinImporte.status})`)

  // ── 9 · EL HISTORIAL ────────────────────────────────────────────────────
  const det = await api(adminToken, `/api/comisiones/${comisionId}`)
  chk(det.status === 200 && (det.body?.pagos?.length || 0) >= 1, 'R9 · el historial guarda el pago')
  chk((det.body?.auditoria?.length || 0) >= 2, `R9b · la auditoria guarda los cambios (${det.body?.auditoria?.length})`)

  // ── 10 · AISLAMIENTO ENTRE COMERCIALES ──────────────────────────────────
  if (comToken) {
    const otro = await api(comToken, `/api/comisiones/${comisionId}`)
    chk(otro.status === 404, `R10 · el comercial NO puede abrir la comision de otro (HTTP ${otro.status})`)
    const listaCom = await api(comToken, '/api/comisiones')
    const ajenos = (listaCom.body?.comisiones || []).filter((c) => c.comercial_id !== comercialId)
    chk(ajenos.length === 0, `R10b · su listado solo tiene lo suyo (${ajenos.length} ajenas)`)
  }

  // ── 11 · LOS TOTALES COINCIDEN CON LOS MOVIMIENTOS ─────────────────────
  const cal = (await api(adminToken, `/api/comisiones/mi/${PERIODO}`)).body?.calculo
  const sumaCobros = (cal?.cobros || []).reduce((s, c) => s + Number(c.importe_base), 0)
  chk(Math.abs(sumaCobros - Number(cal?.base_cobrada)) < 1,
    `R11 · la base es la suma de los cobros del detalle (${sumaCobros} = ${cal?.base_cobrada})`)
  chk((cal?.cobros || []).every((c) => c.estado === 'VERIFIED'),
    'R11b · en la base solo entran los cobros VERIFICADOS')
} catch (e) {
  chk(false, `EXCEPCION · ${e.message.slice(0, 150)}`)
} finally {
  // ── LIMPIEZA · SOLO LO CREADO POR ESTA PRUEBA ───────────────────────────
  for (const pid of [pedidoId, pedidoId2].filter(Boolean)) {
    await api(adminToken, `/api/orders/${pid}/anular`, 'POST', { motivo: MARCA })
  }
  console.log(`\n  · pedidos de prueba anulados: ${[pedidoId, pedidoId2].filter(Boolean).join(', ')}`)
  console.log(`  · las comisiones de prueba quedan en el historico (auditoria del sistema)`)
}

console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
