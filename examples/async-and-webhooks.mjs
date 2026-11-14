/**
 * Pone validaciones en cola, registra el webhook que las recibe y consulta.
 *
 *     export VERIKO_API_KEY=veriko_tu_clave_aqui
 *     node examples/async-and-webhooks.mjs
 *
 * Es el camino para volumen: la API acepta cada petición de inmediato y el veredicto llega después,
 * por webhook o consultando.
 */

import { writeFile } from 'node:fs/promises';

import { ApiError, TimeoutError, Veriko, hasCep } from '@veriko-mx/sdk';

const client = new Veriko(); // lee VERIKO_API_KEY del entorno

// 1. El endpoint que recibe los veredictos. El secreto viaja una sola vez.
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/veriko',
  events: ['validation.completed', 'validation.retry.resolved'],
});
console.log('Endpoint', endpoint.id, 'registrado');
console.log('Secreto de firma:', endpoint.attributes.secret, '(la API no lo entrega de nuevo)');

// 2. Un evento de prueba confirma que el receptor responde antes de enviar tráfico real.
const test = await client.webhooks.test(endpoint.id);
if (!test.attributes?.delivered) {
  console.error('El receptor no aceptó el evento de prueba:', test.attributes?.error);
  process.exit(1);
}
console.log('Prueba entregada en', test.attributes.response_time_ms, 'ms');

// 3. Las transferencias por validar. La clave de idempotencia sale del número de pedido,
//    no de un valor aleatorio, para que un reenvío no duplique el cobro.
//    `clientRef` relaciona la validación con un pedido propio.
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
    console.error('Rechazada:', error.code, '-', error.detail);
  }
}
console.log('En cola:', queuedValidations.length, 'validaciones');

// 4. Con el webhook registrado, el veredicto llega solo. Consultar sirve a un
//    proceso que necesita el resultado antes de continuar. waitFor() respeta las
//    pausas que pide la API.
for (const queued of queuedValidations) {
  let validation;
  try {
    validation = await client.validations.waitFor(queued, { timeoutMs: 120_000 });
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    console.error(queued.id, 'no tiene un veredicto asentado después de', error.timeoutMs, 'ms');
    continue;
  }

  console.log(validation.id, '->', validation.attributes.status);
  if (hasCep(validation)) {
    const cep = await client.validations.cep(validation.id, { format: 'pdf' });
    await writeFile(cep.filename, cep.content);
    console.log('  comprobante en', cep.filename);
  }
}
