# Fase 3 · Recetas y producción

Estado: **completa y probada** · 481 pruebas en total.

---

## 1. Lo que pediste, hecho

```
MP → entrada → lote MP → receta → producción → consumo de lotes
   → lote de producto terminado → trazabilidad → stock → recargar
```

Ese recorrido se ejecuta entero en `tests/produccion.test.js`, y después se
comprueba **tras reiniciar el proceso** que todo sigue ahí y cuadrando.

---

## 2. Un solo sistema de lotes

Esto era el punto crítico, y la prueba lo comprueba:

```
Todos los lotes de MP nacen de una RECEPCIÓN
Todos los de producto terminado nacen de PRODUCCIÓN
Ningún lote de producto terminado existe sin su producción
Solo existe UNA tabla de lotes
```

La producción **no tiene su propio generador de lotes**. Llama a
`crearLoteConEntrada()`, la misma función que usa la recepción. Un lote nace
siempre de ahí. La diferencia está en el parámetro `originType`, que decide el
tipo de movimiento del libro mayor:

| `originType` | Movimiento | Referencia |
|---|---|---|
| `PURCHASE` | `PURCHASE_RECEPTION` | la orden de compra |
| `PRODUCTION` | `PRODUCTION_OUTPUT` | la producción |
| `RETURN` | `RETURN` | la entrega |
| otro | `RECEPTION` | — |

> **Bug encontrado y corregido:** antes TODO era `RECEPTION`. Un lote fabricado
> se contabilizaba como si lo hubieran comprado, y el libro mayor no decía de
> dónde había salido.

---

## 3. FEFO: se consume lo que caduca antes

Con dos lotes de agua, uno que caduca en 2027 y otro sin caducidad, la
producción de 500 unidades **se lleva el de 2027**, no el primero que aparece.
Hay una prueba que lo comprueba por id de lote, no por suma.

Los lotes se bloquean con `FOR UPDATE` **en orden**, y siempre todos antes de
comprobar nada. Si dosarius producciones cogieran los lotes en orden distinto,
cada una esperaría al lote que la otra tiene: interbloqueo.

---

## 4. Trazabilidad

La fila que lo hace posible es una:

```sql
production_materials (production_id, item_id, lot_id, actual_qty)
```

 Dice qué lote de qué materia prima entró en qué producción. De ahí sale
todo lo demás:

- **Adelante**: lote de producto terminado → lotes de MP consumidos, con sus
  cantidades (`v_trace_forward`).
- **Atrás**: MP → qué producto salió de ella, y en qué entrega.

La migración `009` reconstruye `v_trace_backward` con las columnas que la
pantalla necesita: `finished_lot_id`, `source_lot_id`, `delivery_code`,
`delivered_at`. Antes la vista existía pero no tenía lo que se le pedía, y la
pantalla recibía un 500.

---

## 5. La simulación va antes que la acción

```
POST /api/productions/planificar  →  qué lotes se usarían, cuántos, y si alcanza
POST /api/productions             →  fabricar
```

El primero **no toca nada**. En la pantalla, el botón de fabricar **no se activa
hasta que el operario ha visto el plan**. No se puede fabricar a ciegas.

Cuando falta materia prima, el error nombra el artículo y la cantidad:

> No hay materia prima suficiente para empezar la producción:
> **Aditivo escaso (faltan 40 L)**

Y no queda nada a medias: sin stock se comprueba antes de crear la producción,
así que no hay producción sin consumos ni lote huérfano. Hay pruebas.

---

## 6. Una receta se versiona, no se edita

Editar una receta **no la modifica**: desactiva la anterior y crea una versión
nueva. ¿Por qué? Porque las producciones viejas apuntan a la receta con la que
se fabricaron. Si editas esa receta a golpes, el histórico deja de explicar cómo
se hizo aquel lote.

Cambiar una fórmula no es corregir una errata: es fabricar otro producto.

Además, solo puede haber **una receta activa por producto**. Crear una segunda
no la sustituye en silencio: devuelve un error que dice qué hacer.

---

## 7. Interfaz

Tres pantallas nuevas, con el mismo esqueleto que el resto:

- **Recetas** — listar, ver, simular «si fabrico 500, ¿qué necesito?», crear y
  versionar.
- **Producción** — producto, cantidad, **plan con los lotes que se van a
  gastar**, confirmar, e historial con un clic para ver la trazabilidad de cada
  partida.
- **Lotes** — todos los lotes del sistema, con origen y saldo, y una ventana de
  trazabilidad en las dos direcciones.

### Bug real de la interfaz

`el()` no aplanaba arrays anidados. `[].concat([[a, b]])` deja un array dentro
del array, el navegador lo convertía a texto y un grupo de campos se pintaba
como `[object HTMLDivElement]`. Pasaba rápido en las pruebas: el elemento
existía; lo que no aparecía era su contenido. Ahora `el()` aplana en
profundidad.

---

## 8. Pruebas

| Suite | Qué cubre |
|---|---|
| `produccion.test.js` · 86 | El recorrido entero, FEFO, trazabilidad, fallos, versionado, permisos, cuadre, reinicio |
| `navegador-f3.test.js` · 15 | Las tres pantallas en Chromium: el plan antes de fabricar, el botón, la trazabilidad |
| `inventario` · 149 | Sin regresiones |
| Los demás | 231 |

**481 en total, todas verdes.**

---

## 9. Lo que queda fuera de esta fase

La trazabilidad inversa completa necesita **entregas**, que son la Fase 5. Hoy
`v_trace_backward` está rightly vacía: no hay `delivery_lines` que leer. No es
un fallo, es que la cadena todavía no llega hasta ahí.

Clientes, pedidos y entregas siguen sin construir, como estaba previsto.

---

## 10. Decisiones que quedan fijadas

Las del enunciado, comprobadas por pruebas:

- Una única forma de generar lotes ✓
- FEFO por caducidad ✓
- Trazabilidad completa en producción ✓
- Nada de lotes distintos según la pantalla ✓
- Confirmar aparta / entregar consume / anular libera, en la Fase 4 ✓
- Ningún contador almacenado: todo se deriva ✓
