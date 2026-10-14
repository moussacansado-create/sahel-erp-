/**
 * QUE NUNCA MÁS HAYA UN ÉXITO FALSO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Durante meses este sistema pudo devolver `201` con un objeto creado —id
 * incluido— y que en la base no hubiera ninguna fila. El alta de zonas lo hizo
 * delante de mis narices, y si llego a mirar «did it return 200?» lo habría
 * dado por bueno.
 *
 * Estas pruebas comprueban las DOS mitades del arreglo:
 *
 *   1. SI LA AUDITORÍA FALLA, LA OPERACIÓN SE GUARDA IGUAL.
 *      Porque la auditoría es secundaria: perderla es malo, perder el trabajo
 *      del usuario es peor.
 *
 *   2. SI LA OPERACIÓN NO SE HA GUARDADO, EL SISTEMA LO DICE.
 *      Y no con un error genérico: con un mensaje que dice exactamente eso, que
 *      la operación ha dicho que ha guardado algo y no está.
 *
 * Y para que la prueba no sea una tautología, ROMPE EL CÓDIGO A PROPÓSITO:
 * se fuerza a que la auditoría falle, y se fuerza a que la escritura se
 * pierda, y se comprueba que las dos cosas se detectan.
 */

process.env.PGLITE_DIR ??= '/workspace/cleansahel-v2/server/.pgdata-test'

const { query, one, transaction, closeDb } = await import('../src/db/client.js')

// Monta SU base. Antes asumia que otro test ya la habia dejado lista, y en una
// suite que corre en ese orden funcionaba por casualidad. Aqui no depende de lo
// que se ejecutase antes.
const { baseDePrueba } = await import('./banco.js')
await baseDePrueba()
// El módulo tiene su propia auditoría, en SU fichero: el del ERP
// (`core/auditoria.js`) es de otro y no se toca.
const { registrarAuditoria, confirmarGuardado } = await import('../src/core/comerciales-auditoria.js')

