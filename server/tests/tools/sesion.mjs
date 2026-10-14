/**
 * SESIÓN PARA ARNESES.
 *
 * El login va con un límite de 10 intentos cada 15 minutos, por IP y usuario.
 * Un arnés que teclea la contraseña en cada pasada se come ese presupuesto con
 * sus propias pruebas, y a partir de la décima se queda esperando a una
 * aplicación que no arranca nunca: un fallo de autenticación disfrazado de
 * fallo de JavaScript, que es de las cosas que más tiempo quitan.
 *
 * La salida es una sesión real para el navegador: se hace UN login por `fetch`
 * y se siembra el token de refresco en `localStorage` antes de la primera
 * navegación. `app.js` llama a `A.recuperar()` al arrancar y con ese token la
 * aplicación entra sola.
 */

/** Un token de refresco, o null si el login está cerrado ahora mismo. */
export async function pedirRefresh(base = 'http://127.0.0.1:10000') {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'demo1234' }),
  })
  if (r.status === 429) return null
  if (!r.ok) throw new Error('el login devolvió ' + r.status)
  return (await r.json()).refresh
}

/**
 * Deja la aplicación abierta y lista.
 *
 * @returns {Promise<boolean>} false si el login estaba cerrado
 */
export async function abrir(p, { base = 'http://127.0.0.1:10000', refresh } = {}) {
  const tok = refresh || await pedirRefresh(base)
  if (!tok) return false
  // Sin caché: un arnés que lee una versión vieja del código da resultados de
  // una versión que ya no existe, y el fallo se achaca al código equivocado.
  await p.setCacheEnabled(false)
  // SOLO si no hay ya uno. El token de refresco rota en cada renovación, y
  // pisarlo con el original en cada navegación invalidaba el que la aplicación
  // acababa de emitir: la segunda página ya salía sin sesión y parecía un fallo
  // del arranque que en realidad era del arnés.
  await p.evaluateOnNewDocument((r) => {
    try {
      if (!localStorage.getItem('cs2.refresh')) localStorage.setItem('cs2.refresh', r)
    } catch {}
  }, tok)
  await p.goto(base + '/', { waitUntil: 'networkidle2', timeout: 45000 })
  await p.waitForFunction(
    () => { const a = document.getElementById('app'); return a && !a.classList.contains('oculto') },
    { timeout: 25000 },
  )
  await p.waitForSelector('a[data-ruta]', { visible: true, timeout: 15000 })
  return true
}
