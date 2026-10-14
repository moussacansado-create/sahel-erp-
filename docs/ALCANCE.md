# ALCANCE · CleanSahel ERP nuevo

Este documento es el contrato entre lo que el negocio pidió y lo que la
aplicación tiene realmente. Existe para que no haya que ir descubriendo cada
semana que falta una parte.

**Cómo se comprueba:** cada fila dice dónde vive la garantía. Si dice «base de
datos», hay un `CHECK`, un índice o un disparador en PostgreSQL que lo impide,
y una prueba en `server/tests/alcance.test.js` que lo verifica. Si dice
«código», depende de que la función esté bien escrita y hay una prueba que la
ejercita. Si dice «pendiente», no existe todavía.

**Regla de la auditoría:** no se da por hecho que algo está hecho porque se
mencionó en un plan. Se comprueba contra el esquema.

---

## 1 · Clientes

| Requisito | Estado | Dónde |
|---|---|---|
| Ficha completa | Hecho | `customers` (nombre, empresa, teléfono, email, dirección, zona, coordenadas) |
| Código único | Hecho | `customers.code` UNIQUE |
| Historial de pedidos | Hecho | `obtenerCliente()` + vista `v_order_progress` |
| QR opaco y revocable | Hecho | 192 bits, único. `regenerarTokenQr()` invalida la tarjeta perdida en el acto |
| QR sin datos personales | Hecho | **Comprobado**: el token no contiene el nombre, el teléfono ni el correo |
| Tarjeta física con QR | **Pendiente** | Fase 6. `customers.qr_token` ya es UNIQUE y NOT NULL |
| El QR identifica, no prueba entrega | Hecho | La entrega exige firma, no QR. `deliveries` no acepta `DELIVERED` sin `signature_id` |
| Tarjeta generable e imprimible | **Pendiente** | Fase 6 |

## 2 · Pedidos

| Requisito | Estado | Dónde |
|---|---|---|
| Crear pedidos desde el cliente | Hecho | `core/pedidos.js`. El precio sale de la ficha; el IVA no lo elige el cliente |
| **Confirmar aparta, NO descuenta** | Hecho | **Comprobado con números**: antes de confirmar 210 en el lote, después de confirmar 210. El `UPDATE lots` no aparece en el camino |
| Preparación del pedido | Hecho | `prepararPedido()` → `PREPARED` |
| Estados completos | Hecho | `DRAFT, CONFIRMED, RESERVED, PREPARED, IN_ROUTE, DELIVERED, CANCELLED` |
| **No permitir reservas duplicadas** | Hecho | **Base de datos**: `uniq_reserva_linea_lote` + `fn_reserva_no_supera_pedido` (la SUMA de lo apartado no puede pasar de lo pedido) |
| **No descontar dos veces** | Hecho | **Base de datos**: `stock_movement_keys` con clave `DELIVERY:<id>:lot:<id>`; y `fn_pedido_estado_coherente` impide reabrir un pedido entregado |
| Entrega **parcial** | Hecho | La reserva lleva `qty_consumed`: servir 40 de 100 no parte la fila, deja 60 vivos |
| Reparto FEFO al confirmar | Hecho | Aparta primero el lote que caduca antes, con los lotes bloqueados en orden |
| Fabricar para un pedido | Hecho | `produces({orderId})` guarda `productions.sales_order_id` y aparta el lote PT al salir de fábrica |

> **Por qué dos mecanismos y no uno.** Una línea de 100 unidades puede
> necesitar dos lotes distintos (40 de uno, 60 de otro), así que un índice
> único sobre la línea habría roto un caso legítimo. El índice único es
> `(línea, lote)`, y el exceso sobre lo pedido lo vigila un disparador que
> suma. Las dos cosas hacen falta.

## 3 · Albarán

Los cuatro hechos están **separados**, y el orden lo impone la base:

```
CREAR ──→ IMPRIMIR ──→ FIRMAR ──→ ENTREGAR
```

| Requisito | Estado | Dónde |
|---|---|---|
| Imprimir NO entrega | Hecho | **Base de datos**: `printed_at` no obliga a `delivered_at`; para `DELIVERED` hacen falta `signed_at` **y** `delivered_at` |
| Firma obligatoria para entregar | Hecho | `albaran_delivered_exige_firma_y_fecha` + `fn_entrega_exige_firma` sobre `deliveries` |
| Un albarán por entrega | Hecho | `uniq_albaran_entrega` (índice único parcial) |
| Historial de los hechos | Hecho | `albaran_events`, escrito por el disparador `trg_albaran_evento` |
| Datos de Sahel, cliente, fecha, nº, productos, cantidades | Hecho | `detalleAlbaran()` devuelve la cabecera completa |
| Espacio para firmar, nombre de quien recibe, observaciones | Hecho | `delivery_signatures.signer_name`, `albaranes.recipient_name`, `observations` |
| **Imprimir DOS copias** | Hecho | `albaranes.copies` (por defecto 2). Queda registrado cuántas salieron |
| Pantalla imprimible del albarán | **Pendiente** | Fase 5. La API y la hoja de impresión ya existen |

## 4 · Documentos e impresión

| Requisito | Estado | Dónde |
|---|---|---|
| Identidad visual común | Hecho | `web/img/logo-sahel.svg` (copia byte a byte del original) + `web/css/app.css` |
| Hoja de impresión compartida | Hecho | bloque `@media print` en `app.css` |
| **Moneda FCFA** | Hecho | Decisión del usuario. Base = `XOF`, símbolo impreso `FCFA` |
| **Datos de empresa centralizados** | Hecho | `app_config` (`empresa.*`). Ningún documento los lleva escritos a fuego |
| Tarjeta de cliente con QR | **Pendiente** | Fase 6 |
| Albarán imprimible en pantalla | **Pendiente** | Fase 5. API y hoja de impresión listas |
| Documentos de producción | **Pendiente** | Fase 7 |
| Informes imprimibles | **Pendiente** | Fase 7 |

> Los cuatro colores de marca (`#1e3a6e`, `#7dd3fc`, `#0ea5e9`, `#0284c7`) están
> extraídos literalmente del logo original. Antes de esta corrección la aplicación
> usaba un verde genérico que no era de Sahel.

## 5 · Entrega

