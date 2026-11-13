/**
 * Queue validations, register the webhook that collects them, and poll.
 *
 *     export VERIKO_API_KEY=veriko_your_key_here
 *     node examples/async-and-webhooks.mjs
 *
 * This is the path for volume: the API accepts each request at once and the
 * verdict arrives later, by webhook or by polling.
 */

import { writeFile } from 'node:fs/promises';

import { ApiError, TimeoutError, Veriko, hasCep } from '@veriko-mx/sdk';

const client = new Veriko(); // reads VERIKO_API_KEY from the environment

// 1. The endpoint that receives the verdicts. The secret travels once.
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/veriko',
  events: ['validation.completed', 'validation.retry.resolved'],
});
console.log('Endpoint', endpoint.id, 'registered');
console.log('Signing secret:', endpoint.attributes.secret, '(the API does not deliver it again)');

// 2. A test event confirms the receiver is reachable before real traffic goes out.
const test = await client.webhooks.test(endpoint.id);
if (!test.attributes?.delivered) {
  console.error('The receiver did not accept the test event:', test.attributes?.error);
  process.exit(1);
}
console.log('Test delivered in', test.attributes.response_time_ms, 'ms');

// 3. The transfers to validate. The idempotency key comes from the order number,
//    not from a random value, so a resend does not duplicate the charge.
//    `clientRef` relates the validation to an order of your own.
const transfers = [
  {
    sendDate: '2025-03-15',
    amount: 15000.5,
    trackingKey: 'MXBA20250315001234',
    beneficiaryAccount: '012180004412345678',
    clientRef: 'order-4f3a2b1c',
    idempotencyKey: 'order-4f3a2b1c',
  },
  {
    sendDate: '2025-03-15',
    amount: 2300,
    trackingKey: 'MXBA20250315005678',
    beneficiaryAccount: '012180004412345678',
    clientRef: 'order-7c2d9e0a',
    idempotencyKey: 'order-7c2d9e0a',
  },
];

const queuedValidations = [];
for (const transfer of transfers) {
  try {
    queuedValidations.push(await client.validations.enqueue(transfer));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error('Rejected:', error.code, '-', error.detail);
  }
}
console.log('Queued', queuedValidations.length, 'validations');

// 4. With the webhook registered, the verdict arrives on its own. Polling suits a
//    process that needs the result before it continues. waitFor() honors the
//    pauses the API asks for.
for (const queued of queuedValidations) {
  let validation;
  try {
    validation = await client.validations.waitFor(queued, { timeoutMs: 120_000 });
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    console.error(queued.id, 'has no settled verdict after', error.timeoutMs, 'ms');
    continue;
  }

  console.log(validation.id, '->', validation.attributes.status);
  if (hasCep(validation)) {
    const cep = await client.validations.cep(validation.id, { format: 'pdf' });
    await writeFile(cep.filename, cep.content);
    console.log('  receipt in', cep.filename);
  }
}
