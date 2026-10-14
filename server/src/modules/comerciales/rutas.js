import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { query, one } from '../../db/client.js'
import { tienePermiso } from '../../security/permisos.js'
import { abrirIncidencia, cambiarEstado, listarIncidencias } from '../../core/incidencias.js'
import { crearSeguimiento, cerrarSeguimiento, listarSeguimientos } from '../../core/seguimientos.js'
import {
  generarAlertas, listarAlertasComerciales, atenderAlerta,
  umbralInactividad, inactividadActiva, ponerUmbralInactividad,
} from '../../core/alertas-comerciales.js'
import { mapa, carteras, perfilDe, administraComerciales, asignarZonas, zonasDe, zonasQuePuedoUsar } from '../../core/mapa-comercial.js'
import { requiereSesion, requiereAlgunoDe } from '../../security/permisos.js'
import {
  ErrorComercial, listarZonas, crearZona, actualizarZona,
  altaComercial, bajaComercial, listarComerciales, asignarZona, afinidades,
  ponerObjetivo, listarObjetivos, registrarVisita, listarVisitas,
  ranking, puntosDe, concederPuntos, estadisticas, hechos,
} from '../../core/comerciales.js'
import {
  METRICAS, listarRankings, listarReglas, crearRanking, editarRanking,
  crearRegla, editarRegla, cambiarEstadoRegla, otorgarPuntos, ventana,
} from '../../core/rankings.js'

const rutas = Router()

/**
 * COMERCIALES · API
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * AQUÍ NO HAY LÓGICA. Ni una regla, ni una validación de negocio, ni un
 * cálculo. Eso vive en `core/comerciales.js`, que está probado.
 *
 * Y no es una cuestión de estilo. Si el núcleo dice que un comercial necesita
 * un idioma y la API dice otra cosa, hay dos verdades sobre la misma regla y
 * solo una va a fallar primero. La que falla primero es la que aparece en el
 * móvil del repartidor, no la que está en el test.
 *
 * Lo que sí hace esta capa:
 *
 *   · traducir HTTP a funciones y funciones a HTTP;
 *   · decir QUÉ código de permiso hace falta para qué;
 *   · comprobar lo que HTTP puede comprobar mejor que el núcleo: que el id de
 *     la ruta es un número, y que el cuerpo es un objeto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PERMISOS. TRES NIVELES, NO UNO.
 *
 * Un único permiso para el módulo entero significaría que cualquier comercial
 * que pudiera mirar el ranking podía también cambiarle el objetivo a un
 * compañero. Y cambiar un objetivo antes de que empiece el periodo es
 * exactamente el poder que decide quién va primero.
 *
 * De ahí tres: VER, GESTIONAR y OBJETIVOS. Ver lo tiene cualquiera del equipo
 * —un ranking que solo ve quien dirige es un ranking del que la gente
 * desconfía—, gestionar es de quien lleva el negocio, y objetivos es aparte
 * porque es el poder que mueve el ranking.
 *
 * NINGUNA RUTA TOCA `users.role`. El rol no se deduce de que alguien venda.
 * Dar de alta a un comercial no puede quitarle permisos a quien los tenía.
 */

const auth = requiereSesion({ query, one })

const VER = requiereAlgunoDe([['commercial', 'view'], ['sales', 'view']], 'ver comerciales')
const GESTIONAR = requiereAlgunoDe([['commercial', 'create']], 'gestionar comerciales')
const OBJETIVOS = requiereAlgunoDe([['commercial', 'edit']], 'gestionar objetivos')
// El mapa se lee con lo que ya tiene el comercial. No hace falta permiso nuevo:
// crear uno seria dar por supuesto un derecho que la 037/038 ya repartieron.
const MAPA = requiereAlgunoDe([['zones', 'view'], ['commercial', 'view']], 'consultar el mapa')

// ── RANKINGS CONFIGURABLES ──────────────────────────────────────────────────
//
// LEER el ranking y CONFIGURARLOS son dos cosas distintas, y la diferencia no
// es estética: configurar una regla cambia la nota de un compañero. Por eso hay
// dos permisos y no uno.
//
// · `rankings:view`  — ver la clasificación y en qué consiste cada competición.
// · `rankings:edit`  — crear, editar, pausar y desactivar. ADMIN y JEFE_COMERCIAL.
//
// Un COMERCIAL NO tiene `edit`. Y no porque el botón esté oculto: `requiereAlgunoDe`
// contesta 403 ANTES de que la función se ejecute. Ocultarlo sería cortesía; el 403
// es la garantía. Un comercial que llame a la API directamente recibe lo mismo que
// un usuario sin sesión.
const VER_RANKING = requiereAlgunoDe([['rankings', 'view']], 'ver el ranking')
const CONFIGURAR_RANKING = requiereAlgunoDe([['rankings', 'edit']], 'configurar rankings y reglas de puntos')

