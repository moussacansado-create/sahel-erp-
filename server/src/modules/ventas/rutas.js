/**
 * API de clientes, pedidos y entregas.
 *
 * Las tres están en el mismo módulo a propósito: un cliente sin pedidos y un
 * pedido sin cliente son media aplicación, y el reparto necesita las tres
 * cosas en la misma pantalla. Los ficheros de lógica sí están separados:
 * `core/clientes.js`, `core/pedidos.js`, `core/entregas.js`.
 */

import { Router } from 'express'
import { idempotente } from '../../http/idempotencia.js'
import { asincrono } from '../../http/middlewares.js'
import { requiereSesion, requierePermiso, requiereAlguno } from '../../security/permisos.js'
import { query, one, exec } from '../../db/client.js'
import { transaction } from '../../db/client.js'
import {
  crearCliente, actualizarCliente, obtenerCliente, listarClientes,
  archivarCliente, reactivarCliente,
  regenerarTokenQr, resolverQr,
} from '../../core/clientes.js'
import { empresa as leerEmpresa } from '../../core/config.js'
import { datosTarjeta, imagenQr } from '../../core/tarjeta.js'
import {
  crearPedido, obtenerPedido, listarPedidos, confirmarPedido,
  simularConfirmacion, anularPedido, prepararPedido,
} from '../../core/pedidos.js'
import { registrarEntrega, planEntrega, listarEntregas } from '../../core/entregas.js'
import {
  listarReparto, resumenReparto, anotarNoEntregado,
} from '../../core/reparto.js'
import { confirmarDesdeTarjeta } from '../../core/entregas.js'
import { cobrar, listarMetodos } from '../../core/cobros.js'
import {
  quienLlevaDinero, abrirTraspaso, recibirDinero, listarTraspasos, saldoDe,
} from '../../core/caja.js'
import {
  abrirCaja, cajaAbierta, estado as estadoCaja, registrarMovimiento, movimientos,
  arquearYCerrar, listarSesiones, consultaPeriodo, retiradasDe, registrarRetirada,
} from '../../core/caja-sesion.js'

const router = Router()
const db = { query, one, exec }
const auth = requiereSesion({ query, one })

const verClientes = requierePermiso('customers', 'view')
const editarClientes = requierePermiso('customers', 'edit')
const verPedidos = requierePermiso('sales', 'view')
const crearPedidos = requierePermiso('sales', 'create')
// La matriz de permisos tiene approve / create / delete / edit / export / view.
// No se añaden acciones nuevas para esta fase: confirmar y preparar usan
// `edit` (gestionar un pedido) y anular usa `approve`, que es un escalón más
// alto porque rompe un compromiso con el cliente.
const gestionarPedidos = requierePermiso('sales', 'edit')
const anularPedidos = requierePermiso('sales', 'approve')
const verEntregas = requiereAlguno(['deliveries', 'sales'], 'view', 'ver entregas')
const hacerEntregas = requierePermiso('deliveries', 'create')

// ═══ Clientes ═══════════════════════════════════════════════════════════════

router.get('/customers', auth, verClientes, asincrono(async (req, res) => {
  res.json(await listarClientes({
    buscar: req.query.buscar || '',
    // `todos=1` sale a Mixing clientes vivos y archivados; `archivados=1`
    // sale solo a los archivados. Por defecto, solo vivos: el listado del día
    // a día no tiene por qué enseñar a quien ya no se le vende.
    soloActivos: req.query.archivados !== '1',
    soloArchivados: req.query.archivados === '1',
    limite: Number(req.query.limite) || 100,
      usuario: req.user,
  }))
}))

router.get('/customers/:id', auth, verClientes, asincrono(async (req, res) => {
  res.json(await obtenerCliente(Number(req.params.id), req.user))
}))

router.post('/customers', auth, idempotente('alta-cliente'), editarClientes, asincrono(async (req, res) => {
  res.status(201).json(await crearCliente(req.body || {}, req.user.id))
}))

router.put('/customers/:id', auth, editarClientes, asincrono(async (req, res) => {
  res.json(await actualizarCliente(Number(req.params.id), req.body || {}, req.user.id))
}))

