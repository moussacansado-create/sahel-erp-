/**
 * Middlewares comunes.
 */

import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import config, { origenesPermitidos, esProduccion } from '../config/index.js'

/** Cabeceras de seguridad. Activas siempre, no solo en producción. */
export function cabeceras() {
  return helmet({
    // La CSP está activa también en desarrollo y en el entorno de pruebas.
    // Antes se desactivaba fuera de producción; con el backend expuesto por
    // túnel eso dejaba la puerta abierta a un XSS incrustado.
    // 'unsafe-inline' se permite SOLO para estilos, porque los formularios usan
    // atributos style=… para anchos de columna. Los scripts, en cambio, quedan
    // cerrados a 'self': nada de JS de terceros, nada de inyecciones.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...(process.env.CORS_ORIGINS ? [process.env.CORS_ORIGINS] : [])],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,   // los QR y las firmas necesitan cargar imágenes externas
  })
}

/**
 * CORS con lista blanca.
 *
 * Dos reglas, y la segunda es la que costó un disgusto:
 *
 *  1. Una petición SIN cabecera `Origin` no es de otro sitio. Pasa.
 *  2. Una petición CON `Origin` pero IGUAL al de esta misma servidor tampoco es
 *     de otro sitio. Pasa. Y tiene que pasar: los navegadores envían `Origin`
 *     en los scripts de tipo módulo aunque el fichero sea del mismo origen, así
 *     que rejectarlos rompe la propia aplicación con un 403 en el primer
 *     `<script type="module">` y la página se queda sin JavaScript.
 *
 * Para un origen de verdad ajeno, NO se devuelve 403: simplemente no se manda la
 * cabecera `Access-Control-Allow-Origin`, y es el navegador quien bloquea la
 * lectura. Un 403 sería castigar a un servidor legítimo por un problema de otro.
 */
export function cors() {
  const permitidos = new Set(origenesPermitidos())
  return (req, res, next) => {
    const origen = req.headers.origin
    if (!origen) return next()                     // curl, apps nativas, sin Origin

    // ¿Es este mismo servidor? Entonces no hay nada que autorizar.
    const propio = `${req.protocol}://${req.get('host')}`
    const esPropio = origen === propio
      || (req.get('x-forwarded-proto') && `${req.get('x-forwarded-proto')}://${req.get('host')}` === origen)

    if (!esPropio && permitidos.has(origen)) {
      res.setHeader('Access-Control-Allow-Origin', origen)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
    } else if (!esPropio) {
      // Origen ajeno no autorizado: se sigue atendiendo, pero SIN cabeceras
      // CORS. El navegador impedirá que el sitio atacante lea la respuesta.
      res.setHeader('Vary', 'Origin')
    }

    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }
}

/**
 * Límite de intentos de acceso.
 *
 * Va por IP y por usuario. El de la base es el que de verdad frena a alguien
 * probando contraseñas contra cuentas reales; el de la IP frena el ruido.
 */
export function limiteDeAcceso() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.NODE_ENV === 'test' ? 10000 : 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Se usa ipKeyGenerator porque en IPv6 una misma persona tiene un
    // prefijo /64 completo: sin normalizar, el límite se esquivaría cambiando
    // los últimos bits de la dirección.
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip)
      const usuario = String(req.body?.username || '').toLowerCase().slice(0, 60)
      return usuario ? `${ip}:${usuario}` : ip
    },
    message: { error: 'Demasiados intentos. Espera unos minutos.', codigo: 'DEMASIADOS_INTENTOS' },
  })
}

/**
 * Límite de la RENOVACIÓN de sesión.
 *
 * Va aparte del de acceso, y bastante más alto, porque la renovación no es un
 * intento de autenticación: la hace el navegador solo en cada carga de página,
 * sin que nadie pulse nada. Con el límite de acceso (10 por 15 minutos) un
 * trabajador normal que refresca la pantalla varias veces se quedaba sin
 * sesión, y como el navegador borra el token al fallar, sin poder volver
 * atrás: tenía que escribir la contraseña otra vez.
 *
 * Aquí el margen es de 120 por 15 minutos. Sigue habiendo techo —para que un
 * bucle de reintentos no se convierta en una denegación de servicio—, pero
 * de sobra para un día de trabajo con recargas y cambios de pestaña.
 */
export function limiteDeRefresco() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.NODE_ENV === 'test' ? 100000 : 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: 'Demasiadas renovaciones. Recarga la página en un momento.', codigo: 'DEMASIADOS_INTENTOS' },
  })
}

/** Límite general de la API, para que nadie pueda abusar de ella. */
export function limiteGeneral() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: config.NODE_ENV === 'test' ? 100000 : 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
}

/**
 * Envuelve un handler async para que sus rechazos lleguen al middleware de
 * errores en vez de quedar sin capturar y matar el proceso.
 */
export function asincrono(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}
