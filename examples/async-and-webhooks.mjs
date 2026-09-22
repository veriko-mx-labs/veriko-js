/**
 * Encolar validaciones, registrar el webhook que las recoge, y sondear.
 *
 *     export VERIKO_API_KEY=veriko_tu_clave_aqui
 *     node examples/async-and-webhooks.mjs
 *
 * Es el camino para volumen: la API acepta cada petición al instante y el
 * veredicto llega después, por webhook o por sondeo.
 */

import { writeFile } from 'node:fs/promises';

import { ApiError, TimeoutError, Veriko, hasCep } from '@veriko-mx/sdk';

const client = new Veriko(); // lee VERIKO_API_KEY del entorno

// 1. El endpoint que va a recibir los veredictos. El secreto viaja una sola vez.
const endpoint = await client.webhooks.create({
  url: 'https://miapp.example.com/hooks/veriko',
  events: ['validation.completed', 'validation.retry.resolved'],
});
console.log('Endpoint', endpoint.id, 'registrado');
console.log('Secreto de firma:', endpoint.attributes.secret, '(la API no lo vuelve a entregar)');

// 2. Un evento de prueba confirma que el receptor es alcanzable antes de mandar
//    tráfico de verdad.
const prueba = await client.webhooks.test(endpoint.id);
if (!prueba.attributes?.delivered) {
  console.error('El receptor no aceptó el evento de prueba:', prueba.attributes?.error);
  process.exit(1);
}
console.log('Prueba entregada en', prueba.attributes.response_time_ms, 'ms');

// 3. Las transferencias por validar. La clave de idempotencia sale del número de
//    pedido, no de un aleatorio: así un reenvío no duplica el cargo.
const transferencias = [
  {
    fecha: '2025-03-15',
    monto: 15000.5,
    claveRastreo: 'MXBA20250315001234',
    idempotencyKey: 'pedido-4f3a2b1c',
  },
  {
    fecha: '2025-03-15',
    monto: 2300,
    claveRastreo: 'MXBA20250315005678',
    idempotencyKey: 'pedido-7c2d9e0a',
  },
];

const encoladas = [];
for (const transferencia of transferencias) {
  try {
    encoladas.push(await client.validations.enqueue(transferencia));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error('Rechazada:', error.code, '-', error.detail);
  }
}
console.log('Encoladas', encoladas.length, 'validaciones');

// 4. Con el webhook registrado, el veredicto llega solo. Sondear sirve para un
//    proceso que necesita el resultado antes de continuar.
for (const queued of encoladas) {
  let validation;
  try {
    validation = await client.validations.waitFor(queued.id, { timeoutMs: 120_000 });
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    console.error(queued.id, 'sin veredicto firme tras', error.timeoutMs, 'ms');
    continue;
  }

  console.log(validation.id, '->', validation.attributes.status);
  if (hasCep(validation)) {
    const cep = await client.validations.cep(validation.id, { format: 'pdf' });
    await writeFile(cep.filename, cep.content);
    console.log('  comprobante en', cep.filename);
  }
}
