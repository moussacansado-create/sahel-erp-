import { el, panel, aviso, protegido, cargando } from '../ui.js'
import * as A from '../api.js'

/**
 * Matriz de roles y permisos.
 *
 * Tabla de casillas. Lo que se ve aquí es EXACTAMENTE lo que consulta el backend
 * en cada petición, no una copia: si se desmarca una casilla, el permiso deja
 * de concederse en la siguiente petición, sin esperar a que caduque ningún
 * token. Y ADMIN no aparece: no se puede quitar, y así se indica.
 */
export async function paginaPermisos() {
  const caja = el('div')
  caja.append(cargando('Cargando la matriz…'))

  //
  // AQUÍ ESTABA EL «asignadas is not iterable».
  //
  // Esta pantalla se escribió contra un contrato que el backend ya no cumple:
  // esperaba que `/permissions` devolviera una lista plana de filas
  // `{rol, module, action}` —una por casilla— y hacía `for (const p of
  // asignadas)`. Pero `/permissions` devuelve un OBJETO:
  //
  //     { modulos: [...], acciones: [...], roles: [{code, name, permisos:{…}}] }
  //
  // Un objeto no se puede recorrer con `for…of`: de ahí el error, y de ahí que
  // la pantalla no llegara a pintar ni una casilla. El backend es el que está
  // bien —devuelve la matriz ya montada, que es más barata y más clara que
  // 150 filas planas—, así que se arregla la pantalla, no el contrato.
  //
  // Y no se hace un `|| []` como parche. `leerPermisos()` más abajo normaliza
  // las TRES formas que pueden llegar (objeto, lista plana, o nada) y deja
  // siempre la misma estructura. Un día el backend cambie, o devuelva un 403
  // con cuerpo vacío, esta pantalla sigue enseñando una matriz vacía CON MOTIVO
  // en vez de reventar con un TypeError.
  //
  // UNA sola llamada. `/permissions` ya trae los roles con sus permisos, así que
  // pedir además `/roles` era tirar una segunda petición para usar la mitad.
  const leido = leerPermisos(await A.api('/permissions').catch((e) => ({ __error: e.message })))

  // ADMIN no sale de la matriz editable: el backend se lo salta siempre, no es
  // una fila de la tabla sino una excepción. Se marca aparte para poder decirlo.
  const roles = leido.roles
    .map((r) => ({ ...r, code: r.code, name: r.name || r.code }))
  const inicial = new Map(roles.map((r) => [r.code, new Set(r.permisos || [])]))
  const acciones = leido.acciones.length ? leido.acciones : ACCIONES
  const modulos = leido.modulos.length ? leido.modulos : MODULOS
  const todos = modulos

  const cuerpo = el('div', { style: 'overflow-x:auto' })
  const pending = new Map()

  function pintar() {
    const tabla = el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { style: 'min-width:230px', text: 'Módulo' }),
        ...roles.map((r) => el('th', { class: 'centro', style: 'min-width:96px' },
          [el('div', { text: NOMBRE_ROL[r.code] || r.name || r.code }), el('div', { class: 'pequeno tenue', text: r.code })])),
      ])]),
      el('tbody', {}, modulos.map((m) => {
            if (!todos.includes(m)) return null
        return el('tr', {}, [
          el('td', {}, [el('div', { text: NOMBRE_MODULO[m] || m }), el('div', { class: 'pequeno mono tenue', text: m })]),
          ...roles.map((r) => {
            const bloqueado = r.code === 'ADMIN'
            const casillas = acciones.map((a) => {
              const marcado = inicial.get(r.code).has(`${m}:${a}`)
              return el('div', { style: 'padding:2px 0' }, [
                el('label', { class: 'pequeno', style: 'display:flex;gap:5px;align-items:center;cursor:' + (bloqueado ? 'not-allowed' : 'pointer') }, [
                  el('input', {
                    type: 'checkbox', checked: bloqueado || marcado, disabled: bloqueado,
                    onchange: (ev) => {
                      const c = ev.target.checked
                      if (c) inicial.get(r.code).add(`${m}:${a}`); else inicial.get(r.code).delete(`${m}:${a}`)
                      pending.set(r.code, [...inicial.get(r.code)])
                      pintarGuardar()
                    },
                  }),
                  el('span', { text: a }),
                ]),
              ])
            })
            return el('td', { class: 'centro', style: 'vertical-align:top' }, [
              el('div', { style: 'display:flex;flex-direction:column' }, casillas),
            ])
          }),
        ])
      }).filter(Boolean)),
    ])
    cuerpo.replaceChildren(tabla)
  }

  const barraGuardar = el('div', { class: 'pila pila--fin' })
  function pintarGuardar() {
    barraGuardar.replaceChildren(
      el('span', { class: 'pequeno tenue', text: `${pending.size} rol(es) sin guardar` }),
      boton('Descartar', () => { pending.clear(); pintar(); pintarGuardar() }),
      boton('Guardar cambios', protegido(async () => {
        for (const [rol, permisos] of pending) {
          // Como MAPA `{"modulo:accion": true}`, que es lo que documenta el
          // endpoint y lo que devuelve al releer. Se mandaba en lista y el
          // servidor lo rechazaba con un 400 al guardar.
          const cuerpo = Object.fromEntries([...permisos].sort().map((c) => [c, true]))
          await A.api(`/roles/${rol}/permisos`, { metodo: 'PUT', cuerpo: { permisos: cuerpo } })
        }
        aviso(`${pending.size} rol(es) actualizados.`)
        pending.clear()
        // Se vuelve a leer y se repinta desde la respuesta REAL del servidor,
        // no desde lo que creemos que hemos guardado. Si el backendchanged algo,
        // se ve. Y si la llamada falla, se conserva lo que había: mejor una
        // matriz que se quedó vieja que una pantalla en blanco.
        const releido = leerPermisos(await A.api('/permissions').catch((e) => ({ __error: e.message })))
        if (releido.aviso) {
          aviso(`Guardado, pero no se ha podido releer: ${releido.aviso}`, 'error')
        } else {
          for (const r of releido.roles) inicial.set(r.code, new Set(r.permisos || []))
          for (const codigo of inicial.keys()) if (!releido.roles.some((r) => r.code === codigo)) {
            inicial.set(codigo, new Set())
          }
        }
        pintar(); pintarGuardar()
      }), 'btn btn--principal'),
    )
  }
  pintarGuardar()

  // Si la API no ha podido leerse, se DICE. Una matriz vacía sin explicación
  // parece «no hay permisos», que es una conclusión falsa y tranquilizadora.
  if (leido.aviso) {
    caja.replaceChildren(panel('Matriz de permisos por rol', null, el('div', {
      class: 'alerta alerta--error',
    }, [
      el('div', { text: 'No se ha podido cargar la matriz de permisos.' }),
      el('p', { class: 'pista', text: leido.aviso }),
    ])))
    return caja
  }

  caja.replaceChildren(
    panel('Matriz de permisos por rol', null, [cuerpo], true),
    el('div', { class: 'pila pila--fin', style: 'margin-bottom:18px' }, [barraGuardar]),
    el('p', { class: 'pista' }, [
      'El rol ADMIN no aparece editable porque no se puede tocar: lo puede todo y el backend se salta la matriz para él. ',
      'Estos permisos son fail-closed: sin permiso, la API devuelve 403 aunque alguien construya la URL a mano.',
    ]),
  )
  pintar()
  return caja
}

