import crypto from 'node:crypto'
import { transaction, one } from '../db/client.js'
import { filtroDeAmbito } from '../security/permisos.js'
import { siguienteCodigoCliente } from './codigos.js'
import { auditar } from './auditoria.js'

/**
 * Clientes.
 *
 * El QR es un token opaco y revocable, no el identificador del cliente. En la
 * tarjeta va grabado `CS-<token>`; con eso el repartidor abre la ficha y ya
 * está. El código interno, el nombre, el teléfono y la dirección NO viajan en
 * el QR: una tarjeta de cliente se pierde, y lo que lleva encima tiene que
 * poder revocarse sin dar de alta a nadie.
 */

const CAMPOS = [
  'name', 'company_name', 'phone', 'email', 'address', 'zone_id',
  'payment_terms_days', 'credit_limit', 'comercial_id', 'notes',
]

/** 192 bits de entropía, en base64url. No es adivinable ni secuencial. */
function nuevoTokenQr() {
  return crypto.randomBytes(24).toString('base64url')
}

function limpiar(d) {
  const o = {}
  for (const k of CAMPOS) if (d[k] !== undefined) o[k] = d[k]
  if (o.name !== undefined) o.name = String(o.name).trim()
  if (o.email !== undefined) o.email = o.email ? String(o.email).trim().toLowerCase() : null
  return o
}

/**
 * Qué comercial y qué zona puede poner en un cliente.
 *
 * ── POR QUÉ ESTO ESTÁ AQUÍ Y NO EN LA PANTALLA ──────────────────────────────
 *
 * Porque `zone_id` y `comercial_id` venían del cuerpo de la petición tal cual.
 * Eso no es un detalle: es un `POST /api/customers` con `comercial_id: 3` y ya
 * está — el comercial se queda el cliente de otro sin tocar la interfaz. Ocultar
 * el campo en el formulario no lo cierra; solo deja de hacerlo visible.
 *
 * Y tampoco vale comprobarlo en el formulario: basta con abrir las herramientas
 * de desarrollo, o con llamar a la API desde el móvil. Lo que cierra de verdad
 * es que la base no acepte un comercial que no eres.
 *
 * Quien administra NO se ve afectado: sigue pudiendo asignar a quien quiera y
 * elegir cualquier zona. Lo que se corrige es el caso de siempre, el de un
 * comercial allocating a un cliente a otro comercial.
 */
/**
 * Un fallo de negocio con su código HTTP.
 *
 * Sin esto, un `throw new Error(...)` sale como 500 «error interno» y quien lo
 * ve piensa que se ha roto el servidor. No se ha roto: alguien ha intentado
 * algo que no le toca, y eso es un 403 con un mensaje que dice qué hacer.
 */
function no(mensaje, codigo, estado = 400) {
  const e = new Error(mensaje)
  e.codigo = codigo
  e.estado = estado
  return e
}

async function limitarCartera(d, usuarioId) {
  const quien = await one(
    `SELECT p.id AS perfil_id, r.code AS rol
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN com_perfiles p ON p.user_id = u.id
      WHERE u.id = $1 AND r.code = 'COMMERCIAL'`,
    [usuarioId],
  )
  // Sin perfil comercial, o con un rol de gestión, no hay nada que limitar.
  if (!quien || !quien.perfil_id) return d
  const gestiona = await one(
    `SELECT 1 AS ok FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.code IN ('ADMIN', 'JEFE_COMERCIAL')`,
    [usuarioId],
  )
  if (gestiona) return d

  // El comercial es el del cliente. Venga lo que venga en el cuerpo.
  d.comercial_id = quien.perfil_id

  const zona = d.zone_id
  if (zona === null || zona === undefined) {
    throw no('Elige una zona para el cliente. Sin zona no se puede ordenar '
      + 'ni contar la cartera.', 'ZONA_OBLIGATORIA', 400)
  }
  const permitida = await one(
    'SELECT 1 AS ok FROM com_comercial_zonas WHERE comercial_id = $1 AND zona_id = $2 AND hasta IS NULL',
    [quien.perfil_id, zona],
  )
  if (!permitida) {
    throw no('Esa zona no es tuya. Solo puedes crear clientes en las zonas '
      + 'que tienes asignadas.', 'ZONA_NO_AUTORIZADA', 403)
  }
  return d
}