/**
 * Envuelve cada ruta para que el error llegue al usuario con su código y su
 * mensaje, en vez de convertirse en un «error interno» que no dice nada.
 *
 * El mensaje del núcleo está escrito para entenderse: «un comercial necesita
 * al menos un idioma». Eso es lo que tiene que ver quien lo ha escrito mal,
 * no «validation failed».
 */
const ruta = (fn) => asincrono(async (req, res) => {
  try {
    // Si la función devuelve `{ status, cuerpo }`, se responde con eso; si
    // devuelve el resultado pelado, se responde 200. Así el 201 no se escribe
    // dentro de la función de negocio.
    const r = await fn(req)
    if (r === undefined) return res.status(204).end()
    if (r && typeof r === 'object' && r.__respuesta) {
      return res.status(r.__respuesta).json(r.cuerpo)
    }
    return res.json(r)
  } catch (e) {
    if (e instanceof ErrorComercial) {
      return res.status(e.estado ?? 400).json({
        error: e.message, codigo: e.codigo, detalle: e.detalle ?? undefined,
      })
    }
    // `NO_SE_GUARDO` y `SE_GUARDO_OTRO_VALOR` no son de este módulo, pero son
    // errores que el usuario TIENE que ver: significan que el sistema ha dicho
    // que ha guardado algo y no lo ha guardado.
    if (e.codigo === 'NO_SE_GUARDO' || e.codigo === 'SE_GUARDO_OTRO_VALOR') {
      return res.status(500).json({ error: e.message, codigo: e.codigo })
    }
    throw e
  }
})

/** Un id de ruta tiene que ser un número. Fallar aquí es más claro que en SQL. */
function idDe(req, nombre = 'id') {
  const v = Number(req.params[nombre])
  if (!Number.isInteger(v) || v <= 0) {
    throw new ErrorComercial(`El ${nombre} de la URL no es un número válido: «${req.params[nombre]}».`, {
      codigo: 'ID_INVALIDO', estado: 400,
    })
  }
  return v
}

/** El cuerpo tiene que ser un objeto. `JSON.stringify(null)` da «null», no un 400. */
function cuerpoDe(req) {
  const b = req.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new ErrorComercial('No se ha recibido qué hacer. Se esperaba un objeto con los datos.', {
      codigo: 'CUERPO_INVALIDO', estado: 400,
    })
  }
  return b
}

// ═══ Zonas ══════════════════════════════════════════════════════════════════

/**
 * GET /api/mapa
 *
 * Región → Zona → Comercial responsable → Clientes.
 *
 * El permiso es el de LEER (`zones:view` o `commercial:view`), que el comercial
 * ya tiene. Lo que cambia segun quien pregunta no es si puede ver el mapa —
 * el mapa es del territorio, no suyo — sino SI CON SERIE ve los nombres de los
 * clientes. Un comercial recibe los recuentos de todas las zonas y la lista
 * completa solo de las suyas. Los nombres de los demas ni se piden a la base.
 *
 * Y los clientes sin comercial NO se reparten: salen con `sin_asignar` para que
 * la administracion los vea como lo que son.
 */
rutas.get('/mapa', auth, MAPA, ruta(async (req) => {
  const perfil = await perfilDe(req.user.id)
  const admin = await administraComerciales(req.user)
  return mapa({
    // Un comercial NO tiene perfil todavía: no puede tener cartera, así que ve
    // el mapa sin nombres. Antes que devolverle los de otro.
    perfilId: admin ? null : (perfil ? perfil.id : -1),
    verClientes: true,
  })
}))

/** GET /api/mapa/carteras · solo quien administra. Sin esto, 403. */
rutas.get('/mapa/carteras', auth, GESTIONAR, ruta(async () => carteras()))

/**
 * El `com_perfiles.id` de quien pregunta, o `null` si administra.
 *
 * `null` significa «sin filtro»: quien administra ve todas las carteras. Un
 * comercial sin perfil NO es `null` — sería darle todas por no encontrar el
 * suyo, que es justo el fallo que hay que evitar.
 */
async function alcanceDeComercial(usuarioId) {
  const esAdmin = await tienePermiso(usuarioId, 'commercial', 'create')
  if (esAdmin) return null
  const p = await one('SELECT id FROM com_perfiles WHERE user_id = $1 AND is_active', [usuarioId])
  return p ? p.id : -1
}

