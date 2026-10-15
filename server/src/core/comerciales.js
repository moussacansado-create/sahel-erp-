/**
 * COMERCIALES · NÚCLEO
 *
 * Todo lo que la API y la pantalla van a usar sale de aquí. Y todas las
 * operaciones terminan en `confirmarGuardado()`: que la transacción devuelva
 * bien no es lo mismo que haya escrito, y esta aplicación ya ha devolvido un
 * id sin fila detrás delante de un usuario.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * REGLAS QUE NO SE NEGOCIAN
 *
 * · NADA ESCRIBE FUERA DE LAS TABLAS `com_*`. Se lee `sales_orders` y `users`
 *   para contar, y no se escribe nunca. La comprobación está en
 *   `com_superficie` y en `tests/migracion-027.test.mjs`.
 *
 * · `user_id` y `customer_id` NO llevan clave foránea, y por eso este módulo
 *   comprueba que existan. Es el precio del aislamiento y hay que pagarlo.
 *
 * · SIN OBJETIVO NO ES OBJETIVO CERO. Un comercial sin objetivo tiene
 *   `tiene_objetivo = false` y cumplimiento `NULL`. Nunca entra en un cálculo
 *   como si tuviera un cero. Ver `com_ranking`.
 *
 * · UNA RESERVA VA EN UN SAVEPOINT. Un fallo de auditoría no puede costarle la
 *   operación a quien estaba creando una zona. Ver `auditoria.js`.
 *
 */

import { query, one, transaction, closeDb } from '../db/client.js'
import { registrarAuditoria as registrar, confirmarGuardado } from './comerciales-auditoria.js'

export { query, one, transaction, closeDb }

// ═══════════════════════════════════════════════════════════════════════════
// ERRORES
// ═══════════════════════════════════════════════════════════════════════════

