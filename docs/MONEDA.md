# EL DINERO: UNA SOLA MONEDA REAL, DOS FORMAS DE ESCRIBIRLA

> **ESTE DOCUMENTO ES UN DISEÑO, NO UNA IMPLEMENTACIÓN.**
> No hay ni una tabla creada a partir de aquí. Se escribe antes de Cobros y
> Facturación a propósito: crear tablas de facturas y pagos es caro de
> deshacer, y una decisión de redondeo tomada a posteriori se nota en cada
> factura que ya no cuadra.

---

## 1 · EL PROBLEMA QUE ESTO RESUELVE

Hoy cada documento lleva su propia `currency_code` y sus propios importes, y
**nada en el sistema los relaciona**:

```
purchase_orders  → currency_code, total, subtotal, tax_amount
sales_orders     → currency_code, total, subtotal, tax_amount
expenses         → currency_code, amount
lots             → unit_cost
```

No existe ninguna tabla de tipos de cambio. Es decir: el sistema sabe qué
moneda dice cada papel, pero **no sabe cuánto vale**.

En cuanto entre el primer euro y el primer franco aparecen dos cosas que no
se pueden arreglar después:

- **Dos precios que se desincronizan.** Alguien teclea «1 500 FCFA» en el
  albarán, luego «2,29 €» en la factura, luego el sistema suma 1 500 + 2,29.
  Ninguna de las dos cifras era falsa el día que se escribió.
- **Cifras que cambian solas.** Si el total se guarda ya convertido y mañana
  la tasa se mueve, un documento de hace seis meses empieza a valer otra
  cosa. Los libros del año pasado dejan de cuadrar con el banco.

---

## 2 · LA REGLA

> **Un documento guarda UN número, en UNA moneda, con la tasa que tenía en el
> momento de emitirse. Nunca dos precios. Nunca un precio que se recalcula.**

De ahí sale todo lo demás.

---

## 3 · LA MONEDA BASE: XOF

**Decidido: XOF (FCFA).**

No por ser más bonito, sino por la dirección del negocio:

- La contabilidad, el banco y el Estado trabajan en FCFA. Una factura que hay
  que presentar en formato XOF con importes XOF no admite discusión.
- Los precios de venta van en FCFA, así que el redondeo natural es a 0
  decimales y no arrastra céntimos que nadie ve.
- El euro es la moneda de **control**: el dueño lo piensa en euros, pero no lo
  factura en euros.

La tabla `currencies` lo declara con `is_base = TRUE` y `rate_to_base = 1`, y
desde la migración **021** sale de una migración y no de los datos de
demostración. Antes vivía en `semillas.js`, lo que significaba que una
instalación real —sin datos de prueba— se levantaba **sin ninguna moneda
declarada**.

## 4 · LA TASA: CON FECHA Y SIN EDITAR

Una tabla, y tres reglas que son el corazón del diseño:

```sql
CREATE TABLE exchange_rates (
  id            BIGSERIAL PRIMARY KEY,
  from_code     TEXT NOT NULL CHECK (from_code = 'EUR'),  -- origen de la paridad
  to_code       TEXT NOT NULL CHECK (to_code   = 'XOF'),
  rate          NUMERIC(18,6) NOT NULL CHECK (rate > 0),
  effective_from DATE NOT NULL,
  source        TEXT NOT NULL DEFAULT 'MANUAL',
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- UNA tasa por día y por par. Reintroducir el mismo día es un `UPDATE`, no
  -- una fila nueva: si no, "¿cuál vale?" deja de tener respuesta.
  UNIQUE (from_code, to_code, effective_from)
);
```

**R1 · La tasa se AÑADE, no se EDITA.** Una tasa corregida después de usarse es
una tasa nueva con fecha posterior. Las antiguas siguen siendo verdad porque se
usaron.

**R2 · Un documento NUNCA se re-evalúa.** Al emitirlo se guarda su
`exchange_rate` junto al importe. Mañana la tasa valdrá otra cosa y ese papel
seguirá diciendo lo que decía.

**R3 · Un documento se guarda en UNA moneda.** La que se emitió. Convertirlo
es una operación nueva, con su papel, no un campo que alguien toca.

---

## 5 · LA TASA EN CADA FILA, NO ENCIMA

Lo importante: **la tasa se guarda en cada línea**, no solo en la cabecera.

```sql
-- en cada línea de venta/compra, y en cada pago:
exchange_rate   NUMERIC(18,6)   -- la usada en ESTA línea
currency_code   TEXT            -- la moneda en que se emitió ESTA línea
```

Con la tasa en la cabecera, un pedido de tres líneas harmed Escrito en días
distintos se congelaría con una sola tasa. Con la tasa por línea, cada línea
conserva la suya y el total es la suma de lo que realmente se loló cada día.

