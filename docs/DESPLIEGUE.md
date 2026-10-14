# Despliegue — infraestructura prevista

> **Nada de esto está creado todavía.** Es la configuración que se usará cuando
> se autorice. La aplicación antigua y su base de datos no se tocan.

## Separación de entornos

| | Base de datos | Datos | Origen |
|---|---|---|---|
| **Desarrollo** | PGlite local (WASM) | Efímera, se recrea | Sin configurar nada |
| **Pruebas** | PGlite local | Efímera | `npm test` levanta y tira |
| **Producción** | Render PostgreSQL, Oregon | Persistente | `DATABASE_URL` |

El código es el mismo en los tres: cambia la variable `DATABASE_URL`, nada más.
Las pruebas nunca tocan la base de producción, ni por accidente.

## Base de datos de producción (pendiente de crear)

Cuando se autorice:

- **Tipo:** Render PostgreSQL
- **Región:** `oregon` — la misma que el servicio web, para que la conexión sea interna
- **Plan:** el mínimo que aguante la carga prevista; se puede ampliar sin downtime
- **Sin datos antiguos:** se crea vacía y la pueban las migraciones
- **Conexión interna:** `postgresql://<host>/<db>` desde Render, sin salir a internet

## Variables de entorno de producción

Obligatorias. La aplicación **no arranca** sin ellas:

```
DATABASE_URL=postgresql://...
JWT_SECRET=<96 caracteres aleatorios>
```

Opcionales, con su valor por defecto:

```
NODE_ENV=production
PORT=10000
DATABASE_SSL=false            # la conexión interna de Render no lleva TLS
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=7d
MAX_FAILED_ATTEMPTS=5
LOCK_MINUTES=15
CORS_ORIGINS=https://<dominio-web>
```

La primera vez, si la base está vacía:

```
ADMIN_EMAIL=...  ADMIN_PASSWORD=...  ADMIN_NAME=Administrador
```

Solo se usan **una vez**, al crear el primer administrador. Después el usuario
debe cambiar la contraseña. Si no se definen, la aplicación avisa y **no crea
ninguna cuenta**: es preferible quedarse cerrado que dejar una credencial
conocida.

## Copias de seguridad

`pg_dump` diario con retención, y una copia antes de cada migración. La
recuperación se prueba de verdad, no se da por supuesta: un backup que nunca
se ha restaurado no es un backup.

En la aplicación antigua el "respaldo" era copiar un fichero SQLite mientras
el servicio estaba corriendo, sin verificar nada. Eso queda atrás.

## Migraciones en producción

Solo hacia adelante, y **una por una**, con su registro. El migrador comprueba
el checksum de cada migración aplicada: si alguien edita una ya ejecutada, para
y avisa en vez de dejar el esquema incoherente.

```bash
# Antes de desplegar, contra una copia
npm run migrate

# Si algo va mal, se revierte el despliegue, no la base: las migraciones
# nunca se deshacen solas.
```

## Orden de puesta en marcha

1. Crear el PostgreSQL en Render (Oregon) y anotar la URL **interna**
2. Configurar las variables de entorno del servicio web
3. Desplegar: el arranque aplica las migraciones y crea el primer admin
4. Entrar, cambiar la contraseña del admin
5. Verificar que la aplicación responde y que el schema está completo
6. Solo entonces, empezar a cargar datos reales
