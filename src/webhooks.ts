/**
 * Signature verification for webhooks.
 *
 * Every delivery arrives signed with HMAC-SHA256 of the body, using the secret that
 * `POST /v1/webhooks` returned when the endpoint was registered. The signature
 * travels in hexadecimal, prefixed by the algorithm:
 *
 *     X-Webhook-Signature: sha256=<hex>
 *
 * What is signed is the body as it arrived. Parsing the JSON and serializing it again
 * changes the bytes, because key order, whitespace and the escaping of non-ASCII
 * characters are not preserved, and the signature stops matching. In Express, that
 * means `express.raw()` on the webhook route.
 *
 * Every delivery also carries a second signature that includes the time of the attempt:
 *
 *     X-Webhook-Signature-Timestamped: t=<seconds>,v1=<hex>
 *
 * `v1` is the HMAC-SHA256 of `<t>.<body>`. With it the receiver can discard an old
 * delivery that someone sends again.
 *
 * After `regenerateSecret()`, and for 24 hours unless `immediate: true` was passed, each
 * delivery also carries the signature made with the previous secret, in the same format
 * as the timestamped one:
 *
 *     X-Webhook-Signature-Old: t=<seconds>,v1=<hex>
 *
 * Pass both secrets, `[current, previous]`, so queued deliveries keep verifying while the
 * receiver is updated.
 *
 * @see https://docs.veriko.mx/en/concepts/webhooks-architecture
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { fillValidation } from './aliases.js';
import { SignatureVerificationError } from './errors.js';
import {
  BILLING_WEBHOOK_EVENTS,
  VALIDATION_WEBHOOK_EVENTS,
  type UnknownWebhookEvent,
  type WebhookEnvelope,
  type WebhookEvent,
  type WebhookValidation,
} from './types.js';

/** Header of the signature. */
export const SIGNATURE_HEADER = 'X-Webhook-Signature';

/** Header of the signature that includes the time of the attempt. */
export const TIMESTAMPED_SIGNATURE_HEADER = 'X-Webhook-Signature-Timestamped';

/** Header of the signature made with the previous secret, during a rotation. */
export const OLD_SIGNATURE_HEADER = 'X-Webhook-Signature-Old';

/** Recommended window between `t` and the receiver's clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Other headers of a delivery. */
export const EVENT_HEADER = 'X-Veriko-Event';
export const DELIVERY_ID_HEADER = 'X-Veriko-Delivery-Id';
export const TIMESTAMP_HEADER = 'X-Veriko-Timestamp';

const SIGNATURE_PREFIX = 'sha256=';

/** `true` when `data` is the JSON:API resource of a validation. */
function isValidationResource(data: unknown): data is WebhookValidation {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'validation';
}

type Payload = string | Uint8Array;

/** One secret, or several: the current one and the previous one during a rotation. */
export type WebhookSecret = string | readonly string[];

function toBuffer(payload: Payload): Buffer {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
}

function secretList(secret: WebhookSecret): string[] {
  return (typeof secret === 'string' ? [secret] : [...secret]).filter(
    (item) => typeof item === 'string' && item !== '',
  );
}

/**
 * Compares two strings in constant time. Both are hashed first, so the comparison
 * works on equal-length buffers whatever the input, non-ASCII included.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** Returns the hexadecimal HMAC-SHA256 of the body, without the `sha256=` prefix. */
export function computeSignature(payload: Payload, secret: string): string {
  return createHmac('sha256', secret).update(toBuffer(payload)).digest('hex');
}

/**
 * Checks the signature of a delivery. Returns `true` or `false`, never throws.
 *
 * It accepts the header value with or without the `sha256=` prefix. The comparison runs
 * in constant time, so the response time leaks nothing. With several secrets, every
 * one is checked and a match with any of them is enough.
 *
 * @param payload The raw body of the request, not re-serialized.
 * @param signature The value of the `X-Webhook-Signature` header.
 * @param secret The secret of the endpoint, or `[current, previous]` during a rotation.
 */