/**
 * GET /api/mis-zonas · las zonas que quien pregunta puede poner en un cliente.
 *
 * El desplegable del formulario se llena con esto y no con la lista entera. Un
 * comercial ve solo las suyas; quien administra, todas. La lista se decide en el
 * servidor, con la MISMA regla que luego comprueba `limitarCartera()`: si no,
 * el formulario ofrecería zonas que el backend rechaza.
 */
rutas.get('/mis-zonas', auth, VER, ruta(async (req) => {
  const perfil = await perfilDe(req.user.id)
  const gestiona = await administraComerciales(req.user)
  return zonasQuePuedoUsar(gestiona ? null : (perfil ? perfil.id : -1), gestiona)
}))

/**
 * GET /api/comerciales/:id/zonas · las zonas que lleva, con su base.
 * PUT  /api/comerciales/:id/zonas · la lista FINAL de zonas que lleva.
 *
 * Es un PUT y no un POST por zona porque lo que se manda desde la pantalla es
 * «estas son las zonas de este comercial», no «añade una más». Con un POST por
 * zona, quitar una exigiría un DELETE y la pantalla tendría que saber el
 * estado anterior para poder deshacer. Enviando la lista entera no hay estado
 * que recordar: lo que se ve es lo que queda.
 */
rutas.get('/comerciales/:id/zonas', auth, VER, ruta(async (req) => zonasDe(idDe(req))))

rutas.put('/comerciales/:id/zonas', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return asignarZonas(idDe(req), b.zonaIds || [], req.user.id, b.base ?? null)
}))

/**
 * GET /api/comerciales/:id/zonas · las zonas que lleva, con su base.
 * PUT  /api/comerciales/:id/zonas · la lista FINAL de zonas que lleva.
 *
 * Es un PUT y no un POST por zona porque lo que se manda desde la pantalla es
 * «estas son las zonas de este comercial», no «añade una más». Con un POST por
 * zona, quitar una exigiría un DELETE y la pantalla tendría que saber el
 * estado anterior para poder deshacer. Enviando la lista entera no hay estado
 * que recordar: lo que se ve es lo que queda.
 */
rutas.get('/comerciales/:id/zonas', auth, VER, ruta(async (req) => zonasDe(idDe(req))))

rutas.put('/comerciales/:id/zonas', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return asignarZonas(idDe(req), b.zonaIds || [], req.user.id, b.base ?? null)
}))

/**
 * GET /api/comerciales/:id/zonas · las zonas que lleva, con su base.
 * PUT  /api/comerciales/:id/zonas · la lista FINAL de zonas que lleva.
 *
 * Es un PUT y no un POST por zona porque lo que se manda desde la pantalla es
 * «estas son las zonas de este comercial», no «añade una más». Con un POST por
 * zona, quitar una exigiría un DELETE y la pantalla tendría que saber el
 * estado anterior para poder deshacer. Enviando la lista entera no hay estado
 * que recordar: lo que se ve es lo que queda.
 */
rutas.get('/comerciales/:id/zonas', auth, VER, ruta(async (req) => zonasDe(idDe(req))))

rutas.put('/comerciales/:id/zonas', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return asignarZonas(idDe(req), b.zonaIds || [], req.user.id, b.base ?? null)
}))

// ═══ INCIDENCIAS COMERCIALES ══════════════════════════════════════════════
//
// Distintas de `incidents`, que son del reparto y no se tocan. Estas cuelgan
// del cliente y se resuelven en el módulo comercial.
rutas.get('/comerciales/incidencias', auth, VER, ruta(async (req) => {
  // El alcance se resuelve AQUÍ, con el perfil de quien pregunta: un comercial
  // que no ponga `comercialId` recibe las suyas y no todas. Sin esto, abrir
  // el listado sin filtros le enseñaría los problemas de la competencia.
  const propio = await alcanceDeComercial(req.user.id)
  return listarIncidencias({
    clienteId: req.query.cliente ? Number(req.query.cliente) : null,
    comercialId: req.query.comercial ? Number(req.query.comercial) : propio,
    estado: req.query.estado || null,
    limite: Number(req.query.limite) || 100,
  })
}))

