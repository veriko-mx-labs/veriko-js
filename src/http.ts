/**
 * HTTP transport: one request, its retries and the translation of errors.
 *
 * It uses the `fetch` of the runtime, so the SDK adds no runtime dependencies.
 *
 * What is retried:
 *
 * - `GET`, `PUT`, `PATCH` and `DELETE` on `5xx`, `408`, `429` and connection errors.
 * - `POST` only when it carries an `Idempotency-Key`, or on `429`, which the API
 *   rejects before running the operation. A `POST` without a key never repeats after
 *   a lost response, because the operation may have run.
 * - `409` with `idempotency_key_in_progress` waits and repeats the same key, within
 *   `maxInProgressWaitMs`.
 * - `429` with `quota_exceeded` is thrown at once: the quota does not refill by waiting.
 *
 * `Retry-After` is honored in full. When it exceeds `maxRetryAfterMs`, the error is
 * thrown with `retryAfter` set, and the caller decides.
 *
 * @see https://docs.veriko.mx/en/concepts/rate-limits
 * @see https://docs.veriko.mx/en/concepts/idempotency
 */

import {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  ConnectionError,
  ERROR_CODES,
  ForbiddenError,
  GoneError,
  InvalidRequestError,
  NotFoundError,
  NotModifiedError,
  PayloadTooLargeError,
  QuotaExceededError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
  ServerError,
  type ApiErrorEntry,
} from './errors.js';
import { newIdempotencyKey } from './internal.js';
import {
  ApiPromise,
  buildResponseMeta,
  parseRetryAfter,
  type CallState,
  type DeprecationNotice,
  type ResponseMeta,
} from './response.js';

export { parseRetryAfter };

export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** How many times to retry and how long to wait between attempts. */
export interface RetryConfig {
  /** Retries in addition to the first attempt. `0` disables them. */
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** When the response carries `Retry-After`, that value wins over the backoff. */
  respectRetryAfter: boolean;
  /**
   * The longest `Retry-After` the SDK waits for. A larger one is never shortened: the
   * error is thrown with `retryAfter` set.
   */
  maxRetryAfterMs: number;
  /**
   * The longest total wait for a request with the same `Idempotency-Key` that is still
   * running (`409` `idempotency_key_in_progress`).
   */
  maxInProgressWaitMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  maxInProgressWaitMs: 120_000,
};

/** The formats the API accepts for the `Idempotency-Key` header. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * The languages of `error.detail` and `error.hint`: `es` (the default of the API) or `en`.
 * Any other value is sent as given, and the API answers in Spanish.
 */
export type AcceptLanguage = 'es' | 'en' | (string & {});

/**
 * Options every method accepts as its last argument.
 *
 * ```ts
 * await client.validations.get(id, { signal: AbortSignal.timeout(2000) });
 * ```
 */
export interface CallOptions {
  /** Aborts the call, including the retries and the waits between them. */
  signal?: AbortSignal;
  /** Milliseconds to wait for each attempt. Overrides the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Retries in addition to the first attempt. `0` makes a single attempt. */
  maxRetries?: number;
  /**
   * `Idempotency-Key` of the call, from 1 to 255 characters among letters, digits, `_` and `-`.
   * The operations that accept it generate one when it is missing.
   */
  idempotencyKey?: string;
  /** Extra headers, such as `Accept-Language`. `Authorization` is not overridable. */
  headers?: Record<string, string>;
  /** Language of `error.detail` for this call. Overrides the client's `acceptLanguage`. */
  acceptLanguage?: AcceptLanguage;
  /** Receives the metadata of every successful response of the call. */
  onResponse?: (meta: ResponseMeta) => void;
}