export function verifyWebhook(
  payload: Payload,
  signature: string | null | undefined,
  secret: WebhookSecret,
): boolean {
  const secrets = secretList(secret);
  if (!signature || secrets.length === 0) return false;
  let received = signature.trim();
  if (received.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    received = received.slice(SIGNATURE_PREFIX.length);
  }
  received = received.toLowerCase();
  let matched = false;
  for (const item of secrets) {
    if (safeEqual(received, computeSignature(payload, item))) matched = true;
  }
  return matched;
}

/** Options of `verifyWebhookTimestamped()` and `parseWebhook()`. */
export interface VerifyTimestampedOptions {
  /** Window between `t` and the receiver's clock, in seconds. Defaults to 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The current time. Defaults to the system clock; tests pass it. */
  now?: Date;
}

const UNIX_SECONDS = /^[0-9]{1,15}$/;

/**
 * Splits `t=<seconds>,v1=<hex>` into the time and the `v1` signatures.
 *
 * It accepts several `v1` and drops the keys it does not know. It returns `undefined`
 * when `t` is missing, appears more than once, or is not an integer of seconds.
 */
function parseTimestamped(header: string): { timestamp: string; digests: string[] } | undefined {
  const times: string[] = [];
  const digests: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') times.push(value);
    else if (key === 'v1') digests.push(value.toLowerCase());
  }
  const timestamp = times[0];
  if (times.length !== 1 || timestamp === undefined || !UNIX_SECONDS.test(timestamp)) {
    return undefined;
  }
  return { timestamp, digests };
}

/**
 * Checks the timestamped signature of a delivery. Returns `true` or `false`, never throws.
 *
 * It accepts the value of `X-Webhook-Signature-Timestamped`, or of
 * `X-Webhook-Signature-Old`, which has the same format: `t=<seconds>,v1=<hex>`. It
 * computes the HMAC-SHA256 of `<t>.<body>`, compares it in constant time with each `v1`,
 * and rejects the delivery when `t` is further than `toleranceSeconds` from the receiver's
 * clock.
 *
 * The window is measured against `t`, the time of that attempt, and not against the
 * `timestamp` field of the body, which is the time of the event. A retry arrives up to
 * about 8.6 hours after the event, with a new `t`.
 *
 * @param payload The raw body of the request, not re-serialized.
 * @param header The value of the `X-Webhook-Signature-Timestamped` header.
 * @param secret The secret of the endpoint, or `[current, previous]` during a rotation.
 * @param options The window and the current time.
 */
export function verifyWebhookTimestamped(
  payload: Payload,
  header: string | null | undefined,
  secret: WebhookSecret,
  options: VerifyTimestampedOptions = {},
): boolean {
  const secrets = secretList(secret);
  if (!header || secrets.length === 0) return false;
  const parsed = parseTimestamped(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (!(Math.abs(nowSeconds - Number(parsed.timestamp)) <= tolerance)) return false;

  const signed = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), toBuffer(payload)]);
  // Every pair is compared, without stopping at the first match.
  let matched = false;
  for (const item of secrets) {
    const expected = createHmac('sha256', item).update(signed).digest('hex');
    for (const digest of parsed.digests) {
      if (safeEqual(digest, expected)) matched = true;
    }
  }
  return matched;
}

type HeaderBag =
  Record<string, string | string[] | undefined> | { get(name: string): string | null };

