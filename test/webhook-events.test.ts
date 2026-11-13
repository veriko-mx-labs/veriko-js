/** The typed webhook events: `WebhookEvent` is discriminated by `event`. */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  BILLING_WEBHOOK_EVENTS,
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  VALIDATION_WEBHOOK_EVENTS,
  WEBHOOK_EVENTS,
  attemptTimestamp,
  isKnownWebhookEvent,
  parseWebhook,
  verifyDelivery,
  type WebhookEvent,
} from '../src/index.js';
import { recordedBody } from './harness.js';

const SECRET = 'a-secret-of-the-tests';
const NOW_SECONDS = 1_700_000_000;
const NOW = new Date(NOW_SECONDS * 1000);

function plain(body: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function timestamped(body: string | Buffer, secret = SECRET, t = NOW_SECONDS): string {
  const digest = createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(body)
    .digest('hex');
  return `t=${String(t)},v1=${digest}`;
}

function signedHeaders(body: string | Buffer, extra: Record<string, string> = {}) {
  return { 'X-Webhook-Signature-Timestamped': timestamped(body), ...extra };
}

/** Narrows with the discriminant, as an integration would. */
function describeEvent(event: WebhookEvent): string {
  switch (event.event) {
    case 'validation.returned':
      return `returned:${event.data.attributes.payment_status.code}`;
    case 'validation.completed':
    case 'validation.failed':
    case 'validation.error':
    case 'validation.retry.scheduled':
    case 'validation.retry.resolved':
    case 'validation.retry.exhausted':
      return `${event.event}:${String(event.data.attributes.status)}`;
    case 'billing.payment_succeeded':
    case 'billing.payment_failed':
    case 'billing.trial_will_end':
    case 'billing.subscription_canceled':
    case 'billing.invoice_upcoming':
      return `billing:${event.event}`;
    case 'test':
      return 'test';
  }
}

describe('the events of a webhook', () => {
  it('the typed event names are the subscribable ones', () => {
    assert.deepEqual(
      [...VALIDATION_WEBHOOK_EVENTS, ...BILLING_WEBHOOK_EVENTS],
      [...WEBHOOK_EVENTS],
    );
  });

  it('a validation.completed carries the validation, typed', () => {
    const body = recordedBody('webhook-validation-banxico-confirmed');

    const event = parseWebhook(body, signedHeaders(body), SECRET, { now: NOW });

    assert.ok(isKnownWebhookEvent(event));
    assert.equal(event.event, 'validation.completed');
    assert.match(describeEvent(event), /^validation\.completed:/);
    // `assert.equal` narrowed the union: `data` is the validation.
    assert.equal(event.data.type, 'validation');
    assert.ok(event.data.attributes.banxico_confirmed);
  });

  it('a validation.returned carries the payment status that revealed it', () => {
    const body = recordedBody('webhook-validation-returned');

    const event = parseWebhook(body, plain(body), SECRET);

    assert.ok(isKnownWebhookEvent(event));
    assert.equal(event.event, 'validation.returned');
    assert.equal(describeEvent(event), `returned:${event.data.attributes.payment_status.code}`);
    assert.equal(event.data.attributes.payment_status.reversed, true);
  });

  it('a retry event is a validation event', () => {
    const body = recordedBody('webhook-retry-resolved');

    const event = parseWebhook(body, plain(body), SECRET);

    assert.ok(isKnownWebhookEvent(event));
    assert.equal(event.event, 'validation.retry.resolved');
    assert.equal(event.data.type, 'validation');
  });

  it('a billing event and a test event keep their data in rawData', () => {
    for (const name of ['billing.invoice_upcoming', 'test']) {
      const body = `{"event":"${name}","timestamp":"2026-01-01T00:00:00Z","data":{"anything":1}}`;

      const event = parseWebhook(body, plain(body), SECRET);

      assert.ok(isKnownWebhookEvent(event));
      assert.equal(event.event, name);
      assert.equal(event.data, undefined);
      assert.deepEqual(event.rawData, { anything: 1 });
    }
  });

  it('an event the SDK does not know is handed over as unknown, not rejected', () => {
    const body = '{"event":"validation.paused","data":{"type":"validation","id":"x"}}';

    const event = parseWebhook(body, plain(body), SECRET);

    assert.equal(isKnownWebhookEvent(event), false);
    assert.equal(event.event, 'validation.paused');
    assert.equal(event.data, undefined);
    assert.deepEqual(event.rawData, { type: 'validation', id: 'x' });
  });

  it('a validation event without the resource is handed over as unknown', () => {
    const body = '{"event":"validation.completed","data":{"nothing":true}}';

    const event = parseWebhook(body, plain(body), SECRET);

    assert.equal(isKnownWebhookEvent(event), false);
    assert.deepEqual(event.rawData, { nothing: true });
  });

  it('a validation.returned without payment_status is handed over as unknown', () => {
    const document = JSON.parse(recordedBody('webhook-validation-returned').toString('utf8')) as {
      data: { attributes: Record<string, unknown> };
    };
    delete document.data.attributes['payment_status'];
    const body = JSON.stringify(document);

    const event = parseWebhook(body, plain(body), SECRET);

    assert.equal(isKnownWebhookEvent(event), false);
    assert.equal(event.event, 'validation.returned');
  });

  it('with the headers it exposes the delivery id and the time of the attempt', () => {
    const body = recordedBody('webhook-validation-completed');
    const headers = signedHeaders(body, { [DELIVERY_ID_HEADER]: 'delivery-1' });

    const event = parseWebhook(body, headers, SECRET, { now: NOW });

    assert.equal(event.deliveryId, 'delivery-1');
    assert.equal(event.attemptTimestamp, NOW_SECONDS);
  });

  it('a body without event takes it from the X-Veriko-Event header', () => {
    const body = '{"data":{"x":1}}';
    const headers = signedHeaders(body, { [EVENT_HEADER]: 'test' });

    const event = parseWebhook(body, headers, SECRET, { now: NOW });

    assert.equal(event.event, 'test');
  });

  it('finds the headers in the spelling of a CGI environment', () => {
    const body = recordedBody('webhook-validation-completed');
    const headers = {
      HTTP_X_WEBHOOK_SIGNATURE_TIMESTAMPED: timestamped(body),
      HTTP_X_VERIKO_DELIVERY_ID: 'cgi-1',
    };

    const event = parseWebhook(body, headers, SECRET, { now: NOW });

    assert.equal(event.deliveryId, 'cgi-1');
  });
});

describe('verifyDelivery', () => {
  const body = Buffer.from('{"event":"test"}');

  it('accepts the timestamped signature and the one of the previous secret', () => {
    assert.equal(verifyDelivery(body, signedHeaders(body), SECRET, { now: NOW }), true);
    const old = { 'X-Webhook-Signature-Old': timestamped(body, 'previous') };
    assert.equal(verifyDelivery(body, old, ['current', 'previous'], { now: NOW }), true);
  });

  it('rejects the plain signature unless requireTimestamp is false', () => {
    const headers = { 'X-Webhook-Signature': plain(body) };

    assert.equal(verifyDelivery(body, headers, SECRET, { now: NOW }), false);
    assert.equal(
      verifyDelivery(body, headers, SECRET, { now: NOW, requireTimestamp: false }),
      true,
    );
    assert.equal(
      verifyDelivery(body, { 'X-Webhook-Signature': plain(body, 'other') }, SECRET, {
        now: NOW,
        requireTimestamp: false,
      }),
      false,
    );
  });

  it('rejects a stale delivery even when the plain signature fallback is on', () => {
    const headers = signedHeaders(body);
    const later = new Date(NOW.getTime() + 3_600_000);

    assert.equal(verifyDelivery(body, headers, SECRET, { now: later }), false);
  });

  it('attemptTimestamp reads t', () => {
    assert.equal(attemptTimestamp(timestamped(body)), NOW_SECONDS);
    assert.equal(attemptTimestamp('v1=abc'), undefined);
    assert.equal(attemptTimestamp(undefined), undefined);
  });
});