export async function crearCliente(datos, usuarioId) {
  const d = await limitarCartera(limpiar(datos), usuarioId)
  if (!d.name || d.name.length < 2) {
    throw new Error('El cliente necesita un nombre de al menos dos letras')
  }
  return transaction(async (tx) => {
    const code = await siguienteCodigoCliente(tx)
    const c = await tx.one(
      `INSERT INTO customers (code, qr_token, name, company_name, phone, email, address,
                              zone_id, payment_terms_days, credit_limit, comercial_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),$10,$11,$12,$13)
       RETURNING *`,
      [code, nuevoTokenQr(), d.name, d.company_name ?? null, d.phone ?? null, d.email ?? null,
       d.address ?? null, d.zone_id ?? null, d.payment_terms_days ?? null,
       d.credit_limit ?? null, d.comercial_id ?? null, d.notes ?? null, usuarioId],
    )
    await auditar(tx, {
      usuarioId, accion: 'CREAR', entidad: 'customers', entidadId: c.id,
      despues: { code: c.code, name: c.name },
    })
    return c
  })
}

export async function actualizarCliente(id, datos, usuarioId) {
  const d = limpiar(datos)
  if (d.name !== undefined && d.name.length < 2) {
    throw new Error('El nombre del cliente no puede quedar vacío')
  }
  return transaction(async (tx) => {
    const antes = await tx.one(`SELECT * FROM customers WHERE id=$1`, [id])
    if (!antes) throw new Error('El cliente no existe')
    if (Object.keys(d).length === 0) return antes

    const sets = []
    const vals = []
    for (const [k, v] of Object.entries(d)) { vals.push(v); sets.push(`${k} = $${vals.length}`) }
    vals.push(id)
    const c = await tx.one(
      `UPDATE customers SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals)
    await auditar(tx, {
      usuarioId, accion: 'ACTUALIZAR', entidad: 'customers', entidadId: id,
      antes: { name: antes.name, phone: antes.phone }, despues: { name: c.name, phone: c.phone },
    })
    return c
  })
}

/**
 * Rota el token del QR.
 *
 * Es la respuesta a «la tarjeta se ha perdido». La tarjeta antigua deja de
 * servir en el mismo instante en que se guarda el nuevo token, sin tocar la
 * ficha del cliente ni su historial de pedidos.
 */
// ── Archivo y recuperación ───────────────────────────────────────────────────
//
//  Un cliente archivado NO se borra. Se apaga, y por eso todo lo que hizo
//  sigue ahí: sus pedidos, sus entregas, sus cobros, su histórico. Dar de baja
//  a un cliente en un almacén no significa que no existió, significa que ya no
//  se le vende.
//
//  Lo que además se guarda es QUIÉN y CUÁNDO lo archivó, y por qué motivo. Sin
//  eso, dentro de dos años «¿por qué este cliente no aparece?» no tiene
//  respuesta, y esa es la pregunta que más veces se hace.
export async function archivarCliente(id, usuarioId, motivo = '') {
  return transaction(async (tx) => {
    const antes = await tx.one('SELECT * FROM customers WHERE id = $1', [id])
    if (!antes) throw Object.assign(new Error('Cliente no encontrado'), { status: 404 })
    if (!antes.is_active) return { ...antes, ya_archivado: true }

    const d = await tx.one(
      `UPDATE customers SET is_active = false, archived_at = now(),
       archived_by = $2, archive_reason = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, usuarioId, motivo || null],
    )
    await auditar(tx, {
      usuarioId, accion: 'ARCHIVAR', entidad: 'customer', entidadId: id,
      antes, despues: d,
      detalle: { motivo: motivo || null },
    })
    return d
  })
}

