/**
 * El arranque de una base desde cero.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ ESTO EXISTE
 *
 * Las migraciones se aplican en orden de fichero. La 035 borra las localidades
 * y, al hacerlo, comprueba que siguen ahí ≥12 zonas, 9 regiones y AL MENOS UN
 * COMERCIAL. Es un guardián bueno: avisa si el borrado se ha comido de más.
 *
 * El problema es que la semilla —la que crea el comercial— se ejecutaba
 * DESPUÉS de todas las migraciones. El guardián miraba antes de que existiera
 * nadie y abortaba, y como el fallo tumba el WASM de PGlite entero, tiraba
 * también todas las pruebas: cada una levanta su base y muere en el mismo
 * sitio.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ NO SE TOCA LA MIGRACIÓN
 *
 * Porque está aplicada, y el migrador comprueba el checksum: si el fichero
 * cambia, se niega a arrancar. Editar la historia no es arreglarla.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * LA SOLUCIÓN
 *
 * Meter la semilla EN MEDIO, que es donde le toca:
 *
 *     1ª pasada   migraciones hasta la 035 (sin ella)
 *     semilla     roles, permisos, y un comercial de arranque
 *     2ª pasada   el resto, incluido el guardián, que ya tiene qué mirar
 *
 * Las dos pasadas son idempotentes: repetir la instalación no duplica nada,
 * porque `migrar()` solo aplica lo que falta y la semilla solo crea el
 * comercial si la base está vacía.
 *
 * Para el que lea esto dentro de seis meses: no es un rodeo. Es que la
 * semilla tiene que estar donde está el guardián, no al final.
 */

import { migrar } from './migrador.js'
import { sembrar, sembrarComercialInicial } from './semillas.js'

/** El guardián. Hasta aquí se llega con la semilla ya puesta. */
export const GUARDIAN_LOCALIDADES = '035_sin_localidades'

/**
 * Deja la base lista para trabajar: migrada y sembrada.
 *
 * @param {{silencioso?: boolean}} opciones
 * @returns {Promise<{parada1: object, sembrados: object, comercial: object, parada2: object}>}
 */
export async function instalarBase({ silencioso = false } = {}) {
  // 1ª pasada: todo lo que hay antes del guardián.
  const parada1 = await migrar({ silencioso, hasta: GUARDIAN_LOCALIDADES })

  // La semilla, aquí, donde el guardián la va a pedir.
  await sembrar()
  const comercial = await sembrarComercialInicial()

  // 2ª pasada: el guardián y todo lo que viene detrás.
  const parada2 = await migrar({ silencioso })

  if (!silencioso) {
    console.log(
      `  → instalador: ${parada1.aplicadas.length} + ${parada2.aplicadas.length} migraciones, ` +
      `comercial de arranque ${comercial.creada ? 'creado' : 'ya estaba'}`,
    )
  }
  return { parada1, comercial, parada2 }
}

/**
 * Realinea TODAS las secuencias con el máximo real de su tabla.
 *
 * Por qué está aquí y no en un script aparte, y por qué es un método que hay
 * que dejar hecho de verdad:
 *
 * Una SERIAL que se queda atrás choca al insertar, y el error que devuelve
 * PostgreSQL es 23505 «Ya existe un registro con esos datos». Un mensaje que
 * miente: no hay ningún duplicado. Lo que pasa es que la secuencia quiere
 * entregar un `id` que ya existe, y el alta de un comercial o de un cliente
 * revienta con un 409 que no dice nada de qué choca ni dónde.
 *
 * Las secuencias se desincronizan solas: cada transacción que se deshace
 * (una alta que falla más tarde, un seed interrumpido, un despliegue a
 * medias) gasta números que nunca llegan a la tabla. Con veinte o treinta
 * fallos acumulados la secuencia va tan por detrás que TODO alta choca, y
 * desde fuera parece que la base está llena o corrupta cuando lo único que
 * pasa es que el contador quedó desfasado.
 *
 * Es idempotente y no toca datos: solo mueve el contador hasta «mayor id
 * existente + 1». Una tabla vacía se deja en 1. Es la misma operación que
 * hace el restaurador al reponer un volcado, y aquítoo, porque el síntoma es
 * idéntico y la causa también.
 */
export async function realinearSecuencias() {
  const { query } = await import('./client.js')
  const filas = await query(
    `SELECT c.table_name AS tabla, pg_get_serial_sequence(c.table_schema || '.' || c.table_name, 'id') AS sec
       FROM information_schema.columns c
      WHERE c.column_name = 'id'
        AND c.table_schema = 'public'
        AND pg_get_serial_sequence(c.table_schema || '.' || c.table_name, 'id') IS NOT NULL`)
  for (const f of filas) {
    const tabla = String(f.tabla).replace(/"/g, '')
    await query(
      `SELECT setval($1, GREATEST(COALESCE((SELECT MAX(id) FROM "${tabla}"), 0), 1))`,
      [f.sec])
  }
  return filas.length
}
