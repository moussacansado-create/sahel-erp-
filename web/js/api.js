/**
 * Cliente de la API de CleanSahel.
 *
 * Tres reglas que no se rompen aquí:
 *
 *  1. El access token vive SOLO en memoria. Si alguien lo lee desde la
 *     consola, al recargar desaparece: es de corta duración por diseño.
 *  2. El refresh token se persiste, porque hay que sobrevivir a un F5. Va en
 *     localStorage, no en una cookie httpOnly: es la única opción cuando la
 *     página se sirve desde un host estático distinto al de la API. Es una
 *     dejación conocida y anotada, no un descuido.
 *  3. Nunca se inventa una respuesta. Si la API no está o falla, el error sube
 *     tal cual hasta la pantalla. No hay datos de ejemplo ni modo offline que
 *     puedan confundirse con los de verdad.
 */

const CLAVE_REFRESH = 'cs2.refresh'
const CLAVE_API = 'cs2.api'

let accessToken = null
let renovando = null          // una sola renovación a la vez, aunque lleguen 10
let alRenovar = null          // quién_AVISO avisar si la sesión muere de verdad

export const sesion = { usuario: null, roles: [], permisos: [] }

/**
 * El token de acceso, para las pocas cosas que hay que hacer FUERA de `api()`.
 *
 * Hoy solo la etiqueta: hay que traerla con la cabecera a mano porque se abre
 * en otra pestaña, y una pestaña no hereda la cabecera de quien la abre. Antes
 * se leía `localStorage` a mano desde la pantalla, y eso ata la pantalla a la
 * clave con la que `api.js` guarda el token: si un día esa clave cambia, la
 * etiqueta deja de abrirse y nadie sabe por qué.
 */
export function tokenActual() {
  return accessToken
}

export function puede(modulo, accion) {
  return sesion.permisos.includes(`${modulo}:${accion}`)
}

// ── Dirección de la API ────────────────────────────────────────────────────

export function baseApi() {
  // Un ?api=... en la URL gana a todo y se memoriza: así se puede mandar un
  // enlace ya apuntando al backend sin que nadie tenga que configurarlo a mano.
  const deUrl = new URLSearchParams(window.location.search).get('api')
  if (deUrl) {
    fijarBaseApi(deUrl)
    return deUrl.replace(/\/+$/, '')
  }
  const guardada = localStorage.getItem(CLAVE_API)
  if (guardada) return guardada.replace(/\/+$/, '')
  // Sin configurar: el mismo origen. Funciona cuando Express sirve la interfaz.
  return window.location.origin
}

export function fijarBaseApi(url) {
  const limpio = String(url || '').trim().replace(/\/+$/, '')
  if (limpio) localStorage.setItem(CLAVE_API, limpio)
  else localStorage.removeItem(CLAVE_API)
}

export function onRenovar(fn) { alRenovar = fn }

// ── Petición ────────────────────────────────────────────────────────────────

class ErrorApi extends Error {
  constructor(estado, mensaje, codigo) {
    super(mensaje)
    this.estado = estado
    this.codigo = codigo
  }
}

