# LO QUE LAS PRUEBAS DE COMISIONES DEJARON EN LA BASE

Este documento existe porque las pruebas del bloque 6 han creado registros
reales en la base de producción. Están aquí, se pueden ver, y se sabe
exactamente qué son. **No se ha borrado nada del libro mayor.**

Fecha: 18 de octubre de 2026 · Commit activo: `6d77b63`

---

## 1 · CLIENTES DE PRUEBA

**13 clientes**, todos con el nombre `PRUEBA-COMISION cliente`, **todos
archivados** (`archived_at` con fecha y motivo). Los 4 clientes reales
(`CL-00001` a `CL-00004`) **siguen activos y sin tocar**.

| Qué | Cuántos | Estado |
|---|---|---|
| Clientes de prueba | 13 | Archivados, con motivo y fecha |
| Clientes reales | 4 | Activos, intactos |

**Por qué archivados y no borrados.** El archivado es la operación que el
propio sistema tiene para esto: conserva el historial, aparta el cliente de
las listas y deja constancia de quién lo archivó y por qué. Un `DELETE`
hubiera roto la trazabilidad de los pedidos y los cobros que los apuntan.

---

## 2 · PEDIDOS DE PRUEBA

**26 pedidos**, todos con la nota `PRUEBA-COMISION` en el campo `notas`.

| Qué | Cuántos | Estado |
|---|---|---|
| Anulados | 22 | `cancelled_at` con motivo `PRUEBA-COMISION` |
| Vivos | 4 | Los de la última corrida, con mercancía entregada y dinero cobrado |

**Por qué algunos siguen vivos.** Un pedido con dinero cobrado **no se anula**:
anularlo es una devolución, que es otra operación. Anular un pedido ya cobrado
dejaba el libro mayor diciendo que había una venta que ya no la había, y el
módulo de comisiones, con razón, dejó de contarlos.

---

## 3 · COBROS DE PRUEBA

**12 cobros**, todos de los pedidos de prueba, todos en efectivo, todos con la
referencia `PRUEBA-COMISION`. **Ninguno ha pasado nunca por el estado
`VERIFIED`**, porque **el ERP no tiene flujo de verificación de cobros**: un
cobro nace `PENDING` y se queda ahí.

Por eso el módulo de comisiones cuenta `PENDING` y `VERIFIED` como cobrado, y
**enseña por separado lo que aún no está verificado**. Si solo contaran los
verificados, la base de la comisión sería cero siempre.

---

## 4 · MOVIMIENTOS DE STOCK

**516 movimientos**, eran **506** antes de las pruebas. **Son 10 movimientos
nuevos**, todos salidas de mercancía por las entregas de los pedidos de prueba.

**No se han revertido, y no se van a revertir.** El libro mayor es
*append-only*: si se borran, se pierde la verdad de lo que salió del almacén y
de quién lo sacó. La salida de mercancía de una entrega real es un hecho, por
irrelevante que fuera la entrega que la provocó.

---

## 5 · COMISIONES Y PORCENTAJES

| Tabla | Cuántas | Estado |
|---|---|---|
| `com_comisiones` | 1 | Comercial 4, periodo 2026-10, **PAGADA** |
| `com_comision_porcentajes` | 1 | Comercial 4, 3 % desde 2026-10-01 |
| `com_comision_pagos` | 1 | La comisión pagada |
| `com_comision_auditoria` | 13 | Todo lo que se hizo, con quién y por qué |

**Esta fila es la que hace que el módulo tenga algo que enseñar.** Sin ella,
las pantallas se verían vacías y no se podría comprobar nada.

La comisión confirmada **no se puede borrar ni reescribir**: la base lo veta
con un disparador. Solo se puede **descartar** (devolver el mes a revisión, con
motivo y rastro) o **ajustar**.

---

## 6 · LO QUE NO SE HA TOCADO

```
lotes                120   (intactos)
usuarios              11   (intactos)
permisos             168   +6 de comisiones, +1 acción nueva
zonas                 14   (intactas)
com_perfiles           6   (intactos)
etiquetas              10   (intactas)
copia nube-20261015-225713.json   conservada
base local                     sin tocar
```

---

## 7 · CÓMO DEJAR ESTO EN BLANCO

Si algún día se quiere empezar de cero con las comisiones:

1. **El porcentaje**: se revisa con otro para la misma fecha o se añade uno
   posterior. No hace falta borrar nada.
2. **La comisión**: se **descarta** desde la pantalla del administrador, con
   un motivo. Queda en la auditoría.
3. **Los clientes**: ya están archivados. Se pueden dejar así, que es lo
   correcto.
4. **Los pedidos y sus cobros**: son operaciones del libro mayor. Se anulan
   con su motivo, como ya están la mayoría. Los 4 vivos son los que tienen
   dinero cobrado: si se anulan, hay que devolver la mercancía antes.
5. **Los movimientos de stock**: no se tocan. Son salidas reales.

**Aviso.** Si se anulan los 4 pedidos vivos, sus cobros dejan de contar para la
comisión —el módulo, con razón, no cuenta lo que no es una venta— y la
comisión del mes pasa a cero. Es lo correcto, pero conviene saberlo antes de
que alguien se asuste.
