# CleanSahel ERP — Documentación

Aplicación nueva para la fábrica y distribución de productos de higiene en Mali.
Construida desde cero, separada por completo de la aplicación anterior.

## Documentación

- **[ARQUITECTURA.md](ARQUITECTURA.md)** — el modelo entero: entidades, relaciones,
  estados, permisos, flujos y las reglas que el sistema garantiza.
- **[DESPLIEGUE.md](DESPLIEGUE.md)** — entornos separados y configuración prevista
  para Render PostgreSQL. *(Todavía no se ha creado nada en producción.)*
- **[SEGURIDAD.md](SEGURIDAD.md)** — modelo de autenticación, sesiones y permisos.

## Estructura

```
cleansahel-v2/
├── db/
│   └── migrations/       SQL versionado, solo hacia adelante
├── server/
│   ├── src/
│   │   ├── config/       Variables de entorno, validadas al arrancar
│   │   ├── db/           Cliente, migrador, semillas
│   │   ├── security/     Hash, tokens, sesiones, permisos
│   │   └── core/         Libro mayor de stock, FEFO
│   └── tests/            Pruebas sobre PostgreSQL real
└── docs/
```

## Puesta en marcha

```bash
npm install

# Obligatorio: sin esto la aplicación no arranca (a propósito)
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

# Desarrollo: PostgreSQL local en WASM, sin instalar nada
npm run migrate     # crea el esquema y los datos del sistema
npm run dev         # arranca la API en el puerto 3000

# Pruebas
npm test            # núcleo: stock, lotes, permisos, auditoría
npm run test:auth   # autenticación, sesiones, usuarios, roles
npm run test:all    # las dos
```

Para trabajar contra un PostgreSQL de servidor, basta con `DATABASE_URL`.

## Reglas que no se negocian

1. **El stock vive solo en los lotes.** La tabla `items` no tiene columna de
   stock, y eso es deliberado: nadie puede escribir existencias donde no hay
   dónde hacerlo.
2. **Toda escritura pasa por una transacción.** Si algo falla a mitad, no queda
   nada a medias.
3. **El libro mayor manda.** `stock_movements` es la explicación de cada cambio
   de existencias, y no se puede editar ni borrar.
4. **Reservar no es consumir.** El stock baja una sola vez, al entregar.
5. **Los permisos se comprueban en el backend**, no solo ocultando botones.
6. **Ningún dato de ejemplo.** Ni clientes, ni pedidos, ni artículos de prueba.
   Los carga la empresa.
7. **Ningún secreto en el repositorio.** Si falta una variable obligatoria, la
   aplicación no arranca.

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Arquitectura, modelo de datos, seguridad | ✅ Hecha |
| 1 | Usuarios, autenticación, sesiones, roles y permisos | ✅ Hecha |
| 2 | Materias primas, envases, productos, inventario | Pendiente |
| 3 | Lotes, recetas, producción, mermas | Pendiente |
| 4 | Pedidos, clientes, QR, entregas | Pendiente |
| 5 | Comerciales, ventas, zonas, mapa | Pendiente |
| 6 | Trazabilidad, recalls, historial | Pendiente |
| 7 | Compras, proveedores, gastos | Pendiente |
| 8 | Dashboard, informes, análisis | Pendiente |
| 9 | Interfaz profesional, móvil, tablet | Pendiente |
| 10 | Pruebas completas, backups, producción | Pendiente |
