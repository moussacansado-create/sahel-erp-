import { el, metrica, panel, num, entero, vacio, estado, fechaHora } from '../ui.js'
import * as A from '../api.js'

/**
 * Panel. Solo números que salen de la API.
 *
 * Nada de porcentajes inventados y nada de campos «razonables»: cada nombre de
 * campo de aquí está en `tests/interfaz.test.js`, que falla si la API deja de
 * devolverlo. Por eso las cabeceras y las celdas se escriben juntas: cuando se
 * añadió una columna se olvidó quitar la de al lado, y la tabla mostró ceros
 * durante horas sin que ninguna prueba se enterara.
 */
export async function paginaPanel() {
  const caja = el('div')

  //
  // CADA BLOQUE POR SU CUENTA. Y CON SU `catch`.
  //
  // Antes: `await Promise.all([api('/inventory/resumen'), …])`. Una sola llamada
  // sin vigilar y todo el panel se caía con su 403. Le pasaba a los roles de
  // reparto y comercial, que sí ven el Panel en el menú (tienen `dashboard:view`)
  // pero no pueden ver el inventario: abrían su pantalla de inicio y no había
  // nada. Ni un solo número.
  //
  // Ahora cada bloque se pide por separado y se guarda o su error. Un 403 NO se
  // esconde: se enseña el motivo en el sitio correspondiente. El backend sigue
  // negando exactamente lo mismo —aquí no se abre ni una puerta— pero quien
  // entra ve todo lo que SÍ puede ver, y lo que no, con la explicación de por qué.
  //
  // Fail-closed también aquí: si la llamada falla, el bloque NO se inventa. Se
  // muestra el aviso, no un cero.
  const [resumen, stock] = await Promise.all([
    A.api('/inventory/resumen').catch((e) => ({ __error: e.message })),
    A.api('/inventory').catch((e) => ({ __error: e.message })),
  ])

  // Sin permiso para el inventario: se dice, y se sigue adelante con lo demás.
  const faltaInventario = resumen && resumen.__error
  if (faltaInventario) {
    caja.replaceChildren(panel('Panel', null, el('div', { class: 'alerta alerta--aviso' }, [
      el('div', { text: 'No se ha podido leer el inventario.' }),
      el('p', { class: 'pista', text: faltaInventario }),
    ])))
    return caja
  }
  caja.replaceChildren()

  const porTipo = resumen.porTipo || []
  const totalArticulos = porTipo.reduce((t, f) => t + Number(f.articulos || 0), 0)
  const totalLotes = stock.reduce((t, f) => t + Number(f.active_lots || 0), 0)
  const bajoMin = (resumen.bajoMinimo || []).length
  const enCuarentena = porTipo.reduce((t, f) => t + Number(f.en_cuarentena || 0), 0)
  const apartado = porTipo.reduce((t, f) => t + Number(f.reservadas || 0), 0)
  const moneda = resumen.moneda || '—'
  const valorCoste = resumen.totales?.valor_coste ?? 0
  const valorVenta = resumen.totales?.valor_venta ?? 0

  // ── Cifras ──
  caja.append(el('div', { class: 'rejilla rejilla--4' }, [
    metrica('Artículos', entero(totalArticulos), 'Materias primas, envases y productos'),
    metrica('Lotes con stock', entero(totalLotes), 'Cada entrada genera su lote'),
    metrica('Bajos de mínimo', entero(bajoMin), enCuarentena
      ? `${num(enCuarentena, 0)} en cuarentena` : 'Todo por encima del mínimo'),
    metrica('Apartado', num(apartado, 0), 'Comprometido, sigue en el almacén'),
  ]))

  caja.append(el('div', { class: 'rejilla rejilla--4', style: 'margin-top:-6px' }, [
    metrica('Valor a coste', `${moneda} ${num(valorCoste)}`, 'Lo que cuesta reponerlo'),
    metrica('Valor a venta', `${moneda} ${num(valorVenta)}`, 'Lo que vale si se vende'),
  ]))

  // ── Desglose ──
  // Cabecera y celdas salen del MISMO sitio. Una tabla con siete columnas
  // declaradas de un lado y cinco del otro es un cero silencioso.
  caja.append(panel('Desglose por tipo', null, tabla(
    [
      ['Tipo',       '', (f) => estado(TIPOS[f.tipo] || f.tipo, TONO[f.tipo] || '')],
      ['Artículos',  'num', (f) => entero(f.articulos)],
      ['Existencias','num', (f) => num(f.existencias)],
      ['Apartado',   'num', (f) => num(f.reservadas)],
      ['Disponible', 'num', (f) => num(f.disponibles)],
      ['Cuarentena', 'num', (f) => num(f.en_cuarentena)],
      ['Caducadas',  'num', (f) => num(f.caducadas)],
    ],
    porTipo, 'El catálogo está vacío', '📦',
  ), true))

  // ── Lo que hay que reponer ──
  const bajos = resumen.bajoMinimo || []
  caja.append(panel(`Bajo mínimo (${bajos.length})`, null,
    bajos.length
      ? tabla([
          ['Artículo',   '', (b) => el('div', {}, [
            el('div', { text: b.name }),
            el('div', { class: 'mono tenue', text: b.sku }),
          ])],
          ['Tipo',       '', (b) => estado(TIPOS[b.category_kind] || b.category_kind, TONO[b.category_kind] || '')],
          ['En almacén', 'num', (b) => num(b.qty_on_hand)],
          ['Mínimo',     'num', (b) => num(b.min_stock, 0)],
          ['Falta',      'num', (b) => num(Math.max(Number(b.min_stock) - Number(b.qty_on_hand), 0), 0)],
        ], bajos, 'Ningún artículo por debajo del mínimo', '✓')
      : el('div', { class: 'alerta alerta--bien', text: 'Ningún artículo por debajo del mínimo.' }),
    true))

  // ── Lo que caduca pronto ──
  const caducidad = resumen.caducidad || []
  if (caducidad.length) {
    caja.append(panel('Caduca en los próximos 90 días', null, tabla([
      ['Artículo',   '',      (c) => c.name],
      ['SKU',        'mono',  (c) => c.sku],
      ['En almacén', 'num',   (c) => num(c.qty_on_hand)],
      ['Categoría',  'pequeno tenue', (c) => TIPOS[c.category_kind] || c.category_kind],
    ], caducidad, '', '📅'), true))
  }

  // ── Últimos movimientos ──
  const movs = await A.api('/inventory/movimientos?limite=12').catch(() => null)
  caja.append(panel('Últimos movimientos', null,
    !movs
      ? el('div', { class: 'alerta alerta--aviso' }, [
        el('div', { text: 'Sin permiso para ver los movimientos del almacén.' }),
        el('p', { class: 'pista', text: 'Hace falta inventory:view.' }),
      ])
      : movs.length
      ? tabla([
          ['Fecha',         'pequeno tenue', (m) => fechaHora(m.occurred_at)],
          ['Tipo',          '', (m) => estado(NOMBRE_MOV[m.movement_type] || m.movement_type, TONO_MOV[m.movement_type] || '')],
          ['Artículo',      '', (m) => el('div', {}, [
            el('div', { text: m.item_name }),
            el('div', { class: 'mono tenue', text: `${m.sku} · ${m.lot_code}` }),
          ])],
          ['Cantidad',      'num', (m) => num(m.qty, 0)],
          ['Saldo del lote','num tenue', (m) => num(m.balance_after)],
          ['Quién',         'pequeno', (m) => m.user_name || '—'],
        ], movs, 'Todavía no se ha movido stock', '📋')
      : vacio('Todavía no se ha movido stock', '📋'),
    true))

  caja.append(el('p', { class: 'pista' },
    'Todas las cifras de esta pantalla salen de las vistas de PostgreSQL. No hay contadores guardados en ningún otro sitio.'))

  return caja
}

