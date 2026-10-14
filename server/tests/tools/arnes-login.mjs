/**
 * Arnés de login y arranque.
 *
 * Antes escribía en `input[0]` e `input[1]`, que en esta página son el campo de
 * la URL de la API (dentro de un <details> plegado) y el de usuario. Por eso la
 * contraseña nunca llegaba a su sitio. Se escribe por `id` y se ESPERA una señal
 * —que el menú exista y `#app` deje de estar oculta— en vez de dormir 3,5 s y
 *rezar. Dormir es como seQUEUE un arnés que pasa sin probar nada.
 */
export const entrar = async (p, B = 'http://127.0.0.1:10000') => {
  await p.goto(B + '/', { waitUntil: 'networkidle2', timeout: 45000 })
  await p.waitForSelector('#usuario', { visible: true, timeout: 20000 })
  await p.type('#usuario', 'admin')
  await p.type('#clave', 'demo1234')
  await p.click('#form-acceso button[type=submit], #form-acceso button:not([type=button])')
  // La señal: la aplicación se ha abierto.
  await p.waitForFunction(
    () => { const a = document.getElementById('app'); return a && !a.classList.contains('oculto') },
    { timeout: 25000 },
  )
  await p.waitForSelector('a[data-ruta="caja"]', { visible: true, timeout: 15000 })
  return true
}
