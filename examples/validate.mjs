/**
 * Valida una transferencia SPEI y descarga su CEP, en Node.
 *
 *     export VERIKO_API_KEY=veriko_tu_clave_aqui
 *     node examples/validate.mjs
 *
 * Los datos de la transferencia van en el objeto de abajo. La fecha es la fecha de envío, en
 * formato YYYY-MM-DD, y la operación exige la clave de rastreo o la referencia numérica.
 */

import { writeFile } from 'node:fs/promises';

import { ApiError, RateLimitError, Veriko, hasCep } from '@veriko-mx/sdk';

const client = new Veriko(); // lee VERIKO_API_KEY del entorno

let validation;
try {
  // validateAndWait() consulta cuando la API responde 202 porque Banxico tardó más de 45 segundos.
  validation = await client.validations.validateAndWait({
    sendDate: '2025-03-15',
    amount: 15000.5,
    trackingKey: 'MXBA20250315001234',
    numericReference: '1234567',
    senderBank: 'BANCO NACIONAL DE MEXICO',
    receiverBank: 'BBVA MEXICO',
    beneficiaryAccount: '012180004412345678',
    idempotencyKey: 'example-validate-001',
  });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error(
      `Límite de tasa o de cuota (${error.kind}). Reintenta en`,
      error.retryAfter,
      'segundos',
    );
  } else if (error instanceof ApiError) {
    console.error('La API rechazó la petición:', error.code, error.detail);
    if (error.hint) console.error('Sugerencia:', error.hint);
    console.error('request_id:', error.requestId);
  } else {
    throw error;
  }
  process.exit(1);
}

console.log('Validación:', validation.id);
console.log('Veredicto: ', validation.attributes.status);
console.log('Banxico:   ', validation.attributes.banxico_status);
console.log('Tardó:    ', validation.attributes.processing_time_ms, 'ms');

if (!hasCep(validation)) {
  console.log('No hay comprobante que descargar.');
  process.exit(0);
}

const cep = await client.getCep(validation.id, { format: 'pdf' });
await writeFile(cep.filename, cep.content);
console.log('CEP guardado en', cep.filename, `(${cep.content.length} bytes)`);