| Requisito | Estado | Dónde |
|---|---|---|
| Repartidor ve sus pedidos | Hecho | Pantalla Pedidos con el progreso de cada línea; el listado de entregas del pedido |
| Cliente firma | Hecho | `delivery_signatures` — BYTEA + sha256. En la Fase 5 pasa a ser el dedo sobre la pantalla |
| Quién entregó, cuándo | Hecho | `deliveries.rep_id`, `delivered_at`, `recipient_name` |
| Firma/evidencia asociada a su entrega | Hecho | `deliveries.signature_id` + índices únicos en `delivery_signatures` |
| **ENTREGAR descuenta UNA SOLA VEZ** | Hecho | **Base de datos**: clave única de consumo + `fn_entrega_exige_firma` |
| **ANULAR libera lo apartado** | Hecho | Las reservas pasan a `RELEASED` con su motivo. El stock no se devuelve porque no se movió |
| Un pedido entregado no se anula | Hecho | Sale: se devuelve, que es otra cosa. `PEDIDO_ENTREGADO_NO_ANULABLE` |
| Un pedido no se cierra incompleto | Hecho | `fn_pedido_estado_coherente` rechaza `DELIVERED` si queda algo por servir |

## 6 · Producción y lotes de producto terminado

| Requisito | Estado | Dónde |
|---|---|---|
| La receta NO es una producción | Hecho | Tablas separadas `recipes` y `productions` |
| Fabricar crea una producción concreta | Hecho | `POST /api/productions` |
| Antes de fabricar se ve producto, cantidad, MP, lotes y cantidades | Hecho | `POST /api/productions/planificar` — no escribe nada |
| Lote PT automático y único | Hecho | `siguienteCodigoLoteProducto()` + contador `code_counters` |
| **Formato por producto** | Hecho | `PT-DES-00001`, `PT-LAV-00001`… (`items.lot_prefix`) |
| Contador independiente por producto | Hecho | Un contador por prefijo en `code_counters` |
| Contador protegido ante simultaneidad | Hecho | `INSERT … ON CONFLICT DO UPDATE` bloquea la fila. **Pendiente** la prueba con dos conexiones reales de PostgreSQL (ver Ab Known) |
| El operario no inventa el número | Hecho | El código lo asigna el sistema; si se pasa uno, es porque viene de una importación |
| La producción pasa a REALIZADAS | **Parcial** | Las producciones hechas ya están en su propio panel; falta la ORDEN de trabajo pendiente |

## 7 · Trazabilidad completa

| Sentido | Estado | Vista |
|---|---|---|
| Lote PT → producción → receta → lotes de MP → recepción → usuario | Hecho | `v_trace_to_material` |
| Lote MP → producción → lote PT → entregas → cliente | Hecho | `v_trace_from_material` |
| Producto entregado → de qué MP salió (con factura y proveedor) | Hecho | `v_trace_backward` |
| Producto → hacia adelante en la cadena | Hecho | `v_trace_forward` |
| Pedido → lote → producción → MP (encadenado) | Hecho | `v_trace_from_material` filtrando por pedido |

## 8 · Stock

| Requisito | Estado | Dónde |
|---|---|---|
| MP / envases / PT con sus cantidades | Hecho | `v_item_available`, `v_item_stock` |
| Cantidades apartadas | Hecho | `v_item_available.qty_reserved` |
| Cantidades realmente consumidas | Hecho | `stock_movements` (libro mayor) |
| Lotes y caducidades | Hecho | `lots`, `v_fefo_candidates` |
| **El stock es real, no una lista de movimientos** | Hecho | Fabricar baja la MP y sube el PT en `lots.qty_available`. Verificado en pruebas |

## 9 · Producto terminado

| Requisito | Estado | Dónde |
|---|---|---|
| Listado de PT por producto con sus lotes | Hecho | `GET /api/lots` filtrado por origen |
| Abrir un lote y ver su trazabilidad | Hecho | `GET /api/trazabilidad/lote/:id/adelante` y `/atras` |

## 10 · Historial y auditoría

| Requisito | Estado | Dónde |
|---|---|---|
| Quién y cuándo en cada operación | Hecho | `audit_log` (append-only por disparador) con usuario, IP, navegador, antes y después |
| Operación completa, no solo el movimiento | Hecho | `audit_log` + `albaran_events` + `productions`/`deliveries` con su usuario y su fecha |

## 11 · Informes

| Requisito | Estado | Dónde |
|---|---|---|
| Consulta por día / semana / mes / producto / lote / cliente | **Pendiente** | Fase 7. El modelo está (`visits`, `expenses`, `commercial_targets`, `deliveries`), la consulta no |
| Imprimir y exportar | **Pendiente** | Fase 7. La hoja de impresión ya es común |

## 12 · Identidad visual

| Requisito | Estado | Dónde |
|---|---|---|
| Logo, gota, nombre de marca | Hecho | `web/img/logo-sahel.svg` |
| Mismo diseño en todos los documentos | Hecho | Variables CSS de marca + hoja `@media print` |
| Copiar lo que funcionaba, no los fallos | Hecho | La app nueva es independiente:Express + PostgreSQL, sin SQLite ni datos antiguos |

---

## Lo que no se puede cambiar

Estas reglas no son preferencias. Viven en la base de datos, no en el código:

| Regla | Mecanismo |
|---|---|
| `items` no tiene columna de stock | Prueba contra `information_schema` |
| Reservar no consume | `order_reservations` no aparece en ningún `UPDATE lots` |
| Imprimir no entrega | `CHECK albaran_delivered_exige_firma_y_fecha` |
| No hay entrega sin firma | Disparador `fn_entrega_exige_firma` |
| No se aparta dos veces lo mismo | `uniq_reserva_linea_lote` + `fn_reserva_no_supera_pedido` |
| Un lote, un código | `lots.code` UNIQUE + contador con bloqueo de fila |
| `audit_log` no se borra | Disparador que impide `UPDATE`/`DELETE` |
| Los permisos fallan cerrados | `requierePermiso` devuelve 403; ocultar botones es cortesía, el 403 es la garantía |

---

## Lo que queda por fase

| Fase | Contenido |
|---|---|
| 5 | Albarán imprimible, firma sobre lienzo, reparto por zona, estados en el panel |
| 6 | Tarjeta de cliente con QR imprimible, escáner con cámara, pantalla de reparto |
| 7 | Informes, alertas, trazabilidad completa en pantalla, gastos, compras, ventas, configuración |

---

## Regla de la lista de trabajo

> **La pantalla enseña lo que está PENDIENTE. Lo hecho no desaparece: se guarda.**

