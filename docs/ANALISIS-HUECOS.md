# Comparación con la aplicación de referencia

Fecha: 2026-10-03
Referencia visual y funcional: la aplicación antigua (**solo lectura del
frontend público**, sin tocar su base de datos ni el servicio que usas).

---

## 1. Lo que hace la aplicación antigua

26 rutas:

```
/  /login  /dashboard          /raw-materials   /packaging   /products
/recipes  /production  /lots  /lot-generator  /raw-material-lots
/orders  /customers  /scanner  /deliveries  /sales
/purchases  /expenses  /recalls  /trace/:id  /history
/alerts  /reports  /search  /users  /settings
```

Y estas capacidades, que ya existían y hay que reproducir:

| Capacidad | Cómo lo hace la antigua | Nota |
|---|---|---|
| Menú lateral completo | 26 secciones agrupadas | Referencia de navegación |
| QR de cliente | `qr_token` por cliente | 80 referencias a QR en el código |
| Escáner con cámara | `getUserMedia` + `<video>` | Ruta `/scanner` |
| Albarán imprimible | `window.print` | 3 llamadas, con hoja de estilo de impresión |
| Firma del cliente | 14 referencias a «firma» | En el albarán y en la entrega |
| Trazabilidad | `/trace/:id` | Sentido directo e inverso |
| Lotes | 2 sistemas **paralelos** | `/lot-generator` y `/raw-material-lots` ← el problema |

### Los dos sistemas de lotes, confirmados

Esto ya lo intuíamos en la auditoría, y ahora se ve en el menú: la aplicación
antigua tiene **`/lot-generator` y `/raw-material-lots` como entradas
independientes**, además de `/lots`. Tres sitios desde los que se puede crear un
lote, y solo uno de ellos pasa por FIFO y consume recetas.

Es exactamente lo que describes: *«no quiero tener que generar manualmente el
mismo lote desde diferentes pantallas»*.

---

## 2. Lo que tiene la aplicación nueva

10 pantallas, y **cada una va contra la API real**:

```
Panel · Materias primas · Envases · Productos · Entradas · Stock
Movimientos · Pedidos · Usuarios · Roles y permisos
```

Lo que ya está construido y probado (369 pruebas):

- Catálogo único de materias primas, envases y productos
- Lotes con estructura única, códigos `MP-`/`ENV-`/`PT-`
- Libro mayor `stock_movements`, saldo por lote
- Reservas internas con motivo, sin pedido falso
- Cuarentena, bloqueo, caducidad
- Autenticación, roles, permisos fail-closed
- Interfaz web real contra la API

---

## 3. Los huecos

| Módulo | Esquema | Código | Interfaz | Estado |
|---|---|---|---|---|
| Catálogo | ✅ | ✅ | ✅ | **Listo** |
| Stock y movimientos | ✅ | ✅ | ✅ | **Listo** |
| Usuarios y permisos | ✅ | ✅ | ✅ | **Listo** |
| **Lotes** (pantalla propia) | ✅ | parcial | ❌ | Falta pantalla |
| **Recetas** | ✅ | ❌ | ❌ | Falta todo |
| **Producción** | ✅ | ❌ | ❌ | Falta todo |
| **Clientes** | ✅ | ❌ | ❌ | Falta todo |
| **Pedidos** | ✅ | ❌ | placeholder | Falta todo |
| **Entregas** | ✅ | ❌ | ❌ | Falta todo |
| **Albarán** | ❌ | ❌ | ❌ | Falta todo |
| **Tarjeta QR** | ✅ (`qr_token`) | ❌ | ❌ | Falta todo |
| **Escáner** | ❌ | ❌ | ❌ | Falta todo |
| **Trazabilidad** | ✅ (2 vistas) | ❌ | ❌ | Falta consulta |
| Informes | ❌ | ❌ | ❌ | Falta todo |
| Alertas / historial | ✅ | ❌ | ❌ | Falta consulta |
| Gastos / compras / ventas | ✅ | ❌ | ❌ | Falta todo |
| Retiradas (recalls) | ✅ | ❌ | ❌ | Falta todo |