Es lo que hace una factura real, y además hace imposible el fallo de «cambió la
tasa a mitad de pedido y el total ya no cuadra con las líneas».

---

## 6 · EL REDONDEO: UNA SOLA VEZ, AL FINAL

**Se guarda EXACTO. Se redondea al presentar, y solo una vez.**

### 6.1 · Por qué el redondeo es un problema de dinero, no de estética

El redondeo no se ve. Un importe que pierde tres decimales sigue pareciendo un
importe, la factura sigue cuadrando consigo misma, y nadie se entera hasta que
la cuenta no llega. Con volumen se convierte en una pérdida constante e
invisible: **1.000 operaciones de medio céntimo son cincuenta céntimos**, y con
mucho flujo eso ya no es ruido.

Hay que distinguir dos cosas, que es donde se confunde una con otra:

- **Precisión de cálculo** — con cuántos decimales se trabaja.
- **Precisión de presentación** — con cuántos decimales se enseña.

La primera no caduca nunca. La segunda depende de la moneda y es una decisión
de cada documento.

### 6.2 · Lo que se guarda

**`NUMERIC(18,4)` en todas las columnas de dinero.** Cuatro decimales, que es lo
mismo que ya usaban los precios unitarios, de modo que un precio y su total
hablan el mismo idioma.

Antes eran `NUMERIC(18,2)`, y eso era una pérdida constante: **PostgreSQL
redondeaba al insertar**, aunque el código llevara la cifra exacta. La base no
le daba sitio. Encima, Compras redondeaba antes de guardar, y por tres sitios en
la misma línea: el importe, el subtotal acumulado y el impuesto.

Un total redondeado antes de tiempo **no es un detalle de presentación**: es una
cifra que ya no es la que se calculó, y a partir de ahí el documento entero
está construido sobre ella.

### 6.3 · Lo que se enseña

| Moneda | Decimales | Por qué |
|---|---|---|
| **XOF** | 0 | El franco CFA no se usa con céntimos. Mostrar `983,94 FCFA` sería fingir una precisión que el dinero no tiene. |
| **EUR** | 2 | Lo que pone cualquier factura en euros. |

Y se redondea **una vez, sobre el total del documento**, no línea a línea.

### 6.4 · Por qué redondear línea a línea está prohibido

Porque el documento deja de cuadrar consigo mismo:

```
Tres líneas de 33,3333, IVA 21 %

Redondeando CADA LÍNEA a 2 decimales:
  línea 1  33,3333 → 33,00
  línea 2  33,3333 → 33,00
  línea 3  33,3333 → 33,00
                    ──────
                    99,00   ← lo que ve el cliente
  El cálculo real   100,00   ← lo que se calculó
```

Nadie sabe cuál de los dos números es el bueno, y quien lo revisa no va a
saberlo nunca. Con redondeo al final, el total es 100 y las líneas se presentan
redondeadas solo para leerlas: siguen cuadrando porque la diferencia va
anotada.

### 6.5 · La diferencia de redondeo se anota, no se tira

`diferenciaDeRedondeo(exacto, redondeado)` deja constancia de cuánto se ha
redondeado. Un total redondeado que no cuadra con la suma de sus líneas es un
documento que parece equivocado; esta cifra es la que explica la diferencia, y
la que revisa un contable cuando algo no le sale.

### 6.6 · El medio siempre al mismo lado

`redondear()` redondea la **magnitud** y aplica el signo al final.

La versión anterior sumaba `Number.EPSILON` al número y redondeaba. Eso
arreglaba `1,005 → 1,01` pero rompía `-1,005 → -1,00`: el EPSILON empuja en una
sola dirección. No era un error de un céntimo en un caso raro, era un
redondeo **siempre sesgado**, y en una devolución o una nota de crédito iba
siempre en el mismo sentido. La pérdida se acumula igual que antes, solo que
hacia el otro lado.

## 7 · TECLEAR EN CUALQUIERA DE LAS DOS

En cualquier campo de importe, con un selector de moneda al lado:

```
Importe  [  1,50  ]  €     →  guarda 983,9355 FCFA  (con la tasa de hoy)
Importe  [   984  ]  FCFA  →  guarda 984 FCFA        (lo mismo, visto al revés)
```

Un único campo. Nunca dos casillas que el usuario pueda rellenar las dos. Se
puede enseñar el equivalente debajo, en gris, para que compruebe, pero el dato
que se guarda es **uno**.

---

## 8 · QUÉ SE EMITE EN QUÉ MONEDA

