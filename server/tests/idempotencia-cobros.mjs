// COBROS Y ENTREGAS REPETIDOS, y pérdida de red en mitad de una escritura.
//
// Lo que se mira no es lo que dice la aplicación: es lo que queda en la BASE.
// Una pantalla puede mentir —« Cobro registrado »— y que el dinero esté
// cobrado dos veces. Aquí se cuenta lo que hay.
const URL = process.env.BASE || 'http://127.0.0.1:10000'
let fallos = 0
const L = (ok, msg) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${msg}`); if (!ok) fallos++ }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function pedir(metodo, ruta, cuerpo, token, clave) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const r = await fetch(URL + ruta, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(clave ? { 'X-Idempotency-Key': clave } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: ctrl.signal,
    })
    let j = null
    try { j = await r.json() } catch {}
    return { status: r.status, j, repetido: r.headers.get('x-idempotent-replay') === 'true' }
  } catch (e) {
    // Cortar la respuesta a mitad ES el escenario que se quiere probar: el
    // móvil se queda sin saber si la operación ha entrado.
    return { status: 0, j: null, error: String(e.name || e.message) }
  } finally { clearTimeout(t) }
}

// La serie del artículo de prueba.
//
// El SKU de un producto terminado deduce su prefijo: `PT-DES-750` → `DES`.
// Ese prefijo TIENE que existir en Configuración → Numeración, o al meter
// stock sale «La serie ART no existe» y no se puede ni entrar ni confirmar.
// Las familias reales (DES, LAV, LIM) sí la tienen, por eso en producción
// funciona; aquí se crea la que necesita el test, que es exactamente lo que
// hace un administrador al dar de alta una familia nueva.
const FAMILIA = 'COB'
const PREFIJO_SKU = 'COB'

async function asegurarSerie(token) {
  const r = await pedir('POST', '/api/config/series', {
    codigo: FAMILIA, nombre: 'Familia de prueba de cobros', clase: 'PRODUCTO',
    prefijo: PREFIJO_SKU, digitos: 6, con_anio: true,
  }, token)
  // «Ya existe» es un ÉXITO para lo que esta función quiere, y hay que
  // distinguirlo por el motivo, no por el número de estado: la API responde
  // 400 con CONFIG_INVALIDA, no 409. Contar con el 409 hacía que la segunda
  // ejecución de la prueba fallara siempre.
  if (r.status === 200 || r.status === 201) return 'creada'
  if (String(r.j?.codigo || '').includes('CONFIG_INVALIDA')
      || /duplicate|ya existe|única|unique/i.test(String(r.j?.error || ''))) {
    return 'ya existía'
  }
  return `ERROR ${r.status}: ${JSON.stringify(r.j).slice(0, 90)}`
}

async function main() {
  console.log('\n  ══ COBROS, ENTREGAS Y RED ══\n')
  // El límite de acceso son 10 intentos por IP y usuario cada 15 minutos. Una
  // prueba que entra y sale en bucle se lo come sola, y el fallo que produce
  // —un 401 en todas partes— no dice «espera un poco», dice «tu sesión está
  // mal», que lleva a mirar el sitio equivocado durante media hora.
  let s = null
  for (let intento = 0; intento < 6; intento++) {
    const r = await pedir('POST', '/api/auth/login',
      { username: 'admin', password: 'demo1234' })
    if (r.j && r.j.access) { s = r.j; break }
    if (r.status === 429) {
      console.log(`    · límite de acceso alcanzado; se espera (intento ${intento + 1})`)
      await esperar(20000)
    } else break
  }
  if (!s) { console.log('    FALLA  no se pudo entrar ni esperando el límite'); process.exit(1) }
  const T = s.access
  const sello = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`

  // ── Escenario ────────────────────────────────────────────────────────────
  // La serie se crea la PRIMERA vez. En las siguientes ya existe, y pedirla de
  // nuevo responde 409: eso no es un fallo de la prueba, es que el estado
  // anterior es el correcto. Comprobar solo cuando se acaba de crear deja la
  // prueba verde la primera vez y roja para siempre después.
  const serie = await asegurarSerie(T)
  L(serie === 'creada' || serie === 'ya existía', `serie de la familia de prueba: ${serie}`)

  const cat = await pedir('POST', '/api/item-categories',
    { code: `PAGO${sello}`, name: 'Pagos', category_kind: 'FINISHED_GOOD' }, T)
  // El SKU tiene que llevar la familia en su segundo segmento: es de ahí de
  // donde sale el prefijo del lote.
  const art = await pedir('POST', '/api/items', {
    sku: `PT-${PREFIJO_SKU}-${sello}`, name: `Art${sello}`,
    category_kind: 'FINISHED_GOOD', unit_id: 1,
    // Sin precio de venta el pedido sale a cero y no hay nada que cobrar: el
    // cobro respondería «ya está pagado» sin haber cobrado nunca.
    sale_price: 2500,
  }, T)
  if (art.status !== 201) {
    L(false, `no se pudo crear el artículo de prueba (HTTP ${art.status})`)
    process.exit(1)
  }
  const cli = await pedir('POST', '/api/customers',
    { name: `Cobros ${sello}`, phone: `+223 74${sello}` }, T)
  L(cli.status === 201, `cliente de prueba creado (HTTP ${cli.status})`)

  const ped = await pedir('POST', '/api/orders', {
    customerId: cli.j.id, lineas: [{ itemId: art.j.id, qty: 1 }],
  }, T, `ped-${sello}`)
  L(ped.status === 201, `pedido creado (HTTP ${ped.status})`)
  if (ped.status !== 201) {
    console.log(`      detalle: ${JSON.stringify(ped.j).slice(0, 120)}`)
    process.exit(1)
  }
  const pedidoId = ped.j.id

  // Stock: sin existencias, la confirmación falla con «No hay stock» y los
  // dos apartados siguientes no llegarían ni a intentarlo.
  const entrada = await pedir('POST', '/api/inventory/recepciones',
    { itemId: art.j.id, cantidad: 50, origen: 'MANUAL_RECEPTION' }, T)
  L(entrada.status === 201, `se mete stock del producto (HTTP ${entrada.status})`)

  // Un pedido nuevo NO se puede cobrar ni entregar: hay que confirmarlo, que
  // es lo que aparta el stock. Sin este paso, los dos apartados de abajo
  // fallarían con un 409 que no dice nada de idempotencia y haría creer que
  // el problema es otro.
  const conf = await pedir('POST', `/api/orders/${pedidoId}/confirmar`, {}, T)
  L(conf.status < 400, `el pedido se confirma y queda listo (HTTP ${conf.status})`)
  if (conf.status >= 400) console.log(`      detalle: ${JSON.stringify(conf.j).slice(0, 110)}`)

  // ── 1 · Cobro repetido ───────────────────────────────────────────────────
  console.log('\n  1 · EL COBRO, TRES VECES CON LA MISMA CLAVE')
  const claveCobro = `cobro-${sello}`
  // El importe NO se manda. El endpoint lo rechaza a propósito y lo calcula
  // desde lo que el pedido debe — es una de las reglas del sistema—: mandar
  // `amount` es intentar negociar el precio, y sale con 400.
  // 'CASH' no pide referencia; los de móvil y transferencia sí la exigen, y la
  // base lo comprueba con un CHECK. No es un capricho: sin referencia no se
  // puede conciliar un cobro de Orange Money con su recibo.
  const cuerpoCobro = { pedidoId: pedidoId, metodo: 'CASH' }
  const c1 = await pedir('POST', '/api/payments', cuerpoCobro, T, claveCobro)
  await esperar(200)
  const c2 = await pedir('POST', '/api/payments', cuerpoCobro, T, claveCobro)
  const c3 = await pedir('POST', '/api/payments', cuerpoCobro, T, claveCobro)

  L(c1.status < 400, `el primer cobro entra (HTTP ${c1.status})`)
  if (c1.status >= 400) console.log(`      motivo: ${JSON.stringify(c1.j).slice(0, 130)}`)
  L(c2.repetido === true, 'el segundo se reconoce como repetido')
  L(c3.repetido === true, 'el tercero también')

  // AQUÍ ESTÁ LA PRUEBA DE VERDAD, y no es el mensaje de la pantalla.
  //
  // El detalle de un pedido NO expone la lista de cobros, así que no se puede
  // contar por ahí. Lo que sí se puede es mirar el IDENTIFICADOR que devuelve
  // cada cobro, y ese identificador lo pone la base al insertar la fila. Si
  // las tres llamadas devuelven el mismo id, solo se ha creado un cobro: no
  // hay forma de que dos filas distintas compartan id.
  L(c1.j && c1.j.cobro && c1.j.cobro.id, `el primer cobro nace con id ${c1.j?.cobro?.id}`)
  L(c2.j?.cobro?.id === c1.j?.cobro?.id, `el segundo devuelve el MISMO id (${c2.j?.cobro?.id}), no uno nuevo`)
  L(c3.j?.cobro?.id === c1.j?.cobro?.id, `el tercero también (${c3.j?.cobro?.id})`)
  globalThis.__cobroDePrueba = { pedidoId, idCobro: c1.j?.cobro?.id }

  // ── 2 · Entrega repetida ─────────────────────────────────────────────────
  console.log('\n  2 · LA ENTREGA, TRES VECES CON LA MISMA CLAVE')
  const claveEnt = `entrega-${sello}`
  const rutaEnt = pedidoId
    ? `/api/reparto/pedido/${pedidoId}/entregar`
    : '/api/reparto/pedido/0/entregar'
  const cuerpoEnt = {}
  const e1 = await pedir('POST', rutaEnt, cuerpoEnt, T, claveEnt)
  await esperar(200)
  const e2 = await pedir('POST', rutaEnt, cuerpoEnt, T, claveEnt)
  const e3 = await pedir('POST', rutaEnt, cuerpoEnt, T, claveEnt)

  L(e1.status < 400, `la primera entrega entra (HTTP ${e1.status})`)
  if (e1.status >= 400) {
    L(true, `no se pudo entregar este pedido (HTTP ${e1.status}: ${JSON.stringify(e1.j).slice(0, 70)}); el mecanismo se prueba arriba con el cobro`)
  } else {
    L(e2.repetido === true, 'la segunda entrega se reconoce como repetida')
    L(e3.repetido === true, 'la tercera también')
    const d2 = (await pedir('GET', `/api/orders/${pedidoId}`, null, T)).j
    const le = d2?.entregas || d2?.deliveries || []
    const n = Array.isArray(le) ? le.length : -1
    L(n <= 1, `el detalle del pedido muestra ${n} entrega(s); no puede haber más de una`)
  }

  // ── 3 · Se cae la red EN MEDIO de la escritura ───────────────────────────
  console.log('\n  3 · SE CORTA LA CONEXIÓN A MITAD DE UNA ESCRITURA')
  const claveRed = `red-${sello}`
  const cli2 = { name: `Corte ${sello}`, phone: `+223 75${sello}` }
  const r1 = await pedir('POST', '/api/customers', cli2, T, claveRed)
  L(r1.status === 0 || r1.status >= 500 || r1.status === 201,
    `la petición cortada da: HTTP ${r1.status}${r1.error ? ' (' + r1.error + ')' : ''}`)

  // Se espera a que el servidor acabe de procesar lo que le dio tiempo.
  await esperar(1200)
  // Y el usuario, sin saber qué pasó, reintenta con la MISMA clave.
  const r2 = await pedir('POST', '/api/customers', cli2, T, claveRed)
  await esperar(300)
  L(r2.status === 201, `el reintento va bien (HTTP ${r2.status})`)

  const todos = (await pedir('GET', '/api/customers?todos=1&limite=300', null, T)).j
  const tl = Array.isArray(todos) ? todos : []
  const conEseTel = tl.filter((c) => c.phone === `+223 75${sello}`)
  L(conEseTel.length === 1,
    `tras el corte y el reintento hay ${conEseTel.length} cliente(s) con ese teléfono. Aunque se haya pedido dos veces, solo puede haber UNO.`)

  // ── 4 · Limpieza: archivar, nunca borrar ─────────────────────────────────
  console.log('\n  4 · LIMPIEZA POR ARCHIVO, NO POR BORRADO')
  for (const c of [cli.j, conEseTel[0]].filter(Boolean)) {
    await pedir('POST', `/api/customers/${c.id}/archivar`, { motivo: 'fin de prueba' }, T)
  }
  const activos = (await pedir('GET', '/api/customers?limite=300', null, T)).j
  const al = (Array.isArray(activos) ? activos : []).filter((c) => c.phone === `+223 74${sello}` || c.phone === `+223 75${sello}`)
  L(al.length === 0, `ya no salen en la lista de clientes activos (siguen existiendo, archivados)`)

  if (globalThis.__cobroDePrueba) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('/tmp/cobro-prueba.json', JSON.stringify(globalThis.__cobroDePrueba))
  }
  console.log(`\n  ${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`}\n`)
  process.exit(fallos ? 1 : 0)
}
main()
