# REFERENCIAS VISUALES · qué debe existir y cómo debe verse

Documento de **especificación**, no de trabajo hecho. Recoge lo que el usuario
ha aportado de la aplicación antigua para que quede por escrito qué hay que
construir en la nueva.

**Regla permanente:** estas imágenes son referencia de *qué tiene que existir* y
*cómo debe verse*. No se copia código, no se leen datos de la base antigua, y
la aplicación nueva sigue siendo independiente: Express + PostgreSQL, sin
SQLite, sin Persistent Disk, sin un solo dato de la anterior.

---

## 1 · Hoja de pedido / albarán

### Lo que se ve en la referencia

```
┌────────────────────────────────────────────────────────────────┐
│ [logo]        SAHEL                          ┌──────────────┐ │
│               PRODUITS D'HYGIÈNE             │ PEDIDO N°    │ │
│               Av. de la Liberté 123,         │ D0001        │ │
│               Bamako, Mali                   │ Fecha:       │ │
│               Tel: +223 70 12 34 56          │ 01/10/2026   │ │
│               Email: contacto@sahel.ml       └──────────────┘ │
├────────────────────────────────────────────────────────────────┤
│                      H O J A   D E   P E D I D O               │
│ ┌──────────────────────┐  ┌──────────────────────────────┐     │
│ │ DATOS DEL CLIENTE    │  │ DETALLES DEL PEDIDO          │     │
│ │ Nombre / Dirección / │  │ Fecha / Condiciones de pago /│     │
│ │ Teléfono             │  │ Vendedor                    │     │
│ └──────────────────────┘  └──────────────────────────────┘     │
│ ┌────┬──────────────┬─────┬────────┬────────────┬────────┐      │
│ │ N° │ DESCRIPCIÓN  │ PRE │CANTIDAD│ PRECIO U.  │ TOTAL  │      │
│ ├────┼──────────────┼─────┼────────┼────────────┼────────┤      │
│ │ 1  │ Limpiador…   │     │   2    │  4,50      │  9,00  │      │
│ └────┴──────────────┴─────┴────────┴────────────┴────────┘      │
│                                    ┌────────────┬────────┐     │
│                                    │ Subtotal   │ 17,40  │     │
│                                    │ I.V.A.     │  3,132 │     │
│                                    │ TOTAL GRAL.│ 20,532 │     │
│                                    └────────────┴────────┘     │
│ ┌──────────────────────┐  ┌──────────────────────────────┐     │
│ │ CONDICIONES GENERALES│  │      (espacio)               │     │
│ │ • mercancía por      │  │   ─────────────────────      │     │
│ │   cuenta y riesgo…   │  │   Firma y sello del cliente  │     │
│ └──────────────────────┘  └──────────────────────────────┘     │
│              ¡GRACIAS POR SU CONFIANZA!                         │
│                  SAHEL - Produits d'hygiène                     │
└────────────────────────────────────────────────────────────────┘
```

### Elementos que hay que reproducir

| Elemento | Nota |
|---|---|
| Botones | «Imprimir / Guardar PDF» y «Cerrar» |
| Cabecera | Logo + razón social + dirección + teléfono + email |
| Caja derecha | Número de pedido y fecha, enmarcada |
| Título centrado | «HOJA DE PEDIDO», en azul, con espaciado entre letras |
| Dos cajas | Datos del cliente / Detalles del pedido (fecha, pago, vendedor) |
| Tabla | N°, Descripción, **Presentación**, Cantidad, Precio unitario, Total |
| Totales | Subtotal, I.V.A., TOTAL GENERAL en bloque destacado |
| Condiciones | Lista de condiciones comerciales fijas |
| Firma | Espacio con línea y «Firma y sello del cliente» |
| Pie | «¡GRACIAS POR SU CONFIANZA!» + marca |

**«Presentación» es una columna que no existe en la nueva aplicación.** El
catálogo tiene `format_label` (750 ml, 1 L…) pero está sin usar. Habrá que
decidir si se enseña aquí y en la tarjeta.

