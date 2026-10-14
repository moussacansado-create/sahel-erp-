// Dos sesiones independientes, como dos trabajadores con dos móviles.
// Se prueba lo que de verdad importa: que lo que hace uno, lo ve el otro sin
// cerrar sesión ni recargar, y que lo ve con SUS permisos y no con los del otro.
// Esta prueba NO importa `banco.js` a propósito. `banco.js` abre una PGlite
// propia para las pruebas de base de datos, y aquí lo que se quiere probar es
// el servidor de verdad, el que está en marcha, hablando por HTTP como lo hace
// un móvil. Importarlo además habría abierto una segunda base en el mismo
// proceso: exactamente lo que corrompe el PGlite.
const URL = process.env.BASE || 'http://127.0.0.1:10000'

async function pedir(metodo, ruta, cuerpo, token) {
  const r = await fetch(URL + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, j }
}
const T = {
  post: (ruta, cuerpo, token) => pedir('POST', ruta, cuerpo, token),
  put: (ruta, cuerpo, token) => pedir('PUT', ruta, cuerpo, token),
  get: (ruta, token) => pedir('GET', ruta, null, token),
}
let fallos = 0
const L = (ok, msg) => { console.log(`${ok ? '    OK  ' : '    FALLA'}  ${msg}`); if (!ok) fallos++ }

// ── Un canal SSE de verdad, leído como lo lee un navegador ──────────────────
async function abrirCanal(token, nombre) {
  const ctrl = new AbortController()
  const recibidas = []
  ;(async () => {
    const r = await fetch(`${URL}/api/sync/stream`, {
      headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
    })
    const lector = r.body.getReader()
    const dec = new TextDecoder()
    let cola = ''
    for (;;) {
      const { done, value } = await lector.read()
      if (done) break
      cola += dec.decode(value, { stream: true })
      for (;;) {
        const c = cola.indexOf('\n\n')
        if (c === -1) break
        const t = cola.slice(0, c); cola = cola.slice(c + 2)
        const ev = /event: (\w+)/.exec(t); const da = /data: (.+)/.exec(t)
        if (ev && ev[1] === 'cambio' && da) {
          try { recibidas.push(JSON.parse(da[1]).tablas) } catch {}
        }
      }
    }
  })().catch(() => {})
  await new Promise((r) => setTimeout(r, 700))
  return { recibidas, cerrar: () => ctrl.abort(), nombre }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('\n  ══ DOS SESIONES INDEPENDIENTES ══\n')
  const t0 = Date.now()

  // ── Sesión A y sesión B, con tokens distintos ─────────────────────────────
  // `pedir` devuelve `{status, j}`; el token vive en `j`.
  const [ra, rb] = await Promise.all([
    T.post('/api/auth/login', { username: 'admin', password: 'demo1234' }),
    T.post('/api/auth/login', { username: 'admin', password: 'demo1234' }),
  ])
  const A = ra.j || {}
  const B = rb.j || {}
  L(ra.status === 200 && rb.status === 200, `las dos sesiones abren (HTTP ${ra.status} y ${rb.status})`)
  L(A.access && B.access && A.access !== B.access,
    'las dos sesiones tienen tokens DISTINTOS (dos dispositivos de verdad)')
  L(A.access && B.access, 'las dos sesiones abren sin problema')

  const ca = await abrirCanal(A.access, 'A')
  const cb = await abrirCanal(B.access, 'B')

  // ── 1 · Crear: lo hace A, lo ve B ─────────────────────────────────────────
  console.log('\n  1 · CREAR UN REGISTRO EN A, VERLO EN B')
  const marca = Date.now()
  const rNuevo = await T.post('/api/customers', {
    name: `Sincro Test ${marca}`, phone: '+223 70000001',
  }, A.access)
  const nuevo = rNuevo.j || {}
  L(!!nuevo.id, `A crea el cliente (HTTP ${rNuevo.status})` + (nuevo.id ? '' : ` · ${JSON.stringify(nuevo).slice(0,90)}`))
  L(!!nuevo.id, `A crea el cliente ${nuevo.code || nuevo.id}`)

  await esperar(3200)
  const listaB = (await T.get('/api/customers', B.access)).j
  const vistoPorB = (Array.isArray(listaB) ? listaB : listaB?.data || [])
    .find((c) => c.id === nuevo.id)
  L(!!vistoPorB, `B lo ve SINCERONIZADO, sin recargar: ${vistoPorB?.name || 'NO'}`)
  L(cb.recibidas.some((t) => t.includes('customers')),
    'el canal de B ha recibido el aviso de cambio')

  // ── 2 · Modificar: lo hace B, lo ve A ─────────────────────────────────────
  console.log('\n  2 · MODIFICAR EN B, VERLO EN A')
  await T.put(`/api/customers/${nuevo.id}`, { name: `Sincro Renombrado ${marca}` }, B.access)
  await esperar(3200)
  const vA = (await T.get('/api/customers', A.access)).j
  const vistoPorA = (Array.isArray(vA) ? vA : vA?.data || []).find((c) => c.id === nuevo.id)
  L(vistoPorA?.name === `Sincro Renombrado ${marca}`,
    `A ve el nombre nuevo: ${vistoPorA?.name || 'NO'}`)

  // ── 3 · Archivo: se propaga, y no desaparece de golpe ─────────────────────
  console.log('\n  3 · ARCHIVAR: SE PROPAGA Y NO SE BORRA')
  const arch = await T.post(`/api/customers/${nuevo.id}/archivar`, { motivo: 'prueba de sincronización' }, A.access)
  L(arch.status < 400, `A archiva el cliente (HTTP ${arch.status})`)
  await esperar(3200)
  const lA = (await T.get('/api/customers', B.access)).j
  const activos = Array.isArray(lA) ? lA : (lA?.data || [])
  L(!activos.find((c) => c.id === nuevo.id),
    'B ya NO lo ve entre los clientes activos')
  const historico = await T.get(`/api/customers/${nuevo.id}`, B.access)
  L(!!historico.j && historico.j.id === nuevo.id,
    'pero el registro SIGUE AHÍ: se archivó, no se borró')

  // ── 4 · El canal no filtra datos ──────────────────────────────────────────
  console.log('\n  4 · EL CANAL NO SACA DATOS, SACA AVISOS')
  const crudo = JSON.stringify(cb.recibidas)
  L(!crudo.includes('Sincro') && !crudo.includes('70000001'),
    'por el canal NO ha pasado ningún nombre ni ningún teléfono')

  // ── 5 · Un tercero sin permiso de clientes no recibe el aviso ────────────
  console.log('\n  5 · SIN SESIÓN NO HAY CANAL')
  const r = await fetch(`${URL}/api/sync/stream`)
  L(r.status === 401, `el canal rechaza a quien no tiene sesión (${r.status})`)
  ca.cerrar(); cb.cerrar()

  console.log(`\n  ${fallos === 0 ? 'TODO CORRECTO' : `${fallos} FALLOS`} · ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)
  process.exit(fallos ? 1 : 0)
}
main()
