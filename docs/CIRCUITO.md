# EL CIRCUITO COMPLETO: QUÉ HAY Y QUÉ FALTA

> Mapa de auditoría del ERP contra el principio de **un solo circuito
> conectado**, de la materia prima a la caja.
>
> **Fecha:** 2026-10-04 · **Estado:** verificación hecha contra la base y el
> código reales, no contra la memoria.
>
> **No se ha programado nada para producir este documento.** Es solo lectura.

---

## EL CIRCUITO QUE PIDE EL NEGOCIO

```
MATERIA PRIMA → PRODUCCIÓN → PRODUCTO TERMINADO → STOCK → PEDIDO
   → PREPARACIÓN → REPARTO → ENTREGA → PAGO → CAJA
```

Y dos exigencias que vienen con él:

1. **Se puede recorrer en los dos sentidos.** En cualquier momento, saber qué
  pasó con una venta, cuánto había, cuánto se vendió, cuánto se cobró, quién
   intervino, cuándo y dónde terminó el dinero.
2. **Una sola verdad.** El importe se calcula una vez. Ningún módulo lo vuelve a
   calcular a su manera.

---

## 1 · EL CIRCUITO, ESLABÓN POR ESLABÓN

Recorrido **hacia atrás** desde un pedido real de la base de pruebas
(`PED-2026-0001`, entregado). Esto no es un esquema teórico: es una consulta que
funciona.

```
PED-2026-0001 (DELIVERED · 7260 XOF)
 └─ cliente ............... CL-00001 Flujo Uno
 └─ comercial ............. (columna existe, sin usar)
 └─ línea 1 ............... 6 × 1000 = 6000
     └─ reserva .......... lote PT-FLU-00001 (origen PRODUCTION)
         └─ entrega ...... DELIVERED vía TARJETA_QR
             └─ producción FAB-2026-0001 (COMPLETED)
                 └─ materia prima MP-FLU-0001
 ✗ SE CORTA AQUÍ: no hay pago, no hay caja
```

### Estado por eslabón

| # | Eslabón | Estado | Qué lo sostiene |
|---|---|---|---|
| 1 | MP → Lote | **HECHO** | `lots.supplier_id`, `origin_type`, `origin_id`, `invoice_ref`, `received_at` |
| 2 | Lote → Producción | **HECHO** | `production_materials(production_id, lot_id, actual_qty)` |
| 3 | Producción → PT | **HECHO** | `lots.production_id` + vistas `v_trace_from_material` / `v_trace_to_material` |
| 4 | PT → Pedido | **HECHO** | `sales_order_lines` por artículo; el **lote** se elige en `order_reservations`, no antes |
| 5 | Pedido → Preparación | **HECHO** | estados `DRAFT → CONFIRMED → PREPARED` |
| 6 | Preparación → Reparto | **HECHO** | `deliveries.sales_order_id`, `rep_id`, `zone_id` |
| 7 | Reparto → Entrega | **HECHO** | `delivery_lines(order_line_id, lot_id, qty_delivered)` + `deliveries.confirmed_by/at/via` |
| 8 | **Entrega → Pago** | **❌ FALTA** | **No existe ninguna tabla de pago** |
| 9 | **Pago → Caja** | **❌ FALTA** | **No existe ninguna tabla de caja** |

**El circuito está entero del 1 al 7 y se rompe en el 8.** Ese es el hecho
central de este mapa.

> Nota sobre el eslabón 4: `sales_order_lines` **no** tiene `lot_id`, y es lo
> correcto. El lote se elige cuando se aparta la mercancía, no cuando se pide.
> Por eso el hilo va pedido → `order_reservations.lot_id` → `lots`.

---

## 2 · EL PRECIO: UNA SOLA VERDAD

Verificado en el esquema. El importe vive **una sola vez**:

