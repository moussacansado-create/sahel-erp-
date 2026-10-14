# CleanSahel ERP — Arquitectura y modelo de datos
**Versión 1.0 · Fase 0**

Aplicación nueva, construida desde cero. No comparte código, base de datos ni
lógica con la aplicación anterior, que permanece intacta como respaldo y
referencia funcional.

---

## 1. Por qué esta arquitectura

La aplicación anterior falló por una razón concreta y repetida: **el mismo dato
físico estaba en varios sitios y cada operación actualizaba solo algunos.**

- El stock de materia prima vivía en `raw_materials.stock` (lo que veían las
  pantallas) y en `raw_material_lots.remaining` (lo que veía la fábrica).
  Fabricar descendía el segundo y nunca el primero.
- Existían dos flujos de producción que eran exactamente el reverso del otro:
  uno tocaba el total, el otro los lotes. Ninguno tocaba los dos.
- `orders.items_json` guardaba las líneas como texto, así que no se podía
  relacionar un pedido con los lotes que salieron de él. La trazabilidad hacia
  delante no era un bug: era imposible con ese modelo.

Aquí se resuelve en la estructura, no en el código:

| Decisión | Cómo elimina el problema |
|---|---|
| **Un solo catálogo (`items`)** | Materias primas, envases y productos terminados son filas de la misma tabla con un `category_kind`. No puede haber una cuarta tabla con stock. |
| **El stock vive en el lote, y solo en el lote** | Un lote es la unidad con cantidad y caducidad. `items` **no tiene columna de stock**. El stock es siempre `SUM(lots.qty_available)`. |
| **Un único libro mayor (`stock_movements`)** | Ninguna operación escribe existencias directamente. Todas pasan por una única función transaccional. Si mañana hay un auditor nuevo, el balance se reconstruye desde el libro. |
| **Reservar ≠ consumir** | Un pedido confirmado crea *reservas*. El stock baja **una sola vez**, al entregar. Cancelar libera la reserva sin tocar el stock porque el stock nunca se tocó. |
| **Líneas de pedido y de receta son tablas** | `sales_order_lines`, `recipe_lines`, `purchase_lines`, `delivery_lines`. Se pueden relacionar por SQL, que es lo que hace posible la trazabilidad. |
| **Permisos en el backend** | Un middlewareobligatorio en cada ruta. Ocultar un botón es cortesía; impedir la operación es la garantía. |

---

## 2. El principio de una sola fuente de verdad, en公式

```
Existencia de un artículo = SUM(lots.qty_available)
                            donde lots.item_id = artículo
                            y   lots.status IN ('ACTIVE')

Reservado   = SUM(order_reservations.qty)  con status = 'ACTIVE'
Disponible  = Existencia − Reservado
```

Ni una pantalla, ni un informe, ni una decisión de producción calcula el stock
de otra forma. Las tres cosas leen la misma suma, o una vista que la calcula.

---

## 3. Entidades

### 3.1 Identidad y acceso

| Tabla | Para qué | Notas |
|---|---|---|
| `users` | Personas | `password_hash` (bcrypt/argon2), `locked_until`, `failed_attempts`, `must_change_password` |
| `roles` | Catálogo de roles | Filas, no enum: se pueden añadir sin migrar |
| `permissions` | Acción atómica | `module` + `action` |
| `role_permissions` | Qué puede cada rol | Allows y denys explícitos |
| `user_roles` | Asignación | Un usuario puede tener varios |
| `sessions` | Refresh tokens | Hash en BD, nunca el token |
| `login_attempts` | Auditoría de accesos | Detecta fuerza bruta |

### 3.2 Organización territorial

| Tabla | Para qué |
|---|---|
| `zones` | Región → zona → sector. Jerárquica con `parent_id`. Configurable, no codificada. |
| `sales_routes` | Ruta comercial, pertenece a una zona |
| `machines` | Máquina o línea de producción |

### 3.3 Catálogo (núcleo)

| Tabla | Para qué |
|---|---|
| `units` | Unidad de medida. `dimension` ∈ VOLUME, MASS, COUNT. `base_factor` para conversión. |
| `item_categories` | Categorías por tipo de artículo |
| `items` | **Maestro único**: materia prima, envase o producto terminado según `category_kind` |
| `suppliers` | Proveedores |
| `customers` | Clientes, con zona, comercial asignado y `qr_token` |

