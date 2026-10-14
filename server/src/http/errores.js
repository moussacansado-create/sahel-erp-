/**
 * Middleware de errores.
 *
 * Un único formato de error en toda la API, y los detalles internos NUNCA
 * llegan al cliente. Un volcado de traza de PostgreSQL en pantalla es información
 * gratis para quien intente romperla.
 */

export function manejadorDeErrores(err, req, res, _next) {
  const codigo = err.codigo || err.code || 'ERROR_INTERNO'

  // Errores de negocio: el mensaje es para el usuario.
  if (err.name === 'ErrorDeAuth' || err.name === 'ErrorDeStock' || err.estado) {
    return res.status(err.estado || 400).json({
      error: err.message,
      codigo,
      detalle: err.detalle || undefined,
    })
  }

  // Restricciones de la base de datos: 23505 duplicado, 23503 clave ajena,
  // 23514 CHECK, 22P02 tipo inválido. Son culpa de quien llama, no del servidor.
  if (codigo === '23505') {
    // El detalle SÍ ayuda: saber si choca el código o la versión de la receta
    // cambia por completo el mensaje que ve quien está en la pantalla.
    const donde = err.constraint || err.detail
    return res.status(409).json({
      error: 'Ya existe un registro con esos datos',
      codigo: 'DUPLICADO',
      detalle: process.env.NODE_ENV === 'test' ? donde : undefined,
    })
  }
  if (codigo === '23503') {
    return res.status(400).json({ error: 'La referencia no existe en el catálogo indicado', codigo: 'REFERENCIA_INVALIDA' })
  }
  if (codigo === '23514') {
    return res.status(400).json({ error: 'Los datos no cumplen las reglas del sistema', codigo: 'REGLA_VULNERADA', detalle: err.detail })
  }
  if (codigo === '22P02' || codigo === '22007') {
    return res.status(400).json({ error: 'Formato de dato inválido', codigo: 'FORMATO_INVALIDO' })
  }
  if (codigo === '22P08') {
    return res.status(400).json({ error: 'Se han enviado parámetros que no son válidos', codigo: 'PARAMETROS_INVALIDOS' })
  }

  // Resto: se registra entero, se responde genérico.
  console.error(`[error] ${req.method} ${req.originalUrl}`, err)
  return res.status(500).json({
    error: 'Error interno del servidor',
    codigo: 'ERROR_INTERNO',
    // Solo en desarrollo, para no perder tiempo depurando.
    ...(process.env.NODE_ENV === 'development' ? { detalle: err.message } : {}),
  })
}

export function noEncontrado(req, res) {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}`, codigo: 'RUTA_NO_ENCONTRADA' })
}
