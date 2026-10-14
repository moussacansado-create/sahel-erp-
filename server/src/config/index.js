/**
 * Configuración y secretos.
 *
 * El proceso NO ARRANCA si falta una variable obligatoria. No hay valores por
 * defecto: en la aplicación anterior, `JWT_SECRET` tenía un valor de reserva
 * escrito en el repositorio, y como el repositorio era público, cualquiera
 * podía firmar un token de administrador.
 */

/** Variables sin las cuales la aplicación no puede funcionar. */
const OBLIGATORIAS = ['JWT_SECRET']

/** Variables opcionales, con su valor por defecto y su motivo. */
const OPCIONALES = {
  NODE_ENV:            { valor: 'development',  motivo: 'entorno de ejecución' },
  PORT:                { valor: 3000,          motivo: 'puerto HTTP' },
  DATABASE_URL:        { valor: null,          motivo: 'PostgreSQL; si falta, se usa PGlite local' },
  DATABASE_SSL:        { valor: 'true',        motivo: 'TLS con PostgreSQL gestionado' },
  ACCESS_TOKEN_TTL:    { valor: '15m',         motivo: 'duración del token de acceso' },
  REFRESH_TOKEN_TTL:   { valor: '7d',          motivo: 'duración de la sesión' },
  BCRYPT_COST:         { valor: 12,            motivo: 'coste del hash de contraseña' },
  MAX_FAILED_ATTEMPTS: { valor: 5,             motivo: 'intentos antes de bloquear' },
  LOCK_MINUTES:        { valor: 15,            motivo: 'minutos de bloqueo' },
  CORS_ORIGINS:        { valor: null,          motivo: 'orígenes permitidos, separados por coma' },
  ALLOWED_CLOCK_SKEW:  { valor: 30,            motivo: 'tolerancia de reloj del token, en segundos' },
}

const problemas = []
const config = {}

for (const [nombre, def] of Object.entries(OPCIONALES)) {
  const bruto = process.env[nombre]
  config[nombre] = bruto === undefined || bruto === '' ? def.valor : bruto
}

// Las obligatorias no tienen valor de reserva. Ni uno.
for (const nombre of OBLIGATORIAS) {
  const valor = process.env[nombre]
  if (!valor || valor.length < 32) {
    problemas.push(
      !valor
        ? `${nombre} no está definida en el entorno`
        : `${nombre} es demasiado corta (mínimo 32 caracteres)`,
    )
  }
  config[nombre] = valor || null
}

if (problemas.length) {
  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  ARRANQUE ABORTADO: falta configuración de seguridad        ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  for (const p of problemas) console.error(`  ✗ ${p}`)
  console.error('')
  console.error('  Esta aplicación no tiene secretos por defecto, a propósito.')
  console.error('  Para generar uno:')
  console.error("    node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"")
  console.error('')
  throw new Error('Configuración de seguridad incompleta')
}

export default config
export const esProduccion = () => config.NODE_ENV === 'production'
export const origenesPermitidos = () =>
  (config.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