// ── Clave de idempotencia ───────────────────────────────────────────────────
//
// La clave se genera AQUÍ, en el móvil, ANTES de enviar, y se reutiliza si la
// misma operación se intenta otra vez. Es lo que evita que un cobro se cobre
// dos veces porque el túnel se comió la respuesta.
//
// Reutilizarla tiene una consecuencia que conviene entender: si el usuario
// pulsa dos veces «guardar» con datos DISTINTOS dentro de la misma ventana, la
// segunda pulsación se ignorará y verá el resultado de la primera. Por eso la
// ventana es de un minuto, no de una hora: dentro de un minuto ya no es «el
// mismo clic», es «otra cosa que quiere hacer», y entonces la clave cambia y
// se guarda como una operación nueva.
//
// Solo se aplica a escrituras. Un GET repetido no duplica nada, y mandar clave
// en un GET solo basura inútil.
const CLAVE_POR = new Map()   // ruta+huella -> { clave, cuando }
function claveDe(ruta, metodo, cuerpo) {
  if (metodo === 'GET' || metodo === 'HEAD') return null
  const huella = `${metodo} ${ruta} ${cuerpo === undefined ? '' : JSON.stringify(cuerpo)}`
  const ahora = Date.now()
  const previo = CLAVE_POR.get(huella)
  if (previo && ahora - previo.cuando < 60000) return previo.clave
  const clave = `${ruta.replace(/[^a-z0-9]/gi, '').slice(0, 20)}-${
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`
  CLAVE_POR.set(huella, { clave, cuando: ahora })
  // Solo se guardan las últimas, por si acaso: esto es una memoria de trabajo,
  // no un archivo. Y al limpiar, se olvida la clave, que es justo lo que
  // quiere quien guarda OTRA cosa con los mismos datos.
  if (CLAVE_POR.size > 100) {
    for (const [k, v] of CLAVE_POR) if (ahora - v.cuando >= 60000) CLAVE_POR.delete(k)
  }
  return clave
}

async function pedir(ruta, { metodo = 'GET', cuerpo, reintentar = true } = {}) {
  const cabeceras = { Accept: 'application/json' }
  if (cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json'
  if (accessToken) cabeceras.Authorization = `Bearer ${accessToken}`
  const clave = claveDe(ruta, metodo, cuerpo)
  if (clave) cabeceras['X-Idempotency-Key'] = clave

  let res
  try {
    res = await fetch(`${baseApi()}/api${ruta}`, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    })
  } catch (e) {
    throw new ErrorApi(0, `No se pudo contactar con la API en ${baseApi()}. ¿Está encendida?`, 'SIN_CONEXION')
  }

  if (res.status === 204) return null

  const texto = await res.text()
  const tipo = res.headers.get('content-type') || ''

  // Un host estático con fallback a index.html devuelve HTML con estado 200 en
  // CUALQUIER ruta, incluidas las de la API. Sin esto, el login «funcionaría» y
  // la pantalla se quedaría en blanco sin decir por qué. Aquí se distingue.
  if (!tipo.includes('application/json')) {
    throw new ErrorApi(0,
      `${baseApi()} no es la API: respondió ${tipo || 'sin tipo'} en vez de JSON. ` +
      'Un host estático devuelve la página HTML en todas las rutas. ' +
      'Apunta la base de la API al backend (por ejemplo http://localhost:10000).',
      'NO_ES_LA_API')
  }

  let datos = null
  if (texto) { try { datos = JSON.parse(texto) } catch { datos = texto } }

  if (!res.ok) {
    const codigo = datos?.codigo
    // El token caducó o la sesión se cerró: se renueva una vez y se repite.
    if (reintentar && res.status === 401 && accessToken) {
      const renovado = await renovar()
      if (renovado) return pedir(ruta, { metodo, cuerpo, reintentar: false })
    }
    throw new ErrorApi(res.status, datos?.error || `Error ${res.status}`, codigo)
  }
  return datos
}

async function renovar() {
  const guardado = localStorage.getItem(CLAVE_REFRESH)
  if (!guardado) return false
  // Si ya hay una renovación en curso, se espera a esa y no se lanza otra.
  if (renovando) return renovando
  renovando = (async () => {
    try {
      const r = await pedir('/auth/refresh', { metodo: 'POST', cuerpo: { refreshToken: guardado } })
      accessToken = r.access
      localStorage.setItem(CLAVE_REFRESH, r.refresh)
      return true
    } catch (e) {
      // Solo se borra la sesión si el token es de verdad inválido.
      //
      // Antes cualquier fallo —un 429, un corte de red, el servidor
      // reiniciándose— borraba el token de refresco. Con eso, un fallo pasajero
      // se convertía en perder la sesión y tener que escribir la contraseña otra
      // vez: el fallo de red se alargaba en vez de pasar. Ahora el token se
      // guarda y se reintenta al siguiente arranque, que es lo que corresponde
      // a algo que quizá no estaba disponible.
      const invalido = e instanceof ErrorApi
        && (e.estado === 400 || e.estado === 401 || e.codigo === 'REFRESH_INVALIDO')
      if (invalido) {
        localStorage.removeItem(CLAVE_REFRESH)
        accessToken = null
        if (alRenovar) alRenovar()
        return false
      }
      // Fallo temporal: se conserva la sesión y se dice que no se pudo renovar
      // AHORA. La próxima carga lo intentará otra vez, sin que nadie tenga que
      // hacer nada.
      console.warn('[api] no se pudo renovar la sesión ahora mismo; se conserva', e?.message || e)
      return false
    } finally {
      renovando = null
    }
  })()
  return renovando
}

