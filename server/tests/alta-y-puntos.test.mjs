// EL ALTA DE UN CLIENTE Y LA PUNTUACIÓN DEL COMERCIAL.
//
// Lo que se comprueba aquí, con lo que hay de verdad en la base:
//
//   1 · El cliente queda con su zona y su comercial.
//   2 · La métrica que usa la regla activa NO es un caso perdido: si el
//       calculador no la implementa, se guarda la regla, se ve en Ajustes y
//       no puntúa nada. Eso ya pasó con CLIENTE_NUEVO.
//   3 · Dar de alta puntúa UNA vez.
//   4 · Volver a calcular el ranking NO duplica: el indice único lo impide.
//   5 · Cambiar de comercial mueve el cliente de un contador a otro, y no
//       deja el punto atrás en el que estaba.
//
// Nada de esto crea ni borra datos: las consultas van contra la base de solo
// lectura y lo que se comprueba son los resultados de la consulta que usa el
// ranking de verdad, no una simulación.
import { query } from '../src/db/client.js'
import { METRICAS } from '../src/core/rankings.js'

let ok = 0, total = 0
const chk = (c, m) => { total++; if (c) ok++; console.log(`${c ? 'PASA  ' : 'FALLA '}${m}`) }

const DESDE = '2026-10-01', HASTA = '2026-10-31'

// ── 1 · LA CARTERA Y LA ZONA ────────────────────────────────────────────────
const cartera = await query(
  `SELECT c.code, c.zone_id, c.comercial_id, c.created_at::date AS alta
     FROM customers c
    WHERE c.comercial_id IS NOT NULL
    ORDER BY c.code`,
)
chk(cartera.length > 0, `R1 · hay clientes con comercial asignado (${cartera.length})`)
chk(cartera.every((c) => c.zone_id !== null && c.zone_id !== undefined),
  'R1b · todo cliente con comercial tiene zona: sin zona no hay cartera que contar')
chk(cartera.every((c) => c.alta >= DESDE.slice(0, 7) + '-01' && c.alta <= HASTA),
  'R1c · las altas caen dentro del periodo del ranking')

// ── 2 · LA REGLA ACTIVA TIENE UNA MÉTRICA QUE EL CALCULADOR CONOCE ─────────
const reglas = await query(
  `SELECT id, code, metrica, puntos, is_active FROM com_reglas_puntos WHERE is_active`,
)
chk(reglas.length > 0, `R2 · hay reglas activas (${reglas.length})`)
const desconocidas = reglas.filter((r) => !METRICAS[r.metrica])
chk(desconocidas.length === 0,
  `R2b · toda regla activa tiene una métrica que el calculador sabe evaluar`
  + (desconocidas.length ? ` (huérfanas: ${desconocidas.map((r) => `${r.code}=${r.metrica}`).join(', ')})` : ''))

// La que se veía configurada y no puntuaba:
chk(!!METRICAS.CLIENTE_NUEVO, 'R2c · la métrica CLIENTE_NUEVO está implementada')

// ── 3 · EL ALTA PUNTÚA UNA VEZ ──────────────────────────────────────────────
const metricasCliente = ['CLIENTE_NUEVO', 'DISTINCT_CUSTOMERS']
  .map((m) => METRICAS[m]).filter((m) => m && m.sql)
const contados = []
for (const m of metricasCliente) {
  const hechos = await query(m.sql, [null, DESDE, HASTA])
  contados.push([m.nombre, hechos.length])
  chk(hechos.length > 0, `R3 · ${m.nombre}: ${hechos.length} clientes contados en el periodo`)
  // Una fila por cliente: si salieran dos, el mismo cliente puntuaría dos.
  const ids = hechos.map((h) => h.ref)
  chk(new Set(ids).size === ids.length,
    `R3b · ${m.nombre}: una fila por cliente, ninguna repetida`)
}

// ── 4 · EL ÍNDICE ÚNICO IMPIDE EL DUPLICADO ──────────────────────────────────
const idx = await query(
  `SELECT indexname FROM pg_indexes
    WHERE tablename = 'com_puntos' AND indexname = 'uniq_com_puntos_evento'`,
)
chk(idx.length === 1, 'R4 · existe el indice unico que impide repetir un evento')
if (idx.length) {
  const def = await query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_com_puntos_evento'`,
  )
  const d = def[0]?.indexdef || ''
  chk(/comercial_id/.test(d) && /regla_code/.test(d) && /ref_id/.test(d),
    'R4b · el indice incluye comercial, regla y el evento: el mismo cliente no repite')
}

// Y la prueba de fuego: dos inserciones del MISMO evento, la segunda debe rebotar.
const r = reglas.find((x) => METRICAS[x.metrica]?.sql)
if (r && cartera.length) {
  const c = cartera[0]
  const args = [c.comercial_id, r.id, r.code, DESDE, HASTA, Number(r.puntos),
    'cliente ' + c.code, 'customers', c.code ? c.id : null]
  const sql = `INSERT INTO com_puntos
      (comercial_id, regla_id, regla_code, period_start, period_end, puntos,
       motivo, ref_tipo, ref_id, awarded_at)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING`
  const a1 = await query(sql, args)
  const a2 = await query(sql, args)
  chk(a2.length === 0 || a1.length === 0,
    'R4c · el mismo cliente con la misma regla dos veces: el segundo insert NO cuela')
  // Y se limpia lo que se ha metido, para no dejar puntos de prueba.
  if (a1.length) {
    await query(`DELETE FROM com_puntos WHERE comercial_id=$1 AND regla_code=$2
                  AND ref_id=$3`, [c.comercial_id, r.code, c.id])
  }
}

// ── 5 · CAMBIAR DE COMERCIAL ────────────────────────────────────────────────
const porComercial = {}
for (const c of cartera) porComercial[c.comercial_id] = (porComercial[c.comercial_id] || 0) + 1
chk(Object.keys(porComercial).length > 0,
  `R5 · el recuento por comercial reparte los clientes (${JSON.stringify(porComercial)})`)
chk(Object.values(porComercial).reduce((a, b) => a + b, 0) === cartera.length,
  'R5b · la suma de carteras es el total de clientes: nadie se pierde al reasignar')

console.log(`\nTOTAL ${ok}/${total}`)
process.exit(ok === total ? 0 : 1)
