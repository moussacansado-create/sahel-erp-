# SAHEL ERP — AUDITORÍA FUNCIONAL Y GUÍA DE USO

**Producción:** https://sahel-erp.onrender.com
**Commit activo:** `8b9d0dd` (live, verificado por la API de Render)
**Fecha de la auditoría:** 18 de octubre de 2026
**Base de datos:** `sahel-db` de Render (host `dpg-db503sbrjlhs73bugiv0-a`), `NODE_ENV=production`, `DATABASE_SSL=true`

> Esta auditoría **no ha cambiado nada**. Solo ha mirado. Las únicas cosas
> que se han escrito en la aplicación son sesiones de inicio de sesión.

---

## A · RESUMEN GENERAL

**Lo que está listo:** la aplicación funciona, es estable y tiene las piezas
principales de una fábrica y una red comercial: catálogo, almacén, lotes,
pedidos, albaranes, reparto, cobros, caja, mapa de zonas, comerciales,
ranking y comisiones. El mapa de Bamako es interactivo de verdad y el módulo
de comisiones está completo y probado en producción.

**Lo que falta de verdad no es código: son datos y configuración.** La base
de datos está prácticamente vacía de operación real:

| Falta | Consecuencia |
|---|---|
| **Ninguna caja configurada** | No se puede vender por cajas todavía (el mecanismo está, los datos no) |
| **Ningún envase registrado** | No se puede fabricar nada (un producto necesita su envase) |
| **Ninguna receta** | No se puede fabricar nada |
| **Ningún proveedor ni compra** | El módulo de compras está vacío |
| **4 de los 7 roles sin ningún usuario** | Caja, producción, reparto, contabilidad y jefe comercial no tienen a nadie |
| **3 productos nuevos sin precio** | Se pueden vender a 0 FCFA |
| **Los 4 productos nuevos sin existencias** | El stock que hay es de los 6 productos antiguos, que están desactivados |

**La consecuencia práctica:** la aplicación está como un almacén con las
estanterías montadas, la luz encendida y los controles funcionando, pero
**todavía no ha pasado por él ninguna venta real**. La primera venta de
verdad obligará a configurar el catálogo, las cajas, los envases y las
recetas.

---

## B · TABLA DE MÓDULOS

Estado: **T** = terminado y comprobado en producción · **I** = implementado,
pendiente de comprobar con datos reales · **P** = parcial · **C** = necesita
configuración o datos.