// ── Sesión ──────────────────────────────────────────────────────────────────

export async function entrar(username, password) {
  const r = await pedir('/auth/login', { metodo: 'POST', cuerpo: { username, password } })
  accessToken = r.access
  localStorage.setItem(CLAVE_REFRESH, r.refresh)
  await cargarYo()
  return sesion
}

export async function cargarYo() {
  const r = await pedir('/auth/me')
  sesion.usuario = r.usuario
  sesion.roles = r.roles
  sesion.permisos = r.permisos
  return sesion
}

export async function salir() {
  try { await pedir('/auth/logout', { metodo: 'POST' }) } catch { /* se limpia igual */ }
  localStorage.removeItem(CLAVE_REFRESH)
  accessToken = null
  sesion.usuario = null
  sesion.roles = []
  sesion.permisos = []
}

/** Al abrir la página: si hay refresh token, se recupera la sesión. */
/**
 * ¿Hay una sesión guardada en este navegador?
 *
 * Lo consulta el arranque para no perder tiempo reintentando cuando no hay
 * nada que recuperar: sin sesión, un reintento solo retrasa la pantalla de
 * acceso.
 */
export function haySesionGuardada() {
  try { return !!localStorage.getItem(CLAVE_REFRESH) } catch { return false }
}

export async function recuperar() {
  if (!localStorage.getItem(CLAVE_REFRESH)) return false
  if (!(await renovar())) return false
  await cargarYo()
  return true
}

/**
 * Una imagen de la API, lista para poner en un `<img>`.
 *
 * ESTE PROBLEMA SALIÓ CON EL QR DE LA TARJETA, PERO LE PASABA YA A LA FIRMA
 * DEL ALBARÁN.
 *
 * Un `<img src="/api/…">` no lleva cabeceras. La API pide la sesión con
 * `Authorization: Bearer …`, así que la imagen salía con un 401 y en pantalla
 * no se veía nada: ni la firma del cliente ni el QR de la tarjeta. Dos
 * documentos oficiales en blanco, y sin ningún error visible.
 *
 * Aquí se pide con la cabecera correcta y se devuelve una dirección `blob:`.
 *
 *   `blob:` y NO el token en la URL. Poner el token en la dirección lo
 *   escribiría en el historial del navegador, en los registros del servidor y
 *   en cualquier copia de la barra de direcciones. Con `blob:` la dirección
 *   solo vale en esta pestaña.
 *
 * @param {string} ruta   sin el prefijo `/api`, como el resto del módulo
 * @returns {Promise<string>} una URL `blob:` lista para un `src`
 */
async function imagen(ruta) {
  const cabeceras = { Accept: 'image/*' }
  if (accessToken) cabeceras.Authorization = `Bearer ${accessToken}`
  const res = await fetch(`${baseApi()}/api${ruta}`, { headers: cabeceras })
  if (!res.ok) {
    let detalle = ''
    try { detalle = (await res.json()).error || '' } catch { /* sin cuerpo */ }
    throw new Error(detalle || `No se pudo cargar la imagen (${res.status})`)
  }
  return URL.createObjectURL(await res.blob())
}

export { pedir as api, imagen, ErrorApi }
