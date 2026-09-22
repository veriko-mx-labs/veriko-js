/**
 * Verificación de la firma de un webhook.
 *
 * Los cuerpos son los de `test/recordings/webhook-*.json`, servidos aquí como
 * bytes crudos: es lo que firma la API y lo que hay que verificar sin
 * reserializar.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  SIGNATURE_HEADER,
  SignatureVerificationError,
  computeSignature,
  parseWebhook,
  signatureFromHeaders,
  verifyWebhook,
} from '../src/index.js';
import { recordedBody } from './harness.js';

// 64 hex, la forma real del secreto según el contrato. La firma se calcula con él,
// así que el valor concreto da igual para la prueba.
const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function firmar(payload: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifyWebhook', () => {
  it('acepta una firma correcta', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, firmar(payload), SECRET), true);
  });

  it('acepta la firma con y sin el prefijo del algoritmo', () => {
    const payload = recordedBody('webhook-validation-completed');
    const conPrefijo = firmar(payload);
    const sinPrefijo = conPrefijo.slice('sha256='.length);

    assert.equal(verifyWebhook(payload, conPrefijo, SECRET), true);
    assert.equal(verifyWebhook(payload, sinPrefijo, SECRET), true);
    assert.equal(verifyWebhook(payload, sinPrefijo.toUpperCase(), SECRET), true);
  });

  it('rechaza un cuerpo alterado', () => {
    const payload = recordedBody('webhook-validation-completed');
    const firma = firmar(payload);
    const alterado = Buffer.from(
      payload.toString('utf8').replace('"valid"', '"not_found"'),
      'utf8',
    );

    assert.notEqual(alterado.toString('utf8'), payload.toString('utf8'));
    assert.equal(verifyWebhook(alterado, firma, SECRET), false);
  });

  it('reserializar el JSON rompe la firma', () => {
    // El error más común al integrar: leer el cuerpo a un objeto y volverlo a
    // escribir. Los bytes cambian, aunque el documento sea el mismo.
    const payload = recordedBody('webhook-validation-completed');
    const firma = firmar(payload);
    const reserializado = Buffer.from(
      JSON.stringify(JSON.parse(payload.toString('utf8')), null, 2),
      'utf8',
    );

    assert.equal(verifyWebhook(reserializado, firma, SECRET), false);
  });

  it('rechaza otro secreto', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, firmar(payload), 'otro_secreto'), false);
  });

  it('rechaza una firma o un secreto ausentes', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, null, SECRET), false);
    assert.equal(verifyWebhook(payload, '', SECRET), false);
    assert.equal(verifyWebhook(payload, firmar(payload), ''), false);
  });

  it('rechaza una firma de longitud distinta sin romperse', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, 'sha256=abc', SECRET), false);
  });

  it('admite el cuerpo como texto además de bytes', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload.toString('utf8'), firmar(payload), SECRET), true);
  });
});

describe('computeSignature', () => {
  it('devuelve el hexadecimal sin prefijo', () => {
    const payload = Buffer.from('{"event":"test"}', 'utf8');

    const firma = computeSignature(payload, SECRET);

    assert.equal(firma.length, 64);
    assert.equal(firma, createHmac('sha256', SECRET).update(payload).digest('hex'));
  });
});

describe('signatureFromHeaders', () => {
  it('encuentra la cabecera en cualquiera de sus grafías', () => {
    assert.equal(signatureFromHeaders({ [SIGNATURE_HEADER]: 'sha256=abc' }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-webhook-signature': 'sha256=abc' }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-webhook-signature': ['sha256=abc'] }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-otra-cosa': 'sha256=abc' }), undefined);
  });
});

describe('parseWebhook', () => {
  it('devuelve el evento interpretado', () => {
    const payload = recordedBody('webhook-validation-completed');

    const evento = parseWebhook(payload, firmar(payload), SECRET);

    assert.equal(evento.event, 'validation.completed');
    assert.equal(evento.timestamp, '2025-03-15T14:22:11Z');
    assert.equal(evento.data?.id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(evento.data.attributes.status, 'valid');
  });

  it('lee el ciclo de reintentos', () => {
    const payload = recordedBody('webhook-retry-resolved');

    const evento = parseWebhook(payload, firmar(payload), SECRET);

    assert.equal(evento.event, 'validation.retry.resolved');
    assert.equal(evento.data?.attributes.retry_state?.attempts_completed, 3);
    assert.equal(evento.data.attributes.retry_state.terminal_state, 'resolved');
  });

  it('no interpreta un cuerpo con firma inválida', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.throws(
      () => parseWebhook(payload, `sha256=${'0'.repeat(64)}`, SECRET),
      SignatureVerificationError,
    );
  });
});