> `items` **no tiene columna `stock`**. Esa es la garantía estructural de que no
> puede existir un segundo lugar donde alguien escriba existencias.

### 3.4 Lotes y existencias (núcleo)

| Tabla | Para qué |
|---|---|
| `lots` | Unidad con cantidad, caducidad y estado. `qty_available` es la existencia. |
| `stock_movements` | **Libro mayor.** Toda variación de existencias, con origen, usuario y saldo posterior. |

`stock_movements` es append-only y cubre: `RECEPTION`, `PURCHASE_RECEPTION`,
`PRODUCTION_OUTPUT`, `PRODUCTION_CONSUMPTION`, `SALE`, `DELIVERY`,
`DELIVERY_REVERSAL`, `ADJUSTMENT`, `WASTE`, `TRANSFER`, `RECALL_WITHDRAW`.

### 3.5 Compras

`purchase_orders`, `purchase_lines`, `supplier_invoices`.
Recibir una compra **crea el lote y el movimiento en la misma transacción**.

### 3.6 Recetas y producción

| Tabla | Para qué |
|---|---|
| `recipes` | Cabecera: producto, lote base, versión, activa |
| `recipe_lines` | Componentes con cantidad por lote base |
| `productions` | Cabecera:理论, real, merma, máquina, operario, estado |
| `production_materials` | **Qué lote concreto se consumió y cuánto** → es la trazabilidad |

> El escalado es una sola fórmula: `necesario = cantidad_línea × (producción ÷
> cantidad_base)`. 500 L, 1.000 L, 5.000 L, 10.000 L o 15.000 L salen de la
> misma receta, sin duplicarla.

### 3.7 Ventas y entregas

| Tabla | Para qué |
|---|---|
| `sales_orders` | Cabecera con estados y totales |
| `sales_order_lines` | Productos, precios, impuestos |
| `order_reservations` | **Reservas**: Separate from stock movement |
| `deliveries` | Entrega, repartidor, hora, GPS, incidencias |
| `delivery_lines` | Qué lote salió en qué línea |
| `incidents` | Incidencias de entrega |

### 3.8 Comercial

`visits`, `leads`, `commercial_targets`.

### 3.9 Trazabilidad, calidad y soporte

`recalls`, `recall_affected_customers`, `alerts`, `audit_log`, `app_config`,
`currencies`.

---

## 4. Estados

### 4.1 Lote

```
ACTIVE ──────► BLOCKED ──────► ACTIVE        (bloqueo reversible)
   │
   ├──► QUARANTINE ──► ACTIVE | RETIRED
   │
   ├──► EXHAUSTED          (automático al llegar qty_available a 0)
   ├──► EXPIRED            (automático por fecha, o al consultarlo)
   └──► RETIRED            (por retirada: no vendible, no entregable)
```

Transiciones permitidas, en el backend y en un `trigger` de base de datos.

### 4.2 Pedido

```
DRAFT ──► CONFIRMED ──► RESERVED ──► PREPARED ──► IN_ROUTE ──► DELIVERED
  │           │                                                      │
  └──► CANCELLED ◄──────────────────────────────────────────────────┘
          │                                                          │
          └──────► RETURNED ◄─────────────────────────────────────────┘
```

- **Confirmar** valida disponibilidad y crea reservas. No toca existencias.
- **Preparar / en ruta** no toca existencias.
- **Entregar** consume las reservas, descuenta existencias **una vez** y
  registra los lotes concretos que salieron.
- **Cancelar** libera reservas. No toca existencias porque nunca se tocaron.
- **Devolver** crea entradas nuevas de stock con motivo.

### 4.3 Producción

```
DRAFT ──► PLANNED ──► IN_PROGRESS ──► COMPLETED
  │                       │
  └──► CANCELLED          └──► ABORTED   (revierte todo: nada queda a medias)
```

### 4.4 Compra y entrega

`DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED → CLOSED`
`PENDING → ASSIGNED → PICKED_UP → DELIVERED`, con `FAILED` e `RETURNED`.

