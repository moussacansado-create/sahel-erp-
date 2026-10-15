/**
 * Armazón de la aplicación: menú, rutas y ciclo de vida.
 *
 * El menú se construye con los permisos que devuelve /auth/me. Eso es una
 * AYUDA, no una garantía: el backend vuelve a comprobar cada permiso. Si alguien
 * fuerza un enlace a mano, receives un 403 —que la página muestra— en vez de un
 * acceso.
 */

// Se levanta ANTES de nada, en la primera línea del cuerpo del módulo.
//
// El cuerpo de un módulo se ejecuta DESPUÉS de que todos sus `import` se han
// resuelto. Si a `entradas.js` —o a cualquier otro— le pasa algo, nada de lo
// que hay aquí abajo llega a ejecutarse. Poner la bandera en la primera línea
// es la única forma de distinguir «no se ha podido descargar» de «se ha
// descargado y ha fallado al ejecutar».
window.__sahelArranque = window.__sahelArranque || { appArranco: false, fallos: [] }
window.__sahelArranque.appArranco = true

import { $, el, aviso } from './ui.js'
import * as A from './api.js'
import { conectarSiHaceFalta, desconectar as cortarSincronizacion } from './sincronizacion.js'
import { paginaPanel } from './paginas/panel.js'
import { paginaCatalogo } from './paginas/catalogo.js'
import { paginaEntradas } from './paginas/entradas.js'
import { paginaConfig } from './paginas/config.js'
import { paginaStock } from './paginas/stock.js'
import { paginaPedidos } from './paginas/pedidos.js'
import { paginaAlbaranes } from './paginas/albaranes.js'
import { paginaCompras, paginaProveedores } from './paginas/compras.js'
import { paginaReparto } from './paginas/reparto.js'
import { paginaCaja } from './paginas/caja.js'
import { paginaComerciales } from './paginas/comerciales.js'
import { paginaClientes } from './paginas/clientes.js'
import { paginaMovimientos } from './paginas/movimientos.js'
import { paginaUsuarios } from './paginas/usuarios.js'
import { paginaPermisos } from './paginas/permisos.js'
import { paginaLotes } from './paginas/lotes.js'
import { paginaRecetas } from './paginas/recetas.js'
import { paginaProduccion } from './paginas/produccion.js'