| Pantalla | Lista de trabajo | Histario |
|---|---|---|
| Stock → Apartado | Solo `ACTIVE` y `ASSIGNED` | Liberados y consumidos, en panel plegado con su cuenta |
| Pedidos | `DRAFT`, `CONFIRMED`, `RESERVED`, `PREPARED`, `IN_ROUTE` | `DELIVERED` y `CANCELLED`, en panel plegado |
| Entregas | Todo menos `DELIVERED` | Entregas cerradas |
| Producción | — **pendiente de construir** | `Producciones realizadas` |

Las cuatro leen `?vivas=1`. **Nada se borra**: es un cambio de dónde se mira.

### Lo que falta, y por qué no se ha hecho todavía

**Las órdenes de fabricación pendientes.** El esquema ya tiene lo necesario
(`productions.status` con `DRAFT` y `PLANNED`, más `planned_at`), pero `producir()`
crea directamente en `COMPLETED`: hoy no existe la posibilidad de decir «hay que
fabricar 1.000 litros» sin hacerlo en el mismo instante.

Para hacerlo bien hacen falta decisiones que son tuyas, no mías:

1. ¿Quién crea la orden? ¿Tú desde Recetas, o el propio sistema al confirmar un
   pedido que no tiene stock?
2. ¿Al planificar la orden se aparta el stock para ella, o se aparta al confirmarla?
3. Si al llegar el día ya no hay materiales, ¿qué pasa con la orden?
4. ¿La cantidad se puede cambiar después de crearse?

No se ha empezado porque es funcionalidad **nueva**, no una corrección de vista, y
tienes que decidir esas cuatro cosas antes.

---

## Decisiones del usuario (2026-10-03)

Quedan fijadas aquí para que no se vuelvan a discutir por separado:

| Decisión | Valor |
|---|---|
| Moneda oficial | **FCFA**. Código interno `XOF` (ISO 4217, la columna solo admite 3 letras) |
| Navegación móvil | **Menú lateral deslizable** con botón ☰ |
| Datos de empresa | En `app_config`, leídos por todos los documentos |
| QR de la tarjeta | Permanente mientras la tarjeta esté vigente; revocable si se pierde |
| Nombre del cliente | **Sí** va impreso en la tarjeta; **no** va en el QR |
| Columna PRESENTACIÓN | `items.format_label` |
| IVA | Se calcula con la tasa real configurada. `subtotal + impuesto = total` |

**El error de la aplicación antigua que NO se reproduce:** rotula «21% I.V.A.»
pero aplica el 18 %. Aquí el total siempre cuadra con la etiqueta.

---

## Limitaciones conocidas

Estas cosas **no están resueltas**, y conviene no olvidarlo:

1. **La concurrencia real no se ha probado con dos conexiones de PostgreSQL.**
   PGlite serializa dentro del mismo proceso, así que la prueba del contador
   demuestra la semántica del SQL pero no un bloqueo entre transacciones
   abiertas a la vez. Hay que repetirlo contra el PostgreSQL de Oregon antes de
   producción. Afecta a: contador de lotes, `FOR UPDATE` del FEFO, y la carrera
   entre dos repartidores confirmando el mismo pedido.

2. **La pantalla del albarán no existe todavía.** La API, el modelo y las
   reglas están; falta el documento que se ve y se imprime (Fase 5).

3. **La tarjeta de cliente con QR no existe todavía** (Fase 6). El `qr_token` sí,
   con su unicidad garantizada.

4. **La pantalla de separar producciones pendientes de realizadas no existe**
   (Fase 5). Los estados están en la tabla desde el principio.

6. **Los datos de empresa están sembrados, no editables desde la interfaz.**
   Existen en `app_config` y todos los documentos los leerán de ahí, pero
   todavía no hay una pantalla para cambiarlos (Fase 7).

5. **PGlite es solo para desarrollo y pruebas.** En producción, PostgreSQL de
   servidor mediante `DATABASE_URL`. Nunca se ha creado esa base.

---

## Cómo actualizar este documento

Cuando se complete algo, se cambia su estado **y se toca la prueba que lo
verifica**. Si una fila dice «base de datos» y no hay ningún `CHECK`, índice ni
disparador que lo ponga, la fila está mintiendo: hay que arreglar el
mecanismo o cambiarla a «código», siendo honesto sobre lo que es.

## Cómo se verifica cada punto

Las ocho garantías de la Fase 4 tienen prueba propia en
`server/tests/fase4.test.js` (50 pruebas). Ninguna comprueba que el código
«intente» hacerlo: comprueban lo que la BASE hace cuando el código se equivoca
o cuando alguien escribe por SQL saltándose la API.

| Prueba | Qué Rompe si falla |
|---|---|
| 1 · sobre-reservar | Un pedido podría comprometer más mercancía de la que hay |
| 2 · anular | Lo apartado no se liberaría, o el stock aparecería devuelto sin haber salido |
| 3 y 4 · fabricar para un pedido | La producción perdería el vínculo, o el lote PT quedaría sin dueño |
| 5 · entrega parcial | Se descontaría de más, o lo no servido dejar de estar apartado |
| 6 · entrega completa | El pedido no cerraría, o se podría volver a entregar |
| 7 · más de lo reservado | Se podría entregar mercancía de otro pedido |
| 8 · trazabilidad | La cadena se rompe y nadie sabe de dónde salió qué |
| Extra · QR | La tarjeta filtraría datos o una tarjeta perdida seguiría valiendo |
| Extra · libro mayor | El stock y sus movimientos dejarían de cuadrar |

Auditado y verificado el 3 de octubre de 2026 contra el esquema real, no contra
un plan. Última auditoría: Fase 4.

---

## ÓRDENES DE FABRICACIÓN (añadido el 4 de octubre de 2026)

Producir era una sola pulsación. Ahora el trabajo pasa por una orden que el
planificador deja y el operario termina. El motivo es que un programador no es
un operario: si quien decide qué se fabrica no es quien pulse, hace falta un
papel en medio.

```
PLANIFICAR ──► PENDIENTE ──► CONFIRMAR ──► HISTÓRICO
   (nada           │            │              (con lote
    se toca)       │            │               y materiales)
                   │            └──► aquí SÍ se consume
                   └──► falta material: NO se cancela
```

### Las cuatro reglas de esta parte

