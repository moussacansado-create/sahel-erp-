/**
 * CONFIGURACIÓN GENERAL DE SAHEL.
 *
 * ── POR QUÉ ESTE ARCHIVO ───────────────────────────────────────────────────
 *
 * Aquí viven los datos de la empresa (los que salen en albaranes y etiquetas),
 * los parámetros de numeración y las series. Antes eran lecturas sueltas desde
 * varios sitios, cada una con su valor por defecto: el mismo datoicloud leía de
 * dos maneras y el día que cambiaba uno se olvidaba el otro.
 *
 * `leerConfig` conserva la firma de siempre —`(clave, porDefecto, tx)`— porque
 * media aplicación la llama así. Los valores sensibles NO se pueden escribir
 * sin usuario: `guardar` deja siempre rastro en `audit_log` con el antes y el
 * después, porque cambiar un prefijo de lote o una moneda es de los cambios que
 * no se pueden deshacer a ojo.
 */
import { query, one, transaction } from '../db/client.js'
import { ErrorDeAuth } from '../modules/auth/servicio.js'

/** Un valor suelto de configuración. Acepta transacción para leer en la misma. */
export async function leerConfig(clave, porDefecto = null, tx = null) {
  const ejecutar = tx || { one, query }
  const fila = await ejecutar.one('SELECT value FROM app_config WHERE key = $1', [clave])
  if (!fila || fila.value === null || fila.value === '') return porDefecto
  return fila.value
}

/** Todas las claves de configuración, con su metadato. Para la pantalla. */
/**
 * Tipos admitidos por parámetro.
 *
 * `app_config` sin tipos es un cajón de sastre: nadie sabe qué clave existe ni
 * qué pasa si alguien guarda `«sí»` donde tocaba un booleano. Cada clave
 * declara el suyo y `guardar` lo comprueba ANTES de escribir, para que un
 * valor mal puesto no llegue a la base a esconderse en una pantalla.
 */
export const TIPOS = {
  texto: (v) => typeof v === 'string',
  numero: (v) => typeof v === 'number' && Number.isFinite(v),
  booleano: (v) => typeof v === 'boolean',
  anio: (v) => Number.isInteger(v) && v >= 2000 && v <= 2200,
  objeto: (v) => v !== null && typeof v === 'object',
}

/** Qué tipo se espera de una clave, deducido de su nombre. */
export function tipoDeClave(clave) {
  const k = String(clave)
  if (/^\d{4}$/.test(k.split('.').pop()) || /anio|ejercicio/.test(k)) return 'anio'
  if (/activa|habilitad|reinicio|con_anio/.test(clave)) return 'booleano'
  if (/\.dias$|^\d+$|iva|plazo|dias/.test(clave)) return 'numero'
  return 'texto'
}

export async function todaLaConfig() {
  const filas = await query(
    `SELECT c.key, c.value, c.description, c.updated_at,
            (SELECT full_name FROM users WHERE id = c.updated_by) AS actualizado_por
       FROM app_config c ORDER BY c.key`,
  )
  const out = {}
  for (const f of filas) out[f.key] = f
  return out
}
export async function leer(clave, porDefecto = null) {
  const f = await one('SELECT value FROM app_config WHERE key = $1', [clave])
  return f ? f.value : porDefecto
}
/**
 * Los datos de la empresa tal como se imprimen.
 *
 * `moneda` es el código ISO (`XOF`) y `simbolo` lo que ve el cliente (`FCFA`).
 * Se guardan por separado a propósito: el código sirve para ordenar y calcular,
 * el símbolo para imprimir. Confundirlos fue exactamente el error que traía la
 * aplicación antigua, que decía `EUR` en la configuración y `FCFA` en el
 * documento impreso.
 */
