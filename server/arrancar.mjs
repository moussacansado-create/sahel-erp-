/** Arranca la API + la interfaz sobre la base de pruebas local. */
process.env.DATABASE_URL = ''
process.env.JWT_SECRET = process.env.JWT_SECRET || 'clave-de-pruebas-interfaz-suficientemente-larga-1234567890'
process.env.NODE_ENV = 'development'
process.env.PORT = process.env.PORT || '10000'
const { createApp } = await import('/workspace/cleansahel-v2/server/src/app.js')
const { getDb } = await import('/workspace/cleansahel-v2/server/src/db/client.js')
const { migrar } = await import('/workspace/cleansahel-v2/server/src/db/migrador.js')

//
// SE APLICAN LAS MIGRACIONES PENDIENTES ANTES DE ESCUCHAR.
//
// Este arranque importaba `app.js` directamente y se saltaba `src/index.js`, que
// es quien llama a `migrar()`. Consecuencia: la base se quedaba donde estaba
// y el servidor arrancaba igual, pareciéndase normal, sin avisar.
//
// No es un fallo ruidoso, y por eso es peligroso: se redea una migración que
// cambia una columna de NUMERIC(18,2) a NUMERIC(18,4) y la aplicación sigue en
// marcha, guardando los importes redondeados igual que antes, con el mismo
// aspecto y el mismo número. Nadie se entera hasta que alguien mira la
// definición de la columna.
//
// Aplicar lo pendiente al arrancar es lo que hace cualquier ORM, y aquí es
// además la diferencia entre una migración y un olvido.
//
const { aplicadas } = await migrar({ silencioso: true })
if (aplicadas > 0) {
  console.log(`  Esquema actualizado: ${aplicadas} migración(es) aplicada(s).`)
}

const app = createApp()
await getDb()
const PUERTO = Number(process.env.PORT)
app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`CleanSahel ERP escuchando en http://localhost:${PUERTO}`)
  console.log('  Base de datos: PRUEBAS LOCALES (PGlite) — nada de producción.')
  if (process.env.PUBLIC === '1') {
    console.log('')
    console.log('  ⚠  ENTORNO DE PRUEBAS EXPUESTO A INTERNET')
    console.log('     Usuarios de demostración con contraseña conocida.')
    console.log('     No sirve para datos reales. No lo abras más de lo necesario.')
  }
})