const RUTAS = [
  // ── CONFIGURACIÓN ─────────────────────────────────────────────────────────
  //
  // Va al FINAL de la lista de rutas a propósito: el menú lateral se pinta en
  // ese orden, y la configuración es lo último que se abre, no lo primero que
  // se ve al entrar. Con `settings:view` no aparece para nadie más.
  { ruta: 'configuracion', titulo: 'Configuración', grupo: 'Sistema', permiso: ['settings', 'view'],
    render: paginaConfig },

  { ruta: 'panel', titulo: 'Panel', grupo: 'General', permiso: ['dashboard', 'view'],
    render: paginaPanel, numero: 'inventario' },

  { ruta: 'materias-primas', titulo: 'Materias primas', grupo: 'Catálogo', permiso: ['raw_materials', 'view'],
    render: (c) => paginaCatalogo(c, 'RAW_MATERIAL', 'Materias primas') },
  { ruta: 'envases', titulo: 'Envases', grupo: 'Catálogo', permiso: ['packaging', 'view'],
    render: (c) => paginaCatalogo(c, 'PACKAGING', 'Envases') },
  { ruta: 'productos', titulo: 'Productos', grupo: 'Catálogo', permiso: ['products', 'view'],
    render: (c) => paginaCatalogo(c, 'FINISHED_GOOD', 'Productos terminados') },

  { ruta: 'lotes', titulo: 'Lotes', grupo: 'Almacén', permiso: ['lots', 'view'], render: paginaLotes },
  { ruta: 'entradas', titulo: 'Entradas de mercancía', grupo: 'Almacén', permiso: ['inventory', 'create'],
    render: paginaEntradas },
  { ruta: 'stock', titulo: 'Stock', grupo: 'Almacén', permiso: ['inventory', 'view'],
    render: paginaStock, numero: 'stock' },
  { ruta: 'movimientos', titulo: 'Movimientos', grupo: 'Almacén', permiso: ['inventory', 'view'],
    render: paginaMovimientos },
  { ruta: 'clientes', titulo: 'Clientes', grupo: 'Ventas', permiso: ['customers', 'view'],
    render: paginaClientes },
  { ruta: 'pedidos', titulo: 'Pedidos', grupo: 'Ventas', permiso: ['sales', 'view'], render: paginaPedidos },
  { ruta: 'albaranes', titulo: 'Albaranes', grupo: 'Ventas', permiso: ['sales', 'view'],
    render: paginaAlbaranes },
  { ruta: 'reparto', titulo: 'Reparto', grupo: 'Ventas', permiso: ['deliveries', 'view'],
    render: paginaReparto },

    // Caja va en su PROPIO grupo y con SU permiso, no el de reparto.
    //
    // Con `deliveries:view` el repartidor habría visto la pantalla de caja —
    //quién lleva qué y cuánto—, que no es asunto suyo. Y con `deliveries`
    // en vez de `cash` habría podido ABRIR traspasos, o sea declararse
    // entregado su propio dinero.
    //
    // Ver el reparto y entregarlo a uno mismo son dos cosas distintas, y por
    // eso son dos permisos distintos.
    { ruta: 'caja', titulo: 'Caja', grupo: 'Caja', permiso: ['cash', 'view'],
      render: paginaCaja },

    // Comerciales va en su propio grupo y con SU permiso. Meterlo en Ventas
    // haría que quien puede ver un pedido también entrara al ranking, y son
    // cosas distintas: una es la operación de una venta, la otra es el
    // seguimiento de una persona.
    { ruta: 'comerciales', titulo: 'Comerciales', grupo: 'Comerciales',
      permiso: ['commercial', 'view'], render: paginaComerciales },

  // Compras va en su propio grupo porque no es almacén: PEDIR no es tener, y
  // meterlo con las entradas de mercancía acabaría mezclando dos cosas que se
  // parecen y no son lo mismo.
  { ruta: 'compras', titulo: 'Compras', grupo: 'Compras', permiso: ['purchases', 'view'],
    render: paginaCompras },
  // Proveedores van en su propia entrada y no como una más de Compras: el
  // maestro del proveedor es dato de catálogo, y su historial es dato de
  // compras. En una sola pantalla se mezclan las dos cosas.
  { ruta: 'proveedores', titulo: 'Proveedores', grupo: 'Compras', permiso: ['purchases', 'view'],
    render: paginaProveedores },
  { ruta: 'recetas', titulo: 'Recetas', grupo: 'Producción', permiso: ['recipes', 'view'],
    render: paginaRecetas },
  { ruta: 'produccion', titulo: 'Producción', grupo: 'Producción', permiso: ['production', 'view'],
    render: paginaProduccion },

  { ruta: 'usuarios', titulo: 'Usuarios', grupo: 'Administración', permiso: ['users', 'view'],
    render: paginaUsuarios },
  { ruta: 'permisos', titulo: 'Roles y permisos', grupo: 'Administración', permiso: ['permissions', 'view'],
    render: paginaPermisos },
]

// ── Navegación ──────────────────────────────────────────────────────────────

/**
 * ¿POR QUÉ PANTALLA EMPIEZA CADA ROL?
 *
 * La caja no empieza por el Panel porque `panel` ES un panel de inventario: no
 * tiene otro contenido. Así que abría su pantalla de inicio y se encontraba
 * con «No tienes permiso para ver en inventario». Un 403 educado, y una
 * primera impresión de no poder hacer nada.
 *
 * NO se le da inventario a la caja para que el panel funcione. Eso sería abrir
 * una puerta de verdad por un problema de forma: la caja no necesita ver el
 * stock, y enseñárselo es enseñarle cosas que no puede ni cambiar.
 *
 * Se decide DÓNDE se empieza, no QUÉ se puede ver. Y si alguien escribe a mano
 * `#/panel`, se le lleva igualmente y se le avisa: no se esconde nada.
 */
function pantallaDeInicio() {
  if ((A.sesion.roles || []).includes('CAJAJERO')) return 'caja'
  return 'panel'
}

function rutasVisibles() {
  return RUTAS.filter((r) => A.puede(...r.permiso))
}