// ── Archivo y recuperación de clientes ───────────────────────────────────────
// Archivar NO borra. El cliente sigue existiendo, con sus pedidos y sus
// movimientos; lo que deja de poder hacer es recibir pedidos nuevos, y eso lo
// impide la BASE, no esta ruta.
router.post('/customers/:id/archivar', auth, editarClientes, asincrono(async (req, res) => {
  res.json(await archivarCliente(
    Number(req.params.id), req.user.id, (req.body || {}).motivo || '',
  ))
}))

router.post('/customers/:id/reactivar', auth, editarClientes, asincrono(async (req, res) => {
  res.json(await reactivarCliente(Number(req.params.id), req.user.id))
}))

/** Rota el QR. La tarjeta perdida deja de servir en el mismo instante. */
router.post('/customers/:id/qr/regenerar', auth, editarClientes, asincrono(async (req, res) => {
  res.json(await regenerarTokenQr(Number(req.params.id), req.user.id))
}))

/**
 * GET /api/customers/:id/tarjeta
 * Lo que se imprime en el plástico: nombre, código y token, con los datos de la
 * empresa. Se arma en el servidor para que la tarjeta y la pantalla no puedan
 * contradecirse.
 */
router.get('/customers/:id/tarjeta', auth, verClientes, asincrono(async (req, res) => {
  const id = Number(req.params.id)
  const cliente = await db.one(
    `SELECT id, code, name, company_name, qr_token FROM customers WHERE id = $1`, [id])
  if (!cliente) return res.status(404).json({ error: 'El cliente no existe' })
  res.json(datosTarjeta({ cliente, empresa: await leerEmpresa(db) }))
}))

/**
 * GET /api/customers/:id/qr.png
 * El cuadradito de la tarjeta, en PNG.
 *
 * Es una RUTA FIJA aunque parezca que debería ir después de `/customers/:id`:
 * Express distingue por número de segmentos, así que `qr.png` no se come el
 * `id` de `/customers/7`. Aun así se declara junto a su hermana, no al final,
 * para que la siguiente persona no tenga que averiguarlo.
 */
router.get('/customers/:id/qr.png', auth, verClientes, asincrono(async (req, res) => {
  const cliente = await db.one('SELECT id, qr_token FROM customers WHERE id = $1',
    [Number(req.params.id)])
  if (!cliente) return res.status(404).json({ error: 'El cliente no existe' })
  const png = await imagenQr(cliente.qr_token, { tamano: 320 })
  res.type('image/png')
  // El QR es del cliente, no un dato del servidor: se cachea un rato para no
  // regenerar la imagen en cada previsualización, pero nunca para siempre.
  res.set('Cache-Control', 'private, max-age=300')
  res.send(png)
}))

/**
 * Resolver un QR escaneado.
 *
 * Se deja accesible a quien va a repartir aunque no tenga permiso de clientes:
 * en la calle no se le va a pedir al repartidor que abra la ficha completa con
 * el límite de crédito del cliente delante de él.
 */
router.get('/qr/:token', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await resolverQr(req.params.token))
}))

// ═══ Pedidos ════════════════════════════════════════════════════════════════

router.get('/orders', auth, verPedidos, asincrono(async (req, res) => {
  res.json(await listarPedidos({
    status: req.query.estado || null,
    customerId: req.query.cliente ? Number(req.query.cliente) : null,
    buscar: req.query.buscar || '',
    limite: Number(req.query.limite) || 100,
    vivas: req.query.vivas === '1',
  }))
}))

router.get('/orders/:id', auth, verPedidos, asincrono(async (req, res) => {
  res.json(await obtenerPedido(Number(req.params.id)))
}))

router.post('/orders', auth, idempotente('pedido'), crearPedidos, asincrono(async (req, res) => {
  const { customerId, lineas, notas, promisedDate, commercialId } = req.body || {}
  res.status(201).json(await crearPedido({
    customerId, lineas, notas, promisedDate, commercialId, userId: req.user.id,
  }))
}))

/** Simula qué se apartaría. No escribe nada. */
router.get('/orders/:id/plan', auth, verPedidos, asincrono(async (req, res) => {
  res.json(await simularConfirmacion(Number(req.params.id)))
}))

