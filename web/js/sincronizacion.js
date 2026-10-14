// ─────────────────────────────────────────────────────────────────────────────
//  SINCRONIZACIÓN · LADO DEL MÓVIL
// ─────────────────────────────────────────────────────────────────────────────
//
//  Escucha el canal y, cuando alguien escribe algo, vuelve a pintar la
//  pantalla actual. No trae los datos: solo avisa, y quien los pide es esta
//  misma pantalla, con la sesión de este mismo móvil. Por eso aquí no hay
//  ninguna ruta nueva por la quegamelo a alguien a ver.
//
//  Lo que se repinta es SOLO lo que el usuario está mirando. No se refresca
//  la aplicación entera: si un comercial tiene un formulario a medio rellenar y
//  otro guarda un cliente, no se le borra lo que está escribiendo. Perder el
//  trabajo a medio hacer porque otro ha guardado algo es peor que tener la
//  pantalla un segundo desfasada.

import { tokenActual, haySesionGuardada } from './api.js'

let fuente = null
let reintento = 0
let alCambio = null
const oyentes = new Set()

export function alCambiarAlgo(fn) {
  oyentes.add(fn)
  return () => oyentes.delete(fn)
}

// Qué tabla de la base le interesa a qué parte de la aplicación. Sin este
// mapa, guardar un cliente repintaría la pantalla de caja, y no tiene sentido.
const RELEVANTE = {
  customers: ['#/clientes', '#/pedidos', '#/'],
  sales_orders: ['#/pedidos', '#/reparto', '#/'],
  sales_order_lines: ['#/pedidos', '#/reparto', '#/'],
  items: ['#/catalogo', '#/materiales', '#/lotes', '#/produccion', '#/'],
  lots: ['#/lotes', '#/produccion', '#/catalogo', '#/'],
  stock_movements: ['#/lotes', '#/movimientos', '#/'],
  productions: ['#/produccion', '#/'],
  payments: ['#/caja', '#/cobros', '#/'],
  cash_movements: ['#/caja', '#/'],
  cash_sessions: ['#/caja', '#/'],
  deliveries: ['#/reparto', '#/'],
  albaranes: ['#/reparto', '#/'],
  users: ['#/usuarios', '#/'],
  app_config: ['#/configuracion', '#/'],
  com_visitas: ['#/comercial', '#/'],
  com_incidencias: ['#/comercial', '#/'],
}

function pantallaActual() {
  return (window.location.hash || '#/').split('?')[0]
}

function interesa(tablas) {
  const p = pantallaActual()
  return tablas.some((t) => (RELEVANTE[t] || []).some((r) => r === p))
}

function pintar() {
  const ruta = pantallaActual()
  // El hash no cambia si solo cambian los datos, así queASH no se dispara el
  // evento: hay que decirlo a mano.
  window.dispatchEvent(new CustomEvent('sahel:datos-cambiados', { detail: { ruta } }))
}

function conectar() {
  if (fuente) fuente.close()
  const t = tokenActual()
  if (!t) { desconectar(); return }

  // EventSource no admite cabeceras, y aquí hace falta Authorization.
  // Se abre un búfer con fetch y se leen las líneas a mano. Es lo mismo que
  // un EventSource, pero con la cabecera puesta.
  const ctrl = new AbortController()
  fuente = { close: () => ctrl.abort() }
  window.__sahelSync = true

  ;(async () => {
    while (!ctrl.signal.aborted) {
      try {
        const r = await fetch('/api/sync/stream', {
          headers: { Authorization: `Bearer ${tokenActual()}` },
          signal: ctrl.signal,
        })
        if (!r.ok || !r.body) throw new Error(String(r.status))
        reintento = 0
        const lector = r.body.getReader()
        const dec = new TextDecoder()
        let cola = ''
        for (;;) {
          const { done, value } = await lector.read()
          if (done) break
          cola += dec.decode(value, { stream: true })
          // Los eventos llegan separados por una línea en blanco.
          for (;;) {
            const corte = cola.indexOf('\n\n')
            if (corte === -1) break
            const trozo = cola.slice(0, corte)
            cola = cola.slice(corte + 2)
            const ev = /event: (\w+)/.exec(trozo)
            const da = /data: (.+)/.exec(trozo)
            if (ev && ev[1] === 'cambio' && da) {
              try {
                const { tablas } = JSON.parse(da[1])
                if (interesa(tablas)) pintar()
                for (const f of oyentes) f(tablas)
              } catch { /* un evento malformado no tumba la conexión */ }
            }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return
      }
      // Se cayó la red o el servidor. Se espera y se vuelve a entrar. El
      // tiempo sube con los intentos, para no martillear si el problema es
      // que no hay cobertura.
      const espera = Math.min(1000 * 2 ** reintento, 20000)
      reintento++
      await new Promise((r) => setTimeout(r, espera))
      if (ctrl.signal.aborted) return
    }
  })()
}

export function desconectar() {
  if (fuente) { fuente.close(); fuente = null }
  window.__sahelSync = false
}

export function conectarSiHaceFalta() {
  if (!haySesionGuardada()) { desconectar(); return }
  if (fuente) return
  conectar()
}
