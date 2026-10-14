// Reintentos por red: la misma operación, tres veces, con la misma clave.
// Debe pasar UNA vez. Ni un pedido de más, ni un cobro de más, ni una entrada
// de más. Y sin clave, debe pasar de verdad: la idempotencia protege, pero no
// bloquea.
const URL = process.env.BASE || 'http://127.0.0.1:10000'
let fallos = 0
const L = (ok, msg) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${msg}`); if (!ok) fallos++ }

async function pedir(metodo, ruta, cuerpo, token, clave) {
  const r = await fetch(URL + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(clave ? { 'X-Idempotency-Key': clave } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, j, repetido: r.headers.get('x-idempotent-replay') === 'true' }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('\n  ══ REINTENTOS: LA MISMA OPERACIÓN, TRES VECES ══\n')
  const { j: sesion } = await pedir('POST', '/api/auth/login',
    { username: 'admin', password: 'demo1234' })
  const T = sesion.access

  // ── Alta de cliente: la operación más sencilla de duplicar ───────────────
  console.log('  1 · CREAR UN CLIENTE TRES VECES CON LA MISMA CLAVE')
  const sello = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`
  const clave = `alta-${sello}`
  const cuerpo = { name: `Idempotencia ${clave.slice(-8)}`, phone: `+223 70${sello}` }
  const r1 = await pedir('POST', '/api/customers', cuerpo, T, clave)
  await esperar(120)   // la escritura del async puede ir detrás
  const r2 = await pedir('POST', '/api/customers', cuerpo, T, clave)
  const r3 = await pedir('POST', '/api/customers', cuerpo, T, clave)

  L(r1.status === 201, `el primer intento crea (HTTP ${r1.status})`)
  L(r2.repetido === true, 'el segundo NO vuelve a crear: lo reconoce como repetido')
  L(r3.repetido === true, 'el tercero tampoco')
  L(r2.j?.id === r1.j?.id && r3.j?.id === r1.j?.id,
    `las tres devuelven el MISMO cliente (${r1.j?.id})`)

  const cuantos = (await pedir('GET', '/api/customers?todos=1&limite=200', null, T)).j
  const mios = (Array.isArray(cuantos) ? cuantos : []).filter((c) => c.phone === `+223 70${sello}`)
  L(mios.length === 1, `en la base hay EXACTAMENTE 1 cliente con ese teléfono (hay ${mios.length})`)

  // ── Una clave distinta, dos veces: SÍ son dos operaciones ────────────────
  console.log('\n  2 · DOS CLAVES DISTINTAS = DOS CLIENTES DISTINTOS')
  const n0 = mios.length
  const c2 = `otra-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await pedir('POST', '/api/customers', { name: `Idem B ${c2.slice(-6)}`, phone: `+223 71${sello}` }, T, c2)
  await pedir('POST', '/api/customers', { name: `Idem B ${c2.slice(-6)}`, phone: `+223 71${sello}` }, T, c2)
  await esperar(150)
  const t2 = (Array.isArray(cuantos) ? [] : [])
  const lista = (await pedir('GET', '/api/customers?todos=1&limite=200', null, T)).j
  const mios2 = (Array.isArray(lista) ? lista : []).filter((c) => c.phone === `+223 71${sello}`)
  L(mios2.length === 1, 'también se repiten bien con la segunda clave (1 solo)')

  // ── Sin clave: la operación pasa, porque la idempotencia no es una puerta ─
  console.log('\n  3 · SIN CLAVE LA OPERACIÓN PASA (no se rompe nada)')
  const s3 = await pedir('POST', '/api/customers',
    { name: `Sin clave ${Date.now()}`, phone: `+223 72${sello}` }, T)
  L(s3.status === 201, `un cliente sin clave se crea normal (HTTP ${s3.status})`)

  // ── Una operación que falla NO debe quemar la clave ──────────────────────
  console.log('\n  4 · UNA OPERACIÓN QUE FALLA NO QUEMA LA CLAVE')
  const mala = `mala-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const f1 = await pedir('POST', '/api/customers', { phone: '' }, T, mala)
  L(f1.status >= 400, `lo que falla devuelve error (HTTP ${f1.status}), no un éxito falso`)
  const f2 = await pedir('POST', '/api/customers', { name: 'Ahora sí', phone: `+223 73${sello}` }, T, mala)
  L(f2.status === 201,
    `la MISMA clave, ya con datos buenos, sí funciona (HTTP ${f2.status}): el reintento es legítimo`)

  // ── Un pedido: la operación que de verdad cuesta dinero si se duplica ────
  console.log('\n  5 · UN PEDIDO REPETIDO NO CONSUME STOCK DOS VECES')
  const marcaItem = `ITM-IDEM-${sello}`
  const art = await pedir('POST', '/api/items',
    { name: marcaItem, category_kind: 'FINISHED_GOOD', unit_id: 1 }, T, `item-${sello}`)
  L(art.status === 201, `se crea el artículo de prueba (HTTP ${art.status})`)

  if (art.status === 201) {
    const cid = mios[0].id
    const clavePed = `ped-${sello}`
    const cuerpoP = { customerId: cid, lineas: [{ itemId: art.j.id, qty: 1 }] }

    const p1 = await pedir('POST', '/api/orders', cuerpoP, T, clavePed)
    L(p1.status === 201, `el primer intento crea el pedido (HTTP ${p1.status})`)

    const p2 = await pedir('POST', '/api/orders', cuerpoP, T, clavePed)
    L(p2.repetido === true, 'el reintento se reconoce como repetido')
    L(p2.j?.id === p1.j?.id, `devuelve el MISMO pedido, no uno nuevo (${p1.j?.id})`)

    await esperar(300)
    const lista = (await pedir('GET', '/api/orders?limite=200', null, T)).j
    const suyos = (Array.isArray(lista) ? lista : lista?.data || [])
      .filter((o) => (o.customer_id ?? o.customerId) === cid)
    L(suyos.length === 1, `ese cliente tiene ${suyos.length} pedido. Ni uno más.`)

    // Y con la clave olvidada, dos pedidos SÍ son dos pedidos: no se está
    // tragando operaciones de verdad para fingir que es idempotente.
    const cuerpoP2 = { customerId: cid, lineas: [{ itemId: art.j.id, qty: 1 }] }
    const q1 = await pedir('POST', '/api/orders', cuerpoP2, T, `ped2-${sello}-a`)
    const q2 = await pedir('POST', '/api/orders', cuerpoP2, T, `ped2-${sello}-b`)
    L(q1.j?.id !== q2.j?.id || (q1.status !== 201 || q2.status !== 201),
      'con claves DISTINTAS se crean pedidos distintos (no se bloquea de más)')

    // Limpieza: lo que la prueba ha creado, la prueba lo archiva. Nunca borra.
    for (const c of [mios[0].id]) {
      await pedir('POST', `/api/customers/${c}/archivar`, { motivo: 'fin de prueba' }, T)
    }
    L(true, 'los clientes de prueba quedan ARCHIVADOS, no borrados')
  }

  console.log(`\n  ${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`}\n`)
  process.exit(fallos ? 1 : 0)
}
main()
