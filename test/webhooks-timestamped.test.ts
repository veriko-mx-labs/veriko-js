/**
 * Verification of the timestamped signature of a webhook.
 *
 * The header is `X-Webhook-Signature-Timestamped: t=<seconds>,v1=<hex>`, and `v1`
 * is the HMAC-SHA256 of `<t>.<body>` with the endpoint secret.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOLERANCE_SECONDS,
  TIMESTAMPED_SIGNATURE_HEADER,
  parseWebhook,
  timestampedSignatureFromHeaders,
  verifyWebhook,
  verifyWebhookTimestamped,
} from '../src/index.js';
import { recordedBody } from './harness.js';

const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const NOW_SECONDS = 1_700_000_000;
const T = String(NOW_SECONDS);
const NOW = new Date(NOW_SECONDS * 1000);
const PAYLOAD = recordedBody('webhook-validation-completed');

function atSeconds(seconds: number): Date {
  return new Date((NOW_SECONDS + seconds) * 1000);
}

function v1(payload: Buffer, t: number, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(payload)
    .digest('hex');
}

function signedHeader(payload: Buffer, t = NOW_SECONDS, secret = SECRET): string {
  return `t=${String(t)},v1=${v1(payload, t, secret)}`;
}

describe('verifyWebhookTimestamped', () => {
  it('the fixed signature vector', () => {
    // The HMAC-SHA256 of `1700000000.{"event":"test"}` with the secret of the tests.
    const header =
      't=1700000000,v1=9b5ddb2ae0c5514e340f612c3424deb50a1e17b12767ae8550d6388096c92e10';

    assert.equal(
      verifyWebhookTimestamped(Buffer.from('{"event":"test"}'), header, SECRET, { now: NOW }),
      true,
    );
  });

  it('accepts a correct signature inside the window', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), SECRET, { now: NOW }),
      true,
    );
  });

  it('accepts text and Uint8Array as well as Buffer', () => {
    const text = PAYLOAD.toString('utf8');

    assert.equal(verifyWebhookTimestamped(text, signedHeader(PAYLOAD), SECRET, { now: NOW }), true);
    assert.equal(
      verifyWebhookTimestamped(new Uint8Array(PAYLOAD), signedHeader(PAYLOAD), SECRET, {
        now: NOW,
      }),
      true,
    );
  });

  it('measures the window toward the past and the future', () => {
    const header = signedHeader(PAYLOAD);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: atSeconds(299) }), true);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: atSeconds(-299) }), true);
  });

  it('accepts the edge of the window and rejects one second more', () => {
    const header = signedHeader(PAYLOAD);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: atSeconds(300) }), true);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: atSeconds(301) }), false);
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: atSeconds(-301) }),
      false,
    );
  });

  it('rejects an old delivery that is replayed', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), SECRET, { now: atSeconds(3600) }),
      false,
    );
  });

  it('adjusts the window with toleranceSeconds', () => {
    const header = signedHeader(PAYLOAD);

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, {
        toleranceSeconds: 60,
        now: atSeconds(61),
      }),
      false,
    );
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, {
        toleranceSeconds: 60,
        now: atSeconds(60),
      }),
      true,
    );
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, {
        toleranceSeconds: 3600,
        now: atSeconds(3600),
      }),
      true,
    );
  });

  it('the default window is five minutes', () => {
    assert.equal(DEFAULT_TOLERANCE_SECONDS, 300);
  });

  it('without now it uses the system clock', () => {
    const now = Math.floor(Date.now() / 1000);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD, now), SECRET), true);
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD, now - 3600), SECRET),
      false,
    );
  });

  it('an invalid current time accepts nothing', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), SECRET, {
        now: new Date(Number.NaN),
      }),
      false,
    );
  });

  it('rejects a tampered body', () => {
    const alterado = Buffer.from(PAYLOAD.toString('utf8').replace('"valid"', '"not_found"'));

    assert.notEqual(alterado.toString('utf8'), PAYLOAD.toString('utf8'));
    assert.equal(
      verifyWebhookTimestamped(alterado, signedHeader(PAYLOAD), SECRET, { now: NOW }),
      false,
    );
  });

  it('re-serializing the JSON breaks the signature', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(PAYLOAD.toString('utf8')), null, 2));

    assert.equal(
      verifyWebhookTimestamped(reserialized, signedHeader(PAYLOAD), SECRET, { now: NOW }),
      false,
    );
  });

  it('rejects another secret', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), 'other_secret', { now: NOW }),
      false,
    );
  });

  it('changing t without signing again invalidates the signature', () => {
    // Whoever replays an old delivery cannot give it a new `t`: `t` is signed.
    const renewed = `t=${String(NOW_SECONDS + 3000)},v1=${v1(PAYLOAD, NOW_SECONDS)}`;

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, renewed, SECRET, { now: atSeconds(3000) }),
      false,
    );
  });

  it('the body-only signature does not work as a timestamped signature', () => {
    const bodyOnly = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, `t=${T},v1=${bodyOnly}`, SECRET, { now: NOW }),
      false,
    );
  });

  it('with several v1 it is enough that one matches', () => {
    const good = v1(PAYLOAD, NOW_SECONDS);
    const bad = '0'.repeat(64);
    const verify = (header: string): boolean =>
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: NOW });

    assert.equal(verify(`t=${T},v1=${bad},v1=${good}`), true);
    assert.equal(verify(`t=${T},v1=${good},v1=${bad}`), true);
    assert.equal(verify(`t=${T},v1=${bad},v1=${'1'.repeat(64)}`), false);
  });

  it('ignores the keys it does not know and the spaces', () => {
    const signature = v1(PAYLOAD, NOW_SECONDS);
    const verify = (header: string): boolean =>
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: NOW });

    assert.equal(verify(` v0=abc , t=${T} , v1=${signature} , v2=other`), true);
    assert.equal(verify(`v1=${signature},t=${T}`), true);
  });

  it('accepts the signature in uppercase', () => {
    const header = `t=${T},v1=${v1(PAYLOAD, NOW_SECONDS).toUpperCase()}`;

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: NOW }), true);
  });

  it('rejects a malformed header without throwing', () => {
    const malformed: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      '   ',
      'garbage',
      't=,v1=',
      `t=${T}`,
      `v1=${'a'.repeat(64)}`,
      `t=yesterday,v1=${'a'.repeat(64)}`,
      `t=-${T},v1=${'a'.repeat(64)}`,
      `t=${T}.5,v1=${'a'.repeat(64)}`,
      `t=1e9,v1=${'a'.repeat(64)}`,
      `t=١٧٠٠٠٠٠٠٠٠,v1=${'a'.repeat(64)}`,
      `t=${'9'.repeat(40)},v1=${'a'.repeat(64)}`,
      `t=${T},t=${T},v1=${'a'.repeat(64)}`,
      `t=${T},v1=`,
      `t=${T},v1=áéíóú`,
      `sha256=${'a'.repeat(64)}`,
    ];

    for (const header of malformed) {
      assert.equal(
        verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: NOW }),
        false,
        String(header),
      );
    }
  });

  it('without a secret nothing is accepted', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD, NOW_SECONDS, ''), '', { now: NOW }),
      false,
    );
  });

  it('both signatures coexist and the plain one does not change', () => {
    const plain = `sha256=${createHmac('sha256', SECRET).update(PAYLOAD).digest('hex')}`;

    assert.equal(verifyWebhook(PAYLOAD, plain, SECRET), true);
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), SECRET, { now: NOW }),
      true,
    );
    // The plain signature does not cover the time, and the new one is not confused with it.
    assert.equal(verifyWebhook(PAYLOAD, signedHeader(PAYLOAD), SECRET), false);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, plain, SECRET, { now: NOW }), false);
  });

  it('it is verified before the event is parsed', () => {
    const plain = `sha256=${createHmac('sha256', SECRET).update(PAYLOAD).digest('hex')}`;

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, signedHeader(PAYLOAD), SECRET, { now: NOW }),
      true,
    );
    const event = parseWebhook(PAYLOAD, plain, SECRET);

    assert.equal(event.event, 'validation.completed');
  });
});

describe('timestampedSignatureFromHeaders', () => {
  it('finds the header under any capitalization', () => {
    const value = 't=1,v1=abc';

    assert.equal(timestampedSignatureFromHeaders({ [TIMESTAMPED_SIGNATURE_HEADER]: value }), value);
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature-timestamped': value }),
      value,
    );
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature-timestamped': [value] }),
      value,
    );
    // The plain signature is not confused with the new one.
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature': 'sha256=abc' }),
      undefined,
    );
  });

  it('the header name', () => {
    assert.equal(TIMESTAMPED_SIGNATURE_HEADER, 'X-Webhook-Signature-Timestamped');
  });
});