| # | Módulo | Estado | Cómo se ha comprobado | Limitaciones |
|---|---|---|---|---|
| 1 | **Inicio de sesión, usuarios, roles y permisos** | **T** | Login real con 2 usuarios; 11 usuarios, 7 roles, 196 permisos, 326 asignaciones de rol. Hay límite de 10 intentos por cada 15 minutos y por IP. | La contraseña de los usuarios de demostración es la misma para todos y es débil. Hay que cambiarla. |
| 2 | **Clientes y fichas de cliente** | **T** | 4 clientes activos. Alta, edición, código automático (CL-#####), ficha con su comercial y zona, tarjeta QR, archivado y reactivación. | El archivado esconde el cliente de las listas pero conserva su historial. No se puede borrar. |
| 3 | **Asignación de clientes a comerciales y zonas** | **T** | Los 4 clientes tienen zona y comercial. Un comercial solo puede dar de alta clientes en sus zonas; el administrador en todas. | Un comercial **no puede** asignarse a sí mismo a un cliente de otra zona: el sistema se lo impide. |
| 4 | **Mapa comercial, zonas, ranking y fichas** | **T** | 14 zonas (9 regiones + 5 distritos de Bamako). El mapa se pulsa y abre la ficha de la zona. Recuadro de ampliación de Bamako con sus 5 zonas, pulsables. Ranking con puesto, objetivo, ventas y puntos. | El recuadro de Bamako es una ampliación aparte: el mapa de Mali es demasiado pequeño para poder pulsarlo. |
| 5 | **Visitas, seguimiento, tareas e incidencias** | **I** | Las rutas y las tablas existen. Las pantallas se abren. | **No hay ni una visita, seguimiento ni incidencia registrada.** Falta probarlo con datos de verdad. |
| 6 | **Pedidos y tarifas** | **T** | 26 pedidos creados y correctamente calculados. El precio se guarda con el pedido, así que cambiar la tarifa después no mueve los pedidos antiguos. | 3 de los 10 productos tienen precio 0. Un pedido necesita stock en el momento de confirmarlo. |
| 7 | **Venta por unidades y venta por cajas** | **P** | La mecánica está probada por el código y las pruebas. | **No hay ninguna caja configurada.** Ver la sección C. |
| 8 | **Preparación, albaranes y entregas** | **T** | Flujo completo: preparar → albarán → firma en papel → escaneo de la tarjeta → entrega. 10 entregas registradas. | La entrega la confirma **la tarjeta del cliente**, no el repartidor. El papel firmado es la referencia. |
| 9 | **Cobros, pagos, caja y cierre diario** | **T** | 12 cobros. Módulo de caja completo: abrir caja, meter y sacar dinero, traspasos, contar al cerrar, y anotar la diferencia si no cuadra. | **No se puede cobrar una parte de un pedido**: el sistema cobra lo que queda pendiente del pedido entero. Ver la sección F. |
| 10 | **Comisiones comerciales** | **T** | 44/44 pruebas de cálculo y permisos, 26/26 de API, **32/32 de interfaz en navegador real**. | Venta por cajas y comisiones: la base se calcula sobre lo cobrado. |
| 11 | **Materias primas, envases y lotes** | **P** | 1 materia prima, **0 envases**, 120 lotes (107 con existencias). | **Sin envases no se puede fabricar.** Ver la sección E. |
| 12 | **Fórmulas, recetas y producción** | **I** | Las pantallas y el cálculo existen. | **0 recetas y 0 producciones.** No se ha podido probar el circuito completo de fabricación. |
| 13 | **Stock, movimientos y trazabilidad** | **T** | 120 lotes, 516 movimientos. Cada salida tiene su lote, su motivo y su responsable. | 10 de los movimientos son de las pruebas de comisiones. Ver la sección H. |
| 14 | **Historial, auditoría y copias** | **T** | 2.532 entradas de auditoría, 7.305 cambios registrados, script de respaldo y script de restauración probados. | Ver la sección H. |
| 15 | **Móvil y ordenador** | **T** | Revisado en navegador a 1.400 px y a 1.000 px. El menú y las tablas se adaptan. | El Panel del comercial en móvil es el punto débil (ver la sección I). |

---

## C · VENTA POR CAJAS: QUÉ SE PUEDE HACER HOY

**La respuesta corta: el mecanismo está completo y probado, pero no hay ni una
caja configurada en producción. Hay que crearlas antes de poder vender por
cajas.**

### Qué significa una caja aquí

Una caja **no es un artículo**. No se fabrica, no entra por el almacén y no se
descuenta. El almacén sigue contando botellas. Lo único que dice una caja es
**cuántas botellas lleva y cuánto vale**. Por eso el apartado está en
Ajustes y no en el catálogo.

### Las diez preguntas, una a una

| Pregunta | Respuesta |
|---|---|
| ¿Vender una botella suelta? | **Sí.** Es lo que se ha hecho en los 26 pedidos. |
| ¿Vender una caja completa? | **La mecánica sí, pero no hay ninguna caja creada.** Hay que configurarlas en Ajustes → Formatos de venta. |
| ¿Varias cajas en un solo pedido? | **Sí.** Se indican cuántas cajas y el sistema calcula las botellas. |
| ¿Combinar cajas y unidades sueltas del mismo producto? | **En líneas distintas, sí. En la misma línea, no:** el sistema avisa *"En X has puesto a la vez cajas y botellas. Elige una"*. |
| ¿Cada producto con sus unidades por caja? | **Sí, se configura producto por producto.** No hay un valor por defecto: cada caja dice cuántas botellas lleva. |
| ¿El precio por caja es independiente del de la unidad? | **Sí.** La caja tiene su propio precio y su propio IVA. Si la caja no tiene precio, se usa el de la unidad. |
| ¿Se guarda el precio acordado? | **Sí.** Al guardar el pedido se copian el nombre, las unidades y el precio de la caja. Si mañana cambias el precio de la caja, **los albaranes y las facturas de los pedidos antiguos no se mueven**. |
| ¿El stock se descuenta bien? | **Sí, en unidades físicas.** Si una caja son 12 botellas y vendes 3 cajas, salen 36 botellas del almacén. |
| ¿El albarán lo enseña claro? | **Sí.** Sale el nombre de la caja, cuántas cajas y cuántas botellas equivalen. |
| ¿Los cobros y las comisiones lo cuentan bien? | **Sí.** Se cobra el precio de la caja por caja, una sola vez, y la comisión se calcula sobre ese importe. |

### Cómo configurarlas (5 minutos)

1. **Ajustes → Formatos de venta (cajas)** (solo el administrador).
2. Elige el producto terminado.
3. Pon el nombre de la caja (por ejemplo, «Caja de 12»).
4. Cuántas botellas lleva (12).
5. El precio de la caja y su IVA.
6. Guardar.

**Aviso importante:** solo se pueden crear cajas sobre **productos terminados**
que ya existan en el catálogo. Y solo puede hacerlo quien tenga permiso de
editar las cajas.

---

## D · GUÍA DE USO: LAS OPERACIONES DE CADA DÍA

### 1 · El comercial por la mañana

| Qué | Dónde | Qué hacer |
|---|---|---|
| Ver sus clientes | Menú → Clientes | Filtrar por zona o buscar por nombre |
| Ver sus ventas | Menú → Pedidos | Los suyos están todos aquí |
| Ver lo que ha cobrado y lo que se le calcula | Menú → Ventas y comisiones | Elegir el mes. Arriba: base cobrada, pendiente, porcentaje y comisión |
| Ver el mapa | Menú → Comerciales | Pulsar una zona para ver quién la lleva y sus clientes |

### 2 · Crear un pedido

1. Menú → **Pedidos** → **+ Nuevo pedido**.
2. Elegir el **cliente**. Se puede escanear su tarjeta con la cámara («Escanear cliente»).
3. Añadir las líneas: producto y cantidad.
   - **Si el producto tiene cajas configuradas**, aparece un desplegable para elegir «cajas» o «botellas» y, al elegir cajas, el sistema dice cuántas botellas son.
4. **Guardar**. El pedido queda en *Borrador*.
5. Alguien del almacén pulsa **Preparar** (o **Confirmar**): el sistema aparta el stock. **Si no hay stock, avisa exactamente de qué falta y de cuánto.**

### 3 · El almacén

1. Menú → **Albaranes** → crear el albarán del pedido e imprimirlo.
2. El cliente firma en papel.
3. Se escanea la **tarjeta del cliente** → la entrega queda registrada.
4. Menú → **Cobros** → cobrar. **El importe no se escribe: lo pone el sistema.**

### 4 · El repartidor al terminar el día

1. Menú → **Caja** → **Abrir la caja de hoy** (con el dinero inicial que lleva encima, contado).
2. Cada cobro que hace se anota solo en su caja.
3. Al terminar: **Cerrar la caja** → se cuenta el dinero y se escribe el total contado.
4. Si **no cuadra**, el sistema **exige una explicación**. Una diferencia sin explicación no se guarda.
5. Si lleva dinero al administrador: **Traspasos de reparto** → **Abrir traspaso**.

**Lo que puede ver el jefe:** «Repartidores con dinero», «Total que debería haber»
y los traspasos. Si el dinero que tienen los repartidores **no** coincide con
el total que debería haber, ahí está la diferencia.

### 5 · El administrador al cierre de mes

1. Menú → **Ventas y comisiones** → elegir comercial y mes.
2. Revisar la base, el porcentaje y el detalle de cobros.
3. **Confirmar comisión**. A partir de ahí la cifra queda **congelada**.
4. **Marcar como pagada** con el importe, la fecha y la referencia del pago.

### 6 · Comprobar que todo cuadra

- **Stock**: Menú → Stock (qué hay) y Movimientos (por qué salió).
- **Ventas**: Menú → Pedidos.
- **Cobros**: Menú → Cobros.
- **Dinero**: Menú → Caja.
- **Comisiones**: Menú → Ventas y comisiones.
- **Trazabilidad**: Menú → Lotes → un lote → su historial.

---

## E · PUESTA EN MARCHA INICIAL: EL ORDEN CORRECTO

Este es el orden para configurar la empresa desde cero. **Seguirlo en orden
evita la mitad de los bloqueos**, porque cada paso necesita el anterior.

| # | Qué configurar | Dónde | Quién | Por qué en este orden |
|---|---|---|---|---|
| 1 | **Zonas comerciales** | Ya están: 9 regiones + 5 distritos de Bamako | — | Todo lo demás cuelga de las zonas |
| 2 | **Comerciales y su zona** | Menú → Comerciales → Nuevo comercial | Admin | Un comercial sin zona no puede crear clientes ni tener cartera |
| 3 | **Usuarios** | Menú → Usuarios | Admin | El usuario se crea con un rol. **Crea uno por persona** |
| 4 | **Materiales primas** | Menú → Materias primas | Admin | Sin materia prima no hay nada que fabricar |
| 5 | **Envases** | Menú → Envases | Admin | **Sin envase no hay producto terminado.** Es el paso que más gente se salta |
| 6 | **Recetas** | Menú → Recetas | Producción | Dice qué materia prima y qué envase usa cada producto |
| 7 | **Producción** | Menú → Producción | Producción | Fabrica y genera los lotes con existencias |
| 8 | **Precios de venta** | Menú → Productos | Admin | **Sin precio, el pedido sale a 0** |
| 9 | **Formatos de venta (cajas)** | Ajustes → Formatos de venta | Admin | Ver la sección C |
| 10 | **Clientes** | Menú → Clientes | Comercial o Admin | Cada cliente necesita zona y comercial |
| 11 | **Porcentaje de comisión** | Ventas y comisiones → Guardar porcentaje | Admin | Sin porcentaje, la comisión no se calcula |
| 12 | **Proveedores y compras** | Menú → Proveedores / Compras | Admin | Solo si compras a proveedores |
| 13 | **Primer pedido** | Menú → Pedidos | Comercial | Ya se puede hacer una venta real |

**Lo mínimo para poder vender:** pasos 1, 2, 3, 8 y 10. Con eso ya se puede
crear un cliente y un pedido y cobrarlo.

**Lo mínimo para poder fabricar:** pasos 1, 3, 4, 5, 6, 7.

---

## F · MENSAJES Y BLOQUEOS HABITUALES

### Por qué no me deja crear un pedido

| Lo que pasa | Por qué | Cómo se resuelve | Quién |
|---|---|---|---|
| «No hay clientes» | Un pedido necesita un cliente | Crear el cliente primero, con zona y comercial | Comercial (en su zona) o Admin |
| «No hay stock para confirmar el pedido: X (faltan N de M)» | Se ha pedido más de lo que hay | Fabricar, o cambiar la cantidad | Admin o Producción |
| «El pedido está en estado X y no se puede confirmar» | Ya está preparado o entregado | No se puede volver atrás | Admin |
| «Solo se puede preparar un pedido reservado» | El pedido no está confirmado | Confirmar primero | Admin |
| «La cantidad de X tiene que ser mayor que cero» | La línea está vacía | Escribir la cantidad | Quien lo hace |
| «X es materia prima o envase, no producto para vender» | Se intenta vender algo que no es de venta | Elegir un producto terminado | Quien lo hace |
| «No hay formatos de venta» / solo aparece el precio por unidad | No hay cajas configuradas | Configurarlas en Ajustes | Admin |

### Other restrictions worth knowing

| Situación | Qué ocurre |
|---|---|
| **Producto sin precio** | El pedido sale con importe 0. No lo avisa: hay que revisar los precios antes de vender. |
| **Cliente sin comercial** | Se puede crear, pero **no cuenta en ningún ranking ni comisión**. Se avisa al elegir la zona: *«Elige una zona para el cliente. Sin zona no se puede ordenar ni contar la cartera»*. |
| **Sin zonas configuradas** | No se puede dar de alta ningún cliente ni comercial. |
| **Comercial crea un pedido, el admin no lo ha confirmado** | El pedido se queda en *Borrador*. **No aparta stock y no se puede entregar** hasta que alguien con permiso lo confirme. El comercial puede verlo en su lista de pedidos. |
| **Cliente que aún no ha pagado** | Se puede guardar el pedido sin problema. El cobro va aparte: primero se entrega, después se cobra. El pedido y el cobro son cosas distintas. |
| **Pedido pendiente de entrega** | Sí, se guarda. Aparece en la hoja de reparto. |
| **Una caja y botellas del mismo producto en la misma línea** | El sistema lo rechaza: *«has puesto a la vez cajas y botellas. Elige una»*. En **líneas distintas** sí se puede. |
| **Cobrar una parte de un pedido** | **No se puede.** El sistema cobra lo que queda pendiente del pedido entero. No hay cobros parciales por pedido. |
| **Cobro sin verificar** | Todos los cobros nacen «sin verificar» porque **el ERP no tiene forma de verificarlos todavía**. Por eso la comisión los cuenta, pero los enseña en ámbar. |
| **Pantalla vacía** | Cada pantalla vacía dice qué falta (por ejemplo: *«No hay envases todavía»*, *«Todavía no se ha fabricado nada»*). Si no lo dice, es un error y hay que avisar. |

### Cómo distinguir una restricción de un fallo

- **Restricción:** sale con un texto que explica el motivo y un código
  (por ejemplo `STOCK_INSUFICIENTE_PARA_CONFIRMAR`, 409). Es el sistema
  funcionando. La respuesta está en el mensaje.
- **Error de programación:** sale *«Error interno del servidor»* con el código
  `ERROR_INTERNO`, o la pantalla se queda en blanco. **Eso sí es un fallo** y
  hay que anotarlo.

---

## G · ROLOS Y PERMISOS

### Qué ve cada rol (calculado sobre el código y la tabla real de permisos)

| Rol | Pantallas | Puede crear | No puede |
|---|---|---|---|
| **Administrador** | 22 (todo) | Todo | — |
| **Jefe comercial** | 12 | Clientes, pedidos, albaranes, alta de comerciales | No ve caja, ni compras, ni comisiones, ni producción |
| **Comercial** | 7 | Clientes (en sus zonas), pedidos | No confirma pedidos, no cobra, no cambia precios, no ve comisiones ajenas, no ve el stock |
| **Caja** | 6 | Sesiones de caja, movimientos, cobros | No ve stock, ni compras, ni comerciales, ni comisiones |
| **Producción** | 10 | Materias primas, envases, recetas, producciones, entradas | No ve clientes, ni pedidos, ni caja |
| **Reparto** | 4 | Entregas, notas de reparto | No ve stock, ni pedidos, ni caja, ni comerciales |
| **Contabilidad** | 9 | Compras, proveedores, entradas, consultas | No ve caja, ni reparto, ni comerciales, ni comisiones |

### Comprobado en el servidor, no solo en la pantalla

Se ha entrado con sesión de **comercial** y se ha intentado:

| Acción | Respuesta del servidor |
|---|---|
| Confirmar su propia comisión | **403 prohibido** |
| Registrar el pago de una comisión | **403 prohibido** |
| Cambiar su porcentaje | **403 prohibido** |
| Ver el resumen de otro comercial | Le devuelve **el suyo**, no el del otro |
| Ver el listado de comisiones | Solo le devuelve **las suyas** (comercial 4) |

**Los botones ocultos no son la seguridad: la seguridad está en el servidor.**
Está comprobado que el servidor responde 403 aunque se llame a la operación
directly.

### El problema: cinco roles sin ninguna persona

Los roles **Caja, Producción, Reparto, Contabilidad y Jefe comercial existen y
tienen sus permisos bien puestos, pero no hay ningún usuario con ellos**. Los
únicos usuarios son el administrador y 10 comerciales.

**Antes de formar al personal hay que crear esos usuarios** (Menú → Usuarios →
Nuevo usuario, eligiendo el rol). Un usuario de reparto con el rol
Administrador se acabaría viendo las comisiones de los demás: el rol es lo
que protege.

---

## H · SEGURIDAD DE DATOS

### Qué se conserva al publicar una versión nueva

**Nada se borra al publicar.** Un despliegue:

1. Descarga el código nuevo.
2. Ejecuta las **migraciones nuevas** (archivos de `db/migrations/`), que
   solo **añaden** tablas, columnas, índices y restricciones.
3. Arranca el servidor. **La base de datos no se toca.**

Las migraciones aplicadas están registradas con su **suma de verificación** en
la tabla `schema_migrations`: si alguien cambiara una migración ya aplicada, el
arranque se negaría a continuar. Una migración aplicada es inmutable.

**Comprobado:** las migraciones 068 a 078 (las de este trabajo) **no contienen
ningún `DELETE`**. La única migración que borró datos fue la 073, la limpieza
de demostración que ya se hizo y que está documentada.

### La base de datos de producción

`DATABASE_URL` apunta a `sahel-db` de Render (`dpg-db503sbrjlhs73bugiv0-a`),
con `NODE_ENV=production` y `DATABASE_SSL=true`. Es la **misma base que se
usó desde el principio**, la que se eligió a propósito para no tener dos.

### Las copias de seguridad

| Qué | Estado |
|---|---|
| Copia en este repositorio | `respaldos-nube/nube-20261015-225713.json` (2.302.110 bytes) — **conservada** |
| Script de respaldo | `server/respaldar.mjs` — pide el volcado **al servidor** y lo firma. **No abre la base por su cuenta**, porque hacerlo con el servidor en marcha la corrompe (ya pasó tres veces en este proyecto) |
| Script de restauración | `server/restaurar.mjs` — restaura y **comprueba que las tablas cuadran** al terminar |
| Copia local | `respaldos/respaldo-20261010-081609` — 81 tablas, verificada |
| Automático | **No hay copia automática programada.** Hay que lanzar el script a mano |

### Cómo hacer una copia antes de tocar nada

```bash
cd server
node respaldar.mjs          # deja el fichero firmado en respaldos-nube/
```

Y para comprobar que **se puede restaurar**, sin tocar producción:

```bash
node restaurar.mjs <fichero>   # en una base de pruebas, nunca en producción
```

**Consejo:** antes de una migración importante, copia y guarda el fichero
**fuera del servidor** (descargarlo al ordenador o a un disco externo). Una
copia que solo vive en el mismo sitio que los datos no protege de perder
el servidor.

### Qué NO protege una copia

El historial de auditoría y los registros de sincronización son los que más
crecen. Si el ERP se usa a diario, conviene una copia **semanal**, no solo
antes de cada cambio.

### Los datos de prueba que hay en la base

Están documentados en `docs/PRUEBAS-COMISIONES.md`:

| Qué | Cuántos | Estado |
|---|---|---|
| Clientes `PRUEBA-COMISION` | 13 | **Archivados** (con motivo y fecha). Los 4 clientes reales, intactos |
| Pedidos de prueba | 26 | 22 anulados, 4 vivos con mercancía entregada y dinero cobrado |
| Cobros de prueba | 12 | En efectivo, referencia `PRUEBA-COMISION` |
| Movimientos de stock nuevos | 10 | **No se han revertido.** El libro mayor es *append-only* |
| Comisiones | 1 | Comercial 4, octubre 2026, pagada |

**Aviso:** si se anulan los 4 pedidos vivos, sus cobros dejan de contar para la
comisión y la del mes pasa a 0. Es lo correcto, pero conviene saberlo.

---

## I · INCIDENCIAS

### Incidencias reales encontradas (pendientes de autorización)

**1 · El Panel del comercial enseña un error en vez de su trabajo.**
El comercial entra en la aplicación y lo primero que ve es el Panel, que dice:
*«No se ha podido leer el inventario. No tienes permiso para view en inventory o
lots»*. El Panel pide datos de inventario que el comercial no puede ver.
**Lo que debería:** el Panel del comercial tendría que enseñar sus ventas, sus
clientes y su comisión. **Prioridad: alta** — es la primera pantalla que ve
todo el equipo comercial.

**2 · No existe verificación de cobros.**
La tabla de cobros tiene los estados `PENDING`, `VERIFIED` y `REJECTED`, pero
**nada en la aplicación pasa un cobro a `VERIFIED`**. Todos los cobros se
quedan «sin verificar» para siempre. Mientras tanto, el módulo de comisiones
los cuenta como cobrados y los enseña en ámbar, separando lo verificado de lo
que no. **Prioridad: media** — no bloquea nada, pero ensucia la lectura.

**3 · No se puede cobrar una parte de un pedido.**
El importe del cobro es el pendiente del pedido entero. No hay cobros parciales
por pedido. **Prioridad: baja**, salvo que el negocio los necesite.

**4 · Un producto sin precio no avisa.**
El pedido sale a 0 FCFA sin decir nada. **Prioridad: media** — un descuido
caro.

**5 · Cinco roles sin usuarios.** No es un fallo del programa: falta crear las
cuentas. **Prioridad: alta**, porque sin ellas nadie puede trabajar en caja,
producción, reparto ni contabilidad.

**6 · No hay ninguna caja configurada.** No es un fallo: falta configurarlas.
**Prioridad: media** si se quiere vender por cajas.

**7 · Contraseñas de demostración débiles y compartidas.**
Todos los usuarios de demostración comparten la misma contraseña, y la del
administrador es trivial. **Prioridad: alta** antes de poner esto en manos
reales.

### Dudas sin resolver

- **¿La comisión se calcula sobre lo cobrado o sobre lo entregado?** Está
  decidido: **sobre lo cobrado**, que es lo que se pidió. Pero conviene
  confirmarlo con el negocio una vez haya ventas reales, porque cambia mucho
  el número.
- **¿Debe el comercial ver el nombre de sus compañeros en el ranking?** Ahora
  sí lo ve (su posición, no sus clientes). Es una decisión de negocio.

### Funciones pendientes de los bloques originales

Bloques 3, 4, 5, 7, 8 y 9: clientes por zona y seguimiento, prueba de los 12
permisos con usuarios reales, coherencia del marcador de puntos, historial
cronológico del comercial, alertas e incidencias, y verificación final.

---

## J · PRÓXIMOS PASOS

**Lo primero, y en este orden:**

1. **Arreglar el Panel del comercial.** Es la primera pantalla que ve la mitad del equipo y ahora mismo enseña un error. *(Necesita autorización.)*
2. **Cambiar las contraseñas** de los usuarios de demostración y crear las
   cuentas que faltan: caja, producción, reparto, contabilidad y jefe
   comercial. **Sin esto, la mitad de la empresa no puede trabajar.**
3. **Configurar el catálogo de verdad:** precios de los 4 productos nuevos,
   envases y recetas. **Sin envases ni recetas no se puede fabricar nada**, y
   hoy el stock que hay pertenece a productos que están desactivados.
4. **Decidir si se vende por cajas** y, si sí, configurarlas. La mecánica está
   lista; faltan los datos.
5. **Hacer una venta de prueba completa** de punta a punta con un comercial y
   un repartidor reales, y comprobar que el stock, el cobro y la comisión
   cuadran. Es la prueba que falta y la que más información daría.

**Lo que NO hay que rehacer:** el mapa con su recuadro de Bamako, el módulo de
comisiones (backend e interfaz, con 32/32 de pruebas visuales), el sistema de
cajas, el módulo de caja, la trazabilidad de lotes, las copias de seguridad y
el sistema de permisos. Todo eso está comprobado y funcionando.