| Regla | Por qué |
|---|---|
| **Planificar no toca el stock** | La orden es un papel. Si crear una orden moviera mercancía, un programador que se equivoca de cantidadvaciaría el almacén sin haberlauchado nada. |
| **Falta material no cancela la orden** | Cancelar en silencio le quitaría al planificador la única señal de que hay un problema. Se queda `PLANNED` diciendo QUÉ falta y CUÁNTO. |
| **La cantidad se cambia solo antes de empezar** | Una vez confirmada, la cantidad es un hecho. Cambiarla después rompería la trazabilidad: el lote dice una cosa y el consumo otra. |
| **Confirmar consume una sola vez** | El bloqueo de la fila va DENTRO de la transacción, con `FOR UPDATE` y con el `UPDATE … WHERE status='PLANNED'`. La segunda confirmación espera, revalida y se va con 409 sin haber tocado un lote. |

### El código FAB se conserva

Al confirmar **no** se pide un código nuevo. El parte de trabajo del operario
dice `FAB-2026-0008` y el histórico dice `FAB-2026-0008`. Si al fabricar se
pidiera otro, el trabajo de una persona desaparecería de su propia pantalla.

### `produccionId` frente a `productionId`

No son el mismo nombre y NO son el mismo parámetro. El de `confirmarPlan()` es
`productionId`; el de `producir()` es `produccionId`. Confundirlos daba un 500
sin explicación. Igual que `v_item_available` vs `existenciasDe`.

### Lo que se olvidó por el camino

`calcularNecesidades()` devolvía las líneas de la receta **sin `disponible`**.
Entonces `Number(l.disponible)` daba `NaN`, y `NaN < necesita` es `false`: la
comprobación de material daba «hay suficiente» cuando no había ni un envase. La
pantalla llegó a decir «hay material para fabricar 2000 unidades» con un **0**
al lado. El campo se añadió en la receta, que es de donde viene.

Igual con el histórico: `listarProducciones()` sin filtro devuelve también las
pendientes, y los dos bloques de la misma pantalla enseñaban la misma fila dos
veces. La pantalla pide `?estado=COMPLETED`.

### Verificación

`server/tests/ordenes.test.js`, 12 pruebas. Entre otras:

| Prueba | Qué rompe si falla |
|---|---|
| 1 · planificar | Un papel movería mercancía |
| 2 y 3 · falta material | Se cancelaría en silencio, o se fabricaría sin material |
| 5 y 6 · editar antes/después | La trazabilidad dejaría de cuadrar |
| 7 y 9 · confirmar | No se consumiría, o el lote PT no saldría |
| 8 · el código | El parte y el histórico dejarían de ser el mismo trabajo |
| 10 · confirmar dos veces | Se fabricaría dos veces y se comería el doble de material |
| 11 · solape | La misma orden en pendientes y en el histórico |
| 12 · el muro | La comprobación estaría fuera de la transacción y dejaría pasar la segunda |

La 12 llama al motor con una orden ya hecha: es justo lo que vería la segunda
confirmación si se colara. PGlite serializa las transacciones, así que la
carrera real contra un PostgreSQL de servidor sigue sin probarse; lo que sí está
comprobado es que el bloqueo y la revalidación ocurren dentro de la transacción
y ANTES de consumir el primer lote.

---

## ALBARÁN (Fase 5, 4 de octubre de 2026)

```
CREAR ──► IMPRIMIR ──► FIRMAR ──► ENTREGAR
  (nada     │            │             │
se toca)    │            │             └──► AQUÍ sale la mercancía
            │            └──► imagen PNG + SHA-256, una sola vez
            └──► NO entrega. El almacén imprime mucho antes de tiempo.
```

### El agujero que esta fase cerró

`entregarAlbaran()` marcaba el documento como `DELIVERED` y **no hacía nada
más**. No creaba entrega, no consumía stock y no tocaba el pedido. Es decir: un
albarán podía decir «entregado» mientras la mercancía seguía entera en el
almacén. Un almacén que regala.

Ahora `ENTREGAR` pasa por el **mismo motor** que la API de entregas
(`registrarEntrega`), dentro de la misma transacción. Un solo camino para las
dos pantallas, y por tanto una sola regla. La firma que el cliente dejó en el
albarán se **enlaza** a la entrega: es la misma fila de la misma imagen, no una
copia.

Lo dejó pasar una prueba verde: `alcance.test.js` daba por bueno el
comportamiento viejo. Se corrigió la prueba, no el sistema.

### Cuatro reglas

| Regla | Por qué |
|---|---|
| **Imprimir no entrega** | En almacén se imprime mucho antes de que nadie firme. Si imprimir descontara, el almacén vaciaría el stock cada mañana. |
| **No se salta ningún paso** | Firmar sin imprimir o entregar sin firma da 409 con el motivo. Los CHECK de la migración lo vigilan también desde abajo. |
| **La firma no se vuelve a poner** | Antes, un albarán ya FIRMADO aceptaba una segunda firma y la **sobrescribía**: la imagen y el nombre de quien recibió cambiaban después de haber servido la mercancía. Aquí es donde se decide quién recibió, y una vez decidido no se toca. |
| **Entregar dos veces no descuenta dos veces** | 409, y el stock se comprueba con números en la prueba. |

### Los datos de la empresa salen de `app_config`

El documento se arma en el servidor con `empresa()` de `core/config.js`. Razón
social, CIF, domicilio, moneda y símbolo **no están escritos en el código**:
cambiarlos es cambiar una fila y queda bien en todos los documentos a la vez.

- `moneda` = `XOF` (código ISO, para ordenar y calcular).
- `simbolo` = `FCFA` (lo que se imprime).

El IVA sale con **su tasa**: el documento dice `I.V.A. (21 %)`. La aplicación
antigua rotulaba «21 %» y aplicaba 18 %; el papel no cuadraba con la cuenta.

`items.format_label` es la columna **PRESENTACIÓN** y estaba sin usar: el
albarán salía sin decir «750 ml». Ahora la trae.

### La firma en pantalla

`web/js/firma.js` dibuja con `pointer*` (dedo, ratón y lápiz en un solo código)
y con `touch-action: none`, sin lo cual el navegador se queda con el gesto de
deslizar y la línea sale cortada. `getCoalescedEvents()` recupera los puntos
intermedios: sin ellos la firma es una poligonal de lados rectos. Los trazos se
suavizan con curvas cuadráticas por el punto medio.

Se guarda como PNG binario en PostgreSQL con su **SHA-256**, y hay una
`UNIQUE` en `albaran_id`: un albarán no puede tener dos firmas.

### Impresión

Dos copias, una por hoja A4. Al imprimir se oculta **toda** la aplicación
(`body:has(.albaran) .contenido`) y no «todo lo que no sea albarán»: esa
segunda versión parecía correcta y fue la que acabó ocultando el documento
entero, imprimiendo en blanco. El albarán se arma en el servidor, así que lo
impreso y lo que se ve en pantalla no pueden contradecirse.