/**
 * Normaliza lo que devuelva `/permissions` a UNA sola forma.
 *
 * Acepta, sin romperse con ninguna:
 *
 *   · el objeto actual  `{ modulos, acciones, roles:[{code, permisos:{}}] }`
 *   · la lista plana antigua `[{rol, module, action}, …]`
 *   · `null`, `undefined`, `[]`, `{}` o un cuerpo de error
 *
 * Y devuelve SIEMPRE `{ modulos, acciones, roles, aviso }`, con `roles` como
 * lista de `{ code, name, permisos: string[] }`. Quien pinte la matriz no tiene
 * que volver a preguntar por la forma, y un contrato que cambie mañana no
 * rompe esta pantalla: la mostrará vacía y lo dirá.
 *
 * Que el backend devuelva un 403 con cuerpo vacío, una lista donde se esperaba
 * un objeto, o un `null` porque se cayó una conexión, NO puede convertirse en
 * un `TypeError` en la cara del usuario. Eso no es robustez decorativa: es que
 * un fallo de red se lee como «no hay nada que ver» y no como «la aplicación
 * está rota».
 */
function leerPermisos(bruto) {
  const vacio = { modulos: [], acciones: [], roles: [], aviso: null }
  if (bruto == null) return { ...vacio, aviso: 'La API no ha devuelto nada.' }
  if (typeof bruto !== 'object') return { ...vacio, aviso: 'Formato inesperado.' }

  if (bruto.__error) return { ...vacio, aviso: bruto.__error }

  // ── Forma 1: la de ahora ──────────────────────────────────────────────
  if (!Array.isArray(bruto) && Array.isArray(bruto.roles)) {
    return {
      modulos: Array.isArray(bruto.modulos) ? bruto.modulos : [],
      acciones: Array.isArray(bruto.acciones) ? bruto.acciones : [],
      roles: bruto.roles
        .filter((r) => r && typeof r.code === 'string')
        .map((r) => ({
          code: r.code,
          name: r.name || r.code,
          // `permisos` llega como objeto {«módulo:acción»: true}; si algún día
          // llega como lista, también vale.
          permisos: Array.isArray(r.permisos)
            ? r.permisos.map(String)
            : Object.keys(r.permisos || {}),
        })),
      aviso: null,
    }
  }

  // ── Forma 2: la lista plana antigua ───────────────────────────────────
  if (Array.isArray(bruto)) {
    const porRol = new Map()
    for (const fila of bruto) {
      if (!fila || typeof fila.rol !== 'string') continue
      if (!porRol.has(fila.rol)) porRol.set(fila.rol, new Set())
      porRol.get(fila.rol).add(`${fila.module}:${fila.action}`)
    }
    return {
      modulos: [...new Set(bruto.map((f) => f && f.module).filter(Boolean))],
      acciones: [...new Set(bruto.map((f) => f && f.action).filter(Boolean))],
      roles: [...porRol].map(([code, set]) => ({ code, name: code, permisos: [...set] })),
      aviso: null,
    }
  }

  // ── Forma 3: algo raro pero no roto ───────────────────────────────────
  return { ...vacio, aviso: 'La API ha devuelto una estructura desconocida.' }
}