export class ErrorComercial extends Error {
  constructor(mensaje, { codigo = 'ERROR_COMERCIAL', estado = 400, detalle = null } = {}) {
    super(mensaje)
    this.name = 'ErrorComercial'
    this.codigo = codigo
    this.estado = estado
    this.detalle = detalle
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HECHOS · LA CUENTA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que ha hecho un comercial en un periodo.
 *
 * Va contra `com_hechos()`, que está en SQL a propósito. El ranking, los
 * objetivos y los puntos tienen que decir LO MISMO, y si cada uno se calculara
 * por su lado el ranking puede decir que alguien cumple su objetivo mientras
 * los puntos dicen que no. Los dos números serían ciertos y los dos mentirían.
 *
 * Solo lectura sobre el ERP. Aquí no se escribe nada.
 */
export async function hechos(comercialId, desde, hasta) {
  const r = await one('SELECT * FROM com_hechos($1::int, $2::date, $3::date)', [comercialId, desde, hasta])
  return {
    importe: Number(r.importe),
    pedidos: Number(r.pedidos),
    unidades: Number(r.unidades),
    visitas: Number(r.visitas),
    clientesDistintos: Number(r.clientes_distintos),
    diasActivos: Number(r.dias_activos),
  }
}

/** El mes en curso, que es lo que se mira un lunes por la mañana. */
export function mesEnCurso(hoy = new Date()) {
  return {
    desde: new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10),
    hasta: new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).toISOString().slice(0, 10),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONAS
// ═══════════════════════════════════════════════════════════════════════════

const TIPOS_ZONA = ['URBANA', 'RURAL', 'PUNTO_VENTA', 'MAYORISTA', 'CORREDURIA']

export async function crearZona({ code, name, kind, parentId = null, idiomas = [], notas = null, usuarioId = null }) {
  const codigo = String(code ?? '').trim().toUpperCase()

  if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(codigo)) {
    throw new ErrorComercial(
      'El código de zona son de 2 a 20 caracteres: letras mayúsculas, números, guion o guion bajo.',
      { codigo: 'CODIGO_ZONA_INVALIDO', detalle: { recibido: code } },
    )
  }
  if (!name || String(name).trim().length < 2) {
    throw new ErrorComercial('La zona necesita un nombre de al menos dos letras.', { codigo: 'ZONA_SIN_NOMBRE' })
  }
  if (!TIPOS_ZONA.includes(kind)) {
    throw new ErrorComercial(
      `Tipo de zona desconocido. Los que hay son: ${TIPOS_ZONA.join(', ')}.`,
      { codigo: 'TIPO_ZONA_INVALIDO', detalle: { recibido: kind, validos: TIPOS_ZONA } },
    )
  }

  const z = await transaction(async (tx) => {
    if (parentId) {
      const padre = await tx.one('SELECT id, nivel FROM com_zonas WHERE id = $1', [parentId])
      if (!padre) {
        throw new ErrorComercial(`No existe la zona padre ${parentId}.`, { codigo: 'ZONA_PADRE_NO_EXISTE' })
      }
      //
      // El padre tiene que ser una REGIÓN, y se comprueba aquí con un mensaje
      // que explica el porqué.
      //
      // El CHECK `com_zona_nivel_coherente` también lo impide, pero llega
      // como «violates check constraint com_zona_nivel_coherente», que no
      // dice qué hay que hacer. Un error que hay que buscar en el esquema es un
      // error que se queda sin resolver.
      //
      if (padre.nivel !== 'REGION') {
        throw new ErrorComercial(
          `La zona padre ${parentId} es una ZONA, y una zona cuelga de una región, no de otra zona. `
          + 'El esquema tiene dos niveles a propósito: con tres habría que decidir '
          + 'qué cuenta como zona al pintar el mapa, y esa decisión no está tomada.',
          { codigo: 'PADRE_NO_ES_REGION', detalle: { parentId, nivelPadre: padre.nivel } },
        )
      }
    }

    const creada = await tx.one(
      //
      // El `nivel` se pone EXPLÍCITAMENTE. Dejarlo al DEFAULT parece más
      // limpio y es peor: el día que una zona pase a ser región, la fila
      // cambiará de nivel sola, sin que nadie lo haya decidido, y el mapa
      // enseñará algo que nadie eligió.
      //
      `INSERT INTO com_zonas (code, name, parent_id, kind, nivel, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [codigo, String(name).trim(), parentId, kind, parentId ? 'ZONA' : 'REGION', notas],
    )
    await ponerIdiomasZona(tx, creada.id, idiomas)
    await registrar(tx, {
      usuarioId, accion: 'com.zona_creada', entidad: 'com_zonas', entidadId: creada.id,
      datos: { code: codigo, name, kind, idiomas: (idiomas ?? []).length },
    })
    return creada
  })

  return confirmarGuardado('com_zonas', z.id, { que: 'la zona', campo: 'code', esperado: codigo })
}

/** Los idiomas de una zona. Se reescriben enteros: es una lista corta. */
async function ponerIdiomasZona(tx, zonaId, idiomas) {
  for (const i of (idiomas ?? [])) {
    const codigo = String(i.language ?? i.codigo ?? i).trim().toLowerCase()
    const existe = await tx.one('SELECT code FROM com_idiomas WHERE code = $1', [codigo])
    if (!existe) {
      throw new ErrorComercial(
        `El idioma «${codigo}» no está en el catálogo. Se puede añadir, pero no se `
        + 'adivina: escribir un idioma que no existe es escribir mal.',
        { codigo: 'IDIOMA_DESCONOCIDO', detalle: { idioma: codigo } },
      )
    }
    await tx.query(
      `INSERT INTO com_zona_idiomas (zona_id, idioma_code, peso) VALUES ($1,$2,$3)
       ON CONFLICT (zona_id, idioma_code) DO UPDATE SET peso = EXCLUDED.peso`,
      [zonaId, codigo, i.peso ?? i.weight ?? 100],
    )
  }
}

export async function actualizarZona(zonaId, { name, kind, parentId, notas, idiomas = null, usuarioId = null }) {
  if (kind && !TIPOS_ZONA.includes(kind)) {
    throw new ErrorComercial(`Tipo de zona desconocido: ${kind}`, { codigo: 'TIPO_ZONA_INVALIDO' })
  }

  const z = await transaction(async (tx) => {
    const actual = await tx.one('SELECT * FROM com_zonas WHERE id = $1 FOR UPDATE', [zonaId])
    if (!actual) throw new ErrorComercial(`No existe la zona ${zonaId}`, { codigo: 'ZONA_NO_EXISTE' })

    if (parentId) {
      if (Number(parentId) === Number(zonaId)) {
        throw new ErrorComercial('Una zona no puede ser hija de sí misma.', { codigo: 'ZONA_CICLO' })
      }

      //
      // El padre tiene que ser una REGIÓN, al MOVER igual que al CREAR.
      //
      // Si solo se comprueba al crear, el error entra por la puerta de atrás:
      // se crea bien y luego se mueve mal, y el sistema que «no podía pasar»
      // acaba pasándolo.
      //
      const padreZona = await tx.one('SELECT id, nivel FROM com_zonas WHERE id = $1', [parentId])
      if (!padreZona) {
        throw new ErrorComercial(`No existe la zona padre ${parentId}.`, { codigo: 'ZONA_PADRE_NO_EXISTE' })
      }
      if (padreZona.nivel !== 'REGION') {
        throw new ErrorComercial(
          `La zona padre ${parentId} es una ZONA, y una zona cuelga de una región, no de otra zona. `
          + 'El esquema tiene dos niveles a propósito: con tres habría que decidir '
          + 'qué cuenta como zona al pintar el mapa, y esa decisión no está tomada.',
          { codigo: 'PADRE_NO_ES_REGION', detalle: { parentId, nivelPadre: padreZona.nivel } },
        )
      }
      // El bucle de zonas: A no puede colgar de B si B cuelga de A. Con dos
      // niveles no se nota; con tres, un comercial aparece duplicado en todos
      // los filtros y nadie sabe por qué.
      let actualId = parentId
      for (let nivel = 0; nivel < 50; nivel++) {
        if (Number(actualId) === Number(zonaId)) {
          throw new ErrorComercial(
            'Esa zona cuelga de esta: moverla aquí crearía un bucle y los filtros se romperían.',
            { codigo: 'ZONA_CICLO' },
          )
        }
        const padre = await tx.one('SELECT parent_id FROM com_zonas WHERE id = $1', [actualId])
        if (!padre?.parent_id) break
        actualId = padre.parent_id
      }
    }

    const modificada = await tx.one(
      `UPDATE com_zonas SET name = COALESCE($2, name), kind = COALESCE($3, kind),
              parent_id = $4, notes = COALESCE($5, notes), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [zonaId, name ?? null, kind ?? null, parentId ?? null, notas ?? null],
    )
    if (idiomas) await ponerIdiomasZona(tx, zonaId, idiomas)
    await registrar(tx, { usuarioId, accion: 'com.zona_actualizada', entidad: 'com_zonas', entidadId: zonaId })
    return modificada
  })

  return confirmarGuardado('com_zonas', z.id, { que: 'la zona' })
}

export async function listarZonas({ conIdiomas = false } = {}) {
  const zonas = await query(
    `SELECT z.*,
            (SELECT COUNT(*) FROM com_perfiles p WHERE p.home_zona_id = z.id AND p.is_active) AS comerciales,
            (SELECT array_agg(zi.idioma_code ORDER BY zi.idioma_code)
               FROM com_zona_idiomas zi WHERE zi.zona_id = z.id) AS idiomas
       FROM com_zonas z
      ORDER BY z.name`,
  )
  if (!conIdiomas) return zonas.map(({ idiomas: _i, ...z }) => z)

  const detalle = await query(
    `SELECT zi.zona_id, zi.idioma_code, zi.peso, i.nombre
       FROM com_zona_idiomas zi JOIN com_idiomas i ON i.code = zi.idioma_code`,
  )
  const porZona = new Map()
  for (const d of detalle) {
    if (!porZona.has(d.zona_id)) porZona.set(d.zona_id, [])
    porZona.get(d.zona_id).push({ idioma: d.idioma_code, nombre: d.nombre, peso: d.peso })
  }
  return zonas.map((z) => ({ ...z, idiomas: porZona.get(z.id) ?? [] }))
}

// ═══════════════════════════════════════════════════════════════════════════
// COMERCIALES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Alta de un comercial.
 *
 * `userId` es un número SIN clave foránea, así que aquí se comprueba que el
 * usuario exista. Es el precio del aislamiento: la base no lo garantiza por
 * nosotros porque no la dejamos atar nada al ERP.
 *
 * Y NO se toca `users.role`. El rol dice qué puede hacer alguien dentro de la
 * aplicación, y no se deduce de que venda. Alguien puede ser comercial y
 * cajero a la vez, y una alta que le quita permisos a quien los tenía es una
 * alta que «funciona» mientras a la semana nadie puede cobrar.
 */
export async function altaComercial({ userId, idiomas = [], zonaId = null, hiredOn = null, notas = null, usuarioId = null }) {
  const id = Number(userId)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ErrorComercial('Hacen falta los datos del comercial.', { codigo: 'DATOS_INCOMPLETOS' })
  }