/** CONFIRMAR: aparta stock. NO lo descuenta. */
router.post('/orders/:id/confirmar', auth, gestionarPedidos, asincrono(async (req, res) => {
  res.json(await confirmarPedido(Number(req.params.id), req.user.id))
}))

router.post('/orders/:id/preparar', auth, gestionarPedidos, asincrono(async (req, res) => {
  res.json(await prepararPedido(Number(req.params.id), req.user.id))
}))

/** ANULAR: libera lo apartado. No devuelve stock porque nunca se movió. */
router.post('/orders/:id/anular', auth, anularPedidos, asincrono(async (req, res) => {
  res.json(await anularPedido(Number(req.params.id), req.body?.motivo, req.user.id))
}))

// ═══ Entregas ═══════════════════════════════════════════════════════════════

router.get('/deliveries', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await listarEntregas({
    orderId: req.query.pedido ? Number(req.query.pedido) : null,
    limite: Number(req.query.limite) || 100,
    vivas: req.query.vivas === '1',
  }))
}))

/** Qué se puede servir ahora. No descuenta nada. */
router.get('/deliveries/plan/:orderId', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await planEntrega(Number(req.params.orderId)))
}))

  /**
   * POST /api/deliveries
   *
   * CERRADO. Toda entrega pasa por su albarán firmado:
   *
   *     POST /api/albaranes/:id/entregar
   *
   * Este endpoint cerraba el PEDIDO y se dejaba el ALBARÁN en «por entregar»,
   * para siempre. Consecuencia real: un pedido podía estar ENTREGADO mientras
   * su albarán seguía en la lista de pendientes, que es la primera pantalla
   * donde se mira. Dos verdades sobre la misma entrega.
   *
   * Además, la firma que llegaba por aquí era un PNG FABRICADO en el
   * navegador a partir del id del pedido y la hora. Es decir: la evidencia de
   * que el cliente recibió la mercancía —la garantía que sostiene todo el
   * diseño— era un sello generado por la propia aplicación.
   *
   * Se responde 409 explicando por dónde va. Quitar la ruta de golpe dejaría
   * clientes viejos colgados con un 404 sin explicación.
   */
  router.post('/deliveries', auth, hacerEntregas, asincrono(async (req, res) => {
    const orderId = Number(req.body?.orderId)
    const pedido = orderId
      ? await db.one('SELECT code, status FROM sales_orders WHERE id = $1', [orderId])
      : null
    res.status(409).json({
      error: pedido
        ? `Las entregas se cierran por el albarán firmado, no directamente sobre el `
          + `pedido ${pedido.code}. Abre o crea el albarán de ese pedido: es lo que `
          + 'sabe qué lleva el cliente y lo que guarda su firma.'
        : 'Las entregas se cierran por el albarán firmado. Crea el albarán del pedido e imprímelo.',
      codigo: 'ENTREGAR_POR_ALBARAN',
    })
  }))


// ═══ Reparto ═══════════════════════════════════════════════════════════════

/**
 * GET /api/reparto
 * La hoja de ruta. `?mias=1` limita a las del repartidor que pregunta, que es
 * como lo abre el repartidor en el móvil.
 */
router.get('/reparto', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await listarReparto({
    soloPendientes: req.query.todas !== '1',
    zona: req.query.zona ? Number(req.query.zona) : null,
  }, db))
}))

router.get('/reparto/resumen', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await resumenReparto({ soloPendientes: req.query.todas !== '1' }, db))
}))

/**
 * POST /api/reparto/pedido/:id/entregar
 *
 * LA ENTREGA. El único camino, y es el de la TARJETA.
 *
 * El repartidor escanea la tarjeta del cliente, ve los pedidos que tiene
 * pendientes, elige uno y pulsa «Entregar». Aquí se descuenta el stock, el
 * pedido pasa a ENTREGADO y queda escrito quién lo hizo y cuándo.
 *
 * El albarán no hace falta: es el papel que se llevó y que el cliente firmó.
 * Si se imprimió, queda como referencia de ese viaje.
 */