export interface RequestOptions {
  method: string;
  path: string;
  /** The public operations send no authentication header. */
  authenticated?: boolean;
  body?: unknown;
  /** A repeated value (`buckets[]=a&buckets[]=b`) is passed as an array. */
  query?: Record<string, string | number | readonly string[] | undefined>;
  headers?: Record<string, string | undefined>;
  accept?: string;
  /** `false` makes a single attempt, with no retries. Defaults to the configured ones. */
  retry?: boolean;
  /** The operation accepts `Idempotency-Key`: one is generated when the caller gave none. */
  idempotent?: boolean;
  /**
   * Hands the body of a successful response over as a stream, without reading it. An error
   * response is still read whole, so it becomes the typed error.
   */
  stream?: boolean;
  /** The caller's options for this call. */
  call?: CallOptions | undefined;
  /** Records the metadata of the last response. */
  state?: CallState | undefined;
}

/** Sends a request on behalf of one call. */
export type Send = (request: RequestOptions) => Promise<RawResponse>;

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  /** Empty when `stream` is set. */
  body: Uint8Array;
  /** The unread body, for a request made with `stream: true`. */
  stream?: ReadableStream<Uint8Array>;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: RetryConfig;
  userAgent: string;
  acceptLanguage?: string | undefined;
  /** Receives the metadata of every successful response. */
  onResponse?: ((meta: ResponseMeta) => void) | undefined;
  /** Receives the `Deprecation` and `Sunset` headers the first time each pair appears. */
  onDeprecation?: ((notice: DeprecationNotice) => void) | undefined;
  /** Replaceable in tests so they do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** The file name of `Content-Disposition` (RFC 6266), or the fallback. */
export function filenameFromContentDisposition(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const parameters = splitParameters(value);
  const extended = parameters.get('filename*');
  if (extended) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
    const encoded = match ? (match[2] ?? '') : extended;
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded) return decoded;
    } catch {
      // A malformed escape falls through to `filename`.
    }
  }
  const plain = parameters.get('filename');
  return plain ? plain : fallback;
}

