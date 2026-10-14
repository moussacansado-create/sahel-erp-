/**
 * TARJETA DE CLIENTE
 *
 * La tarjeta es un trozo de plástico que el cliente se lleva a casa y que
 * vuelve a aparecer en la puerta del almacén dentro de un año. Eso decide dos
 * cosas:
 *
 * · EL QR NO LLEVA NINGUNA DIRECCIÓN. Si codificara una URL, el dominio
 *   quedaría grabado en el plástico, y el día que se cambie de servidor todas
 *   las tarjetas repartidas dejan de servir. Va solo el token, que es opaco y
 *   no depende de dónde se escanee.
 *
 * · EL QR NO LLEVA DATOS PERSONALES. Ciento noventa y dos bits de entropía,
 *   base64url, ni una letra del nombre ni un dígito del teléfono. El nombre SÍ
 *   va impreso en la tarjeta, que es un documento que el cliente enseña a
 *   propósito; el QR es un token que la aplicación resuelve. Son dos cosas
 *   distintas y no se mezclan.
 *
 * · NIVEL DE CORRECCIÓN ALTO. La referencia antigua venía bastante cargada, y
 *   estas tarjetas van plastificadas, sucias y a contraluz. Con `H` aguanta
 *   hasta un 30 % del área tapada. Con el nivel por defecto, se lee en el
 *   despacho y falla en la calle, que es donde de verdad se usa.
 */

import QRCode from 'qrcode'

/** El prefijo que precede al token en la tarjeta. Facilita leerlo a mano. */
const PREFIJO = 'CS-'

/** Lo que se imprime en el cuadradito. Token, y nada más. */
export function contenidoQr(token) {
  return `${PREFIJO}${token}`
}

/**
 * La imagen del QR en PNG.
 *
 * @param {string} token  el `qr_token` del cliente
 * @param {number} margen módulos de margen, en blanco alrededor
 * @returns {Promise<Buffer>} PNG
 */
export async function imagenQr(token, { tamano = 320, margen = 2 } = {}) {
  if (!token) throw new Error('Ese cliente no tiene tarjeta')
  return QRCode.toBuffer(contenidoQr(token), {
    type: 'png',
    errorCorrectionLevel: 'H',   // 30 % de tolerancia: tarjeta sucia y plastificada
    margin: margen,
    scale: 1,
    width: tamano,
    color: { dark: '#0d1b2a', light: '#ffffff' },
  })
}

/**
 * Lo que lleva la tarjeta impresa.
 *
 * Se arma en el servidor para que la tarjeta de papel y lo que ve el repartidor
 * en la pantalla no puedan contradecirse: mismo nombre, mismo código, misma
 * empresa.
 */
export function datosTarjeta({ cliente, empresa }) {
  return {
    codigo: cliente.code,
    nombre: cliente.company_name || cliente.name,
    // Si el cliente tiene razón social, el nombre comercial también se imprime
    // debajo: el repartidor lo reconoce por el rótulo del local, no por el
    // titular de la factura.
    titular: cliente.company_name && cliente.name ? cliente.name : null,
    token: contenidoQr(cliente.qr_token),
    empresa: {
      nombre: empresa.nombre,
      descriptor: empresa.descriptor,
      telefono: empresa.telefono,
      web: empresa.web,
    },
  }
}

/**
 * Lo que se le dice a quien va a repartir cuando escanea.
 *
 * Sin datos que no necesite: en la calle no se le va a abrir el límite de
 * crédito del cliente delante de él.
 */
export function resumenEntrega(cliente, pedidos) {
  return {
    id: cliente.id,
    codigo: cliente.code,
    // Se renombra a propósito para el móvil del repartidor, donde el cliente se
    // llama por su rótulo de local y no por su titular de factura.
    nombre: cliente.company_name || cliente.name,
    valido: true,
    pedidos_pendientes: (pedidos || []).map((p) => ({
      order_id: p.order_id,
      order_code: p.order_code,
      status: p.status,
      qty_pending: p.qty_pending,
    })),
  }
}