router.post('/reparto/pedido/:id/entregar', auth, idempotente('entrega'), hacerEntregas, asincrono(async (req, res) => {
  const cuerpo = req.body || {}
  res.status(201).json(await confirmarDesdeTarjeta({
    orderId: Number(req.params.id),
    clienteId: cuerpo.clienteId ? Number(cuerpo.clienteId) : null,
    userId: req.user.id,
    recibe: cuerpo.recibe || null,
    lineas: Array.isArray(cuerpo.lineas) && cuerpo.lineas.length ? cuerpo.lineas : null,
  }))
}))


/**
 * POST /api/reparto/pedido/:id/no-entregado — anota el motivo SIN cambiar el estado.
 *
 * El `:id` es un PEDIDO, no un albarán. Antes lo era, y quedaba enredado: la
 * hoja de ruta se armaba sobre albaranes, así que no se podía anotar una visita
 * fallida si no se había impreso. La nota va de la parada, que es donde pasó
 * la cosa.
 *
 * Se conserva `POST /api/reparto/:id/no-entregado` por compatibilidad, y hace
 * lo mismo: busca el albarán, su pedido, y anota ahí. Los clientes antiguos
 * siguen funcionando; los nuevos usan la ruta con el nombre del recurso.
 */
router.post('/reparto/pedido/:id/no-entregado', auth, hacerEntregas, asincrono(async (req, res) => {
  res.json(await anotarNoEntregado(Number(req.params.id), {
    motivo: req.body?.motivo, usuarioId: req.user.id,
  }, db))
}))

// Ruta antigua. Se resuelve el albarán y se anota en SU pedido.
router.post('/reparto/:id/no-entregado', auth, hacerEntregas, asincrono(async (req, res) => {
  const a = await db.one('SELECT sales_order_id FROM albaranes WHERE id = $1',
    [Number(req.params.id)])
  if (!a) {
    return res.status(404).json({
      error: 'Ese albarán no existe. La nota de una visita va en el PEDIDO: '
        + 'usa /api/reparto/pedido/:id/no-entregado.',
      codigo: 'ALBARAN_NO_ENCONTRADO',
    })
  }
  res.json(await anotarNoEntregado(a.sales_order_id, {
    motivo: req.body?.motivo, usuarioId: req.user.id,
  }, db))
}))

// ═══════════════════════════════════════════════════════════════════════════
// CAJA
// ═══════════════════════════════════════════════════════════════════════════
//
// Ver quién lleva qué se puede con un permiso normal. COBRAR no: un
// repartidor puede ver lo que lleva porque es su dinero, pero la caja es un rol
// aparte, y mezcla esas dos cosas convierte la conciliación en un trámite.