/** The value of a header, regardless of case. */
function headerValue(headers: HeaderBag, header: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(header) ?? undefined;
  }
  // `X-Webhook-Signature`, `x-webhook-signature` and the `HTTP_X_WEBHOOK_SIGNATURE` of CGI
  // style environments name the same header.
  const lower = header.toLowerCase();
  const wanted = new Set([lower, lower.replaceAll('-', '_'), `http_${lower.replaceAll('-', '_')}`]);
  for (const [name, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    if (!wanted.has(name.toLowerCase())) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Finds the signature header in any spelling.
 *
 * Header names are case-insensitive, and each framework delivers them its own way.
 */
export function signatureFromHeaders(headers: HeaderBag): string | undefined {
  return headerValue(headers, SIGNATURE_HEADER);
}

/** Finds the timestamped signature header in any spelling. */
export function timestampedSignatureFromHeaders(headers: HeaderBag): string | undefined {
  return headerValue(headers, TIMESTAMPED_SIGNATURE_HEADER);
}

/** Finds the header with the signature of the previous secret in any spelling. */
export function oldSignatureFromHeaders(headers: HeaderBag): string | undefined {
  return headerValue(headers, OLD_SIGNATURE_HEADER);
}

/** Options of `verifyDelivery()` and `parseWebhook()` when they receive the headers. */
export interface VerifyDeliveryOptions extends VerifyTimestampedOptions {
  /**
   * Reject a delivery that carries no valid timestamped signature. It is `true` by default.
   * With `false`, such a delivery falls back to `X-Webhook-Signature`, which proves the
   * origin but gives no protection against a replay.
   */
  requireTimestamp?: boolean;
}

/**
 * Checks a whole delivery from its headers. Returns `true` or `false`, never throws.
 *
 * It verifies `X-Webhook-Signature-Timestamped` and, when present, `X-Webhook-Signature-Old`,
 * each against every secret given, and applies the window `toleranceSeconds` to `t`. Pass
 * `[current, previous]` during the 24 hours after a rotation. With `requireTimestamp: false`,
 * a delivery without a valid timestamped signature falls back to `X-Webhook-Signature`.
 *
 * @param payload The raw body of the request, not re-serialized.
 * @param headers The request headers, in any spelling the frameworks use.
 */
export function verifyDelivery(
  payload: Payload,
  headers: HeaderBag,
  secret: WebhookSecret,
  options: VerifyDeliveryOptions = {},
): boolean {
  const current = verifyWebhookTimestamped(
    payload,
    timestampedSignatureFromHeaders(headers),
    secret,
    options,
  );
  const old = verifyWebhookTimestamped(payload, oldSignatureFromHeaders(headers), secret, options);
  if (current || old) return true;
  if (options.requireTimestamp ?? true) return false;
  return verifyWebhook(payload, signatureFromHeaders(headers), secret);
}

/**
 * Checks a delivery from its headers: the timestamped signature, and during a rotation
 * the `-Old` one. It is `verifyDelivery()` with the plain signature never accepted.
 */
export function verifyWebhookHeaders(
  payload: Payload,
  headers: HeaderBag,
  secret: WebhookSecret,
  options: VerifyTimestampedOptions = {},
): boolean {
  return verifyDelivery(payload, headers, secret, { ...options, requireTimestamp: true });
}

/**
 * The `t` of a timestamped signature header, in Unix seconds: the time of that delivery
 * attempt. `undefined` when the header is missing or malformed.
 */
export function attemptTimestamp(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const parsed = parseTimestamped(header);
  return parsed ? Number(parsed.timestamp) : undefined;
}

const VALIDATION_EVENTS: ReadonlySet<string> = new Set(VALIDATION_WEBHOOK_EVENTS);
const BILLING_EVENTS: ReadonlySet<string> = new Set(BILLING_WEBHOOK_EVENTS);

/**
 * `true` when the event is one this version of the SDK types. It narrows
 * `WebhookEvent | UnknownWebhookEvent` to `WebhookEvent`, which `switch (event.event)`
 * then discriminates.
 */
export function isKnownWebhookEvent(
  event: WebhookEvent | UnknownWebhookEvent,
): event is WebhookEvent {
  if (VALIDATION_EVENTS.has(event.event)) {
    // A validation event that did not arrive with its validation is handed over as unknown.
    const data = (event as { data?: WebhookValidation }).data;
    if (data === undefined) return false;
    return event.event !== 'validation.returned' || data.attributes.payment_status !== undefined;
  }
  return BILLING_EVENTS.has(event.event) || event.event === 'test';
}

/**
 * Verifies the signature and returns the parsed event.
 *
 * The second argument is either the value of `X-Webhook-Signature`, which proves the
 * origin and nothing about freshness, or the headers of the request. With the headers,
 * the timestamped signature (and `X-Webhook-Signature-Old` during a rotation) is
 * verified inside the window `toleranceSeconds`, 300 by default, which also protects
 * against replays.
 *
 * The result is discriminated by `event`: for the seven `validation.*` events `data` is the
 * validation, and for `validation.returned` it carries `attributes.payment_status`. For
 * `billing.*` and `test` events the body's `data` is in `rawData`. An event the SDK does not
 * know, or a validation event whose body is not the documented one, comes back as an
 * `UnknownWebhookEvent`; `isKnownWebhookEvent()` tells them apart. With the headers, the
 * result also carries `deliveryId` and `attemptTimestamp`, and a body without `event` takes
 * it from `X-Veriko-Event`.
 *
 * @throws {SignatureVerificationError} When the signature does not match the body. The
 * body is not parsed in that case.
 */
export function parseWebhook(
  payload: Payload,
  signatureOrHeaders: string | null | undefined | HeaderBag,
  secret: WebhookSecret,
  options: VerifyDeliveryOptions = {},
): WebhookEvent | UnknownWebhookEvent {
  const fromHeaders = typeof signatureOrHeaders === 'object' && signatureOrHeaders !== null;
  const valid = fromHeaders
    ? verifyDelivery(payload, signatureOrHeaders, secret, options)
    : verifyWebhook(payload, signatureOrHeaders, secret);
  if (!valid) {
    throw new SignatureVerificationError(
      'The signature of the delivery does not match the body received. Check that the ' +
        'body is the raw one, not re-serialized, that the secret belongs to the endpoint ' +
        'that sends it, and, when verifying with headers, that the delivery is within ' +
        'the time window.',
    );
  }

  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new SignatureVerificationError('The body of the delivery is not a JSON object');
  }

  const document = parsed as Record<string, unknown>;
  const data = document['data'];
  const headerEvent = fromHeaders ? headerValue(signatureOrHeaders, EVENT_HEADER) : undefined;
  const name =
    typeof document['event'] === 'string' && document['event'] !== ''
      ? document['event']
      : (headerEvent ?? '');

  const envelope: WebhookEnvelope = {};
  if (typeof document['timestamp'] === 'string') envelope.timestamp = document['timestamp'];
  if (data !== undefined) envelope.rawData = data;
  if (document['meta'] && typeof document['meta'] === 'object') {
    envelope.meta = document['meta'] as Record<string, unknown>;
  }
  if (fromHeaders) {
    const deliveryId = headerValue(signatureOrHeaders, DELIVERY_ID_HEADER);
    if (deliveryId !== undefined) envelope.deliveryId = deliveryId;
    const attempt = attemptTimestamp(timestampedSignatureFromHeaders(signatureOrHeaders));
    if (attempt !== undefined) envelope.attemptTimestamp = attempt;
  }

  if (VALIDATION_EVENTS.has(name) && isValidationResource(data)) {
    const validation = fillValidation(data);
    if (name !== 'validation.returned') {
      return { ...envelope, event: name as never, data: validation };
    }
    // A return carries the payment status that revealed it; without it the body is not the
    // documented one, and it is handed over as an event the SDK does not type.
    if (validation.attributes.payment_status) {
      return {
        ...envelope,
        event: 'validation.returned',
        data: validation as Extract<WebhookEvent, { event: 'validation.returned' }>['data'],
      };
    }
  } else if (BILLING_EVENTS.has(name) || name === 'test') {
    return { ...envelope, event: name as never };
  }
  return { ...envelope, event: name };
}