rutas.post('/comerciales/incidencias', auth, VER, ruta(async (req) => {
  const b = cuerpoDe(req)
  const inc = await abrirIncidencia({
    // QUIÉN LA REGISTRA: la sesión. Nunca el cuerpo.
    usuarioId: req.user.id,
    clienteId: b.clienteId ? Number(b.clienteId) : null,
    comercialId: b.comercialId ? Number(b.comercialId) : null,
    comunicadaPor: b.comunicadaPor ? Number(b.comunicadaPor) : null,
    tipo: b.tipo,
    descripcion: b.descripcion,
    gravedad: b.gravedad || 'NORMAL',
    proximaAccion: b.proximaAccion ?? null,
    fechaSeguimiento: b.fechaSeguimiento ?? null,
  })
  return { __respuesta: 201, cuerpo: inc }
}))

rutas.put('/comerciales/incidencias/:id', auth, VER, ruta(async (req) => {
  const b = cuerpoDe(req)
  const inc = await cambiarEstado({
    id: Number(req.params.id),
    usuarioId: req.user.id,
    estado: b.estado,
    resolucion: b.resolucion ?? null,
    proximaAccion: b.proximaAccion ?? null,
    fechaSeguimiento: b.fechaSeguimiento ?? null,
  })
  return inc
}))

// ═══ SEGUIMIENTOS ════════════════════════════════════════════════════════
rutas.get('/comerciales/seguimientos', auth, VER, ruta(async (req) => {
  const propio = await alcanceDeComercial(req.user.id)
  return listarSeguimientos({
    clienteId: req.query.cliente ? Number(req.query.cliente) : null,
    asignadoA: req.query.asignado === '1' ? propio : undefined,
    situacion: req.query.situacion || null,
    limite: Number(req.query.limite) || 200,
  })
}))

rutas.post('/comerciales/seguimientos', auth, VER, ruta(async (req) => {
  const b = cuerpoDe(req)
  const t = await crearSeguimiento({
    // QUIÉN LA CREA: la sesión.
    usuarioId: req.user.id,
    clienteId: b.clienteId ? Number(b.clienteId) : null,
    titulo: b.titulo,
    descripcion: b.descripcion ?? null,
    motivo: b.motivo ?? null,
    prioridad: b.prioridad || 'NORMAL',
    venceEn: b.venceEn ?? null,
    asignadoA: b.asignadoA ? Number(b.asignadoA) : null,
    visitaId: b.visitaId ? Number(b.visitaId) : null,
    incidenciaId: b.incidenciaId ? Number(b.incidenciaId) : null,
  })
  return { __respuesta: 201, cuerpo: t }
}))

rutas.post('/comerciales/seguimientos/:id/cerrar', auth, VER, ruta(async (req) => {
  const b = cuerpoDe(req)
  return cerrarSeguimiento({
    id: Number(req.params.id),
    usuarioId: req.user.id,
    resultado: b.resultado ?? null,
    cancelar: b.cancelar === true || b.cancelar === 'true',
    motivoCancelacion: b.motivoCancelacion ?? null,
  })
}))

// ═══ CENTRO DE ALERTAS COMERCIALES ═══════════════════════════════════════
rutas.get('/comerciales/alertas', auth, VER, ruta(async (req) => {
  const propio = await alcanceDeComercial(req.user.id)
  return listarAlertasComerciales({ perfilId: propio, limite: Number(req.query.limite) || 200 })
}))

/** Genera las que falten. Idempotente por `dedupe_key`: se puede llamar mil veces. */
rutas.post('/comerciales/alertas/generar', auth, VER, ruta(async (req) => generarAlertas()))

rutas.post('/comerciales/alertas/atender', auth, VER, ruta(async (req) => {
  const b = cuerpoDe(req)
  return atenderAlerta(b.dedupeKey, req.user.id)
}))

/** El umbral, desde administración. Sin tocar código. */
rutas.get('/comerciales/config', auth, VER, ruta(async () => ({
  umbralInactividad: await umbralInactividad(),
  inactividadActiva: await inactividadActiva(),
})))

rutas.put('/comerciales/config/inactividad', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return { umbral: await ponerUmbralInactividad(b.dias, req.user.id) }
}))

rutas.get('/comerciales/zonas', auth, VER, ruta(async (req) => listarZonas({ conIdiomas: req.query.idiomas === '1' })))

rutas.post('/comerciales/zonas', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  const creada = await crearZona({
    code: b.code, name: b.name, kind: b.kind,
    parentId: b.parentId ?? null,
    idiomas: Array.isArray(b.idiomas) ? b.idiomas : [],
    notas: b.notas ?? null, usuarioId: req.user.id,
  })
  return { __respuesta: 201, cuerpo: creada }
}))

rutas.put('/comerciales/zonas/:id', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return actualizarZona(idDe(req), {
    name: b.name ?? null, kind: b.kind ?? null,
    parentId: b.parentId === undefined ? undefined : (b.parentId ? Number(b.parentId) : null),
    notas: b.notas ?? null,
    idiomas: Array.isArray(b.idiomas) ? b.idiomas : null,
    usuarioId: req.user.id,
  })
}))

