/**
 * Response metadata: what a call returns besides its `data`.
 *
 * Every method returns an `ApiPromise`, a `Promise` that also offers
 * `.withResponse()`. The plain `await` keeps returning the resource; `.withResponse()`
 * adds the status, the headers and the values the API reports in them.
 */

import type { RawResponse } from './http.js';

/** Rate-limit window reported by `X-RateLimit-*`. */
export interface RateLimitInfo {
  /** `X-RateLimit-Limit`: requests per window for this key. */
  limit: number | undefined;
  /** `X-RateLimit-Remaining`: requests left in the window. */
  remaining: number | undefined;
  /** `X-RateLimit-Reset`: when the window resets. */
  reset: Date | undefined;
}

/** Monthly quota reported by `X-Quota-*`. */
export interface QuotaInfo {
  limit: number | undefined;
  used: number | undefined;
  remaining: number | undefined;
  /** `X-Quota-Reset`: end of the cycle, ISO 8601 UTC. */
  reset: string | undefined;
}

/** Status, headers and reported values of the last response of a call. */
export interface ResponseMeta {
  status: number;
  /** All headers, with lowercase names. */
  headers: Record<string, string>;
  /** `meta.request_id` of the body, or the `X-Request-Id` header. */
  requestId: string | undefined;
  /** `meta.version` of the body: the API version that answered. */
  apiVersion: string | undefined;
  /** The `meta` object of the body. Empty when the body carries none. */
  meta: Record<string, unknown>;
  /** `undefined` when the response carries no `X-RateLimit-*` header. */
  rateLimit: RateLimitInfo | undefined;
  /** `undefined` when the response carries no `X-Quota-*` header. */
  quota: QuotaInfo | undefined;
  /** `Idempotent-Replayed`: `true` when the API replayed a stored response. */
  replayed: boolean | undefined;
  etag: string | undefined;
  location: string | undefined;
  /** `Retry-After`, in seconds. */
  retryAfter: number | undefined;
  /** `Deprecation` header, verbatim. */
  deprecation: string | undefined;
  /** `Sunset` header, verbatim. */
  sunset: string | undefined;
  /** `Link` header, verbatim. */
  link: string | undefined;
  /** Requests it took, counting the retries. */
  attempts: number;
}

/** Passed to `onDeprecation` when a response carries `Deprecation` or `Sunset`. */
export interface DeprecationNotice {
  method: string;
  path: string;
  deprecation: string | undefined;
  sunset: string | undefined;
  link: string | undefined;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Seconds from a `Retry-After` header, in either of its two forms. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, (timestamp - Date.now()) / 1000);
}

function bodyMeta(response: RawResponse): Record<string, unknown> {
  const type = response.headers['content-type'] ?? '';
  if (!type.includes('json') || response.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const meta = (parsed as Record<string, unknown>)['meta'];
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return meta as Record<string, unknown>;
      }
    }
  } catch {
    // An unreadable body carries no meta.
  }
  return {};
}

/** Builds the metadata of one response. */
export function buildResponseMeta(response: RawResponse, attempts: number): ResponseMeta {
  const headers = response.headers;
  const meta = bodyMeta(response);
  const reset = num(headers['x-ratelimit-reset']);
  const replayed = headers['idempotent-replayed'];
  const id = meta['request_id'];
  const version = meta['version'];
  return {
    status: response.status,
    headers,
    requestId: typeof id === 'string' ? id : headers['x-request-id'],
    apiVersion: typeof version === 'string' ? version : undefined,
    meta,
    rateLimit:
      headers['x-ratelimit-limit'] !== undefined || headers['x-ratelimit-remaining'] !== undefined
        ? {
            limit: num(headers['x-ratelimit-limit']),
            remaining: num(headers['x-ratelimit-remaining']),
            reset: reset === undefined ? undefined : new Date(reset * 1000),
          }
        : undefined,
    quota:
      headers['x-quota-limit'] !== undefined || headers['x-quota-remaining'] !== undefined
        ? {
            limit: num(headers['x-quota-limit']),
            used: num(headers['x-quota-used']),
            remaining: num(headers['x-quota-remaining']),
            reset: headers['x-quota-reset'],
          }
        : undefined,
    replayed: replayed === undefined ? undefined : replayed.toLowerCase() === 'true',
    etag: headers['etag'],
    location: headers['location'],
    retryAfter: parseRetryAfter(headers['retry-after']),
    deprecation: headers['deprecation'],
    sunset: headers['sunset'],
    link: headers['link'],
    attempts,
  };
}

/** What a call recorded about its responses. */
export interface CallState {
  last?: ResponseMeta;
}

/** A resource together with the metadata of the response that produced it. */
export interface WithResponse<T> {
  data: T;
  response: ResponseMeta;
}

/**
 * A `Promise` that also offers `.withResponse()`.
 *
 * `await` resolves to the resource, as for any promise. `.withResponse()` resolves to
 * `{ data, response }`, where `response` describes the last response of the call.
 */
export class ApiPromise<T> extends Promise<T> {
  /** Derived promises (`then`, `catch`) are plain promises. */
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  private readonly state: CallState;

  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => void,
    state: CallState = {},
  ) {
    super(executor);
    this.state = state;
  }

  /** Wraps a promise that records its responses in `state`. */
  static wrap<T>(promise: Promise<T>, state: CallState): ApiPromise<T> {
    return new ApiPromise<T>((resolve, reject) => {
      promise.then(resolve, reject);
    }, state);
  }

  /** Resolves to the resource and the metadata of the last response of the call. */
  async withResponse(): Promise<WithResponse<T>> {
    const data = await this;
    const response = this.state.last;
    if (!response) {
      throw new Error('The call finished without a response to describe');
    }
    return { data, response };
  }
}
