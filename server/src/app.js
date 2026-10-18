/**
 * Aplicación HTTP.
 *
 * Se construye aparte del arranque para que las pruebas puedan levantarla sin
 * abrir un puerto: `createApp()` devuelve el objeto Express y cada prueba
 * decide qué hace con él.
 */

import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cabeceras, cors, limiteGeneral } from './http/middlewares.js'
import { manejadorDeErrores, noEncontrado } from './http/errores.js'
import { query } from './db/client.js'
import authRoutes from './modules/auth/rutas.js'
import usuariosRoutes from './modules/usuarios/rutas.js'
import configRoutes from './modules/config/rutas.js'
import catalogoRoutes from './modules/catalogo/rutas.js'
import inventarioRoutes from './modules/inventario/rutas.js'
import produccionRoutes from './modules/produccion/rutas.js'
import albaranesRoutes from './modules/albaranes/rutas.js'
import ventasRoutes from './modules/ventas/rutas.js'
import comprasRoutes from './modules/compras/rutas.js'
import comercialesRoutes from './modules/comerciales/rutas.js'
import comisionesRoutes from './modules/comisiones/rutas.js'
import syncRoutes from './modules/sync/rutas.js'
import { requiereSesion } from './security/permisos.js'

export function createApp(opciones = {}) {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1)   // para que req.ip sea la real detrás del proxy

  app.use(cabeceras())
  app.use(cors())

  app.use(express.json({ limit: '1mb' }))
  app.use(limiteGeneral())

  // Solo revela si la API está viva. No dice cuántos usuarios hay ni qué
  // contiene la base.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'cleansahel-erp', time: new Date().toISOString() })
  })

  app.use('/api', authRoutes)
  app.use('/api/sync', syncRoutes)
  app.use('/api', usuariosRoutes)
  app.use('/api', configRoutes)
  //
  // COMPRAS ANTES QUE CATÁLOGO, y no es capricho.
  //
  // Compras expone `/suppliers/compras` (la ficha de compras de un proveedor) y
  // catálogo expone `/suppliers/:id` (el maestro). Express prueba en orden, así
  // que con catálogo primero, `/suppliers/compras` lo cogía la ruta del maestro,
  // intentaba hacer `Number('compras')` y devolvía un 22P02 —«Formato de dato
  // inválido»— que no señalaba el origen ni por un pelo.
  //
  // Lo LITERAJO de Express manda: primero en `app.use`, primero gana. Los
  // parámetros con nombre no tienen prioridad sobre los literales, hay que
  // registrar el más específico antes.
  app.use('/api', comprasRoutes)
  app.use('/api', catalogoRoutes)
  app.use('/api', inventarioRoutes)
  app.use('/api', produccionRoutes)
  app.use('/api', albaranesRoutes)
  app.use('/api', ventasRoutes)
    // Comerciales después de ventas: define `/zonas`, que el reparto también usa.
    app.use('/api', comercialesRoutes)
  app.use('/api', comisionesRoutes)

  // ── Interfaz web ────────────────────────────────────────────────────────
  // Se monta DESPUÉS de /api para que ninguna ruta de la API quede tapada por
  // el enrutado del cliente. historyApiFallback hace que un F5 en
  // /inventario siga encontrando index.html.
  if (opciones.servirInterfaz !== false) {
    const aqui = path.dirname(fileURLToPath(import.meta.url))
    const raiz = path.resolve(aqui, '..', '..', 'web')
    app.use(express.static(raiz, { index: 'index.html', maxAge: 0 }))
    // El F5 de una ruta de la SPA devuelve index.html. Pero `/api` Y SUS
    // HIJOS tienen que devolver JSON siempre, incluido el 404: una ruta de API
    // mal escrita que devuelve la página entera le da a un cliente un 200 con
    // HTML donde esperaba datos, y el error se descubre tres pantallas más
    // abajo, como «no se han podido cargar los datos».
    //
    // El exclusion era `api/` con barra, así que `/api` a secas —sin barra—
    // se colaba y devolvía la aplicación con un 200. Ahora se excluye también
    // el final de cadena.
    app.get(/^\/(?!api(?:\/|$))\w[\w\-./]*$/, (_req, res) => res.sendFile(path.join(raiz, 'index.html')))
  }

  app.use(noEncontrado)
  app.use(manejadorDeErrores)

  return app
}
