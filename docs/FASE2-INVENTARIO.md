# Fase 2 · Catálogo e inventario

Estado: **completa y probada** · 140 pruebas propias, 291 acumuladas.

---

## 1. Qué resuelve

La aplicación antigua tenía **tres fuentes de stock** que se contradecían entre
sí. La UI decía una cosa y el motor de producción otra: «hay 500 litros», y a la
hora de fabricar, `shortages`. La causa no era un bug de lógica sino de datos:
`raw_materials.stock` (un escalar) y `raw_material_lots.remaining` (vacía) eran
dos verdades sobre lo mismo, y cada módulo leía una.

Aquí hay **una sola**:

| Qué | Dónde vive |
|---|---|
| Qué artículos existen | `items` (una tabla, tres `category_kind`) |
| Cuánto hay de cada cosa | `lots.qty_available` |
| Por qué ha cambiado | `stock_movements` (libro mayor, append-only) |
| Cuánto está apartado | `order_reservations` |
| Cómo se ve desde fuera | `v_item_available` |

`items` **no tiene columna de stock**. Hay una prueba que lo comprueba
consultando `information_schema`, para que nadie añada una «por comodidad» sin
darse cuenta de que acaba creando la tercera fuente.

---

## 2. El modelo, en una frase

> Un artículo es un catálogo. Un lote es una cantidad con fecha y origen. El
> stock es la suma de los lotes utilizables. Cualquier variación es un
> movimiento, y todo movimiento dice quién lo hizo, por qué y cuánto quedaba
> después.

---

## 3. Una decisión que cambió durante la fase

**Recibir mercancía no es crear la ficha del artículo.**

La primera versión exigía `raw_materials:create` para registrar una entrada.
Estaba mal por dos razones: el almacén no tenía ese permiso y no podía recibir;
y cualquiera con permiso de catálogo podía inventarse recepciones que nadie vio.

Ahora la entrada exige `inventory:create` (acto de almacén) y la ficha exige el
permiso del módulo que le toca (acto de ingeniería).

De paso, un comercial ya no puede crear productos: los ve y exporta la tarifa,
pero no decide qué se fabrica ni a qué precio se vende.

---

## 4. La regla crítica, verificada paso a paso

| Paso | Operación | Stock |
|---|---|---|
| 0 | — | 0 |
| 1 | Entrada de 500 L (albarán ALB-001) | **500** |
| 2 | Entrada posterior de 50 L | **550** |
| 3 | Ajuste `+10` (recuento físico) | **560** |
| 4 | Ajuste `-20` (merma) | **540** |
| 5 | Intento de retirar 600 | **540** ✗ rechazado |

El intento de retirar 600 se comprueba por cuatro vías independientes: la API
sigue diciendo 540, la vista PostgreSQL dice 540, no se creó ningún movimiento
nuevo, y el saldo del último movimiento real sigue cuadrando con su lote.

---

## 5. Reservar no es consumir

Tres números, tres significados:

```
físico  = hay en el almacén
reservado = apartado, sigue en el almacén
disponible = físico − reservado
```

Apartar 200 sobre 540 deja 540 físicos, 200 reservados y 340 disponibles. No
aparece ningún movimiento, porque no se ha movido nada.

**Retenciones internas.** Una orden de producción, una muestra de laboratorio o
un control de calidad necesitan apartar stock, pero no son un pedido de venta.
La primera versión fabricaba un pedido falso colgado del primer cliente de la
tabla — datos de negocio falsos en la base, que es justo lo que este proyecto no
admite, y ensuciaba el histórico de ventas con líneas de precio cero.

La migración `008_retenciones.sql` permite la misma tabla con dos orígenes: con
pedido (la willa) o sin pedido pero con motivo obligatorio. Hay una prueba que
comprueba que apartar stock **no crea ningún pedido**.

---

## 6. Un ajuste se reparte entre lotes

La primera versión aplicaba el ajuste entero sobre el primer lote FEFO. Con
tres lotes, una salida de 100 fallaba aunque hubiera 640 en total, porque el
primero tenía 90. Y dejaba intacto el lote que caduca antes, que es justo al
revés de como se consume un almacén.

Ahora el ajuste se reparte por FEFO y genera **un movimiento por lote tocado**,
para que el libro mayor pueda explicar de dónde salió cada unidad. Los lotes se
bloquean siempre en el mismo orden: si dos salidas los cogieran en orden
distinto, cada una esperaría al lote que la otra tiene, y deadlock.

