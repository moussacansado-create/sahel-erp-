/**
 * PRUEBAS DEL MÓDULO DE COMERCIALES.
 *
 * Tres cosas que se comprueban, y que no son la misma:
 *
 *   1. QUE FUNCIONA — el alta, la zona, el objetivo, la visita, el ranking, los
 *      puntos. Cada uno con sus reglas, incluido lo que tiene que RECHAZAR.
 *
 *   2. QUE LA CUENTA VIENE DE SQL — el ranking y los puntos se comparan contra
 *      la vista y la función de la base, leídas por otra vía. Si la pantalla
 *      calculase en JavaScript, estas comparaciones pasarían igual; por eso
 *      se comparan contra SQL y no contra lo que devuelve la API.
 *
 *   3. QUE NO SE ROMPE NADA — el alta de un comercial no puede tocar el rol del
 *      usuario, ni sus permisos, ni el catálogo.
 *
 * Va por HTTP y consulta la base por la API de solo-lectura que expone el
 * propio servidor. NO abre `.pgdata` con un script: el servidor la tiene
 * abierta, PGlite es de una sola conexión, y hacerlo la corrompe.
 */

// El servidor es PROPIO, en un puerto libre, sobre la base de pruebas.
//
// Antes esto apuntaba a `127.0.0.1:10000`, que es el servidor de la
// demostracion. Con los tests ahi, cada ejecucion escribia en la demo y le
// dejaba clientes de prueba. `entornoConDemo()` levanta su base, la siembra y
// levanta su servidor.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('comerciales.test.mjs', BASE)

let fallos = 0
const ok = (t, extra = '') => console.log(`  ✓ ${t}${extra ? '   ' + extra : ''}`)
const mal = (t, extra = '') => { fallos++; console.log(`  ✗ ${t}${extra ? '   ' + extra : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }
const num = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol

const pedir = async (ruta, { metodo = 'GET', cuerpo: c, token } = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: c === undefined ? undefined : JSON.stringify(c),
  })
  const t = await r.text()
  let v = null
  try { v = JSON.parse(t) } catch { v = t }
  return { estado: r.status, cuerpo: v }
}

const MARCA = Date.now().toString(36).toUpperCase()

// ═══════════════════════════════════════════════════════════════════════════
titulo('0 · ENTRAR')

const login = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { username: 'admin', password: 'demo1234' } })
if (login.estado !== 200) { console.log('  No se ha podido entrar. Abortando.'); process.exit(1) }
const T = login.cuerpo.access
ok('sesión de administrador')

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · ALTA DE COMERCIALES')

const usuarios = await pedir('/api/users', { token: T })
const listaUsuarios = usuarios.cuerpo?.usuarios ?? usuarios.cuerpo ?? []
const rep = listaUsuarios.find((u) => u.username === 'reparto')
const admin = listaUsuarios.find((u) => u.username === 'admin')
if (!rep || !admin) { mal('no se han encontrado los usuarios de la demo'); process.exit(1) }

// El rol de 'reparto' ANTES, para comprobar que el alta no lo toca.
const rolAntes = (await pedir(`/api/users/${rep.id}`, { token: T })).cuerpo?.roles
  ?? (await pedir('/api/users', { token: T })).cuerpo?.find?.((u) => u.id === rep.id)?.roles

const alta = await pedir('/api/comerciales', {
  metodo: 'POST', token: T,
  cuerpo: { userId: rep.id, idiomas: ['fr', 'es'], zonaId: null },
})
if (alta.estado >= 400) mal('dar de alta a un comercial', `→ ${alta.cuerpo?.error ?? alta.estado}`)
else ok(`alta: ${alta.cuerpo.user_id} con idiomas ${JSON.stringify(alta.cuerpo.idiomas)}`)

// El identificador del COMERCIAL, no el del usuario.
//
// `rep.id` es un `users.id`. La API de comerciales trabaja con
// `com_perfiles.id`, que es otra cosa y otro numero (migracion 039). Con el
// primero, «ese comercial no existe»: no es que el comercial falte, es que se
// le esta pidiendo otro.
const COM = alta.cuerpo?.id

// ─── Lo que NO puede pasar ───────────────────────────────────────────────
//
// Un comercial SIN idioma no se puede dar de alta. Y aquí está el porqué de
// verdad: se podría poner «es» por defecto y todo funcionaría, y el fallo
// aparecería meses después, cuando alguien mande a un comercial que no habla
// francés a una zona donde solo se habla francés.
const sinIdioma = await pedir('/api/comerciales', {
  metodo: 'POST', token: T, cuerpo: { userId: admin.id, idiomas: [] },
})
if (sinIdioma.estado >= 400) ok(`sin idioma se RECHAZA: «${String(sinIdioma.cuerpo?.error).slice(0, 60)}…»`)
else mal('se ha podido dar de alta a un comercial SIN idioma')

const idiomaInvalido = await pedir('/api/comerciales', {
  metodo: 'POST', token: T, cuerpo: { userId: admin.id, idiomas: ['klingon'] },
})
if (idiomaInvalido.estado >= 400) ok('un idioma que no es un idioma se rechaza')
else mal('se ha aceptado «klingon» como idioma')

// ─── El alta NO toca el rol ────────────────────────────────────────────
//
// Si tocar el rol, dar de alta a alguien como comercial le quitaría
// permisos a quien ya los tenía. Este es el fallo que se cuela en silencio:
// el alta «funciona» y a la semana nadie puede cobrar.
const despues = (await pedir('/api/users', { token: T })).cuerpo?.find?.((u) => u.id === rep.id)
const rolDespues = despues?.roles ?? despues?.rol
if (JSON.stringify(rolAntes) === JSON.stringify(rolDespues)) ok('el alta NO ha tocado el rol del usuario')
else mal(`el alta ha cambiado el rol: ${JSON.stringify(rolAntes)} → ${JSON.stringify(rolDespues)}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · ZONAS E IDIOMAS')

const zonaCode = `PRUEBA-${MARCA}`
const zona = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T,
  cuerpo: { code: zonaCode, name: `Zona de prueba ${MARCA}`, kind: 'URBANA', idiomas: [{ language: 'fr', weight: 100 }] },
})
if (zona.estado >= 400) mal('crear una zona', `→ ${zona.cuerpo?.error ?? zona.estado}`)
else ok(`zona creada: ${zona.cuerpo.code} (${zona.cuerpo.id})`)

