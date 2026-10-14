/**
 * LA PEGATA, EN HTML.
 *
 * ── POR QUÉ HTML Y NO UNA IMAGEN ─────────────────────────────────────────────
 *
 * Un PNG de 300 ppp impreso por el sistema acaba midiendo 25 mm. Un SVG, o
 *vectorial, es un desastre con las impresoras térmicas: media gama con firmware
 * viejo no rasteriza bien el vector y sale con el QR cortado. El sistema
 * operativo, en cambio, sabe calcular los milímetros y respects el rollo.
 *
 * Y la forma correcta de decirle al driver «esto mide 50 por 30» es CSS:
 *
 *     @page { size: 50mm 30mm; margin: 0 }
 *
 * Con eso, tanto la impresora térmica como el «Microsoft Print to PDF» cortan
 * donde toca. Es lo que evita que la pegata salga descentrada o con la última
 * línea a medias.
 *
 * ── LO QUE NO SE IMPRIME SI NO EXISTE ───────────────────────────────────────
 *
 * Un campo sin dato no se imprime. Ni «—», ni «N/A», ni un hueco con la
 * etiqueta encima. Un hueco se ve y se entiende; un dato inventado se cree y
 * después cuesta tres semanas de audits explicarlo.
 */
import { FORMATOS, tipoDeLote } from './etiquetas.js'
import { svgCodigoBarras, codificar, decodificar } from './codigo-barras.js'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

