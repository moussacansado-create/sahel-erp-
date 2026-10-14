/**
 * EL DINERO NO SE PIERDE.
 *
 * Estas pruebas existen por una razón concreta: el redondeo no se ve. Un
 * importe que pierde tres céntimos sigue pareciendo un importe, la factura
 * sigue cuadrando consigo misma, y nadie se entera hasta que la cuenta no
 * llega. Aquí se mira justo eso: que lo que se guarda sea EXACTO lo que se
 * calculó.
 *
 * LA REGLA QUE COMPRUEBAN
 *
 *   Se guarda EXACTO. Se redondea AL PRESENTAR, y solo una vez.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EL CASO QUE LAS HIZO NECESARIAS
 *
 * Las columnas de dinero eran `NUMERIC(18,2)`: dos decimales. Suena prudente,
 * y es una pérdida constante e invisible, porque PostgreSQL redondea al
 * insertar, aunque el código lleve la cifra exacta. Encima, compras redondeaba
 * en JavaScript ANTES de guardar, y por tres sitios distintos en la misma
 * línea: el importe, el subtotal acumulado y el impuesto.
 *
 * Con dos decimales, mil operaciones de medio céntimo son cincuenta céntimos.
 * Nada. Con cuatro decimales y cien mil líneas, son decenas de euros. Y lo
 * peor no es la cantidad: es que no hay forma de saber cuánto se ha perdido,
 * porque nadie dejó de escribir el número.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'clave-de-pruebas-dinero-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'test'

const { baseDePrueba, query, one, closeDb } = await import('./banco.js')
const D = await import('../src/core/dinero.js')
const V = await import('../src/core/compras.js')

let u = null
let persona = null
let art

test.before(async () => {
  await baseDePrueba()
  persona = (await one(
    `INSERT INTO users (username, full_name, password_hash, password_changed_at)
     VALUES ('tesorero','Contabilidad','x', now()) RETURNING id`)).id
  u = (await one(`SELECT id FROM units ORDER BY id LIMIT 1`)).id
})
test.after(async () => { await closeDb() })

// El artículo dice en qué moneda está. En el catálogo hay un DEFAULT ('XOF'),
// pero aquí se dice igualmente: un test que depende de un valor por omisión
// deja de comprobar lo que cree que está comprobando en cuanto ese valor cambia.
const nuevoArticulo = async (sku, moneda = 'XOF') => (await one(
  `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix,currency_code)
   VALUES ($1,'Artículo de prueba','RAW_MATERIAL',$2,'DIN',$3) RETURNING id`,
  [sku, u, moneda])).id

// ═══════════════════════════════════════════════════════════════════════════
// 1 · LA BASE NO PIERDE CIFRAS AL GUARDAR
// ═══════════════════════════════════════════════════════════════════════════

test('las columnas de dinero guardan cuatro decimales, no dos', async () => {
  // El punto donde se perdía el dinero sin que nadie lo viera. NUMERIC(18,2)
  // hacía el redondeo PostgreSQL, en el INSERT, por mucho que el código
  // mandase la cifra exacta: la base no le daba sitio.
  for (const [tabla, columna] of [
    ['purchase_orders', 'subtotal'], ['purchase_orders', 'tax_amount'],
    ['purchase_orders', 'total'], ['sales_orders', 'total'],
    ['sales_order_lines', 'line_total'], ['expenses', 'amount'],
  ]) {
    const c = await one(
      `SELECT numeric_precision AS p, numeric_scale AS s
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`, [tabla, columna])
    assert.ok(c, `debe existir ${tabla}.${columna}`)
    assert.equal(Number(c.s), 4,
      `${tabla}.${columna} es NUMERIC(18,${c.s}): con dos decimales PostgreSQL ` +
      `redondea al guardar y la pérdida es invisible`)
  }

  // Y los precios unitarios ya estaban en 18,4: ahora los precios y sus
  // totales hablan el mismo idioma, que es lo que siempre se quiso.
  const p = await one(
    `SELECT numeric_scale AS s FROM information_schema.columns
      WHERE table_name = 'purchase_lines' AND column_name = 'unit_cost'`)
  assert.equal(Number(p.s), 4)
})

test('un importe con cuatro decimales entra ÍNTEGRO en la base', async () => {
  // La prueba de humo: si la columna es 18,4, esto se guarda tal cual. Si
  // alguien la vuelve a estrechar, esta prueba falla en el INSERT.
  const prov = (await one(
    `INSERT INTO suppliers (code, name) VALUES ('PRO-PREC','Precisión') RETURNING id`)).id
  const a = await nuevoArticulo('DIN-PREC-1')
  const o = await V.crearOrden({
    supplierId: prov,
    lineas: [{ itemId: a, qtyOrdered: 1, unitCost: 0.1234 }],
    userId: persona,
  })
  const fila = await one(
    `SELECT unit_cost FROM purchase_lines WHERE purchase_order_id = $1`, [o.id])
  assert.equal(Number(fila.unit_cost), 0.1234, 'el precio entra tal cual')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · LA CONVERSIÓN
// ═══════════════════════════════════════════════════════════════════════════

test('1,50 EUR son 983,9355 FCFA — y se guardan sin redondear', async () => {
  // El ejemplo del diseño, tal cual. Si alguien «redondea» aquí para que salga
  // 984, ha perdido 0,0645 FCFA en este documento, y en los siguientes mil.
  const r = D.aXof(1.50, 655.957)
  assert.equal(r.importe, 983.9355, 'sin redondear: la cifra exacta')
  assert.equal(r.moneda, 'XOF')
  assert.equal(r.tasa, 655.957, 'y guarda la tasa con la que se hizo')

  // Lo que ve el cliente es otra cosa, y se decide DESPUÉS.
  assert.equal(D.redondearPara('XOF', r.importe), 984, 'el documento muestra entero')
  assert.equal(D.diferenciaDeRedondeo(r.importe, 984), 0.0645,
    'y la diferencia queda anotada, no perdida')
})

test('la conversión es reversible hasta el cuarto decimal, y no más', async () => {
  // Se dice «hasta el cuarto decimal» a propósito. `aXof` redondea a cuatro —
  // 8098,1827 guardados de 8098,18274xx calculados—, así que al volver a
  // dividir se recupera el valor con una diferencia de hasta 0,0001.
  //
  // Prometer exactitud infinita sería falso: cuatro decimales es lo que se
  // guarda, y pretender más exigiría guardar más, que es una decisión distinta.
  const tasa = 655.957
  const original = 12.3456
  const ida = D.aXof(original, tasa).importe
  const vuelta = ida / tasa
  assert.ok(Math.abs(vuelta - original) <= 0.0001,
    `${original} → ${ida} → ${vuelta}: vuelve con precisión de cuatro decimales`)
  // Lo que NO se admite es que pierda más que eso: sería un redondeo de más.
  assert.ok(Math.abs(vuelta - original) < 0.001, 'y desde luego no más de un milésimo')
})

test('sin tasa no hay documento', async () => {
  // La tasa se LEE, no se supone. Si no hay, se dice que no hay: emitir un
  // papel con una cifra inventada es peor que no emitirlo.
  await assert.rejects(
    () => D.tasaEn('JPY', '2026-01-01'),
    (e) => e.codigo === 'TASA_INEXISTENTE',
  )
  // Y si la hay, se lee. Cero coma cincuenta y cinco con siete decimales, que
  // es lo que cabe sin perder nada.
  const t = await D.tasaEn('EUR', '2030-01-01')
  assert.equal(t, 655.957)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LA ACUMULACIÓN, QUE ES DONDE SE PERDÍA
// ═══════════════════════════════════════════════════════════════════════════

test('acumular no redondea: 1.000 veces medio céntimo siguen siendo cinco', async () => {
  // El caso queitania el comentario del redondeo por línea.
  //
  // 1.000 líneas de 0,005 son 5. Redondeando CADA línea a dos decimales, cada
  // una se convierte en 0,01 y el total acaba siendo 10: el doble. Redondeando
  // hacia abajo, cada una se convierte en 0 y el total es 0: se ha perdido
  // cinco unidades enteras. Ninguna de las dos facturas se ve rara.
  const cuenta = D.cuentaMonetaria('XOF')
  for (let i = 0; i < 1000; i++) cuenta.suma(0.0055)
  assert.equal(cuenta.exacto(), 5.5, 'la suma es exacta: 1000 × 0,0055 = 5,5')

  // Y redondeado UNA vez, al final.
  assert.equal(cuenta.total(), 6, 'y al mostrarlo son 6 FCFA enteros, no 10 ni 0')
})

test('el error de coma flotante no se acumula', async () => {
  // 0,1 + 0,2 da 0,30000000000000004 en JavaScript, y 1,1 + 2,2 da
  // 3,3000000000000003. IEEE 754 representa los decimales en binario de forma
  // aproximada, así que el error no es un descuido: es la representación.
  //
  // Da igual que hoy `0,7 + 0,1 + 0,2` dé justo 1 —depende del orden y de la
  // versión—, lo que no cambia es que 0,1 + 0,2 nunca ha dado 0,3.
  let comaFlotante = 0
  for (const v of [0.1, 0.2]) comaFlotante += v
  assert.notEqual(comaFlotante, 0.3, '0,1 + 0,2 en JavaScript nunca da 0,3')

  let otra = 0
  for (const v of [1.1, 2.2]) otra += v
  assert.notEqual(otra, 3.3, 'ni 1,1 + 2,2 da 3,3')

  // Con la cuenta entera, los dos dan exactamente lo que deben. Siempre.
  const cuenta = D.cuentaMonetaria('EUR')
  for (const v of [0.1, 0.2]) cuenta.suma(v)
  assert.equal(cuenta.exacto(), 0.3, 'en enteros de diezmilésimas: exacto')

  const otra2 = D.cuentaMonetaria('EUR')
  for (const v of [1.1, 2.2]) otra2.suma(v)
  assert.equal(otra2.exacto(), 3.3)
})

test('una factura de 60.000 líneas no pierde ni un milésimo', async () => {
  // El caso de volumen del que habla el negocio: mucho margen y mucho flujo.
  // Cada línea vale 0,0001 y hay sesenta mil. Son 6 exactamente, y si cada
  // línea se hubiera redondeado a dos decimales se habrían convertido todas en
  // 0 y la factura valdría cero.
  const cuenta = D.cuentaMonetaria('XOF')
  for (let i = 0; i < 60000; i++) cuenta.suma(0.0001)
  assert.equal(cuenta.exacto(), 6, '60 000 × 0,0001 = 6. Ni un milésimo menos.')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · EL REDONDEO OCURRE UNA VEZ Y AL FINAL
// ═══════════════════════════════════════════════════════════════════════════

test('subtotal + impuesto = total, con IVA del 21 %', async () => {
  const cuenta = D.cuentaMonetaria('XOF')
  const base = 333.33
  const iva = 0.21

  const subtotal = D.cuentaMonetaria('XOF').suma(base)
  const impuesto = D.cuentaMonetaria('XOF').suma(base * iva)
  const total = D.cuentaMonetaria('XOF').suma(subtotal.exacto()).suma(impuesto.exacto())

  // 333,33 × 0,21 = 69,9993. Y 333,33 + 69,9993 = 403,3293.
  assert.equal(impuesto.exacto(), 69.9993, 'el IVA sale exacto: 69,9993')
  assert.equal(total.exacto(), 403.3293, 'y el total es su suma exacta: 403,3293')
  assert.equal(
    Math.abs(total.exacto() - (subtotal.exacto() + impuesto.exacto())), 0,
    'el total es la suma de los otros dos, hecho sobre las cifras EXACTAS')

  // Si se redondearan ANTES de sumar pasarían dos cosas: el impuesto se
  //>printaría 70,00 y el total 403,33 — 0,0007 de más, que es exactamente el
  // trabajo de la cuenta exacta hecho dos veces.
  assert.equal(D.redondear(base * iva, 2), 70, 'el impuesto redondeado es 70,00')
  assert.equal(D.redondear(base, 2) + D.redondear(base * iva, 2), 403.33,
    'y por eso el total redondeado NO cuadra con los otros dos redondeados')
})

test('el IVA es por línea, no sobre el subtotal entero', async () => {
  // Cada línea puede llevar su propio tipo. Aplicarlo al acumulado cobraría el
  // impuesto una vez sobre todo y otra sobre cada línea.
  const porLinea = D.cuentaMonetaria('XOF')
  for (const base of [100, 100, 100]) porLinea.suma(base * 0.21)
  assert.equal(porLinea.exacto(), 63, 'tres líneas de 100 al 21 % = 63')

  // Y con tipos distintos, que es el caso que de verdad lo rompe.
  const mixto = D.cuentaMonetaria('XOF')
  mixto.suma(1000 * 0.21).suma(100 * 0.07)   // una al 21 %, otra al 7 %
  assert.equal(mixto.exacto(), 217, '210 + 7 = 217, no 1100 × 0,21 = 231')
})

test('el redondeo se aplica al presentar, según la moneda', async () => {
  // XOF sin céntimos, que es como se usa el franco CFA; EUR con dos, que es
  // lo que pone cualquier factura en euros. El ERP guarda igual en los dos
  // casos: lo que cambia es lo que se ENSEÑA.
  assert.equal(D.redondearPara('XOF', 983.9355), 984)
  assert.equal(D.redondearPara('XOF', 983.4), 983)
  assert.equal(D.redondearPara('EUR', 1.23456), 1.23)
  assert.equal(D.redondearPara('EUR', 1.235), 1.24)
})

test('el medio se va al lado correcto, siempre', async () => {
  // 1,005 es el caso que rompe a los redondeos ingenuos: 1,005 × 100 da
  // 100,49999999999999 en IEEE 754, y sin el EPSILON saldría 1,00 en vez de
  // 1,01. Medio céntimo que se va siempre al mismo lado no es redondeo: es un
  // sesgo, y sesga en la misma dirección todos los días.
  assert.equal(Math.round(1.005 * 100) / 100, 1.00,
    'sin corregir nada, JavaScript redondea 1,005 a 1,00')
  assert.equal(D.redondear(1.005, 2), 1.01, 'con el EPSILON, a 1,01')

  // Y la regla del medio en negativo, que es donde un redondeo ingenuo se
  // vuelve una pérdida de dinero con el signo cambiado.
  assert.equal(D.redondear(-1.005, 2), -1.01)
  assert.equal(D.redondear(-0.125, 2), -0.13)
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · LA MONEDA NO SE ADIVINA
// ═══════════════════════════════════════════════════════════════════════════

test('ninguna tabla de documentos se inventa la moneda', async () => {
  // Eran DEFAULT 'EUR' de la primera versión de la aplicación, cuando se
  // pensaba en euros. Hoy la base es XOF, así que ese default era una
  // contradicción esperando a que alguien insertara sin mirar.
  //
  // Quitarlo es lo que hace que el sistema falle EN VOZ ALTA: un INSERT
  // futuro que olvide la moneda revienta con un error de NOT NULL, en vez de
  // registrar en euros una factura de Mali sin que nadie se entere.
  const conDefault = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'currency_code' AND column_default IS NOT NULL
        AND table_name IN ('purchase_orders','sales_orders','expenses')`)
  assert.deepEqual(conDefault, [],
    `estos documentos aún adivinan la moneda: ${conDefault.map((x) => x.table_name).join(', ')}`)

  // Y los tres están, con la restricción activa.
  for (const t of ['purchase_orders', 'sales_orders', 'expenses']) {
    const c = await one(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'currency_code'`, [t])
    assert.equal(c.is_nullable, 'NO', `${t}.currency_code tiene que ser obligatoria`)
  }
})

test('una orden de compra guarda la moneda que se le dio, no otra', async () => {
  // Una compra REAL a un proveedor europeo sigue pudiendo estar en euros. Lo
  // que no se puede es que el sistema la convierta sola: cada documento
  // conserva su moneda, y punto.
  const prov = (await one(
    `INSERT INTO suppliers (code, name) VALUES ('PRO-EUR','Proveedor Europeo') RETURNING id`)).id
  const a = await nuevoArticulo('DIN-EUR-1')

  const enEuros = await V.crearOrden({
    supplierId: prov, lineas: [{ itemId: a, qtyOrdered: 10, unitCost: 2.5 }],
    userId: persona,
  })
  const f1 = await one(`SELECT currency_code FROM purchase_orders WHERE id = $1`, [enEuros.id])
  assert.equal(f1.currency_code, 'XOF', 'por defecto, la moneda de la empresa')

  // Si alguien compra en euros de verdad, se le pone EUR y se queda en EUR.
  // El sistema no lo convierte, no lo corrige y no avisa.
  const enEurosReal = await one(
    `INSERT INTO purchase_orders (code,supplier_id,status,order_date,currency_code,
        subtotal,tax_amount,total,created_by)
     VALUES ('COM-EUR-TEST',$1,'DRAFT',CURRENT_DATE,'EUR',25,5.25,30.25,$2)
     RETURNING id`, [prov, persona])
  const f2 = await one(
    `SELECT currency_code, total FROM purchase_orders WHERE id = $1`, [enEurosReal.id])
  assert.equal(f2.currency_code, 'EUR', 'una compra en euros se queda en euros')
  assert.equal(Number(f2.total), 30.25)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · LA TASA ES UN LIBRO, NO UN AJUSTE
// ═══════════════════════════════════════════════════════════════════════════

test('la tasa se añade con fecha y no se edita nunca', async () => {
  // Si una tasa se pudiera corregir, los documentos que la usaron empezarían a
  // decir otra cosa. Un albarán de hace seis meses tiene que seguir valiendo
  // lo que valía aunque el euro se mueva hoy.
  await one(
    `INSERT INTO exchange_rates (from_code,to_code,rate,effective_from,source)
     VALUES ('EUR','XOF',660.5,'2026-11-01','MANUAL')`)

  await assert.rejects(
    () => one(`UPDATE exchange_rates SET rate = 1 WHERE effective_from = '2026-11-01'`),
    (e) => /no se edita/i.test(e.message),
    'corregir una tasa ya escrita es imposible: se añade otra con fecha nueva')

  // Y por eso la del martes y la de noviembre conviven sin pelearse.
  assert.equal(await D.tasaEn('EUR', '2026-10-31'), 655.957)
  assert.equal(await D.tasaEn('EUR', '2026-11-01'), 660.5)
  assert.equal(await D.tasaEn('EUR', '2026-10-15'), 655.957, 'antes de noviembre, la vieja')
})

test('la vista de progreso del pedido sobrevive a la migración', async () => {
  // Se soltó para poder ensanchar las columnas y se volvió a levantar con la
  // MISMA definición. Si alguien cambia la vista en 011 y se le olvida
  // actualizar 020, esta prueba lo dice en vez de romper en producción.
  const f = await import('node:fs/promises')
  const def = (await f.readFile(
    new URL('../../db/migrations/020_precision_y_tasa.sql', import.meta.url), 'utf8'))
  const en011 = (await f.readFile(
    new URL('../../db/migrations/011_clientes_pedidos.sql', import.meta.url), 'utf8'))

  // Ojo: `indexOf` a secas finde la primera MENCION de la frase, y aquí la
  // mención va en un comentario que explica qué hace la migración. Buscar la
  // sentencia de verdad —la que va seguida de « AS» y un salto de línea— es
  // lo único que compara el SQL con el SQL.
  //
  // Se saca la SENTENCIA, no todo lo que viene detrás. Un `CREATE VIEW` no
  // tiene punto y coma en su interior, así que el primer «;» que aparece es
  // el final. Sin esto la comparación acababa faced con el `COMMENT ON
  // VIEW` de la 011 y contra el párrafo siguiente de la 020, y fallaba por
  // texto que no es de la vista.
  //
  const buscar = (texto, cabecera) => {
    const i = texto.indexOf(`${cabecera} AS\n`)
    if (i === -1) return ''
    const resto = texto.slice(i)
    const fin = resto.indexOf(';')
    return fin === -1 ? resto : resto.slice(0, fin + 1)
  }
  const a = buscar(def, 'CREATE OR REPLACE VIEW v_order_progress')
  const b = buscar(en011, 'CREATE VIEW v_order_progress')
  assert.ok(a && b, 'las dos migraciones tienen que definir la vista')
  // Se comparan con los espacios normalizados: un `CREATE VIEW` a secas frente
  // a un `CREATE OR REPLACE VIEW` no es una diferencia de la vista, y no debe
  // hacer fallar la prueba. Lo que importa es que la CONSULTA sea la misma.
  const limpia = (s) => s
    .replace(/CREATE (OR REPLACE )?VIEW/, 'CREATE VIEW')
    .replace(/\s+/g, ' ')
    .trim()
  assert.equal(limpia(a), limpia(b),
    'la vista de la migración 020 tiene que ser LITERALMENTE la de la 011')
})

// ═══════════════════════════════════════════════════════════════════════════
// 7 · TRES PRECISIONES DISTINTAS, Y POR QUÉ NO ES REDUNDANTE
// ═══════════════════════════════════════════════════════════════════════════

test('la cuenta trabaja con más precisión de la que se guarda', async () => {
  // El error que quedaba dentro del diseño anterior, y que es el mismo del
  // principio un nivel más adentro: la cuenta acumulaba a 4 decimales, igual
  // que la columna.
  //
  //   0,3702 × 0,21 = 0,077742  — y a cuatro decimales se queda en 0,0777
  //
  // Se pierden 0,000042 por línea. En cien mil líneas, 4,2 FCFA. Y lo peor es
  // que parece correcto: el total sigue cuadrando, porque se calcula con los
  // mismos números ya recortados.
  //
  // La cuenta tiene que ser MÁS precisa que la columna. Si no, al escribir se
  // pierde lo que se calculó con más cuidado del necesario, y no hay forma de
  // recuperarlo porque nadie miró nunca.
  const subtotal = D.cuentaMonetaria('XOF').suma(0.3702)
  const iva = D.cuentaMonetaria('XOF').suma(0.3702).escala(0.21)

  assert.equal(subtotal.exacto(), 0.3702)
  assert.equal(iva.exacto(), 0.077742, 'a la precisión de trabajo: el IVA íntegro')
  assert.equal(iva.guardar(), 0.0777, 'y al guardar baja a los 4 de la columna')

  assert.equal(D.PRECISION_TRABAJO, 8)
  assert.equal(D.PRECISION_GUARDADO, 4)
  assert.ok(D.PRECISION_TRABAJO > D.PRECISION_GUARDADO,
    'si se calculara con la misma precisión con la que se guarda, no habría dos precisiones')
})

test('el total se monta sobre las cifras de trabajo, no sobre las ya guardadas', async () => {
  // Si el total se calculara sumando los dos números YA redondeados a cuatro,
  // el redondeo se contaría dos veces para la misma línea. Con el IVA al 21 %,
  // una diferencia de 0,000042 por línea que nadie vería.
  const s = D.cuentaMonetaria('XOF').suma(0.3702)
  const i = D.cuentaMonetaria('XOF').suma(0.3702).escala(0.21)

  const bien = D.cuentaMonetaria('XOF').suma(s.exacto()).suma(i.exacto())
  const mal = D.cuentaMonetaria('XOF').suma(s.guardar()).suma(i.guardar())

  assert.equal(bien.exacto(), 0.447942, 'sobre las cifras de trabajo')
  assert.equal(mal.exacto(), 0.4479, 'sumando lo ya recortado, sale distinto')
  assert.notEqual(bien.exacto(), mal.exacto(),
    'y por eso importa en qué momento se baja la precisión')
})

test('un IVA de 21 % no se pierde al multiplicar', async () => {
  // `escala()` también pasa el factor por enteros. Si multiplicara en coma
  // flotante, 0,21 × 3702000000 daría 777419999.9999999 en vez de 777420000:
  // el error entraría por la puerta de atrás justo después de haberlo cerrado
  // por la otra, y nadie lo vería nunca.
  const i = D.cuentaMonetaria('XOF').suma(0.3702).escala(0.21)
  assert.equal(i.entero(), 7774200,
    'exacto en enteros de diezmillonésimas: ni una unidad de menos')

  // Y un factor de más decimales también, que es lo que pasa con un tipo de
  // IVA que no sea el 21 % redondo.
  const raro = D.cuentaMonetaria('XOF').suma(100).escala(0.0755)
  assert.equal(raro.exacto(), 7.55, 'con un 7,55 % que no es redondo')
})

test('el descuento tampoco redondea por el camino', async () => {
  // El descuento es el otro sitio donde se pierde: si se aplica a un importe
  // ya redondeado, el descuento de 7,5 % sobre 33,3333 no es 2,5 sino 2,4999,
  // y la diferencia depende de en qué orden se aplicó cada operación.
  const base = 33.3333
  const conDescuento = D.cuentaMonetaria('XOF').suma(base).escala(0.925)
  assert.equal(conDescuento.exacto(), 30.83330250, '7,5 % de descuento, exacto')

  // Y el IVA se aplica sobre la base YA descontada, que es lo que dice la ley
  // y lo que hace que un descuento antes del impuesto cueste más de lo que
  // parece.
  const conIva = D.cuentaMonetaria('XOF').suma(conDescuento.exacto()).escala(1.21)
  assert.equal(conIva.exacto(), 37.30829603)
})


test('el catálogo SÍ tiene moneda por omisión, pero es la base', async () => {
  // La diferencia entre un documento y un artículo del catálogo.
  //
  // Un pedido es un papel que va a un cliente: que la base le ponga la moneda
  // a la que le apetezca es justo lo que no puede pasar, y por eso no tiene
  // default. Un artículo del catálogo, en cambio, pertenece a la moneda de la
  // empresa mientras nadie diga otra cosa, y obligar a teclearlo en cada alta
  // es ruido.
  //
  // Lo que estaba mal nunca fue que el default existiera, sino que valiera
  // 'EUR' —la contradicción con la moneda base de `currencies`—. Por eso aquí
  // se cambia el valor y no se quita.
  const c = await one(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'items' AND column_name = 'currency_code'`)
  assert.ok(c.column_default, 'el catálogo tiene default: es una decisión, no un descuido')
  assert.match(c.column_default, /'XOF'/,
    `el default del catálogo es 'XOF', no ${c.column_default}: el otro era la contradicción`)

  // Y un artículo creado sin decir nada cae en la moneda base.
  const soltero = await one(
    `INSERT INTO items (sku,name,category_kind,unit_id,lot_prefix)
     VALUES ('SIN-MONEDA','Sin moneda','RAW_MATERIAL',$1,'DIN') RETURNING currency_code`, [u])
  assert.equal(soltero.currency_code, 'XOF')
})
