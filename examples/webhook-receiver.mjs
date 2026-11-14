/**
 * Receptor de webhooks con firma verificada, en Node sin framework.
 *
 *     export VERIKO_WEBHOOK_SECRET=el_secreto_del_endpoint
 *     node examples/webhook-receiver.mjs
 *
 * `POST /v1/webhooks` devuelve el secreto al registrar el endpoint, una sola vez. Si se pierde,
 * `client.webhooks.regenerateSecret(id)` emite uno nuevo y el anterior sigue firmando durante 24
 * horas.
 *
 * Cuatro detalles del receptor:
 *
 * 1. Verifica el cuerpo crudo, tal como llegó. Si un framework interpreta el JSON y lo
 *    serializas de nuevo, los bytes cambian y la firma deja de coincidir. En
 *    Express eso significa `express.raw({ type: 'application/json' })` en esta ruta,
 *    no `express.json()`; el resto de este archivo es igual.
 * 2. La entrega tiene 10 segundos. Responde `2xx` primero y procesa después para
 *    evitar reintentos innecesarios.
 * 3. `parseWebhook()` recibe las cabeceras de la petición y verifica la firma con
 *    marca de tiempo dentro de una ventana de 5 minutos contra `t`, no contra el
 *    `timestamp` del cuerpo, lo que además descarta una entrega vieja que alguien reenvía.
 *    Durante una rotación, define VERIKO_WEBHOOK_SECRET_PREVIOUS: la entrega se
 *    verifica entonces también con `X-Webhook-Signature-Old`.
 * 4. Un reintento trae el mismo id de entrega. Guarda los que ya procesaste.
 */

import { createServer } from 'node:http';

import { SignatureVerificationError, isKnownWebhookEvent, parseWebhook } from '@veriko-mx/sdk';

const PORT = Number(process.env.PORT ?? 3000);

// El secreto actual, y el anterior mientras hay una rotación abierta.
const SECRETS = [
  process.env.VERIKO_WEBHOOK_SECRET,
  process.env.VERIKO_WEBHOOK_SECRET_PREVIOUS,
].filter(Boolean);

// En producción esto vive en Redis o en una tabla, y las entradas se guardan al menos 24 horas.
const processedDeliveries = new Set();

// El pedido asociado a cada validación, por id. En producción sale de tu base de datos, no de un
// mapa en memoria.
const orders = new Map(); // validationId -> { amount }

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/hooks/veriko') {
    response.writeHead(404).end();
    return;
  }

  let event;
  try {
    // El único camino de verificación: firma, ventana y rotación.
    event = parseWebhook(await readBody(request), request.headers, SECRETS);
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      // La firma no coincide, o la entrega está fuera de la ventana: no la proceses.
      response.writeHead(400).end();
      return;
    }
    throw error;
  }

  if (event.deliveryId && processedDeliveries.has(event.deliveryId)) {
    response.writeHead(200).end(); // ya procesada: acusa recibo del reintento e ignóralo
    return;
  }

  response.writeHead(200).end();

  try {
    handle(event);
    if (event.deliveryId) processedDeliveries.add(event.deliveryId);
  } catch (error) {
    // La entrega ya se confirmó, así que registra el fallo y vuelve a procesarla desde tu propia
    // cola.
    console.error(`[${event.event}] falló el procesamiento`, error);
  }
});

function handle(event) {
  // Un evento de una API más nueva: acusa recibo y revisa `event.rawData` después.
  if (!isKnownWebhookEvent(event)) {
    console.log(`[${event.event}] evento que esta versión del SDK no tipa`);
    return;
  }

  switch (event.event) {
    case 'validation.completed': {
      const { id, attributes } = event.data;
      console.log(`[${event.event}] ${id} -> ${attributes.status}`);
      if (attributes.client_ref) console.log('  pedido:', attributes.client_ref);

      // `banxico_confirmed` llega sólo cuando Banxico ya confirmó el pago.
      // Compara el importe contra el pedido antes de liberar la mercancía: la
      // imagen de un comprobante puede mostrar un importe distinto del confirmado.
      const confirmed = attributes.banxico_confirmed;
      const order = orders.get(id);
      if (confirmed && order && confirmed.amount !== order.amount) {
        console.error('  el importe confirmado no coincide con el pedido:', confirmed.amount);
      }
      break;
    }
    case 'validation.returned': {
      // La validación salió `valid` y Banxico reportó la devolución después.
      // Suscribe el endpoint a este evento además de `validation.completed`.
      const { id, attributes } = event.data;
      console.log(
        `[${event.event}] ${id} -> ${attributes.status} (${attributes.payment_status.code})`,
      );
      if (attributes.client_ref) console.log('  pedido por revisar:', attributes.client_ref);
      break;
    }
    case 'validation.failed':
    case 'validation.error':
      console.log(`[${event.event}] ${event.data.id}`);
      break;
    case 'validation.retry.scheduled':
      console.log(`[${event.event}] ${event.data.id} se reintentará`);
      break;
    case 'validation.retry.resolved':
      console.log(
        `[${event.event}] resuelto después de`,
        event.data.attributes.retry_state?.attempts_completed ?? 0,
        'reintento(s)',
      );
      break;
    case 'validation.retry.exhausted':
      console.log(`[${event.event}] se agotaron los reintentos sin un veredicto asentado`);
      break;
    case 'test':
      console.log(`[${event.event}] evento de prueba recibido`);
      break;
    default:
      // `billing.*`: la API no publica la forma de `data`; está en `event.rawData`.
      console.log(`[${event.event}] evento de suscripción`);
  }
}

server.listen(PORT, () => {
  console.log(`Receptor escuchando en http://localhost:${String(PORT)}/hooks/veriko`);
});
