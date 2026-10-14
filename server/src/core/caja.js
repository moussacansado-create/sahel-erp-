/**
 * CAJA
 *
 * Lo que pasa cuando un repartidor vuelve con el dinero encima.
 *
 * ── QUÉ ES Y QUÉ NO ES ESTO ────────────────────────────────────────────────
 *
 * No es un saldo. No es un «le debes X» que alguien ajusta a mano. Es el
 * contraste entre DOS HECHOS que ya existen:
 *
 *   1. Los cobros que el repartidor hizo, y que siguen sin entregarse.
 *   2. Lo que la caja cuenta cuando tiene el dinero en la mano.
 *
 * Cuando los dos coinciden, se concilia. Cuando no, se ANOTA la diferencia con
 * su explicación, y no se arregla: una diferencia que se arregla sola no es una
 * conciliación, es un inconveniente.
 *
 * ── POR QUÉ NO HAY UN CAMPO DE «LO QUE LLEVA» ─────────────────────────────
 *
 * Porque ese campo sería un saldo guardado, y un saldo guardado se
 * desincroniza de los cobros que lo justifican en cuanto alguien cobra algo y
 * no actualiza el campo. Un céntimo de desfase aquí es un céntimo que nadie
 * busca, porque el sistema dice que cuadra.
 *
 * Lo que lleva se cuenta, cada vez, con `fn_por_entregar()`.
 *
 * Y `import('../db/client.js')` es un MÓDULO, no un `{ default }`: ese
 * fichero no tiene export por defecto, y desestructurarlo daba `undefined`
 * —que no falla al importar sino al primer `db.one()`, en producción, con
 * un repartidor esperando y la caja sin poder mirar lo que lleva.
 *
 * ── LA REGLA DE LAS DOS PERSONAS ───────────────────────────────────────────
 *
 * `handed_by` es quien llevaba el dinero. `received_by` es una persona con su
 * usuario, no una «caja». Y son dos usuarios DISTINTOS: nadie se entrega dinero
 * a sí mismo declarando que cuadra, porque si se lo entrega a sí mismo la
 * conciliación no está comprobando nada.
 */

import { transaction } from '../db/client.js'

/** A quién se le puede entregar dinero. El ADMIN entra, por si no hay nadie más. */
const ROLES_QUE_COBRAN = ['DELIVERY', 'ADMIN']

/**
 * Quiénes llevan dinero encima ahora mismo.
 *
 * Es una CONSULTA, no un campo: la caja mira a los repartidores que tienen
 * cobros sin entregar y les dice lo que llevan. Un repartidor que no tiene nada
 * no aparece, porque no hay nada que entregarle.
 *
 * @param {string} moneda
 */
export async function quienLlevaDinero(moneda = 'XOF') {
  const db = await import('../db/client.js')
  return db.query(
    `SELECT d.user_id, u.full_name, u.username,
            d.currency_code, d.cobrado, d.entregado, d.en_su_poder,
            fn_por_entregar(d.user_id, d.currency_code) AS lleva_ahora,
            (SELECT COUNT(*) FROM payments p
              WHERE p.collected_by = d.user_id
                AND p.status = 'PENDING') AS cobros_por_verificar
       FROM v_deuda_repartidor d
       JOIN users u ON u.id = d.user_id
      WHERE d.currency_code = $1
        AND fn_por_entregar(d.user_id, d.currency_code) > 0
        AND u.is_active
      ORDER BY d.en_su_poder DESC, u.full_name`,
    [moneda],
  )
}

/**
 * Abrir un traspaso.
 *
 * NO LLEVA IMPORTE. Solo quién entrega, a quién y en qué moneda. Lo que
 * receives es un HECHO de la caja —lo que ha contado en la mano— y ese se
 * escribe, pero se escribe al RECIBIR, no al abrir. Al abrir solo se declara
 * quién viene y para qué moneda.
 *
 * Que el importe esperado no se escriba es lo mismo que en los cobros, y por el
 * mismo motivo: la cuenta la hace la base.
 *
 * @param {{handedBy:number, receivedBy:number, moneda?:string, nota?:string,
 *          usuarioId:number}} entrada
 */
