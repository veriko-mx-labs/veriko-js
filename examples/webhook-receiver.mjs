/**
 * Webhook receiver with a verified signature, in Node with no framework.
 *
 *     export VERIKO_WEBHOOK_SECRET=the_endpoint_secret
 *     node examples/webhook-receiver.mjs
 *
 * `POST /v1/webhooks` returns the secret when the endpoint is registered, once.
 * If it is lost, `client.webhooks.regenerateSecret(id)` issues a new one and the
 * previous one keeps signing for 24 hours.
 *
 * Four details of the receiver:
 *
 * 1. Verify the raw body, as it arrived. If a framework parses the JSON and you
 *    serialize it again, the bytes change and the signature stops matching. In
 *    Express that means `express.raw({ type: 'application/json' })` on this route,
 *    not `express.json()`; the rest of this file is the same.
 * 2. The delivery has 10 seconds. Answer `2xx` first and process afterwards to
 *    avoid needless retries.
 * 3. `parseWebhook()` receives the request headers and verifies the timestamped
 *    signature inside a 5 minute window against `t`, not against the `timestamp`
 *    of the body, which also discards an old delivery that someone sends again.
 *    During a rotation, set VERIKO_WEBHOOK_SECRET_PREVIOUS: the delivery then
 *    also verifies with `X-Webhook-Signature-Old`.
 * 4. A retry carries the same delivery id. Keep the ones you processed.
 */

import { createServer } from 'node:http';

import { SignatureVerificationError, isKnownWebhookEvent, parseWebhook } from '@veriko-mx/sdk';

const PORT = Number(process.env.PORT ?? 3000);

// The current secret, and the previous one while a rotation is open.
const SECRETS = [
  process.env.VERIKO_WEBHOOK_SECRET,
  process.env.VERIKO_WEBHOOK_SECRET_PREVIOUS,
].filter(Boolean);

// In production this lives in Redis or a table, and entries are kept for at least 24 hours.
const processedDeliveries = new Set();

// The order associated with each validation, by id. In production it comes from
// your database, not from an in-memory map.
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
    // The one verification path: signature, window and rotation.
    event = parseWebhook(await readBody(request), request.headers, SECRETS);
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      // The signature does not match, or the delivery is outside the window: do not process it.
      response.writeHead(400).end();
      return;
    }
    throw error;
  }

  if (event.deliveryId && processedDeliveries.has(event.deliveryId)) {
    response.writeHead(200).end(); // already processed: acknowledge the retry and ignore it
    return;
  }

  response.writeHead(200).end();

  try {
    handle(event);
    if (event.deliveryId) processedDeliveries.add(event.deliveryId);
  } catch (error) {
    // The delivery was acknowledged, so log the failure and reprocess it from your own queue.
    console.error(`[${event.event}] processing failed`, error);
  }
});

function handle(event) {
  // An event of a newer API: acknowledge it and look at `event.rawData` later.
  if (!isKnownWebhookEvent(event)) {
    console.log(`[${event.event}] event this version of the SDK does not type`);
    return;
  }

  switch (event.event) {
    case 'validation.completed': {
      const { id, attributes } = event.data;
      console.log(`[${event.event}] ${id} -> ${attributes.status}`);
      if (attributes.client_ref) console.log('  order:', attributes.client_ref);

      // `banxico_confirmed` arrives only when Banxico has confirmed the payment.
      // Compare the amount against the order before you release the goods: the
      // image of a receipt can show an amount different from the confirmed one.
      const confirmed = attributes.banxico_confirmed;
      const order = orders.get(id);
      if (confirmed && order && confirmed.amount !== order.amount) {
        console.error('  confirmed amount does not match the order:', confirmed.amount);
      }
      break;
    }
    case 'validation.returned': {
      // The validation came out `valid` and Banxico reported the return later.
      // Subscribe the endpoint to this event as well as to `validation.completed`.
      const { id, attributes } = event.data;
      console.log(
        `[${event.event}] ${id} -> ${attributes.status} (${attributes.payment_status.code})`,
      );
      if (attributes.client_ref) console.log('  order to review:', attributes.client_ref);
      break;
    }
    case 'validation.failed':
    case 'validation.error':
      console.log(`[${event.event}] ${event.data.id}`);
      break;
    case 'validation.retry.scheduled':
      console.log(`[${event.event}] ${event.data.id} will be retried`);
      break;
    case 'validation.retry.resolved':
      console.log(
        `[${event.event}] resolved after`,
        event.data.attributes.retry_state?.attempts_completed ?? 0,
        'retry(ies)',
      );
      break;
    case 'validation.retry.exhausted':
      console.log(`[${event.event}] retries ran out with no settled verdict`);
      break;
    case 'test':
      console.log(`[${event.event}] test event received`);
      break;
    default:
      // `billing.*`: the API does not publish the shape of `data`; it is in `event.rawData`.
      console.log(`[${event.event}] subscription event`);
  }
}

server.listen(PORT, () => {
  console.log(`Receiver listening on http://localhost:${String(PORT)}/hooks/veriko`);
});