// (No hay ruta de zona suelta: una zona son cinco líneas y se ven en la lista.
// Abrirla en una pantalla propia para editarla es de la fase de pantalla.)


// ═══ Comerciales ═══════════════════════════════════════════════════════════

rutas.get('/comerciales', auth, VER, ruta(async (req) => listarComerciales({ soloActivos: req.query.todos !== '1' })))

rutas.post('/comerciales', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  const alta = await altaComercial({
    userId: b.userId,
    idiomas: Array.isArray(b.idiomas) ? b.idiomas : [b.idioma].filter(Boolean),
    zonaId: b.zonaId ? Number(b.zonaId) : null,
    hiredOn: b.hiredOn ?? null, notas: b.notas ?? null, usuarioId: req.user.id,
  })
  return { __respuesta: 201, cuerpo: alta }
}))

rutas.delete('/comerciales/:id', auth, GESTIONAR, ruta(async (req) => bajaComercial(idDe(req), req.user.id)))

rutas.post('/comerciales/:id/zona', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  if (b.zonaId === undefined || b.zonaId === null) {
    throw new ErrorComercial('Falta la zona a la que asignarlo.', { codigo: 'ZONA_FALTA' })
  }
  return asignarZona(idDe(req), Number(b.zonaId), req.user.id)
}))

// ═══ Objetivos ══════════════════════════════════════════════════════════════

rutas.post('/comerciales/:id/objetivo', auth, OBJETIVOS, ruta(async (req) => {
  const b = cuerpoDe(req)
  const puesto = await ponerObjetivo({
    comercialId: idDe(req),
    periodStart: b.periodStart, periodEnd: b.periodEnd,
    targetAmount: b.targetAmount ?? null,
    targetUnits: b.targetUnits ?? null,
    targetOrders: b.targetOrders ?? null,
    targetVisits: b.targetVisits ?? null,
    notas: b.notas ?? null, usuarioId: req.user.id,
  })
  return { __respuesta: 201, cuerpo: puesto }
}))

rutas.get('/comerciales/:id/objetivos', auth, VER, ruta(async (req) => listarObjetivos({ comercialId: idDe(req) })))

// ═══ Visitas ════════════════════════════════════════════════════════════════

  rutas.post('/comerciales/visitas', auth, VER, ruta(async (req) => {
    const b = cuerpoDe(req)
    const visita = await registrarVisita({
      // El que la ESCRIBE lo pone el servidor, siempre. Si se leyera del
      // cuerpo, cualquiera podria firmar las visitas de otro.
      usuarioId: req.user.id,
      // El que la HIZO. Antes `comercialId` venia del cuerpo y decidia el
      // autor de la visita: mandar otro id registraba una visita «en nombre
      // de» otro comercial sin que nadie se enterara.
      comercialId: b.comercialId ? Number(b.comercialId) : null,
      // El administrador puede ser quien VA, sin tener cartera propia. Entonces
      // se anota aqui y la fila conserva a su comercial.
      realizadaPor: b.realizadaPor ? Number(b.realizadaPor) : null,
      clienteId: b.clienteId ? Number(b.clienteId) : null,
      tipoVisita: b.tipoVisita ?? null,
      resultado: b.resultado,
      notas: b.notas ?? null,
      huboPedido: b.huboPedido ?? null,
      pedidoId: b.pedidoId ? Number(b.pedidoId) : null,
      problemas: b.problemas ?? null,
      nextAction: b.nextAction ?? null,
      nextActionDate: b.nextActionDate ?? null,
      lat: b.lat ?? null, lng: b.lng ?? null,
    })
    return { __respuesta: 201, cuerpo: visita }
  }))

rutas.get('/comerciales/visitas', auth, VER, ruta(async (req) => listarVisitas({
  comercialId: req.query.comercialId ? Number(req.query.comercialId) : null,
  clienteId: req.query.clienteId ? Number(req.query.clienteId) : null,
  limite: req.query.limite ? Number(req.query.limite) : 50,
})))

// ═══ Ranking, puntos, estadísticas ═════════════════════════════════════════
//
// El ranking es de todo el equipo. Un ranking que solo ve quien dirige es un
// ranking del que la gente desconfía, y de uno en el que no se confía no se
// saca nada útil. Lo que es de cada uno son sus notas de visita, y eso se ve
// en su propia ficha.
//

rutas.get('/comerciales/ranking', auth, VER, ruta(async (req) => ranking({
  desde: req.query.desde, hasta: req.query.hasta,
})))

