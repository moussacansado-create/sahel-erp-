# EL DISEÑO, CONTRASTRADO CON EL CÓDIGO

> Fecha: 2026-10-04. Sin programar. Solo verificación.
> Se comprobó cada una de las cinco decisiones contra el esquema y el código
> reales, y se anota lo que falta para que aterrice sin romper nada.

---

## 1 · ¿QUIÉN COBRA? — El repartidor cobra. ✅ tu regla, y casi cumple ya

**Lo que ya se cumple**

- La entrega **no acepta ningún importe**. `reparto.js` y `entregas.js` no tienen
  ni un campo de dinero. El repartidor no puede tocar el precio porque no hay
  dónde escribirlo. Exactamente lo que pediste.
- `deliveries` y `delivery_lines` no guardan importe: lo toman del pedido.

**🔴 Lo que falta**

**La tarjeta NO le dice al repartidor cuánto cobrar.** `resolverQr()` en
`core/clientes.js:175` devuelve:

```
order_id, order_code, status, qty_pending, qty_delivered,
qty_ordered, promised_date, lineas, que_lleva
```

Código, estado, cantidades y qué lleva. **No el importe.** Hoy el repartidor
escanea, ve qué lleva y entrega — pero nadie le ha dicho cuánto cobrar.

Es un añadido de una columna, no un rediseño. Y es lo que convierte la entrega
en una operación de cobro.

**Y hay una consecuencia que hay que decidir**

Si el repartidor cobra, necesita **su propio permiso de cobro**. Hoy `DELIVERY`
tiene permisos de reparto, no de cobros. Sin ese permiso, o le damos cobros (y
entonces puede registrar cobros de pedidos que no son suyos), o creamos un
alcance más fino.

**Decisión técnica que propongo:** el cobro se registra **en el mismo momento que
la entrega**, y solo del pedido que se está entregando. No hay una pantalla de
cobros para el repartidor. Es imposible que cobre algo que no está en su mano.

---

## 2 · ¿CAJA ES UNA PERSONA? — Sí, y hay que crear el rol

**Lo que hay**

5 roles: `ADMIN`, `PRODUCTION`, `ACCOUNTING`, `DELIVERY`, `COMMERCIAL`.
Módulos con permiso: 25.

**🔴 Lo que falta**

- **No existe un rol de caja.** Ni el módulo `caja` ni el de `cobros` aparecen
  en la matriz de permisos. Habrá que crearlos.
- **No hay tabla de caja, ni de cobros.** Cero.
- **No hay nada de cierres.** Ni tabla, ni clave de configuración, ni función.
  Ni una línea de código que hable de cierre de caja.

**Lo que tu regla impone y hay que diseñar bien**

```
Repartidor X → entrega 125.000 → Caja/usuario Y → recibe 125.000 → fecha/hora
```

Y poder comparar **lo que debía entregar** con **lo que entregó**. Eso necesita
que la deuda del repartidor se pueda calcular *en cualquier momento*, no solo al
entregar a caja. Si se calcula al momento del traspaso, y el repartidor cobra
otro día, la cuenta no cuadra.

**Propuesta:** el saldo del repartidor se deriva de los cobros, no se guarda.
Es decir, `caja_recibido − cobrado` en cada momento. Sin estado que se pueda
desincronizar.

---

## 3 · ORANGE MONEY — Correcto en no programarlo

De acuerdo, y añado el motivo de por qué es buena idea.

La regla que has puesto —**«comprobante subido ≠ pago confirmado»**— es
exactamente la garantía estructural que necesita. Si se implementa como un
estado de un campo, es una intención. Si se implementa como un `CHECK` en la
base de datos, es una ley.

**Propuesta concreta:** el pago tiene `estado` y la base **no permite** que un
pago con evidencia de Orange Money esté en estado `CONFIRMADO` sin que exista
un `verified_by` y un `verified_at`. No es que la aplicación lo compruebe: es que
no se puede escribir.

**Lo que hay que investigar antes** (y no es código):

1. Si existe API oficial de Orange Money para comercios en Mali.
2. Si hay webhook de confirmación o solo consulta.
3. Qué datos devuelve: referencia, importe, teléfono, fecha.
4. Si permite Initiar el cobro desde el ERP o solo recibir confirmaciones.

Mismo problema, y más serio: **si el repartidor marca un cobro como Orange Money
sin que haya confirmación, ese cobro entra en caja igual que uno verificado.**
Hay que decidir si la caja **acepta** cobros sin verificar o los rechaza.

---

## 4 · PORTAL DEL CLIENTE — La base está lista, falta todo lo demás

**Lo que ya sirve**

- `customers.qr_token` existe, es **opaco** (192 bits), **revocable** y
  **regenerable**, y **no contiene nombre, teléfono ni email** dentro. El QR es
  una llave, no una fuga de datos.
- La tarjeta QR ya se imprime en PDF de 85,6 × 54 mm.

**🔴 Lo que falta: todo**

- No existe ninguna ruta pública. La de hoy, `/api/qr/:token`, **exige sesión
  interna** (`auth` + permiso de entregas) y es para el repartidor.
- No hay mini página, ni consulta de pedidos, ni de saldo, ni historial.
- No hay creación de pedidos desde fuera.

**La decisión que hay que tomar y que cambia todo lo demás**

Has dicho «lo más sencillo posible, sin obligar a crear cuenta con contraseña».
Entonces: **el enlace ES la contraseña**.

Eso significa que **quien tenga el enlace tiene todo lo del cliente**, y no hay
segundo factor posible. No es un problema que se solucione con más código: es
una consecuencia de la simplicidad que pides, y hay que aceptarla o renunciar a
ella.

**Consecuencias concretas que hay que resolver:**