  const limpio = (Array.isArray(idiomas) ? idiomas : [idiomas])
    .filter(Boolean)
    .map((i) => String(i.language ?? i.codigo ?? i).trim().toLowerCase())
    .filter(Boolean)

  if (!limpio.length) {
    //
    // SIN IDIOMA NO SE DA DE ALTA, y sin inventarle uno.
    //
    // Se podría poner «es» por defecto y todo funcionaría, y el fallo
    // aparecería meses después, cuando alguien mande a un comercial que no
    // habla francés a una zona donde solo se habla francés. Un idioma
    // inventado empareja PEOR que no emparejar.
    //
    throw new ErrorComercial(
      'Un comercial necesita al menos un idioma. Sin él no se puede emparejar con '
      + 'ninguna zona, y un idioma inventado empareja peor que ninguno.',
      { codigo: 'COMERCIAL_SIN_IDIOMA', detalle: { recibidos: idiomas } },
    )
  }

  const alta = await transaction(async (tx) => {
    const u = await tx.one('SELECT id, full_name, is_active FROM users WHERE id = $1', [id])
    if (!u) {
      throw new ErrorComercial(`No existe el usuario ${id}.`, { codigo: 'USUARIO_NO_EXISTE', detalle: { userId: id } })
    }
    if (!u.is_active) {
      throw new ErrorComercial(
        `${u.full_name} está desactivado: no se puede dar de alta a un comercial que no puede entrar.`,
        { codigo: 'USUARIO_INACTIVO' },
      )
    }

    for (const c of limpio) {
      const existe = await tx.one('SELECT code FROM com_idiomas WHERE code = $1', [c])
      if (!existe) {
        throw new ErrorComercial(
          `El idioma «${c}» no está en el catálogo.`, { codigo: 'IDIOMA_DESCONOCIDO', detalle: { idioma: c } },
        )
      }
    }

    if (zonaId) {
      const z = await tx.one('SELECT id FROM com_zonas WHERE id = $1 AND is_active', [zonaId])
      if (!z) throw new ErrorComercial(`No existe la zona ${zonaId}`, { codigo: 'ZONA_NO_EXISTE' })
    }

    const ya = await tx.one('SELECT * FROM com_perfiles WHERE user_id = $1', [id])
    const ficha = ya
      ? await tx.one(
        `UPDATE com_perfiles SET is_active = TRUE, hired_on = $2,
                home_zona_id = $3, notes = COALESCE($4, notes), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [ya.id, hiredOn || ya.hired_on, zonaId, notas],
      )
      : await tx.one(
        `INSERT INTO com_perfiles (user_id, home_zona_id, hired_on, notes)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4) RETURNING *`,
        [id, zonaId, hiredOn, notas],
      )

    for (const [n, c] of limpio.entries()) {
      await tx.query(
        `INSERT INTO com_comercial_idiomas (comercial_id, idioma_code, nativo)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [ficha.id, c, n === 0],
      )
    }

    //
    // La zona principal se apunta TAMBIÉN en `com_comercial_zonas`.
    //
    // Antes solo se escribía `com_perfiles.home_zona_id`, y eso dejaba
    // `com_comercial_zonas` VACÍA después de dar de alta a un comercial. Dos
    // consecuencias, y las dos malas:
    //
    //   · la ficha del comercial —que lee la tabla de asignaciones, que es la
    //     que admite varias zonas— no encontraba ni una;
    //   · `fn_comerciales_de(zona)`, que es lo que llena el tercer desplegable
    //     de la cascada de clientes, tampoco.
    //
    // `home_zona_id` queda como lo que es: QUÉ ZONA SE MARCA EN EL MAPA. La
    // tabla de asignaciones es la que dice a qué zonas trabaja. Son dos
    // preguntas, y guardar solo una dejaba la otra sin respuesta.
    //
    if (zonaId) {
      await tx.query(
        `INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
         VALUES ($1, $2, TRUE, 100, CURRENT_DATE)
         ON CONFLICT (comercial_id, zona_id, desde)
         DO UPDATE SET es_principal = TRUE`,
        [ficha.id, zonaId],
      )
    }

    await registrar(tx, {
      usuarioId, accion: ya ? 'com.alta_actualizada' : 'com.alta',
      entidad: 'com_perfiles', entidadId: ficha.id,
      datos: { userId: id, idiomas: limpio, zonaId },
    })
    return ficha
  })

  return confirmarGuardado('com_perfiles', alta.id, { que: 'el comercial' })
}

/**
 * Baja.
 *
 * NO se borra: el histórico de visitas y de ventas tiene que seguir ahí, y un
 * comercial al que se le borró el perfil pierde su pasado. Se marca.
 */
export async function bajaComercial(comercialId, usuarioId = null) {
  const p = await transaction(async (tx) => {
    const f = await tx.one('SELECT * FROM com_perfiles WHERE id = $1 FOR UPDATE', [comercialId])
    if (!f) throw new ErrorComercial('Ese comercial no existe.', { codigo: 'COMERCIAL_NO_EXISTE' })

    const r = await tx.one(
      'UPDATE com_perfiles SET is_active = FALSE, updated_at = now() WHERE id = $1 RETURNING *',
      [comercialId],
    )
    await registrar(tx, {
      usuarioId, accion: 'com.baja', entidad: 'com_perfiles', entidadId: comercialId,
    })
    return r
  })
  return confirmarGuardado('com_perfiles', p.id, { que: 'el comercial', campo: 'is_active', esperado: false })
}

