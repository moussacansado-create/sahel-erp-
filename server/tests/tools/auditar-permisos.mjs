/**
 * PERMISOS POR ROL.
 *
 * Que un botón esté oculto NO es una garantía: la garantía es que la API
 * conteste 403. Así que aquí se prueba la API, no la pantalla, y se mira lo que
 * cada rol PUEDE tanto como lo que NO puede: un permiso que falta es un
 * nombre, pero un permiso que sobra es un agujero, y un agujero se busca en la
 * respuesta, no en el botón.
 *
 * Cada rol se crea de verdad con su cuenta, entra de verdad, y se le pide de
 * verdad cada pantalla. Los usuarios de prueba se borran al terminar.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer')
const B = process.env.BASE || 'http://127.0.0.1:10000'
const SALIDA = new URL('../../../salida-estabilidad/', import.meta.url).pathname
const ACCESO = 'acceso_probe' + String(Date.now()).slice(-6)
const SUFIJO = 'z' + String(Date.now()).slice(-6)

// DELETE /api/users/:id NO borra: desactiva. Es a propósito —el historial de
// quien dio de alta y cobró tiene que seguir ahí—, y el arnés lo daba por
// borrado: reutilizaba el mismo nombre, el alta devolvía 409 «ya existe» y
// los ocho roles se quedaban sin probar. De ahí el sufijo en cada nombre.
const fallos = []
const chk = (ok, t) => { console.log('  ' + (ok ? 'OK   ' : 'FALLA') + '  ' + t); if (!ok) fallos.push(t) }

// Cada pantalla, con el permiso que la protege y el endpoint que la alimenta.
// Cada pantalla con lo que su ruta EXIGE de verdad, no lo que parece.
//
// La primera versión de esta lista adivinaba los nombres de permiso
// (`productions:view`, `inventory:create`) y por eso dio seis fugas que no
// eran fugas: la ruta de producción pide `production:view`, a secas, y la de
// entradas pide `inventory:view`, no `create`. Un informe de seguridad con el
// mapa equivocado es peor que ninguno, porque manda a arreglar cosas que
// estaban bien.
//
// Cada lista lleva TODOS los permisos que la ruta acepta, porque hay rutas
// con `requiereAlguno`: `/reparto` la abre quien tenga `deliveries:view` O
// `sales:view`, y con una sola de las dos en la lista todo parecería una fuga.
const PANTALLAS = [
  // Las tres ERRAN en la misma ruta, `/items`, y esa ruta pide
  // `requiereAlguno` sobre los cinco permisos de catálogo. Se tratan aparte
  // porque no es un agujero: es una decisión documentada del backend —leer el
  // catálogo es abierto a quien trabaje con él, escribir en él no— y la
  // PANTALLA sí exige el permiso de su módulo. Cambiarlo sería quitar acceso,
  // no quitar un error.
  ['materias-primas', ['raw_materials:view', 'packaging:view', 'products:view', 'inventory:view', 'lots:view'], '/items?tipo=RAW_MATERIAL'],
  ['envases', ['packaging:view', 'raw_materials:view', 'products:view', 'inventory:view', 'lots:view'], '/items?tipo=PACKAGING'],
  ['productos', ['products:view', 'raw_materials:view', 'packaging:view', 'inventory:view', 'lots:view'], '/items?tipo=FINISHED_GOOD'],
  ['recetas', ['recipes:view'], '/recipes'],
  ['produccion', ['production:view'], '/productions'],
  ['compras', ['purchases:view'], '/purchases'],
  ['lotes', ['lots:view', 'inventory:view'], '/inventory?limite=1'],
  ['entradas', ['inventory:view', 'lots:view'], '/inventory/entradas'],
  ['stock', ['inventory:view', 'lots:view'], '/inventory/resumen'],
  ['movimientos', ['inventory:view', 'lots:view'], '/inventory/movimientos'],
  ['clientes', ['customers:view'], '/customers'],
  ['pedidos', ['sales:view'], '/orders'],
  ['reparto', ['deliveries:view', 'sales:view'], '/reparto'],
  ['caja', ['cash:view'], '/caja/sesiones'],
  ['usuarios', ['users:view'], '/users'],
  ['configuracion', ['settings:view'], '/config'],
]

async function login(usuario) {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usuario, password: 'demo1234' }),
  })
  if (r.status === 429) return null
  return r.ok ? (await r.json()).access : null
}
const get = async (tok, ruta) => {
  const r = await fetch(B + ruta, { headers: { Authorization: 'Bearer ' + tok } })
  try { await r.json() } catch {}
  return r.status
}
const getJson = async (tok, ruta) => {
  const r = await fetch(B + ruta, { headers: { Authorization: 'Bearer ' + tok } })
  try { return await r.json() } catch { return null }
}
const post = async (tok, ruta, cuerpo) => {
  const r = await fetch(B + ruta, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(cuerpo),
  })
  try { return { s: r.status, j: await r.json() } } catch { return { s: r.status, j: null } }
}
async function borrarUsuario(tok, username) {
  const d = await getJson(tok, '/api/users')
  const u = (Array.isArray(d) ? d : (d && d.users) || []).find((x) => x.username === username)
  if (u) await fetch(B + '/api/users/' + u.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } })
}

async function main() {
  const nav = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const p = await nav.newPage()
  await p.setViewport({ width: 1440, height: 1000 })

  try {
    const adminTok = await login('admin')
    if (!adminTok) {
      console.log('\n  EL LOGIN ESTÁ CERRADO (429). Límite de 10 intentos cada 15 min.')
      process.exitCode = 1
      return
    }
    mkdirSync(SALIDA, { recursive: true })

    const roles = (await getJson(adminTok, '/api/roles')) || []
    const informe = []

    console.log('\n  CADA ROL CONTRA TODAS LAS PANTALLAS')
    console.log('  rol                 permitidas · negadas · fugas')
    for (const r of roles) {
      const usuario = 'probe' + SUFIJO + '_' + String(r.code).toLowerCase()
      await borrarUsuario(adminTok, usuario)
      const alta = await post(adminTok, '/api/users', {
        username: usuario, password: 'demo1234', fullName: 'Prueba ' + r.name, roles: [r.code],
      })
      if (alta.s >= 300) {
        chk(false, `${r.name}: no se pudo crear el usuario (${alta.s} ${JSON.stringify(alta.j).slice(0, 70)})`)
        continue
      }
      const tok = await login(usuario)
      if (!tok) { chk(false, `${r.name}: el usuario creado no puede entrar`); continue }

      const yo = await getJson(tok, '/api/auth/me')
      const mios = yo.permisos || []
      const fugas = []
      const rotas = []
      const contadas = []
      for (const [nombre, permisos, endpoint] of PANTALLAS) {
        const codigo = await get(tok, '/api' + endpoint)
        const debe = permisos.some((x) => mios.includes(x))
        if (debe) {
          // Tiene permiso: no puede ser 403, ni un 500, ni devolver HTML.
          if (codigo === 403 || codigo >= 500) rotas.push(`${nombre}=${codigo}`)
          contadas.push(nombre)
        } else if (codigo === 403) {
          contadas.push(nombre)
        } else {
          // NO tiene permiso y la API le ha dejado pasar. Esto es un agujero.
          fugas.push(`${nombre}(${codigo})`)
        }
      }
      chk(fugas.length === 0,
        `${r.name.padEnd(18)} ${String(mios.length).padStart(3)} permisos · `
        + `${contadas.length} pantallas · ${fugas.length} fugas`
        + (fugas.length ? ' → ' + fugas.slice(0, 4).join(' ') : '')
        + (rotas.length ? ' · ROTO: ' + rotas.slice(0, 3).join(' ') : ''))
      informe.push(`${r.name}: ${mios.length} permisos, fugas=${fugas.join('|') || 'ninguna'}, rotas=${rotas.join('|') || 'ninguna'}`)
      await borrarUsuario(adminTok, usuario)
    }

    // ── Un 403 de verdad, no uno de pantalla ─────────────────────────────
    console.log('\n  SIN PERMISO, NI POR URL DIRECTA')
    await borrarUsuario(adminTok, 'acceso' + SUFIJO)
    const alta2 = await post(adminTok, '/api/users', {
      username: 'acceso' + SUFIJO, password: 'demo1234', fullName: 'Prueba Acceso', roles: ['COMMERCIAL'],
    })
    if (alta2.s >= 300) {
      chk(false, 'no se pudo crear el usuario de prueba: ' + JSON.stringify(alta2.j).slice(0, 80))
    } else {
      await p.setCacheEnabled(false)
      await p.goto(B + '/', { waitUntil: 'networkidle2', timeout: 45000 })
      // `ACCESO` vive en Node. Dentro de `p.evaluate` el código corre en el
      // NAVEGADOR, donde esa variable no existe: hay que pasarla como
      // argumento, y por eso este login se quedaba sin hacer.
      await p.evaluate(async (usuario) => {
        const r = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: usuario, password: 'demo1234' }),
        })
        const j = await r.json()
        window.__login = r.status
        if (j.refresh) localStorage.setItem('cs2.refresh', j.refresh)
      }, ACCESO)
      // Si el login del navegador sale con 429, lo que se mide después no es la
      // aplicación: es el límite de intentos. Sin esto, el arnés concluía que al
      // comercial no le dejaba entrar, cuando lo que no le dejaba entrar era
      // haber gastado la cuota probando.
      const codeLogin = await p.evaluate(() => window.__login)
      if (codeLogin === 429) {
        console.log('\n  EL LOGIN DEL NAVEGADOR SALIÓ CON 429: el límite de intentos está gastado.')
        console.log('  La parte de permisos por API ya está hecha; la de pantalla necesita esperar.')
        process.exitCode = 1
        return
      }
      await p.reload({ waitUntil: 'networkidle2', timeout: 30000 })
      // Antes de medir, comprobar que la aplicación está ABIERTA. Sin esta
      // espera, el hash se ponía sobre la pantalla de acceso y lo que se
      // midió fue un `#vista` vacío: «pantalla en blanco» que no lo era, era el
      // arnés mirando demasiado pronto.
      const abierta = await p.waitForFunction(
        () => { const a = document.getElementById('app'); return a && !a.classList.contains('oculto') },
        { timeout: 20000 },
      ).then(() => true).catch(() => false)
      if (!abierta) {
        const d = await p.evaluate(() => JSON.stringify({
          appOculto: document.getElementById('app').classList.contains('oculto'),
          refresh: (localStorage.getItem('cs2.refresh') || 'NINGUNO').slice(0, 12),
          cuerpo: (document.body.innerText || '').trim().slice(0, 90),
        }))
        console.log('    · estado: ' + d)
      }
      chk(abierta, 'el usuario sin permiso sí entra en la aplicación (lo que se le niega es la pantalla)')
      await new Promise((s) => setTimeout(s, 800))
      await p.evaluate(() => { window.location.hash = '#/usuarios' })
      await new Promise((s) => setTimeout(s, 2200))
      const visto = await p.evaluate(() => {
        const t = ((document.getElementById('vista') || {}).innerText || '').trim()
        return {
          texto: t.slice(0, 140),
          dicePermiso: /permiso|403|no autorizado|restringido/i.test(t),
          fuga: /hash|contrase|password|administrador/i.test(t),
        }
      })
      chk(visto.dicePermiso,
        'un comercial escribiendo #/usuarios a mano ve un aviso de permiso: '
        + JSON.stringify(visto.texto.slice(0, 56)))
      chk(!visto.fuga, 'y no se le enseña nada de la lista de usuarios')
      await p.screenshot({ path: SALIDA + '403-usuarios.png' }).catch(() => {})
      await borrarUsuario(adminTok, 'acceso' + SUFIJO)
    }

    writeFileSync(SALIDA + 'permisos.txt', informe.join('\n'))
    console.log('')
    if (fallos.length) {
      console.log('  ' + fallos.length + ' FALLO(S):')
      for (const f of fallos) console.log('    · ' + f)
      process.exitCode = 1
    } else console.log('  Todo correcto.')
  } finally {
    await nav.close()
  }
}
main()
