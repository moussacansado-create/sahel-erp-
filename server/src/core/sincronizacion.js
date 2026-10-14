// ─────────────────────────────────────────────────────────────────────────────
//  SINCRONIZACIÓN ENTRE DISPOSITIVOS
// ─────────────────────────────────────────────────────────────────────────────
//
//  Aquí NO viajan datos. Solo la noticia de que una tabla ha cambiado, y el
//  motivo es concreto: si el servidor empujara el contenido, tendría que
//  filtrarlo por los permisos de quien escucha, y ese es exactamente el punto
//  donde un sistema se fuga. Un comercial con la zona norte se conectaría al
//  canal y recibiría la notificación de un cliente del sur, que luego no podría
//  ver pero sabría que existe.
//
//  Con esta forma, el canal no sabe qué ha cambiado ni a quién le afecta:
//  solo dice «algo se movió aquí». Cada móvil vuelve a pedir los datos por su
//  API de siempre, con su sesión y su zona, y el filtrado es el de siempre.
//  No hay una segunda puerta por la que entre information.
//
//  El sondeo en vez de LISTEN/NOTIFY es a conciencia: PGlite corre en WASM
//  sobre un solo hilo, y una conexión de notificación asíncrona encima
//  comparte ese hilo con las peticiones que están sirviendo. Un sondeo cada
//  segundo y medio no se nota y no puede colgar el servidor.

import { EventEmitter } from 'node:events'
import { query } from '../db/client.js'

const emisor = new EventEmitter()
emisor.setMaxListeners(0)   // muchos móviles a la vez, y es lo normal

let ultimoId = 0
let timer = null

const CADA_MS = 1500

export function alCambiar(fn) {
  emisor.on('cambio', fn)
  return () => emisor.off('cambio', fn)
}

async function sondear() {
  try {
    if (!ultimoId) {
      const f = await query('select coalesce(max(id), 0) as m from cambios')
      ultimoId = f[0].m
      return
    }
    const filas = await query(
      'select id, tabla from cambios where id > $1 order by id asc limit 200', [ultimoId],
    )
    if (!filas.length) return
    ultimoId = filas[filas.length - 1].id
    // Se agrupa: veinte movimientos de caja seguidos son un «cambió la caja»,
    // no veinte avisos. El móvil no se enter veinte veces de lo mismo.
    const tablas = [...new Set(filas.map((f) => f.tabla))]
    emisor.emit('cambio', { tablas, hasta: ultimoId })
  } catch {
    // Sondear no puede tirar la aplicación porque un sondeo falle. El ciclo
    // siguiente lo reintenta solo.
  }
}

export function arrancarSincronizacion() {
  if (timer) return
  timer = setInterval(sondear, CADA_MS)
  timer.unref?.()
  sondear()
}

export function pararSincronizacion() {
  clearInterval(timer)
  timer = null
}
