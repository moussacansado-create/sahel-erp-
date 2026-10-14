# LAS 21 SECCIONES DEL PLAN ORIGINAL, UNA A UNA

> Fecha: 2026-10-04. Comprobación previa a empezar la Fase 1.
> Cada sección se ha verificado contra el esquema, el código y la interfaz.
> No se ha programado nada para producir este documento.

---

## EL VEREDICTO, ANTES DE NADA

**Las cinco fases que has confirmado cubren el circuito completo, pero NO
cubren el plan original entero.** Faltan cuatro secciones por completo y una
está a medio hacer.

| | |
|---|---|
| **17 secciones** | 🟢 **Completas** |
| **1 sección** | 🟡 **A medias** — §20 Centro de Lotes |
| **4 secciones** | 🔴 **Sin construir** — §15 Gastos · §16 Alertas · §19 Configuración · retiradas de lote |

Las cuatro rojas **caben enteras dentro de las fases que ya has aprobado** (se
detalla al final). Ninguna necesita una fase nueva.

---

## LAS 21, UNA A UNA

### 1 · DASHBOARD — 🟢 Completa
`web/js/paginas/panel.js`. Muestra producción, stock, MP, envases, PT, pedidos,
clientes y actividad, leídos de la base real. Los números se recalculan en cada
carga.
**Pendiente menor:** cuando se añadan alertas, el panel tiene que enseñarlas.

### 2 · MATERIAS PRIMAS — 🟢 Completa
`catalogo.js` + `entradas.js` + `inventario.js`. Crear, entradas, lotes,
cantidades, unidades, consumo, ajustes, caducidad, trazabilidad, historial.
Pruebas: 149 de inventario + 88 de producción.

### 3 · ENVASES Y PACKAGING — 🟢 Completa
Mismo módulo, `category_kind = 'PACKAGING'`. Misma lógica, mismos controles.

### 4 · PRODUCTOS TERMINADOS — 🟢 Completa
Stock real, mínimo, añadir, retirar, ajustes, lotes, caducidad, movimientos.
`v_item_available` es la única fuente de lectura.

### 5 · RECETAS — 🟢 Completa
`recetas.js`. Escalado de cantidades, conversiones, consumo calculado. Verificado
con 500 L, 1.000 L, 5.000 L, 10.000 L y 15.000 L en las pruebas.

### 6 · PRODUCCIÓN / FABRICACIÓN — 🟢 Completa
Producto, receta, cantidad, MP usadas, **lotes de MP concretos** (FEFO),
consumo real, mermas, lote PT, fechas, usuario, máquina.
- Planificar **no** consume. Confirmar **sí**.
- El lote PT se genera antes que el registro de producción, como pediste.

### 7 · TRAZABILIDAD — 🟡 A medias
**Lo que funciona:** la API está (`/trazabilidad/lote/:id/adelante` y `/atras`),
las vistas existen, y `lotes.js` las consume al abrir un lote.
**Lo que falta:** **no hay entrada propia en el menú**. Solo se llega desde la
ficha de un lote, y no se puede buscar una trazabilidad sin saber de antemano el
lote. Para una retirada, eso es insuficiente.
→ **Fase 4**

### 8 · LOTES — 🟢 Completa
`lotes.js`. Contadores calculados desde la base, no inventados. Crear un lote
lo hace aparecer al instante y **después de recargar** (hay prueba de eso).

### 9 · PEDIDOS — 🟢 Completa
Cliente vinculado, productos y cantidades reales, descuenta PT por lotes
concretos, guarda movimiento, aparece en historial, mantiene trazabilidad.
No se puede pedir más de lo que hay: hay prueba de sobre-reserva.

### 10 · CLIENTES — 🟢 Completa
CRUD, búsqueda, ficha, historial, QR, estado de pedidos, entregas. Códigos
`CL-#####`.

### 11 · ENTREGAS — 🟢 Completa (como está hoy)
Desde el QR: identificar cliente, ver pendientes, marcar entrega, registrar
fecha/hora, conservar historial. **La entrega la confirma la tarjeta, no el
albarán**, y el albarán es solo papel.
**Pendiente por diseño tuyo:** que además registre el **cobro**. → **Fase 1**

### 12 · BÚSQUEDA GLOBAL — 🟢 Completa
Busca en los módulos reales, no devuelve 500, no inventa resultados.

### 13 · INVENTARIO — 🟢 Completa
Una sola fuente de verdad. Entradas, salidas, producción, pedidos, ajustes,
consumo y lotes, todos sobre `stock_movements` + `lots.qty_available`.
Pruebas que verifican que **saldo del lote = cantidad del movimiento**.

### 14 · PROVEEDORES Y COMPRAS — 🟢 Completa
Proveedores, compras, entradas, costes, lotes, factura, historial, desviación de
precio. Recordatorio: **pedir no es tener**; solo recibir mete mercancía.

### 15 · GASTOS — 🔴 **Sin construir**
Tabla `expenses` (0 filas) y `expense_categories`. **Cero código**: ninguna
consulta SQL, ninguna ruta, ninguna pantalla.
Peor: la tabla tiene **`amount` y `paid` a la vez** — un interruptor de «pagado»
que nadie mantiene y que contradice el circuito único.
→ **Fase 1**, tal y como ya has decidido

