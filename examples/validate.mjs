/**
 * Validate a SPEI transfer and download its CEP, in Node.
 *
 *     export VERIKO_API_KEY=veriko_your_key_here
 *     node examples/validate.mjs
 *
 * The transfer data goes in the object below. The date is the send date, in
 * YYYY-MM-DD format, and the operation requires the tracking key or the numeric
 * reference.
 */

import { writeFile } from 'node:fs/promises';

import { ApiError, RateLimitError, Veriko, hasCep } from '@veriko-mx/sdk';

const client = new Veriko(); // reads VERIKO_API_KEY from the environment

let validation;
try {
  // validateAndWait() polls when the API answers 202 because Banxico took longer than 45 seconds.
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
    console.error(`Rate limit or quota (${error.kind}). Retry in`, error.retryAfter, 'seconds');
  } else if (error instanceof ApiError) {
    console.error('The API rejected the request:', error.code, error.detail);
    if (error.hint) console.error('Hint:', error.hint);
    console.error('request_id:', error.requestId);
  } else {
    throw error;
  }
  process.exit(1);
}

console.log('Validation:', validation.id);
console.log('Verdict:   ', validation.attributes.status);
console.log('Banxico:   ', validation.attributes.banxico_status);
console.log('Took:      ', validation.attributes.processing_time_ms, 'ms');

if (!hasCep(validation)) {
  console.log('No receipt to download.');
  process.exit(0);
}

const cep = await client.getCep(validation.id, { format: 'pdf' });
await writeFile(cep.filename, cep.content);
console.log('CEP saved to', cep.filename, `(${cep.content.length} bytes)`);