const ACCIONES = ['view', 'create', 'edit', 'delete', 'approve', 'export']
const MODULOS = [
  'dashboard', 'raw_materials', 'packaging', 'products', 'recipes', 'lots', 'production',
  'inventory', 'orders', 'customers', 'deliveries', 'commercial', 'sales', 'purchases',
  'suppliers', 'expenses', 'traceability', 'recalls', 'history', 'alerts',
  'users', 'permissions', 'reports', 'zones', 'settings',
]
const NOMBRE_MODULO = {
  dashboard: 'Panel', raw_materials: 'Materias primas', packaging: 'Envases', products: 'Productos',
  recipes: 'Recetas', lots: 'Lotes', production: 'Producción', inventory: 'Inventario',
  orders: 'Pedidos', customers: 'Clientes', deliveries: 'Entregas', commercial: 'Comercial',
  sales: 'Ventas', purchases: 'Compras', suppliers: 'Proveedores', expenses: 'Gastos',
  traceability: 'Trazabilidad', recalls: 'Retiradas', history: 'Historial', alerts: 'Avisos',
  users: 'Usuarios', permissions: 'Permisos', reports: 'Informes', zones: 'Zonas', settings: 'Configuración',
}
const NOMBRE_ROL = {
  ADMIN: 'Administrador', PRODUCTION: 'Producción', ACCOUNTING: 'Contabilidad',
  DELIVERY: 'Entregas', COMMERCIAL: 'Comercial',
}
function boton(t, onclick, clase = 'btn') { return el('button', { class: clase, text: t, onclick }) }