export async function reactivarCliente(id, usuarioId) {
  return transaction(async (tx) => {
    const antes = await tx.one('SELECT * FROM customers WHERE id = $1', [id])
    if (!antes) throw Object.assign(new Error('Cliente no encontrado'), { status: 404 })
    if (antes.is_active) return { ...antes, ya_activo: true }

    const d = await tx.one(
      `UPDATE customers SET is_active = true, archived_at = NULL,
       archived_by = NULL, archive_reason = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    )
    await auditar(tx, {
      usuarioId, accion: 'REACTIVAR', entidad: 'customer', entidadId: id, antes, despues: d,
    })
    return d
  })
}

// Un cliente archivado no recibe pedidos nuevos. Los ANTIGUOS siguen ahí y se
// siguen viendo: cerrar un cliente no es reescribir su historia.
export async function comprobarClienteActivo(tx, clienteId) {
  const c = await tx.one('SELECT id, code, is_active FROM customers WHERE id = $1', [clienteId])
  if (!c) throw Object.assign(new Error('Cliente no encontrado'), { status: 404 })
  if (!c.is_active) {
    throw Object.assign(
      new Error(`El cliente ${c.code} está archivado. Recupéralo antes de crear un pedido.`),
      { status: 409, codigo: 'CLIENTE_ARCHIVADO' },
    )
  }
  return c
}

export async function regenerarTokenQr(id, usuarioId) {
  return transaction(async (tx) => {
    const antes = await tx.one(`SELECT id, code, qr_token FROM customers WHERE id=$1`, [id])
    if (!antes) throw new Error('El cliente no existe')
    const nuevo = nuevoTokenQr()
    await tx.query(`UPDATE customers SET qr_token=$2, updated_at=now() WHERE id=$1`, [id, nuevo])
    await auditar(tx, {
      usuarioId, accion: 'ROTAR_QR', entidad: 'customers', entidadId: id,
      antes: { qr: `${antes.qr_token.slice(0, 6)}…` }, despues: { qr: `${nuevo.slice(0, 6)}…` },
    })
    return { id, code: antes.code, qr_token: nuevo, rotado: true }
  })
}


export async function obtenerCliente(id, usuario = null) {
  return transaction(async (tx) => {
    // Por el mismo motivo que en la lista: si el filtro solo se aplica a
    // `/customers`, basta con adivinar un id para leer el cliente de otro.
    const ambito = usuario
      ? filtroDeAmbito(usuario, { ambitoEntregas: false })
      : { sql: '', params: [] }
    const c = await tx.one(
      `SELECT c.*, z.name AS zone_name, u.full_name AS commercial_name
         FROM customers c
         LEFT JOIN zones z ON z.id = c.zone_id
         LEFT JOIN com_perfiles cp ON cp.id = c.comercial_id
         LEFT JOIN users  u ON u.id = cp.user_id
        WHERE c.id = $1 ${ambito.sql.replace(/\$__N/g, '$2')}`, [id, ...ambito.params])

      // Un comercial que pide la ficha de un cliente que no es suyo recibe
      // ESTO MISMO, no un 403: si dijéramos «no tienes permiso», le estaríamos
      // confirmando que ese cliente existe. Que no sepa ni que exista.
      if (!c) {
        const e = new Error('El cliente no existe')
        e.codigo = 'CLIENTE_NO_ENCONTRADO'
        e.estado = 404
        throw e
      }
    const pedidos = await tx.query(
      `SELECT order_id, order_code, status, qty_ordered, qty_delivered, qty_pending, total
         FROM v_order_progress WHERE customer_id = $1
        ORDER BY created_at DESC LIMIT 50`, [id])
    return { ...c, pedidos }
  })
}

export async function listarClientes(opciones = {}) {
  const { buscar = '', soloActivos = true, soloArchivados = false, limite = 100, usuario = null } = opciones
  return transaction(async (tx) => {
    const cond = []
    const p = []
      // ÁMBITO: un comercial solo ve SUS clientes.
      //
      // Esto no estaba, y por eso un comercial veía los 23 clientes de la casa.
      // Un permiso de «ver clientes» no dice cuáles: el ámbito es lo que lo
      // dice, y sin él el permiso es una puerta abierta.
      if (usuario) {
        const ambito = filtroDeAmbito(usuario, { ambitoEntregas: false })
        if (ambito.sql) {
          // El filtro llega con un «AND» delante, pensado para añadirse a un
          // WHERE que ya tiene algo. Si resulta ser la PRIMERA condición se
          // queda sin él, o la consulta sale como «WHERE AND …» y no arranca.
          const trozo = ambito.sql.replace(/\$__N/g, `$${p.length + 1}`)
          cond.push(cond.length ? trozo : trozo.replace(/^\s*AND\s+/i, ''))
          p.push(...ambito.params)
        }
      }
    if (soloActivos) cond.push('c.is_active')
    if (opciones.soloArchivados) cond.push('NOT c.is_active')
    if (buscar) {
      p.push(`%${String(buscar).toLowerCase()}%`)
      cond.push(`(lower(c.name) LIKE $${p.length} OR lower(COALESCE(c.company_name,'')) LIKE $${p.length}`
              + ` OR lower(c.code) LIKE $${p.length} OR lower(COALESCE(c.phone,'')) LIKE $${p.length})`)
    }
    p.push(limite)
    return tx.query(
      `SELECT c.id, c.code, c.name, c.company_name, c.phone, c.email, c.address,
              c.zone_id, c.is_active, c.credit_limit, c.payment_terms_days, c.comercial_id,
              z.name AS zone_name,
              COALESCE(p.qty_pending, 0)  AS qty_pending,
              COALESCE(p.total, 0)        AS facturado
         FROM customers c
         LEFT JOIN zones z ON z.id = c.zone_id
         LEFT JOIN LATERAL (
           SELECT SUM(qty_pending) AS qty_pending, SUM(total) AS total
             FROM v_order_progress v WHERE v.customer_id = c.id AND v.status <> 'CANCELLED'
         ) p ON TRUE
        ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER BY c.name LIMIT $${p.length}`, p)
  })
}

/**
 * Resuelve un QR escaneado.
 *
 * Solo devuelve lo mínimo para identificar: código, nombre y si tiene pedidos
 * pendientes. El repartidor necesita saber a quién va; no necesita el límite
 * de crédito ni las coordenadas.
 */
export async function resolverQr(token) {
  const limpio = String(token || '').trim().replace(/^CS-/, '')
  if (!limpio) throw new Error('Falta el código de la tarjeta')
  return transaction(async (tx) => {
    const c = await tx.one(
      `SELECT id, code, name, company_name FROM customers WHERE qr_token = $1`, [limpio])
    if (!c) {
      throw new Error('Esa tarjeta no es válida. Puede que se haya revocado al darla por perdida.')
    }
    // ── Qué le enseñamos al repartidor ─────────────────────────────────────
    //
    // Solo los pedidos que SE PUEDEN ENTREGAR AHORA: reservados con mercancía
    // apartada, o preparados, o a medias de una entrega anterior.
    //
    // Antes salían TODOS los no anulados, incluidos los que están en BORRADOR.
    // Un borrador ni siquiera tiene mercancía reservada: el repartidor veía el
    // pedido, le daba a «Entregar» y la operación fallaba. Peor: mezclarlos con
    // los de verdad hacía imposible saber cuál de los tres de la lista era el
    // que acababa de entregar.
    const entregables = await tx.query(
      `SELECT v.order_id, v.order_code, v.status, v.qty_pending, v.qty_delivered,
              v.qty_ordered, v.promised_date,
              --
              -- ══ LO QUE HAY QUE COBRAR ══
              --
              -- v_order_progress ya trae o.total y o.currency_code del
              -- pedido, y por eso el importe sale de AQUÍ: de la fila del
              -- pedido, no de una cuenta que alguien haga en su cabeza ni de
              -- un campo que alguien escriba.
              --
              -- La regla del negocio es «si el pedido son 125.000, el sistema
              -- le tiene que indicar que debe cobrar 125.000». Eso significa
              -- que el repartidor tiene que VER la cifra antes de entregar.
              -- Sin esto cobraba de memoria, que es como se cobran mal.
              --
              -- pendiente_de_cobro es el total MENOS lo ya cobrado, no el
              -- total a secas: un pedido cobrado a medias tiene que mostrar
              -- lo que falta, o el repartidor cobra dos veces.
              --
              -- Y ya_cobrado marca los que ya están pagados: se quedan en
              -- la lista si les queda mercancía por entregar —el cliente la
              -- necesita aunque ya haya pagado— pero el repartidor ve que no
              -- hay nada que cobrar.
              --
              --
              -- Y con los NOMBRES DE LA VISTA, no los de su tabla.
              --
              -- La vista expone order_id, total y currency_code.
              -- No expone «o», porque ese es el alias de sales_orders DENTRO
              -- de la vista, y ahí dentro se acaba. Escribir o.total desde
              -- fuera da «missing FROM-clause entry for table o», que es el
              -- mismo error que el ic.id del filtro de categoría: un alias
              -- que se usa donde no existe.
              --
              v.total                                         AS importe_pedido,
              v.currency_code                                 AS moneda,
              --
              -- fn_pendiente_cobro() es LA cuenta. No la repetimos aquí.
              --
              -- (Y sin comillas invertidas en el comentario: esto es una
              -- plantilla de SQL y un acento grave la cierra antes de tiempo.
              -- Ya ha pasado dos veces, y las dos lancen un error que no
              -- señala ni de dónde sale. Un comentario no rompe el programa.
              --
              -- Estaba escrita dos veces en esta misma consulta —una para el
              -- importe y otra para el «¿ya está pagado?»— y una tercera en el
              -- disparador que valida el cobro. Tres copias de la misma
              -- fórmula, y la tarjeta y la base se separaron justo por eso.
              --
              -- Aquí la tarjeta y el cobro llaman a la MISMA función, así que
              -- no pueden decir cosas distintas: no es que se compruebe que
              -- cuadren, es que no hay dos que comparar.
              --
              fn_pendiente_cobro(v.order_id)                  AS pendiente_de_cobro,
              (fn_pendiente_cobro(v.order_id) <= 0)          AS ya_cobrado,
              (SELECT COUNT(*) FROM payments p
                WHERE p.sales_order_id = v.order_id AND p.status <> 'REJECTED') AS cobros,
              (SELECT COUNT(*) FROM payments p
                WHERE p.sales_order_id = v.order_id AND p.status = 'PENDING')  AS cobros_por_verificar,
              (SELECT COUNT(*) FROM deliveries d
                WHERE d.sales_order_id = v.order_id AND d.status = 'DELIVERED') AS entregas,
              (SELECT COUNT(*) FROM sales_order_lines l
                WHERE l.sales_order_id = v.order_id
                  AND l.qty > l.qty_delivered + 0.0001) AS lineas,
              (SELECT string_agg(i.name || ' × ' || (l.qty - l.qty_delivered)::int, ', '
                                 ORDER BY i.name)
                 FROM sales_order_lines l JOIN items i ON i.id = l.item_id
                WHERE l.sales_order_id = v.order_id
                  AND l.qty > l.qty_delivered + 0.0001) AS que_lleva
         FROM v_order_progress v
        WHERE v.customer_id = $1
          AND v.qty_pending > 0
          AND v.status IN ('RESERVED','PREPARED','IN_ROUTE')
        ORDER BY v.status = 'PREPARED' DESC, v.created_at`, [c.id])

    // Los que NO se pueden entregar, y por qué, para que el repartidor no se pregunte
    // dónde se han quedado.
    const enPreparacion = await tx.query(
      `SELECT order_id, order_code, status
         FROM v_order_progress
        WHERE customer_id = $1 AND qty_pending > 0
          AND status NOT IN ('RESERVED','PREPARED','IN_ROUTE')
        ORDER BY created_at`, [c.id])

    return {
      ...c,
      valido: true,
      pedidos_pendientes: entregables,
      pedidos_no_entregables: enPreparacion,
    }
  })
}
