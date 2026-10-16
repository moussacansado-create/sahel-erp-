/**
 * RANKINGS Y REGLAS DE PUNTOS CONFIGURABLES.
 *
 * ── POR QUÉ NO ES «OTRO `otorgarPuntos`» ─────────────────────────────────────
 *
 * La versión anterior tenía los puntos escritos a fuego: por visita, por
 * pedido, por cliente, por objetivo. Para cambiar «dos puntos por visita» a
 * «tres» había que editar código y desplegar. Eso no es configurable, y encima
 * obliga a que el que decide cómo se trabaja tenga que saber programar.
 *
 * Aquí una regla es un FILA con su métrica, sus puntos, su modo y su periodo.
 * Añadir una competición nueva no es un despliegue: es un INSERT.
 *
 * ── LO QUE ESTÁ PROHIBIDO HACER AQUÍ ────────────────────────────────────────
 *
 * · CONCEDER PUNTOS QUE NO VIENEN DE UN HECHO. No hay mínimos de facturación,
 *   ni bonuses porzones sin datos, ni «estimaciones amables».
 * · INVENTAR UN RESULTADO CUANDO FALTAN LOS DATOS. Si no hay ni una sola
 *   entrega en el sistema, una regla de «pedidos entregados» no vale cero:
 *   vale *no se puede calcular*. Se dice y se sigue, y quien lo configure lo ve
 *   antes de activarla.
 * · TRATAR LOS PUNTOS COMO DINERO. Son posición en una tabla. `puntos` nunca se
 *   suma a un importe, nunca se multiplica por un precio, nunca se cobra.
 */
import { query, one } from '../db/client.js'
import { ErrorComercial } from './comerciales.js'

// ═══════════════════════════════════════════════════════════════════════════
// CATÁLOGO DE MÉTRICAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cada métrica sabe DOS cosas: cómo se mide, y de qué datos depende.
 *
 * `sql` devuelve una fila por evento awarding, con `comercial`, `ref`, `motivo`.
 * Para métricas de UMBRAL no hay sql: se cuentan los eventos y se concede una
 * vez al llegar a `cantidad`.
 *
 * `requiere` NO es decoración: es la comprobación que impide que una regla mal
 * configurada dé un cero que parece un cero de verdad.
 */
