/**
 * AUDITORÍA QUE NO PUEDE ROMPER LA OPERACIÓN —NI MENTIR SOBRE ELLA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE PASÓ, Y POR QUÉ NO BASTA CON ARREGLAR DOS NOMBRES DE COLUMNA
 *
 * El helper de auditoría insertaba en `audit_log (…, old_data, new_data, …)`.
 * Esas columnas no existen: se llaman `before_data` y `after_data`. El INSERT
 * fallaba.
 *
 * Y aquí está lo importante: el INSERT fallaba, el `catch` se lo tragaba, y
 * eso parecía sensato —«perder una línea de auditoría es malo, perder la
 * operación es peor»— pero en PostgreSQL una sentencia fallida **envenena la
 * transacción entera**. Lo que viene después da «current transaction is
 * aborted», el COMMIT falla, y TODO lo que hadí­a hecho el `callback` se
 * deshace.
 *
 * El resultado fue el peor posible: la API devolvía 201 con el objeto creado,
 * id incluido, y la fila no existía. El sistema **decía haber guardado algo
 * que no había guardado**. Un id que se devuelve y no existe es peor que un
 * error: la persona que lo ve ya no va a mirar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS COSAS QUE LO ARREGLA DE VERDAD
 *
 * UN · LA AUDITORÍA VA EN UN SAVEPOINT.
 *
 * Un SAVEPOINT es un punto al que se puede volver SIN deshacer lo anterior. Si
 * la auditoría falla, se vuelve al savepoint, la transacción sigue viva y la
 * operación se guarda. Si la auditoría va bien, se suelta el savepoint.
 *
 * Sigue siendo cierto que perder una auditoría es malo. Por eso el fallo se
 * escribe en la consola con la fila que se perdió, y por eso hay una prueba
 * que lo comprueba. Pero perder una auditoría no puede costarle el día a
 * alguien que estaba creando una zona.
 *
 * DOS · NADA SE DA POR GUARDADO HASTA COMPROBAR QUE ESTÁ GUARDADO.
 *
 * Que la transacción devuelva bien no es lo mismo que haya escrito. Por eso
 * `guardar()` relee lo que dice haber creado, DESPUÉS de confirmar, y compara.
 * Si no está, lanza un error que lo dice con todas sus letras en vez de
 * devolver un id que no existe.
 *
 * Es la diferencia entre «la operación dijo que salió bien» y «la operación
 * está guardada». Hoy el sistema no tenía ninguna de las dos garantías.
 */

/**
 * Escribe en `audit_log` sin poder tumbar la operación de alrededor.
 *
 * @param {object} tx      transacción en curso
 * @param {object} entrada { usuarioId, accion, entidad, entidadId, datos }
 */