rutas.get('/comerciales/estadisticas', auth, VER, ruta(async () => estadisticas()))

rutas.get('/comerciales/afinidades', auth, VER, ruta(async (req) => afinidades({
  comercialId: req.query.comercialId ? Number(req.query.comercialId) : null,
})))

rutas.get('/comerciales/:id/puntos', auth, VER, ruta(async (req) => puntosDe(idDe(req), {
  desde: req.query.desde, hasta: req.query.hasta,
})))

rutas.get('/comerciales/:id/hechos', auth, VER, ruta(async (req) => {
  const { desde, hasta } = req.query.desde && req.query.hasta
    ? { desde: req.query.desde, hasta: req.query.hasta }
    : mesPorDefecto()
  return hechos(idDe(req), desde, hasta)
}))

rutas.post('/comerciales/:id/puntos/conceder', auth, OBJETIVOS, ruta(async (req) => concederPuntos({
  comercialId: idDe(req), desde: req.query.desde, hasta: req.query.hasta, usuarioId: req.user.id,
})))

/** Copia mínima de `mesEnCurso()` para no importar más de lo necesario. */
function mesPorDefecto() {
  const h = new Date()
  return {
    desde: new Date(h.getFullYear(), h.getMonth(), 1).toISOString().slice(0, 10),
    hasta: new Date(h.getFullYear(), h.getMonth() + 1, 0).toISOString().slice(0, 10),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONAS · LAS NUEVE REGIONES DE MALI
//
// Añadidas después de las de module.exports, porque `export default` ya cerró
// el fichero y en ES Modules no se puede exportar dos veces. Se añaden aquí y
// se enganchan abajo, con las mismas protecciones que el resto.
// ═══════════════════════════════════════════════════════════════════════════

const Z = await import('../../core/zonas.js')
const FICHA = await import('../../core/comerciales-ficha.js')
const EDICION = await import('../../core/comerciales-edicion.js')

rutas.get('/comerciales/mapa', auth, VER, ruta(async (req) => Z.listarZonasMapa({
  periodo: req.query.periodo ?? 'MES',
  desde: req.query.desde,
  hasta: req.query.hasta,
  comercialId: req.query.comercialId ? Number(req.query.comercialId) : null,
})))

rutas.get('/comerciales/zonas/:id', auth, VER, ruta(async (req) => Z.fichaZona(idDe(req), {
  periodo: req.query.periodo ?? 'MES',
  desde: req.query.desde,
  hasta: req.query.hasta,
})))

rutas.post('/comerciales/zonas/:id/comerciales', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  if (!b.comercialId) {
    throw new ErrorComercial('Falta el comercial que se quiere asignar.', { codigo: 'COMERCIAL_FALTA' })
  }
  return Z.asignarComercialAZona({
    comercialId: Number(b.comercialId),
    zonaId: idDe(req),
    esPrincipal: b.esPrincipal === true,
    porcentaje: b.porcentaje ?? null,
    desde: b.desde ?? null,
    hasta: b.hasta ?? null,
    notas: b.notas ?? null,
    usuarioId: req.user.id,
  })
}))

// ───────────────────────────────────────────────────────────────────────────
// LA FICHA DE UN COMERCIAL
//
// `GET /api/comerciales/:id`
//
// Sale DESPUÉS de `/comerciales/ranking`, `/mapa` y `/zonas/:id`, que están
// por encima, para que un `id` en la URL no se coma una de esas. Es el orden
// que menosCastiga leer.
//
// El 404 lo da la propia ficha, con su mensaje: un comercial inexistente es un
// dato que no está, no un servidor roto.
//
rutas.get('/comerciales/ficha/:id', auth, VER, ruta(async (req) => FICHA.fichaComercial(
  Number(req.params.id),
  { periodo: req.query.periodo ?? 'MES', desde: req.query.desde, hasta: req.query.hasta },
)))

// La navegación inversa: qué comerciales trabajan en una zona. De
// `com_comercial_zonas`, que admite varios —`home_zona_id` no aparece por aquí
// porque si apareciera, un comercial dejaría de verse en cuanto otro fuera el
// responsable.
rutas.get('/comerciales/zonas/:id/comerciales', auth, VER, ruta(async (req) => FICHA.comercialesDeZona(
  idDe(req),
)))

