/**
 * EDICIÓN DE UN COMERCIAL
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE SE PUEDE EDITAR, Y LO QUE NO. NO ES UNA DECISIÓN ESTÉTICA.
 *
 * Se puede editar lo que es de las PERSONAS y lo que es de la ORGANIZACIÓN:
 *
 *   · sus notas;
 *   · sus idiomas;
 *   · las zonas que cubre, cuál es la principal y qué porcentaje lleva;
 *   · si está de alta o de baja.
 *
 * NO se puede editar nada de lo que es HECHOS:
 *
 *   · las visitas, los pedidos, las ventas, el cumplimiento, los puntos, el
 *     puesto. Salen de `com_hechos()`, `com_puntos_de()` y las vistas, y esa
 *     cuenta no se toca desde aquí ni aunque llegue un campo escondido.
 *
 * ¿Por qué? Porque un ranking que se puede editar a mano no es un ranking: es
 * una hoja de cálculo con pasos. Y el día que alguien corrija «por error» el
 * cumplimiento de un compañero, nadie sabrá si era un error o una取出
 * (\`que alguien lo arregló — y la confianza en el sistema se va para siempre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ UN FICHERO NUEVO
 *
 * `comerciales.js` y `zonas.js` están verificados con 110 comprobaciones entre
 * los dos. Añadirles edición al lado sería meter una mano nueva en un
 * fichero que se sabe que funciona, y no es el momento: primero que se pruebe
 * por separado, luego se integra si toca.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE SE ESCRIBE AL GUARDAR
 *
 *   · `com_perfiles`           — notas, alta/baja
 *   · `com_comercial_idiomas`  — la lista de idiomas, REEMPLAZADA entera
 *   · `com_comercial_zonas`    — las zonas, con su principal y su porcentaje
 *
 * Y NADA MÁS. Ni clientes, ni ventas, ni artículos, ni stock. Este fichero no
 * tiene ni una sentencia contra esas tablas, y eso es comprobable con `grep`.
 */

import { query, one, transaction, closeDb } from '../db/client.js'
import { registrarAuditoria as registrar } from './comerciales-auditoria.js'

export { query, one, closeDb }

export class ErrorEdicion extends Error {
  constructor(mensaje, { codigo = 'ERROR_EDICION', estado = 400 } = {}) {
    super(mensaje)
    this.name = 'ErrorEdicion'
    this.codigo = codigo
    this.estado = estado
  }
}

/**
 * Guardar la ficha de un comercial.
 *
 * Las tres escrituras van en UNA transacción. Sueltas, se puede guardar el
 * nombre y que los idiomas no se guarden, y quien mire la ficha ve una cosa y
 * quien consulte la base ve otra.
 *
 * @param {number} comercialId
 * @param {object} datos
 * @param {string} [datos.notas]
 * @param {string[]} [datos.idiomas]  lista COMPLETA: sustituye a la anterior
 * @param {boolean} [datos.activo]
 * @param {Array} [datos.zonas]  [{ zonaId, esPrincipal, porcentaje }]
 */