/**
 * Tabla. Las columnas se declaran como [título, clase, función] y reciben el
 * objeto de la fila. La cabecera y el cuerpo salen de la MISMA lista, así que
 * no pueden desincronizarse: cuando se añadió una columna y se olvidó quitar
 * la de al lado, la tabla mostró ceros sin que nada se enterara.
 */
function tabla(columnas, filas, mensajeVacio = 'Nada por aquí', icono = '∅') {
  return el('div', { style: 'overflow-x:auto' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, columnas.map(([titulo, clase]) =>
        el('th', { class: (clase || '').includes('num') ? 'num' : '', text: titulo })))]),
      el('tbody', {}, filas.length
        ? filas.map((fila) => el('tr', {}, columnas.map(([, clase, fn]) =>
            el('td', { class: (clase || '').includes('num') ? 'num' : '' }, [fn(fila)]))))
        : [el('tr', {}, [el('td', { colspan: columnas.length }, [vacio(mensajeVacio, icono)])])]),
    ]),
  ])
}

const TIPOS = { RAW_MATERIAL: 'Materia prima', PACKAGING: 'Envase', FINISHED_GOOD: 'Producto terminado' }
const TONO = { RAW_MATERIAL: 'marca', PACKAGING: 'aviso', FINISHED_GOOD: 'bien' }
const NOMBRE_MOV = {
  RECEPTION: 'Entrada', PURCHASE_RECEPTION: 'Entrada (compra)',
  ADJUSTMENT_IN: 'Ajuste +', ADJUSTMENT_OUT: 'Ajuste −',
  PRODUCTION_OUTPUT: 'Producción', PRODUCTION_CONSUMPTION: 'Consumo (producción)', WASTE: 'Merma', DELIVERY_REVERSAL: 'Devolución de entrega',
  DELIVERY: 'Entrega', RETURN: 'Devolución', SCRAP: 'Merma',
}
const TONO_MOV = {
  RECEPTION: 'bien', PURCHASE_RECEPTION: 'bien', ADJUSTMENT_IN: 'marca',
  ADJUSTMENT_OUT: 'aviso', PRODUCTION_OUTPUT: 'marca', CONSUMPTION: 'aviso',
  DELIVERY: 'aviso', RETURN: 'marca', SCRAP: 'peligro',
}
