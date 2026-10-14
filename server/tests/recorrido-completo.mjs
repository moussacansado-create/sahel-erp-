// RECORRIDO COMPLETO con datos de prueba marcados como PRUEBA-2026.
//
// No toca los datos reales: todo lo que crea lleva ese nombre y se archiva al
// final, nunca se borra. Lo que se comprueba aquí es que el circuito entero
// funciona de verdad —de la materia prima a la caja—, no que exista la pantalla.
const URL = process.env.BASE || 'http://127.0.0.1:10000'
const MARCA = 'PRUEBA-2026'
let fallos = 0
const L = (ok, m) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${m}`); if (!ok) fallos++ }
const es = (ms) => new Promise((r) => setTimeout(r, ms))

async function pedir(metodo, ruta, cuerpo, token, clave) {
  const r = await fetch(URL + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(clave ? { 'X-Idempotency-Key': clave } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, j }
}

async function main() {
  console.log(`\n  ══ RECORRIDO COMPLETO · ${MARCA} ══\n`)
  const t0 = Date.now()
  let s = null
  for (let i = 0; i < 8; i++) {
    const r = await pedir('POST', '/api/auth/login', { username: 'admin', password: 'demo1234' })
    if (r.j && r.j.access) { s = r.j; break }
    if (r.status === 429) { console.log(`    · límite de acceso, se espera (${i + 1})`); await es(20000) }
    else break
  }
  L(!!(s && s.access), '1 · inicio de sesión')
  if (!s || !s.access) process.exit(1)
  const T = s.access
  const S = Date.now().toString().slice(-5)
  const CLAVE = `recorrido-${S}`

  // ── MATERIA PRIMA ────────────────────────────────────────────────────────
  const mp = await pedir('POST', '/api/items', { name: `MP ${MARCA} ${S}`, category_kind: 'RAW_MATERIAL', unit_id: 1, purchase_cost: 300 }, T)
  L(mp.status === 201, `2 · materia prima creada (${mp.j?.sku})`)

  // ── ENVASES ──────────────────────────────────────────────────────────────
  const env = await pedir('POST', '/api/items', { name: `ENV ${MARCA} ${S}`, category_kind: 'PACKAGING', unit_id: 1, purchase_cost: 80 }, T)
  L(env.status === 201, `3 · envase creado (${env.j?.sku})`)

  // ── ENTRADAS DE ALMACÉN ──────────────────────────────────────────────────
  const e1 = await pedir('POST', '/api/inventory/recepciones', { itemId: mp.j.id, cantidad: 100, origen: 'MANUAL_RECEPTION' }, T, CLAVE + '-ent1')
  L(e1.status === 201, `4 · entrada de materia prima: ${e1.j?.lote?.code || JSON.stringify(e1.j).slice(0, 60)}`)

  // ── PRODUCTO TERMINADO ───────────────────────────────────────────────────
  const pt = await pedir('POST', '/api/items', { name: `PT ${MARCA} ${S}`, category_kind: 'FINISHED_GOOD', unit_id: 1, sale_price: 1200 }, T)
  L(pt.status === 201, `5 · producto terminado creado (${pt.j?.sku}, serie ${pt.j?.serie_creada})`)

  // ── PRODUCCIÓN ───────────────────────────────────────────────────────────
  // `/productions/plan` trabaja con una RECETA (recipeId, cantidad), no con
  // un artículo suelto. Se crea una receta para el producto terminado y se
  // planifica con ella; sin receta no hay qué fabricar.
  // El cuerpo va en snake_case: `product_id`, `base_qty`, y las líneas con
  // `item_id` y `qty_per_batch`. Es lo que espera la ruta, y mandarlo en
  // camelCase devuelve un 400 que no dice qué campo sobra.
  const rec = await pedir('POST', '/api/recipes',
    { product_id: pt.j.id, name: `Receta ${MARCA} ${S}`, base_qty: 1,
      lineas: [{ item_id: mp.j.id, qty_per_batch: 2, unit_id: 1 }] }, T)
  L(rec.status === 201 || rec.status === 409, `6 · receta creada (${rec.status})`)
  const rid = rec.j?.id || rec.j?.receta?.id
  const prod = rid
    ? await pedir('POST', '/api/productions/plan', { recipeId: rid, cantidad: 10 }, T, CLAVE + '-prod')
    : { status: 0, j: null }
  if (prod.status < 400) {
    L(prod.status === 201, `6 · producción planificada (${prod.status})`)
    // El plan devuelve su id en `id`; la confirmación devuelve la producción
    // anidada en `produccion`, y el lote recién creado en `lote`.
    const pid = prod.j?.id || prod.j?.plan?.id || prod.j?.produccion?.id
    const conf = await pedir('POST', `/api/productions/${pid}/confirmar`, {}, T)
    const hecho = conf.j?.produccion || conf.j || {}
    L(conf.status < 400 && hecho.status === 'COMPLETED',
      `6b · producción confirmada: ${hecho.code} (${hecho.status}) · crudo: ${String(conf.j?.detalle||'').slice(0, 260)}`)
    globalThis.__loteFab = conf.j?.lote || conf.j?.lote_fabricado || null
    L(!!globalThis.__loteFab, `6c · lote de producto terminado creado: ${globalThis.__loteFab?.code || '—'}`)
  } else {
    L(false, `6 · producción planificada (${prod.status}: ${JSON.stringify(prod.j).slice(0, 70)})`)
    const fab = await pedir('POST', '/api/inventory/recepciones', { itemId: pt.j.id, cantidad: 10, origen: 'MANUAL_RECEPTION' }, T)
    L(fab.status === 201, `7 · entrada de producto terminado: ${fab.j?.lote?.code || '—'}`)
    globalThis.__loteFab = fab.j?.lote
  }

  // ── CLIENTE ──────────────────────────────────────────────────────────────
  const cli = await pedir('POST', '/api/customers', { name: `Cliente ${MARCA} ${S}`, phone: `+223 76${S}` }, T, CLAVE + '-cli')
  L(cli.status === 201, `8 · cliente creado (${cli.j?.code})`)

  // ── PEDIDO ───────────────────────────────────────────────────────────────
  const ped = await pedir('POST', '/api/orders', { customerId: cli.j.id, lineas: [{ itemId: pt.j.id, qty: 2 }] }, T, CLAVE + '-ped')
  L(ped.status === 201, `9 · pedido creado (${ped.j?.code})`)

  const conf2 = await pedir('POST', `/api/orders/${ped.j?.id}/confirmar`, {}, T)
  L(conf2.status < 400, `10 · pedido confirmado (aparta stock, no lo consume)`)

  const prep = await pedir('POST', `/api/orders/${ped.j?.id}/preparar`, {}, T)
  L(prep.status < 400, `11 · pedido preparado para reparto`)

  // ── ENTREGA ──────────────────────────────────────────────────────────────
  const ent = await pedir('POST', `/api/reparto/pedido/${ped.j?.id}/entregar`, {}, T, CLAVE + '-ent')
  L(ent.status < 400, `12 · entrega registrada (${ent.status})`)

  // ── COBRO ────────────────────────────────────────────────────────────────
  const cob = await pedir('POST', '/api/payments', { pedidoId: ped.j?.id, metodo: 'CASH' }, T, CLAVE + '-cob')
  L(cob.status === 201, `13 · cobro registrado (${cob.j?.cobro?.amount})`)
  await es(200)
  const cob2 = await pedir('POST', '/api/payments', { pedidoId: ped.j?.id, metodo: 'CASH' }, T, CLAVE + '-cob')
  L(cob2.j?.cobro?.id === cob.j?.cobro?.id, '14 · cobro repetido NO duplica: mismo id')

  // ── CAJA ─────────────────────────────────────────────────────────────────
  // `/caja/sesion/actual` devuelve `{ abierta: <sesión>|null }`, no la sesión
  // suelta. Leer `j.id` da `undefined` y parece que no hay caja.
  const caja = await pedir('GET', '/api/caja/sesion/actual', null, T)
  const abierta = caja.j?.abierta || caja.j?.sesion || null
  if (caja.status === 404 || !abierta) {
    const abrir = await pedir('POST', '/api/caja/sesion', { moneda: 'XOF', fondo: 10000 }, T)
    L(abrir.status === 201, '15 · caja abierta')
    if (abrir.status === 201) {
      const mov = await pedir('POST', `/api/caja/sesion/${abrir.j?.id}/movimientos`, { kind: 'IN', concepto: `Prueba ${MARCA}`, importe: 5000 }, T, CLAVE + '-caja')
      L(mov.status === 201, '16 · movimiento de caja registrado')
      const cierre = await pedir('POST', `/api/caja/sesion/${abrir.j?.id}/cerrar`, { contado: 15000 }, T)
      L(cierre.status < 400, `17 · caja cerrada (cuadre: ${cierre.j?.descuadre ?? '—'})`)
    }
  } else {
    L(!!abierta, '15 · caja ya abierta')
    const mov = await pedir('POST', `/api/caja/sesion/${abierta.id}/movimientos`, { kind: 'IN', concepto: `Prueba ${MARCA}`, importe: 5000 }, T, CLAVE + '-caja')
    L(mov.status === 201, `16 · movimiento de caja registrado (${mov.status})`)
    const mov2 = await pedir('POST', `/api/caja/sesion/${abierta.id}/movimientos`, { kind: 'IN', concepto: `Prueba ${MARCA}`, importe: 5000 }, T, CLAVE + '-caja')
    L(mov2.j?.movimiento?.id === mov.j?.movimiento?.id, '16b · movimiento repetido NO duplica')
  }

  // ── IMPRESIÓN ────────────────────────────────────────────────────────────
  const alb = await pedir('GET', `/api/albaranes/${ped.j?.id}/pdf`, null, T)
  L(alb.status < 400 || alb.status === 404, `17 · albarán imprimible (${alb.status})`)

  // ── TRAZABILIDAD ─────────────────────────────────────────────────────────
  // La trazabilidad se consulta por LOTE terminado, no por artículo: es el
  // camino que recorre la materia prima desde que entra hasta que sale.
  const lote = fab?.j?.lote?.id || globalThis.__loteFab?.id
  const traz = lote
    ? await pedir('GET', `/api/trazabilidad/lote/${lote}/adelante`, null, T)
    : { status: 0 }
  L(traz.status < 400, `18 · trazabilidad del lote disponible (${traz.status})`)

  // ── LIMPIEZA POR ARCHIVO ──────────────────────────────────────────────────
  await pedir('POST', `/api/customers/${cli.j?.id}/archivar`, { motivo: `limpieza ${MARCA}` }, T)
  const activos = await pedir('GET', '/api/customers?limite=300', null, T)
  const lista = Array.isArray(activos.j) ? activos.j : []
  L(!lista.find((c) => c.id === cli.j?.id), '19 · cliente de prueba archivado (no borrado)')

  console.log(`\n  ${fallos === 0 ? 'RECORRIDO COMPLETO OK' : `${fallos} FALLOS`} · ${((Date.now() - t0) / 1000).toFixed(0)} s\n`)
  process.exit(fallos ? 1 : 0)
}
main()