---

## 5. Permisos

### 5.1 Módulos

`dashboard`, `raw_materials`, `packaging`, `products`, `recipes`, `lots`,
`production`, `inventory`, `orders`, `customers`, `deliveries`, `commercial`,
`sales`, `purchases`, `suppliers`, `expenses`, `traceability`, `recalls`,
`history`, `alerts`, `users`, `permissions`, `reports`, `zones`, `settings`.

### 5.2 Acciones

`view`, `create`, `edit`, `delete`, `approve`, `export`.

### 5.3 Roles de partida

| Rol | Puede | No puede |
|---|---|---|
| **ADMIN** | Todo | — |
| **PRODUCTION** | MP, envases, lotes, recetas, producción, inventario | Ventas, compras, usuarios, ajustes financieros |
| **ACCOUNTING** | Ventas, compras, gastos, informes, inventario (ver) | Producción, recetas, borrar compras |
| **DELIVERY** | Sus entregas, escáner QR, clientes asignados | Fabricar, recetas, compras, stock arbitrario |
| **COMMERCIAL** | Clientes asignados y potenciales, visitas, pedidos, ventas | Recetas, producción, compras, stock |

### 5.4 Cómo se aplican

Middleware obligatorio, `fail-closed`:

1. Sin token válido → **401**
2. Con token pero sin permiso para el módulo/acción → **403**
3. El botón se oculta en la interfaz por comodidad; **la garantía está aquí**

Reglas de alcance que van más allá del permiso:

- Un repartidor solo ve pedidos de los que es responsable o de su ruta.
- Un comercial solo ve sus clientes asignados y los potenciales de su zona.
- Nadie puede saltarse una regla de negocio con un endpoint directo.

---

## 6. Reglas de negocio que el sistema garantiza

Estas reglas están en el código **y** en el esquema, con `CHECK`, `UNIQUE`,
`FOREIGN KEY` y `trigger`. No dependen de que alguien se acuerde.

| # | Regla | Dónde se garantiza |
|---|---|---|
| R1 | Un movimiento de stock solo existe dentro de una transacción | `postMovement()` es la única vía |
| R2 | `lots.qty_available` nunca baja de 0 | `CHECK (qty_available >= 0)` |
| R3 | Un lote agotado cambia a `EXHAUSTED` solo | `trigger` |
| R4 | Un lote `RETIRED` o `QUARANTINE` no se puede consumir ni vender | Comprobación en `postMovement` + trigger |
| R5 | Entregar descuenta existencias **exactamente una vez** | La reserva se marca `CONSUMED`; el movimiento solo se crea si no lo estaba |
| R6 | Cancelar un pedido no altera existencias | Reservas a `RELEASED`, sin movimiento |
| R7 | El lote de producto terminado se crea en la misma transacción que el consumo | `productions` completo o `rollback` |
| R8 | Todo lote tiene código único y trazable a su origen | `lots.code UNIQUE` + `origin_type/origin_id` |
| R9 | FEFO ordena por caducidad, no por inserción | `ORDER BY expiry_date NULLS LAST, received_at` |
| R10 | `audit_log` no se puede modificar ni borrar | Sin permisos de UPDATE/DELETE para la aplicación |
| R11 | Un usuario desactivado no puede autenticarse | `is_active = false` → 401 |
| R12 | Los importes los calcula el servidor | El cliente nunca envía totales |

---

## 7. Flujos completos

### 7.1 Compra → Materia prima → Lote → Producción → Producto

```
1. purchase_order DRAFT → ORDERED
2. Recibir línea  →  postMovement(RECEPTION)
                     → crea lot (tipo del artículo, proveedor, factura, caducidad)
                     → actualiza qty_available
3. Fabricar (una transacción):
   a. Validar receta activa del producto
   b. Calcular necesidad: línea × (producción ÷ cantidad_base)
   c. FEFO: elegir lotes con qty_available > 0, por caducidad
   d. Si falta material → ROLLBACK completo
   e. Por cada material: postMovement(PRODUCTION_CONSUMPTION) + production_materials
   f. Crear lot FINISHED del producto terminado con el código PT-AAAA-NNNN
   g. postMovement(PRODUCTION_OUTPUT) → suma existencias del producto
   h. Registrar merma (PRODUCTION_WASTE) si la real < la teórica
   i. Marcar producción COMPLETED con cantidad real
4. Queda la cadena completa:
   MP-0001 → FAB-0015 → PT-2026-0015 → (futuro) PED-0120 → cliente
```

