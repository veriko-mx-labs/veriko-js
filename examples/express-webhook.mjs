/**
 * Receptor de webhooks con Express, con la firma verificada.
 *
 *     npm install express
 *     export VERIKO_WEBHOOK_SECRET=el_secreto_del_endpoint
 *     node examples/express-webhook.mjs
 *
 * El secreto lo devuelve `POST /v1/webhooks` al registrar el endpoint, una sola
 * vez. Si se pierde, se rota con `POST /v1/webhooks/{id}/regenerate-secret`.
 *
 * Dos detalles del receptor:
 *
 * 1. `express.raw()` en esta ruta, no `express.json()`. Lo que se firma es el
 *    cuerpo crudo; si Express interpreta el JSON, volver a serializarlo cambia
 *    los bytes y rompe la firma.
 * 2. La entrega dispone de 10 segundos. Responder `2xx` primero y procesar
 *    después evita reintentos innecesarios.
 */

import express from 'express';

import { SignatureVerificationError, parseWebhook } from '@veriko-mx/sdk';

const app = express();
const SECRET = process.env.VERIKO_WEBHOOK_SECRET;

// Las entregas se repiten: un reintento trae el mismo Delivery-Id. En producción
// esto vive en Redis o en una tabla, no en memoria.
const entregasVistas = new Set();

app.post('/hooks/veriko', express.raw({ type: 'application/json' }), (request, response) => {
  const deliveryId = request.get('X-Veriko-Delivery-Id');

  let evento;
  try {
    evento = parseWebhook(request.body, request.get('X-Webhook-Signature'), SECRET);
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      // Firma que no cuadra: el cuerpo no se procesa.
      response.sendStatus(400);
      return;
    }
    throw error;
  }

  if (entregasVistas.has(deliveryId)) {
    response.sendStatus(200); // ya se procesó; el reintento se acusa y se ignora
    return;
  }
  entregasVistas.add(deliveryId);

  response.sendStatus(200);

  switch (evento.event) {
    case 'validation.completed':
      console.log(`[${evento.event}] ${evento.data.id} → ${evento.data.attributes.status}`);
      if (evento.data.links?.cep_pdf) {
        console.log('  comprobante disponible en', evento.data.links.cep_pdf);
      }
      break;
    case 'validation.retry.resolved':
      console.log(
        `[${evento.event}] resuelto tras`,
        evento.data.attributes.retry_state?.attempts_completed ?? 0,
        'reintento(s)',
      );
      break;
    case 'validation.retry.exhausted':
      console.log(`[${evento.event}] se agotaron los reintentos sin veredicto firme`);
      break;
    default:
      console.log(`[${evento.event}] evento sin tratamiento propio`);
  }
});

app.listen(3000, () => {
  console.log('Receptor escuchando en http://localhost:3000/hooks/veriko');
});