// ───────────────────────────────────────────────────────────────────────────
// ALTA DE CLIENTE CON REGIÓN → ZONA → COMERCIAL
//
// Esto es de la FASE 3 y aquí solo se DEJA DICHO, no se hace: la selección en
// cascada necesita poder GUARDAR la asignación, y rellenar `customers.zone_id`
// o `customers.commercial_id` a mano hoy sería inventar la cartera de un
// comercial real.
//
rutas.post('/comerciales/zonas/:id/objetivo', auth, OBJETIVOS, ruta(async (req) => {
  const b = cuerpoDe(req)
  const puesto = await Z.ponerObjetivoZona({
    zonaId: idDe(req),
    periodStart: b.periodStart, periodEnd: b.periodEnd,
    targetAmount: b.targetAmount ?? null,
    targetUnits: b.targetUnits ?? null,
    notas: b.notas ?? null,
    usuarioId: req.user.id,
  })
  return { __respuesta: 201, cuerpo: puesto }
}))

// ───────────────────────────────────────────────────────────────────────────
// EDICIÓN DE LA FICHA
//
// `PUT /api/comerciales/ficha/:id` y `DELETE /api/comerciales/:id/zonas/:zonaId`
//
// Se cuelgan al FINAL, debajo de la ficha, y las cuatro llevan el permiso de
// GESTIONAR, que es el de `commercial/create`. Ver por eso la ficha es de solo
// lectura para un comercial y editable para quien dirige: el permiso, no la
// pantalla, es lo que decide.
//
// Lo único editable son datos de la persona y de la organización —notas,
// idiomas, zonas—. Las ventas, las visitas, el cumplimiento y los puntos NO
// tienen ninguna ruta que los escriba. No es que se escondan: es que no hay
// por dónde escribirlos.
//
rutas.put('/comerciales/ficha/:id', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  return EDICION.editarComercial(idDe(req), {
    notas: b.notas ?? undefined,
    idiomas: Array.isArray(b.idiomas) ? b.idiomas : undefined,
    activo: typeof b.activo === 'boolean' ? b.activo : undefined,
    zonas: Array.isArray(b.zonas) ? b.zonas : undefined,
    usuarioId: req.user.id,
  })
}))

rutas.delete('/comerciales/:id/zonas/:zonaId', auth, GESTIONAR, ruta(async (req) => EDICION.quitarZona(
  idDe(req), idDe(req, 'zonaId'), req.user.id,
)))

// ═══════════════════════════════════════════════════════════════════════════
// GESTIÓN DESDE EL MAPA
//
// El flujo completo del administrador es: clic en la REGIÓN → entrar en una
// ZONA → ver quién la cubre y quién no → asignar. Estas rutas son ese flujo.
//
// Y quitar es quitar una ASIGNACIÓN, no borrar un comercial. El comercial
// sigue en el sistema con su usuario y su historial; lo que se deshace es que
// trabaje ahí.
//
rutas.get('/comerciales/zona/:id/gestion', auth, VER, ruta(async (req) => EDICION.gestionDeZona(
  idDe(req),
)))

rutas.post('/comerciales/zona/:id/asignar', auth, GESTIONAR, ruta(async (req) => {
  const b = cuerpoDe(req)
  if (!b.comercialId) {
    throw new ErrorComercial('Falta el comercial que se quiere asignar.', { codigo: 'COMERCIAL_FALTA' })
  }
  return EDICION.asignarAZona(Number(b.comercialId), idDe(req), {
    esPrincipal: b.esPrincipal === true,
    porcentaje: b.porcentaje ?? null,
    usuarioId: req.user.id,
  })
}))

rutas.delete('/comerciales/zona/:id/comerciales/:cid', auth, GESTIONAR, ruta(async (req) =>
  EDICION.quitarDeZona(idDe(req, 'cid'), idDe(req), req.user.id)))

export default rutas

// ═══════════════════════════════════════════════════════════════════════════
// RANKINGS CONFIGURABLES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El catálogo de métricas va al frontend para que el formulario ofrezca solo lo
 * que existe, con su explicación puesta. Sin esto habría que mantener dos
 * listas que algún día no coincidirían.
 */
rutas.get('/rankings/metricas', auth, VER_RANKING, ruta(async () => ({
  familias: [...new Set(Object.values(METRICAS).map((m) => m.familia))].map((f) => ({
    familia: f,
    metricas: Object.entries(METRICAS)
      .filter(([, m]) => m.familia === f && !m.alias)
      .map(([code, m]) => ({ code, nombre: m.nombre, modo: m.modo, explica: m.explica,
                              requiere: m.requiere || null, avisaSiFalta: m.avisaSiFalta || null })),
  })),
  periodos: [
    { code: 'NINGUNO', nombre: 'Desde siempre' },
    { code: 'MENSUAL', nombre: 'Cada mes' },
    { code: 'TRIMESTRAL', nombre: 'Cada trimestre' },
    { code: 'ANUAL', nombre: 'Cada año' },
  ],
})))

