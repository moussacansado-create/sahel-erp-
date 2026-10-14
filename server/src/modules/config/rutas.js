/**
 * CONFIGURACIÓN GENERAL DE SAHEL.
 *
 * ── QUIÉN ENTRA ──────────────────────────────────────────────────────────────
 *
 * `settings:*`, que es de ADMIN. Y no es un detalle: este módulo cambia el
 * prefijo con el que se numeran los lotes, el ejercicio en curso y la moneda de
 * la empresa. Un usuario que no puede administrar el sistema no toca nada de
 * esto, aunque tenga permisos de almacén o de producción.
 *
 * ── POR QUÉ NO ES «UNA PANTALLA MÁS» ────────────────────────────────────────
 *
 * Cada parámetro que se expone aquí está conectado a algo real: el prefijo lo
 * usa `siguienteCodigoLote()`, el ejercicio lo lee `fn_siguiente_serie()` y la
 * moneda la toman las etiquetas y los albaranes. Un ajuste que no cambia
 * ningún comportamiento no se expone, porque sería un campo decorativo que
 * alguien acaba creyendo que funciona.
 *
 * ── TODO CAMBIO DEJA RASTRO ─────────────────────────────────────────────────
 *
 * `audit_log`, con el antes y el después, y con QUIÉN lo hizo. Cambiar un
 * prefijo no reescribe los lotes ya existentes —eso está prohibido—, pero
 * alguien tiene que poder explicar dentro de un año por qué hay lotes
 * `PT-DES-00001` y lotes `DES-2026-000001` en la misma fábrica.
 */
import { Router } from 'express'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import {
  todaLaConfig, guardar, guardarVarios, series, historialDeSeries,
  editarSerie, crearSerie, anioDeTrabajo, cambiarAnio,
} from '../../core/config.js'
import { FORMATOS, listarSeriesCompleto } from '../../core/etiquetas.js'
import {
  listarFormatos, crearFormato, editarFormato, desactivarFormato, obtenerFormato,
} from '../../core/formatos.js'

const router = Router()
// `requiereSesion` necesita el módulo de base de datos para comprobar que el
// usuario sigue existiendo y activo, no solo que el token vale.
const auth = requiereSesion({ query, one })
const ADMIN_CFG = requierePermiso('settings', 'edit')
const LEER_CFG = requierePermiso('settings', 'view')

const falla = (res, e) => res
  .status(e.codigo === 'ROL_DESCONOCIDO' || e.codigo === 'SERIE_NO_EXISTE' ? 404 : 400)
  .json({ error: e.message, codigo: e.codigo || 'CONFIG_INVALIDA' })

// ── LEER ─────────────────────────────────────────────────────────────────────

/** Todo lo que hay, agrupado como lo ve la pantalla. */
router.get('/config', auth, LEER_CFG, asincrono(async (_req, res) => {
  const [config, series_, anio] = await Promise.all([
    todaLaConfig(),
    series(),
    anioDeTrabajo(),
  ])
  res.json({
    empresa: config,
    series: series_,
    anio,
    etiquetas: listarSeriesCompleto(),
    formatos: Object.entries(FORMATOS).map(([code, f]) => ({
      code, nombre: f.nombre, ancho: f.ancho, alto: f.alto, omitidos: f.omitidos || [],
    })),
  })
}))

/** El historial de la numeración: qué se abrió cada año y hasta dónde llegó. */
router.get('/config/series/historial', auth, LEER_CFG, asincrono(async (req, res) => {
  res.json(await historialDeSeries(req.query.anio ? Number(req.query.anio) : null))
}))

// ── ESCRIBIR ─────────────────────────────────────────────────────────────────