/** Splits `attachment; filename="a;b.csv"; filename*=UTF-8''x` honoring quoted strings. */
function splitParameters(header: string): Map<string, string> {
  const parameters = new Map<string, string>();
  let index = 0;
  const length = header.length;
  // Skip the disposition type.
  while (index < length && header[index] !== ';') index += 1;
  while (index < length) {
    index += 1; // the ';'
    while (index < length && /\s/.test(header[index] ?? '')) index += 1;
    const equals = header.indexOf('=', index);
    if (equals === -1) break;
    const name = header.slice(index, equals).trim().toLowerCase();
    index = equals + 1;
    let value = '';
    if (header[index] === '"') {
      index += 1;
      while (index < length && header[index] !== '"') {
        if (header[index] === '\\' && index + 1 < length) index += 1;
        value += header[index] ?? '';
        index += 1;
      }
      index += 1;
    } else {
      while (index < length && header[index] !== ';') {
        value += header[index] ?? '';
        index += 1;
      }
      value = value.trim();
    }
    if (!parameters.has(name)) parameters.set(name, value);
    while (index < length && header[index] !== ';') index += 1;
  }
  return parameters;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The shape of an API key: `veriko_` and 64 lowercase hexadecimal characters. A key
 * of any other shape is not sent: the request fails before it reaches the network.
 */
export const API_KEY_PATTERN = /^veriko_[0-9a-f]{64}$/;

const warnedDeprecations = new Set<string>();

/** Forgets the warnings already issued. Only the tests use it. */
export function resetApiDeprecationWarnings(): void {
  warnedDeprecations.clear();
}

export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly userAgent: string;
  private readonly acceptLanguage: string | undefined;
  private readonly onResponse: ((meta: ResponseMeta) => void) | undefined;
  private readonly onDeprecation: ((notice: DeprecationNotice) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.userAgent = options.userAgent;
    this.acceptLanguage = options.acceptLanguage;
    this.onResponse = options.onResponse;
    this.onDeprecation = options.onDeprecation;
    this.sleep = options.sleep ?? defaultSleep;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Runs one call: `run` receives a `send` bound to the caller's options, and the
   * result is an `ApiPromise` that remembers the last response.
   */
  call<T>(options: CallOptions | undefined, run: (send: Send) => Promise<T>): ApiPromise<T> {
    const state: CallState = {};
    const send: Send = (request) => this.request({ ...request, call: options, state });
    let promise: Promise<T>;
    try {
      promise = run(send);
    } catch (error) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return ApiPromise.wrap(promise, state);
  }

  async request(options: RequestOptions): Promise<RawResponse> {
    const call = options.call ?? {};
    const url = this.buildUrl(options.path, options.query);
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/json',
      'user-agent': this.userAgent,
    };
    if (options.authenticated ?? true) {
      if (!this.apiKey) {
        throw new ConfigurationError(
          'The API key is missing. Pass it in apiKey or set VERIKO_API_KEY.',
        );
      }
      if (!API_KEY_PATTERN.test(this.apiKey)) {
        throw new ConfigurationError(
          'The API key does not have the shape of a Veriko key. Copy it whole from the dashboard.',
        );
      }
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const language = call.acceptLanguage ?? this.acceptLanguage;
    if (language) headers['accept-language'] = language;
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers[name.toLowerCase()] = value;
    }
    for (const [name, value] of Object.entries(call.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === 'authorization') {
        throw new ConfigurationError('Authorization cannot be overridden per call.');
      }
      headers[lower] = value;
    }

    const key = call.idempotencyKey ?? headers['idempotency-key'];
    if (key !== undefined) {
      checkIdempotencyKey(key);
      headers['idempotency-key'] = key;
    } else if (options.idempotent) {
      headers['idempotency-key'] = newIdempotencyKey();
    }

    let payload: string | FormData | undefined;
    if (options.body instanceof FormData) {
      // `fetch` sets the `Content-Type` with the boundary of the form.
      payload = options.body;
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    const method = options.method.toUpperCase();
    const maxRetries = options.retry === false ? 0 : (call.maxRetries ?? this.retry.maxRetries);
    // A POST without a key could run twice if its response is lost.
    const replaySafe = method !== 'POST' || headers['idempotency-key'] !== undefined;
    const timeoutMs = call.timeoutMs ?? this.timeoutMs;
    let inProgressWaitedMs = 0;

    let failures = 0;
    let inProgressWaits = 0;
    let attempts = 0;
    let lastConnectionError: unknown;
    let lastTimedOut: boolean | undefined;

    for (;;) {
      attempts += 1;
      let response: RawResponse;
      try {
        response = await this.send(
          url,
          method,
          payload,
          headers,
          timeoutMs,
          call.signal,
          options.stream === true,
        );
      } catch (cause) {
        if (cause instanceof RequestAbortedError) throw cause;
        lastConnectionError = cause instanceof AttemptTimeout ? cause.cause : cause;
        lastTimedOut = cause instanceof AttemptTimeout;
        if (!replaySafe || failures >= maxRetries) break;
        await this.wait(this.backoff(failures), call.signal);
        failures += 1;
        continue;
      }

      if (response.status < 400 || response.status === 304) {
        const meta = buildResponseMeta(response, attempts);
        if (options.state) options.state.last = meta;
        this.report(meta, method, options.path, call);
        return response;
      }

      const retryAfter = parseRetryAfter(response.headers['retry-after']);
      const code = peekCode(response);

      if (
        response.status === 409 &&
        code === ERROR_CODES.IDEMPOTENCY_KEY_IN_PROGRESS &&
        headers['idempotency-key'] !== undefined &&
        maxRetries > 0
      ) {
        const waitMs =
          this.retry.respectRetryAfter && retryAfter !== undefined
            ? retryAfter * 1000
            : this.backoff(inProgressWaits);
        const overLimit =
          retryAfter !== undefined &&
          this.retry.respectRetryAfter &&
          retryAfter * 1000 > this.retry.maxRetryAfterMs;
        if (!overLimit && inProgressWaitedMs + waitMs <= this.retry.maxInProgressWaitMs) {
          await this.wait(waitMs, call.signal);
          inProgressWaitedMs += waitMs;
          inProgressWaits += 1;
          continue;
        }
        throw toApiError(response, retryAfter);
      }

      const retryable =
        RETRYABLE_STATUSES.has(response.status) &&
        code !== ERROR_CODES.QUOTA_EXCEEDED &&
        (response.status === 429 || replaySafe);
      if (retryable && failures < maxRetries) {
        if (this.retry.respectRetryAfter && retryAfter !== undefined) {
          // Never sleep less than the server asked for; never sleep more than the limit.
          if (retryAfter * 1000 > this.retry.maxRetryAfterMs)
            throw toApiError(response, retryAfter);
          await this.wait(retryAfter * 1000, call.signal);
        } else {
          await this.wait(this.backoff(failures), call.signal);
        }
        failures += 1;
        continue;
      }

      throw toApiError(response, retryAfter);
    }

    if (lastTimedOut) {
      throw new RequestTimeoutError(
        `The request to ${this.baseUrl} did not finish within ${String(timeoutMs)} ms after ` +
          `${String(attempts)} attempt(s)`,
        attempts,
        timeoutMs,
        { cause: lastConnectionError },
      );
    }
    throw new ConnectionError(
      `Could not reach ${this.baseUrl} after ${String(attempts)} attempt(s): ` +
        describe(lastConnectionError),
      attempts,
      { cause: lastConnectionError },
    );
  }

  /** Milliseconds to wait before the next attempt, with jitter. */
  backoff(attempt: number): number {
    const window = Math.min(this.retry.backoffBaseMs * 2 ** attempt, this.retry.backoffMaxMs);
    return window / 2 + Math.random() * (window / 2);
  }

  /**
   * Milliseconds to wait before the next attempt: the whole `Retry-After` when the
   * response carries one, and the backoff otherwise.
   */
  sleepFor(attempt: number, retryAfterSeconds: number | undefined): number {
    if (this.retry.respectRetryAfter && retryAfterSeconds !== undefined) {
      return Math.max(0, retryAfterSeconds * 1000);
    }
    return this.backoff(attempt);
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw abortedError(signal);
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(abortedError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private report(meta: ResponseMeta, method: string, path: string, call: CallOptions): void {
    this.onResponse?.(meta);
    call.onResponse?.(meta);
    if (meta.deprecation === undefined && meta.sunset === undefined) return;
    const key = `${meta.deprecation ?? ''}|${meta.sunset ?? ''}|${meta.link ?? ''}`;
    if (warnedDeprecations.has(key)) return;
    warnedDeprecations.add(key);
    const notice: DeprecationNotice = {
      method,
      path,
      deprecation: meta.deprecation,
      sunset: meta.sunset,
      link: meta.link,
    };
    if (this.onDeprecation) {
      this.onDeprecation(notice);
      return;
    }
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      const sunset = meta.sunset ? ` It is removed on ${meta.sunset}.` : '';
      process.emitWarning(
        `${method} ${path} is deprecated.${sunset}${meta.link ? ` See ${meta.link}.` : ''}`,
        { type: 'DeprecationWarning', code: 'VERIKO_API_DEPRECATION' },
      );
    }
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (typeof value === 'object') {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async send(
    url: string,
    method: string,
    payload: string | FormData | undefined,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stream: boolean,
  ): Promise<RawResponse> {
    if (signal?.aborted) throw abortedError(signal);
    const controller = new AbortController();
    const flags = { timedOut: false };
    const timer = setTimeout(() => {
      flags.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let streaming = false;
    const release = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      if (stream && response.body && response.status < 400 && response.status !== 304) {
        // The time limit covers the wait for the headers; the caller's signal still
        // cancels the transfer until the stream ends.
        streaming = true;
        return {
          status: response.status,
          headers: responseHeaders,
          body: new Uint8Array(0),
          stream: guardStream(response.body, controller, signal, release),
        };
      }
      return {
        status: response.status,
        headers: responseHeaders,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (cause) {
      if (signal?.aborted) throw abortedError(signal);
      if (flags.timedOut) throw new AttemptTimeout(cause);
      throw cause;
    } finally {
      clearTimeout(timer);
      if (!streaming) release();
    }
  }
}

/**
 * Wraps the body of a response so that it releases the abort listener when it ends, and
 * so that aborting the caller's signal mid-transfer fails with `RequestAbortedError`.
 */
function guardStream(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  signal: AbortSignal | undefined,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(sink) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          sink.close();
        } else {
          sink.enqueue(chunk.value);
        }
      } catch (cause) {
        release();
        sink.error(signal?.aborted ? abortedError(signal) : cause);
      }
    },
    async cancel(reason) {
      release();
      controller.abort();
      try {
        await reader.cancel(reason);
      } catch {
        // The transfer was already being aborted.
      }
    },
  });
}

/** Internal marker: the attempt hit its time limit. */
class AttemptTimeout extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('attempt timed out');
    this.cause = cause;
  }
}

