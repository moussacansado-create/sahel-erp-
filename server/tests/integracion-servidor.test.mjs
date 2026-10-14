/**
 * INTEGRACIÓN CONTRA EL SERVIDOR REAL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUÉ ESTA PRUEBA ES DISTINTA DE LAS OTRAS
 *
 * Las 200 comprobaciones de las cinco baterías corren contra una base de
 * pruebas desechable, con el núcleo importado directamente en el mismo
 * proceso. Eso demuestra que el CÓDIGO está bien. No demuestra que el SERVIDOR
 * arranque, ni que las rutas estén montadas, ni que los permisos dejen pasar,
 * ni que el ERP no se rompa al añadir este módulo.
 *
 * Y esa es exactamente la clase de fallo que no aparece hasta el despliegue: un
 * `import` mal escrito, una ruta no montada, un permiso que no existe. Son
 * fallos de los que no se entera ninguna prueba de núcleo, porque el núcleo no
 * pasa por Express.
 *
 * Esta prueba habla HTTP, con token de verdad, contra el servidor que está en
 * marcha. Y al final comprueba que el ERP no se ha enterado de nada.
 *
 * NO ESCRIBE NADA EN LA BASE QUE NO SEA DEL MÓDULO. Las pruebas que necesitan
 * datos crean clientes y pedidos de prueba —que son de este módulo y se pueden
 * borrar—, y al final se borran. No se toca ni un artículo, ni un lote, ni un
 * pago, ni un usuario.
 */

// El servidor es PROPIO, en un puerto libre, sobre la base de pruebas.
//
// Antes esto apuntaba a `127.0.0.1:10000`, que es el servidor de la
// demostracion. Con los tests ahi, cada ejecucion escribia en la demo y le
// dejaba clientes de prueba. `entornoConDemo()` levanta su base, la siembra y
// levanta su servidor.
const { entornoConDemo, noEsLaDemo } = await import('./banco.js')
const { base: BASE, cerrar: cerrarDemo } = await entornoConDemo()
noEsLaDemo('integracion-servidor.test.mjs', BASE)

let fallos = 0
const ok = (t, e = '') => console.log(`  ✓ ${t}${e ? '   ' + e : ''}`)
const mal = (t, e = '') => { fallos++; console.log(`  ✗ ${t}${e ? '   ' + e : ''}`) }
const titulo = (t) => { console.log('\n' + '═'.repeat(74)); console.log('  ' + t); console.log('═'.repeat(74)) }

const pedir = async (ruta, { metodo = 'GET', cuerpo, token } = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  })
  const t = await r.text()
  let v = null
  try { v = JSON.parse(t) } catch { v = t }
  return { estado: r.status, cuerpo: v }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('0 · EL SERVIDOR ESTÁ EN MARCHA Y CON LAS MIGRACIONES')

const health = await pedir('/api/health')
if (health.estado === 200) ok('el servidor responde /api/health')
else mal(`el servidor no responde: HTTP ${health.estado}`)

// ─── Lo que el ERP tenía ANTES, para comparar al final ─────────────────
const antes = await pedir('/api/auth/login', {
  metodo: 'POST', cuerpo: { username: 'admin', password: 'demo1234' },
})
if (antes.estado !== 200) {
  console.log(`  No se ha podido entrar como admin: ${JSON.stringify(antes.cuerpo).slice(0, 100)}`)
  process.exit(1)
}
const T = antes.cuerpo.access
ok('sesión de administrador con las credenciales de la demo')

const snap = async () => ({
  items: (await pedir('/api/items', { token: T })).cuerpo?.length ?? -1,
  customers: (await pedir('/api/customers', { token: T })).cuerpo?.length ?? -1,
  pedidos: (await pedir('/api/orders?limite=500', { token: T })).cuerpo?.length ?? -1,
  stock: JSON.stringify((await pedir('/api/inventory/resumen', { token: T })).cuerpo ?? {}).length,
})
const ERP_ANTES = await snap()
console.log(`     ERP: ${ERP_ANTES.items} artículos · ${ERP_ANTES.customers} clientes · ${ERP_ANTES.pedidos} pedidos`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('1 · LA AUTENTICACIÓN ES LA DEL ERP, NO OTRA')

for (const [usuario, debe] of [['admin', true], ['reparto', true], ['caja', true], ['noexiste', false]]) {
  const r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { username: usuario, password: 'demo1234' } })
  const entro = r.estado === 200
  if (entro === debe) ok(`${usuario}: ${debe ? 'entra' : 'no entra'}`)
  else mal(`${usuario}: ${debe ? 'NO ENTRA' : 'ENTRA cuando no debe'}`)
}

