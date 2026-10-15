/**
 * Middleware de errores.
 *
 * Un único formato de error en toda la API, y los detalles internos NUNCA
 * llegan al cliente. Un volcado de traza de PostgreSQL en pantalla es información
 * gratis para quien intente romperla.
 */

// Qué regla se ha chocado, en cristiano.
//
// El nombre de la restricción se traduce a la frase que le diría alguien a
// la persona que está delante de la pantalla. Lo desconocido cae en un
// «revisa los datos» genérico en vez de inventarse una explicación: un
// mensaje que miente es peor que uno que no dice nada.
const REGLAS_DUPLICADO = [
  [/com_perfiles.*user_id|com_perfiles_user_id/i,
    'Esa persona ya tiene una ficha de comercial. No se puede dar de alta dos veces.'],
  [/users.*username|users_username/i,
    'Ese nombre de usuario ya está ocupado.'],
  [/users.*email|users_email/i,
    'Ese correo ya está registrado.'],
  [/items.*sku|items_sku/i,
    'Ya existe un artículo con esa referencia (SKU).'],
  [/sale_formats|item_id.*name/i,
    'Ese formato de caja ya está configurado para ese producto.'],
  [/lotes.*code|lots_code/i,
    'Ya existe un lote con ese código.'],
  [/customers.*code/i,
    'Ya existe un cliente con ese código.'],
  [/com_comercial_idiomas/i,
    'Ese idioma ya está asignado a ese comercial.'],
]

function mensajeDeDuplicado(restriccion) {
  for (const [patron, frase] of REGLAS_DUPLICADO) {
    if (patron.test(restriccion)) return frase
  }
  return 'Ya existe un registro con esos datos. Revisa si estás repetido.'
}

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
    // Por qué esto ya no devuelve el nombre crudo ni solo en `test`:
    //
    // «Ya existe un registro con esos datos» no sirve de nada. No dice QUÉ
    // choca, y quien lo lee no tiene forma de arreglarlo. Un nombre de
    // índice —`com_perfiles_user_id_key`— no es un secreto: es el nombre de
    // una regla del propio sistema, y quien está en el ERP ya sabe que su
    // nombre de usuario puede estar ocupado aunque no sepa cómo se llama la
    // columna. Lo que sí sería filtrar es el texto de la consulta o el
    // contenido de las tablas, y eso no sale nunca.
    //
    // Así que se hace las dos cosas: al servidor se le dice TODO (código,
    // restricción, consulta), y al que está en pantalla se le da un mensaje
    // que dice la regla en cristiano. Antes, encontrar por qué un alta
    // reventaba obligaba a poner la aplicación en modo de prueba en
    // producción, que es justo lo que no hay que hacer.
    const donde = err.constraint || err.detail || 'desconocida'
    // En el log del servidor, siempre. Es lo que se lee cuando algo falla de
    // madrugada y no hay nadie delante para preguntar.
    console.error(
      `[db 23505] restricción=${donde} · ${err.table || '?'} · ${(err.message || '').slice(0, 200)}`)
    return res.status(409).json({
      error: mensajeDeDuplicado(donde),
      codigo: 'DUPLICADO',
      // La regla concreta, no el detalle interno: qué está repetido y por qué
      // se repite. Sin valores, sin consultas, sin nombres de tabla ajenos.
      regla: donde,
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