function pintarMenu() {
  const menu = $('#menu')
  menu.replaceChildren()
  const rutas = rutasVisibles()
  if (!rutas.length) {
    menu.append(el('p', { class: 'pista', text: 'Tu usuario no tiene ningún permiso asignado. Habla con un administrador.' }))
    return
  }
  let grupo = null
  for (const r of rutas) {
    if (r.grupo !== grupo) {
      grupo = r.grupo
      menu.append(el('div', { class: 'lateral__grupo', text: grupo }))
    }
    menu.append(el('a', {
      class: 'lateral__enlace',
      href: `#/${r.ruta}`,
      'data-ruta': r.ruta,
    }, [el('span', { text: r.titulo }), r.numero ? el('span', { class: 'lateral__pastilla', 'data-numero': r.numero }) : null]))
  }
}

/** Rellena los contadores del menú con datos REALES de la API. */
async function pintarContadores() {
  if (!A.puede('inventory', 'view')) return
  try {
    const stock = await A.api('/inventory/resumen')
    const total = (stock.porTipo || []).reduce((t, f) => t + Number(f.items || 0), 0)
    for (const [clave, valor] of [['stock', total]]) {
      const n = $(`[data-numero="${clave}"]`)
      if (n && valor) n.textContent = entero(valor)
    }
  } catch { /* los contadores son un extra: si fallan, no molestan */ }
}
function entero(v) { return Number(v).toLocaleString('es-ES') }

function marcarActiva(ruta) {
  for (const a of document.querySelectorAll('.lateral__enlace')) {
    a.classList.toggle('activo', a.dataset.ruta === ruta)
  }
}

// ── Menú lateral en móvil ───────────────────────────────────────────────────
//
// La barra lateral se esconde por debajo de 800 px, así que sin esto la
// aplicación se quedaba encerrada en la página del panel. Ahora entra deslizando
// desde la izquierda, con un velo detrás, y se cierra al elegir sección, al
// tocar fuera o con la tecla Escape.

const MOVIL = window.matchMedia('(max-width: 800px)')

function menuAbierto() {
  return $('#app').classList.contains('menu-abierto')
}

function abrirMenu() {
  $('#app').classList.add('menu-abierto')
  $('#velo').hidden = false
  $('#abrir-menu').setAttribute('aria-expanded', 'true')
  document.body.style.overflow = 'hidden'
}

function cerrarMenu() {
  $('#app').classList.remove('menu-abierto')
  $('#velo').hidden = true
  $('#abrir-menu').setAttribute('aria-expanded', 'false')
  document.body.style.overflow = ''
}

$('#abrir-menu').addEventListener('click', () => (menuAbierto() ? cerrarMenu() : abrirMenu()))
$('#cerrar-menu').addEventListener('click', cerrarMenu)
$('#velo').addEventListener('click', cerrarMenu)
// Elegir una sección cierra el menú: si no, el nuevo contenido queda debajo de
// una lista de secciones que tapa justo lo que se ha ido a ver.
$('#menu').addEventListener('click', (ev) => {
  if (ev.target.closest('.lateral__enlace') && MOVIL.matches) cerrarMenu()
})
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && menuAbierto()) cerrarMenu()
})
// Al pasar a escritorio el menú se queda en su sitio fijo, sin velo.
MOVIL.addEventListener('change', () => { if (!MOVIL.matches) cerrarMenu() })

// ── Rutas ───────────────────────────────────────────────────────────────────

let tokenNavegacion = 0