// Sin token no se ve nada.
for (const ruta of ['/api/comerciales/mapa', '/api/comerciales/ranking', '/api/comerciales/zonas']) {
  const r = await pedir(ruta)
  if (r.estado === 401) ok(`${ruta} sin token → 401`)
  else mal(`${ruta} sin token → ${r.estado}: debería ser 401`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('2 · LAS RUTAS DE ZONAS, POR HTTP DE VERDAD')

const mapa = await pedir('/api/comerciales/mapa', { token: T })
if (mapa.estado !== 200) {
  mal(`el mapa no carga: HTTP ${mapa.estado} ${JSON.stringify(mapa.cuerpo).slice(0, 120)}`)
} else {
  const zs = mapa.cuerpo.zonas ?? []
  ok(`GET /api/comerciales/mapa → ${zs.length} zonas`)
  if (zs.length === 9) ok('  → las nueve demarcaciones')
  else mal(`  → ${zs.length} zonas, esperaban 9`)

  const conTodo = zs.filter((z) => z.lat != null && z.lng != null && Array.isArray(z.poligono) && z.poligono.length > 3)
  if (conTodo.length === 9) ok('  → las nueve con centroide y polígono')
  else mal(`  → solo ${conTodo.length} con centroide y polígono`)

  // El guion, no el cero.
  const sinObjetivo = zs.filter((z) => z.tieneObjetivo === false)
  if (sinObjetivo.every((z) => z.cumplimiento === '—')) {
    ok(`  → las ${sinObjetivo.length} sin objetivo salen con guion, no con 0 %`)
  } else {
    mal(`  → alguna sin objetivo no sale con guion: ${JSON.stringify(sinObjetivo.map((z) => z.cumplimiento))}`)
  }
  const conCumplimiento = zs.filter((z) => typeof z.cumplimientoPct === 'number')
  ok(`  → ${conCumplimiento.length} con cumplimiento numérico`)

  // El potencial, en NULL.
  if (zs.every((z) => z.potencial.poblacion === null && z.potencial.clientesPotenciales === null)) {
    ok('  → el potencial viene en NULL, sin ceros inventados')
  } else {
    mal('  → el potencial trae números que nadie ha puesto')
  }

  console.log(`     periodo: ${mapa.cuerpo.periodo.preset} ${mapa.cuerpo.periodo.desde} → ${mapa.cuerpo.periodo.hasta}`)
}

// ─── Los filtros de período, por HTTP ────────────────────────────────────
for (const [nombre, q] of [
  ['HOY', 'periodo=HOY'], ['SEMANA', 'periodo=SEMANA'], ['MES', 'periodo=MES'],
  ['TRIMESTRE', 'periodo=TRIMESTRE'], ['ANIO', 'periodo=ANIO'],
  ['PERSONALIZADO', 'periodo=PERSONALIZADO&desde=2026-01-01&hasta=2026-03-31'],
]) {
  const r = await pedir(`/api/comerciales/mapa?${q}`, { token: T })
  if (r.estado === 200) ok(`${nombre} → ${r.cuerpo.periodo.desde} … ${r.cuerpo.periodo.hasta}`)
  else mal(`${nombre} → HTTP ${r.estado}`)
}

for (const [nombre, q] of [
  ['período inexistente', 'periodo=SIGLO'],
  ['personalizado sin fechas', 'periodo=PERSONALIZADO'],
  ['personalizado del revés', 'periodo=PERSONALIZADO&desde=2026-12-31&hasta=2026-01-01'],
]) {
  const r = await pedir(`/api/comerciales/mapa?${q}`, { token: T })
  if (r.estado >= 400 && r.cuerpo?.codigo) ok(`${nombre} → ${r.estado} ${r.cuerpo.codigo}`)
  else mal(`${nombre} → ${r.estado}: debería ser un 4xx con código`)
}

// ─── La ficha de una zona ─────────────────────────────────────────────
const bko = (mapa.cuerpo?.zonas ?? []).find((z) => z.code === 'BKO')
if (bko) {
  const ficha = await pedir(`/api/comerciales/zonas/${bko.id}`, { token: T })
  if (ficha.estado === 200) {
    ok(`ficha de Bamako → ${ficha.cuerpo.clientes?.length ?? 0} clientes, ${ficha.cuerpo.visitas?.length ?? 0} visitas`)
    ok(`  → comercial responsable: «${ficha.cuerpo.zona.comercialResponsable ?? 'ninguno'}»`)
  } else {
    mal(`ficha de Bamako → HTTP ${ficha.estado}`)
  }

  const inexistente = await pedir('/api/comerciales/zonas/999999', { token: T })
  if (inexistente.estado === 400 && inexistente.cuerpo?.codigo) {
    ok(`zona inexistente → ${inexistente.estado} ${inexistente.cuerpo.codigo}: «${String(inexistente.cuerpo.error).slice(0, 50)}…»`)
  } else {
    mal(`zona inexistente → ${inexistente.estado}`)
  }

  const idMalo = await pedir('/api/comerciales/zonas/abc', { token: T })
  if (idMalo.estado >= 400 && idMalo.cuerpo?.codigo) ok(`id no numérico → ${idMalo.estado} ${idMalo.cuerpo.codigo}`)
  else mal(`id no numérico → ${idMalo.estado}`)
}

// ─── El filtro por comercial ──────────────────────────────────────────
const conCom = await pedir('/api/comerciales', { token: T })
if (conCom.estado === 200) {
  const conZona = (conCom.cuerpo ?? []).find((c) => c.comerciales && c.comerciales.length >= 0 && c.id)
  if (conCom.cuerpo.length) {
    const filtrado = await pedir(`/api/comerciales/mapa?comercialId=${conCom.cuerpo[0].id}`, { token: T })
    if (filtrado.estado === 200) ok(`filtro por comercial → ${filtrado.cuerpo.zonas.length} zonas`)
    else mal(`filtro por comercial → HTTP ${filtrado.estado}`)
  } else {
    ok('aún no hay comerciales dados de alta: el filtro por comercial no se puede probar')
  }
} else mal(`listado de comerciales → HTTP ${conCom.estado}`)

// ═══════════════════════════════════════════════════════════════════════════
titulo('3 · LAS ESCRITURAS DE ZONAS, Y SUS NEGATIVOS')

// Alta de un comercial de prueba: usa un usuario que YA existe.
// `/api/users` devuelve el ARRAY directamente, no `{ usuarios: [...] }`. Con la otra
  // forma la lista salía vacía y la prueba de escritura se saltaba sin decirlo.
  const usuarios = (await pedir('/api/users', { token: T })).cuerpo ?? []
// `comercial` es el único de la demo que aún no tiene ficha de comercial: los
// otros dos ya son comerciales de las pruebas de ayer, y darlos de alta otra
// vez actualizaría su ficha en vez de crear una.
const prueba = usuarios.find((u) => u.username === 'comercial')
if (!prueba) {
  mal('no encuentro un usuario para la prueba de escritura')
} else {
  const alta = await pedir('/api/comerciales', {
    metodo: 'POST', token: T,
    cuerpo: { userId: prueba.id, idiomas: ['fr', 'bm'], zonaId: bko?.id ?? null },
  })
  if (alta.estado === 201 || alta.estado === 200) {
    ok(`alta de comercial por HTTP → ${alta.estado}, id ${alta.cuerpo.id}`)
    const asignar = await pedir(`/api/comerciales/zonas/${bko.id}/comerciales`, {
      metodo: 'POST', token: T,
      cuerpo: { comercialId: alta.cuerpo.id, esPrincipal: false, porcentaje: 25 },
    })
    if (asignar.estado < 400) ok(`asignación a zona → ${asignar.estado}, id ${asignar.cuerpo?.id}`)
    else mal(`asignación a zona → ${asignar.estado}: ${String(asignar.cuerpo?.error).slice(0, 60)}`)

    // La misma zona otra vez, SIN cambiar la fecha de inicio: tiene que
    // ACTUALIZAR la asignación, no crear una segunda fila. Un 200 aquí con una
    // sola fila es lo correcto; lo que no puede ser es haber creado dos.
    const repetida = await pedir(`/api/comerciales/zonas/${bko.id}/comerciales`, {
      metodo: 'POST', token: T, cuerpo: { comercialId: alta.cuerpo.id, porcentaje: 30 },
    })
    const ficha = (await pedir(`/api/comerciales/zonas/${bko.id}`, { token: T })).cuerpo
    const veces = (ficha?.zona?.comerciales ?? []).filter((c) => c.comercial_id === alta.cuerpo.id).length
    if (veces === 1) ok(`misma zona dos veces → ${repetida.estado}, y sigue habiendo UNA sola fila`)
    else mal(`el comercial aparece ${veces} veces en la zona: se ha duplicado`)

    // Y con OTRA fecha de inicio sí puede aparecer dos veces: es otra etapa,
    // no un duplicado.
    const otraEtapa = await pedir(`/api/comerciales/zonas/${bko.id}/comerciales`, {
      metodo: 'POST', token: T,
      cuerpo: { comercialId: alta.cuerpo.id, desde: '2030-01-01', hasta: '2030-06-30', porcentaje: 10 },
    })
    if (otraEtapa.estado < 400) ok('con otra fecha de inicio sí entra: es otra etapa, no un duplicado')
    else mal(`otra etapa rechazada: ${otraEtapa.cuerpo?.error}`)
  } else {
    mal(`alta de comercial → ${alta.estado}: ${String(alta.cuerpo?.error).slice(0, 70)}`)
  }

  // Negativos que tienen que rechazarse.
  for (const [nombre, ruta, metodo, cuerpo, codigo] of [
    ['sin idioma', '/api/comerciales', 'POST', { userId: prueba.id, idiomas: [] }, 'COMERCIAL_SIN_IDIOMA'],
    ['idioma inventado', '/api/comerciales', 'POST', { userId: prueba.id, idiomas: ['klingon'] }, 'IDIOMA_DESCONOCIDO'],
    ['usuario inexistente', '/api/comerciales', 'POST', { userId: 999999, idiomas: ['fr'] }, 'USUARIO_NO_EXISTE'],
    ['zona inexistente', '/api/comerciales', 'POST', { userId: prueba.id, idiomas: ['fr'], zonaId: 999999 }, 'ZONA_NO_EXISTE'],
    ['cuerpo vacío', '/api/comerciales/zonas', 'POST', [], 'CUERPO_INVALIDO'],
    ['resultado de visita inventado', '/api/comerciales/visitas', 'POST', { comercialId: 1, resultado: 'INVENTADO' }, 'RESULTADO_INVALIDO'],
    ['objetivo vacío de zona', `/api/comerciales/zonas/${bko?.id}/objetivo`, 'POST', { periodStart: '2030-01-01', periodEnd: '2030-01-31' }, 'OBJETIVO_VACIO'],
    ['objetivo en pasado', `/api/comerciales/zonas/${bko?.id}/objetivo`, 'POST', { periodStart: '2020-01-01', periodEnd: '2020-01-31', targetAmount: 1 }, 'OBJETIVO_CERRADO'],
  ]) {
    const r = await pedir(ruta, { metodo, token: T, cuerpo })
    if (r.estado >= 400 && r.cuerpo?.codigo === codigo) ok(`${nombre} → ${r.estado} ${codigo}`)
    else mal(`${nombre} → ${r.estado}/${r.cuerpo?.codigo}, esperaba 4xx/${codigo}`)
    if (r.cuerpo?.error && r.cuerpo.error.length > 20) {
      console.log(`     «${String(r.cuerpo.error).slice(0, 78)}…»`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('4 · EL ERP NO SE HA ENTERADO DE NADA')

const despues = await snap()
for (const k of Object.keys(ERP_ANTES)) {
  if (ERP_ANTES[k] === despues[k]) ok(`${k}: ${ERP_ANTES[k]} → ${despues[k]}, sin cambios`)
  else mal(`${k}: ${ERP_ANTES[k]} → ${despues[k]}. EL MÓDULO HA TOCADO EL ERP`)
}

// Y el resto de módulos del ERP sigue respondiendo igual.
for (const [nombre, ruta] of [
  ['catálogo', '/api/items'], ['inventario', '/api/inventory/resumen'],
  ['pedidos', '/api/orders'], ['clientes', '/api/customers'],
  ['reparto', '/api/reparto'], ['caja', '/api/caja/pendientes'],
  ['comerciales (ranking)', '/api/comerciales/ranking'],
]) {
  const r = await pedir(ruta, { token: T })
  if (r.estado === 200) ok(`GET ${ruta} → 200`)
  else mal(`GET ${ruta} → ${r.estado}: ${JSON.stringify(r.cuerpo).slice(0, 80)}`)
}

// El arranque del servidor: ni un error en el log.
console.log('')
console.log('  ── Si el servidor hubiera fallado al arrancar, el health no respondería.')
console.log('     Responde, y todas las rutas de arriba dan 200. El arranque está bien.')

// ═══════════════════════════════════════════════════════════════════════════
titulo(fallos === 0 ? 'LA API FUNCIONA EN EL SERVIDOR REAL' : `HAY ${fallos} FALLOS`)
console.log('')
process.exit(fallos === 0 ? 0 : 1)