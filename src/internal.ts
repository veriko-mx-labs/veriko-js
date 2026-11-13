/**
 * Helpers shared by the client and the operation families.
 *
 * Nothing here is re-exported from `index.ts`.
 */

import { randomUUID } from 'node:crypto';

import { ApiError, ConfigurationError } from './errors.js';
import type { RawResponse } from './http.js';

/**
 * One key per call, stable across the retries of that same call.
 *
 * Repeating a `POST` without an idempotency key can duplicate the operation, and its
 * charge, when the response was lost but the request arrived. With a key, the repeat
 * returns the original response.
 *
 * This key does not outlive the process that generated it. The one that protects a
 * later resend is the one passed in `idempotencyKey`.
 */
export function newIdempotencyKey(): string {
  return `veriko-js-${randomUUID().replace(/-/g, '')}`;
}

/** An identifier cannot be empty or carry slashes, question marks or hash signs. */
export function checkedId(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || /[/?#]/.test(cleaned)) {
    throw new ConfigurationError(`Unusable identifier: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

/** The numeric identifier of a resource, which the API accepts as a number or a string. */
export type EntityId = string | number;

/** A checked identifier, encoded and ready to go in the path. */
export function pathSegment(value: string): string {
  return encodeURIComponent(checkedId(value));
}

/** The filters of a query: what is not passed is not sent. */
export type Query = Record<string, string | number | readonly string[] | undefined>;

/** Joins a list of values with commas, which is how the API takes several statuses. */
export function joinList(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

function malformed(response: RawResponse, detail: string): ApiError {
  return new ApiError(detail, { status: response.status, headers: response.headers });
}

/** Reads the body of a JSON:API response as an object. */
export function readDocument(response: RawResponse): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw malformed(response, 'The response is not a JSON document');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The `data` resource of a response. `what` completes the message when it is missing.
 *
 * The caller fixes the type: it is the cast of the parsed JSON to the spec's type.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function readData<T>(response: RawResponse, what: string): T {
  const data = readDocument(response)['data'];
  if (data === undefined || data === null) {
    throw malformed(response, `The response has no \`data\` resource ${what}`);
  }
  return data as T;
}

/** The `data` list of a collection. */
export function readList<T>(response: RawResponse, what: string): T[] {
  const data = readDocument(response)['data'];
  if (!Array.isArray(data)) {
    throw malformed(response, `The response has no \`data\` list ${what}`);
  }
  return data as T[];
}

/** The `meta` of a response, or an empty object when it has none. */
export function readMeta(document: Record<string, unknown>): Record<string, unknown> {
  const meta = document['meta'];
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}