function abortedError(signal: AbortSignal): RequestAbortedError {
  return new RequestAbortedError('The call was aborted by its AbortSignal', {
    cause: signal.reason,
  });
}

function checkIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new InvalidRequestError(
      'The Idempotency-Key accepts letters, digits, hyphen and underscore, from 1 to 255 characters',
      { status: 400, code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY, local: true },
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readDocument(response: RawResponse): Record<string, unknown> {
  try {
    const text = new TextDecoder().decode(response.body);
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    }
  } catch {
    // An unreadable body does not change the status: the error is built anyway.
  }
  return {};
}

/** The `code` of the first entry of an error response, when it has one. */
function peekCode(response: RawResponse): string | undefined {
  const errors = readDocument(response)['errors'];
  if (!Array.isArray(errors)) return undefined;
  const first: unknown = errors[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const code = (first as ApiErrorEntry).code;
  return typeof code === 'string' ? code : undefined;
}

/** Turns an error response into the exception that corresponds to it. */
export function toApiError(response: RawResponse, retryAfter: number | undefined): ApiError {
  const document = readDocument(response);
  const entries: ApiErrorEntry[] = Array.isArray(document['errors'])
    ? (document['errors'] as unknown[]).filter(
        (entry): entry is ApiErrorEntry => typeof entry === 'object' && entry !== null,
      )
    : [];
  const first = entries[0];
  const meta = (document['meta'] ?? {}) as Record<string, unknown>;
  const requestId = typeof meta['request_id'] === 'string' ? meta['request_id'] : undefined;
  const retry = retryAfter ?? parseRetryAfter(response.headers['retry-after']);

  const init = {
    status: response.status,
    code: first?.code,
    detail: first?.detail,
    hint: first?.hint,
    docsUrl: first?.docs_url,
    pointer: first?.source?.pointer,
    errors: entries,
    requestId,
    meta,
    headers: response.headers,
    retryAfter: retry,
  };
  const message =
    first?.detail ?? `The API answered ${String(response.status)} with no readable body`;

  switch (response.status) {
    case 304:
      return new NotModifiedError(message, init);
    case 401:
      return new AuthenticationError(message, init);
    case 403:
      return new ForbiddenError(message, init);
    case 404:
      return new NotFoundError(message, init);
    case 409:
      return new ConflictError(message, init);
    case 410:
      return new GoneError(message, init);
    case 413:
      return new PayloadTooLargeError(message, init);
    case 400:
    case 422:
      return new InvalidRequestError(message, init);
    case 429:
      return first?.code === ERROR_CODES.QUOTA_EXCEEDED
        ? new QuotaExceededError(message, init)
        : new RateLimitError(message, init);
    default:
      return response.status >= 500 ? new ServerError(message, init) : new ApiError(message, init);
  }
}