---

## 2 · Tarjeta de cliente

### Lo que se ve en la referencia

- **Formato:** 85,6 × 54 mm (tarjeta bancaria estándar), papel grueso,
  plastificada. Con borde azul, esquinas redondeadas.
- **Izquierda:** `SAHEL` / `PRODUITS D'HYGIÈNE` / hueco / **Nombre del cliente**
  / código `CL-00002` en caracteres monoespaciados sobre fondo azul.
- **Derecha:** QR con el pie «Escanear para entrega».
- Encima, un bloque de **Instrucciones** con:
  - código del cliente;
  - «Imprimir en papel grueso (85,6mm x 54mm) y plastificar»;
  - «El cliente conserva siempre la misma tarjeta; el QR es permanente»;
  - «El operador escanea el QR desde Pedidos → Escanear cliente».

### Puntos que hay que resolver antes de construirla

1. **El código.** La antigua usa `CL-00002` y la nueva mantiene ese mismo formato: `CL-00001`. Hay que
   elegir una convención y aplicarla al albarán también.
2. **«El QR es permanente» contra «revocable».** En la nueva el token se puede
   rotar al instante, y eso es una mejora que no se va a perder. La lectura
   correcta: *permanente mientras el cliente conserve la tarjeta; revocable si
   la pierde*. El botón de rotar ya existe.
3. **El nombre SÍ va impreso en la tarjeta.** Lo que no va en el QR. Son dos
   cosas distintas: la tarjeta es un documento que el cliente enseña; el QR es
   un token que la aplicación resuelve. La regla de «el QR no lleva datos
   personales» sigue intacta.
4. El QR de la referencia se ve bastante cargado. Conviene un **nivel de
   corrección alto** (`M` o `H`) para que se lea con Arenas sucias o con
   Plastic.

---

## 3 · Lo que NO se copia (errores de la aplicación antigua)

| Lo que se ve | Por qué no se reproduce |
|---|---|
| **El I.V.A. está mal.** Dice «21%» pero cobra 18%: 17,40 × 0,18 = 3,132, y 17,40 + 3,132 = 20,532. | La etiqueta y la cifra no cuadran. En la nueva, el impuesto se calcula de la tasa real del producto y el total siempre sale. |
| **La moneda no cuadra.** La configuración dice `currency: "EUR"`, pero el documento impreso muestra **FCFA**. | Hay que decidir cuál es la buena: FCFA (Malí) o EUR. **Preguntado, sin respuesta todavía.** |
| El número de pedido es `D0001` | La nueva usa `PED-2026-0001`, que ordena por año y por fecha. Se puede cambiar si se quiere, pero conviene decidirlo una vez. |
| La configuración dice `language: "es"` | La empresa está en Bamako y el documento está en español. Puede ser intencionado. No cambiar sin preguntar. |

---

## 4 · Dato de empresa (de la configuración de la antigua)

```
Nombre     SAHEL
CIF        ML12345678
Dirección  Av. de la Liberté 123, Bamako, Mali
Teléfono   +223 70 12 34 56
Email      contacto@sahel.ml
Web        www.sahel.ml
IVA        21 %
```

Estos datos tienen que salir de la **tabla `app_config` de la nueva
aplicación**, no estar escritos a fuego en el código. Así se cambian una vez y
todos los documentos los recogen.

**Pendiente:** la nueva aplicación todavía no tiene estos datos de empresa, y su
moneda sembrada es EUR. Es trabajo de la Fase 5, y necesita una respuesta
sobre FCFA vs EUR.

---

## 5 · Estado

- **Navegación móvil**: pendiente. Es lo primero.
- **Albarán imprimible**: pendiente. Fase 5.
- **Firma sobre lienzo**: pendiente. Fase 5.
- **Tarjeta de cliente**: pendiente. Fase 6.
- **Escáner de QR**: pendiente. Fase 6.

Nada de esto se ha empezado a construir. Este documento solo deja por escrito
qué tiene que existir.