export const METRICAS = {
  // ── CLIENTES ──────────────────────────────────────────────────────────────
  CLIENTE_NUEVO: {
    nombre: 'Cliente nuevo', familia: 'Clientes', modo: 'UNIDAD',
    explica: 'Un punto por cada cliente asignado a este comercial dentro del periodo.',
    sql: `SELECT c.comercial_id AS comercial, c.id AS ref,
                 'Cliente ' || c.code || ' · ' || c.name AS motivo
            FROM customers c
           WHERE c.comercial_id IS NOT NULL
             AND ($1::int IS NULL OR c.comercial_id = $1::int)
             AND c.created_at::date BETWEEN $2 AND $3`,
  },
  CLIENTES_ALCANZADOS: {
    nombre: 'Clientes alcanzados', familia: 'Clientes', modo: 'UMBRAL',
    explica: 'Puntos una sola vez al llegar a la cantidad de clientes del periodo.',
    cuenta: `SELECT c.comercial_id AS comercial, COUNT(DISTINCT c.id)::numeric AS cuenta
               FROM customers c
              WHERE c.comercial_id IS NOT NULL
                AND ($1::int IS NULL OR c.comercial_id = $1::int)
                AND c.created_at::date BETWEEN $2 AND $3
              GROUP BY c.comercial_id`,
  },
  CLIENTE_RECUPERADO: {
    nombre: 'Cliente inactivo recuperado', familia: 'Clientes', modo: 'UNIDAD',
    explica: 'Un punto por cada cliente que vuelve a comprar tras un tiempo sin hacerlo.',
    requiere: 'entregas',
    avisaSiFalta: 'No se puede calcular: no hay ninguna entrega registrada. '
      + 'Sin compras reales no se sabe a quién se considera inactivo.',
    sql: `SELECT o.comercial_id AS comercial, o.id AS ref,
                 'Recuperado · pedido ' || o.code AS motivo
            FROM sales_orders o
           WHERE o.comercial_id IS NOT NULL AND o.delivered_at IS NOT NULL
             AND ($1::int IS NULL OR o.comercial_id = $1::int)
             AND o.created_at::date BETWEEN $2 AND $3`,
  },
  CLIENTE_FIDEL: {
    nombre: 'Cliente fiel', familia: 'Clientes', modo: 'UMBRAL',
    explica: 'Puntos al mantener un cliente comprando durante varios meses seguidos.',
    requiere: 'entregas',
    avisaSiFalta: 'No se puede calcular: sin fechas de entrega no hay forma de '
      + 'comprobar que un cliente compré de forma consecutiva.',
    cuenta: `SELECT x.comercial_id AS comercial, COUNT(*)::numeric AS cuenta
               FROM (
                 SELECT o.id, o.comercial_id
                   FROM sales_orders o
                  WHERE o.delivered_at IS NOT NULL
                    AND o.comercial_id IS NOT NULL
                    AND ($1::int IS NULL OR o.comercial_id = $1::int)
                    AND o.created_at::date BETWEEN $2 AND $3
               ) x
              GROUP BY x.comercial_id`,
  },

  // ── PEDIDOS Y ENTREGAS ─────────────────────────────────────────────────────
  PEDIDO_VALIDO: {
    nombre: 'Pedido válido', familia: 'Pedidos y entregas', modo: 'UNIDAD',
    explica: 'Un punto por cada pedido creado en el periodo.',
    sql: `SELECT o.comercial_id AS comercial, o.id AS ref,
                 'Pedido ' || o.code AS motivo
            FROM sales_orders o
           WHERE o.comercial_id IS NOT NULL
             AND ($1::int IS NULL OR o.comercial_id = $1::int)
             AND o.created_at::date BETWEEN $2 AND $3`,
  },
  PEDIDO_ENTREGADO: {
    nombre: 'Pedido entregado', familia: 'Pedidos y entregas', modo: 'UNIDAD',
    explica: 'Un punto por cada pedido que llega de verdad al cliente.',
    requiere: 'entregas',
    avisaSiFalta: 'No se puede calcular: no hay ninguna entrega registrada.',
    sql: `SELECT o.comercial_id AS comercial, o.id AS ref,
                 'Entregado · ' || o.code AS motivo
            FROM sales_orders o
           WHERE o.comercial_id IS NOT NULL AND o.delivered_at IS NOT NULL
             AND ($1::int IS NULL OR o.comercial_id = $1::int)
             AND o.created_at::date BETWEEN $2 AND $3`,
  },
  PEDIDOS_ALCANZADOS: {
    nombre: 'Pedidos alcanzados', familia: 'Pedidos y entregas', modo: 'UMBRAL',
    explica: 'Puntos una vez al llegar a la cantidad de pedidos del periodo.',
    cuenta: `SELECT o.comercial_id AS comercial, COUNT(*)::numeric AS cuenta
               FROM sales_orders o
              WHERE o.comercial_id IS NOT NULL
                AND ($1::int IS NULL OR o.comercial_id = $1::int)
                AND o.created_at::date BETWEEN $2 AND $3
              GROUP BY o.comercial_id`,
  },
  ENTREGA_COMPLETADA: {
    nombre: 'Entrega completada', familia: 'Pedidos y entregas', modo: 'UNIDAD',
    explica: 'Un punto por cada reparto entregado y confirmado.',
    requiere: 'entregas',
    avisaSiFalta: 'No se puede calcular: la tabla de entregas está vacía.',
    sql: `SELECT o.comercial_id AS comercial, d.id AS ref,
                 'Entrega ' || d.code AS motivo
            FROM deliveries d
            JOIN sales_orders o ON o.id = d.sales_order_id
           WHERE o.comercial_id IS NOT NULL AND d.delivered_at IS NOT NULL
             AND ($1::int IS NULL OR o.comercial_id = $1::int)
             AND d.delivered_at::date BETWEEN $2 AND $3`,
  },

  // ── VISITAS Y ACTIVIDAD ───────────────────────────────────────────────────
  VISITA_REALIZADA: {
    nombre: 'Visita realizada', familia: 'Visitas y actividad', modo: 'UNIDAD',
    explica: 'Un punto por cada visita hecha en el periodo.',
    sql: `SELECT v.comercial_id AS comercial, v.id AS ref,
                 'Visita #' || v.id AS motivo
            FROM com_visitas v
           WHERE v.comercial_id IS NOT NULL
             AND ($1::int IS NULL OR v.comercial_id = $1::int)
             AND v.visita_fecha BETWEEN $2 AND $3`,
  },
  VISITAS_ALCANZADAS: {
    nombre: 'Visitas alcanzadas', familia: 'Visitas y actividad', modo: 'UMBRAL',
    explica: 'Puntos una vez al llegar a la cantidad de visitas del periodo.',
    cuenta: `SELECT v.comercial_id AS comercial, COUNT(*)::numeric AS cuenta
               FROM com_visitas v
              WHERE v.comercial_id IS NOT NULL
                AND ($1::int IS NULL OR v.comercial_id = $1::int)
                AND v.visita_fecha BETWEEN $2 AND $3
              GROUP BY v.comercial_id`,
  },
  SEGUIMIENTO_COMPLETADO: {
    nombre: 'Seguimiento completado', familia: 'Visitas y actividad', modo: 'UNIDAD',
    explica: 'Un punto por cada tarea de seguimiento cerrada con resultado.',
    sql: `SELECT s.asignado_a AS comercial, s.id AS ref,
                 'Tarea cerrada · ' || s.titulo AS motivo
            FROM com_seguimientos s
           WHERE s.asignado_a IS NOT NULL AND s.estado = 'COMPLETADA'
             AND ($1::int IS NULL OR s.asignado_a = $1::int)
             AND s.completada_at::date BETWEEN $2 AND $3`,
  },

  // ── OBJETIVOS ─────────────────────────────────────────────────────────────
  OBJETIVO_CUMPLIDO: {
    nombre: 'Objetivo cumplido', familia: 'Objetivos', modo: 'UMBRAL',
    explica: 'Puntos por alcanzar el objetivo de facturación del periodo.',
    // `fn_hechos_comercial` devuelve un RECORD, no un escalar. Por eso va en un
    // LATERAL y no en la lista del SELECT: llamada así, Postgres no sabe qué
    // columna mirar y la consulta no compila.
    cuenta: `SELECT ob.comercial_id AS comercial,
                    (COALESCE(SUM(h.importe),0)
                     / NULLIF(MAX(ob.target_amount),0) * 100)::numeric AS cuenta
               FROM com_objetivos ob
               LEFT JOIN LATERAL (
                 SELECT * FROM fn_hechos_comercial(ob.comercial_id, ob.period_start, ob.period_end)
               ) h ON true
              WHERE ($1::int IS NULL OR ob.comercial_id = $1::int)
                AND ob.period_start >= $2::date AND ob.period_start <= $3::date
              GROUP BY ob.comercial_id`,
  },

  // ── HEREDADAS ─────────────────────────────────────────────────────────────
  // Las tres primeras reglas que existían antes de que esto fuera configurable.
  // Se leen por su nombre viejo para que el código y el histórico no dejen de
  // entenderse, pero se calculan por su métrica de verdad.
  DISTINCT_CUSTOMERS: {
    nombre: 'Clientes distintos atendidos', familia: 'Clientes', modo: 'UNIDAD',
    explica: 'Un punto por cada cliente distinto, aunque se visite muchas veces.',
    sql: `SELECT c.comercial_id AS comercial, c.id AS ref,
                 'Cliente ' || c.code AS motivo
            FROM customers c
           WHERE c.comercial_id IS NOT NULL
             AND ($1::int IS NULL OR c.comercial_id = $1::int)
             AND c.created_at::date BETWEEN $2 AND $3`,
  },
  TARGET_ACHIEVEMENT: {
    nombre: 'Cumplir el objetivo', familia: 'Objetivos', modo: 'UMBRAL',
    alias: 'OBJETIVO_CUMPLIDO',
    explica: 'Un punto por cada punto porcentual del objetivo alcanzado.',
  },
  // «Cliente nuevo» y «Clientes distintos» son LA MISMA cuenta contada de dos
  // maneras, y el cálculo solo knew una.
  //
  // El configurador de reglas (052) deja elegir la métrica de entre las que
  // ofrece la lista, y una de ellas es `CLIENTE_NUEVO`. Aquí solo estaba
  // `DISTINCT_CUSTOMERS`. Una métrica que el calculador no conoce no entra
  // ni por la rama de los hechos ni por la del contador: la regla se guarda,
  // se ve en Ajustes, y no puntúa NADA. Por eso un comercial con tres
  // clientes de octubre tenía cero puntos y cero clientes distintos.
  //
  // La misma consulta para las dos: una fila por cliente, y el indice unico
  // `uniq_com_puntos_evento` (comercial, regla, tipo_ref, ref_id) hace que
  // recalcular el ranking no duplique ni un punto.
  CLIENTE_NUEVO: {
    nombre: 'Clientes nuevos', familia: 'Clientes', modo: 'UNIDAD',
    explica: 'Un punto por cada cliente dado de alta en el periodo. Cada uno suma una vez, se edite lo que se edite.',
    sql: `SELECT c.comercial_id AS comercial, c.id AS ref,
                 'Cliente ' || c.code AS motivo
            FROM customers c
           WHERE c.comercial_id IS NOT NULL
             AND ($1::int IS NULL OR c.comercial_id = $1::int)
             AND c.created_at::date BETWEEN $2 AND $3`,
  },
  ORDERS: { nombre: 'Pedidos cerrados', familia: 'Pedidos y entregas', modo: 'UNIDAD', alias: 'PEDIDO_VALIDO' },
  VISITS: { nombre: 'Visitas hechas', familia: 'Visitas y actividad', modo: 'UNIDAD', alias: 'VISITA_REALIZADA' },
}

