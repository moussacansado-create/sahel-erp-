# ══════════════════════════════════════════════════════════════════════════════
# COPIAS Y RESTAURACIÓN DE LA BASE DE DATOS
#
# ── POR QUÉ ESTE DOCUMENTO EXISTE ───────────────────────────────────────────
#
# La base de desarrollo es PGlite: un PostgreSQL dentro de un WebAssembly. No es
# un proceso aparte — el servidor Node ES la base de datos, y el directorio
# `.pgdata` está abierto mientras el proceso vive.
#
# Abrir ese directorio con un segundo programa mientras el servidor está en
# marcha hace que los dos escriban a la vez, el WASM aborta y la base queda
# ilegible. Ha pasado CUATRO veces en este proyecto. Cada vez, la única salida
# fue restaurar de una copia.
#
# La regla es corta:
#
#   NUNCA abras, copies a mano ni borres `.pgdata` con el servidor encendido.
#
# ── LAS DOS ÚNICAS FORMAS LEGÍTIMAS ─────────────────────────────────────────
#
#   A) COPIA en caliente, con el servidor PARADO
#   B) SCRIPT contra la base, con el servidor PARADO y comprobado
#
# ── LO QUE NUNCA SE HACE ─────────────────────────────────────────────────────
#
#   · `kill -9` al servidor con la base abierta.
#   · `cp -r .pgdata` con el servidor corriendo «porque no pasa nada». PASA.
#   · Borrar una base dañada. Se APARTA, con su hora en el nombre.
#   · Restaurar una copia «por si acaso». Solo si hay un problema real.
#   · Reaplicar migraciones a mano. Se aplican solas al arrancar.
# ══════════════════════════════════════════════════════════════════════════════


## ═══ 1 · PARAR EL SERVIDOR ═════════════════════════════════════════════════

```sh
sh server/parar.sh
```

Qué hace y por qué:

1. Manda `SIGINT` y **espera**. Un servidor bien cerrado suelta la base él solo.
2. Cuenta los procesos vivos mirando `stat`, no el PID a secas: los `<defunct>`
   son zombis, ya están muertos y no sujetan nada, pero su línea de comando sigue
   en `/proc` y `pgrep` los cuenta. Contarlos como vivos es lo que hace que
   `pgrep -f arrancar.mjs` devuelva un número y alguien abra la base sin parar
   de verdad.
3. Comprueba que el **puerto 10000 queda libre**. Con el proceso muerto pero el
   puerto ocupado hay OTRO servidor detrás, y abrir la base a mano es
   exactamente el error que se quiere evitar.

Devuelve 0 solo cuando se puede trabajar con `.pgdata`. Si devuelve 1: **no
tocas la base**. Mira quién la ocupa:

```sh
ps -eo pid,stat,args | grep -v defunct | grep arrancar
```

---

## ═══ 2 · COPIAR (con el servidor parado) ═══════════════════════════════════

```sh
sh server/parar.sh
mkdir -p respaldos-produccion/antes-de-<motivo>-$(date +%Y%m%d-%H%M%S)
cp -r server/.pgdata respaldos-produccion/antes-de-<motivo>-<hora>/pgdata
sh server/reiniciar.sh
```

Copiar `.pgdata` con el servidor parado es una copia consistente: no hay
escrituras a medias porque no hay nadie escribiendo.

**Se copia el directorio ENTERO.** No sirve copiar archivos sueltos: PGlite
mantiene el estado del motor repartido y una copia parcial no arranca.

**Antes de dar por buena una copia, verifícala:**

```sh
cd server && PGLITE_DIR=./.pgdata-test node -e "
process.env.PGLITE_DIR='./la-copia'
const {query,closeDb}=await import('./src/db/client.js')
console.log(await query('select count(*) from lots')); await closeDb()"
```

Una copia que no se ha leído alguna vez no es una copia: es una carpeta con
confianza.

---

## ═══ 3 · RESTAURAR (solo con problema real) ═════════════════════════════════

**El orden importa. Apartar ANTES de restaurar, siempre.**

```sh
sh server/parar.sh

# 1 · APARTAR la dañada. No se borra: puede servir, y explica qué pasó.
mv server/.pgdata server/.pgdata-corrupta-$(date +%H%M%S)

# 2 · RESTAURAR
cp -r respaldos-produccion/<la-copia>/pgdata server/.pgdata

# 3 · ARRANCAR. Las migraciones pendientes se aplican solas.
sh server/reiniciar.sh
```

Las bases apartadas se acumulan en `server/`. Cuando ya haya demasiadas y se
quiera limpiar, se borran **las apuntadas en este documento**, nunca una
`.pgdata` a secas:

| Nombre | Cuándo |
|---|---|
| `.pgdata-corrupta-20261009-114505` | script abierto con el servidor vivo (etiquetas) |
| `.pgdata-corrupta-123955` | server que tardó en soltar el bloqueo |

**Una copia restaurada puede quedarse atrás respecto al código.** Si restauraste
de una copia anterior a una migración, no hay que reaplicarla a mano: al
arrancar, el migrador compara `schema_migrations` con el disco y aplica lo que
falte, en orden, cada migración en su propia transacción. Si una migración se
aplica a medias, la transacción se deshace entera: no quedan columnas a mitad.

---

## ═══ 4 · SCRIPT CONTRA LA BASE ══════════════════════════════════════════════

A veces hay que mirar dentro o hacer limpieza. También con el servidor parado.

```sh
sh server/parar.sh
cd server
JWT_SECRET=x node /ruta/al/script.mjs
sh server/reiniciar.sh
```

El script **siempre** empieza con `PGLITE_DIR` explícito. Sin él, el cliente de
base de datos resuelve la ruta relativa al módulo importado y puede abrir
`../.pgdata` en lugar de `./.pgdata`, que es como seauthentica el admin y falla
con `CREDENCIALES_INVALIDAS` sin explicar por qué.

```js
process.env.PGLITE_DIR = './.pgdata'        // OBLIGATORIO
const { query, closeDb } = await import('/…/src/db/client.js')
```

**Y cierra siempre.** Un `closeDb()` que falta deja el directorio abierto y el
siguiente programa sePegase la base por sorpresa.

---

## ═══ 5 · CUANDO LA BASE PARECE DAÑADA ══════════════════════════════════════

El síntoma es siempre el mismo:

```
Error [TypeError]: Aborted(). Build with -sASSERTIONS for more info.
```

Significa que el WASM abortó. **No arregles la base**: restáurala. Y antes de
hacer nada, comprueba que no es un problema de proceso:

```sh
ps -eo pid,stat,args | grep -v defunct | grep arrancar
```

Si no hay nadie, la base está dañada de verdad. Si hay alguien, el problema es
que hay dos programas encima.

---

## ═══ 6 · PRODUCCIÓN ═════════════════════════════════════════════════════════

Nada de esto aplica a producción, y no por un capricho.

PGlite es un PostgreSQL en memoria dentro del proceso: una sola conexión, sin
red, sin usuarios, sin permisos reales. En producción el destino es
**PostgreSQL de verdad** vía `DATABASE_URL`, con su propio `pg_dump` diario,
su réplica y sus usuarios. Cuando se migre, este documento deja de aplicar y el
procedimiento pasa a ser el de PostgreSQL.

**Hasta que exista esa decisión, el único servidor de base de datos que hay es
PGlite, y por eso hay que tratarlo como si fuera un proceso: se para, se copia,
se arranca. Nunca se toca por debajo mientras está vivo.**