/** Guardar un parámetro suelto. Valida el tipo antes de tocar nada. */
router.put('/config/:clave', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    const clave = req.params.clave
    if (!/^[a-z0-9_.-]{2,60}$/i.test(clave)) {
      return res.status(400).json({ error: 'La clave no es válida.', codigo: 'CLAVE_INVALIDA' })
    }
    const valor = req.body?.valor
    res.json(await guardar(clave, valor, req.user.id))
  } catch (e) { return falla(res, e) }
}))

/** Los datos de la empresa de golpe: son un formulario, no 12 peticiones. */
router.put('/config/empresa', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    const b = req.body || {}
    const cambios = {}
    for (const [k, v] of Object.entries(b)) {
      if (k.startsWith('empresa.')) cambios[k] = v
    }
    if (!Object.keys(cambios).length) {
      return res.status(400).json({ error: 'No se ha enviado ningún dato de empresa.', codigo: 'SIN_CAMBIOS' })
    }
    res.json(await guardarVarios(cambios, req.user.id))
  } catch (e) { return falla(res, e) }
}))

// ── SERIES ───────────────────────────────────────────────────────────────────

router.post('/config/series', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.status(201).json(await crearSerie(req.body || {}, req.user.id))
  } catch (e) { return falla(res, e) }
}))

/**
 * Editar una serie.
 *
 * El prefijo nuevo solo afecta a lo que se numere a partir de ahora. Los lotes
 * que ya existen conservan el suyo: renumerar unas instalaciones que ya
 * salieron de fábrica dejaría el inventario mintiendo.
 */
router.put('/config/series/:codigo', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.json(await editarSerie(req.params.codigo, req.body || {}, req.user.id))
  } catch (e) { return falla(res, e) }
}))

/**
 * Cambiar de ejercicio.
 *
 * Abrir 2027 no borra 2026 ni toca un lote. La serie nueva empieza en 000001 y
 * la vieja se queda donde estaba, con su historial consultable. Es lo que pasa
 * al cambiar de cuaderno en la fábrica, y por eso los lotes antiguos siguen
 * siendo legibles.
 */
router.put('/config/numeracion/anio', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.json(await cambiarAnio(Number(req.body?.anio), req.user.id))
  } catch (e) { return falla(res, e) }
}))

router.put('/config/numeracion', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    const b = req.body || {}
    const cambios = {}
    if (b.anio !== undefined) await cambiarAnio(Number(b.anio), req.user.id)
    if (b.reinicio_anual !== undefined) cambios['numeracion.reinicio_anual'] = !!b.reinicio_anual
    if (b.digitos_lote !== undefined) cambios['numeracion.digitos_lote'] = Number(b.digitos_lote)
    if (b.formato !== undefined) cambios['numeracion.formato'] = String(b.formato)
    if (!Object.keys(cambios).length) {
      return res.status(400).json({ error: 'No se ha enviado ningún cambio.', codigo: 'SIN_CAMBIOS' })
    }
    res.json(await guardarVarios(cambios, req.user.id))
  } catch (e) { return falla(res, e) }
}))

export default router