| Tabla | Campos de importe |
|---|---|
| `sales_orders` | `subtotal`, `discount_amount`, `tax_rate`, `tax_amount`, `total` |
| `deliveries` | **ninguno** — lo toma del pedido |
| `delivery_lines` | **ninguno** — lo toma del pedido |
| `albaranes` | **ninguno** — lo toma del pedido |
| `albaran_lines` | **ninguno** — lo toma del pedido |
| `expenses` | `amount`, `paid` ← **excepción, ver abajo** |

**Esto ya cumple el principio.** Entrega y albarán no pueden mostrar una cifra
distinta de la del pedido porque no tienen dónde guardarla.

La moneda y la precisión también están resueltas desde el turno anterior:
8 decimales de cálculo, 4 de guardado, redondeo una vez al final, y cada
documento conserva su moneda y su tasa.

**⚠ La excepción:** `expenses` tiene `amount` **y** `paid` dentro de la misma
tabla. Un gasto con su propio «pagado» es el germen del sistema paralelo que
el negocio quiere evitar. Cuando se implemente Cobros, ese campo tiene que
desaparecer o pasar a ser un enlace a un cobro real, no un interruptor.

---

## 3 · LA AUDITORÍA: EXISTE, PERO ESTÁ DISTRIBUIDA

`audit_log` tiene 33 filas en la base de pruebas y **está protegido contra
UPDATE por un disparador** (`trg_audit_no_update`). Append-only de verdad, en la
base, no por convención del código.

Lo que registra hoy:

| Entidad | Acciones |
|---|---|
| `sales_orders` | `CREAR_PEDIDO`, `CONFIRMAR_PEDIDO`, `PREPARAR_PEDIDO` |
| `deliveries` | `REGISTRAR_ENTREGA`, `CONFIRMAR_ENTREGA_TARJETA` |
| `productions` | `PRODUCCION` |
| `customers` | `CREAR` |

**Lo que le falta para ser la trazabilidad que se pide:**

- Recepción de mercancía (lotes)
- Consumos de producción
- Cobros y caja — no hay nada que auditar todavía
- Cambios sobre datos ya existentes: `before_data` y `after_data` existen en la
  tabla, pero **no hay ninguna prueba de que algo los use** para un UPDATE

Con eso, la auditoría es un registro de «qué pasó», no de «qué cambió». El
negocio pide las dos cosas (§9 del documento).

---

## 4 · EL PORTAL DEL CLIENTE: NO EXISTE

Lo que hay hoy es `GET /api/qr/:token` → `resolverQr()`. Sirve para **el
repartidor**: le dice qué pedidos son entregables. Y además exige sesión interna
(`auth` + permiso de entregas), así que no es un portal público.

**No existe** ninguna de las cosas del §2 del documento:

- Mini página del cliente
- Consulta de pedidos por el cliente
- Consulta de lo pendiente / pagado / historial
- Creación de pedidos desde fuera

El `qr_token` del cliente ya existe y es opaco, revocable y sin datos personales
dentro — la base está lista. **Falta todo lo demás.**

Decisión de diseño pendiente: si el portal es público, el token es la única
puerta, y eso cambia el modelo de threats de todo lo demás.

---

## 5 · COMERCIAL: LAS COLUMNAS EXISTEN, EL SISTEMA NO

| Pieza | Estado |
|---|---|
| `leads`, `visits`, `commercial_targets`, `customer_stats`, `sales_routes` | tablas, **0 filas** |
| `zones` | 11 filas |
| `customers.commercial_id` | **columna real**, sin usar |
| `sales_orders.commercial_id` | **columna real**, sin usar |
| Rutas de API | **cero** |
| Pantallas | **cero** |
| Antecesor en la app antigua | **ninguno** |

Las dos columnas del enlace Cliente → Comercial → Pedido **ya están en el
esquema**, que es justo el hilo que el §3 del documento pide. Lo que falta es
lo que las llene y algo que las enseñe.

---

## 6 · LOS MÓDULOS QUE YA FUNCIONAN (con API y pantalla)