//
// El permiso es `cash`, NO `deliveries`.
//
// Con `deliveries` la puerta era abierta: el repartidor cobra en la puerta, y
// por lo tanto podía abrir el traspaso de su propio dinero y declararlo
// entregado. La conciliación de un mismo con él mismo siempre cuadra, y aquí
// no estamos hablando de un trámite: estamos hablando de que nadie comprueba
// nada.
//
// Con `cash` el reparto cobra y entrega, y quien ENTREGA el dinero es otro.
//
const verCaja = requierePermiso('cash', 'view')
const cobrarCaja = requierePermiso('cash', 'create')

  // ══════════════════════════════════════════════════════════════════════
  // CAJA: LA SESIÓN DEL DÍA
  //
  // Arriba están los TRASPASOS: el repartidor vuelve con el dinero. Aquí está
  // la CAJA: el día, con su fondo, sus movimientos y su arqueo.
  //
  // No es lo mismo y no se mezclan. Un traspaso dice «este dinero viene de
  // aquí»; una caja dice «aquí había esto al empezar el día, ha entrado esto y
  // ha salido esto, y al final he contado esto». Sin la segunda, el arqueo no
  // tiene contra qué compararse.
  // ══════════════════════════════════════════════════════════════════════

  // ── La caja que tengo abierta ahora ────────────
  router.get('/caja/sesion/actual', auth, verCaja, asincrono(async (req, res) => {
    const moneda = req.query.moneda || 'XOF'
    const abierta = await cajaAbierta(req.user.id, moneda)
    if (!abierta) return res.json({ abierta: null })
    res.json({ abierta: true, ...await estadoCaja(abierta.id) })
  }))

  // ── Abrir ──────────────────────────
  //
  // El fondo es lo que se CUENTA al abrir. El sistema no lo deduce: una caja
  // que empieza en 20.000 porque el sistema lo dice y en la realidad había
  // 18.500 no tiene arreglo, y el arqueo del día siguiente arrastra el error.
  router.post('/caja/sesion', auth, cobrarCaja, asincrono(async (req, res) => {
    const b = req.body || {}
    try {
      const caja = await abrirCaja({
        usuarioId: req.user.id,
        moneda: b.moneda || 'XOF',
        fondoContado: b.fondoContado ?? b.fondo ?? 0,
        notas: b.notas ?? null,
      })
      res.status(201).json({ ...await estadoCaja(caja.id) })
    } catch (e) {
      res.status(e.estado || 400).json({ error: e.message, codigo: e.codigo })
    }
  }))

  // ── Meter y sacar dinero ────────────
  //
  // El importe va en positivo y el `kind` dice de qué lado. La caja cerrada y
  // el borrado del histórico los frena la base, no esta ruta.
  router.post('/caja/sesion/:id/movimientos', auth, idempotente('movimiento-caja'), cobrarCaja, asincrono(async (req, res) => {
    const b = req.body || {}
    try {
      const mov = await registrarMovimiento({
        sessionId: Number(req.params.id),
        kind: b.kind,
        concepto: b.concepto,
        importe: b.importe,
        usuarioId: req.user.id,
        ref: (b.refTipo || b.ref_tipo) ? { tipo: b.refTipo || b.ref_tipo, id: b.refId ?? b.ref_id } : null,
        notas: b.notas ?? null,
      })
      res.status(201).json({ movimiento: mov, ...await estadoCaja(Number(req.params.id)) })
    } catch (e) {
      res.status(e.estado || 400).json({ error: e.message, codigo: e.codigo })
    }
  }))

  // ── Los movimientos de una caja ────────────
  router.get('/caja/sesion/:id/movimientos', auth, verCaja, asincrono(async (req, res) => {
    res.json(await movimientos(Number(req.params.id), { limite: Number(req.query.limite) || 200 }))
  }))

  // ── El estado: esperado, contado y diferencia ────────────
  router.get('/caja/sesion/:id', auth, verCaja, asincrono(async (req, res) => {
    try {
      const e = await estadoCaja(Number(req.params.id))
      res.json({ ...e, movimientos: await movimientos(Number(req.params.id)) })
    } catch (x) {
      res.status(x.estado || 400).json({ error: x.message, codigo: x.codigo })
    }
  }))

  // ── Arquear y cerrar ────────────
  //
  // El descuadre NO bloquea. Se registra y se anota. Bloquear dejaría a
  // alguien con el dinero contado y sin poder cerrar el día.
  router.post('/caja/sesion/:id/cerrar', auth, cobrarCaja, asincrono(async (req, res) => {
    const b = req.body || {}
    try {
      const r = await arquearYCerrar({
        sessionId: Number(req.params.id),
        contado: b.contado,
        usuarioId: req.user.id,
        notas: b.notas ?? null,
      })
      res.json({ ...await estadoCaja(Number(req.params.id)), arqueo: r })
    } catch (e) {
      res.status(e.estado || 400).json({ error: e.message, codigo: e.codigo })
    }
  }))

  // ── Las sesiones, y el periodo ────────────
  router.get('/caja/sesiones', auth, verCaja, asincrono(async (req, res) => {
    res.json(await listarSesiones({
      usuarioId: req.query.mias === '1' ? req.user.id : null,
      estado: req.query.estado || null,
      limite: Number(req.query.limite) || 50,
    }))
  }))

  // Día, semana o mes. Con `desde`/`hasta` se acota a esos días, no a los que
  // se hayan abierto: mirar un mes es mirar las sesiones ESE mes.
  router.get('/caja/periodo', auth, verCaja, asincrono(async (req, res) => {
    res.json(await consultaPeriodo({
      preset: req.query.periodo || 'MES',
      desde: req.query.desde || null,
      hasta: req.query.hasta || null,
      usuarioId: req.query.mias === '1' ? req.user.id : null,
    }))
  }))