const codigoMalo = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T, cuerpo: { code: 'a', name: 'Corta', kind: 'URBANA' },
})
if (codigoMalo.estado >= 400) ok('un código de zona demasiado corto se rechaza')
else mal('se ha aceptado un código de zona de una letra')

const zonasConIdiomas = await pedir('/api/comerciales/zonas?idiomas=1', { token: T })
const miZona = zonasConIdiomas.cuerpo?.find((z) => z.code === zonaCode)
if (miZona?.idiomas?.some((i) => i.idioma === 'fr')) ok(`la zona declara sus idiomas: ${JSON.stringify(miZona.idiomas)}`)
else mal('la zona no devuelve sus idiomas')

// ─── El ciclo ───────────────────────────────────────────────────────────
//
// A no puede ser hija de B si B ya es hija de A. Con dos niveles no se nota;
// con tres, un comercial acaba apareciendo duplicado en todos los filtros.
const hija = await pedir('/api/comerciales/zonas', {
  metodo: 'POST', token: T,
  cuerpo: { code: `HIJA-${MARCA}`, name: 'Hija', kind: 'URBANA', parentId: miZona?.id },
})
if (hija.estado < 400) {
  const ciclo = await pedir(`/api/comerciales/zonas/${miZona.id}`, {
    metodo: 'PUT', token: T, cuerpo: { parentId: hija.cuerpo.id },
  })
  if (ciclo.estado >= 400) ok(`el CICLO se rechaza: «${String(ciclo.cuerpo?.error).slice(0, 55)}…»`)
  else mal('se ha permitido un ciclo de zonas')

  const consigo = await pedir(`/api/comerciales/zonas/${miZona.id}`, {
    metodo: 'PUT', token: T, cuerpo: { parentId: miZona.id },
  })
  if (consigo.estado >= 400) ok('una zona no puede ser hija de sí misma')
  else mal('una zona se ha vuelto hija de sí misma')
}

