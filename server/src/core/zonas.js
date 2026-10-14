/**
 * ZONAS · CONSULTAS PARA EL MAPA.
 *
 * En fichero aparte y a propósito. `core/comerciales.js` está verificado con
 * 64 comprobaciones y no se toca; este módulo se apoya en las vistas de la 027
 * y la 028 y añade lo que el mapa necesita.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LOS PERÍODOS, EN UN SITIO SOLO
 *
 * Hoy, semana, mes, trimestre, año y personalizado. Se calculan aquí y en
 * ninguna parte más, porque en cuanto cada pantalla calcula «el mes» por su
 * cuenta, el mapa dice una cosa, el ranking otra y el filtro otra. Y el día
 * que el mes cambiara a todos a la vez, la mitad de las cifras quedarían en el
 * mes anterior.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * UNA ZONA NO SE CUENTA CON LA DE AL LADO
 *
 * `com_hechos_zona()` ya lee por `zona_id`. Aquí se le pasa UN id y se
 * comprueba que lo que sale es de esa zona. En una prueba: se plantan ventas
 * en dos zonas y se mira que cada una ve solo las suyas. Es el fallo más caro
 * de un ERP con zonas, porque no da error: da un número plausible de la zona
 * equivocada.
 */

import { query, one, transaction, closeDb } from '../db/client.js'
import { registrarAuditoria as registrar, confirmarGuardado } from './comerciales-auditoria.js'

export { query, one, closeDb }

export class ErrorZona extends Error {
  constructor(mensaje, { codigo = 'ERROR_ZONA', estado = 400, detalle = null } = {}) {
    super(mensaje)
    this.name = 'ErrorZona'
    this.codigo = codigo
    this.estado = estado
    this.detalle = detalle
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PERÍODOS
// ═══════════════════════════════════════════════════════════════════════════

const iso = (d) => d.toISOString().slice(0, 10)

/**
 * Los seis períodos que pidió el negocio, en un solo sitio.
 *
 * `MES` es el que se mira un lunes por la mañana, `TRIMESTRE` el que se mira
 * en la reunión de resultados, y `PERSONALIZADO` el que hace falta cuando se
 * pregunta «y en el mes de marzo, exactamente?».
 */
export function periodo(preset = 'MES', desde = null, hasta = null) {
  const hoy = new Date()
  const y = hoy.getFullYear()
  const m = hoy.getMonth()

  const P = {
    HOY: () => [iso(hoy), iso(hoy)],

    SEMANA: () => {
      // Lunes a domingo. La semana comercial que empieza en domingo deja los
      // domingos sueltos, y un domingo no es un día que nadie mire.
      const d = new Date(hoy)
      const dow = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - dow)
      const f = new Date(d); f.setDate(f.getDate() + 6)
      return [iso(d), iso(f)]
    },

    MES: () => [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))],

    TRIMESTRE: () => {
      const t = Math.floor(m / 3)
      return [iso(new Date(y, t * 3, 1)), iso(new Date(y, t * 3 + 3, 0))]
    },

    ANIO: () => [iso(new Date(y, 0, 1)), iso(new Date(y, 11, 31))],

    PERSONALIZADO: () => [desde, hasta],
  }

  const clave = String(preset ?? 'MES').toUpperCase()
  if (!P[clave]) {
    throw new ErrorZona(
      `Período desconocido: «${preset}». Los que hay son: ${Object.keys(P).join(', ')}.`,
      { codigo: 'PERIODO_DESCONOCIDO', detalle: { recibidos: preset, validos: Object.keys(P) } },
    )
  }

  const [d, h] = P[clave]()
  const desdeFinal = d ?? desde
  const hastaFinal = h ?? hasta

  if (clave === 'PERSONALIZADO' && (!desdeFinal || !hastaFinal)) {
    throw new ErrorZona('Un período personalizado necesita las dos fechas: desde y hasta.', {
      codigo: 'PERIODO_INCOMPLETO',
    })
  }
  if (desdeFinal && hastaFinal && String(hastaFinal) < String(desdeFinal)) {
    throw new ErrorZona(
      `El período está del revés: del ${desdeFinal} al ${hastaFinal}.`,
      { codigo: 'PERIODO_INVALIDO', detalle: { desde: desdeFinal, hasta: hastaFinal } },
    )
  }

  return { preset: clave, desde: desdeFinal, hasta: hastaFinal }
}