async function navegar() {
  //
  // ¿POR DÓNDE EMPIEZA CADA UNO?
  //
  // Antes, todo el que entraba caía en `panel`. Y `panel` es, literalmente, un
  // panel de INVENTARIO: no tiene otro contenido. Así que la caja —que
  // arregla el dinero, no el almacén— abría su pantalla de inicio y se
  // encontraba con un «No tienes permiso para ver en inventario». Un 403
  // educado, y una primera impresión de no poder hacer nada.
  //
  // No se le da inventario a la caja para que el panel funcione. Eso sería
  // abrir una puerta de verdad por un problema de forma: la caja no necesita
  // ver el stock, y enseñárselo es enseñarle cosas que no puede cambiar.
  //
  // La caja empieza en CAJA, que es donde tiene algo que hacer. Y si alguien
  // escribe a mano `#/panel`, sigue llevándole allí: se le avisa, no se le
  // esconde. Lo que se decide es dónde se empieza, no qué se puede ver.
  //
  const porDefecto = pantallaDeInicio()
  const pedazo = window.location.hash.replace(/^#\/?/, '') || porDefecto
  const [ruta, ...resto] = pedazo.split('/')
  const definicion = RUTAS.find((r) => r.ruta === ruta) || RUTAS.find((r) => r.ruta === 'panel')

  if (!A.puede(...definicion.permiso)) {
    mostrar403(definicion)
    return
  }

  marcarActiva(definicion.ruta)
  $('#titulo').textContent = definicion.titulo
  const vista = $('#vista')
  vista.replaceChildren(el('div', { class: 'cargando', text: 'Cargando…' }))

  // Si el usuario navega muy rápido, la respuesta de la página anterior puede
  // llegar tarde y pisar la nueva. Este testigo descarta las viejas.
  const mio = ++tokenNavegacion

  try {
    const contenido = await definicion.render({ params: resto })
    if (mio !== tokenNavegacion) return
    vista.replaceChildren(contenido)
    vista.scrollTop = 0
  } catch (e) {
    // Sin esto, una pantalla que falla al montarse se queda en blanco y no
    // deja ni una pista de por qué. Antes solo se veía el mensaje en la
    // pantalla, y si el fallo estaba en construir la vista —no al pintar— no
    // llegaba aTiempo de enseñarse. Con el stack en la consola, el fallo se
    // puede localizar sin tener que reproducirlo a ojo.
    console.error(`[montaje] ${definicion.ruta}: ${e && e.message}`, e && e.stack)
    if (mio !== tokenNavegacion) return
    vista.replaceChildren(el('div', { class: 'panel' }, [el('div', { class: 'panel__cuerpo' }, [
      el('div', { class: 'alerta alerta--error', text: e.message }),
      el('p', { class: 'pista', text: 'Si es un 403, tu usuario no tiene permiso para esta pantalla.' }),
      el('p', { class: 'pista', text: 'El detalle está en la consola del navegador.' }),
    ])]))
  }
}

function mostrar403(definicion) {
  $('#titulo').textContent = definicion.titulo
  $('#vista').replaceChildren(el('div', { class: 'panel' }, [el('div', { class: 'panel__cuerpo' }, [
    el('div', { class: 'alerta alerta--error', text: 'No tienes permiso para ver esta pantalla.' }),
    el('p', { class: 'pista', text: `Hace falta el permiso ${definicion.permiso.join(':')}.` }),
    el('p', { class: 'pista', text: 'Ocultar el enlace no es la protección: el backend lo comprueba igual.' }),
  ])]))
}

// ── Arranque ────────────────────────────────────────────────────────────────

function pintarQuienSoy() {
  const u = A.sesion.usuario
  $('#quien-soy').replaceChildren(
    el('b', { text: u.fullName || u.username }),
    el('span', { text: A.sesion.roles.join(' · ') || 'sin roles' }),
  )
  $('#btn-salir').classList.remove('oculto')
}

function mostrarApp() {
  $('#acceso').classList.add('oculto')
  $('#app').classList.remove('oculto')
  pintarMenu()
  pintarQuienSoy()
  pintarContadores()
}

function mostrarAcceso() {
  $('#app').classList.add('oculto')
  $('#acceso').classList.remove('oculto')
  $('#api-url').value = A.baseApi()
  $('#usuario').focus()
}

async function comprobarApi() {
  const estado = $('#api-estado')
  estado.textContent = 'Comprobando…'
  try {
    const r = await fetch(`${A.baseApi()}/api/auth/me`)
    const tipo = r.headers.get('content-type') || ''
    if (!tipo.includes('application/json')) {
      estado.textContent = `✗ ${A.baseApi()} devuelve HTML, no JSON. No es la API.`
      estado.style.color = 'var(--peligro)'
      return false
    }
    estado.textContent = r.status === 401
      ? '✓ La API responde. Necesitas iniciar sesión (401 es lo correcto).'
      : `✓ La API responde (${r.status}).`
    estado.style.color = 'var(--bien)'
    return true
  } catch {
    estado.textContent = `✗ No hay respuesta en ${A.baseApi()}. Revisa que el backend esté encendido.`
    estado.style.color = 'var(--peligro)'
    return false
  }
}

function conectarAcceso() {
  $('#form-acceso').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const boton = ev.target.querySelector('button[type=submit]')
    const error = $('#acceso-error')
    boton.disabled = true
    boton.textContent = 'Entrando…'
    error.classList.add('oculto')
    try {
      await A.entrar($('#usuario').value.trim(), $('#clave').value)
      mostrarApp()
        if (!window.location.hash) window.location.hash = '#/' + pantallaDeInicio()
      else navegar()
    } catch (e) {
      error.textContent = e.message
      error.classList.remove('oculto')
    } finally {
      boton.disabled = false
      boton.textContent = 'Entrar'
    }
  })

  $('#btn-salir').addEventListener('click', async () => {
    await A.salir()
    window.location.hash = ''
    mostrarAcceso()
    aviso('Sesión cerrada', 'bien')
  })

  $('#btn-probar-api').addEventListener('click', async () => {
    A.fijarBaseApi($('#api-url').value)
    $('#api-url').value = A.baseApi()
    await comprobarApi()
  })
  $('#btn-usar-mismo-origen').addEventListener('click', () => {
    A.fijarBaseApi('')
    $('#api-url').value = A.baseApi()
    comprobarApi()
  })
  $('#api-url').addEventListener('change', (ev) => {
    A.fijarBaseApi(ev.target.value)
    ev.target.value = A.baseApi()
  })
}