rutas.get('/rankings', auth, VER_RANKING, ruta(async () => listarRankings()))

rutas.get('/rankings/reglas', auth, VER_RANKING, ruta(async (req) => listarReglas(
  req.query.rankingId ? Number(req.query.rankingId) : null,
)))

/**
 * La clasificación de UNA competición. Los puntos salen de `com_puntos` —los que
 * de verdad se concedieron y están atados a un hecho— y no de un cálculo en
 * vivo: un ranking que cambia de un segundo a otro no se puede ni auditar.
 */
rutas.get('/rankings/:id/clasificacion', auth, VER_RANKING, ruta(async (req) => {
  const rankingId = Number(req.params.id)
  const r = await one('SELECT * FROM com_rankings WHERE id = $1::int', [rankingId])
  if (!r) return { status: 404, cuerpo: { error: 'Esa competición no existe.', codigo: 'NO_ENCONTRADO' } }
  const filas = await query(
    // El nombre sale de `users.full_name` Passing por `com_perfiles`, porque
    // `com_perfiles` guarda la ficha del comercial y NO su nombre: el nombre es
    // de la persona. `com_puntos` guarda el `motivo` del hecho, no el nombre, así
    // que renombrar a alguien no reescribe su histórico.
    `SELECT p.comercial_id, COALESCE(u.full_name, cp.notes, CAST(p.comercial_id AS text)) AS nombre,
            SUM(p.puntos) AS puntos,
            MIN(p.period_start) AS desde, MAX(p.period_end) AS hasta, COUNT(*)::int AS hechos
       FROM com_puntos p
       JOIN com_reglas_puntos g ON g.id = p.regla_id
       LEFT JOIN com_perfiles cp ON cp.id = p.comercial_id
       LEFT JOIN users u ON u.id = cp.user_id
      WHERE g.ranking_id = $1::int
        AND ($2::int IS NULL OR p.comercial_id = $2::int)
      GROUP BY p.comercial_id, u.full_name, cp.notes
      ORDER BY SUM(p.puntos) DESC, u.full_name`,
    [rankingId, req.query.comercialId ? Number(req.query.comercialId) : null],
  )
  return { competicion: r, clasificacion: filas.map((f, i) => ({ ...f, puesto: i + 1 })) }
}))

rutas.post('/rankings', auth, CONFIGURAR_RANKING, ruta(async (req) => {
  const r = await crearRanking(req.body || {}, req.usuario?.id ?? req.user?.id)
  return { __respuesta: 201, cuerpo: r }
}))

rutas.put('/rankings/:id', auth, CONFIGURAR_RANKING, ruta(async (req) =>
  editarRanking(Number(req.params.id), req.body || {})))

rutas.post('/rankings/reglas', auth, CONFIGURAR_RANKING, ruta(async (req) => {
  const r = await crearRegla(req.body || {}, req.usuario?.id ?? req.user?.id)
  return { __respuesta: 201, cuerpo: r }
}))

rutas.put('/rankings/reglas/:id', auth, CONFIGURAR_RANKING, ruta(async (req) =>
  editarRegla(Number(req.params.id), req.body || {})))

/**
 * PAUSAR / REACTIVAR / DESACTIVAR.
 *
 * Cada una es un estado, no un borrado. Los puntos ya concedidos se quedan
 * donde estaban porque `com_puntos` no se toca aquí, y la regla sigue
 * apareciendo en el historial con su estado. Si se pudiera «quitar una regla» de
 * verdad, el ranking dejaría de ser un registro y pasaría a ser una opinión.
 */
rutas.post('/rankings/reglas/:id/estado', auth, CONFIGURAR_RANKING, ruta(async (req) =>
  cambiarEstadoRegla(Number(req.params.id), String(req.body?.estado || '').toUpperCase())))

/** Lanzar el cálculo a mano. Es idempotente: correrlo otra vez no añade nada. */
rutas.post('/rankings/calcular', auth, CONFIGURAR_RANKING, ruta(async (req) =>
  otorgarPuntos({
    rankingId: req.body?.rankingId ? Number(req.body.rankingId) : null,
    comercialId: req.body?.comercialId ? Number(req.body.comercialId) : null,
    ancla: req.body?.ancla || null,
  })))

rutas.get('/rankings/periodo', auth, VER_RANKING, ruta(async (req) =>
  ventana(String(req.query.periodo || 'MENSUAL'), req.query.ancla || null)))

export { METRICAS }