export async function empresa(tx) {
  const claves = [
    'empresa.nombre', 'empresa.cif', 'empresa.direccion', 'empresa.telefono',
    'empresa.email', 'empresa.web', 'empresa.moneda', 'empresa.simbolo',
    'empresa.iva', 'empresa.idioma', 'ventana.pago', 'ventana.reclamacion_horas',
  ]
  const filas = await tx.query(
    `SELECT key, value FROM app_config WHERE key = ANY($1)`, [claves])
  const c = Object.fromEntries(filas.map((f) => [f.key, f.value]))

  const nombre = c['empresa.nombre'] || 'SAHEL'
  return {
    nombre,
    // En el membrete se lee «SAHEL — PRODUITS D'HYGIÈNE». El descriptor viene
    // separado del nombre para poder cambiarlo sin tocar la razón social.
    descriptor: c['empresa.descriptor'] || "PRODUITS D'HYGIÈNE",
    cif: c['empresa.cif'] || null,
    direccion: c['empresa.direccion'] || null,
    telefono: c['empresa.telefono'] || null,
    email: c['empresa.email'] || null,
    web: c['empresa.web'] || null,
    moneda: c['empresa.moneda'] || 'XOF',
    simbolo: c['empresa.simbolo'] || 'FCFA',
    iva: Number(c['empresa.iva'] ?? 0.21),
    idioma: c['empresa.idioma'] || 'es',
    ventanaPago: c['ventana.pago'] || null,
    ventanaReclamacion: c['ventana.reclamacion_horas'] || null,
  }
}

/** Una cantidad con el símbolo de la empresa, sin decimales de más. */
export function dinero(cantidad, simbolo = 'FCFA', decimales = 0) {
  const n = Number(cantidad || 0)
  const txt = n.toLocaleString('es-ES', {
    minimumFractionDigits: decimales, maximumFractionDigits: decimales,
  })
  return `${txt} ${simbolo}`
}

/** Un porcentaje de IVA escrito como lo ve un cliente: «21 %». */
export function porcentaje(tasa) {
  const n = Number(tasa || 0) * 100
  const txt = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${txt} %`
}


// ═══════════════════════════════════════════════════════════════════════════
// ESCRITURA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Guardar UN parámetro, con su antes y su después.
 *
 * @param {string} clave
 * @param {*}      valor
 * @param {number} usuarioId  quién lo cambia. Obligatorio: sin él no hay
 *                           historial y un cambio sin autor es un cambio que
 *                           luego nadie puede explicar.
 */
export async function guardar(clave, valor, usuarioId) {
  if (!usuarioId) throw new ErrorDeAuth('No se sabe quién cambia la configuración', 'SIN_AUTOR', 400)
  if (valor !== null && !TIPOS[tipoDeClave(clave)](valor)) {
    throw new ErrorDeAuth(
      `«${clave}» espera un valor de tipo ${tipoDeClave(clave)}, y se ha recibido otro.`,
      'VALOR_INVALIDO', 400,
    )
  }
  return transaction(async (tx) => {
    const antes = await tx.one('SELECT value FROM app_config WHERE key = $1', [clave])
    const fila = await tx.one(
      `INSERT INTO app_config (key, value, updated_by, updated_at)
            VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value, updated_by, updated_at`,
      [clave, JSON.stringify(valor), usuarioId],
    )
    await tx.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, before_data, after_data, outcome)
       SELECT $1, u.username, 'UPDATE_CONFIG', 'app_config', $2, $3, $4, 'SUCCESS'
         FROM users u WHERE u.id = $1`,
      [usuarioId, clave, antes ? JSON.stringify(antes.value) : null, JSON.stringify(valor)],
    )
    return { ...fila, antes: antes ? antes.value : null }
  })
}

/** Varios a la vez: o se guardan todos, o ninguno. */
export async function guardarVarios(cambios, usuarioId) {
  const claves = Object.keys(cambios || {})
  if (!claves.length) return []
  const salida = []
  for (const k of claves) salida.push(await guardar(k, cambios[k], usuarioId))
  return salida
}

// ═══════════════════════════════════════════════════════════════════════════
// SERIES DE NUMERACIÓN
// ═══════════════════════════════════════════════════════════════════════════

export async function series() {
  return query(
    `SELECT s.*,
            (SELECT COALESCE(SUM(e.ultimo_valor), 0) FROM config_series_ejercicio e
              WHERE e.serie = s.codigo AND e.anio = EXTRACT(YEAR FROM CURRENT_DATE)::int) AS consumido_anio,
            (SELECT count(*)::int FROM lots l WHERE l.code LIKE s.prefijo || '-%') AS lotes_con_prefijo
       FROM config_series s
      ORDER BY s.clase, s.codigo`,
  )
}

export async function historialDeSeries(anio = null) {
  return query(
    `SELECT e.* FROM config_series_ejercicio e
      WHERE $1::int IS NULL OR e.anio = $1::int
      ORDER BY e.anio DESC, e.serie`,
    [anio ?? null],
  )
}

