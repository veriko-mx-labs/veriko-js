/**
 * Verification of the signature of a webhook.
 *
 * The bodies are those of `test/recordings/webhook-*.json`, served here as raw
 * bytes: it is what the API signs and what has to be verified without
 * re-serializing.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  SIGNATURE_HEADER,
  SignatureVerificationError,
  computeSignature,
  hasCep,
  parseWebhook,
  signatureFromHeaders,
  verifyWebhook,
} from '../src/index.js';
import { recordedBody } from './harness.js';

// 64 hex, the real shape of the secret according to the contract. The signature is
// computed with it, so the concrete value does not matter for the test.
const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function sign(payload: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifyWebhook', () => {
  it('accepts a correct signature', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, sign(payload), SECRET), true);
  });

  it('accepts the signature with and without the algorithm prefix', () => {
    const payload = recordedBody('webhook-validation-completed');
    const withPrefix = sign(payload);
    const sinPrefijo = withPrefix.slice('sha256='.length);

    assert.equal(verifyWebhook(payload, withPrefix, SECRET), true);
    assert.equal(verifyWebhook(payload, sinPrefijo, SECRET), true);
    assert.equal(verifyWebhook(payload, sinPrefijo.toUpperCase(), SECRET), true);
  });

  it('rejects a tampered body', () => {
    const payload = recordedBody('webhook-validation-completed');
    const signature = sign(payload);
    const tampered = Buffer.from(
      payload.toString('utf8').replace('"valid"', '"not_found"'),
      'utf8',
    );

    assert.notEqual(tampered.toString('utf8'), payload.toString('utf8'));
    assert.equal(verifyWebhook(tampered, signature, SECRET), false);
  });

  it('re-serializing the JSON breaks the signature', () => {
    // The most common mistake when integrating: reading the body into an object and
    // writing it back. The bytes change even though the document is the same.
    const payload = recordedBody('webhook-validation-completed');
    const signature = sign(payload);
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(payload.toString('utf8')), null, 2),
      'utf8',
    );

    assert.equal(verifyWebhook(reserialized, signature, SECRET), false);
  });

  it('rejects another secret', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, sign(payload), 'other_secret'), false);
  });

  it('rejects a missing signature or secret', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, null, SECRET), false);
    assert.equal(verifyWebhook(payload, '', SECRET), false);
    assert.equal(verifyWebhook(payload, sign(payload), ''), false);
  });

  it('rejects a signature of a different length without breaking', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload, 'sha256=abc', SECRET), false);
  });

  it('accepts the body as text as well as bytes', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.equal(verifyWebhook(payload.toString('utf8'), sign(payload), SECRET), true);
  });
});

describe('computeSignature', () => {
  it('returns the hexadecimal without a prefix', () => {
    const payload = Buffer.from('{"event":"test"}', 'utf8');

    const signature = computeSignature(payload, SECRET);

    assert.equal(signature.length, 64);
    assert.equal(signature, createHmac('sha256', SECRET).update(payload).digest('hex'));
  });
});

describe('signatureFromHeaders', () => {
  it('finds the header under any capitalization', () => {
    assert.equal(signatureFromHeaders({ [SIGNATURE_HEADER]: 'sha256=abc' }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-webhook-signature': 'sha256=abc' }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-webhook-signature': ['sha256=abc'] }), 'sha256=abc');
    assert.equal(signatureFromHeaders({ 'x-other-thing': 'sha256=abc' }), undefined);
  });
});

describe('parseWebhook', () => {
  it('returns the parsed event', () => {
    const payload = recordedBody('webhook-validation-completed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.event, 'validation.completed');
    assert.equal(event.timestamp, '2025-03-15T14:22:11Z');
    assert.equal(event.data?.id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(event.data.attributes.status, 'valid');
  });

  it('reads the retry cycle', () => {
    const payload = recordedBody('webhook-retry-resolved');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.event, 'validation.retry.resolved');
    assert.equal(event.data?.attributes.retry_state?.attempts_completed, 3);
    assert.equal(event.data.attributes.retry_state.terminal_state, 'resolved');
  });

  it('does not parse a body with an invalid signature', () => {
    const payload = recordedBody('webhook-validation-completed');

    assert.throws(
      () => parseWebhook(payload, `sha256=${'0'.repeat(64)}`, SECRET),
      SignatureVerificationError,
    );
  });

  it('reads what Banxico confirmed when the delivery carries it', () => {
    const payload = recordedBody('webhook-validation-banxico-confirmed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.banxico_status, 'valid');
    assert.deepEqual(event.data.attributes.banxico_confirmed, {
      amount: 15000.5,
      operationDate: '15-03-2025',
      processingTime: '14:22:10',
      trackingKey: 'MBAN01002503151422ABCDEF',
      senderBank: 'BBVA',
      receiverBank: 'STP',
      beneficiaryAccount: '••••5678',
    });
  });

  it('reads client_ref when the delivery carries it', () => {
    const payload = recordedBody('webhook-validation-client-ref');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.client_ref, 'order-4812');
  });

  it('reads the reason when the validation was not confirmed', () => {
    const payload = recordedBody('webhook-validation-not-found');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.status, 'not_found');
    assert.equal(event.data.attributes.error_code, 'not_found_amount');
    assert.equal(
      event.data.attributes.error_message,
      'Banxico encontró la operación con un importe distinto.',
    );
  });

  it('carries no reason when the delivery does not include it', () => {
    const payload = recordedBody('webhook-validation-completed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.error_code, undefined);
    assert.equal(event.data?.attributes.error_message, undefined);
  });

  it('carries no client_ref when the delivery does not include it', () => {
    const payload = recordedBody('webhook-validation-completed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.client_ref, undefined);
  });

  it('reads validation.returned with the payment status', () => {
    const payload = recordedBody('webhook-validation-returned');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.event, 'validation.returned');
    assert.equal(event.timestamp, '2026-10-02T09:15:44Z');
    assert.equal(event.data?.attributes.status, 'returned');
    assert.equal(event.data.attributes.banxico_status, 'returned');
    assert.equal(event.data.attributes.client_ref, 'order-4812');
    assert.equal(hasCep(event.data), true);
    assert.deepEqual(event.data.attributes.payment_status, {
      code: 'devuelto',
      label: 'Devuelto',
      settled: false,
      reversed: true,
      checked_at: '2026-10-02T09:15:44Z',
    });
  });

  it('carries no payment_status when the event is not validation.returned', () => {
    const payload = recordedBody('webhook-validation-completed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.payment_status, undefined);
  });

  it('carries no banxico_confirmed when the delivery does not include it', () => {
    const payload = recordedBody('webhook-validation-completed');

    const event = parseWebhook(payload, sign(payload), SECRET);

    assert.equal(event.data?.attributes.banxico_confirmed, undefined);
  });
});