### Verificación

`server/tests/albaran.test.js`, 9 pruebas. La más importante es la 6: comprueba
que el stock baja exactamente lo servido. Es la que habría detectado el
agujero.

---

## TARJETA, ESCÁNER Y REPARTO (Fase 6, 4 de octubre de 2026)

```
TARJETA ──► QR ──► ESCÁNER ──► CLIENTE ──► PEDIDO ──► ALBARÁN ──► ENTREGA ──► HISTÓRICO
(85,6×54)  (opaco)  (móvil)                    (en ruta)   (firma)   (stock baja)
```

### El QR no lleva la dirección

Es la decisión más importante de la fase y se puede resumir en una frase: **la
tarjeta es plástico y dura años; el dominio actual es temporal.**

Si el QR codificara una URL (`https://dominio/qr/abc`), el dominio quedaría
grabado en el plástico. El día que se cambie de servidor, todas las tarjetas
repartidas dejarían de servir a la vez y habría que reimprimir el lote entero.
Va solo el token, que es opaco y no depende de dónde se escanee.

Se comprueba con una prueba: el contenido del QR no puede contener `http`,
`//`, `api/` ni el dominio. Y medido: 32 caracteres, 192 bits de entropía.

### El QR no lleva datos personales

Ni una letra del nombre, ni un dígito del teléfono, ni la dirección. Hay una
prueba que lo recorre y falla si aparece cualquiera de ellos.

El **nombre sí va impreso** en la tarjeta. No es contradicción: la tarjeta es
un documento que el cliente enseña a propósito, y el QR es un token que la
aplicación resuelve. Son dos cosas y no se mezclan.

### La tarjeta: 85,6 × 54 mm, en milímetros de verdad

Tamaño bancario. En pantalla se ve a escala real y al imprimir sale en una hoja
de 85,6 × 54 mm — comprobado sobre el PDF generado: `MediaBox` de 85,7 × 54,0
mm, una sola página.

Tres cosas hubo que arreglar para que saliera **una** hoja y no dos:

1. `.app` conserva `min-height: 100vh`; con todo lo de dentro oculto, eso es
   una pantalla entera de hueco detrás de la tarjeta.
2. El `body` con su margen por defecto empuja la tarjeta hacia abajo.
3. El diálogo mide **un píxel** más que la hoja, y ese píxel genera la segunda.

### Generador y lector, comprobados el uno contra el otro

No basta con que el QR se genere: tiene que LEERSE. La prueba 2 genera el PNG
del servidor, lo decodifica con el mismo jsQR que usa el móvil y comprueba que
sale el token del cliente. Y en el navegador, jsQR lee el PNG y la API lo
resuelve.

Nivel de corrección **H**: un 30 % del área puede estar tapada. Estas tarjetas
se plastifican, se manchan y se leen a contraluz; con el nivel por defecto se
leerían en el despacho y fallarían en la calle.

### El escáner tiene plan B

Cámara con `getUserMedia` y `BarcodeDetector` no: la API nativa no está en iOS
Safari ni en Firefox, y el repartidor lleva el móvil en la mano. Se usa
`getUserMedia` + `jsQR`, que funciona en todas partes.

Debajo de la cámara hay **siempre** un campo para escribir el código. Un
escaner que no tiene plan B no es un escaner: es un adorno que falla el día que
hace falta, y ese día es cuando el cliente está en la puerta esperando.

Se analiza el fotograma con `requestAnimationFrame`, no con `setInterval`: los
temporizadores siguen corriendo en segundo plano y se comen la batería del
móvil justo cuando hace falta, que es un reparto entero.

### La ruta del repartidor son ALBARANES, no entregas

Este es el hallazgo de diseño de la fase, y tiene prueba propia.

Lo primero fue listar `deliveries`, que ya tenía `rep_id` y sus estados
PENDING/ASSIGNED/PICKED_UP. **No funcionaba**, y el motivo es incómodo:
la fila de `deliveries` no nace cuando se carga la mercancía, sino cuando el
cliente firma. `registrarEntrega()` crea la entrega y la cierra en el mismo
paso. Es decir: en el instante en que existiría una «entrega en ruta», ya
estaría entregada, y la ruta marcaría cero paradas siempre.

El documento que sí viaja es el albarán, y sus estados ya son el recorrido:

| Estado | Qué significa |
|---|---|
| `DRAFT` | impreso todavía, en el almacén |
| `PRINTED` | impreso y cargado. **Va en el camión.** |
| `SIGNED` | el cliente ya ha firmado |
| `DELIVERED` | cerrado. Aquí baja el stock. |

### Imprimir y firmar NO mueven el stock

Es la confusión más cara del reparto, y tiene prueba: se imprime, se firma, y
el saldo se comprueba que **no se ha movido**. Lo baja `DELIVERED`.

| Momento | ¿Baja el stock? |
|---|---|
| Crear el albarán | No |
| Imprimir | No. El almacén imprime mucho antes de tiempo |
| Firmar | No. La mercancía sale al firmarlo, no antes |
| Confirmar entrega | **Sí**, y solo una vez |

### «No pude entregar» no cancela nada

Se anota el motivo en el historial del albarán y **no se toca el estado**. El
albarán sigue impreso y sin firmar, para el día siguiente.

Si esto cancelara, un cliente que no estaba habría perdido su pedido entero.
La mercancía tampoco «vuelve al almacén» por escribir un motivo: nunca salió.

Eso obligó a ampliar el `CHECK` de `albaran_events` con `NOT_DELIVERED`
(migración `012`).

### Un fallo que también era un fallo

`<img src="/api/…">` no lleva la cabecera de sesión, así que salía con un 401.
Afectaba a **dos documentos oficiales**: la firma del albarán (Fase 5) y el QR
de la tarjeta. Los dos se veían en blanco, sin ningún error visible.

Se resuelve con `A.imagen()`, que pide la imagen con la cabecera correcta y
devuelve una dirección `blob:`. **No** el token en la URL: eso lo escribiría en
el historial del navegador y en los registros del servidor.

### El reparto salía repetido

Un `LEFT JOIN` normal a `deliveries` multiplicaba la fila: un pedido entregado
en dos tandas tiene dos entregas, y la misma parada salía **DOS VECES** en la
hoja de ruta. El repartidor iba dos veces a la misma puerta.

Resuelto con `LEFT JOIN LATERAL … LIMIT 1`. La prueba 8 fuerza el caso creando
una segunda entrega y comprueba que cada parada sale una vez.