export async function registrarAuditoria(tx, {
  usuarioId = null, accion, entidad, entidadId = null, datos = null,
  //
  // Solo para las pruebas. Permite romper la auditoría A PROPÓSITO para
  // comprobar que la operación se guarda igual. Un módulo no puede tener esto
  // en su API pública: sería una puerta para dejar de auditar.
  //
  forzarFallo = false,
}) {
  const marca = `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  await tx.query(`SAVEPOINT ${marca}`)
  try {
    if (forzarFallo) throw new Error('fallo de auditoría provocado por la prueba')
    //
    // Las columnas son `before_data` y `after_data`. Se pueden ver en
    // `006_comercial_trazabilidad.sql`. Escribirlas bien no basta: el
    // SAVEPOINT de arriba es lo que hace que un error aquí no arrase con la
    // operación.
    //
    await tx.query(
      `INSERT INTO audit_log
         (user_id, action, entity_type, entity_id, before_data, after_data, outcome, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5,'SUCCESS',now())`,
      [usuarioId, accion, entidad, entidadId == null ? null : String(entidadId),
        datos ? JSON.stringify(datos) : null],
    )
    await tx.query(`RELEASE SAVEPOINT ${marca}`)
  } catch (e) {
    //
    // Se vuelve AL GUARDADO, no al principio. Esto es lo que antes no pasaba.
    //
    await tx.query(`ROLLBACK TO SAVEPOINT ${marca}`).catch(() => {})
    await tx.query(`RELEASE SAVEPOINT ${marca}`).catch(() => {})

    // La pérdida se dice en voz alta. Silenciarla era el primer error.
    console.error(
      `[auditoría] no se ha podido registrar «${accion}» de ${entidad}`
      + `${entidadId == null ? '' : `#${entidadId}`}: ${e.message}`,
      datos ?? '',
    )
  }
}

/**
 * Comprueba que lo que una operación dice haber escrito está escrito.
 *
 * Se llama DESPUÉS de que la transacción haya confirmado, y es lo último que
 * hace la función antes de devolver.
 *
 * Por qué es necesaria y no un adorno: durante años este sistema ha podido
 * devolver un id sin fila detrás, y la forma de saber que algo está guardado
 * no es confiar en el código que lo escribió. Es ir a mirarlo.
 *
 * @param {string}  tabla      tabla donde debería estar
 * @param {number}  id         id que se dice haber creado
 * @param {object}  opciones
 * @param {string}  [opciones.que] descripción para el mensaje de error
 * @param {string}  [opciones.sql] consulta alternativa de verificación
 * @param {any}    [opciones.esperado] valor que debe tener (opcional)
 * @param {string}  [opciones.campo]   columna a comparar
 * @throws {Error} si la fila no está
 */
export async function confirmarGuardado(tabla, id, opciones = {}) {
  const { que = `el ${tabla}`, sql = null, esperado = undefined, campo = null } = opciones

  const consulta = sql
    ?? `SELECT * FROM ${tabla} WHERE id = $1`
  const fila = await dbOne(consulta, [id])

  if (!fila) {
    //
    // Este es el mensaje que faltaba durante meses. No «error interno», no un
    // 201 con un id que no existe: esto.
    //
    const e = new Error(
      `La operación ha dicho que ha guardado ${que}, pero no está en la base. `
      + `Se ha devuelto el id ${id} y no existe ninguna fila con ese id. `
      + 'No se ha guardado nada: vuelve a intentarlo y, si sigue igual, avisa.',
    )
    e.codigo = 'NO_SE_GUARDO'
    e.estado = 500
    e.entidad = tabla
    e.entidadId = id
    throw e
  }

  if (esperado !== undefined && campo) {
    const guardado = fila[campo]
    const coincide = typeof esperado === 'number'
      ? Math.abs(Number(guardado) - Number(esperado)) < 1e-6
      : String(guardado) === String(esperado)

    if (!coincide) {
      const e = new Error(
        `Se ha guardado ${que}, pero ${campo} no es lo que se pidió: `
        + `se pidió «${esperado}» y hay «${guardado}».`,
      )
      e.codigo = 'SE_GUARDO_OTRO_VALOR'
      e.estado = 500
      throw e
    }
  }

  return fila
}

//
// EL IMPORT ES DIRECTO, Y ANTES NO LO ERA.
//
// Antes esto era un `dbOne` perezoso que alguien tenía que activar con
// `conectarAuditoria(one)` antes de poder usarlo. Cada test y cada módulo
// tenía que acordarse. El que se olvidaba se llevaba un «no se ha guardado
// nada» en TODAS sus altas, que es la forma más ruidosa y más difícil de
// diagnosticar que tiene un fallo de este tipo.
//
// No hay ciclo de importación: `db/client.js` no importa este fichero. Y si lo
// hubiera, se rompería al arrancar y no al escribir, que es peor, pero se vería.
//
import { one as dbOne } from '../db/client.js'

/** Se mantiene por compatibilidad, pero ya no hace falta para nada. */
export function conectarAuditoria() {}