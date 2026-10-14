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
