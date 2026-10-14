# ══════════════════════════════════════════════════════════════════════════════
# MATRIZ DE PERMISOS — ESTADO REAL Y CÓMO SE LLEGÓ
#
# Este documento NO cambia ningún permiso. Describe lo que hay, de dónde sale
# cada cosa y qué queda de lo que el código dice que debería haber.
# ══════════════════════════════════════════════════════════════════════════════

## 1 · DÓNDE VIVE LA VERDAD

Un permiso de la aplicación está en **DOS sitios a la vez**:

| Sitio | Qué es |
|---|---|
| `role_permissions` | La fila en la base. Lo que el servidor consulta. |
| `MODULOS` en `server/src/security/permisos.js` | La lista en el código. |

**Si no coinciden, el sistema se rompe por la mitad**, y es exactamente lo que
pasó con `rankings`:

- La fila `rankings:edit` existía en la base.
- `rankings` no estaba en `MODULOS`.
- ADMIN pasaba los 403 del servidor… pero `/auth/me` no le devolvía el permiso,
  y la interfaz, que decide con `A.puede()`, le ocultaba el apartado entero.

Un permiso que solo está en un sitio no existe a medias: no existe.

---

## 2 · ADMIN: PERMISOS CALCULADOS, NO GUARDADOS

El ADMIN **no usa la tabla**. En `permisosDe()`:

```js
if (rs.includes('ADMIN')) {
  return MODULOS.flatMap((m) => ACCIONES.map((a) => `${m}:${a}`))
}
```

Se le concede todo lo que hay en `MODULOS` × `ACCIONES`. Por eso **`MODULOS` es
crítico**: añadir un módulo ahí se lo da al ADMIN automáticamente; olvidarse
produce el fallo del punto 1.

`ADMIN` no aparece en `role_permissions` y `usuarios/rutas.js` lo impide
explícitamente: sus permisos no se tocan.

---

## 3 · LA SIEMBRA SOLO AÑADE, NUNCA QUITA

`sembrarPermisos()` inserta la matriz con `ON CONFLICT DO NOTHING`. Cada
arranque **añade** permisos que falten. **No revoca** los que sobran.

Esto tiene una consecuencia que ya se ha materializado (sección 5).

---

## 4 · MATRIZ DE ALMACÉN, TAL CUAL ESTÁ HOY

Lo que devuelven los usuarios reales, leído de `/api/auth/me`:

| Rol | Consultar entradas | Registrar stock | Imprimir etiqueta |
|---|---|---|---|
| **ADMIN** | sí | sí | sí |
| **ACCOUNTING** (contabilidad) | sí | **sí** | **sí** |
| **PRODUCTION** (producción) | sí | **sí** | **sí** |
| **JEFE_COMERCIAL** | sí (`inventory:view`) | no | no |
| **DELIVERY** (reparto) | no (solo `lots:view`) | no | no |
| **CAJAJERO** | no (solo `lots:view`) | no | no |
| **COMMERCIAL** | no | no | no |

Imprimir usa `inventory:create`, el MISMO permiso que registrar una entrada. No
es un descuido: quien puede meter 5 000 litros en el almacén puede etiquetarlos.
El caso contrario —poder gastar rollos sin poder recibir— no aporta nada.

**Imprimir NO necesita un permiso aparte** y, con la matriz actual, **imprimir
tampoco puede hacer daño**: la ruta `/inventory/lotes/:id/etiqueta/imprimir`
solo escribe en `lot_etiquetas`, que es una bitácora. No toca `lots`,
`stock_movements`, cantidades ni costes. Comprobado: tres impresiones seguidas
dejan el stock y los movimientos idénticos.

---

## 5 · ⚠ HAY UNA DIFERENCIA ENTRE EL CÓDIGO Y LA BASE

**El `seed` dice una cosa y la base hace otra.** Conviene saberlo antes de tocar
nada.

Commit `abce905` (trabajo A2) cambió esta función:

```js
// ANTES — concedía TODAS las acciones del módulo
function pv(modulo) {
  return MODULOS.includes(modulo) ? ACCIONES.map((a) => [modulo, a]) : []
}

// AHORA — solo lectura
function pv(modulo) {
  return MODULOS.includes(modulo) ? [[modulo, 'view']] : []
}
```

El cambio de intención es correcto y está bien razonado en el propio código.
**Pero la siembra solo inserta**: los permisos amplios que la versión antigua
concedió durante el instalador siguen en `role_permissions`, y arrancar el
servidor no los quita.

Resultado: `ACCOUNTING` y `PRODUCTION` conservan `inventory:create`, `:edit`,
`:delete`, `:approve` y `lots:create`, `:edit`, `:delete` **que el código ya no
quiere darles**.

**No se ha cambiado nada.** Verificarlo, documentarlo y decidir con quien
corresponda es más barato que arreglarlo a ciegas: si Contabilidad necesita
`inventory:view` para valorar existencias y hoy tiene más, restringirlos es una
decisión de negocio, no un bug de infraestructura.

`audit_log` tiene **cero** eventos `UPDATE_PERMISSIONS`: nadie lo cambió por la
interfaz. Viene del instalador, y desde ahí viene la diferencia.

---

## 6 · CÓMO SE CORREGIRÍA, SI SE DECIDE CORREGIRLO

No se ha hecho. Se deja escrito para que sea una decisión y no un descuido.

Un permiso por rol, borrando primero lo que sobra:

```sql
DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE code = 'ACCOUNTING')
   AND permission_id IN (SELECT id FROM permissions WHERE module = 'inventory');
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE code = 'ACCOUNTING'), id FROM permissions
 WHERE module = 'inventory' AND action = 'view'
ON CONFLICT DO NOTHING;
```

**Antes de ejecutarlo, probar qué se rompe.** Con los permisos actuales,
Contabilidad y Producción pueden registrar entradas y lanzar producciones; si
alguien usa eso a diario, quitarlo les para el trabajo de un día sin avisar.

---

## 7 · REGLAS QUE NO SE TOCAN

- El backend es la garantía. Ocultar un botón es cortesía; el 403 es la puerta.
- Un permiso ausente en `MODULOS` **falla cerrado**: nadie lo tiene.
- `COMMERCIAL` no recibe `permissions:*` ni `users:*`. Está comprobado dentro
  de la migración 037 y vuelve a comprobarlo la 038.
- Los puntos son posición, no dinero. Un comercial no puede concederse puntos.
