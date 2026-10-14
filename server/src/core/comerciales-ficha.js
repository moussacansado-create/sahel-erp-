/**
 * FICHA DE UN COMERCIAL
 *
 * Fichero nuevo, y a propósito. `core/comerciales.js` y `core/zonas.js` están
 * verificados con 128 comprobaciones entre los dos y no se tocan: meter aquí
 * media ficha dejaría el módulo partido en dos sitios que hay que abrir para
 * entender una zona.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ESTA FICHA NO CALCULA NADA
 *
 * Todo lo que enseña sale de funciones y vistas que ya existen y que están
 * probadas:
 *
 *   · los hechos,      de `com_hechos()`          —ventas, pedidos, visitas…
 *   · los puntos,      de `com_puntos_de()`       —reglas de `point_rules`
 *   · el puesto,       de `com_ranking`
 *   · la región,       de `fn_region_de()`
 *   · las zonas,       de `com_comercial_zonas`
 *   · el cumplimiento, de `com_progreso`
 *
 * Si aquí se dividiera una vez para «sacarla rápido», habría dos verdades sobre
 * el mismo número y algún día no coincidirían. Lo que no se puede calcular en
 * dos sitios, no se calcula en dos sitios.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LO QUE ESTA FICHA NO HACE, Y CÓMO SE DICE
 *
 * · NO rellena `customers.comercial_id`. Está en `NULL` para todos los clientes
 *   yrellenarlo sería inventar una cartera comercial que no existe.
 *
 * · NO deduce la zona de un cliente. `customers.zone_id` existe y está en
 *   `NULL` para todos. Deducirla —por dirección, por nombre, por lo que sea —
 *   sería inventar la pertenencia territorial de una empresa real.
 *
 * Cuando eso falte, la sección se devuelve vacía PERO DICIÉNDOLO, con un
 * `motivo` que explica qué falta. Una lista vacía sin explicación parece un
 * fallo; una lista vacía que dice por qué es una respuesta.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LOS FILTROS DE PERIODO TOCAN LO TEMPORAL Y SOLO LO TEMPORAL
 *
 * Las ventas, las visitas y los puntos cambian con el periodo. Las zonas, los
 * idiomas y los clientes NO cambian nunca con el periodo: un comercial sigue
 * teniendo las mismas zonas el día 1 y el día 30. Mezclarlos haría que al cambiar
 * de trimestre desapareciera gente del mapa, que es el peor sitio posible para
 * que algo desaparezca.
 *
 */

import { query, one, closeDb } from '../db/client.js'
import { registrarAuditoria as registrar } from './comerciales-auditoria.js'

export { query, one, closeDb }

export class ErrorFicha extends Error {
  constructor(mensaje, { codigo = 'ERROR_FICHA', estado = 400 } = {}) {
    super(mensaje)
    this.name = 'ErrorFicha'
    this.codigo = codigo
    this.estado = estado
  }
}

/** El mismo `mesEnCurso()` de `zonas.js`, repetido aquí a propósito: es una línea. */
function rango(preset = 'MES', desde = null, hasta = null) {
  const h = new Date()
  const y = h.getFullYear()
  const m = h.getMonth()
  const t = new Date(y, m, 1)
  const f = new Date(y, m + 1, 0)

  if (String(preset).toUpperCase() === 'PERSONALIZADO') {
    if (!desde || !hasta) {
      throw new ErrorFicha('Un período personalizado necesita las dos fechas.', { codigo: 'PERIODO_INCOMPLETO' })
    }
    if (String(hasta) < String(desde)) {
      throw new ErrorFicha(`El período está del revés: del ${desde} al ${hasta}.`, { codigo: 'PERIODO_INVALIDO' })
    }
    return { preset: 'PERSONALIZADO', desde, hasta }
  }
  return {
    preset: String(preset).toUpperCase(),
    desde: desde ?? t.toISOString().slice(0, 10),
    hasta: hasta ?? f.toISOString().slice(0, 10),
  }
}

/**
 * La ficha completa de un comercial.
 *
 * @param {number} comercialId  el id de `com_perfiles`, no el de `users`
 * @param {object} opciones     { periodo, desde, hasta }
 */