1. **Enlace por cliente o por tarjeta?** La tarjeta física se pierde. Si el enlace
   es por cliente, se regenera. Si es por tarjeta, también.
2. **¿Lleva caducidad?** Sin caducidad, un enlace filtrado sirve para siempre.
3. **¿Qué ve del cliente, y qué NO?** Nombre de la empresa, dirección, límites
   de crédito, historial completo. Recomiendo empezar por lo mínimo.

**Recomendación que te doy**: un token de acceso de **corta duración** (semanas) que
el cliente renueva desde el mismo enlace mientras conserve la tarjeta. Y que
**crear un pedido** exija además confirmar con un código de un solo uso enviado
a su teléfono — para que un enlace robado permita *ver*, pero no *pedir ni pagar*.

Eso es lo que separa «leer» de «comprometer dinero».

---

## 5 · COMERCIAL — Tus dos medidas, y el hueco real

**Lo que hay: el esquema, completo.**

| Pide | Tabla que lo sostiene |
|---|---|
| Objetivos | `commercial_targets(commercial_id, period_start, period_end, target_amount)` ✅ |
| Visitas | `visits(visit_date, result, next_action, next_action_date, lat, lon)` ✅ |
| Clientes captados | `leads(status, converted_at, assigned_to)` ✅ |
| Nº pedidos / importe | `customer_stats(total_orders, total_delivered, total_spent, last_order_at)` ✅ |
| Enlace cliente → comercial | `customers.commercial_id` + `sales_orders.commercial_id` ✅ |

**🔴 Tres huecos reales**

1. **`customer_stats` no la mantiene nadie.** Cero ficheros de código la leen o
   la escriben. Es una caché muerta: hoy está vacía y **seguiría vacía** con
   años de uso. Una tabla que promete un dato y no lo calcula es peor que no
   tenerla, porque alguien se creería que sí lo tiene.

2. **No existe «clientes activos».** `customer_stats` tiene `last_order_at`, que
   permite derivarlo, pero **no hay ninguna definición** de qué cuenta como
   activo. Con esa cifra en un informe, cada uno contará lo que quiera.

3. **No hay histórico, y «evolución por periodo» lo necesita.** Ahora hay un
   `customer_targets` por periodo, pero **nada guarda lo conseguido en cada
   periodo ya cerrado**. La evolución hay que calcularla reconstruyendo sobre
   pedidos, que puede hacerse… mientras los datos estén. Si mañana se corrige un
   pedido de 2026, la evolución de 2026 cambia.

**Sobre las zonas — tienes razón, y HOY ESTÁN MEZCLADAS**

`zones` es **una sola tabla** usada por `customers`, `deliveries`, `leads`,
`sales_routes` y `suppliers`. Y los datos que hay son **geográficos**:
Bamako, Koulikoro, Sikasso, Ségou, Mopti, Gao.

**Son zonas de reparto, no de captación comercial.** No hay ninguna señal en el
esquema que distinga una cosa de la otra, que es exactamente lo que pediste que
no ocurriera.

**Propuesta:** añadir `kind` a `zones` con valores `DELIVERY` y `COMMERCIAL`, y
restringir: un cliente tiene zona comercial, una entrega tiene zona de reparto, y
**no son la misma columna**. Si más adelante se quiere que la zona comercial
herede la geográfica, es un dato más, no una mudanza de la tabla.

---

## 6 · LA REGLA FINAL QUE HAS CERRADO — «Que nadie recalcule el precio»

Esta regla **ya se cumple hoy**, y conviene decirlo porque es lo mejor del
diseño:

| Tabla | Campo de importe |
|---|---|
| `sales_orders` | `subtotal`, `discount_amount`, `tax_rate`, `tax_amount`, `total` |
| `deliveries` | **ninguno** |
| `delivery_lines` | **ninguno** |
| `albaranes` | **ninguno** |
| `albaran_lines` | **ninguno** |

Y el precio **se copia a `sales_order_lines.unit_price` al crear el pedido**, no
se lee del catálogo después. Cambiar el precio del catálogo **no** altera un
pedido ya hecho. Que es lo correcto.

**⚠ Una excepción que hay que arreglar en Cobros:** `expenses` tiene `amount` y
`paid` **en la misma tabla**. Un gasto con su propio interruptor «pagado» es el
germen del sistema paralelo que quieres evitar. Cuando llegue Cobros, ese campo
tiene que morir o pasar a ser un enlace a un cobro real.

---

## 7 · LO QUE FALTA PARA USAR EL ERP A DIARIAMENTE

Todo lo de arriba es el circuito. Esto es otra cosa: **coste de operar**.

| Falta | Por qué importa a diario |
|---|---|
| **Respaldo de la base** | Render PostgreSQL Oregon **no está creado** (tú decidiste que aún no). Sin él no hay red. |
| **Restauración probada** | Un respaldo que nunca se ha restaurado no es un respaldo. |
| **Factura de venta** | No hay ninguna tabla. Entregas y albaranes no son factura. Sin ella no se factura a nadie. |
| **Nota de crédito / devolución** | No existe. Un cliente que devuelve mercancía no tiene camino. |
| **Histórico de precios** | `items.sale_price` es un precio actual. Al cambiarlo, **no queda constancia del anterior**. |
| **Alertas de existencias** | `min_stock` existe en el catálogo, y no hay nada que avise de que se cruzó. |
| **Cierre de caja** | Ya citado. Sin él, el dinero se registra pero no se cuadra por periodo. |

De estos, los tres que **bloquean el uso diario** son: **respaldo**, **factura
de venta** y **nota de crédito**. Los demás se pueden vivir sin ellos al principio
—un negocio arranca con caja simple— pero hay que saber que están ahí.