### El código del cliente: `CL-00001`

**Formato antiguo, cinco dígitos. Decisión del usuario.**

La aplicación nueva generaba `CLI-0001` y la antigua `CL-00001`. Tener los dos
formatos conviviendo es peor que equivocarse en uno: el repartidor ve
«CLI-0007» en un sitio y «CL-00007» en otro, y el albarán impreso en papel dice
una cosa y la pantalla otra.

Migración `019_codigo_cliente.sql`: `CLI-####` → `CL-#####`.

Es segura porque **ninguna tabla guarda el código del cliente** —todas lo
referencian por `id`—, y el albarán y la tarjeta leen `c.code` al imprimirse.
No hay ningún documento que reeditar, y los pedidos, entregas, stock e
historial no se tocan: esto solo cambia una etiqueta.

### Verificación

`server/tests/tarjeta.test.js`, 12 pruebas. Las que más valen: la 2 (el QR
impreso es el que el escáner lee), la 6 (imprimir no crea entrega) y la 7
(firmar no baja el stock).

---

## EL ALBARÁN ES DE UNA SOLA HOJA (4 de octubre de 2026)

La aplicación genera **un albarán**. Cuántas hojas saque quien lo imprime lo
decide su diálogo de impresión, con sus opciones de páginas y de número de
copias. Eso no lo controlamos nosotros.

Antes se generaban dos copias —una para el cliente y otra para el archivo—
porque era una necesidad de almacén, no una regla del documento.

### `copies` ya no es el documento

`albaranes.copies` pasa a ser **cuántas hojas se quedaron en el archivo**, que
es una nota operativa. Que valga 10 no significa que el documento tenga diez
páginas: el documento es siempre uno.

Solo se cambió el **valor por defecto** a 1. Los albaranes ya emitidos
conservan el número que se imprimió de verdad, porque eso es un hecho del
pasado y reescribirlo sería inventar una historia que no ocurrió.

### Un fallo que salió al hacer esta comprobación

Al generar el PDF para verificar que era una hoja, salió **cuatro**, y el
`MediaBox` decía **85,7 × 54 mm**: el tamaño de la tarjeta.

`@page` **no admite selectores**. Los dos documentos declaraban su `@page` a
suelo, así que el de `albaran.css` (A4) y el de `tarjeta.css` (85,6 × 54 mm) se
pisaban, y **ganaba el que cargaba después**: el de la tarjeta. El albarán
salía impreso en un bolsillo de tarjeta de visita.

Es un fallo que ningún test de JavaScript habría visto, porque el CSS no se
ejecuta: hay que mirar el PDF generado.

Se resuelve nombrando las páginas, que es para lo que están:

```css
@page albaran { size: A4; margin: 12mm 11mm; }
body:has(.albaran) { page: albaran; }

@page tarjeta { size: 85.6mm 54mm; margin: 0; }
body:has(.tarjeta) { page: tarjeta; }
```

Cada documento va al papel que le toca, sin importar el orden en que lleguen
las hojas de estilo.

**Comprobado sobre el PDF generado:**

| Documento | Páginas | Tamaño |
|---|---|---|
| Albarán | **1** | 209,9 × 297,0 mm (A4) |
| Tarjeta | **1** | 85,7 × 54,0 mm |

### La prueba que lo vigila

`albaran.test.js` 10 y 11:

- **10**: un albarán creado con `copies: 10` sigue siendo un solo documento, y
  uno nuevo nace con una hoja.
- **11**: comprueba que los dos `@page` están **nombrados** y que ningún
  `@page` anónimo suelto ha vuelto a colarse. Es la que falla si alguien
  vuelve a declarar un tamaño sin nombre.

---

## UNA SOLA PUERTA PARA ENTREGAR (auditoría, 4 de octubre de 2026)

### Lo que estaba pasando

Había **DOS** maneras de entregar el mismo pedido, y solo una era coherente:

| Vía | Pedido | Albarán | Firma |
|---|---|---|---|
| `POST /api/albaranes/:id/entregar` | `DELIVERED` | `DELIVERED` | la del cliente |
| `POST /api/deliveries` | `DELIVERED` | **se quedaba en `DRAFT`** | **fabricada** |

Comprobado sobre el sistema real, no sobre el papel:

```
PED-2026-0010  →  DELIVERED
ALB-2026-0008  →  DRAFT      ← «por entregar», para siempre
```

Es decir: **un pedido podía estar entregado mientras su albarán seguía en la
primera pantalla de pendientes.** Dos verdades sobre la misma entrega, y la que
se ve primero es la equivocada. De ahí lo que se veía en la aplicación: pedidos
«Preparado» sin salida clara, y albaranes de pedidos que ya se habían
entregado.

La firma de la vía falsa era peor: un PNG **fabricado en el navegador** a
partir del id del pedido y la hora. La evidencia de que el cliente recibió la
mercancía —la garantía sobre la que está construido todo lo demás— era un sello
generado por la propia aplicación.

### El arreglo: una puerta, y el albarán es un VIAJE

`POST /api/deliveries` responde **409** y explica por dónde va. No se borra, para
no dejar clientes viejos con un 404 sin explicación.

Y para que las entregas parciales sigan siendo posibles, el albarán pasó a
llevar **sus propias líneas** (`albaran_lines`, migración `013`):

- Un albarán es **un viaje**, no un pedido. Imprime lo que lleva ese viaje.
- Un pedido solo admite **un albarán vivo**: el segundo se rechaza con
  `ALBARAN_EN_CURSO`. Sin eso se montaban dos y uno quedaba huérfano.
- Un disparador impide que un albarán lleve más de lo que queda pendiente, y
  descuenta lo que otros albaranes del mismo pedido ya exigen. Entre que se
  crea y que se entrega pueden pasar horas.

### Un bug de la Fase 4 que esto destapó

Al servir una línea de pedido **desde dos lotes** reventaba con
`duplicate key value violates unique constraint`.

La causa: `delivery_lines` guarda **una fila por lote** —es lo que permite la
trazabilidad hacia atrás— pero el índice único era
`(delivery_id, order_line_id)`, es decir, prohíbe lo que la tabla necesita
guardar. El índice no describía la realidad: la impedía.

Y es el caso **normal**: un producto fabricado en dos tiradas, que es lo que pasa
siempre que se ha producido más de una vez.