function fecha(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function fechaHora(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
/**
 * Un número, o NADA.
 *
 * Antes era `Number(v).toFixed(d)`, y eso devuelve la cadena «NaN» cuando el
 * valor no es un número: un texto vacío, un «—», un `undefined` que llegó por
 * una unión mal hecha. Una etiqueta con «NaN L» encima es peor que una
 * etiqueta sin cantidad, porque parece un dato.
 *
 * Aquí, si no se puede convertir, se devuelve `null` y la fila NO se imprime.
 * El hueco se ve y se pregunta; el NaN se copia a un albarán.
 */
function num(v, d = 2) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n.toFixed(d).replace(/\.?0+$/, '')
}

/**
 * Una fila de la pegata. Si el valor no existe, la fila NO se escribe: es
 * preferible una pegata con tres líneas a una con cinco y dos huecos.
 */
function fila(etiqueta, valor) {
  if (valor === null || valor === undefined || valor === '') return ''
  return `<div class="f"><span class="k">${esc(etiqueta)}</span><span class="v">${esc(valor)}</span></div>`
}

/**
 * LA ETIQUETA.
 *
 * ── ESTRUCTURA ──────────────────────────────────────────────────────────────
 *
 * De arriba abajo, y en ese orden porque es el orden en que se lee:
 *
 *   1. QUIÉN ES   logotipo y nombre de Sahel. Lo primero que se ve de lejos.
 *   2. QUÉ ES     tipo de material y nombre del artículo. Lo segundo.
 *   3. CUÁNTO     cantidad y unidad, en el hueco de la derecha.
 *   4. DE QUÉ     número de entrada, LOTE INTERNO y LOTE DEL FABRICANTE, cada
 *                 uno con su nombre. Nunca uno en el hueco del otro.
 *   5. CUÁNDO     recepción y caducidad.
 *   6. QUIÉN LO TRAJO   proveedor.
 *   7. CÓDIGOS    QR a la entrada y código de barras real debajo.
 *
 * ── LO QUE NO SE IMPRIME SI NO EXISTE ───────────────────────────────────────
 *
 * Un campo sin dato no se imprime. Ni «—», ni «N/A», ni un hueco con la
 * etiqueta encima. La cantidad, además, pasa por una conversión que NO puede
 * devolver `NaN`: si no se puede convertir, el campo desaparece en vez de
 * enseñar un NaN que alguien acabaría copiando a un albarán.
 *
 * ── LA IMPRESIÓN ────────────────────────────────────────────────────────────
 *
 * El tamaño se declara en milímetros con `@page { size: Xmm Ymm }`, que es lo
 * único que hace que el driver corte donde toca en vez de por donde le parece.
 */
export function htmlEtiqueta(d, fmt = '60x40', copias = 1) {
  const F = FORMATOS[fmt] || FORMATOS['60x40']
  const n = Math.max(1, Math.min(200, Number(copias) || 1))
  const urlQr = `/api/inventory/lotes/${d.loteId}/qr.png?tamano=300`
  const qrMm = Math.round(F.alto * F.altoQr)
  const art = `${d.sku} · ${d.articulo}`

  // ── Código de barras: se genera, se VERIFICA y solo se dibuja si es válido ─
  // Una franja que parece un código de barras y no lo es hace CREER que hay
  // identificación donde no la hay. Peor que no poner nada.
  // El código de barras codifica el MISMO identificador que va en grande, que
  // en producto terminado es el lote de fabricación. Un código de barras que
  // apunta a la entrada mientras la pegata habla del lote obliga a escanear
  // para llegar a un sitio y leer a otro.
  const principal = d.identificadorPrincipal || d.loteInterno || d.numeroEntrada
  const textoBarras = String(principal).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20)
  const cb = codificar(textoBarras)
  const barras = (cb && decodificar(cb.modulos).ok)
    ? svgCodigoBarras(textoBarras, { altoMm: F.altoCb, moduloMm: 0.3, margen: 4 })
    : null
  const bloqueBarras = barras
    ? `<div class="cb"><div class="cb__img">${barras}</div><div class="cb__t">${esc(textoBarras)}</div></div>`
    : ''

  // El formato decide CUÁNTOS campos caben. Los que no caben no se imprimen
  // de cualquier manera: no entran. Y la hoja de impresión lo DICE, para que
  // quien pega la etiqueta sepa qué tiene que mirar en la pantalla.
  const permitidos = F.fichaCorta ? (k) => F.fichaCorta.includes(k) : () => true

  // La ficha SOLO lleva lo que no está ya en otro sitio.
  //
  // Article, tipo, cantidad e identificadores tienen bloque propio: repetirlos
  // aquí llenaba la pegata de dos veces el mismo dato y obligaba a recortar
  // campos que síaban decir algo. Lo que queda es el contexto: cuándo entró,
  // quién lo trajo y cuándo caduca.
  const ficha = [
    ['Recibido', fecha(d.recibidoEn)],
    ['Proveedor', d.proveedor],
    ['Caducidad', fecha(d.caducidad)],
  ].filter(([k, v]) => permitidos(k) && v !== null && v !== undefined && v !== '')

  // LOS TRES IDENTIFICADORES, en su propia banda y con su nombre.
  const ids = [
    ['Lote de fabricacion', d.loteInterno],
    ['N.o de entrada', d.numeroEntrada],
    ['Lote del fabricante', d.loteFabricante],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '')

  const pegata = `
  <div class="et${F.compacto ? ' et--c' : ''}" style="width:${F.ancho}mm;height:${F.alto}mm">
    <div class="cab">
      <div class="marca">
        <div class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="100%" height="100%">
            <path d="M12 1.6c3.4 4.4 6.4 8 6.4 11.4a6.4 6.4 0 1 1-12.8 0C5.6 9.6 8.6 6 12 1.6z" fill="#fff"/>
          </svg>
        </div>
        <div class="marca__t">
          <div class="marca__n">SAHEL</div>
          <div class="marca__s">Produits d'hygiene</div>
        </div>
      </div>
      <div class="ent">
        <div class="ent__e">${d.principalEsLote ? 'LOTE FABRICACION' : 'N.o ENTRADA'}</div>
        <div class="ent__n">${esc(principal)}</div>
      </div>
    </div>

    <div class="art">
      <div class="art__t">${esc(d.articulo)}</div>
      <div class="art__m">
        <span class="art__sku">${esc(d.sku)}</span>
        <span class="art__tipo">${esc(d.tipoMaterial)}</span>
      </div>
    </div>

    <div class="cant">
      <span class="cant__n">${esc(num(d.cantidadRecibida) ?? '—')}</span>
      <span class="cant__u">${esc(d.unidad || '')}</span>
    </div>

    <div class="ids">
      ${ids.map(([k, v]) => `<div class="id"><span class="id__k">${esc(k)}</span><span class="id__v">${esc(v)}</span></div>`).join('')}
    </div>

    <div class="ficha">
      ${ficha.map(([k, v]) => `<div class="f"><span class="k">${esc(k)}:</span> <span class="v">${esc(v)}</span></div>`).join('')}
    </div>

    <div class="pie">
      <img class="qr" style="width:${qrMm}mm;height:${qrMm}mm"
           src="${urlQr}" alt="QR de la entrada ${esc(d.numeroEntrada)}">
      <div class="pie__d">${bloqueBarras}</div>
    </div>
  </div>`

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Etiqueta ${esc(principal)} · ${esc(F.nombre)}</title>
<style>
  /* Lo primero y lo más importante: la pegata mide EXACTO lo que el rollo.
     Sin esto el driver recorta por donde le parece. */
  @page { size: ${F.ancho}mm ${F.alto}mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, Helvetica, sans-serif; color: #000; }

  .hoja { display: flex; flex-wrap: wrap; gap: 5mm; padding: 5mm; background: #d6d6d6; }
  @media print { .hoja { padding: 0; gap: 0; background: #fff; } }

  .et {
    background: #fff; padding: ${F.pad}mm;
    display: flex; flex-direction: column; gap: ${F.hueco}mm;
    overflow: hidden;              /* lo que no cabe se corta, no invade la siguiente */
    page-break-after: always; break-after: page;
    border: .2mm dashed #999;      /* el borde solo se ve en pantalla */
  }
  @media print { .et { border: 0; } }

  /* ── QUIÉN ES ── */
  .cab { display: flex; align-items: center; justify-content: space-between; gap: 1mm; flex: 0 0 auto; }
  .marca { display: flex; align-items: center; gap: .9mm; min-width: 0; }
  .logo {
    width: ${(F.titulo * 0.78).toFixed(1)}mm; height: ${(F.titulo * 0.78).toFixed(1)}mm;
    background: #000; border-radius: .6mm; padding: .3mm; flex: 0 0 auto;
  }
  .marca__n { font-size: ${F.titulo.toFixed(1)}pt; font-weight: 800; letter-spacing: .4pt; line-height: 1; }
  .marca__s { font-size: ${(F.titulo * 0.40).toFixed(1)}pt; line-height: 1.1; white-space: nowrap; }
  .ent { text-align: right; flex: 0 0 auto; }
  .ent__e { font-size: ${(F.titulo * 0.36).toFixed(1)}pt; line-height: 1.1; letter-spacing: .3pt; }
  .ent__n { font-size: ${(F.titulo * 1.25).toFixed(1)}pt; font-weight: 800; line-height: 1.05; }

  /* ── QUÉ ES ── */
  .art { flex: 0 0 auto; }
  .art__t { font-size: ${(F.cuerpo * 1.12).toFixed(1)}pt; font-weight: 800; line-height: 1.12; overflow-wrap: anywhere; }
  .art__m { display: flex; gap: 1mm; align-items: baseline; }
  .art__sku { font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: ${(F.cuerpo * 0.86).toFixed(1)}pt; font-weight: 700; }
  .art__tipo { font-size: ${(F.cuerpo * 0.78).toFixed(1)}pt; opacity: .72; }

  /* ── CUÁNTO ── */
  .cant { display: flex; align-items: baseline; gap: .8mm; flex: 0 0 auto; }
  .cant__n { font-size: ${(F.cuerpo * 1.5).toFixed(1)}pt; font-weight: 800; line-height: 1; }
  .cant__u { font-size: ${(F.cuerpo * 0.8).toFixed(1)}pt; opacity: .75; }

  /* ── DE QUÉ: los tres identificadores, con su nombre ── */
  .ids {
    display: flex; gap: 1mm; flex: 0 0 auto;
    border-top: .3mm solid #000; border-bottom: .3mm solid #000;
    padding: .5mm 0;
  }
  .id { min-width: 0; }
  .id__k { display: block; font-size: ${(F.cuerpo * 0.52).toFixed(1)}pt; letter-spacing: .2pt; opacity: .7; line-height: 1.1; }
  .id__v { display: block; font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: ${(F.cuerpo * 0.82).toFixed(1)}pt; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }

  /* ── CUÁNDO Y QUIÉN ── */
  .ficha { flex: 0 0 auto; line-height: 1.16; }

  .f { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k { opacity: .7; }
  .v { }

  /* ── CÓDIGOS ── */
  .pie { display: flex; align-items: flex-end; justify-content: space-between; gap: 1mm; flex: 0 0 auto; }
  .qr { flex: 0 0 auto; image-rendering: pixelated; }
  .pie__d { flex: 1 1 auto; min-width: 0; display: flex; justify-content: flex-end; }
  .cb { text-align: right; }
  .cb__img { display: flex; justify-content: flex-end; }
  .cb__img svg { max-width: 100%; height: auto; }
  .cb__t { font-family: ui-monospace, "DejaVu Sans Mono", monospace; font-size: ${(F.cuerpo * 0.6).toFixed(1)}pt; letter-spacing: .3pt; }

  .fuera { padding: 5mm; background: #d6d6d6; font-family: system-ui, sans-serif; max-width: 90mm; }
  @media print { .fuera { display: none; } }
  @media (max-width: 480px) { .fuera { padding: 3mm; max-width: none; } }
</style></head>
<body>
<div class="hoja">${pegata.repeat(n)}</div>
<div class="fuera">
  <p><b>${esc(d.sku)} · ${esc(d.articulo)}</b><br>${d.principalEsLote ? 'Lote de fabricacion' : 'Entrada'} <b>${esc(principal)}</b></p>
  <p>Formato ${esc(F.nombre)} · ${n === 1 ? '1 copia' : n + ' copias'}. Esta pantalla es solo para ver el resultado: al imprimir salen ${n} pegatas y nada más.</p>
  ${F.omitidos && F.omitidos.length
    ? `<p style="background:#fff3cd;border-left:3px solid #b8860b;padding:6px 8px;border-radius:4px">
        <b>Este formato NO cabe para:</b> ${esc(F.omitidos.join(', '))}.
        Si necesitas esos datos en la pegata, usa 100 × 50 mm.</p>`
    : ''}
  <p>Elige la impresora térmica. Para probar sin gastar rollo, «Microsoft Print to PDF»: sale a ${F.ancho} × ${F.alto} mm exactos.</p>
  <p><button onclick="window.print()">Imprimir</button></p>
</div>
</body></html>`
}

/** Los tres formatos, con sus medidas, para el selector de la pantalla. */
export function catalogoFormatos() {
  return Object.entries(FORMATOS).map(([code, f]) => ({
    code, nombre: f.nombre, ancho: f.ancho, alto: f.alto,
  }))
}
