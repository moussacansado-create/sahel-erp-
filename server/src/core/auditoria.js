/**
 * Registro de auditoría.
 *
 * Vive en su propio módulo porque lo necesitan todas las áreas —clientes,
 * pedidos, inventario, producción, albaranes, entregas— y estaba metido dentro
 * de `inventario.js`, donde los demás no lo alcanzaban. Copiar la función en
 * cada sitio habría sido peor: seis sitios que se olvidan de actualizar.
 *
 * `audit_log` es append-only: hay un disparador en PostgreSQL que impide
 * modificar o borrar lo que ya está escrito. Por eso no hay `update` ni
 * `delete` en ninguna parte del código.
 */
export async function auditar(tx, { usuarioId, accion, entidad, entidadId, antes, despues }) {
  await tx.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_data, after_data, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS')`,
    [usuarioId, accion, entidad, String(entidadId ?? ''),
     antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null],
  )
}

/**
 * Intenta auditar sin tumbar la operación.
 *
 * Solo se usa en la ruta de error. Si la escritura del log falla, lo que
 * importa es que el error original llegue al usuario: perder un registro de
 * auditoría no puede convertirse en perder un pedido.
 */
export async function auditarFallo(tx, { usuarioId, accion, entidad, entidadId, motivo }) {
  try {
    await tx.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, after_data, outcome)
       VALUES ($1,$2,$3,$4,$5,'FAILURE')`,
      [usuarioId, accion, entidad, String(entidadId ?? ''), JSON.stringify({ motivo })],
    )
  } catch {
    // Se traga el fallo a propósito. Ver la nota de arriba.
  }
}