### 16 · ALERTAS Y NOTIFICACIONES — 🔴 **Sin construir**
Tabla `alerts` (0 filas). **Cero código**.
**Consecuencia real:** el catálogo tiene `min_stock` y las tablas tienen
`expiry_date`, y **nadie avisa nunca de nada**. Un lote que caduca en silencio
es exactamente lo contrario de lo que pediste.
La matriz de permisos ya tiene el módulo `alerts`; lo que no hay son las reglas.
→ **Fase 1**

### 17 · HISTORIAL — 🟡 A medias
`audit_log` existe, funciona y es **append-only de verdad** (disparador
`trg_audit_no_update`). Registra quién, qué, cuándo, entidad e identificador.
**Lo que falta:** `before_data` y `after_data` existen y **nadie los escribe**.
Hoy registra qué pasó; no registra **qué cambió**.
→ **Fase 4**

### 18 · USUARIOS Y PERMISOS — 🟢 Completa, y crece en Fase 1
Matriz de 25 módulos × 5 roles × 6 acciones, editable y releíble. 150
permisos para ADMIN. 401 sin sesión, 403 sin permiso. Un usuario sin permiso no
pasa aunque el botón esté visible.
**Añadir en Fase 1:** 2 usuarios de caja, cada uno con su usuario, su
contraseña, sus permisos y su trazabilidad. Nada de cuenta compartida.

### 19 · CONFIGURACIÓN — 🔴 **Sin construir**
`app_config` existe y está poblada (empresa, IVA 21 %, moneda XOF), pero **no hay
pantalla**. Nadie puede cambiar nada desde la aplicación.
**Consecuencia directa:** la **tasa de cambio** que acabamos de construir **no se
puede cambiar desde el ERP**. Solo desde la base de datos, a mano. Eso es un
agujero: el día que el euro se mueva, hay que entrar por SQL.
→ **Fase 1**

### 20 · CENTRO DE LOTES — 🟡 A medias
`lotes.js` existe y muestra los datos reales: estado, movimientos, trazabilidad
adelante y atrás.
**Pero el plan pide que sea «una herramienta real de control, no una pantalla
informativa», y hoy no lo es:**
- **No se puede ajustar ni retirar un lote desde ahí** (0 acciones).
- **No hay retiradas (recalls).** La tabla `recalls` existe —con
  `recall_affected_customers` al lado, lo cual es buena señal— y **no la lee ni
  la escribe ni un solo fichero**. Un lote que hay que retirar del mercado no
  tiene camino: no se puede marcar, no se puede avisar a los clientes que lo
  compraron.
→ **Fase 4**, junto a la trazabilidad (es el mismo problema)

### 21 · EXPERIENCIA DE USO — 🟢 Completa
Ordenador, móvil y tablet. Menú lateral con velo y `Escape` en móvil. Los tests
de navegador comprueban **visibilidad real** (`getComputedStyle`), no presencia
en el DOM — que es donde se escondían los fallos antes.
Errores que explican qué ha ocurrido. 3 suites de navegador activas.

---

## LO QUE FALTA, RESUMIDO EN UNA TABLA

| Sección | Falta | Va en |
|---|---|---|
| §15 Gastos | API, pantalla, y **matar el `paid` paralelo** | **Fase 1** |
| §16 Alertas | reglas de mínimo y caducidad, API, pantalla | **Fase 1** |
| §19 Configuración | pantalla; hoy la tasa solo se cambia por SQL | **Fase 1** |
| §7 Trazabilidad | entrada propia en el menú | **Fase 4** |
| §17 Historial | escribir `before_data` / `after_data` | **Fase 4** |
| §20 Centro de Lotes | ajuste, retirada, y la tabla `recalls` sin usar | **Fase 4** |
| §18 Usuarios | los 2 de caja | **Fase 1** |

**Las tres primeras que pones en Fase 1 no son un añadido: son la Fase 1 tal y
como la has escrito.** Y las tres de Fase 4 completan lo que el plan llama
«herramienta real de control».

---

## LA RESPUESTA A TU PREGUNTA

> «¿Hay otra pieza funcional importante del plan original que esté faltando?»

**Sí: cuatro secciones enteras.** Tres ya las tienes dentro de la Fase 1
(Gastos, Alertas, Configuración) y una se me había escapado por completo:

**§20 Centro de Lotes — las retiradas.** El plan pide expresamente «el camino
inverso cuando sea necesario para una retirada o recall», y **la tabla existe
pero no la usa nadie**. No se puede retirar un lote del mercado ni avisar a los
clientes que lo compraron. En una empresa de limpieza, eso no es una función
pequena: es la diferencia entre un producto defectuoso retirado a tiempo y una
reclamación.

**Con eso, sí: el alcance queda cubierto por tus cinco fases**, sin meter una
sexta y sin tocar ningún módulo que funcione.

---

## COMPROMISO

Módulos que funcionan y **no se tocan** en la Fase 1, salvo la conexión
imprescindible: catálogo, inventario/lotes, producción, recetas, pedidos,
reparto, albaranes, compras, proveedores, trazabilidad, permisos, panel.

La Fase 1 **añade**: cobro ligado a pedido y entrega, caja y conciliación,
cierre, rol y usuarios de caja, alertas, configuración y gastos. **Y una sola
conexión hacia atrás**: que la tarjeta le muestre al repartidor el importe del
pedido. Ese es el único punto en el que se toca un módulo existente, y es
imprescindible para que el repartidor sepa cuánto cobrar.