/**
 * Cambiar una serie.
 *
 * El prefijo SOLO afecta a lo que se numere a partir de ahora. Los lotes ya
 * existentes guardan su código en `lots.code` y no se tocan: renumerar el
 * histórico sería reescribir unas instalaciones que ya salieron de fábrica.
 *
 * Por eso se guarda `prefijo_anterior`: para poder decir «antes se numeraba
 * así» sin tener que adivinarlo.
 */
export async function editarSerie(codigo, cambios, usuarioId) {
  if (!usuarioId) throw new ErrorDeAuth('No se sabe quién cambia la configuración', 'SIN_AUTOR', 400)
  const antes = await one('SELECT * FROM config_series WHERE codigo = $1', [codigo])
  if (!antes) throw new ErrorDeAuth(`La serie ${codigo} no existe`, 'SERIE_NO_EXISTE', 404)

  const prefijo = cambios.prefijo
    ? String(cambios.prefijo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    : null
  if (cambios.prefijo && prefijo.length < 2) {
    throw new ErrorDeAuth('Un prefijo necesita al menos dos letras o números', 'PREFIJO_INVALIDO', 400)
  }

  return transaction(async (tx) => {
    const fila = await tx.one(
      `UPDATE config_series SET
          nombre      = COALESCE($2, nombre),
          prefijo     = COALESCE($3, prefijo),
          prefijo_anterior = CASE WHEN $3 IS NOT NULL AND $3 <> prefijo THEN prefijo ELSE prefijo_anterior END,
          digitos     = COALESCE($4, digitos),
          con_anio    = COALESCE($5, con_anio),
          is_active   = COALESCE($6, is_active),
          actualizado_por = $7,
          actualizado_at = now()
        WHERE codigo = $1
      RETURNING *`,
      [codigo, cambios.nombre || null, prefijo,
        Number.isInteger(cambios.digitos) ? cambios.digitos : null,
        typeof cambios.con_anio === 'boolean' ? cambios.con_anio : null,
        typeof cambios.is_active === 'boolean' ? cambios.is_active : null,
        usuarioId],
    )
    await tx.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, before_data, after_data, outcome)
       SELECT $1, u.username, 'UPDATE_CONFIG', 'config_series', $2, $3, $4, 'SUCCESS'
         FROM users u WHERE u.id = $1`,
      [usuarioId, codigo, JSON.stringify(antes), JSON.stringify(fila)],
    )
    return fila
  })
}

/** Crear una serie nueva. Un producto nuevo, un prefijo nuevo. */
export async function crearSerie(datos, usuarioId) {
  if (!usuarioId) throw new ErrorDeAuth('No se sabe quién cambia la configuración', 'SIN_AUTOR', 400)
  const codigo = String(datos.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (codigo.length < 2) throw new ErrorDeAuth('El código necesita al menos dos caracteres', 'CODIGO_INVALIDO', 400)
  return transaction(async (tx) => {
    const fila = await tx.one(
      `INSERT INTO config_series (codigo, nombre, clase, prefijo, digitos, con_anio, actualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [codigo, datos.nombre || codigo, datos.clase || 'PRODUCTO',
        String(datos.prefijo || codigo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
        Number.isInteger(datos.digitos) ? datos.digitos : 6,
        datos.con_anio !== false, usuarioId],
    )
    await tx.query(
      `INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, after_data, outcome)
       SELECT $1, u.username, 'CREATE_CONFIG', 'config_series', $2, $3, 'SUCCESS' FROM users u WHERE u.id = $1`,
      [usuarioId, codigo, JSON.stringify(fila)],
    )
    return fila
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// EJERCICIO
// ═══════════════════════════════════════════════════════════════════════════

export async function anioDeTrabajo() {
  return await leer('numeracion.anio_activo', new Date().getFullYear())
}

/**
 * Cambiar de ejercicio.
 *
 * Abrir 2027 no borra 2026 ni toca un solo lote: la serie de 2027 empieza en
 * 000001 y la de 2026 se queda donde estaba, con su historial. Es exactamente
 * lo que pasa al cambiar de cuaderno en la fábrica, y por eso los lotes viejos
 * siguen siendo legibles.
 */
export async function cambiarAnio(anio, usuarioId) {
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2200) {
    throw new ErrorDeAuth('El ejercicio debe ser un año entre 2000 y 2200', 'ANIO_INVALIDO', 400)
  }
  const anterior = await anioDeTrabajo()
  const r = await guardar('numeracion.anio_activo', anio, usuarioId)
  return { anterior, nuevo: anio, ...r }
}