| Documento | Moneda | Por qué |
|---|---|---|
| Factura a cliente en Mali | **FCFA** | Es lo que se presenta y lo que paga el cliente |
| Albarán | **FCFA** | Va impreso en el coche, en la calle |
| Tarjeta de reparto | **FCFA** | La ve el repartidor, no necesita conversión |
| Compra a proveedor europeo | **EUR** o **FCFA**, lo que diga el proveedor | Se emite en la del proveedor, no en la nuestra |
| Panel del dueño | **EUR** | Para decidir, no para presentar |
| Contabilidad / libros | **FCFA** | Es con lo que se declara |

**El error que hay que evitar:** decidir la moneda «según el cliente» en el
momento de cobrar. La moneda la fija **el documento**, cuando se emite. Cambiar
la moneda de un pedido ya emitido significa emitir otro documento.

---

## 9 · INFORMES: DOS COLUMNAS, UNA VERDAD

Un informe enseña **las dos** columnas porque esa es su utilidad:

```
                    FCFA          EUR (a la tasa de hoy)
Ventas del mes    12 450 000        18 988
```

Con un pie que lo dice, sin letra pequeña:

> *El euro es una conversión a la tasa vigente en este momento. Los documentos
> emitidos en el mes se contabilizan con la tasa que tenían ese día.*

Y al pinchar en un mes, el detalle sale con **la tasa de cada documento**, que
ya es la que se usó. El mes no cuadra con la suma de euros de hoy, y eso es
correcto: se contabiliza con lo que valía entonces.

---

## 10 · LO QUE ESTO NO TOCA

- **Los precios del catálogo** (`items.purchase_cost`, `prices`): siguen en su
  moneda, sin cambio. Un cambio de precios es una decisión comercial.
- **Los lotes y su `unit_cost`**: ya son un valor real. No se re-convierten.
- **Los pedidos y entregas ya emitidos**: conservan su moneda y su tasa.
 Y tampoco los ya emitidos, incluidos los de demostración: esos no se
   reescriben.

---

## 11 · LO QUE YA ESTÁ DECIDIDO

| Decisión | Valor | Dónde vive |
|---|---|---|
| Moneda documental y base | **XOF** (FCFA) | `currencies.is_base`, migración 021 |
| Tipo de cambio | **Manual y centralizado** | `exchange_rates` |
| Al emitir un documento | Conserva su **moneda y su tasa** | columnas del documento |
| EUR y XOF | **Una misma representación**, nunca dos precios | `core/dinero.js` |
| Precisión interna | **4 decimales, sin redondear** | `NUMERIC(18,4)`, migración 020 |
| Precisión de presentación | 0 en XOF, 2 en EUR, **una vez al final** | `redondearPara()` |
| La moneda se adivina | **Nunca.** Sin `DEFAULT` | migración 020 |
| Una compra a un proveedor europeo | **Se queda en EUR.** Sin convertir | `currency_code` del documento |

Y una cosa que se decidió al implementarlo, y que conviene dejar escrita:

**Los tipos de cambio los mete una persona, a mano, con su fecha.** No se
traen de un banco. La tasa se **añade** y nunca se **edita**: una tasa
corregida después de usarse es una tasa nueva con fecha posterior, y las
viejas siguen siendo la verdad de los documentos que las usaron. Hay un
disparador en la base que impide hacer un `UPDATE` de la tasa.

## 11 bis · LO QUE QUEDA POR DECIDIR

Estas siguen sin respuesta y son de la fase de Cobros, no de esta:

1. **¿Los documentos de Mali se emiten siempre en XOF**, o puede un cliente
   concreto facturarse en euros? Lo primero es lo natural; lo segundo pasa
   por un cliente que lo pida.
2. **¿Quién introduce la tasa y con qué frecuencia?** Si es a diario y a
   mano, se acaba en un trabajo de cinco minutos que hay que hacer bien: sin
   tasa no se emite nada, y eso hay que explicarlo en pantalla, no dejar que
   reviente con un error.
3. **¿Redondeo a 0 en los documentos de venta too, o solo en los de Mali?**
   Es coherente con el criterio general, pero conviene confirmarlo.

## 12 · EL ORDEN

1. Confirmar estas 5 decisiones.
2. `exchange_rates` + su prueba (una tasa por día, no editable, con su autor).
3. Una función `importeBase({ importe, moneda, fecha })` con **una sola**
   manera de convertir, usada por todos. Y una prueba que verifique que
   `1,50 € × 655,957 = 983,9355 FCFA` y que el redondeo ocurre UNA vez.
4. Cobros.
5. Facturación.
6. Informes.

El punto 3 es el que importa. **Si cada módulo lleva su propia conversión, en
seis meses habrá seis redondeos distintos y el sistema estará cuadrado por
ningún sitio.**