/** Los dos periodos anteriores del mismo tamaño, para poder calcular variaciones. */
export function periodosAnteriores(preset, desde, hasta) {
  const d = new Date(`${desde}T00:00:00`)
  const h = new Date(`${hasta}T00:00:00`)
  const dias = Math.max(1, Math.round((h - d) / 86400000) + 1)

  const previoFin = new Date(d); previoFin.setDate(previoFin.getDate() - 1)
  const previoIni = new Date(previoFin); previoIni.setDate(previoIni.getDate() - dias + 1)
  return { desde: iso(previoIni), hasta: iso(previoFin), dias }
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTADO PARA EL MAPA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Las nueve regiones, con TODO lo que el mapa necesita en una sola llamada.
 *
 * Una llamada y no nueve: el mapa dibuja nueve polígonos a la vez, y pedirlo
 *zonazona son nueve idas y vuelta que en un móvil se notan.
 *
 * Cada zona trae sus datos de período YA CALCULADOS. La pantalla no calcula
 * nada: pinta lo que viene. Si la pantalla calculara el cumplimiento, un día
 * redondearía distinto del ranking y habría dos verdades.
 */
export async function listarZonasMapa({ periodo: preset = 'MES', desde, hasta, comercialId = null } = {}) {
  const p = periodo(preset, desde, hasta)
  const previo = periodosAnteriores(p.preset, p.desde, p.hasta)

  const filas = await query(
    `SELECT
       f.zona_id, f.code, f.name, f.kind, f.latitude, f.longitude, z.poligono,
       f.poblacion, f.comercios_estimados, f.clientes_potenciales, f.dificultad,
       f.tiene_objetivo, f.target_amount, f.target_units, f.cumplimiento_pct,
       f.importe, f.pedidos, f.unidades, f.clientes_activos, f.clientes_totales,
       f.visitas, f.nuevos_clientes, f.comerciales_asignados, f.comerciales,
       f.potencial_pendiente,
       -- El objetivo de la zona puede ser de OTRO periodo que el que se está
       -- mirando. Por eso se busca por las fechas del filtro y no por «el de
       -- ahora»: mirar el trimestre pasado tiene que mostrar el objetivo de
       -- aquel trimestre, no el de este.
       (SELECT json_agg(json_build_object('periodo', oz.period_start || ' → ' || oz.period_end,
                                           'importe', oz.target_amount,
                                           'unidades', oz.target_units)
                         ORDER BY oz.period_start DESC)
          FROM com_objetivos_zona oz
         WHERE oz.zona_id = f.zona_id AND oz.is_active
           AND oz.period_start <= $2::date AND oz.period_end >= $1::date) AS objetivos,
       -- Ventas del periodo ANTERIOR, para la variación. Con un solo mes
       -- no hay periodo anterior con datos, y por eso sale NULL.
       (SELECT COALESCE(SUM(so.total), 0)
          FROM sales_orders so
          JOIN customers c ON c.id = so.customer_id
          JOIN zones erp ON erp.id = c.zone_id AND erp.code = f.code
         WHERE so.status <> 'CANCELLED'
           AND so.order_date BETWEEN $3::date AND $4::date) AS importe_previo,
       (SELECT COUNT(*) FROM sales_orders so
          JOIN customers c ON c.id = so.customer_id
          JOIN zones erp ON erp.id = c.zone_id AND erp.code = f.code
         WHERE so.status <> 'CANCELLED'
           AND so.order_date BETWEEN $3::date AND $4::date) AS pedidos_previo,
       (SELECT COALESCE(SUM(l.qty), 0) FROM sales_order_lines l
          JOIN sales_orders so ON so.id = l.sales_order_id
          JOIN customers c ON c.id = so.customer_id
          JOIN zones erp ON erp.id = c.zone_id AND erp.code = f.code
         WHERE so.status <> 'CANCELLED'
           AND so.order_date BETWEEN $3::date AND $4::date) AS unidades_previo
     FROM com_ficha_zona($1::date, $2::date) f
     JOIN com_zonas z ON z.id = f.zona_id
     ORDER BY f.code`,
    [p.desde, p.hasta, previo.desde, previo.hasta],
  )

  const soloConComercial = comercialId
    ? await query(
      `SELECT cz.zona_id FROM com_comercial_zonas cz
        WHERE cz.comercial_id = $1::int AND cz.hasta IS NULL`, [comercialId],
    )
    : null
  const permitidas = soloConComercial ? new Set(soloConComercial.map((r) => r.zona_id)) : null

  // ── TELÉFONOS ──────────────────────────────────────────────────────────────
  //
  // El mapa sirve para llamar a quien lleva la zona. Con el nombre no basta, y
  // `com_perfiles.phone` es NULL en todos: eso se ve, no se disimula. Se trae
  // en una consulta aparte en vez de tocar la función SQL de los hechos, porque
  // un teléfono no es un «hecho» del periodo: es un dato del contacto, y meterlo
  // en la vista de ventas lo ataría a un mes que no tiene nada que ver.
  const tel = new Map((await query('SELECT id, phone FROM com_perfiles'))
    .map((r) => [r.id, r.phone]))

  // ── CLIENTES SIN ASIGNAR ───────────────────────────────────────────────────
  //
  // Los que no son de nadie. Salen como un bloque propio y NO se reparten entre
  // los comerciales: repartirlos haría cuadrar el mapa a costa de mentir sobre
  // quién lleva qué, y ese es el dato que el mapa existe para decir.
  const sueltos = await query(
    `SELECT count(*)::int AS clientes,
            count(*) FILTER (WHERE is_active)::int AS activos
       FROM customers WHERE comercial_id IS NULL`,
  )

  // ── QUIÉN ES EL RESPONSABLE ────────────────────────────────────────────────
  //
  // Antes era `comerciales[0]`, el primero que salía. Eso es lo que hacía que
  // en Kayes pusiera a un perfil de prueba como responsable mientras el
  // comercial de verdad estaba en la lista: el orden de un array no es un cargo.
  //
  // Ahora se elige por lo que significa cada cosa, en este orden:
  //   1 · el que tiene `es_principal` — alguien lo ticked a propósito;
  //   2 · si no, el de más porcentaje — quien lleva más de la zona;
  //   3 · si no hay porcentajes, NULL. «No hay responsable» es un dato, y
  //       poner un nombre cualquiera es peor que no poner ninguno.
  const de = (z) => {
    const lista = (z.comerciales ?? []).slice()
    if (!lista.length) return null
    const principal = lista.find((c) => c.es_principal)
    if (principal) return principal
    const conPct = lista.filter((c) => Number(c.porcentaje || 0) > 0)
    if (!conPct.length) return null
    const orden = conPct.sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje))
    // Empate no es un cargo. En Kayes los dos tienen el 30 %, y quedarse con el
    // primero que salía significaba señalar a un perfil de prueba como
    // responsable de una zona. Si nadie destaca, el mapa dice que hay dos y
    // deja que la administración lo decida: el orden de un array no decide
    // quién lleva una zona.
    if (orden.length > 1 && Number(orden[0].porcentaje) === Number(orden[1].porcentaje)) {
      return { __empate: true, n: orden.length }
    }
    return orden[0]
  }

  return {
    periodo: p,
    periodoPrevio: previo,
    sinAsignar: {
      clientes: Number(sueltos[0]?.clientes ?? 0),
      activos: Number(sueltos[0]?.activos ?? 0),
    },
    zonas: filas
      .filter((z) => (permitidas ? permitidas.has(z.zona_id) : true))
      .map((z) =>({
        id: z.zona_id ?? z.id,
        code: z.code,
        nombre: z.name,
        tipo: z.kind,
        // Lo que el mapa necesita, con estos nombres y no los de la base.
        lat: Number(z.latitude),
        lng: Number(z.longitude),
        poligono: z.poligono,
        comercial: z.comerciales_asignados,
        responsable: de(z)?.nombre ?? null,
        comercialIdResponsable: de(z)?.comercial_id ?? null,
        telefonoResponsable: de(z) && de(z).comercial_id ? (tel.get(de(z).comercial_id) ?? null) : null,
        emailResponsable: de(z)?.email ?? null,
        responsableAmbiguo: de(z)?.__empate === true ? de(z).n : null,
        // Cada uno de los que pasan por la zona, con su teléfono. Una zona la
        // pueden llevar varios, y el que llama necesita saber a cuál.
        comerciales: (z.comerciales ?? []).map((c) => ({
          ...c,
          telefono: tel.get(c.comercial_id) ?? null,
          email: c.email ?? null,
        })),
        //
        // El guion se decide AQUÍ con la misma regla que en `com_ranking_zonas`:
        // sin objetivo, o sin porcentaje, guion. Nunca un cero.
        //
        // Ojo con esto: si un día el ranking y el mapa dijeran cosas distintas
        // sobre la misma zona, sería porque el texto está calculado en dos
        // sitios. Aquí está duplicado a propósito porque el mapa NO usa el
        // ranking, y la regla es de una línea.
        //
        cumplimiento: (!z.tiene_objetivo || z.cumplimiento_pct === null) ? '—'
          : Number(z.cumplimiento_pct) === Math.trunc(Number(z.cumplimiento_pct))
            ? `${Math.trunc(Number(z.cumplimiento_pct))} %`
            : `${Number(z.cumplimiento_pct)} %`,
        cumplimientoPct: z.cumplimiento_pct === null ? null : Number(z.cumplimiento_pct),
        tieneObjetivo: z.tiene_objetivo,
        objetivo: z.target_amount === null ? null : Number(z.target_amount),
        objetivoUnidades: z.target_units === null ? null : Number(z.target_units),
        objetivos: z.objetivos ?? [],
        potencial: {
          // Se devuelven tal cual, con su NULL. La pantalla decide cómo
          // enseñarlos; aquí no se rellena ni se estima nada.
          poblacion: z.poblacion,
          comerciosEstimados: z.comercios_estimados,
          clientesPotenciales: z.clientes_potenciales,
          dificultad: z.dificultad,
          pendiente: z.potencial_pendiente,
        },
        ventas: {
          importe: Number(z.importe),
          pedidos: Number(z.pedidos),
          unidades: Number(z.unidades),
          clientesActivos: Number(z.clientes_activos),
          clientesTotales: Number(z.clientes_totales),
          visitas: Number(z.visitas),
          nuevosClientes: Number(z.nuevos_clientes),
        },
        variacion: {
          importe: Number(z.importe_previo),
          pedidos: Number(z.pedidos_previo),
          unidades: Number(z.unidades_previo),
          //
          // NULL, no 0. Con un solo mes no hay periodo anterior con datos, y
          // un 0 % ahí se lee como «esta zona no crece», que es una afirmación
          // que el sistema no puede hacer. NULL es «no hay con qué comparar».
          //
          pct: (Number(z.importe_previo) > 0 && Number(z.importe) !== 0)
            ? Number((((Number(z.importe) - Number(z.importe_previo)) / Number(z.importe_previo)) * 100).toFixed(1))
            : null,
          suficienteHistorial: Number(z.importe_previo) > 0,
        },
      })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UNA ZONA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La ficha de una zona, con sus clientes.
 *
 * Los clientes vienen por `customers.zone_id`, que apunta a la tabla `zones`
 * del ERP. El puente es el código: las dos tablas llevan los mismos porque son
 * las mismas demarcaciones. Por eso `com_ficha_zona` lee por código y no por
 * id, y por eso si mañana el ERP renombra `BKO` esta ficha dirá «no ha encontrado
 * esa zona» en lugar de devolver la de al lado.
 */
export async function fichaZona(zonaId, { periodo: preset = 'MES', desde, hasta } = {}) {
  const p = periodo(preset, desde, hasta)
  const previo = periodosAnteriores(p.preset, p.desde, p.hasta)

  //
  // La ficha se lee de `com_ficha_zona`, que YA lleva los hechos del periodo
  // actual. La primera versión hacía `CROSS JOIN LATERAL com_hechos_zona()` y
  // pedíale `tiene_objetivo`, que esa función no devuelve: son cosas distintas.
  // La vista es la que junta las dos mitades sin que haya que hacerlo aquí.
  //
  //
  // La ficha es una FUNCIÓN y hay que darle el período que se está mirando.
  // Antes era una vista y cogía «hoy» sola, que es justo lo que no debe.
  //
  const zona = await one(
    `SELECT f.*, z.notes
       FROM com_ficha_zona($2::date, $3::date) f
       JOIN com_zonas z ON z.id = f.zona_id
      WHERE f.zona_id = $1::int`,
    [zonaId, p.desde, p.hasta],
  )
  if (!zona) throw new ErrorZona(`No existe la zona ${zonaId}.`, { codigo: 'ZONA_NO_EXISTE' })
  if (zona.latitude === null) {
    throw new ErrorZona(
      `«${zona.name}» no es una demarcación de Mali, así que no tiene ficha. `
      + 'Es una de las zonas de prueba.',
      { codigo: 'ZONA_SIN_MAPA', detalle: { zonaId } },
    )
  }

  const clientes = await query(
    `SELECT c.id, c.code, c.name, c.company_name, c.address, c.phone,
            c.is_active, c.latitude, c.longitude,
            COUNT(DISTINCT so.id) FILTER (
              WHERE so.status <> 'CANCELLED'
                AND so.order_date IS NOT NULL) AS pedidos_totales,
            COALESCE(SUM(so.total) FILTER (
              WHERE so.status <> 'CANCELLED'
                AND so.order_date IS NOT NULL), 0) AS importe_total,
            MAX(so.order_date) AS ultima_compra
       FROM customers c
       JOIN zones erp ON erp.id = c.zone_id AND erp.code = $1::text
       LEFT JOIN sales_orders so ON so.customer_id = c.id
      GROUP BY c.id
      ORDER BY importe_total DESC NULLS LAST, c.name`,
    [zona.code],
  )

  const visitas = await query(
    `SELECT v.id, v.visita_fecha, v.resultado, v.notas, v.customer_id,
            u.full_name AS comercial, c.name AS cliente
       FROM com_visitas v
       JOIN customers c ON c.id = v.customer_id
       JOIN zones erp ON erp.id = c.zone_id AND erp.code = $3::text
       JOIN com_perfiles cp ON cp.id = v.comercial_id
       JOIN users u ON u.id = cp.user_id
      WHERE v.visita_fecha BETWEEN $1::date AND $2::date
      ORDER BY v.visita_fecha DESC, v.visita_at DESC
      LIMIT 100`,
    [p.desde, p.hasta, zona.code],
  )

  const anterior = await one(
    `SELECT COALESCE(SUM(so.total),0) AS importe, COUNT(*) AS pedidos
       FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
       JOIN zones erp ON erp.id = c.zone_id AND erp.code = $3::text
      WHERE so.status <> 'CANCELLED' AND so.order_date BETWEEN $1::date AND $2::date`,
    [previo.desde, previo.hasta, zona.code],
  )

  const objetivos = await query(
    `SELECT id, period_start, period_end, target_amount, target_units, notas
       FROM com_objetivos_zona
      WHERE zona_id = $1::int AND is_active
      ORDER BY period_start DESC LIMIT 24`,
    [zonaId],
  )

  return {
    periodo: p,
    periodoPrevio: previo,
    zona: {
      id: zona.zona_id,
      code: zona.code,
      nombre: zona.name,
      tipo: zona.kind,
      lat: Number(zona.latitude),
      lng: Number(zona.longitude),
      poligono: zona.poligono,
      tieneObjetivo: zona.tiene_objetivo,
      objetivo: zona.target_amount === null ? null : Number(zona.target_amount),
      cumplimientoPct: zona.cumplimiento_pct === null ? null : Number(zona.cumplimiento_pct),
      cumplimiento: zona.tiene_objetivo && zona.cumplimiento_pct !== null
        ? (Number(zona.cumplimiento_pct) === Math.trunc(Number(zona.cumplimiento_pct))
          ? `${Math.trunc(Number(zona.cumplimiento_pct))} %`
          : `${Number(zona.cumplimiento_pct)} %`)
        : '—',
      potencial: {
        poblacion: zona.poblacion,
        comerciosEstimados: zona.comercios_estimados,
        clientesPotenciales: zona.clientes_potenciales,
        dificultad: zona.dificultad,
        pendiente: zona.potencial_pendiente,
      },
      comerciales: zona.comerciales ?? [],
      comercialResponsable: zona.comerciales?.[0]?.nombre ?? null,
      ventas: {
        importe: Number(zona.importe),
        pedidos: Number(zona.pedidos),
        unidades: Number(zona.unidades),
        clientesActivos: Number(zona.clientes_activos),
        clientesTotales: Number(zona.clientes_totales),
        visitas: Number(zona.visitas),
        nuevosClientes: Number(zona.nuevos_clientes),
      },
      variacion: {
        importePrevio: Number(anterior.importe),
        pedidosPrevio: Number(anterior.pedidos),
        suficienteHistorial: Number(anterior.importe) > 0,
        pct: Number(anterior.importe) > 0
          ? Number((((Number(zona.importe) - Number(anterior.importe)) / Number(anterior.importe)) * 100).toFixed(1))
          : null,
      },
      objetivos: objetivos.map((o) => ({
        id: o.id,
        desde: o.period_start, hasta: o.period_end,
        importe: o.target_amount === null ? null : Number(o.target_amount),
        unidades: o.target_units === null ? null : Number(o.target_units),
        notas: o.notas,
      })),
    },
    clientes,
    visitas,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR COMERCIAL A ZONA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Un comercial puede llevar varias zonas; cada zona tiene UN responsable.
 *
 * Las tres reglas que gobiernan esto están en índices ÚNICOS de la base, no
 * en este fichero:
 *
 *   · un comercial no lleva dos veces la misma zona  (`uniq_comercial_zona`)
 *   · un comercial tiene una sola zona principal     (`uniq_comercial_zona_principal`)
 *   · una zona tiene un solo responsable             (`uniq_zona_responsable`)
 *
 * Y están ahí a propósito. Si estuvieran en JavaScript, un script suelto que
 * insertara por la espalda las saltaría sin enterarse. En la base, no.
 *
 * POR QUÉ UNA TRANSACCIÓN
 *
 * Aquí hay TRES escrituras: bajar la marca de principal del comercial, poner
 * la asignación nueva y apuntar `home_zona_id`. Sueltas, si la segunda
 * falla la primera ya está hecha y el comercial se queda sin ninguna zona
 * principal: el mapa no marcaría ninguna, la ficha tampoco, y no habría
 * ningún error que explicarlo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * REGLA DE ESCRITURA DE SQL EN ESTE FICHERO, PARA QUE NO SE REPITA EL ERROR
 *
 * Cada consulta lleva sus parámetros EN ORDEN, del $1 al $n, SIN SALTOS, y
 * cada uno con su tipo explícito: `$1::int`, `$1::date`, `$1::text`.
 *
 * · Si sobra un parámetro, Postgres dice «bind message supplies 3 parameters,
 *   but prepared statement requires 2» —y dice cuál, pero no dónde.
 * · Si falta, dice «could not determine data type of parameter $1» —y no dice
 *   NADA de qué consulta es.
 * · Si un parámetro se usa dos veces con dos tipos distintos, se rompe.
 *
 * Las tres cosas pasaron hoy en este fichero. Aquí cada consulta se lee de
 * arriba abajo contando sus `$`.
 *
 * @param {object} datos
 * @param {number} datos.comercialId
 * @param {number} datos.zonaId
 * @param {boolean} [datos.esPrincipal]  pasa a ser la zona principal
 * @param {number|null} [datos.porcentaje] 0–100. `null` reparte a partes iguales.
 * @param {string|null} [datos.desde]   por defecto, hoy
 * @param {string|null} [datos.hasta]   `null` = sigue
 * @param {number|null} [datos.usuarioId]
 */
export async function asignarComercialAZona({
  comercialId,
  zonaId,
  esPrincipal = false,
  porcentaje = null,
  desde = null,
  hasta = null,
  notas = null,
  usuarioId = null,
}) {
  // ─── Comprobaciones que se pueden hacer ANTES de escribir ───────────────
  //
  // Todas leen una tabla y devuelven un id. Un parámetro por consulta, en
  // orden, con su tipo.
  //
  const zona = await one(
    `SELECT id, code, name FROM com_zonas
      WHERE id = $1::int AND latitude IS NOT NULL`,
    [zonaId],
  )
  if (!zona) {
    throw new ErrorZona(
      `No existe la zona ${zonaId}, o no es una demarcación de Mali.`,
      { codigo: 'ZONA_NO_EXISTE' },
    )
  }

  const perfil = await one(
    `SELECT id FROM com_perfiles WHERE id = $1::int AND is_active`,
    [comercialId],
  )
  if (!perfil) {
    throw new ErrorZona(
      'Ese comercial no existe o está de baja. Un comercial de baja no cubre zonas.',
      { codigo: 'COMERCIAL_NO_ACTIVO' },
    )
  }

  if (porcentaje !== null && (Number(porcentaje) < 0 || Number(porcentaje) > 100)) {
    throw new ErrorZona(
      `El porcentaje tiene que estar entre 0 y 100; se ha pasado ${porcentaje}.`,
      { codigo: 'PORCENTAJE_FUERA_DE_RANGO' },
    )
  }

  const desdeFinal = desde ?? new Date().toISOString().slice(0, 10)

  // ─── Las tres escrituras, juntas ────────────────────────────────────────
  //
  // `fila` guarda lo que devuelve la transacción. Si algo falla dentro, la
  // excepción sale de `transaction()` y aquí no se llega: o están las tres
  // escrituras o no hay ninguna.
  //
  let fila
  try {
    fila = await transaction(async (tx) => {
      // 1 · Si este comercial va a ser principal, deja de serlo donde lo fuera.
      //
      // Sin esto, ponerlo principal en una zona nueva lo deja con dos, y el
      // índice `uniq_comercial_zona_principal` no lo ve porque solo mira las
      // filas nuevas que entran.
      if (esPrincipal) {
        await tx.query(
          `UPDATE com_comercial_zonas SET es_principal = FALSE
            WHERE comercial_id = $1::int AND es_principal`,
          [comercialId],
        )
      }

      // 2 · La asignación. Un parámetro, un tipo, en su sitio.
      const asignada = await tx.one(
        `INSERT INTO com_comercial_zonas
           (comercial_id, zona_id, es_principal, porcentaje, desde, hasta, notas)
         VALUES ($1::int, $2::int, $3, $4, $5::date, $6::date, $7)
         ON CONFLICT (comercial_id, zona_id, desde) DO UPDATE
           SET es_principal = EXCLUDED.es_principal,
               porcentaje   = EXCLUDED.porcentaje,
               hasta        = EXCLUDED.hasta,
               notas        = EXCLUDED.notas
         RETURNING *`,
        [comercialId, zonaId, esPrincipal, porcentaje, desdeFinal, hasta, notas],
      )

      // 3 · `home_zona_id` apunta a la principal. No se cambia el significado:
      // la 027 y el ranking de comerciales ya lo leen, y no se tocan. Aquí solo
      // se mantiene apuntando a la zona buena.
      if (esPrincipal) {
        await tx.query(
          `UPDATE com_perfiles SET home_zona_id = $2::int, updated_at = now()
            WHERE id = $1::int`,
          [comercialId, zonaId],
        )
      }

      await registrar(tx, {
        usuarioId,
        accion: 'com.zona_comercial_asignado',
        entidad: 'com_comercial_zonas',
        entidadId: asignada.id,
        datos: { comercialId, zonaId, esPrincipal, porcentaje },
      })

      return asignada
    })
  } catch (e) {
    // El índice `uniq_zona_responsable` es el que impide poner dos
    // responsables. Su error dice «duplicate key», que no le dice nada a
    // quien lo lee; aquí se traduce a lo que de verdad ha pasado.
    if (String(e.message).includes('uniq_zona_responsable')) {
      throw new ErrorZona(
        `«${zona.name}» ya tiene un responsable. Quítaselo antes de poner a otro: `
        + 'una zona tiene UNO, y los demás la cubren.',
        { codigo: 'ZONA_YA_RESPONSABLE', detalle: { zonaId, zona: zona.name } },
      )
    }
    if (String(e.message).includes('uniq_comercial_zona_principal')) {
      throw new ErrorZona(
        'Ese comercial ya tiene una zona principal. Quítasela antes de poner otra.',
        { codigo: 'COMERCIAL_YA_TIENE_PRINCIPAL', detalle: { comercialId } },
      )
    }
    throw e
  }

  return confirmarGuardado('com_comercial_zonas', fila.id, {
    que: `la asignación de ${zona.name}`,
    campo: 'zona_id',
    esperado: zonaId,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// OBJETIVO DE UNA ZONA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poner el objetivo de UNA ZONA.
 *
 * No toca `com_objetivos`, que es el del COMERCIAL. Son dos mediciones
 * distintas y por eso dos tablas:
 *
 *   · el objetivo del comercial es el suyo;
 *   · el objetivo de la zona es el de la zona, y se reparte entre los que la
 *     cubren según su `porcentaje` en `com_comercial_zonas`.
 *
 * Un comercial puede tener los dos. Unirlos obligaría a decidir cuál manda, y
 * esa decisión no tiene un criterio general: depende de si el comercial lleva
 * la zona o solo la cubre mientras otro la lleva.
 *
 * @param {object} datos
 * @param {number} datos.zonaId
 * @param {string} datos.periodStart  no puede estar en pasado
 * @param {string} datos.periodEnd
 * @param {number|null} [datos.targetAmount]
 * @param {number|null} [datos.targetUnits]
 */
export async function ponerObjetivoZona({
  zonaId,
  periodStart,
  periodEnd,
  targetAmount = null,
  targetUnits = null,
  notas = null,
  usuarioId = null,
}) {
  // ─── Comprobaciones ────────────────────────────────────────────────────
  const zona = await one(
    `SELECT id, name FROM com_zonas WHERE id = $1::int`,
    [zonaId],
  )
  if (!zona) throw new ErrorZona(`No existe la zona ${zonaId}.`, { codigo: 'ZONA_NO_EXISTE' })

  if (!periodStart || !periodEnd || String(periodEnd) < String(periodStart)) {
    throw new ErrorZona(
      'El periodo no vale: la fecha final tiene que ser posterior a la inicial.',
      { codigo: 'PERIODO_INVALIDO', detalle: { periodStart, periodEnd } },
    )
  }

  if (targetAmount === null && targetUnits === null) {
    throw new ErrorZona(
      'Un objetivo de zona tiene que decir ALGO: importe o unidades. '
      + 'Uno vacío no mide nada.',
      { codigo: 'OBJETIVO_VACIO' },
    )
  }

  // El periodo empieza en texto y `hoy` también: se comparan como texto, que es
  // lo mismo y sí significa algo. `Date < string` da `false` siempre, y ese
  // silencio ya costó un bug.
  const inicio = String(periodStart).slice(0, 10)
  const hoy = new Date().toISOString().slice(0, 10)
  if (inicio < hoy) {
    throw new ErrorZona(
      `El periodo empieza el ${inicio} y hoy es ${hoy}: ese objetivo ya ha empezado y no se cambia. `
      + 'Un objetivo que se puede retocar después de ver el resultado deja de ser una medida.',
      { codigo: 'OBJETIVO_CERRADO', detalle: { periodo: inicio, hoy } },
    )
  }

  // ─── La escritura, con su auditoría, en UNA transacción ─────────────────
  const guardado = await transaction(async (tx) => {
    // ¿Hay ya uno para esta zona en este periodo? Un parámetro por tipo.
    const existente = await tx.one(
      `SELECT id FROM com_objetivos_zona
        WHERE zona_id = $1::int AND period_start = $2::date`,
      [zonaId, inicio],
    )

    // Se reescribe, no se crea otro. `RETURNING *` en las dos ramas, para que
    // abajo exista siempre una fila con la que trabajar.
    const fila = existente
      ? await tx.one(
        `UPDATE com_objetivos_zona
            SET period_end    = $2,
                target_amount = COALESCE($3, target_amount),
                target_units  = COALESCE($4, target_units),
                notas         = COALESCE($5, notas),
                is_active     = TRUE
          WHERE id = $1
          RETURNING *`,
        [existente.id, periodEnd, targetAmount, targetUnits, notas],
      )
      : await tx.one(
        `INSERT INTO com_objetivos_zona
           (zona_id, period_start, period_end, target_amount, target_units, notas)
         VALUES ($1::int, $2::date, $3::date, $4, $5, $6)
         RETURNING *`,
        [zonaId, inicio, periodEnd, targetAmount, targetUnits, notas],
      )

    await registrar(tx, {
      usuarioId,
      accion: existente ? 'com.objetivo_zona_actualizado' : 'com.objetivo_zona_creado',
      entidad: 'com_objetivos_zona',
      entidadId: fila.id,
      datos: { zonaId, inicio, targetAmount, targetUnits },
    })

    return fila
  })

  return confirmarGuardado('com_objetivos_zona', guardado.id, {
    que: `el objetivo de ${zona.name}`,
    campo: 'zona_id',
    esperado: zonaId,
  })
}