export async function listarComerciales({ soloActivos = false } = {}) {
  return query(
    `SELECT cp.*, u.username, u.full_name, u.is_active AS usuario_activo,
            z.name AS zona,
            COALESCE((SELECT array_agg(m.idioma_code ORDER BY m.idioma_code)
                        FROM com_comercial_idiomas m WHERE m.comercial_id = cp.id), '{}') AS idiomas
       FROM com_perfiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN com_zonas z ON z.id = cp.home_zona_id
      ${soloActivos ? 'WHERE cp.is_active AND u.is_active' : ''}
      ORDER BY u.full_name`,
  )
}

/** Asignar (o cambiar) la zona de un comercial. */
export async function asignarZona(comercialId, zonaId, usuarioId = null) {
  const p = await transaction(async (tx) => {
    const zona = await tx.one('SELECT * FROM com_zonas WHERE id = $1 AND is_active', [zonaId])
    if (!zona) throw new ErrorComercial(`No existe la zona ${zonaId}`, { codigo: 'ZONA_NO_EXISTE' })

    const perfil = await tx.one('SELECT * FROM com_perfiles WHERE id = $1', [comercialId])
    if (!perfil) throw new ErrorComercial('Ese comercial no existe.', { codigo: 'COMERCIAL_NO_EXISTE' })

    const r = await tx.one(
      'UPDATE com_perfiles SET home_zona_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [comercialId, zonaId],
    )
    await registrar(tx, {
      usuarioId, accion: 'com.zona_asignada', entidad: 'com_perfiles', entidadId: comercialId,
      datos: { zonaId },
    })
    return { ...r, zonaNombre: zona.name }
  })

  const guardada = await confirmarGuardado('com_perfiles', p.id, { que: 'el comercial' })

  // Aviso, no error. Puede ser correcto: alguien que cubre su zona en el
  // francés que él no habla. Lo que no hace falta es enterarse tarde.
  const [habla, zonaHabla] = await Promise.all([
    query('SELECT idioma_code FROM com_comercial_idiomas WHERE comercial_id = $1', [comercialId]),
    query('SELECT idioma_code FROM com_zona_idiomas WHERE zona_id = $1', [zonaId]),
  ])
  const comunes = zonaHabla.filter((z) => habla.some((h) => h.idioma_code === z.idioma_code))
  return {
    ...guardada,
    aviso: zonaHabla.length > 0 && comunes.length === 0
      ? `${p.zonaNombre} se habla en ${zonaHabla.map((z) => z.idioma_code).join(', ')} y este comercial `
        + 'no habla ninguno. Se ha asignado igualmente, pero conviene revisarlo.'
      : null,
  }
}

/** Quién encaja con qué zona, por idioma. */
export async function afinidades({ comercialId = null } = {}) {
  const filas = await query(
    `SELECT * FROM com_afinidades ${comercialId ? 'WHERE comercial_id = $1' : ''}
      ORDER BY zona, full_name, idioma`,
    comercialId ? [comercialId] : [],
  )
  return filas
}

// ═══════════════════════════════════════════════════════════════════════════
// OBJETIVOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poner un objetivo.
 *
 * Un objetivo NO se toca una vez que su periodo ha empezado. Se puede
 * corregir la cifra ANTES de que empiece; después, el siguiente periodo.
 *
 * Por qué: un objetivo es la medida con la que se juzgó a alguien. Si se
 * puede retocar después de ver el resultado, deja de ser una medida y pasa a
 * ser una opinión. Y el ranking entero se apoya en ello.
 */