async function iniciar() {
  // Si llegamos aquí, el módulo ha cargado bien: el aviso puede desaparecer.
  document.getElementById('sin-js')?.classList.add('oculto')
  conectarAcceso()
  window.addEventListener('hashchange', () => { if (!$('#app').classList.contains('oculto')) navegar() })

  A.onRenovar(() => { mostrarAcceso(); aviso('Tu sesión ha caducado. Vuelve a entrar.', 'aviso') })

  // Si hay una sesión guardada, se intenta recuperar ANTES de pedir la
  // contraseña, y con reintentos.
  //
  // El motivo: `recuperar()` devuelve false tanto si no hay sesión como si la
  // renovación falló por un motivo pasajero —el servidor reiniciándose, un
  // corte de red, un 429—. Sin reintento, ese segundo caso terminaba en la
  // pantalla de acceso con la impresión de que se había perdido la sesión, y
  // el trabajador tenía que volver a escribir su contraseña por un reinicio del
  // servidor. Tres intentos con medio segundo entre ellos cubren de sobra un
  // reinicio, y no se Tardan cuando no hay nada que recuperar.
  for (let intento = 1; intento <= 3; intento++) {
    if (!A.haySesionGuardada()) break
    try {
      if (await A.recuperar()) {
        mostrarApp()
        await navegar()
        return
      }
    } catch { /* se reintenta */ }
    if (intento < 3) await new Promise((r) => setTimeout(r, 500))
  }

  mostrarAcceso()
  comprobarApi()
}

// ── Sincronización entre dispositivos ────────────────────────────────────────
// El canal se abre una vez que hay sesión y se cierra al salir. Si no, el móvil
// se queda reconectando en segundo plano con un token que ya no vale.
function manageSincronizacion(conectado) {
  if (conectado) conectarSiHaceFalta()
  else cortarSincronizacion()
}
window.addEventListener('hashchange', () => conectarSiHaceFalta())
// Cuando el servidor avisa de que algo cambió, se repinta la pantalla actual.
// Un formulario a medio rellenar NO se toca: solo se repinta si no hay nada
// escrito, y si lo hay se avisa en vez de perder el trabajo.
let hayFormularioAbierto = false
window.addEventListener('focusin', (ev) => {
  if (ev.target && ev.target.closest && ev.target.closest('form')) hayFormularioAbierto = true
})
window.addEventListener('submit', () => { hayFormularioAbierto = false })
window.addEventListener('sahel:datos-cambiados', async () => {
  if (hayFormularioAbierto) {
    aviso('Alguien ha guardado algo. Vuelve a abrir la lista para verlo.', 'aviso')
    return
  }
  await navegar()
})
document.addEventListener('DOMContentLoaded', () => conectarSiHaceFalta())

iniciar()