### 7.2 Venta → Pedido → Entrega → Cliente

```
1. Crear pedido DRAFT con sus líneas (el servidor calcula importes)
2. CONFIRMED: comprobar disponibilidad, crear order_reservations (ACTIVE)
   → NO se toca el stock
3. PREPARED / IN_ROUTE: se eligen lotes concretos, se imprinted
4. DELIVERED (una transacción):
   a. Por cada línea: postMovement(DELIVERY) sobre los lotes reservados
   b. Marcar reservas CONSUMED
   c. Crear delivery + delivery_lines con el lote que salió
   d. Pedido → DELIVERED
   e. Al cliente se le suma el consumo; al comercial, su venta
5. CANCELLED: reservas → RELEASED. El stock nunca se había tocado.
```

### 7.3 Retirada de un lote

```
1. Crear recall sobre un lote
2. El lote → QUARANTINE
3. Sistema recorre: lotes que lo consumieron → producciones → pedidos →
   entregas → clientes. Guarda el alcance en recall_affected_customers.
4. Alerta a responsables
5. Resolver: RETIRED (definitivo) o devolver a ACTIVE (falso positivo)
```

---

## 8. Auditoría

`audit_log` registra **toda** operación que cambia datos, no solo las sensibles.
Captura quién, qué, cuándo, qué cambió (antes y después), desde dónde y con qué
resultado.

Es **append-only**: la aplicación no tiene ningún camino de código para
actualizarlo o borrarlo, y el rol de base de datos usado por la aplicación no
tiene permiso para hacerlo.

---

## 9. Seguridad desde el primer día

- Contraseñas con **argon2id** (parámetros calibrados en el servidor).
- **Ninguna credencial en el repositorio.** Todo secreto, en variables de entorno.
- La aplicación **no arranca** si falta una variable obligatoria.
- `JWT_SECRET` sin valor por defecto. Se puede además fijar `JWT_ALGORITHM` y
  issuer/audience verificados.
- Sesiones con refresh token **hasheado** en base de datos, revocable.
- Bloqueo por intentos fallidos.
- Cabeceras de seguridad, CORS restrictivo con lista blanca, límite de tasa en
  autenticación.
- **Todas** las consultas parametrizadas. El lint prohibido `string` en SQL.
- Sin endpoints que devuelvan datos sin comprobar permiso.

---

## 10. Multiidioma y moneda

- Textos de la interfaz en recursos (`es`, `fr`), no incrustados en el código.
- `currencies` con tipo de cambio a una moneda base. EUR y XOF de origen.
- Unidades y zonas configurables, adaptadas a Mali.

---

## 11. Estructura del proyecto

```
cleansahel-v2/
  db/
    migrations/        SQL versionado, solo hacia adelante
    seeds/             Datos mínimos: roles, permisos, unidades
  server/
    src/
      config/          Variables de entorno, validadas al arrancar
      db/              Cliente, migrador, transacción
      security/        Hash, tokens, sesiones, permisos
      core/            Libro mayor, FEFO, códigos, auditoría
      modules/         Un módulo por dominio, con sus rutas y servicios
      audit/
    tests/
  client/
  docs/
```

Reglas de los módulos: cada uno expone sus rutas y llama a los servicios de
`core/`. **Ningún módulo escribe existencias directamente.** Si una pantalla
necesita una cantidad, pide el servicio que la calcula.

---

## 12. Qué decide la Fase 0

✅ Catálogo único en vez de tres tablas con stock
✅ Stock solo en lotes, derivado por vista
✅ Un único libro mayor para todo movimiento
✅ Reservas separadas del consumo → no hay doble descuento
✅ Líneas relacionales en vez de JSON
✅ Lote de producto creado en la misma transacción que su consumo
✅ Auditoría append-only
✅ Permisos fail-closed en backend
✅ FEFO de verdad, visible para el operario