export async function abrirTraspaso({
  handedBy, receivedBy, moneda = 'XOF', nota = null, usuarioId,
}) {
  if (!handedBy) throw new Error('Falta quién lleva el dinero')
  if (!receivedBy) throw new Error('Falta quién lo recibe')

  //
  // Nadie se entrega dinero a sí mismo.
  //
  // Suena a tontería y no lo es. Si el mismo usuario puede abrir y recibir su
  // propio traspaso, la conciliación no está comparando dos personas: está
  // comparando una consigo misma, que siempre cuadra. Es el modo más barato
  // de no comprobar nada.
  //
  if (Number(handedBy) === Number(receivedBy)) {
    throw Object.assign(
      new Error(
        'El mismo usuario no puede entregarse dinero a sí mismo. Una conciliación '
        + 'compara a QUIEN PAGA con QUIEN RECIBE, y si son la misma persona no '
        + 'está comparando nada.',
      ),
      { codigo: 'CAJA_NO_SI_MISMO' },
    )
  }

  return transaction(async (tx) => {
    const quien = await tx.one(
      `SELECT id, full_name FROM users WHERE id = $1 AND is_active`, [handedBy])
    if (!quien) throw new Error('Ese repartidor no existe o está desactivado')

    const receptor = await tx.one(
      `SELECT id, full_name FROM users WHERE id = $1 AND is_active`, [receivedBy])
    if (!receptor) throw new Error('Ese receptor de caja no existe o está desactivado')

    const lleva = await tx.one(
      `SELECT fn_por_entregar($1, $2) AS n`, [handedBy, moneda])

    if (Number(lleva.n) <= 0) {
      throw Object.assign(
        new Error(
          `${quien.full_name} no lleva nada por entregar en ${moneda}. No hay `
          + 'traspaso que hacer: una caja que abre un traspaso de cero es una '
          + 'caja que se ha inventado un traspaso.',
        ),
        { codigo: 'SIN_DINERO_QUE_ENTREGAR' },
      )
    }

    // `expected_amount` no se manda: lo pone el disparador, con
    // `fn_por_entregar()`. Lo que entra en el INSERT es NULL, no un 0.
    const t = await tx.query(
      `INSERT INTO cash_handoffs
         (handed_by, received_by, currency_code, note, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [handedBy, receivedBy, moneda, nota, usuarioId],
    )
    return t[0]
  })
}

/**
 * RECIBIR.
 *
 * Aquí sí entra una cifra: la que la caja ha contado. Es la realidad, y puede
 * no coincidir con lo esperado —de ahí que pueda haber diferencia.
 *
 * Y el dinero que se recibe TIENE que ser el dinero de los cobros concretos. Se
 * eligen y se enlazan en la MISMA transacción que el traspaso, porque separarlo
 * es justo el agujero que dejó el sistema con la caja llena y el repartidor
 * debiendo.
 *
 * @param {{traspasoId:number, recibido:number, nota?:string,
 *          pagos?:number[], usuarioId:number}} entrada
 */
export async function recibirDinero({
  traspasoId, recibido, nota = null, pagos = null, usuarioId,
}) {
  if (recibido === undefined || recibido === null) {
    throw new Error('Falta lo que se ha recibido')
  }
  if (!(Number(recibido) >= 0)) {
    throw new Error('Lo recibido no puede ser negativo')
  }

  return transaction(async (tx) => {
    const t = await tx.one(
      `SELECT * FROM cash_handoffs WHERE id = $1 FOR UPDATE`, [traspasoId])
    if (!t) throw new Error('Ese traspaso no existe')
    if (t.status !== 'PENDING') {
      throw Object.assign(
        new Error(
          `El traspaso ${t.id} ya está en estado ${t.status} y no se vuelve a recibir.`
          + ' Un traspaso recibido una vez es un hecho, no un borrador.',
        ),
        { codigo: 'TRASPASO_YA_RECIBIDO' },
      )
    }
    if (t.handed_by === t.received_by) {
      throw new Error('Un traspaso a sí mismo no concilia nada.')
    }

    //
    // Los cobros que se entregan.
    //
    // Si quien llama NO dice cuáles, se enlazan TODOS los que ese repartidor
    // lleva sin entregar en esa moneda. Es lo que hace falta para un traspaso
    // normal, y sobre todo para que no exista el caso «la caja tiene el dinero
    // y el repartidor sigue debiéndolo».
    //
    // Si quien llama SÍ dice cuáles, se comprueba que la suma sea la que dice
    // haber recibido. La caja cuenta una cifra y tiene que poder decir de qué
    // cobros sale; si no puede, lo que ha hecho es escribir un número, y eso es
    // una cuenta a mano con pasos.
    //
    //
    // Si quien llama dice QUÉ cobros, hay que ir a buscarlos: se reciben ids,
    // y un id suelto no lleva ni importe ni moneda. La primera versión usaba la
    // lista tal cual y acababa enlazando «cobro NULL»: el dinero se receive sin
    // que el guard se enterara, y el reparto se quedaba igual.
    //
    const aEntregar = pagos
      ? await tx.query(
        `SELECT id, amount, currency_code, collected_by FROM payments WHERE id = ANY($1::bigint[])`, [pagos])
      : await tx.query(
        `SELECT id, amount, currency_code FROM payments
          WHERE collected_by = $1 AND status <> 'REJECTED' AND currency_code = $2
            AND NOT EXISTS (SELECT 1 FROM payment_handoffs ph WHERE ph.payment_id = payments.id)
          ORDER BY id`, [t.handed_by, t.currency_code])

    // Y que sean REALMENTE de este repartidor, por mucho que la caja los nombre.
    // La base lo comprueba también al enlazar, pero aquí el error dice algo
    // que alguien puede entender: «este cobro no es de este repartidor».
    for (const p of aEntregar) {
      if (p.collected_by !== undefined && p.collected_by !== t.handed_by) {
        throw new Error(
          `El cobro ${p.id} no es de este repartidor. La caja ha elegido unos `
          + 'cobros que no son los que entrega.',
        )
      }
    }

    if (!aEntregar.length) {
      throw Object.assign(
        new Error('Ese repartidor no tiene cobros que entregar.'),
        { codigo: 'SIN_DINERO_QUE_ENTREGAR' },
      )
    }

    const suma = aEntregar.reduce((t2, p) => t2 + Number(p.amount), 0)
    if (Math.abs(suma - Number(t.expected_amount)) > 0.0001) {
      throw new Error(
        `Los cobros elegidos suman ${suma} y el repartidor llevaba ${t.expected_amount}. `
        + 'Se han elegido unos cobros que no son los que lleva.',
      )
    }

    //
    // EL ORDEN IMPORTA, Y ESTE ES EL ORDEN.
    //
    // Primero se marca el traspaso como recibido. Después se enlazan los cobros.
    //
    // Al revés no funciona, y no por un detalle: `tg_enlace_no_mezcla` no deja
    // enlazar un cobro a un traspaso PENDING —dar el dinero por recibido antes
    // de recibirlo es exactamente lo que no se quiere—. Así que la primera
    // versión, que enlazaba y luego actualizaba, se rechazaba a sí misma con
    // el mensaje de su propia regla. La regla estaba bien; el orden, al revés.
    //
    // La cuenta de la discrepancia se hace ANTES de enlazar, y a propósito: en
    // ese momento el repartidor todavía «lleva» el dinero, que es lo que hay
    // que comparar con lo que la caja ha contado. Si se calculara después, el
    // pendiente ya sería cero y todo cuadraría siempre.
    //
    //
    // ANTES de escribir nada: si esto no cuadra y no hay explicación, no se
    // toca la base. La diferencia se puede calcular aquí porque lo esperado ya
    // está en `t.expected_amount` y lo recibido en `recibido`.
    //
    // La regla de verdad la pone `chk_handoff_discrepancy`, en la base, y no se
    // mueve. Esto es solo para que el error sea de personas y no del motor.
    //
    const habraDiferencia = Math.abs(Number(recibido) - Number(t.expected_amount)) > 0.0001
    if (habraDiferencia && (!nota || nota.trim().length < 3)) {
      throw Object.assign(
        new Error(
          `Faltan o sobran ${Math.abs(Number(recibido) - Number(t.expected_amount))} `
          + `${t.currency_code}. Un traspaso que no cuadra tiene que decir por `
          + 'qué: sin explicación, la diferencia se queda ahí y nadie la vuelve a mirar.',
        ),
        { codigo: 'DISCREPANCY_SIN_EXPLICACION' },
      )
    }

    const recibido_ = await tx.query(
      `UPDATE cash_handoffs
          SET received_at = now(),
              received_amount = $2,
              note = COALESCE($3, note),
              status = CASE WHEN abs($2 - fn_por_entregar(handed_by, currency_code)) < 0.0001
                            THEN 'RECONCILED' ELSE 'DISCREPANCY' END
        WHERE id = $1
        RETURNING id, status, expected_amount, received_amount, difference, note`,
      [traspasoId, recibido, nota],
    )
    const salida = recibido_[0]

    for (const p of aEntregar) {
      await tx.query(
        `INSERT INTO payment_handoffs (payment_id, handoff_id) VALUES ($1, $2)`,
        [p.id, t.id],
      )
    }

    // Y el estado, ya calculado. `expected_amount` NO se manda: sale de la
    // función, en el disparador. `difference` tampoco.
    //
    //
    // Y si no cuadra, el estado es DISCREPANCY aunque los enlaces ya estén
    // puestos. Un traspaso con diferencia se guarda igual —se guarda CON SU
    // DIFERENCIA, que es lo que hay que revisar—, pero solo si alguien dice por
    // qué.
    //
    // Y aquí, ANTES de tocar la base. `chk_handoff_discrepancy` ya impide
    // guardar una discrepancia sin nota, y está bien que lo impida; lo que
    // hace es devolver el texto crudo del motor. Si se espera a ese error, la
    // persona que está de caja se encuentra con un «violates check constraint»
    // en vez de con «faltan 400 y hay que decir por qué». La regla sigue
    // estando en la base; el aviso de aquí es el que se entiende.
    //
    //
    // El traspaso guardado, con su diferencia si la hubo. Lo que se devuelve es
    // lo que la base ha dicho, no lo que el código quería decir.
    //
    return { ...salida, cobros_entregados: aEntregar.length }
  })
}

/**
 * Lo que queda de un repartidor, DESPUÉS de este traspaso.
 *
 * Se devuelve recalculado con la función, no con `en_su_poder` del traspaso,
 * que es el valor de ANTES de entregar. Confundir las dos cosas es como
 * vaciar un cubo y mirar el cubo antes de vaciarlo: el número que vale
 * es el de después.
   */
export async function saldoDe(usuarioId, moneda = 'XOF') {
  const db = await import('../db/client.js')
  return db.one('SELECT fn_por_entregar($1, $2) AS lleva_ahora', [usuarioId, moneda])
}

/** Los traspasos de una persona, y quién los recibió. */
export async function listarTraspasos({ usuarioId = null, moneda = null, limite = 50 } = {}) {
  const db = await import('../db/client.js')
  return db.query(
    `SELECT h.id, h.handed_at, h.received_at, h.currency_code,
            h.expected_amount, h.received_amount, h.difference, h.status, h.note,
            emisor.full_name AS entrega, receptor.full_name AS recibe,
            (SELECT COUNT(*) FROM payment_handoffs ph WHERE ph.handoff_id = h.id) AS cobros
       FROM cash_handoffs h
       JOIN users emisor   ON emisor.id = h.handed_by
       JOIN users receptor ON receptor.id = h.received_by
      WHERE ($1::int IS NULL OR h.handed_by = $1 OR h.received_by = $1)
        AND ($2::text IS NULL OR h.currency_code = $2)
      ORDER BY h.created_at DESC
      LIMIT $3`,
    [usuarioId, moneda, limite],
  )
}