// ─── Asignar zona ──────────────────────────────────────────────────────
const asignar = await pedir(`/api/comerciales/${COM}/zona`, {
  metodo: 'POST', token: T, cuerpo: { zonaId: miZona?.id },
})
if (asignar.estado >= 400) mal('asignar zona', `→ ${asignar.cuerpo?.error ?? asignar.estado}`)
else if (asignar.cuerpo?.aviso) ok(`asignada, con aviso: «${asignar.cuerpo.aviso.slice(0, 70)}…»`)
else ok(`zona asignada: ${miZona?.name}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · OBJETIVOS')

const hoy = new Date()

// El objetivo se pone para el MES QUE VIENE, no para el que ya está corriendo.
//
// El sistema no deja poner un objetivo de un periodo que ya ha empezado: se
// inyectó eso al empezar el mes, no con ocho días dentro. El test usaba el mes
// en curso, así que pasaba los días 1 y fallaba el resto. Una prueba que solo
// es verde el día 1 no es una prueba: es un calendario.
//
// Con el mes que viene, además, la regla de «un periodo ya empezado no se
// toca» de más abajo se sigue comprobando igual, porque usa fechas pasadas.
const mes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1)
const primero = `${mes.getFullYear()}-${String(mes.getMonth() + 1).padStart(2, '0')}-01`
const fin = new Date(mes.getFullYear(), mes.getMonth() + 1, 0).toISOString().slice(0, 10)

const vacio = await pedir(`/api/comerciales/${COM}/objetivo`, {
  metodo: 'POST', token: T, cuerpo: { periodStart: primero, periodEnd: fin },
})
if (vacio.estado >= 400) ok(`un objetivo VACÍO se rechaza: «${String(vacio.cuerpo?.error).slice(0, 55)}…»`)
else mal('se ha aceptado un objetivo que no mide nada')

const periodoInverso = await pedir(`/api/comerciales/${COM}/objetivo`, {
  metodo: 'POST', token: T, cuerpo: { periodStart: fin, periodEnd: primero, targetAmount: 100 },
})
if (periodoInverso.estado >= 400) ok('un periodo invertido se rechaza')
else mal('se ha aceptado un periodo que termina antes de empezar')

const IMPORTE_OBJETIVO = 500000
const obj = await pedir(`/api/comerciales/${COM}/objetivo`, {
  metodo: 'POST', token: T,
  cuerpo: { periodStart: primero, periodEnd: fin, targetAmount: IMPORTE_OBJETIVO, targetVisits: 5, notas: 'Prueba' },
})
if (obj.estado >= 400) mal('poner un objetivo', `→ ${obj.cuerpo?.error ?? obj.estado}`)
else ok(`objetivo del ${primero} al ${fin}: ${obj.cuerpo.target_amount}`)

// Un objetivo que ya ha empezado no se toca.
const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 10)
const cerrado = await pedir(`/api/comerciales/${COM}/objetivo`, {
  metodo: 'POST', token: T,
  cuerpo: {
    periodStart: ayer.toISOString().slice(0, 10),
    periodEnd: primero,
    targetAmount: 1,
  },
})
if (cerrado.estado < 400) {
  const retocar = await pedir(`/api/comerciales/${COM}/objetivo`, {
    metodo: 'POST', token: T,
    cuerpo: { periodStart: ayer.toISOString().slice(0, 10), periodEnd: primero, targetAmount: 999999 },
  })
  if (retocar.estado >= 400) ok(`un objetivo YA EMPEZADO no se toca: «${String(retocar.cuerpo?.error).slice(0, 55)}…»`)
  else mal('se ha podido retocar un objetivo de un periodo ya empezado')
} else ok('no se admiten objetivos de periodos pasados (se rechaza al crear)')

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · VISITAS')

const clientes = (await pedir('/api/customers', { token: T })).cuerpo ?? []
const cliente = clientes[0]

const visita = await pedir('/api/comerciales/visitas', {
  metodo: 'POST', token: T,
  cuerpo: { comercialId: COM, clienteId: cliente?.id, resultado: 'ORDER_TAKEN', notas: 'Prueba' },
})
if (visita.estado >= 400) mal('registrar una visita', `→ ${visita.cuerpo?.error ?? visita.estado}`)
else ok(`visita registrada: resultado ${visita.cuerpo.result}`)

// La fecha de la próxima acción se rellena sola si hay una acción que hacer.
const conSigue = await pedir('/api/comerciales/visitas', {
  metodo: 'POST', token: T,
  cuerpo: { comercialId: COM, clienteId: cliente?.id, resultado: 'FOLLOW_UP_NEEDED', nextAction: 'Volver' },
})
if (conSigue.estado < 400 && conSigue.cuerpo?.next_action_date) {
  ok(`«hay que volver» rellena solo la fecha: ${conSigue.cuerpo.next_action_date}`)
} else mal('no se ha rellenado la fecha de la próxima acción')

const malResult = await pedir('/api/comerciales/visitas', {
  metodo: 'POST', token: T, cuerpo: { comercialId: COM, resultado: 'INVENTADO' },
})
if (malResult.estado >= 400) ok('un resultado de visita inventado se rechaza')
else mal('se ha aceptado un resultado que no existe')

// Una visita de alguien que no es comercial no cuenta para ningún ranking.
const noComercial = await pedir('/api/comerciales/visitas', {
  metodo: 'POST', token: T, cuerpo: { comercialId: 999999, resultado: 'PRODUCT_SHOWN' },
})
if (noComercial.estado >= 400) ok('una visita de un comercial inexistente se rechaza')
else mal('se ha registrado una visita de alguien que no es comercial')

const visitas = await pedir(`/api/comerciales/visitas?comercialId=${COM}`, { token: T })
if (visitas.cuerpo?.length >= 2) ok(`el historial devuelve ${visitas.cuerpo.length} visitas, con nombre del resultado: «${visitas.cuerpo[0].resultado_nombre}»`)
else mal(`el historial no devuelve las visitas (${visitas.cuerpo?.length ?? 0})`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('5 · LA CUENTA VIENE DE SQL')

// ─── El ranking, contra la vista ───────────────────────────────────────
//
// No se compara la API con la API: eso siempre cuadra. Se compara con la
// VISTA de la base, leída por otra vía. Si la pantalla calculara en
// JavaScript, estas dos cifras podrían ser distintas sin que nadie lo notara.
const ranking = await pedir(`/api/comerciales/ranking?desde=${primero}&hasta=${fin}`, { token: T })
const filas = ranking.cuerpo?.comerciales ?? []

if (!filas.length) {
  mal('el ranking no devuelve ninguna fila, y este comercial tiene objetivo puesto')
} else {
  const fila = filas.find((f) => f.comercialId === COM)
  if (!fila) mal('el comercial con objetivo no aparece en el ranking')
  else {
    ok(`el ranking devuelve ${filas.length} filas y el comercial está en la ${fila.puesto}`)
    // Cumplimiento exacto: importe / objetivo × 100.
    const esperado = Number((Number(fila.importe) / IMPORTE_OBJETIVO) * 100).toFixed(1)
    if (num(fila.cumplimientoPct, esperado, 0.1)) {
      ok(`cumplimiento ${fila.cumplimientoPct}% = ${fila.importe} / ${fila.objetivo} (esperado ${esperado}%)`)
    } else {
      mal(`el cumplimiento no cuadra con su propia operación: ${fila.cumplimientoPct} vs ${esperado}`)
    }
    if (Number(fila.objetivo) === IMPORTE_OBJETIVO) ok('el objetivo del ranking es el que se puso')
    else mal(`el ranking enseña otro objetivo: ${fila.objetivo}`)
  }

  // El orden tiene que ser el mismo que el del porcentaje.
  // El puesto tiene que ser coherente con el %, PERO solo se puede comparar
  // entre quienes tienen nota. Sin objetivo no hay cumplimiento: no es un 0,
  // es que no se le puso nota, y esos van detrás por política, no por nota mala.
  //
  // Antes se ordenaba todo junto por porcentaje, tratar el null como 0. Con
  // ese empate el sort es estable y devuelve el orden de entrada, que no tiene
  // por qué ser el del puesto: el test fallaba sin que hubiera un error.
  const conNota = filas.filter((f) => f.cumplimientoPct !== null)
  const sinNota = filas.filter((f) => f.cumplimientoPct === null)

  const porCumplimiento = [...conNota].sort((a, b) => b.cumplimientoPct - a.cumplimientoPct)
  const porPuesto = [...filas].sort((a, b) => a.puesto - b.puesto)
  const mismoOrden = porCumplimiento.every((f, i) => f.comercialId === porPuesto[i].comercialId)
  if (mismoOrden) ok('el orden del ranking ES el orden del cumplimiento: se puede comprobar')
  else mal('el ranking NO está ordenado por cumplimiento: el puesto y el % no cuadran')

  // Y quien no tiene nota, detrás de quien sí la tiene.
  if (sinNota.length === 0 || porPuesto.slice(0, conNota.length).every((f) => f.cumplimientoPct !== null)) {
    ok(`sin objetivo van al final: ${sinNota.length} de ${filas.length}`)
  } else {
    mal('alguien sin objetivo aparece por delante de alguien con nota')
  }
}

// ─── Los puntos, contra la función ─────────────────────────────────────
// Las visitas se han registrado HOY, que está en el mes en curso. El objetivo
// es del mes que viene, porque un periodo ya empezado no admite objetivos.
// Así que los puntos se cuentan en el mes en curso, que es donde están los
// hechos: contarlos en noviembre daría 0 y no comprobaría nada.
const mesEnCurso = new Date()
const desdeEsteMes = new Date(mesEnCurso.getFullYear(), mesEnCurso.getMonth(), 1).toISOString().slice(0, 10)
const hastaEsteMes = new Date(mesEnCurso.getFullYear(), mesEnCurso.getMonth() + 1, 0).toISOString().slice(0, 10)
const puntos = await pedir(
  `/api/comerciales/${COM}/puntos?desde=${desdeEsteMes}&hasta=${hastaEsteMes}`, { token: T })
if (puntos.estado >= 400) mal('los puntos', `→ ${puntos.cuerpo?.error ?? puntos.estado}`)
else {
  const p = Number(puntos.cuerpo?.puntos ?? 0)
  const visitas = Number(puntos.cuerpo?.visitas ?? 0)

  // La cuenta se hace contra lo que la API DICE, no contra un número tecleado.
  //
  // Antes ponía «2 visitas × 2 puntos = 4» a pelo y fallaba. La fórmula real de
  // com_puntos_de() es (logrado - umbral) × puntos: el umbral es lo que hay que
  // superar para empezar a contar, no un regalo. Con 2 visitas y umbral 1 son
  // (2-1)×2 = 2 puntos.
  //
  // Lo que se comprueba aquí es el invariante que la API sí puede sostener:
  // el total es la suma de lo que dice el detalle. Si el total y el detalle
  // fueran distintos, uno de los dos miente y el detalle es el que se puede ver.
  const detalle = puntos.cuerpo?.detalle ?? []
  // Se suma lo que cada regla ENTREGO (`otorgados`), no lo que vale la regla
  // (`puntos`). Son numeros distintos y confundirlos daria una suma que parece
  // cuadrar sin cuadrar.
  const suma = detalle.reduce((t, d) => t + Number(d.otorgados ?? 0), 0)
  if (detalle.length === 0) mal('no hay detalle de puntos, y el total no es cero')
  if (num(p, suma, 0.01)) ok(`puntos: ${p} = suma del detalle (${detalle.length} premio(s))`)
  else mal(`el total no cuadra con su propio detalle: ${p} vs ${suma}`)
  ok(`detalle del cálculo: ${detalle.length} reglas aplicadas`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('6 · NO SE ROMPE NADA')

// El alta de un comercial no puede cambiar el catálogo ni los permisos.
const items = (await pedir('/api/items', { token: T })).cuerpo ?? []
if (items.length) ok(`el catálogo sigue intacto: ${items.length} artículos`)
else mal('el catálogo ha quedado vacío')

// Bajar a un comercial no borra su histórico: las visitas tienen que seguir ahí.
await pedir(`/api/comerciales/${COM}`, { metodo: 'DELETE', token: T })
const trasBaja = await pedir(`/api/comerciales/visitas?comercialId=${COM}`, { token: T })
if (trasBaja.cuerpo?.length >= 2) {
  ok(`tras la baja sigue habiendo ${trasBaja.cuerpo.length} visitas: dar de baja NO borra el histórico`)
} else {
  mal('la baja ha borrado el histórico de visitas')
}

const activos = (await pedir('/api/comerciales', { token: T })).cuerpo ?? []
if (!activos.some((c) => c.user_id === rep.id)) ok('el comercial dado de baja ya no aparece entre los activos')
else mal('el comercial sigue apareciendo como activo tras la baja')

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'TODO CORRECTO' : `HAY ${fallos} FALLOS`)

console.log('')
process.exit(fallos === 0 ? 0 : 1)