// ─── Respaldo ───────────────────────────────────────────────────────────────
//
// El volcado lo hace el PROPIO SERVIDOR, y no un script aparte, por un motivo
// que ya costó una base: PGlite es un PostgreSQL dentro del proceso Node, y
// solo admite UNA instancia por directorio. Un script de respaldo abriendo
// `.pgdata` mientras el servidor la tiene abierta provoca un `Aborted()` del
// WASM y deja la base marcada como corrupta. O sea: el script de copia
// acababa rompiendo lo que quería proteger.
//
// Leyendo desde aquí no hay dos instancias, no hay parada, y el volcado sale
// de una base que está en uso sin inconsistencias.
//
// Solo para ADMIN. Un volcado contiene la base entera: contraseñas, teléfonos
// y todo lo demás.
router.get('/backup/volcado', auth, requierePermiso('settings', 'edit'), asincrono(async (_req, res) => {
  const tablas = (await query(
    "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
  )).map((x) => x.table_name).filter((t) => t !== 'schema_migrations')

  // Las columnas JSON/JSONB se leen como TEXTO, no como valor.
  //
  // PGlite devuelve un jsonb ya deserializado: `{"nombre":"SAHEL"}` llega a
  // JavaScript como un objeto y «SAHEL», si el valor es una cadena suelta. Al
  // insertar eso de vuelta, PostgreSQL dice «invalid input syntax for type
  // json: Token "SAHEL" is invalid»: la cadena suelta no es un JSON.
  //
  // Leyéndolas como texto, el volcado guarda el JSON literal y al restaurar
  // vuelve a ser JSON literal. Es la misma información, y esta vez viajable.
  const tipos = (await query(
    `select table_name, column_name from information_schema.columns
     where table_schema='public' and data_type in ('json','jsonb')`,
  ))

  const copia = {}
  let filas = 0
  for (const t of tablas) {
    const suyas = new Set(tipos.filter((x) => x.table_name === t).map((x) => x.column_name))
    const suyasHere = tipos.filter((x) => x.table_name === t)
    const cols = suyasHere.length
      ? await query(
        `select column_name from information_schema.columns
         where table_schema='public' and table_name = $1 order by ordinal_position`, [t],
      )
      : []
    const lista = (cols.length ? cols : await query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name = $1 order by ordinal_position`, [t],
    )).map((c) => c.column_name)
    const seleccion = lista.length
      ? lista.map((c) => (suyas.has(c) ? `"${c}"::text as "${c}"` : `"${c}"`)).join(', ')
      : '*'
    const r = await query(`select ${seleccion} from "${t}"`)
    copia[t] = r
    filas += r.length
  }
  res.json({ version: 1, generado: new Date().toISOString(), filas, tablas: copia })
}))

// ── FORMATOS DE VENTA (CAJAS) ───────────────────────────────────────────────
//
// Van en Ajustes y no en el catálogo porque un formato no es un artículo: no
// se fabrica, no entra por almacén y no se descuenta. Es la forma de vender
// N botellas por un precio, y su precio lo manda quien lleva la tienda, no la
// ficha del producto.
//
// Escribir es de ADMIN (`settings:edit`, el mismo candado que el resto de
// Ajustes). LEER es más abierto, porque el comercial tiene que poder ver qué
// cajas existen al montar un pedido —si no, literalmente no puede vender—.

router.get('/config/formatos', auth, requierePermiso('settings', 'view'), asincrono(async (req, res) => {
  try {
    res.json(await listarFormatos({
      itemId: req.query.item_id ? Number(req.query.item_id) : null,
      incluirInactivos: req.query.incluir_inactivos === '1',
    }))
  } catch (e) { return falla(res, e) }
}))

router.get('/config/formatos/:id', auth, requierePermiso('settings', 'view'), asincrono(async (req, res) => {
  try {
    res.json(await obtenerFormato(Number(req.params.id)))
  } catch (e) { return falla(res, e) }
}))

router.post('/config/formatos', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.status(201).json(await crearFormato(req.body || {}, req.user.id))
  } catch (e) { return falla(res, e) }
}))

/**
 * Editar un formato.
 *
 * Cambiar el precio NO toca los pedidos ya emitidos: cada línea se guardó una
 * copia del nombre, las unidades y el precio el día que se pidió. Los
 * albaranes antiguos siguen imprimiendo los suyos.
 */
router.put('/config/formatos/:id', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.json(await editarFormato(Number(req.params.id), req.body || {}, req.user.id))
  } catch (e) { return falla(res, e) }
}))

/** Desactivar, nunca borrar: el formato puede estar en pedidos ya emitidos. */
router.delete('/config/formatos/:id', auth, ADMIN_CFG, asincrono(async (req, res) => {
  try {
    res.json(await desactivarFormato(Number(req.params.id), req.user.id))
  } catch (e) { return falla(res, e) }
}))
