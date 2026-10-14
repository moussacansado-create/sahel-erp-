/**
 * Envoltorio de supertest con punto de entrada español.
 *
 * `request(app).post('/api/x').send({...})` devuelve directamente un objeto con
 * { status, body, headers }: el cuerpo llega parseado, para que las pruebas
 * lean `r.body.error` sin convertir texto cada vez.
 *
 * Se implementa como una cadena explícita en vez de un Proxy, porque un Proxy
 * sobre supertest no conserva el estado entre llamadas de la cadena.
 */
import supertest from 'supertest'

const METODOS = ['get', 'post', 'put', 'patch', 'delete']

/** Envuelve la respuesta de supertest con el cuerpo ya parseado. */
function envolver(res) {
  let body = null
  const texto = res.text ?? ''
  if (texto) {
    try { body = JSON.parse(texto) } catch { body = texto }
  }
  return {
    status: res.status,
    body,
    headers: res.headers,
    text: texto,
    /** Atajo: el mensaje de error, o '' si no lo hay. */
    get error() { return body?.error ?? '' },
  }
}

/** Objeto encadenable. Cada llamada devuelve uno nuevo con la petición acumulada. */
function cadena(agente, metodo, ruta, cuerpo, cabeceras) {
  // supertest devuelve un objeto "Test" que solo ejecuta al esperarlo (tiene
  // then). Por eso send/query devuelven una promesa, no la respuesta directa.
  const ejecutar = (t) => Promise.resolve(t).then(envolver)
  const self = {
    send(c) { return ejecutar(agente[metodo](ruta).set(cabeceras).send(c)) },
    query(q) { return ejecutar(agente[metodo](ruta).query(q).set(cabeceras)) },
    set(c, v) { return cadena(agente, metodo, ruta, cuerpo, { ...cabeceras, [c]: v }) },
    then(fn) { return self.send(cuerpo).then(fn) },
  }
  return self
}

export function request(app) {
  const agente = supertest(app)
  const api = {
    then: (fn) => Promise.resolve(fn).then ? api : api,   // no-op, por si acaso
  }
  for (const m of METODOS) {
    api[m] = (ruta) => cadena(agente, m, ruta, undefined, {})
  }
  return api
}