| Módulo | API | Pantalla | Nota |
|---|---|---|---|
| Auth, usuarios, roles, permisos | ✅ | ✅ | fail-closed |
| Catálogo (MP / envases / PT) | ✅ | ✅ | maestro único |
| Stock, lotes, movimientos | ✅ | ✅ | saldo en `lots.qty_available` |
| Producción, recetas, FEFO | ✅ | ✅ | planificar no consume; confirmar sí |
| Clientes | ✅ | ✅ | con QR |
| Pedidos, reservas | ✅ | ✅ | reservar no consume |
| Albaranes (PDF) | ✅ | ✅ | una página, sin efecto en el pedido |
| Reparto y entrega por QR | ✅ | ✅ | la tarjeta es la llave |
| Compras y proveedores | ✅ | ✅ | pedir ≠ tener |

---

## 7 · EL RESUMEN EN UNA TABLA

| Eslabón | Estado |
|---|---|
| MP → Lote | 🟢 Hecho |
| Lote → Producción | 🟢 Hecho |
| Producción → PT | 🟢 Hecho |
| PT → Pedido | 🟢 Hecho |
| Pedido → Preparación | 🟢 Hecho |
| Preparación → Reparto | 🟢 Hecho |
| Reparto → Entrega | 🟢 Hecho |
| **Entrega → Pago** | 🔴 **Falta entero** |
| **Pago → Caja** | 🔴 **Falta entero** |
| **Portal del cliente** | 🔴 **Falta entero** |
| **Comercial** | 🟡 Esquema, nada de sistema |
| **Trazabilidad de cambios** (no de acciones) | 🟡 La tabla existe, no se usa |
| **Métodos de pago (Orange Money…)** | ⚪ Verde, ni una línea |
| **Auditoría de caja** | ⚪ Verde, no existe el objeto |

---

## 8 · LO QUE EL MAPA DICE DEL ORDEN

**No hace falta un salto para cerrar el circuito.** El circuito se cierra
añadiendo **lo que ya falta**, no reconstruyendo lo que ya está:

1. **Cobros** — cierra el eslabón 8. El pedido ya tiene su importe; solo falta
   registrar que se pagó y por qué método.
2. **Caja** — cierra el eslabón 9. Y es lo que hace auditable el dinero: quién
   cobró, quién recibió, cuánto faltaba.
3. **Portal del cliente** — hace el circuito visible desde fuera.
4. **Comercial** — cierra el hilo Cliente → Comercial → Venta → Cobro, que las
   columnas ya soportan.

**Cobros y Caja juntos son una fase, no dos.** Separarlas deja el sistema en el
peor sitio posible: se sabe que alguien pagó pero no se sabe dónde está el
dinero, que es exactamente el «sistema que luego hay que cuadrar a mano» que se
quiere evitar.

Y el orden importa por una razón concreta: **Comercial sin Cobros es un CRM a
medias** (no se puede medir lo que se generó), y **Caja sin Cobros es una
cajita sin origen**.

---

## 9 · LO QUE HAY QUE DECIDIR ANTES DE PROGRAMAR

Ninguna de estas se puede responder mirando el código.

1. **¿Quién cobra?** Hoy la entrega la confirma el repartidor. Si el repartidor
   también cobra, su usuario necesita un permiso de cobro que hoy no existe.
2. **¿Caja es una persona o un turno?** El documento dice «personas de caja con
   usuarios individuales». Eso implica roles nuevos y una sesión de caja con
   apertura y cierre.
3. **¿Orange Money tiene integración oficial disponible aquí?** Hay que
   investigarlo antes de diseñar. Si no la hay, el comprobante queda
   «pendiente de verificación» y eso **tiene que ser una regla del sistema, no
   una buena intención**.
4. **El portal del cliente, ¿público o con clave?** Cambia el modelo entero.
5. **Comercial: ¿objetivos por importe, por visitas o ambos?** Y las zonas, ¿de
   reparto o de captación?