const FAMILIAS = [...new Set(Object.values(METRICAS).map((m) => m.familia))]

// ═══════════════════════════════════════════════════════════════════════════
// ¿DE QUÉ DATOS DEPENDE CADA MÉTRICA?
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ¿DE QUÉ DATOS DEPENDE CADA MÉTRICA?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Una métrica que depende de entregas NO es calculable con cero entregas. No
 * es que valga cero: es que no se sabe. Y esa diferencia es la diferencia entre
 * un ranking que dice la verdad y uno que inventa.
 *
 * Se mira una vez por pasada y se comparte con todas las reglas.
 */
async function datosDisponibles() {
  const d = await one(
    `SELECT (SELECT count(*) FROM deliveries)::int AS entregas,
            (SELECT count(*) FROM sales_orders WHERE delivered_at IS NOT NULL)::int AS entregados,
            (SELECT count(*) FROM com_visitas)::int AS visitas,
            (SELECT count(*) FROM com_seguimientos)::int AS seguimientos,
            (SELECT count(*) FROM customers)::int AS clientes,
            (SELECT count(*) FROM com_objetivos)::int AS objetivos,
            (SELECT count(*) FROM sales_orders)::int AS pedidos`,
  )
  return {
    // «Hay entregas» vale con que exista UNA: la tabla de reparto o la fecha de
    // entrega del pedido. Ninguna de las dos existe hoy, y por eso las reglas
    // de entrega se declaran no calculables en vez de dar cero.
    entregas: Number(d.entregas) > 0 || Number(d.entregados) > 0,
    visitas: Number(d.visitas) > 0,
    seguimientos: Number(d.seguimientos) > 0,
    clientes: Number(d.clientes) > 0,
    objetivos: Number(d.objetivos) > 0,
    pedidos: Number(d.pedidos) > 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PERIODO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El periodo decide de qué ventana se miran los hechos. Se devuelve con la
 * fecha de INICIO como texto porque es la que se usa para anclar la puntuación y
 * tiene que ser EXACTAMENTE la misma cada vez que se recalcula: si cambiara, el
 * índice único no reconocería el periodo y los puntos se duplicarían.
 */
export function ventana(periodo, ancla) {
  const f = ancla instanceof Date ? ancla : new Date(ancla || Date.now())
  const y = f.getUTCFullYear(), m = f.getUTCMonth()
  const p = (n) => String(n).padStart(2, '0')
  if (periodo === 'MENSUAL') {
    const ini = new Date(Date.UTC(y, m, 1))
    const fin = new Date(Date.UTC(y, m + 1, 0))
    return { desde: `${y}-${p(m + 1)}-01`, hasta: fin.toISOString().slice(0, 10) }
  }
  if (periodo === 'TRIMESTRAL') {
    const q = Math.floor(m / 3) * 3
    return { desde: `${y}-${p(q + 1)}-01`, hasta: new Date(Date.UTC(y, q + 3, 0)).toISOString().slice(0, 10) }
  }
  if (periodo === 'ANUAL') return { desde: `${y}-01-01`, hasta: `${y}-12-31` }
  return { desde: '1970-01-01', hasta: '2999-12-31' }
}

// ═══════════════════════════════════════════════════════════════════════════
// LECTURA
// ═══════════════════════════════════════════════════════════════════════════

export async function listarRankings() {
  return query(
    `SELECT r.*,
            (SELECT count(*)::int FROM com_reglas_puntos g WHERE g.ranking_id = r.id) AS reglas,
            (SELECT count(*)::int FROM com_reglas_puntos g WHERE g.ranking_id = r.id AND g.estado = 'ACTIVA') AS reglas_activas,
            (SELECT COALESCE(SUM(p.puntos),0) FROM com_puntos p
               JOIN com_reglas_puntos g ON g.id = p.regla_id
              WHERE g.ranking_id = r.id) AS puntos_registrados
       FROM com_rankings r
      ORDER BY r.estado = 'ACTIVA' DESC, r.nombre`,
  )
}

export async function listarReglas(rankingId) {
  const filas = await query(
    // Los puntos YA concedidos por esta regla, aunque esté desactivada. Es lo
    // que hay que enseñar al desactivar: que apagar una regla no devuelve lo
    // ganado, y sin ese número no hay forma de probarlo desde la pantalla.
    `SELECT g.*, r.nombre AS competicion, r.code AS competicion_code,
            (SELECT COALESCE(SUM(p.puntos),0) FROM com_puntos p WHERE p.regla_id = g.id) AS puntos_registrados,
            (SELECT COUNT(*)::int FROM com_puntos p WHERE p.regla_id = g.id) AS hechos_registrados
       FROM com_reglas_puntos g
       LEFT JOIN com_rankings r ON r.id = g.ranking_id
      WHERE $1::int IS NULL OR g.ranking_id = $1::int
      ORDER BY r.nombre NULLS LAST, g.orden, g.id`,
    [rankingId ?? null],
  )
  const datos = await datosDisponibles()
  return filas.map((g) => {
    const m0 = METRICAS[g.metrica]
    const real = m0 && m0.alias ? METRICAS[m0.alias] : m0
    // Sin metrica no se puede ni decir si se puede calcular: se dice que no.
    const cheq = !real ? { ok: false, motivo: 'Métrica desconocida: ' + g.metrica } : chequeo(real, datos)
    return {
      ...g,
      metrica_nombre: real ? real.nombre : g.metrica,
      familia: real ? real.familia : '—',
      modo_real: real ? real.modo : g.tipo_regla,
      explicacion: real ? real.explica : 'Métrica no reconocida.',
      calculable: cheq.ok,
      motivo_no_calculable: cheq.ok ? null : cheq.motivo,
    }
  })
}

/** ¿Se puede calcular con los datos que hay HOY? Atajo síncrono para el `map`. */
export function chequeo(metrica, datos) {
  // Una métrica SIN `requiere` no depende de nada opcional: siempre se puede
  // calcular. Sin esta guarda, `datos[undefined]` daba falso y TODAS las reglas
  // salían como «no calculable», incluidas las de visitas.
  if (!metrica.requiere) return { ok: true }
  return datos[metrica.requiere]
    ? { ok: true }
    : { ok: false, motivo: metrica.avisaSiFalta || 'Faltan los datos que esta regla necesita.' }
}

export { FAMILIAS }

// ═══════════════════════════════════════════════════════════════════════════
// ESCRITURA
// ═══════════════════════════════════════════════════════════════════════════

/** El código se genera del nombre, en ascii y en minúsculas: es una clave, no un texto. */
function slug(nombre) {
  return String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'competicion'
}

export async function crearRanking(datos, usuarioId) {
  const nombre = String(datos.nombre || '').trim()
  if (!nombre) throw new ErrorComercial('El nombre es obligatorio.', 'NOMBRE_OBLIGATORIO')
  return one(
    `INSERT INTO com_rankings (code, nombre, proposito, descripcion, que_premia,
                               vigente_desde, vigente_hasta, estado, creado_por)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7::date,$8,$9)
     RETURNING *`,
    [datos.code || `${slug(nombre)}-${Date.now().toString(36).slice(-4)}`, nombre,
      datos.proposito || null, datos.descripcion || null, datos.que_premia || null,
      datos.vigente_desde || null, datos.vigente_hasta || null,
      ['ACTIVA', 'PAUSADA', 'DESACTIVADA'].includes(datos.estado) ? datos.estado : 'ACTIVA',
      usuarioId ?? null],
  )
}

export async function editarRanking(id, datos) {
  const antes = await one('SELECT * FROM com_rankings WHERE id = $1::int', [id])
  if (!antes) throw new ErrorComercial('Esa competición no existe.', 'NO_ENCONTRADO')
  return one(
    `UPDATE com_rankings SET
        nombre = COALESCE($2, nombre),
        proposito = COALESCE($3, proposito),
        descripcion = COALESCE($4, descripcion),
        que_premia = COALESCE($5, que_premia),
        vigente_desde = COALESCE($6::date, vigente_desde),
        vigente_hasta = $7::date,
        estado = COALESCE($8, estado),
        actualizado_at = now()
      WHERE id = $1::int RETURNING *`,
    [id, datos.nombre || null, datos.proposito ?? null, datos.descripcion ?? null,
      datos.que_premia ?? null, datos.vigente_desde || null,
      datos.vigente_hasta === '' ? null : (datos.vigente_hasta || null),
      ['ACTIVA', 'PAUSADA', 'DESACTIVADA'].includes(datos.estado) ? datos.estado : null],
  )
}

export async function crearRegla(datos, usuarioId) {
  const m = METRICAS[datos.metrica]
  if (!m) throw new ErrorComercial('Esa métrica no existe.', 'METRICA_INVALIDA')
  const real = m.alias ? METRICAS[m.alias] : m
  const modo = datos.tipo_regla === 'UMBRAL' ? 'UMBRAL' : (real.modo || 'UNIDAD')
  const puntos = Number(datos.puntos)
  if (!Number.isFinite(puntos) || puntos <= 0) {
    throw new ErrorComercial('Los puntos deben ser un número mayor que cero.', 'PUNTOS_INVALIDOS')
  }
  if (modo === 'UMBRAL' && !(Number(datos.cantidad) > 0)) {
    throw Object.assign(new Error('Una regla por umbral necesita decir cuál es la cantidad.'),
      { codigo: 'CANTIDAD_OBLIGATORIA' })
  }
  const code = String(datos.code || '').trim() || `${slug(datos.nombre || datos.metrica)}-${Date.now().toString(36).slice(-4)}`
  return one(
    `INSERT INTO com_reglas_puntos
       (code, nombre, descripcion, metrica, puntos, umbral, tope, orden, is_active,
        ranking_id, tipo_regla, cantidad, periodo, acumulativo, vigente_desde, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::int,$11,$12,$13,$14,COALESCE($15::date,CURRENT_DATE),$16)
     RETURNING *`,
    [code, datos.nombre || real.nombre, datos.descripcion || null, datos.metrica, puntos,
      Number(datos.cantidad) || 0, datos.tope != null ? Number(datos.tope) : null,
      Number(datos.orden) || 100, datos.estado !== 'DESACTIVADA' && datos.estado !== 'PAUSADA',
      datos.ranking_id || null, modo, Number(datos.cantidad) || null,
      ['NINGUNO', 'MENSUAL', 'TRIMESTRAL', 'ANUAL'].includes(datos.periodo) ? datos.periodo : 'NINGUNO',
      datos.acumulativo !== false, datos.vigente_desde || null,
      ['ACTIVA', 'PAUSADA', 'DESACTIVADA'].includes(datos.estado) ? datos.estado : 'ACTIVA'],
  )
}

/**
 * EDITAR UNA REGLA NO TOCA EL HISTÓRICO.
 *
 * Los puntos ya concedidos son hechos. Si la regla vale hoy 3 y antes valía 2,
 * lo que se cambia es lo que viene después, no lo que ya pasó. Por eso no hay
 * ningún UPDATE sobre `com_puntos` en esta función, y por eso `vigente_desde`
 * existe: dice desde cuándo manda la configuración nueva.
 */
export async function editarRegla(id, datos) {
  const antes = await one('SELECT * FROM com_reglas_puntos WHERE id = $1::int', [id])
  if (!antes) throw new ErrorComercial('Esa regla no existe.', 'NO_ENCONTRADO')
  const estado = ['ACTIVA', 'PAUSADA', 'DESACTIVADA'].includes(datos.estado) ? datos.estado : null
  return one(
    `UPDATE com_reglas_puntos SET
        nombre = COALESCE($2, nombre),
        descripcion = COALESCE($3, descripcion),
        puntos = COALESCE($4, puntos),
        umbral = COALESCE($5, umbral),
        tope = COALESCE($6, tope),
        orden = COALESCE($7, orden),
        periodo = COALESCE($8, periodo),
        acumulativo = COALESCE($9, acumulativo),
        cantidad = COALESCE($10, cantidad),
        ranking_id = COALESCE($11::int, ranking_id),
        vigente_desde = COALESCE($12::date, vigente_desde),
        estado = COALESCE($13, estado),
        is_active = CASE WHEN $13::text IS NULL THEN is_active
                         WHEN $13::text = 'ACTIVA' THEN true ELSE false END,
        updated_at = now()
      WHERE id = $1::int RETURNING *`,
    [id, datos.nombre || null, datos.descripcion ?? null,
      Number.isFinite(Number(datos.puntos)) ? Number(datos.puntos) : null,
      Number.isFinite(Number(datos.umbral)) ? Number(datos.umbral) : null,
      Number.isFinite(Number(datos.tope)) ? Number(datos.tope) : null,
      Number.isFinite(Number(datos.orden)) ? Number(datos.orden) : null,
      ['NINGUNO', 'MENSUAL', 'TRIMESTRAL', 'ANUAL'].includes(datos.periodo) ? datos.periodo : null,
      typeof datos.acumulativo === 'boolean' ? datos.acumulativo : null,
      Number.isFinite(Number(datos.cantidad)) ? Number(datos.cantidad) : null,
      datos.ranking_id || null, datos.vigente_desde || null, estado],
  )
}

/**
 * PAUSAR ≠ DESACTIVAR ≠ BORRAR.
 *
 * - ACTIVA      cuenta.
 * - PAUSADA     no cuenta, pero se ve y se puede reanimar. Es «este mes no vale».
 * - DESACTIVADA no cuenta y es archivo. Es «esta regla ya no ».
 *
 * Ninguna de las tres toca `com_puntos`. Apagar una regla no devuelve los puntos
 * que ya seComputaron, porque esos puntos se ganaron trabajando.
 */
export async function cambiarEstadoRegla(id, estado) {
  if (!['ACTIVA', 'PAUSADA', 'DESACTIVADA'].includes(estado)) {
    throw new ErrorComercial('Ese estado no existe.', 'ESTADO_INVALIDO')
  }
  return one(
    `UPDATE com_reglas_puntos
        SET estado = $2, is_active = ($2 = 'ACTIVA'), updated_at = now()
      WHERE id = $1::int RETURNING *`,
    [id, estado],
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CÁLCULO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OTORGAR PUNTOS DE TODAS LAS REGLAS ACTIVAS.
 *
 * ── LA GARANTÍA ─────────────────────────────────────────────────────────────
 * Correr esto cinco veces seguidas deja el mismo total. No porque el código lo
 * compruebe, sino porque la BASE no lo permite:
 *
 *   UNIQUE (comercial_id, regla_code, ref_tipo, ref_id)
 *
 * Una regla por UNIDAD se ancla al hecho —esta visita, este pedido— así que
 * repetir el cálculo choca contra el índice y no inserta nada.
 *
 * Una regla por UMBRAL se ancla al PERIODO (`ref_tipo='PERIODO'`), porque lo
 * que se concede una vez es llegar a la cantidad, y la cantidad se comprueba
 * contra una ventana, no contra una fila suelta.
 */
export async function otorgarPuntos({ rankingId = null, comercialId = null, ancla = null } = {}) {
  const datos = await datosDisponibles()
  const reglas = await query(
    `SELECT g.*, r.nombre AS competicion
       FROM com_reglas_puntos g
       LEFT JOIN com_rankings r ON r.id = g.ranking_id
      WHERE g.estado = 'ACTIVA'
        AND ($1::int IS NULL OR g.ranking_id = $1::int)
        AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM com_perfiles p WHERE p.id = $2::int))
      ORDER BY g.orden, g.id`,
    [rankingId, comercialId],
  )

  let insertados = 0
  const yaEstaban = []
  const noCalculables = []

  for (const g of reglas) {
    const m0 = METRICAS[g.metrica]
    const m = m0 && m0.alias ? METRICAS[m0.alias] : m0
    if (!m) { noCalculables.push({ regla: g.code, motivo: 'Métrica desconocida: ' + g.metrica }); continue }
    const cal = chequeo(m, datos)
    if (!cal.ok) { noCalculables.push({ regla: g.code, motivo: cal.motivo }); continue }

    const v = ventana(g.periodo, ancla)
    // Una regla no cuenta para hechos anteriores a cuando empezó a valer. Sin
    // esto, revisar el histórico de una regla nueva llenaría el ranking de
    // meses en los que todavía no existía.
    // NULL = la regla manda desde que existe. No es un detalle: con la fecha de
    // hoy por defecto, las seis visitas que ya había dejaban de contar y el
    // ranking salía a cero sin dar ninguna pista de por qué.
    const vigente = g.vigente_desde ? g.vigente_desde.toISOString().slice(0, 10) : null
    const desde = vigente && vigente > v.desde ? vigente : v.desde

    if (m.modo === 'UNIDAD' && m.sql) {
      // Siempre 3 parámetros, siempre en el mismo orden. Es lo que permite que
      // `WHERE ($1::int IS NULL OR ...)` sirva para el equipo entero y para una
      // sola persona sin escribir la consulta dos veces.
      const hechos = await query(m.sql, [comercialId, desde, v.hasta])
      for (const h of hechos) {
        const r = await query(
          `INSERT INTO com_puntos (comercial_id, regla_id, regla_code, period_start, period_end,
                                   puntos, motivo, ref_tipo, ref_id, awarded_at)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,now())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [h.comercial, g.id, g.code, desde, v.hasta, Number(g.puntos), h.motivo,
            tablaDe(g.metrica), h.ref],
        )
        if (r.length) insertados++; else yaEstaban.push(`${g.code}#${h.ref}`)
      }
    } else if (m.cuenta) {
      const cuentas = await query(m.cuenta, [comercialId, desde, v.hasta])
      for (const c of cuentas) {
        const tope = Number(g.cantidad || g.umbral || 0)
        if (tope <= 0 || Number(c.cuenta) < tope) continue
        // Umbral simple: puntos de una vez. Umbral acumulativo: se multiplica
        // por cuántas veces se ha superado, que es lo que premia el Halcón.
        const veces = g.acumulativo ? Math.floor(Number(c.cuenta) / tope) : 1
        const r = await query(
          `INSERT INTO com_puntos (comercial_id, regla_id, regla_code, period_start, period_end,
                                   puntos, motivo, ref_tipo, ref_id, awarded_at)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,'PERIODO',$8::date,now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [c.comercial, g.id, g.code, desde, v.hasta, Number(g.puntos) * veces,
            `${g.nombre}: ${c.cuenta} de ${tope} en ${desde}…${v.hasta}`, desde],
        )
        if (r.length) insertados++; else yaEstaban.push(`${g.code}@${desde}`)
      }
    }
  }

  const total = await one('SELECT COALESCE(SUM(puntos),0) AS p FROM com_puntos')
  return { insertados, omitidos: yaEstaban.length, total: Number(total.p), reglas: reglas.length, noCalculables }
}

/** De qué tabla viene el hecho. Va en la fila para poder auditarlo después. */
function tablaDe(metrica) {
  return ({
    CLIENTE_NUEVO: 'customers', DISTINCT_CUSTOMERS: 'customers',
    CLIENTE_RECUPERADO: 'sales_orders', PEDIDO_VALIDO: 'sales_orders',
    PEDIDO_ENTREGADO: 'sales_orders', ENTREGA_COMPLETADA: 'deliveries',
    VISITA_REALIZADA: 'com_visitas', SEGUIMIENTO_COMPLETADO: 'com_seguimientos',
  })[metrica] || 'desconocida'
}