// ── Quién lleva dinero, y cuánto ────────────────────────────────────────────
/**
 * GET /api/caja/sesion/:id/retiradas
 *
 * El dinero de una jornada cerrada y a dónde fue. Vive APARTE de los movimientos
 * a propósito: la retirada no es una salida, es un cambio de manos. Si se
 * mezclara, el resultado del día bajaría a cero.
 */
router.get('/caja/sesion/:id/retiradas', auth, verCaja, asincrono(async (req, res) => {
  res.json(await retiradasDe(Number(req.params.id)))
}))

/**
 * POST /api/caja/sesion/:id/retiradas
 *
 * Registrar que el dinero de una caja cerrada se ha entregado a alguien.
 * Solo con la caja cerrada, y nunca por encima de lo contado: las dos reglas
 * las vuelve a comprobar el disparador de la base, no solo este código.
 */
router.post('/caja/sesion/:id/retiradas', auth, idempotente('retirada-caja'), cobrarCaja, asincrono(async (req, res) => {
  const b = req.body || {}
  try {
    const r = await registrarRetirada({
      sessionId: Number(req.params.id),
      importe: b.importe,
      destino: b.destino,
      destinatario: b.destinatario ?? null,
      notas: b.notas ?? null,
      usuarioId: req.user.id,
    })
    res.status(201).json(r)
  } catch (e) {
    res.status(e.estado || 400).json({ error: e.message, codigo: e.codigo })
  }
}))

router.get('/caja/pendientes', auth, verCaja, asincrono(async (req, res) => {
  const moneda = req.query.moneda || 'XOF'
  const lista = await quienLlevaDinero(moneda)
  res.json(lista)
}))

// ── Abrir un traspaso ───────────────────────────────────────────────────────
//
// El cuerpo es { repartidorId, nota? }. NO lleva importe: lo que lleva se
// cuenta, y no se escribe. Y el receptor es SIEMPRE quien está haciendo la
// petición, no un campo del cuerpo: si la caja pudiera elegir a quién le
// entrega su propio dinero, el nombre del receptor no significaría nada.
router.post('/caja/traspasos', auth, cobrarCaja, asincrono(async (req, res) => {
  const cuerpo = req.body || {}
  for (const campo of ['expected_amount', 'expectedAmount', 'en_su_poder', 'saldo']) {
    if (Object.prototype.hasOwnProperty.call(cuerpo, campo)) {
      return res.status(400).json({
        error: `El endpoint no acepta «${campo}». Lo que lleva el repartidor lo `
          + 'cuenta la base; no se puede mandar.',
        codigo: 'IMPORTE_NO_ADMISIBLE',
      })
    }
  }
  try {
    res.status(201).json(await abrirTraspaso({
      handedBy: Number(cuerpo.repartidorId),
      receivedBy: req.user.id,
      moneda: cuerpo.moneda || 'XOF',
      nota: cuerpo.nota || null,
      usuarioId: req.user.id,
    }))
  } catch (e) {
    const cod = e.codigo === 'CAJA_NO_SI_MISMO' ? 409
      : e.codigo === 'SIN_DINERO_QUE_ENTREGAR' ? 409 : 400
    res.status(cod).json({ error: e.message, codigo: e.codigo })
  }
}))

// ── Recibir ─────────────────────────────────────────────────────────────────
//
// AQUÍ sí va una cifra: la que la caja ha contado. Es un hecho. Lo que NO
// puede ir es el importe esperado, y los cobros que lo respaldan los elige el
// backend si quien llama no los dice.
router.post('/caja/traspasos/:id/recibir', auth, cobrarCaja, asincrono(async (req, res) => {
  const cuerpo = req.body || {}
  for (const campo of ['expected_amount', 'expectedAmount', 'en_su_poder', 'saldo']) {
    if (Object.prototype.hasOwnProperty.call(cuerpo, campo)) {
      return res.status(400).json({
        error: `El endpoint no acepta «${campo}»: el importe esperado lo cuenta la base.`,
        codigo: 'IMPORTE_NO_ADMISIBLE',
      })
    }
  }
  try {
    const r = await recibirDinero({
      traspasoId: Number(req.params.id),
      recibido: cuerpo.recibido,
      nota: cuerpo.nota || null,
      pagos: Array.isArray(cuerpo.pagos) ? cuerpo.pagos.map(Number) : null,
      usuarioId: req.user.id,
    })
    res.json(r)
  } catch (e) {
    const cod = ['TRASPASO_YA_RECIBIDO', 'DISCREPANCY_SIN_EXPLICACION',
      'SIN_DINERO_QUE_ENTREGAR'].includes(e.codigo) ? 409 : 400
    res.status(cod).json({ error: e.message, codigo: e.codigo })
  }
}))