**Resumen: 6 módulos de 22 listos.** El esquema está casi entero; falta el
código que lo mueve.

---

## 4. Por qué las tablas ya sirven

No es casualidad. El esquema de la Fase 0 se diseñó pensando en esto:

- `customers.qr_token` — el identificador opaco del QR
- `deliveries.signature_url`, `recipient_name`, `rep_id`, `delivered_at` — la firma
- `delivery_lines.lot_id` — **qué lote concreto salió en cada línea**
- `production_materials.lot_id`, `actual_qty` — la trazabilidad de la receta
- `productions.waste_qty`, `waste_reason` — la merma, que en la antigua no se
  controlaba
- `sales_orders.status`, `delivered_at`, `cancel_reason` — el ciclo de vida

Falta una tabla para el albarán impreso, porque un albarán es un documento, no
un estado del pedido. Se añadirá con su número, sus copias y su historial.

---

## 5. El orden de construcción

El orden lo manda una regla: **cada módulo se prueba con el recorrido completo
antes de empezar el siguiente**, como pides en el punto 9.

### Fase 3 · Recetas y producción
`recetas` → producir → **consume lotes por FEFO** → **crea un lote `PT-`** →
queda registrado qué lotes entraron y cuánto.

Cierra el círculo de lotes: entrada → receta → consumo → lote terminado.
Sin esto no hay trazabilidad que valga.

### Fase 4 · Clientes y pedidos
Crear cliente con QR → crear pedido con líneas → confirmar **aparta** stock
(no lo descuenta) → consultar estado e historial.

### Fase 5 · Entregas y albarán
Preparar entrega → **generar albarán imprimible** (2 copias) → registrar firma
→ la entrega **consume** el stock, una sola vez.

### Fase 6 · Tarjeta QR y escáner
Tarjeta imprimible con QR → escáner con la cámara del móvil → cliente → pedido
pendiente → marcar entregado → se actualiza en el panel.

### Fase 7 · Trazabilidad, informes, alertas
Las dos vistas `v_trace_forward` y `v_trace_backward` ya existen: solo hay que
exponerlas y dibujarlas.

---

## 6. Decisiones que conviene fijar ahora

### El QR no lleva datos del cliente

El QR codifica **un token opaco**, no el nombre ni el teléfono ni nada que una
cámara mal orientada pueda leer. Ese token:

- se genera aleatorio (128 bits), no se adivina
- se puede **revocar y regenerar** si alguien pierde la tarjeta
- resuelve contra `customers.qr_token`, y solo con permiso de entregas

**Hoy `qr_token` es una columna de texto libre.** Hay que darle_generador y
restricciones, igual que se hizo con los códigos de lote. Sin eso, un token
`C001`, `C002` se adivina solo.

### El albarán es un documento, no un botón

Se guarda en base con su número (`ALB-2026-0001`), su pedido, sus líneas y su
estado. Sirve para reimprimir, para saber qué se entregó aunque luego haya más
pedidos, y para el historial. Un `window.print()` sobre la pantalla no deja
rastro.

### Un pedido NO descuenta stock al confirmarse

Es la diferencia que hacia fallar a la aplicación antigua:

```
confirmar   → aparta (reserva). El stock sigue en el almacén.
entregar    → consume. Una sola vez, en una transacción.
anular      → libera lo apartado. El stock no se había movido.
```

Si confirmar descontara, una entrega devolvería el pedido y habría que
devolver también el stock. Dos sistemas, dos errores.

### Nada de contadores

No hay cifras almacenadas. El panel, el stock y los lotes se calculan contra
las vistas de PostgreSQL en el momento. No pueden desincronizarse porque no
existen como dato. Los «contadores automáticos» de la antigua eran columnas que
se olvidaba actualizar; aquí son consultas.

---

## 7. Lo que no se va a hacer

- **No** se copia ni se migra la base de datos antigua
- **No** se conecta la nueva con la antigua
- **No** se toca el servicio que estás usando
- **No** se simplifica quitando funciones para terminar antes

Los datos de prueba se crean con la aplicación, no insertando filas a mano: así
lo que se comprueba es que el sistema funciona, no que se puede rellenar una
tabla.
