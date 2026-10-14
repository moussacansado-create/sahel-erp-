/**
 * CENTRO DE ALERTAS COMERCIALES.
 *
 * ── IDEMPOTENCIA ────────────────────────────────────────────────────────────
 *
 * `dedupe_key` es la clave y hay un índice ÚNICO sobre ella. Insertar la misma
 * alerta dos veces no devuelve un error que haya que silenciar: no entra. Por
 * eso se puede volver a ejecutar el proceso las veces que haga falta —que es
 * lo que se hace para poder decir «no duplica»— sin miedo.
 *
 * ── NO SE GENERA AL ABRIR LA PANTALLA ───────────────────────────────────────
 *
 * Abrir una pantalla no escribe nada. Se comparan las alertas que hay con las
 * que debería haber, y solo se insertan las que falten. Si se generara al
 * leer, recargar sería una forma de crear avisos.
 */

import { query, one, transaction } from '../db/client.js'

/** Configuración comercial, desde `app_config`. Sin números en el código. */
export async function configComercial(clave, porDefecto) {
  const f = await one('SELECT value FROM app_config WHERE key = $1', [clave])
  return f ? f.value : porDefecto
}

export async function umbralInactividad() {
  return Number(await configComercial('comerciales.inactividad.dias', '15'))
}

export async function inactividadActiva() {
  return (await configComercial('comerciales.inactividad.activa', 'false')) === 'true'
}

/** Cambiar el umbral desde la administración. */
export async function ponerUmbralInactividad(dias, usuarioId = null) {
  const n = Number(dias)
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new Error(`El umbral debe ser un número entero de días entre 1 y 3650. Me diste: ${dias}`)
  }
  await query(
    `INSERT INTO app_config (key, value, description, updated_by, updated_at)
     VALUES ('comerciales.inactividad.dias', $1,
             'Dias sin compra valida para considerar a un cliente inactivo', $2, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [String(n), usuarioId],
  )
  return n
}

/**
 * Qué alertas comerciales debería haber AHORA. No inserta nada: solo dice la lista.
 */
export async function alertasPrevistas() {
  return query('SELECT kind, entity_type, entity_id, severity, title, message, dedupe_key, data'
    + ' FROM v_alertas_comerciales ORDER BY severity DESC, dedupe_key')
}

/**
 * Inserta las que falten. Devuelve cuántas ha puesto de verdad.
 *
 * El `ON CONFLICT DO NOTHING` con el índice único es lo que hace idempotente
 * esto: la segunda vez que se ejecuta, cero inserciones. No porque se compruebe
 * antes, sino porque la base no lo permite.
 */
export async function generarAlertas() {
  const previstas = await alertasPrevistas()
  if (!previstas.length) return { insertadas: 0, ya_existentes: 0, total: 0 }

  const ya = await query('SELECT dedupe_key FROM alerts WHERE dedupe_key = ANY($1::text[])',
    [previstas.map((a) => a.dedupe_key)])
  const vistas = new Set(ya.map((x) => x.dedupe_key))
  const faltan = previstas.filter((a) => !vistas.has(a.dedupe_key))

  for (const a of faltan) {
    await query(
      `INSERT INTO alerts (kind, severity, title, message, entity_type, entity_id, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [a.kind, a.severity, a.title, a.message, a.entity_type, a.entity_id, a.data, a.dedupe_key],
    )
  }
  return { insertadas: faltan.length, ya_existentes: ya.length, total: previstas.length }
}

/**
 * Consultar alertas comerciales. `ambito` es el perfil de quien pregunta:
 * `null` = todas (administración). Nunca se filtra en la pantalla.
 */
export async function listarAlertasComerciales({ perfilId = null, limite = 200 } = {}) {
  return query(
    `SELECT a.*, v.data AS contextual
       FROM v_alertas_comerciales v
       JOIN alerts a ON a.dedupe_key = v.dedupe_key AND a.is_read IS NOT TRUE
      ORDER BY a.severity DESC, a.created_at DESC
      LIMIT $1`,
    [Math.min(Number(limite) || 200, 500)],
  )
}

/** Atender una alerta sin borrarla. */
export async function atenderAlerta(dedupeKey, usuarioId) {
  return transaction(async (tx) => {
    const f = await tx.one(
      `UPDATE alerts SET is_read = TRUE, read_by = $2, read_at = now()
        WHERE dedupe_key = $1 RETURNING *`,
      [dedupeKey, usuarioId],
    )
    if (!f) throw new Error('Esa alerta no existe o ya estaba atendida.')
    return f
  })
}