Migración `014`: el índice único pasa a ser `(delivery_id, order_line_id,
lot_id)`. Sigue impidiendo lo que hay que impedir —que la misma combinación
entrega/línea/lote se escriba dos veces, que es lo que rompería el libro mayor— y
deja de impedir algo que sí tiene que pasar. Es un cambio de índice, no de
datos.

### El estado del pedido: una sola fuente

`v_order_progress.status` **es** la columna `sales_orders.status`. No hay estado
derivado en ninguna pantalla: Pedidos, la ficha, el escáner y los albaranes leen
el mismo sitio.

La máquina de estados es la que ya existía, y es coherente:

```
DRAFT ──► RESERVED ──► PREPARED ──┬──► DELIVERED
  │            │            │      │
  │            │            │      └──► IN_ROUTE   (entrega parcial)
  └────────────┴────────────┴─────────────────────► CANCELLED
```

`IN_ROUTE` significa «parte entregada, el resto en camino», y lo pone el motor
cuando la entrega no cubre el pedido entero. **Preparado no es entregado**, y
tener un albarán impreso tampoco.

### El escáner dejó de ser un visor

`abrirEscaner()` se llamaba sin manejador, así que los botones por pedido nunca
se pintaban: se escaneaba la tarjeta, se veía qué había, y no se podía hacer
nada.

Ahora cada pedido pendiente lleva **su** botón, con su código a la vista. Un
cliente puede tener tres pedidos a la vez, y equivocarse al cerrar una entrega
no se deshace: el stock ya bajó y el cliente ya firmó.

### La prueba

`tests/flujo-entrega.test.js`, 9 pruebas, y la prueba de extremo a extremo que se
ejecutó sobre la aplicación en marcha:

| | |
|---|---|
| 1. Crear pedido → `DRAFT` | ✓ |
| 2. Confirmar → `RESERVED` | ✓ |
| 3. Preparar → `PREPARED` | ✓ |
| 4. Tarjeta QR del cliente | ✓ |
| 5. El QR resuelve y lista el pedido pendiente | ✓ |
| 6. `POST /deliveries` **rechazado** con 409 | ✓ |
| 7. Crear albarán con sus líneas | ✓ |
| 8. Segundo albarán del mismo pedido **rechazado** | ✓ |
| 9. Imprimir → firmar → **entregar** | ✓ |
| 10. **Se refleja en** Pedidos, ficha, escáner, reparto e histórico | ✓ |
| 11. Tras 3 recargas sigue `DELIVERED` | ✓ |
| 12. Historial: CREATED → PRINTED → SIGNED → DELIVERED | ✓ |
| 13. **Caso contrario**: preparado ≠ entregado | ✓ |
| 14. Tener albarán impreso **no** entrega | ✓ |
| 15. Entregar sin firmar **rechazado** | ✓ |
| 16. Tres pedidos del mismo cliente: entregar uno no toca los otros dos | ✓ |

**0 fallos.**

---

# LA ENTREGA SE CONFIRMA CON LA TARJETA, NO CON EL ALBARÁN
### Decisión definitiva · 4 de octubre de 2026

## El reparto, paso a paso

```
1.  El repartidor carga la mercancía y los albaranes IMPRESOS.
2.  En la puerta, el cliente FIRMA EN PAPEL y se lleva su copia.
3.  El repartidor ESCANEA LA TARJETA QR del cliente con el móvil.
4.  La pantalla le enseña los pedidos que PUEDE entregar de ese cliente,
    con los productos y las cantidades de cada uno.
5.  Pulsa «Entregar» en el pedido exacto.
6.  ESO escribe en el sistema: descuenta el stock, cierra el pedido y deja
    constancia de quién confirmó, cuándo y por qué vía.
```

El paso 6 es el único que cambia el estado. Los pasos 1 y 2 son papel.

## Lo que se cambió, y por qué

### La entrega pasó de ser «el albarán» a ser «la tarjeta»

**ANTES.** El botón del escáner llamaba a `viaAlbaran()`: abría el pedido,
mostraba el albarán y pedía imprimir, firmar en la pantalla y luego confirmar.
Es decir: para cerrar la entrega, el repartidor tenía que abrir el pedido en el
móvil delante de la puerta con el cliente esperando, y subir un dibujo de la
firma que ya estaba en papel.

**AHORA.** `POST /api/reparto/pedido/:id/entregar` hace el trabajo, y nada más
lo hace. El albarán no participa.

**POR QUÉ.** Tres razones, en orden de peso:

1. **El repartidor, en la puerta, con el móvil en una mano y la mercancía en la
   otra.** Cuantos más pasos, menos entregas se registran. Un paso de más no es
   un detalle: es un pedido que sigueConstando como pendiente al día siguiente.
2. **Había DOS caminos para lo mismo.** `POST /api/albaranes/:id/entregar` y
   `POST /api/deliveries`. Cada uno con sus reglas. Es la forma más rápida de
   que un pedido quede entregado en un sitio y pendiente en otro.
3. **La firma en papel no se puede comprobar.** Exigir una imagen en la
   aplicación no.convertía el papel en digital: solo obligaba a dibujar otra vez
   lo que el cliente acababa de firmar.

### La firma dejó de ser obligatoria, y el repartidor pasó a serlo

| | Antes | Ahora |
|---|---|---|
| Garantía de la entrega | una **imagen** de la firma | la **persona** que confirmó |
| `deliveries.signature_id` | obligatorio (`NOT NULL`) | puede ser `NULL` |
| `deliveries.confirmed_by` | no existía | **obligatorio** |
| `deliveries.confirmed_via` | no existía | `TARJETA_QR` |
| `deliveries.confirmed_at` | no existía | obligatorio con la confirmación |

El disparador de la base cambió en la misma línea: antes rechazaba una entrega
sin `signature_id`; ahora rechaza una entrega sin **`confirmed_by` Y
`confirmed_at`**. La garantía no se ha debilitado, se ha mudado al sitio donde
está la respuesta a la pregunta que de verdad se hace:

> «¿Quién me dejó esto aquí?»

### El albarán se quedó siendo papel

- `anotarPapelDevuelto()` sustituye a `entregarAlbaran()`. **No descuenta
  stock**, **no toca `sales_orders`**. Anota que el papel volvió y quién lo
  devolvió, y nada más.
- `POST /api/albaranes/:id/entregar` devuelve **409** con una explicación, en
  vez de desaparecer: un cliente antiguo recibe un mensaje, no un 404 a secas.
- Se borró la restricción `albaran_delivered_exige_firma_y_fecha` y
  `albaran_entregar_despues_firmar` (migración `016`). En su lugar,
  `albaran_delivered_exige_fecha`: un albarán no puede decir «entregado» sin
  fecha. Es la única coherencia que se le exige al papel.
