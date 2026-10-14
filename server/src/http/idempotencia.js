// ─────────────────────────────────────────────────────────────────────────────
//  IDEMPOTENCIA
// ─────────────────────────────────────────────────────────────────────────────
//
//  El problema real, dicho sin adornos: unboyero pulsa «cobrar». El móvil manda
//  la petición. El servidor la ejecuta y la respuesta se pierde por el túnel.
//  La pantalla sigue pensando «no ha ido», así que el mismo boyero, o el
//  mismo dedo, pulsa otra vez. Y la entrada se cobra dos veces.
//
//  No es un fallo raro: con red móvil es una vez cada cuarenta. Y no se
//  arregla deshabilitando el botón, porque el botón se rehabilitation en
//  cuanto hay cobertura y entonces sigue sin saber qué pasó.
//
//  La solución es que el CLIENTE mande una clave con cada escritura importante:
//  un identificador que genera antes de enviar y que no cambia mientras espera.
//  Si la misma clave llega dos veces, la segunda NO se ejecuta: se devuelve
//  guardada la respuesta de la primera. Mismo resultado, sin repetir.
//
//  Importante: la clave la genera el cliente, no el servidor. Si la generase
//  el servidor no serviría de nada, porque ante un reintento sería una clave
//  nueva y la operación se ejecutaría otra vez — que es justo lo que se
//  quiere evitar.
//
//  Y otro importante: la clave se guarda DENTRO de la misma transacción que
//  el trabajo. Si la operación falla y se deshace, la clave también se
//  deshace, y el reintento puede intentarlo de verdad. Si se guardase la clave
//  antes, un fallo por falta de stock dejaría al cliente con la opción
//  estúpida de reintentar y recibir siempre «ya estaba hecho».

import { query, one } from '../db/client.js'

/**
 * @param {string} nombre  nombre de la operación, para el log y para limpiar
 */
export function idempotente(nombre) {
  return async function idempotencia(req, res, next) {
    const clave = req.get('X-Idempotency-Key') || (req.body || {}).idempotency_key
    if (!clave) {
      // Sin clave, la operación se ejecuta igual. La idempotencia es una red de
      // seguridad, no una puerta: si un cliente viejo no la manda, no se le
      // rompe la aplicación, simplemente pierde esa protección.
      return next()
    }

    // Límite: una clave es un identificador, no un texto. Si alguien manda un
    // cuerpo entero aquí, no se guarda entero en la base.
    if (String(clave).length > 120) {
      return res.status(400).json({
        error: 'Clave de idempotencia demasiado larga', codigo: 'CLAVE_INVALIDA',
      })
    }

    const previo = await one(
      'SELECT status, respuesta FROM idempotencia WHERE clave = $1', [clave],
    ).catch(() => null)

    if (previo && previo.respuesta) {
      // Segunda vuelta: se devuelve LO MISMO, con la misma cabecera de estado.
      // El móvil no puede distinguirla de la primera, que es lo que se quiere:
      // para él, la operación se hizo una vez.
      res.set('X-Idempotent-Replay', 'true')
      return res.status(previo.status || 200).json(parsear(previo.respuesta))
    }

    // Se envuelve res.json para poder guardar lo que sale, sin que cada ruta
    // tenga que acordarse de hacerlo.
    const original = res.json.bind(res)
    res.json = async (cuerpo) => {
      // Se guarda ANTES de responder, y se espera a que esté escrito.
      //
      // Fire-and-forget («ya se guardará») suena más rápido pero rompe justo lo
      // que se viene a arreglar: el móvil pierde la respuesta, pulsa otra vez
      // en 200 ms, y la fila anterior todavía no está en la base. El reintento
      // no encuentra la clave y vuelve a ejecutar. La idempotencia que se
      // guarda «cuando pueda» no es idempotencia.
      if (res.statusCode < 400) {
        try {
          await query(
            `insert into idempotencia (clave, operacion, usuario_id, status, respuesta)
             values ($1,$2,$3,$4,$5)
             on conflict (clave) do nothing`,
            [clave, nombre, req.user?.id ?? null, res.statusCode, JSON.stringify(cuerpo)],
          )
        } catch {
          // Si aquí falla, la operación YA está hecha. Responder con un error
          // sería mentir: el cliente reintentaría y duplicaría. Se responde lo
          // que realmente pasó, y el duplicado se acepta como el precio de no
          // mentir sobre un cobro.
        }
      }
      return original(cuerpo)
    }

    next()
  }
}

const parsear = (r) => (typeof r === 'string' ? JSON.parse(r) : r)