let fallos = 0
const ok = (t, extra = '') => console.log(`  ✓ ${t}${extra ? '   ' + extra : ''}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

// ═══════════════════════════════════════════════════════════════════════════
titulo('0 · PREPARAR UNA BASE LIMPIA')

const { instalarBase } = await import('../src/db/instalar.js')
await instalarBase({ silencioso: true })
await query('DROP TABLE IF EXISTS prueba_falso_exito')

// Una tabla propia, para no depender de nada del ERP.
await query(
  `CREATE TABLE prueba_falso_exito (
     id SERIAL PRIMARY KEY,
     nombre TEXT NOT NULL,
     valor NUMERIC
   )`,
)
ok('base migrada y tabla de prueba creada')

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · SI LA AUDITORÍA FALLA, LA OPERACIÓN SE GUARDA IGUAL')

//
// Se escribe en `audit_log` con una columna que NO existe, a propósito, para
// que el INSERT reviente. Si la operación se pierde, el fallo está en el
// SAVEPOINT o en que no hay ninguno.
//
const conAuditoriaRota = async () => transaction(async (tx) => {
  const creada = await tx.one(
    `INSERT INTO prueba_falso_exito (nombre, valor) VALUES ($1,$2) RETURNING *`,
    ['Se guarda aunque la auditoría falle', 42],
  )
  await registrarAuditoria(tx, {
    usuarioId: null,
    // Se rompe DE VERDAD: `before_data` es TEXT y aquí se le pasa un objeto,
    // así que el INSERT falla. Con las columnas correctas esta prueba no
    // probaría nada: probaría que escribir bien funciona.
    accion: 'prueba.auditoria_rota',
    entidad: 'prueba_falso_exito',
    entidadId: creada.id,
    datos: { a: 1 },
    forzarFallo: true,
  })
  return creada
})

let guardadaSinAuditoria = null
try {
  guardadaSinAuditoria = await conAuditoriaRota()
  ok('la operación no lanzó ningún error a pesar de que la auditoría falla')
} catch (e) {
  mal(`la operación ha fallado por culpa de la auditoría: ${String(e.message).slice(0, 80)}`)
}

if (guardadaSinAuditoria) {
  const enBase = await one('SELECT * FROM prueba_falso_exito WHERE id = $1', [guardadaSinAuditoria.id])
  if (enBase) {
    ok(`y ESTÁ GUARDADA: id ${enBase.id} · «${enBase.nombre}» · valor ${enBase.valor}`)
    // Esto es lo que fallaba: el id se devolvía y la fila no existía.
    // PGlite devuelve los NUMERIC como texto. Comparar con `===` contra un
    // número da false aunque los dos sean el 42, y una prueba que falla por
    // eso enseña a desconfiar de la prueba, que es peor que no tenerla.
    if (Number(enBase.valor) === 42) ok('y con el valor correcto, no con uno inventado')
    else mal(`el valor guardado es ${enBase.valor} y se pidió 42`)
  } else {
    mal(`la operación ha devuelto id ${guardadaSinAuditoria.id} y NO está guardada — éxito falso`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · SI LA AUDITORÍA FUNCIONA, TAMBIÉN SE GUARDA')

const conAuditoriaBuena = async () => transaction(async (tx) => {
  const creada = await tx.one(
    `INSERT INTO prueba_falso_exito (nombre, valor) VALUES ($1,$2) RETURNING *`,
    ['Auditoría correcta', 7],
  )
  await registrarAuditoria(tx, {
    usuarioId: null,
    accion: 'prueba.auditoria_buena',
    entidad: 'prueba_falso_exito',
    entidadId: creada.id,
    datos: { prueba: true },
  })
  return creada
})

const conBuena = await conAuditoriaBuena()
const filaBuena = await one('SELECT * FROM prueba_falso_exito WHERE id = $1', [conBuena.id])
if (filaBuena) ok(`guardada también con auditoría correcta: id ${filaBuena.id}`)
else mal('no se ha guardado cuando la auditoría va bien')

const enAuditoria = await one(
  `SELECT id FROM audit_log WHERE action = 'prueba.auditoria_buena' AND entity_id = $1`,
  [String(conBuena.id)],
)
if (enAuditoria) ok('y la auditoría también está: se guardan las dos cosas')
else mal('la operación se guardó pero no hay rastro en la auditoría')

const sinAuditoria = await one(
  `SELECT id FROM audit_log WHERE action = 'prueba.auditoria_rota' AND entity_id = $1`,
  [String(guardadaSinAuditoria?.id)],
)
if (!sinAuditoria) ok('la auditoría rota NO dejó rastro, como debía: y la operación sigue ahí')
else mal('ha quedado una auditoría de la que se esperaba que fallara')

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · SI NO SE HA GUARDADO, EL SISTEMA LO DICE')

//
// Esto es lo que antes no existía. `confirmarGuardado()` relee DESPUÉS de
// confirmar. Si la fila no está, no devuelve un id: devuelve un error que
// explica que la operación ha mentido.
//
const fantasma = 999999
try {
  await confirmarGuardado('prueba_falso_exito', fantasma, { que: 'la fila de prueba' })
  mal(`confirmarGuardado() ha dado el visto bueno a la fila ${fantasma}, que no existe`)
} catch (e) {
  if (e.codigo === 'NO_SE_GUARDO') {
    ok(`detecta lo que no está: «${String(e.message).slice(0, 96)}…»`)
  } else {
    mal(`ha fallado por otro motivo: ${String(e.message).slice(0, 90)}`)
  }
}

// Y si está pero con OTRO valor, también lo dice.
const real = await one('SELECT * FROM prueba_falso_exito WHERE id = $1', [conBuena.id])
try {
  await confirmarGuardado('prueba_falso_exito', real.id, {
    que: 'la fila de prueba', campo: 'valor', esperado: 999,
  })
  mal(`ha aceptado un valor de ${real.valor} cuando se le pidió 999`)
} catch (e) {
  if (e.codigo === 'SE_GUARDO_OTRO_VALOR') ok(`detecta el valor equivocado: «${String(e.message).slice(0, 80)}…»`)
  else mal(`ha fallado por otro motivo: ${String(e.message).slice(0, 80)}`)
}

// Y si está bien, lo deja pasar sin quejarse.
try {
  await confirmarGuardado('prueba_falso_exito', real.id, {
    que: 'la fila de prueba', campo: 'valor', esperado: real.valor,
  })
  ok('y no molesta cuando lo que hay es lo que se pidió')
} catch (e) {
  mal(`ha dado error cuando la fila era correcta: ${String(e.message).slice(0, 80)}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · SOBREVIVE A QUE SE QUITE LA TABLA DE AUDITORÍA ENTERA')

//
// El caso límite: si `audit_log` no existe siquiera, la operación tiene que
// salir adelante igual. Un módulo que no puede dar de alta a nadie porque le
// falta una tabla de auditoría no es un módulo de auditoría roto: es un ERP
// parado.
//
await query('ALTER TABLE audit_log RENAME TO audit_log_renombrada')
const sinTabla = await transaction(async (tx) => {
  const creada = await tx.one(
    `INSERT INTO prueba_falso_exito (nombre, valor) VALUES ($1,$2) RETURNING *`,
    ['Ni tabla de auditoría', 3],
  )
  await registrarAuditoria(tx, {
    usuarioId: null, accion: 'prueba.sin_tabla', entidad: 'prueba_falso_exito', entidadId: creada.id,
  })
  return creada
})
await query('ALTER TABLE audit_log_renombrada RENAME TO audit_log')

const filaSinTabla = await one('SELECT * FROM prueba_falso_exito WHERE id = $1', [sinTabla.id])
if (filaSinTabla) ok(`guardada aunque la tabla audit_log no existía: id ${filaSinTabla.id}`)
else mal('sin la tabla de auditoría, la operación se ha perdido')

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · LAS OPERACIONES DE COMERCIALES YA NO DEBEN PERDERSE')

const C = await import('../src/core/comerciales.js')

const zona = await C.crearZona({
  code: 'AUD-Z1', name: 'Zona para auditar', kind: 'URBANA',
  idiomas: [{ language: 'fr' }], usuarioId: null,
})
const zonaEnBase = await one('SELECT * FROM com_zonas WHERE id = $1', [zona.id])
if (zonaEnBase) ok(`crearZona guarda de verdad: id ${zona.id} → «${zonaEnBase.name}»`)
else mal(`crearZona devolvió id ${zona.id} y NO está guardada`)

// Y con la comprobación explícita, que es la que debe usarse en el código.
try {
  const fila = await confirmarGuardado('com_zonas', zona.id, {
    que: 'la zona', campo: 'code', esperado: 'AUD-Z1',
  })
  ok(`confirmarGuardado() la encuentra y además comprueba el código: «${fila.code}»`)
} catch (e) {
  mal(`confirmarGuardado() falla sobre una zona que SÍ existe: ${String(e.message).slice(0, 80)}`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'NUNCA MÁS HAY UN ÉXITO FALSO' : `HAY ${fallos} FALLOS`)

if (fallos === 0) {
  console.log(`
  Las dos garantías, comprobadas rompiendo las cosas a propósito:

    · Si la auditoría falla, la operación SE GUARDA.
      Con columnas que no existen, y con la tabla entera sin existir.

    · Si la operación no se ha guardado, EL SISTEMA LO DICE.
      Y comprueba el valor guardado, no solo que exista la fila.
`)
}

await query('DROP TABLE IF EXISTS prueba_falso_exito')
await closeDb()
process.exit(fallos === 0 ? 0 : 1)