- Las **dos restricciones de la entrega** siguen intactas: la que impide
  entregar más de lo reservado y la que impide cerrar un pedido con líneas
  pendientes.

### El escáner enseñaba pedidos que no se podían entregar

`resolverQr()` devolvía todo lo no anulado, incluidos los `DRAFT` (que no tienen
ni mercancía reservada) y los `RESERVED` que todavía nadie había preparado. El
repartidor veía una lista y no tenía forma de saber cuál de los tres era el que
podía entregar.

Ahora devuelve dos listas, y esto es la diferencia entre una lista y una
herramienta:

- **`pedidos_pendientes`**: solo `RESERVED`, `PREPARED` e `IN_ROUTE` con
  mercancía por servir. Cada uno con **qué productos y cuántas unidades**.
- **`pedidos_no_entregables`**: los que hay, pero con su estado, para que no se
  pregunte dónde se han quedado.

### El índice que impedía repartir en varios días

La migración 015 creó `uniq_entrega_por_pedido_confirmada` sobre
`deliveries (sales_order_id) WHERE status='DELIVERED'`, pensando que impedía
cerrar un pedido dos veces.

Lo que impedía era **repartir un pedido en dos días**. `deliveries.status` dice
si ESTA entrega se hizo, no si el PEDIDO se terminó: cuando el repartidor sirve
la mitad y quedan cajas para otro día, esa entrega está hecha y muy bien. Con el
índice, la segunda parada reventaba con «duplicate key». La migración 017 lo
retira, y explica en el propio archivo qué es lo que sí impide el cierre doble:
el libro mayor (`qty_delivered` no pasa de `qty`), el disparador
`fn_pedido_estado_coherente`, y la comprobación de la API.

### Las copias son de la impresora, no del sistema

`albaranes.copies` es la **nota de cuántas hojas se quedaron en el archivo**. El
documento sigue siendo de una sola página: imprimir dos es sacar el mismo
albarán dos veces de la impresora, una para el cliente y otra para el archivo.
No son dos documentos, ni dos páginas, ni dos entregas, y no mueven ningún
estado.

## Lo que NO ha cambiado

- `CONFIRMAR PEDIDO → APARTA EL STOCK, PERO NO LO DESCUENTA.`
- `ENTREGAR PEDIDO → DESCUENTA EL STOCK UNA SOLA VEZ.`
- `ANULAR PEDIDO → LIBERA LO APARTADO SIN HABER DESCONTADO STOCK.`
- La entrega parcial: servir 40 de 100 deja 60 vivos y el pedido en `IN_ROUTE`.
- Un pedido, un albarán vivo a la vez.
- La trazabilidad en los dos sentidos.
- El QR opaco, revocable y sin datos personales dentro.

## La prueba que lo fija

`server/tests/tarjeta-entrega.test.js`, nueve comprobaciones sobre un cliente
con tres pedidos (dos por entregar y uno ya entregado):

| # | Qué comprueba |
|---|---|
| 1 | La tarjeta enseña los dos pendientes y **qué lleva cada uno** |
| 2 | Un borrador no aparece como entregable, pero sí como aviso |
| 3 | Entregar descuenta **exactamente** lo entregado, y deja quién, cuándo y por qué vía |
| 4 | Entregar uno **no mueve** los otros dos |
| 5 | Un pedido entregado no se entrega dos veces |
| 6 | La tarjeta de otro cliente **no** puede entregar este pedido |
| 7 | Un pedido sin preparar **no** se puede entregar |
| 8 | Tener albarán e imprimirlo **no** entregan nada |
| 9 | La entrega apunta a su albarán, y el papel se cierra cuando la entrega existe |

## Una nota sobre el deadlock de PGlite

Al escribir esta prueba se tropezó con el fallo más caro del proyecto, y no es
de PGlite: es de los **nombres de los parámetros**.

`crearPedido`, `confirmarPedido` y `prepararPedido` **no aceptan una `tx`**. Su
segundo parámetro es el **usuario**, y se parece muchísimo a una transacción. Si
se les pasa una `tx` por costumbre, abren una segunda conexión sobre la única que
tiene PGlite y la suite se queda colgada **sin decir ni una palabra**: ni un
error, ni un tiempo de espera, solo un `Promise resolution is still pending`.

Pasa con `crearCliente(datos, usuarioId)` también. Está escrito en el archivo de
la prueba, para que la próxima vez se lea antes de perder la tarde.

---

## LA BASE DE DEMOSTRACIÓN NO SE BORRA SIN AVISAR

**Decidido por el usuario el 5 de octubre de 2026, después de perder datos
reales por la vía de abajo.**

### Lo que pasó

El 5 de octubre se recreó la base de demostración **cinco veces** para poder
reaplicar la migración 025 y deshacer corrupción de PGlite. Cada vez que se
movió `.pgdata` a `.pgdata-<motivo>`, **se fueron los clientes y los pedidos
que el usuario había creado a mano para probar la interfaz**.

No fue un fallo de la aplicación: el alta de clientes funciona y está
probada con un navegador real (`server/tests/clientes-pantalla.test.mjs`).
 Fue una decisión de trabajo mal tomada: «es más rápido que repararlo» sobre
unos datos que eran de otra persona.

### La regla

**No mover, borrar ni recrear `server/.pgdata` sin avisar antes y sin que el
usuario lo pida.** En concreto:

- Las **pruebas** van siempre contra `server/.pgdata-test`, que es desechable
  y se borra entre test y test. Para eso está.
- Los **scripts de demostración y de verificación** (`coste-circuito.mjs`,
  `venta-circuito.mjs`, `revision-circuito.mjs`) **crean lo que necesitan**
  con las funciones de verdad y **no borran la base**. Si algo no existe, lo
  crean; si ya existe, lo usan.
- `seed-demo.mjs` **solo** se ejecuta cuando el usuario lo pide, y avisa de
  que va a crear una base vacía.

### Cómo se hace cumplir

`seed-demo.mjs` exige ahora `RECREAR_DEMO=1` en el entorno. Sin esa variable
se niega a arrancar y explica por qué. No es una promesa: es una barrera.

Los datos que ya se perdieron siguen recoverable: las bases apartadas son
`.pgdata-v025-invertida`, `.pgdata-coste-v1`, `.pgdata-coste-v2`,
`.pgdata-pre-caja` y `.pgdata-pre-caja2`. **No se borran.**