export async function editarComercial(comercialId, {
  notas = undefined, idiomas = undefined, activo = undefined, zonas = undefined, usuarioId = null,
} = {}) {
  const id = Number(comercialId)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ErrorEdicion(`«${comercialId}» no es un identificador de comercial.`, {
      codigo: 'ID_INVALIDO', estado: 400,
    })
  }

  const limpioIdiomas = idiomas === undefined
    ? undefined
    : [...new Set((Array.isArray(idiomas) ? idiomas : [idiomas])
      .filter(Boolean)
      .map((i) => String(i).trim().toLowerCase())
      .filter((i) => /^[a-z]{2}(-[A-Za-z]{2})?$/.test(i)))]

  // Si se manda una lista vacía es que se quiere dejar sin idiomas, y eso es
  // legítimo: un comercial recién fichado aún no habla ningún idioma del
  // catálogo. Lo que NO se puede es mandarlos mal formados.
  if (limpioIdiomas) {
    for (const i of limpioIdiomas) {
      const existe = await one('SELECT code FROM com_idiomas WHERE code = $1', [i])
      if (!existe) {
        throw new ErrorEdicion(
          `El idioma «${i}» no está en el catálogo. Los que hay: ${
            (await query('SELECT code FROM com_idiomas ORDER BY code')).map((x) => x.code).join(', ')
          }.`,
          { codigo: 'IDIOMA_DESCONOCIDO' },
        )
      }
    }
  }

  return transaction(async (tx) => {
    const perfil = await tx.one('SELECT * FROM com_perfiles WHERE id = $1 FOR UPDATE', [id])
    if (!perfil) {
      throw new ErrorEdicion(`No existe ningún comercial con el identificador ${id}.`, {
        codigo: 'COMERCIAL_NO_EXISTE', estado: 404,
      })
    }

    // ─── 1 · LA FICHA ──────────────────────────────────────────────────────
    const modificado = await tx.one(
      `UPDATE com_perfiles
          SET notes = COALESCE($2, notes),
              is_active = COALESCE($3, is_active),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, notas ?? null, activo ?? null],
    )

    // ─── 2 · LOS IDIOMAS, SUSTITUIDOS ENTEROS ─────────────────────────────
    //
    // «Sustituir» y no «añadir» a propósito: si editas la ficha y quitas un
    // idioma, quitándolo de verdad y no con una lista que crece. Una lista que
    // solo crece acaba teniendo los tres idiomas del mundo.
    //
    if (limpioIdiomas !== undefined) {
      await tx.query('DELETE FROM com_comercial_idiomas WHERE comercial_id = $1', [id])
      for (const [n, c] of limpioIdiomas.entries()) {
        await tx.query(
          `INSERT INTO com_comercial_idiomas (comercial_id, idioma_code, nativo)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, c, n === 0],
        )
      }
    }

    // ─── 3 · LAS ZONAS ────────────────────────────────────────────────────
    //
    // Se quitan todas y se ponen las que digan. Una zona que el usuario ha
    // quitado de la pantalla tiene que desaparecer de verdad, y no quedar
    // como marca de agua porque «no la hemos tocado».
    //
    if (zonas !== undefined) {
      if (!Array.isArray(zonas)) {
        throw new ErrorEdicion('La lista de zonas tiene que ser una lista.', { codigo: 'ZONAS_INVALIDAS' })
      }

      const pedidas = []
      for (const z of zonas) {
        const zonaId = Number(z.zonaId ?? z.id)
        if (!Number.isInteger(zonaId) || zonaId <= 0) {
          throw new ErrorEdicion(`«${z.zonaId ?? z.id}» no es una zona válida.`, { codigo: 'ZONA_INVALIDA' })
        }
        const existe = await tx.one('SELECT id, name FROM com_zonas WHERE id = $1 AND is_active', [zonaId])
        if (!existe) throw new ErrorEdicion(`No existe la zona ${zonaId}.`, { codigo: 'ZONA_NO_EXISTE' })
        const pct = z.porcentaje === null || z.porcentaje === undefined ? null : Number(z.porcentaje)
        if (pct !== null && (pct < 0 || pct > 100)) {
          throw new ErrorEdicion(
            `El porcentaje de «${existe.name}» es ${pct} y tiene que estar entre 0 y 100.`,
            { codigo: 'PORCENTAJE_FUERA_DE_RANGO' },
          )
        }
        pedidas.push({ zonaId, esPrincipal: z.esPrincipal === true, porcentaje: pct, nombre: existe.name })
      }

      const principales = pedidas.filter((z) => z.esPrincipal)
      if (pedidas.length && principales.length === 0) {
        //
        // Sin principal no hay mapa: la zona que se marca en
        // `home_zona_id` sería la última que se guardó, y el usuario no habría
        // dicho ninguna.
        //
        throw new ErrorEdicion(
          pedidas.length === 1
            ? `«${pedidas[0].nombre}» tiene que ser la zona principal.`
            : 'Hay que marcar cuál de las zonas es la principal.',
          { codigo: 'SIN_ZONA_PRINCIPAL' },
        )
      }
      if (principales.length > 1) {
        throw new ErrorEdicion(
          `Hay ${principales.length} zonas marcadas como principales (${principales.map((z) => z.nombre).join(', ')}). `
          + 'Solo puede haber una.',
          { codigo: 'VARIAS_ZONAS_PRINCIPALES' },
        )
      }

      await tx.query('DELETE FROM com_comercial_zonas WHERE comercial_id = $1', [id])
      for (const z of pedidas) {
        await tx.query(
          `INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
           VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
          [id, z.zonaId, z.esPrincipal, z.porcentaje],
        )
      }

      // `home_zona_id` es lo que se marca en el mapa. Sigue a la principal, que
      // es lo que el usuario acaba de decir.
      if (principales.length === 1) {
        await tx.query(
          'UPDATE com_perfiles SET home_zona_id = $2 WHERE id = $1',
          [id, principales[0].zonaId],
        )
      } else {
        await tx.query('UPDATE com_perfiles SET home_zona_id = NULL WHERE id = $1', [id])
      }
    }

    await registrar(tx, {
      usuarioId,
      accion: 'com.ficha_editada',
      entidad: 'com_perfiles',
      entidadId: id,
      datos: { notas, idiomas: limpioIdiomas, activo, zonas: zonas?.map((z) => z.zonaId ?? z.id) ?? null },
    })

    return { ...modificado, zonasGuardadas: zonas === undefined ? null : zonas.length }
  })
}

/**
 * Quitar una zona de un comercial.
 *
 * Se borra la fila de la asignación. NO se borra la zona, ni sus clientes, ni
 * su historial: el punto 19 de la especificación dice exactamente eso.
 */
export async function quitarZona(comercialId, zonaId, usuarioId = null) {
  const id = Number(comercialId)
  const zid = Number(zonaId)
  if (!Number.isInteger(id) || !Number.isInteger(zid)) {
    throw new ErrorEdicion('Faltan identificadores válidos.', { codigo: 'ID_INVALIDO' })
  }

  return transaction(async (tx) => {
    const zona = await tx.one(
      `SELECT cz.*, z.name AS zona_nombre FROM com_comercial_zonas cz
         JOIN com_zonas z ON z.id = cz.zona_id
        WHERE cz.comercial_id = $1 AND cz.zona_id = $2`,
      [id, zid],
    )
    if (!zona) {
      throw new ErrorEdicion(
        `Ese comercial no tiene asignada esa zona.`, { codigo: 'ZONA_NO_ASIGNADA' },
      )
    }

    await tx.query('DELETE FROM com_comercial_zonas WHERE comercial_id = $1 AND zona_id = $2', [id, zid])

    // Si era la principal, `home_zona_id` se queda sin apuntar a nada. Dejarlo
    // apuntando a una zona que ya no cubre sería mintiendo sobre el mapa.
    if (zona.es_principal) {
      await tx.query('UPDATE com_perfiles SET home_zona_id = NULL WHERE id = $1', [id])
    }

    // Ni una escritura fuera de las tablas del módulo.
    await registrar(tx, {
      usuarioId, accion: 'com.zona_quitada', entidad: 'com_comercial_zonas',
      datos: { comercialId: id, zonaId: zid, zona: zona.zona_nombre, eraPrincipal: zona.es_principal },
    })

    return { quitada: zona.zona_nombre, eraPrincipal: zona.es_principal }
  })
}
// ═══════════════════════════════════════════════════════════════════════════
// GESTIÓN DE ASIGNACIONES DESDE LA ZONA
//
// Esto es lo que hace el mapa cuando se hace clic en una región y luego en una
// zona: se ven los comerciales que la cubren, se ven los que NO la cubren,
// y se elige. La relación es de muchos a muchos, y aquí se gestiona desde el
// lado de la zona; desde el lado del comercial la gestiona `editarComercial()`.
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una zona con sus comerciales, los que la cubren y los que están libres.
 *
 * La lista de DISPONIBLES es la que hace útil la pantalla: sin ella, para
 * asignar hay que acordarse de un identificador. Y solo salen los que están de
 * alta, porque asignarle una zona a alguien que no trabaja no es una
 * asignación, es un error.
 */
export async function gestionDeZona(zonaId) {
  const zona = await one(
    `SELECT z.id, z.code, z.name, z.kind, z.latitude, z.longitude, z.poligono,
            z.nivel, z.parent_id,
            (SELECT r.name FROM com_zonas r WHERE r.id = z.parent_id) AS region,
            (SELECT r.id   FROM com_zonas r WHERE r.id = z.parent_id) AS region_id
       FROM com_zonas z WHERE z.id = $1::int AND z.is_active`,
    [zonaId],
  )
  if (!zona) {
    throw new ErrorEdicion(`No existe la zona ${zonaId}.`, { codigo: 'ZONA_NO_EXISTE', estado: 404 })
  }

  // `phone` es lo que hace falta para LLAMAR a quien lleva la zona desde la
  // ficha, que es justo cuando se consulta. Y `clientes` son los clientes REALES
  // de este comercial en ESTA zona, contados de `customers`: no de
  // `com_zonas.clientes_potenciales`, que es una estimación escrita a mano y
  // por tanto no sirve para decir «aquí trabajan estos clientes».
  const asignados = await query(
    `SELECT cp.id AS comercial_id, u.id AS user_id, u.username, u.full_name,
            cp.phone, u.email,
            COALESCE(cc.n, 0)::int AS clientes,
            cz.es_principal, cz.porcentaje, cz.desde,
            COALESCE((SELECT array_agg(m.idioma_code ORDER BY m.idioma_code)
                        FROM com_comercial_idiomas m WHERE m.comercial_id = cp.id), '{}') AS idiomas
       FROM com_comercial_zonas cz
       JOIN com_perfiles cp ON cp.id = cz.comercial_id AND cp.is_active
       JOIN users u ON u.id = cp.user_id AND u.is_active
      LEFT JOIN (
        SELECT comercial_id, zone_id, count(*)::int AS n
          FROM customers WHERE is_active
         GROUP BY comercial_id, zone_id
      ) cc ON cc.comercial_id = cp.id AND cc.zone_id = cz.zona_id
      WHERE cz.zona_id = $1::int AND cz.hasta IS NULL
      ORDER BY cz.es_principal DESC, u.full_name`,
    [zonaId],
  )

  const ocupados = new Set(asignados.map((a) => a.comercial_id))
  const disponibles = await query(
    `SELECT cp.id AS comercial_id, u.username, u.full_name,
            COALESCE((SELECT array_agg(m.idioma_code ORDER BY m.idioma_code)
                        FROM com_comercial_idiomas m WHERE m.comercial_id = cp.id), '{}') AS idiomas
       FROM com_perfiles cp
       JOIN users u ON u.id = cp.user_id
      WHERE cp.is_active AND u.is_active
        AND NOT (cp.id = ANY($1::int[]))
      ORDER BY u.full_name`,
    [[...ocupados]],
  )

  // Las zonas hermanas: para asignar a la vez que se quita una, sin volver atrás.
  const hermanas = await query(
    `SELECT z.id, z.code, z.name FROM com_zonas z
      WHERE z.parent_id = $1::int AND z.is_active ORDER BY z.name`,
    [zona.parent_id ?? zona.id],
  )

  return {
    zona: {
      id: zona.id, code: zona.code, nombre: zona.name, tipo: zona.kind,
      lat: zona.latitude === null ? null : Number(zona.latitude),
      lng: zona.longitude === null ? null : Number(zona.longitude),
      region: zona.region, regionId: zona.region_id,
    },
    asignados,
    disponibles,
    hermanas,
    // Si dos comerciales tienen EXACTAMENTE el mismo porcentaje, la zona no
    // tiene un responsable: tiene dos candidatos. Se dice en voz alta en vez
    // de señalar al primero que salió de la consulta, que antes era lo que
    // pasaba y por eso una zona acababa con un perfil de prueba al frente.
    empate: (() => {
      const conPct = asignados.filter((a) => a.porcentaje !== null && Number(a.porcentaje) > 0)
      if (conPct.length < 2) return null
      const top = Math.max(...conPct.map((a) => Number(a.porcentaje)))
      const tantos = conPct.filter((a) => Number(a.porcentaje) === top)
      return tantos.length > 1 ? tantos.length : null
    })(),
  }
}

/** Asignar (o cambiar el reparto de) un comercial a una zona. */
export async function asignarAZona(comercialId, zonaId, {
  esPrincipal = false, porcentaje = null, usuarioId = null,
} = {}) {
  const cid = Number(comercialId)
  const zid = Number(zonaId)
  if (!Number.isInteger(cid) || !Number.isInteger(zid)) {
    throw new ErrorEdicion('Faltan identificadores válidos.', { codigo: 'ID_INVALIDO' })
  }
  const pct = porcentaje === null || porcentaje === undefined ? null : Number(porcentaje)
  if (pct !== null && (pct < 0 || pct > 100)) {
    throw new ErrorEdicion(`El porcentaje es ${pct} y tiene que estar entre 0 y 100.`, {
      codigo: 'PORCENTAJE_FUERA_DE_RANGO',
    })
  }

  return transaction(async (tx) => {
    const zona = await tx.one('SELECT id, name FROM com_zonas WHERE id = $1 AND is_active', [zid])
    if (!zona) throw new ErrorEdicion(`No existe la zona ${zid}.`, { codigo: 'ZONA_NO_EXISTE' })
    const com = await tx.one(
      `SELECT cp.id FROM com_perfiles cp JOIN users u ON u.id = cp.user_id
        WHERE cp.id = $1 AND cp.is_active AND u.is_active`, [cid])
    if (!com) throw new ErrorEdicion('Ese comercial no existe o está de baja.', { codigo: 'COMERCIAL_NO_EXISTE' })

    // Si viene como principal, deja de serlo en el resto de zonas. Una zona
    // tiene UN responsable, y el comercial UNO también: si no, el mapa no
    // sabe cuál marcar.
    if (esPrincipal) {
      await tx.query(
        'UPDATE com_comercial_zonas SET es_principal = FALSE WHERE comercial_id = $1 AND es_principal', [cid])
      await tx.query('UPDATE com_perfiles SET home_zona_id = $2 WHERE id = $1', [cid, zid])
    }

    const fila = await tx.one(
      `INSERT INTO com_comercial_zonas (comercial_id, zona_id, es_principal, porcentaje, desde)
       VALUES ($1,$2,$3,$4,CURRENT_DATE)
       ON CONFLICT (comercial_id, zona_id, desde) DO UPDATE
         SET es_principal = EXCLUDED.es_principal, porcentaje = EXCLUDED.porcentaje
       RETURNING *`,
      [cid, zid, esPrincipal, pct],
    )

    await registrar(tx, {
      usuarioId, accion: 'com.asignacion_creada',
      entidad: 'com_comercial_zonas', entidadId: fila.id,
      datos: { comercialId: cid, zonaId: zid, zona: zona.name, esPrincipal, porcentaje: pct },
    })
    return fila
  })
}

/**
 * Quitar un comercial de una zona.
 *
 * Quitar una zona a un comercial NO lo borra del sistema: solo deshace la
 * asignación. El comercial sigue ahí, con su usuario, su ficha y su historial,
 * y puede recibir otra zona mañana.
 */
export async function quitarDeZona(comercialId, zonaId, usuarioId = null) {
  const cid = Number(comercialId)
  const zid = Number(zonaId)
  return transaction(async (tx) => {
    const fila = await tx.one(
      `SELECT cz.es_principal, z.name AS zona
         FROM com_comercial_zonas cz JOIN com_zonas z ON z.id = cz.zona_id
        WHERE cz.comercial_id = $1 AND cz.zona_id = $2`, [cid, zid])
    if (!fila) {
      throw new ErrorEdicion('Ese comercial no tiene asignada esa zona.', { codigo: 'ZONA_NO_ASIGNADA' })
    }

    await tx.query('DELETE FROM com_comercial_zonas WHERE comercial_id = $1 AND zona_id = $2', [cid, zid])

    if (fila.es_principal) {
      await tx.query('UPDATE com_perfiles SET home_zona_id = NULL WHERE id = $1', [cid])
    }

    await registrar(tx, {
      usuarioId, accion: 'com.asignacion_quitada',
      entidad: 'com_comercial_zonas',
      datos: { comercialId: cid, zonaId: zid, zona: fila.zona, eraPrincipal: fila.es_principal },
    })
    return { quitada: fila.zona }
  })
}
