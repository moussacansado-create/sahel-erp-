// El canal de sincronización. Server-Sent Events, no WebSocket: el tráfico es
// de una sola dirección, es HTTP de verdad, atraviesa proxys sin que haya que
// negociar nada y reconecta solo. Un WebSocket aquí sería más grueso y no
// aportaría nada, porque el móvil nunca manda por el canal: manda por la API.
import { Router } from 'express'
import { requiereSesion } from '../../security/permisos.js'
import { query, one } from '../../db/client.js'
import { alCambiar, arrancarSincronizacion } from '../../core/sincronizacion.js'

const router = Router()
const auth = requiereSesion({ query, one })

router.get('/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // para que un proxy no se trague el flujo
  })
  res.write('retry: 3000\n\n')   // reconexión en 3 s si se cae la red

  const mandar = ({ tablas }) => {
    res.write(`event: cambio\ndata: ${JSON.stringify({ tablas })}\n\n`)
  }
  res.write(`event: listo\ndata: ${JSON.stringify({ ok: true })}\n\n`)

  const quitar = alCambiar(mandar)
  // Latido: sin esto, un móvil en una red móvil que se queda callada sin
  // decir nada puede estar pensando que la conexión sigue viva cuando ya no.
  const latido = setInterval(() => res.write(': latido\n\n'), 25000)

  req.on('close', () => { clearInterval(latido); quitar() })
})

router.get('/estado', auth, async (req, res) => {
  const f = await query('select coalesce(max(id), 0) as m, count(*)::int as n from cambios')
  res.json({ ok: true, cambios: f[0].m, ventana: f[0].n })
})

arrancarSincronizacion()
export default router