export async function ponerObjetivo({
  comercialId, periodStart, periodEnd, targetAmount = null, targetUnits = null,
  targetOrders = null, targetVisits = null, notas = null, usuarioId = null,
}) {
  if (!periodStart || !periodEnd || String(periodEnd) < String(periodStart)) {
    throw new ErrorComercial('El periodo no vale: la fecha final tiene que ser posterior a la inicial.', {
      codigo: 'PERIODO_INVALIDO', detalle: { periodStart, periodEnd },
    })
  }
  if ([targetAmount, targetUnits, targetOrders, targetVisits].every((v) => v === null || v === undefined)) {
    throw new ErrorComercial(
      'Un objetivo tiene que decir ALGO: importe, unidades, pedidos o visitas. '
      + 'Un objetivo vacío no mide nada.',
      { codigo: 'OBJETIVO_VACIO' },
    )
  }

  const hoy = new Date().toISOString().slice(0, 10)
  const inicio = String(periodStart).slice(0, 10)

  if (inicio < hoy) {
    //
    // El periodo ya empezó. Se rechaza, y no es un capricho: es lo que hace que
    // el cumplimiento signifique algo.
    //
    throw new ErrorComercial(
      `El periodo empieza el ${inicio}, y hoy es ${hoy}: ese objetivo ya ha empezado y no se cambia. `
      + 'Un objetivo que se puede retocar después de ver el resultado deja de ser una medida. '
      + 'Pon el del siguiente periodo.',
      { codigo: 'OBJETIVO_CERRADO', detalle: { periodStart: inicio, hoy } },
    )
  }

  const o = await transaction(async (tx) => {
    const perfil = await tx.one('SELECT id FROM com_perfiles WHERE id = $1', [comercialId])
    if (!perfil) throw new ErrorComercial('Ese comercial no existe.', { codigo: 'COMERCIAL_NO_EXISTE' })

    const ya = await tx.one(
      'SELECT * FROM com_objetivos WHERE comercial_id = $1 AND period_start = $2',
      [comercialId, inicio],
    )

    const guardado = ya
      ? await tx.one(
        `UPDATE com_objetivos
            SET period_end = $2, target_amount = COALESCE($3, target_amount),
                target_units = COALESCE($4, target_units), target_orders = COALESCE($5, target_orders),
                target_visits = COALESCE($6, target_visits), notes = COALESCE($7, notes), is_active = TRUE
          WHERE id = $1 RETURNING *`,
        [ya.id, periodEnd, targetAmount, targetUnits, targetOrders, targetVisits, notas],
      )
      : await tx.one(
        `INSERT INTO com_objetivos
           (comercial_id, period_start, period_end, target_amount, target_units, target_orders, target_visits, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [comercialId, inicio, periodEnd, targetAmount, targetUnits, targetOrders, targetVisits, notas],
      )

    await registrar(tx, {
      usuarioId, accion: ya ? 'com.objetivo_actualizado' : 'com.objetivo_creado',
      entidad: 'com_objetivos', entidadId: guardado.id,
      datos: { comercialId, periodStart: inicio, targetAmount, targetUnits },
    })
    return guardado
  })

  return confirmarGuardado('com_objetivos', o.id, { que: 'el objetivo' })
}

export async function listarObjetivos({ comercialId = null } = {}) {
  return query(
    `SELECT o.*, u.username, u.full_name
       FROM com_objetivos o
       JOIN com_perfiles cp ON cp.id = o.comercial_id
       JOIN users u ON u.id = cp.user_id
      ${comercialId ? 'WHERE o.comercial_id = $1' : ''}
      ORDER BY o.period_start DESC, u.full_name`,
    comercialId ? [comercialId] : [],
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// VISITAS
// ═══════════════════════════════════════════════════════════════════════════

export const RESULTADOS = {
  PRODUCT_SHOWN: 'Producto presentado',
  ORDER_TAKEN: 'Pedido conseguido',
  FOLLOW_UP_NEEDED: 'Hay que volver',
  NO_INTEREST: 'No hay interés',
  VISITED_NO_CLIENT: 'Visitado, sin compra',
  CLOSED: 'Cerrado',
}

export async function registrarVisita({
  usuarioId, comercialId = null, clienteId = null, resultado, notas = null,
  nextAction = null, nextActionDate = null, lat = null, lng = null,
  tipoVisita = null, huboPedido = null, pedidoId = null, problemas = null, realizadaPor = null,
}) {
  if (!RESULTADOS[resultado]) {
    throw new ErrorComercial(
      `Resultado de visita desconocido: ${resultado}. Los que hay son: ${Object.keys(RESULTADOS).join(', ')}.`,
      { codigo: 'RESULTADO_INVALIDO', detalle: { recibidos: resultado, validos: Object.keys(RESULTADOS) } },
    )
  }

  // ── QUIÉN VA ───────────────────────────────────────────────────────────────
  // Por defecto, quien escribe. Si viene otro en el cuerpo, ese es el que se
  // anota en `realizada_por`: es la forma de que el ADMINISTRADOR registre una
  // visita a un cliente sin tener que hacerse el comercial, y sin que la
  // visita parezca suya por un campo que no le corresponde.
  let comercialIdReal = comercialId
  let realizadaPorReal = realizadaPor
  const quien = await one('SELECT id FROM com_perfiles WHERE user_id = $1 AND is_active', [usuarioId])
  if (!comercialId) {
    comercialIdReal = quien ? quien.id : null
  } else if (!quien || quien.id !== comercialId) {
    // Se está registrando en nombre de otro: la fila conserva a ese comercial
    // y quien escribe queda en `registrado_por`. Las dos firmas separadas.
    realizadaPorReal = realizadaPor ?? usuarioId
  }

  const visita = await transaction(async (tx) => {
    const perfil = comercialIdReal
      ? await tx.one('SELECT * FROM com_perfiles WHERE id = $1 AND is_active FOR UPDATE', [comercialIdReal])
      : null
    // Sin comercial al que atribuirlas y sin `realizada_por`, la visita no tiene
    // autor: no se guarda. Un visita sin saber quién fue no sirve para nada.
    if (!perfil && !realizadaPorReal) {
      throw new ErrorComercial(
        'Esta visita no tiene autor: no hay comercial al que atribuírsela. '
        + 'Quien la escribe necesita un perfil comercial.',
        { codigo: 'VISITA_SIN_AUTOR' },
      )
    }
      // ── DE QUIÉN ES EL CLIENTE, AHORA MISMO ─────────────────────────────
      //
      // Es una FOTO, no un reparto. Registrar una visita NO cambia el
      // responsable: si lo cambiara, un comercial podría «quedarse» con un
      // cliente solo por registrar visitas en él, que es justo la apropiación
      // que esto tiene que impedir. Se lee y se copia; nada más.
      let responsable = null
      if (clienteId != null) {
        const fila = await tx.one('SELECT comercial_id FROM customers WHERE id = $1', [clienteId])
        responsable = fila?.comercial_id ?? null
      }

    if (!perfil) {
      //
      // Una visita de alguien que no está de alta no cuenta para ningún
      // ranking, así que no se registra: sería ruido con apariencia de dato.
      //
      throw new ErrorComercial(
        'Ese comercial no está de alta. Una visita de alguien que no lo está no cuenta '
        + 'para ningún ranking, y guardarla solo añade ruido.',
        { codigo: 'COMERCIAL_NO_ACTIVO', detalle: { comercialId } },
      )
    }

    // `customer_id` sin clave foránea: se comprueba aquí. Una visita a un
    // cliente que luego se borra tiene que seguir existiendo, porque es la
    // prueba de que el comercial estuvo ahí.
    if (clienteId != null) {
      const c = await tx.one('SELECT id FROM customers WHERE id = $1', [clienteId])
      if (!c) {
        throw new ErrorComercial(`No existe el cliente ${clienteId}.`, {
          codigo: 'CLIENTE_NO_EXISTE', detalle: { clienteId },
        })
      }
    }

    // Si alguien ha dicho «vuelvo el martes», la fecha se rellena sola con el
    // martes de dentro de una semana. No porque el sistema sepa los martes,
    // sino porque un campo que hay que rellenar a mano es un campo que se
    // queda vacío.
    let siguiente = nextActionDate
    if (!siguiente && nextAction) {
      const d = new Date()
      d.setDate(d.getDate() + 7)
      siguiente = d.toISOString().slice(0, 10)
    }

    const v = await tx.one(
      // `responsable_id` es la FOTO de quién era dueño del cliente AHORA, no
      // un enlace vivo. Se copia al escribir y ya no se mueve: si el cliente
      // cambia de comercial mañana, esta visita sigue diciendo a quién se le
      // Visits in a visit, and the visit is not a transfer of the client.
      `INSERT INTO com_visitas
         (comercial_id, customer_id, resultado, notas, next_action, next_action_date,
          lat, lng, registrado_por, realizada_por, responsable_id,
          tipo_visita, hubo_pedido, pedido_id, problemas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [comercialIdReal ?? null, clienteId ?? null, resultado, notas,
         nextAction ?? null, siguiente, lat, lng,
         usuarioId ?? null,                    // QUIEN LA ESCRIBE: lo pone el servidor
         realizadaPorReal ?? null,              // QUIEN LA HIZO si no es un comercial
         responsable,                          // DE QUIEN ERA el cliente al visitarla
         tipoVisita, huboPedido, pedidoId ?? null, problemas],
    )
    await registrar(tx, {
      usuarioId, accion: 'com.visita', entidad: 'com_visitas', entidadId: v.id,
      datos: { comercialId, clienteId, resultado },
    })
    return v
  })

  return confirmarGuardado('com_visitas', visita.id, {
    que: 'la visita', campo: 'resultado', esperado: resultado,
  })
}

export async function listarVisitas({ comercialId = null, clienteId = null, limite = 50 } = {}) {
  // Los filtros se arman aparte del SQL, cada uno con su número.
  //
  // Interpolar `$1`, `$2`… según cuántos haya, y quedarse sin parámetros en
  // el caso normal —«dame las visitas»— produce «bind message supplies 0
  // parameters». El fallo salía en la pantalla más usada del módulo y no en
  // un caso raro.
  const cond = []
  const params = []
  if (comercialId != null) { params.push(comercialId); cond.push(`v.comercial_id = $${params.length}`) }
  if (clienteId != null) { params.push(clienteId); cond.push(`v.customer_id = $${params.length}`) }
  params.push(Math.min(Number(limite) || 50, 500))

  return query(
    // El nombre del cliente sale del `LEFT JOIN`, que ya da NULL si no hay.
    // Envolverlo en un `CASE ... IS NULL THEN NULL ELSE ... END` no añade nada
    // y sí crea problemas: un `CASE` con un NULL sin tipo es sintaxis que
    // depende del analizador, y eso no se escribe en una consulta que se lee
    // para entenderla.
    `SELECT v.*, u.full_name AS comercial, c.name AS cliente, c.code AS cliente_code
       FROM com_visitas v
       JOIN com_perfiles cp ON cp.id = v.comercial_id
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN customers c ON c.id = v.customer_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY v.visita_at DESC
      LIMIT $${params.length}`,
    params,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// RANKING Y PUNTOS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El ranking.
 *
 * Sale de `com_ranking`, que ordena por `tiene_objetivo` primero. Eso no es un
 * detalle: es lo que hace que un comercial sin objetivo vaya detrás SIEMPRE,
 * sin depender de ningún número y sin que el orden cambie según el plan de
 * la consulta.
 *
 * El orden es por CUMPLIMIENTO, no por importe. Una zona pequeña no tiene por
 * qué salir por debajo de una grande, y un comercial con el número de ventas
 * encima compite con el número en vez de con el cliente.
 */
export async function ranking({ desde, hasta } = {}) {
  const p = desde && hasta ? { desde, hasta } : mesEnCurso()

  // ───────────────────────────────────────────────────────────────────────────
  //
  // POR QUÉ NO SE LEE `com_ranking`
  //
  // Antes esto devolvía la tabla `com_ranking` tal cual. El problema es que esa
  // tabla es una FOTO: de lo que había en el momento de construirla. Y la
  // función aceptaba `desde` y `hasta`, los devolvía en la respuesta, y luego
  // no los usaba para nada.
  //
  // Eso no es un detalle: es decir una cosa y enseñar otra. Se pedía el ranking
  // de noviembre y salían las ventas de octubre, con el puesto que le tocaba a
  // octubre. Y el objetivo salía a NULL aunque existiera, porque la foto se
  // había hecho antes de ponerlo. Nadie se da cuenta en una pantalla: los
  // números parecen de alguien.
  //
  // ───────────────────────────────────────────────────────────────────────────
  //
  // AHORA SE CALCULA
  //
  // Contra `com_hechos()`, la MISMA función que usa la ficha del comercial. Es
  // a propósito: el ranking y la ficha tienen que decir lo mismo, y para
  // fijarlo que calculen con la misma regla. Si mañana cambia la regla, cambia
  // para los dos o no cambia para ninguno.
  //
  // Los datos de quién es cada uno salen de `com_perfiles`, que es la lista
  // viva. La foto solo se queda como registro histórico.
  //
  // LA ZONA SE LEE DE `com_comercial_zonas`, NO DE `home_zona_id`.
  //
  // Esto estaba mal y por eso el ranking decía que un comercial no tenía
  // ninguna zona después de habérsela asignado. `home_zona_id` es lo que se
  // marca en el MAPA, no la lista de zonas del comercial: un comercial puede
  // llevar tres zonas y tener `home_zona_id` a NULL si no se marcó ninguna
  // como principal, y entonces el ranking lo pintaba sin zona. La escritura
  // ya guardaba bien en `com_comercial_zonas`; lo que no leía era de ahí.
  //
  // Se lee también `home_zona_id` como respaldo, y por orden: primero la
  // principal, después las demás. Así el ranking enseña la zona que el
  // comercial considera suya arriba, sin perder el resto.
  const filas = await query(
    `SELECT cp.id AS comercial_id, cp.user_id, u.username, u.full_name, cp.is_active,
            cp.home_zona_id,
            hm.name AS zona_principal,
            (SELECT string_agg(z.name, ' · ' ORDER BY cz.es_principal DESC, z.name)
               FROM com_comercial_zonas cz
               JOIN com_zonas z ON z.id = cz.zona_id
              WHERE cz.comercial_id = cp.id) AS zonas
       FROM com_perfiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN com_zonas hm ON hm.id = cp.home_zona_id
      WHERE cp.is_active
      ORDER BY u.full_name`)

  const comerciales = []
  for (const f of filas) {
    const h = await hechos(f.comercial_id, p.desde, p.hasta)
    const o = await one(
      `SELECT target_amount, target_units, target_visits
         FROM com_objetivos
        WHERE comercial_id = $1 AND is_active
          AND period_start <= $3::date AND period_end >= $2::date
        ORDER BY period_start DESC LIMIT 1`,
      [f.comercial_id, p.desde, p.hasta])

    // Sin objetivo no hay cumplimiento que calcular. Poner 0 % sería inventar
    // una nota sobre alguien a quien no se le puso nota.
    const objetivo = o ? (o.target_amount === null ? null : Number(o.target_amount)) : null
    const pct = objetivo && objetivo > 0
      ? Number(((h.importe / objetivo) * 100).toFixed(1))
      : null

    comerciales.push({
      comercialId: f.comercial_id,
      userId: f.user_id,
      username: f.username,
      nombre: f.full_name,
      // `zona` es la que se enseña y la que se usaba para agrupar: primero la
      // principal declarada, y si no hay ninguna marcada, la lista de
      // `com_comercial_zonas`. Antes se leía solo `home_zona_id` y por eso un
      // comercial con zonas guardadas salía sin zona en el ranking.
      zona: f.zonas || f.zona_principal || null,
      puesto: 0,
      tieneObjetivo: !!o,
      objetivo,
      objetivoUnidades: o && o.target_units !== null ? Number(o.target_units) : null,
      importe: h.importe,
      pedidos: h.pedidos,
      unidades: h.unidades,
      visitas: h.visitas,
      clientesDistintos: h.clientesDistintos,
      // NULL aquí es «no lo sé». En la pantalla sale «—».
      cumplimientoPct: pct,
      cumplimientoTexto: pct === null
        ? '—'
        : (pct >= 100 ? `${pct.toFixed(1)}% ✓` : `${pct.toFixed(1)}%`),
      // `puntos` es el cálculo en vivo (por eso siempre cuadra con la pantalla
      // de ficha). `puntosOtorgados` es lo que hay GUARDADO en `com_puntos`,
      // anclado a cada visita, pedido o cliente con su `ref_id` e índice único.
      //
      // Los dos se enseñan, y no se mezclan: uno es lo que el sistema calcularía
      // ahora, y el otro lo que ha dejado registrado. Si se sustituyera uno por
      // otro, se perdería justo la propiedad de no duplicar.
      puntos: Number((await one(
        'SELECT COALESCE(com_puntos_de($1::int, $2::date, $3::date), 0) AS p',
        [f.comercial_id, p.desde, p.hasta]))?.p ?? 0),
      puntosOtorgados: Number((await one(
        'SELECT COALESCE(SUM(puntos), 0) AS p FROM com_puntos'
        + ' WHERE comercial_id = $1 AND period_start <= $3::date AND period_end >= $2::date',
        [f.comercial_id, p.desde, p.hasta]))?.p ?? 0),
    })
  }

  // El puesto es por CUMPLIMIENTO, y sin objetivo no hay cumplimiento: quien no
  // tiene nota no compite por la nota. Se quedan al final, por nombre, que es
  // un orden estable: el mismo grupo sale siempre en el mismo sitio.
  const conNota = comerciales.filter((c) => c.cumplimientoPct !== null)
  const sinNota = comerciales.filter((c) => c.cumplimientoPct === null)
  conNota.sort((a, b) => b.cumplimientoPct - a.cumplimientoPct
    || b.importe - a.importe || String(a.nombre).localeCompare(String(b.nombre)))
  sinNota.sort((a, b) => b.importe - a.importe || String(a.nombre).localeCompare(String(b.nombre)))
  ;[...conNota, ...sinNota].forEach((c, i) => { c.puesto = i + 1 })

  return { desde: p.desde, hasta: p.hasta, comerciales }
}

/**
 * Los puntos de un comercial en un periodo.
 *
 * Se calculan con `com_puntos_de()`. Nadie teclea un número: un sistema de
 * premios cuyo número se puede escribir es una promesa, no un sistema.
 */
export async function puntosDe(comercialId, { desde, hasta } = {}) {
  const p = desde && hasta ? { desde, hasta } : mesEnCurso()
  const total = await one(
    'SELECT com_puntos_de($1::int, $2::date, $3::date) AS puntos', [comercialId, p.desde, p.hasta],
  )
  // El detalle lo produce `com_puntos_detalle()`, que es la MISMA funcion que
  // hay detras del total. Antes venia de la tabla `com_puntos`, que solo se
  // llena al conceder, y la respuesta normal era un total sin desglose: dos
  // numeros distintos que ademas no sumaban.
  const detalle = await query(
    `SELECT regla_id, regla, metrica, puntos, umbral, tope, logrado, puntos_otorgados
       FROM com_puntos_detalle($1::int, $2::date, $3::date)`,
    [comercialId, p.desde, p.hasta],
  )
  return {
    desde: p.desde, hasta: p.hasta,
    puntos: Number(total.puntos),
    // `puntos` es lo que VALE cada regla; `otorgados` es lo que entregó. El
    // que tiene que sumar con el total es `otorgados`.
    detalle: detalle.map((d) => ({
      reglaId: d.regla_id,
      regla: d.regla,
      metrica: d.metrica,
      puntos: Number(d.puntos),
      umbral: Number(d.umbral),
      tope: d.tope === null ? null : Number(d.tope),
      logrado: Number(d.logrado),
      otorgados: Number(d.puntos_otorgados),
    })),
  }
}

/**
 * Guardar los puntos de un periodo.
 *
 * Es una CONCRETA de un cálculo, no una fuente de verdad. La verdad es
 * `com_puntos_de()`. Se guarda para poder decir «octubre: 320 puntos» sin
 * recalcular, y para que un bono ya pagado siga ahí aunque cambien las reglas.
 */
export async function concederPuntos({ comercialId, desde, hasta, usuarioId = null }) {
  const p = desde && hasta ? { desde, hasta } : mesEnCurso()

  const guardado = await transaction(async (tx) => {
    const calculados = await tx.one(
      'SELECT com_puntos_de($1::int, $2::date, $3::date) AS puntos', [comercialId, p.desde, p.hasta],
    )
    const puntos = Number(calculados.puntos)
    if (puntos <= 0) return []

    const reglas = await tx.query('SELECT * FROM com_reglas_puntos WHERE is_active ORDER BY orden, id')
    const salida = []
    for (const r of reglas) {
      const ya = await tx.one(
        'SELECT id FROM com_puntos WHERE comercial_id = $1 AND regla_id = $2 AND period_start = $3::date',
        [comercialId, r.id, p.desde],
      )
      if (ya) continue
      const fila = await tx.one(
        `INSERT INTO com_puntos (comercial_id, regla_id, period_start, period_end, puntos, motivo)
         VALUES ($1,$2,$3::date,$4::date,$5,$6) RETURNING *`,
        [comercialId, r.id, p.desde, p.hasta, puntos / reglas.length,
          `Regla «${r.nombre}» del periodo ${p.desde} a ${p.hasta}`],
      )
      salida.push(fila)
    }
    await registrar(tx, {
      usuarioId, accion: 'com.puntos_concedidos', entidad: 'com_puntos',
      datos: { comercialId, puntos, reglas: salida.length },
    })
    return salida
  })

  return { puntos: guardado.length ? guardado.reduce((a, g) => a + Number(g.puntos), 0) : 0, guardados: guardado.length }
}

/** Lo que va bien y lo que va mal, sin adornos. */
export async function estadisticas() {
  const [porResultado, zonas, afins, reglas] = await Promise.all([
    query(`SELECT resultado, COUNT(*) AS n FROM com_visitas GROUP BY resultado ORDER BY n DESC`),
    query(
      `SELECT z.id, z.name, z.kind,
              (SELECT COUNT(*) FROM com_perfiles p WHERE p.home_zona_id = z.id AND p.is_active) AS comerciales,
              COALESCE((SELECT array_agg(idioma_code) FROM com_zona_idiomas zi WHERE zi.zona_id = z.id), '{}') AS idiomas
         FROM com_zonas z WHERE z.is_active ORDER BY z.name`,
    ),
    query('SELECT * FROM com_afinidades ORDER BY zona, full_name'),
    query('SELECT * FROM com_reglas_puntos WHERE is_active ORDER BY orden'),
  ])

  return {
    visitasPorResultado: porResultado.map((v) => ({
      ...v, n: Number(v.n), nombre: RESULTADOS[v.resultado] ?? v.resultado,
    })),
    zonas,
    afinidades: afins,
    reglas,
  }
}
/**
 * OTORGAR PUNTOS ANCLADOS AL EVENTO.
 *
 * ── POR QUÉ NO SE CALCULA Y SE GUARDA ───────────────────────────────────────
 *
 * Calcular y guardar sin más parece más rápido, pero la fila guardada dice
 * «2 puntos por una visita» sin decir CUÁL visita. Recalcular al mes
 * siguiente no puede saber si ya se contaron, así que vuelve a contarlos. Por
 * eso cada fila lleva `ref_tipo` + `ref_id`, y un índice único impide que el
 * mismo evento puntúe dos veces por la misma regla.
 *
 * No es que el código seportsa: es que la base no lo permite.
 *
 * `por_cliente` se ancla al cliente: un cliente nuevo puntúa una vez, y da igual
 * cuántas visitas tenga. `cumple_objetivo` NO se ancla a nada, porque depende
 * de un periodo y no de un hecho: se guarda aparte, y su unicidad es por
 * comercial + periodo.
 */
export async function otorgarPuntos({ comercialId, periodoInicio, periodoFin }) {
  const p = { desde: periodoInicio, hasta: periodoFin }
  const hechos = []
  const eventos = [
    {
      regla: 'por_visita', refTipo: 'com_visitas', puntos: 2,
      sql: `SELECT v.comercial_id AS comercial, v.id AS ref, 'Visita #' || v.id
              || ' · ' || COALESCE(v.resultado, '') AS motivo
               FROM com_visitas v
              WHERE v.comercial_id = $1 AND v.visita_fecha BETWEEN $2 AND $3`,
    },
    {
      regla: 'por_pedido', refTipo: 'sales_orders', puntos: 5,
      sql: `SELECT c.comercial_id AS comercial, o.id AS ref, 'Pedido ' || o.code AS motivo
               FROM sales_orders o JOIN customers c ON c.id = o.customer_id
              WHERE c.comercial_id = $1 AND o.created_at::date BETWEEN $2 AND $3`,
    },
    {
      regla: 'por_cliente', refTipo: 'customers', puntos: 10,
      sql: `SELECT c.comercial_id AS comercial, c.id AS ref, 'Cliente ' || c.code AS motivo
               FROM customers c
              WHERE c.comercial_id = $1 AND c.created_at::date BETWEEN $2 AND $3`,
    },
  ]

  for (const e of eventos) {
    const filas = await query(e.sql, [comercialId, p.desde, p.hasta])
    for (const f of filas) {
      hechos.push(f)
      await query(
        `INSERT INTO com_puntos (comercial_id, regla_id, regla_code, period_start, period_end,
                                 puntos, motivo, ref_tipo, ref_id, awarded_at)
         SELECT $1, r.id, $2, $3, $4, $5, $6, $7, $8, now()
           FROM com_reglas_puntos r
          WHERE r.code = $2 AND r.is_active
         ON CONFLICT DO NOTHING`,
        [comercialId, e.regla, p.desde, p.hasta, e.puntos, f.motivo, e.refTipo, f.ref],
      )
    }
  }

  const total = await one(
    `SELECT COALESCE(SUM(puntos), 0) AS p FROM com_puntos
      WHERE comercial_id = $1 AND period_start = $2 AND period_end = $3`,
    [comercialId, p.desde, p.hasta],
  )
  return { eventos: hechos.length, puntos: Number(total.p) }
}