---

## 7. Las garantías viven en PostgreSQL

La aplicación valida, pero la base también. Verificado con SQL directo, saltando
la aplicación por completo:

| Intento | Resultado |
|---|---|
| `UPDATE lots SET qty_available = -5` | rechazado (23514) |
| Consumir más de lo recibido | rechazado (23514) |
| Retención interna sin motivo | rechazado (23514) |
| Modificar una línea de auditoría | rechazado (23001) |
| Borrar una línea de auditoría | rechazado (23001) |

`audit_log` es append-only por trigger. Nadie lo corrige ni lo borra, ni
siquiera por SQL.

---

## 8. Concurrencia

`FOR UPDATE` sobre cada lote tocado, siempre en el mismo orden. Con 10 salidas
simultáneas de 100 sobre 640 unidades:

```
6 salidas aceptadas · 4 rechazadas con el motivo · saldo final 40 · nunca negativo
```

Y el libro mayor cuadra exactamente con la suma de los lotes, sin doble conteo.

> **Limitación conocida:** la concurrencia se prueba sobre PGlite, que es una
> sola conexión y serializa internamente. El `FOR UPDATE` está bien escrito y la
> lógica es la correcta, pero **falta una prueba contra un PostgreSQL de servidor
> con conexiones reales** antes de dar esto por cerrado en producción. Queda
> anotado como pendiente de Fase 10.

---

## 9. Errores encontrados y corregidos en esta fase

Ocho, de los cuales cuatro eran fallos de verdad que habrían llegado a
producción:

1. **`tx.exec()` no acepta parámetros.** Los candados `pg_advisory_xact_lock`
   se pasaban con el prefijo, y la consulta fallaba al pedir un parámetro que no
   había llegado. Toda generación de código estaba rota.
2. **`created_by` nulo en todas las recepciones.** `crearLoteConEntrada` espera
   `usuarioId` y se le pasaba `userId`. El libro mayor no sabía quién recibía.
3. **`registrarEntrada` mezclaba español e inglés.** Daba
   `ReferenceError: originId is not defined` en cuanto se creaba un lote. Ahora
   los nombres se normalizan en un único punto, al principio de la función.
4. **`planificar(tx, itemId, …)` con los argumentos desordenados.** Rompía todos
   los ajustes sin lote indicado.
5. **Rutas estáticas detrás de las parametrizadas.** `/inventory/reservas` caía
   dentro de `/inventory/:itemId` y devolvía 404.
6. **Permisos aplicados como callback anidado.** Un error dentro del callback
   escapaba al manejador y tumbaba el proceso. Ahora van encadenados.
7. **`reservarInterno` con pedido falso.** Descrito en el punto 5.
8. **Duplicados que devolvían 500 en vez de 409.** El `UNIQUE` de PostgreSQL
   se traducía a un error interno genérico.

---

## 10. Endpoints

| Método | Ruta | Permiso |
|---|---|---|
| `POST` | `/api/inventory/recepciones` | `inventory:create` |
| `POST` | `/api/inventory/recepciones/masivas` | `inventory:create` |
| `POST` | `/api/inventory/ajustes` | `inventory:edit` |
| `POST` | `/api/inventory/reservas` | `inventory:edit` |
| `POST` | `/api/inventory/reservas/:id/liberar` | `inventory:edit` |
| `GET` | `/api/inventory` · `/resumen` · `/:itemId` · `/:itemId/plan` | `inventory:view` |
| `GET` | `/api/inventory/reservas` · `/movimientos` | `inventory:view` |
| `GET` | `/api/items/:itemId/lots` | `lots:view` |
| `GET` | `/api/lots/:id/movimientos` | `lots:view` |
| `PUT` | `/api/lots/:id/estado` | `lots:edit` |
| `GET/POST/PUT/DELETE` | `/api/items` | según `category_kind` |

Una entrada de albarán con varias líneas es **una sola transacción**: si la
línea 7 de 20 falla, no queda el lote de la línea 1 por el camino. Y el error
dice cuál falló.

---

## 11. Lo que queda

- [ ] Frontend mínimo real conectado a esta API.
- [ ] Prueba de concurrencia contra PostgreSQL de servidor.
- [ ] Fase 3: producción, recetas y consumo por FEFO (ya tiene las piezas:
      `planificarFefo`, `v_production_cost`).