// ── El historial, y el saldo que queda ──────────────────────────────────────
router.get('/caja/traspasos', auth, verCaja, asincrono(async (req, res) => {
  res.json(await listarTraspasos({
    usuarioId: req.query.repartidor ? Number(req.query.repartidor) : null,
    moneda: req.query.moneda || null,
  }))
}))

//
// El saldo de uno mismo también es asunto suyo.
//
// Un repartidor tiene que poder mirar el dinero que lleva encima: no es una
// curiosidad, es para saber qué le falta por entregar. Pero NO puede mirar el
// de los demás, y por eso esta ruta tiene dos puertas y no una: la de la caja,
// que lo ve todo, y la de que sea uno mismo.
//
// La comparación es `req.user.id === id` y no «tiene el permiso»: el permiso se
// comprueba antes, en el middleware, y aquí lo que se decide es si ESTE
// usuario puede ver ESTE saldo.
//
router.get('/caja/repartidor/:id/saldo', auth, asincrono(async (req, res) => {
  const id = Number(req.params.id)
  const propio = Number(req.user.id) === id
  if (!propio) {
    const { one: uno, query: q } = db
    const puede = await uno(
      `SELECT 1 AS ok FROM role_permissions rp
         JOIN user_roles ur ON ur.role_id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1 AND p.module = 'cash' AND p.action = 'view' LIMIT 1`,
      [req.user.id])
    if (!puede) {
      return res.status(403).json({
        error: 'Solo se puede mirar el saldo propio, o todos si se es de caja.',
        codigo: 'SALDO_AJENO',
      })
    }
  }
  res.json(await saldoDe(id, req.query.moneda || 'XOF'))
}))


// ═══════════════════════════════════════════════════════════════════════════
// COBRO
// ═══════════════════════════════════════════════════════════════════════════
//
// Un cobro, y una sola pregunta: ¿de qué pedido? El importe no se pregunta,
// porque no lo decide quien pregunta. Sale del pedido, por la misma función que
// enseña la cifra en la tarjeta del repartidor.
//
// El cuerpo que se acepta es, literalmente:
//
//     { pedidoId, metodo, referencia?, deliveryId? }
//
// No hay `amount`, ni `importe`, ni `precio`. Y no es que se ignoren: el
// núcleo los RECHAZA con un error propio, para que un cliente que los mande
// se entere en el momento en vez de seis meses después, cuando le cuadre mal
// una caja.

router.get('/payments/metodos', auth, verEntregas, asincrono(async (req, res) => {
  res.json(await listarMetodos())
}))

router.post('/payments', auth, idempotente('cobro'), hacerEntregas, asincrono(async (req, res) => {
  const cuerpo = req.body || {}
  try {
    const r = await cobrar({
      pedidoId: Number(cuerpo.pedidoId),
      metodo: cuerpo.metodo,
      referencia: cuerpo.referencia,
      deliveryId: cuerpo.deliveryId ? Number(cuerpo.deliveryId) : null,
      // TODO lo que venga de más se pasa tal cual. El núcleo lo mira pieza a
      // pieza y, si encuentra un importe, para. Así que no hace falta listar aquí
      // los campos prohibidos: queaea con crecer.
      extra: cuerpo,
      usuarioId: req.user.id,
    })
    res.status(201).json(r)
  } catch (e) {
    if (e.codigo === 'IMPORTE_NO_ADMISIBLE') {
      return res.status(400).json({ error: e.message, codigo: e.codigo })
    }
    if (e.codigo === 'PEDIDO_YA_PAGADO') {
      return res.status(409).json({
        error: e.message, codigo: e.codigo, pedidoId: e.pedidoId,
      })
    }
    res.status(400).json({ error: e.message })
  }
}))

export default router