export async function fichaComercial(comercialId, { periodo = 'MES', desde, hasta } = {}) {
  const p = rango(periodo, desde, hasta)
  const id = Number(comercialId)

  if (!Number.isInteger(id) || id <= 0) {
    throw new ErrorFicha(`«${comercialId}» no es un identificador de comercial.`, {
      codigo: 'ID_INVALIDO', estado: 400,
    })
  }

  // ─── 1 · LA PERSONA ────────────────────────────────────────────────────────
  //
  // Si no existe, se responde con un error CONTROLADO y su código. Un 500 sin
  // cuerpo sería «algo se ha roto», que es justo lo que hay que evitar: aquí
  // no se ha roto nada, simplemente no hay nadie con ese identificador.
  //
  const persona = await one(
    `SELECT cp.id, cp.user_id, cp.hired_on, cp.is_active, cp.notes,
            cp.home_zona_id, u.username, u.full_name, u.email, u.is_active AS usuario_activo,
            (SELECT COALESCE(array_agg(m.idioma_code ORDER BY m.idioma_code), '{}')
               FROM com_comercial_idiomas m WHERE m.comercial_id = cp.id) AS idiomas
       FROM com_perfiles cp
       JOIN users u ON u.id = cp.user_id
      WHERE cp.id = $1::int`,
    [id],
  )
  if (!persona) {
    throw new ErrorFicha(`No existe ningún comercial con el identificador ${id}.`, {
      codigo: 'COMERCIAL_NO_EXISTE', estado: 404,
    })
  }

  // ─── 2 · SUS ZONAS, TODAS ────────────────────────────────────────────────
  //
  // De `com_comercial_zonas`, NO de `home_zona_id`.
  //
  // La diferencia es la diferencia entre un comercial y una persona: `home_
  // zona_id` es el número del que cuelga del mapa, y `com_comercial_zonas` es
  // todo lo que cubre. Un comercial que cubre tres zonas tiene UN home y TRES
  // zonas, y enseñar solo el home esconde dos-thirds de su trabajo.
  //
  const zonas = await query(
    `SELECT cz.zona_id AS id, cz.es_principal, cz.porcentaje, cz.desde, cz.hasta,
            z.code, z.name, z.kind, z.latitude, z.longitude,
            fn_region_de(cz.zona_id) AS region_id,
            (SELECT r.name FROM com_zonas r WHERE r.id = fn_region_de(cz.zona_id)) AS region
       FROM com_comercial_zonas cz
       JOIN com_zonas z ON z.id = cz.zona_id
      WHERE cz.comercial_id = $1::int AND cz.hasta IS NULL AND z.is_active
      ORDER BY cz.es_principal DESC, z.name`,
    [id],
  )

  // ─── 3 · SUS CLIENTES, EN DOS APARTADOS Y SIN MEZCLAR ────────────────────
  //
  // ASIGNADOS: los que tienen `comercial_id = users.id`. Hoy son cero, y se
  // dice cero. No se rellena la columna ni se dedu ce nada.
  //
  const clientesAsignados = await query(
    `SELECT c.id, c.code, c.name, c.company_name, c.address, c.phone, c.is_active,
            c.zone_id, fn_region_de(c.zone_id) AS region_id
       FROM customers c
      WHERE c.comercial_id = $1::int
      ORDER BY c.name`,
    [persona.user_id],
  )

  //
  // DE SUS ZONAS: los que pertenecen a una zona que este comercial cubre.
  //
  // El enlace es por CÓDIGO entre `customers.zone_id` → `zones.code` del ERP y
  // `com_zonas.code`. Y como `customers.zone_id` está en `NULL` para todos, el
  // resultado son cero filas.
  //
  // Con CERO FILAS no se devuelve una lista vacía sin más: se devuelve la lista
  // vacía CON un motivo, para que se pueda distinguir «no tiene clientes» de
  // «no hay a quién preguntarle», que son cosas distintas y se ven igual en una
  // tabla.
  //
  const zonasCubiertas = zonas.map((z) => z.id)
  let clientesDeZonas = []
  if (zonasCubiertas.length) {
    clientesDeZonas = await query(
      `SELECT c.id, c.code, c.name, c.company_name, c.address, c.phone, c.is_active,
              c.zone_id, c.comercial_id,
              cz.name AS zona,
              (SELECT u2.full_name FROM users u2 WHERE u2.id = c.comercial_id) AS comercial_nombre
         FROM customers c
         JOIN zones erp ON erp.id = c.zone_id
         JOIN com_zonas cz ON cz.code = erp.code
        WHERE cz.id = ANY($1::int[])
          AND (c.comercial_id IS DISTINCT FROM $2::int)
        ORDER BY cz.name, c.name`,
      [zonasCubiertas, persona.user_id],
    )
  }

  // ¿Por qué puede no haber clientes de zona? Se mira antes de contestar, para
  // poder decirlo con palabras y no con un «—».
  const conZonaEnERP = await query('SELECT count(*) AS n FROM customers WHERE zone_id IS NOT NULL')
  const sinZona = await one('SELECT count(*) AS n FROM customers WHERE zone_id IS NULL')

  const motivoSinClientesDeZona = clientesDeZonas.length
    ? null
    : (Number(conZonaEnERP[0].n) === 0
      ? `Ningún cliente tiene zona asignada: la columna customers.zone_id está vacía en los `
        + `${sinZona.n} clientes. Asignar zonas a clientes es de la Fase 3.`
      : 'Ninguno de los clientes con zona asignada cae en las zonas que cubre este comercial.')

  // ─── 4 · LO TEMPORAL ──────────────────────────────────────────────────────
  //
  // Esto SÍ depende del periodo. Y sale de las funciones de siempre.
  //
  const hechos = await one(
    'SELECT * FROM com_hechos($1::int, $2::date, $3::date)',
    [id, p.desde, p.hasta],
  )
  const puntos = await one(
    'SELECT com_puntos_de($1::int, $2::date, $3::date) AS puntos',
    [id, p.desde, p.hasta],
  )

  // El puesto y el cumplimiento, de las vistas. No se recalculan aquí.
  const progreso = await one(
    `SELECT tiene_objetivo, target_amount, target_units, cumplimiento_pct
       FROM com_progreso
      WHERE comercial_id = $1::int
        AND period_start = date_trunc('month', CURRENT_DATE)::date
      LIMIT 1`,
    [id],
  )

  const puesto = await one(
    `SELECT puesto FROM com_ranking
      WHERE comercial_id = $1::int
        AND period_start = date_trunc('month', CURRENT_DATE)::date
      LIMIT 1`,
    [id],
  )

  const objetivos = await query(
    `SELECT id, period_start, period_end, target_amount, target_units, notes, is_active
       FROM com_objetivos
      WHERE comercial_id = $1::int
      ORDER BY period_start DESC LIMIT 12`,
    [id],
  )

  const visitas = await query(
    `SELECT v.id, v.visita_fecha, v.resultado, v.notas, v.customer_id,
            c.name AS cliente
       FROM com_visitas v
       LEFT JOIN customers c ON c.id = v.customer_id
      WHERE v.comercial_id = $1::int AND v.visita_fecha BETWEEN $2::date AND $3::date
      ORDER BY v.visita_at DESC LIMIT 30`,
    [id, p.desde, p.hasta],
  )

  // ─── 5 · LO QUE SE DEVUELVE ───────────────────────────────────────────────
  //
  // `estructura` va aparte de `metricas` a propósito. Lo estructural —zonas,
  // clientes, nombre— es el mismo con cualquier periodo; lo temporal cambia.
  // Separarlo hace que un filtro mal puesto no pueda mover a nadie de sitio.
  //
  return {
    periodo: p,

    comercial: {
      id: persona.id,
      userId: persona.user_id,
      username: persona.username,
      nombre: persona.full_name,
      email: persona.email,
      idiomas: persona.idiomas ?? [],
      hiredOn: persona.hired_on ? String(persona.hired_on).slice(0, 10) : null,
      activo: persona.is_active,
      usuarioActivo: persona.usuario_activo,
      notas: persona.notes ?? null,
      homeZonaId: persona.home_zona_id,
    },

    //
    // ESTRUCTURAL. No depende del periodo, y no puede.
    //
    estructura: {
      zonas: zonas.map((z) => ({
        id: z.id,
        code: z.code,
        nombre: z.name,
        tipo: z.kind,
        lat: z.latitude === null ? null : Number(z.latitude),
        lng: z.longitude === null ? null : Number(z.longitude),
        esPrincipal: z.es_principal,
        porcentaje: z.porcentaje === null ? null : Number(z.porcentaje),
        regionId: z.region_id,
        region: z.region,
      })),
      clientesAsignados: clientesAsignados.map((c) => ({
        id: c.id, code: c.code, nombre: c.name, empresa: c.company_name,
        direccion: c.address, telefono: c.phone, activo: c.is_active,
        zonaId: c.zone_id, regionId: c.region_id,
        origen: 'ASIGNADO',
      })),
      clientesDeZonas: clientesDeZonas.map((c) => ({
        id: c.id, code: c.code, nombre: c.name, empresa: c.company_name,
        direccion: c.address, telefono: c.phone, activo: c.is_active,
        zona: c.zona,
        comercialNombre: c.comercial_nombre,
        //
        // Se marca de dónde viene. Un cliente que es de la zona pero de otro
        // comercial es información ÚTIL —reparto de carga, quién cubre a
        // quién— y sin la etiqueta parece un cliente asignado a este.
        //
        origen: 'DE_ZONA',
        esPropio: false,
      })),
      zonasCubiertas: zonas.length,
      // El porqué de una lista vacía. Sin esto, «0 clientes» y «no hay
      // asignación de zona» se ven igual.
      clientesAsignadosDisponibles: true,
      clientesDeZonasDisponibles: clientesDeZonas.length > 0,
      motivoSinClientesDeZona,
      motivoSinClientesAsignados: clientesAsignados.length
        ? null
        : 'Ningun cliente tiene comercial_id apuntando a este comercial. '
          + 'Asignar clientes a comerciales es de la Fase 3.',
    },

    //
    // TEMPORAL. Depende del periodo, y solo del periodo.
    //
    metricas: {
      tieneObjetivo: progreso?.tiene_objetivo ?? false,
      objetivo: progreso?.target_amount === null || progreso?.target_amount === undefined
        ? null : Number(progreso.target_amount),
      objetivoUnidades: progreso?.target_units === null || progreso?.target_units === undefined
        ? null : Number(progreso.target_units),
      cumplimientoPct: progreso?.cumplimiento_pct === null || progreso?.cumplimiento_pct === undefined
        ? null : Number(progreso.cumplimiento_pct),
      cumplimientoTexto: (!progreso?.tiene_objetivo || progreso?.cumplimiento_pct === null)
        ? '—'
        : `${Number(progreso.cumplimiento_pct) === Math.trunc(Number(progreso.cumplimiento_pct))
            ? Math.trunc(Number(progreso.cumplimiento_pct))
            : Number(progreso.cumplimiento_pct)} %`,
      ventas: Number(hechos.importe),
      pedidos: Number(hechos.pedidos),
      unidades: Number(hechos.unidades),
      visitas: Number(hechos.visitas),
      clientesDistintos: Number(hechos.clientes_distintos),
      diasActivos: Number(hechos.dias_activos),
      puntos: Number(puntos.puntos),
      puesto: puesto ? Number(puesto.puesto) : null,
      enLista: !!puesto,
    },

    objetivos,
    visitas,
  }
}

/**
 * Los comerciales de una zona, para la navegación inversa.
 *
 * Sale de `com_comercial_zonas`, que admite varios por zona. `home_zona_id` no
 * aparece por aquí: si aparece, un comercial deja de verse en cuanto otro es
 * responsable de la zona.
 */
export async function comercialesDeZona(zonaId) {
  return query(
    `SELECT cp.id AS comercial_id, u.id AS user_id, u.username, u.full_name,
            cz.es_principal, cz.porcentaje,
            COALESCE((SELECT array_agg(m.idioma_code ORDER BY m.idioma_code)
                        FROM com_comercial_idiomas m WHERE m.comercial_id = cp.id), '{}') AS idiomas
       FROM com_comercial_zonas cz
       JOIN com_perfiles cp ON cp.id = cz.comercial_id AND cp.is_active
       JOIN users u ON u.id = cp.user_id AND u.is_active
      WHERE cz.zona_id = $1::int AND cz.hasta IS NULL
      ORDER BY cz.es_principal DESC, u.full_name`,
    [zonaId],
  )
}