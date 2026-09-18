/**
 * Transporte HTTP: una petición, sus reintentos y la traducción de errores.
 *
 * Usa el `fetch` de Node, de modo que el SDK no añade dependencias de runtime a
 * quien lo instala. Node 18 o superior.
 *
 * Qué admite reintento, igual que lo documenta el portal: los `5xx`, el `408` y
 * el `429`. El resto de los `4xx` no, porque la petición hay que corregirla
 * antes de repetirla.
 *
 * @see https://docs.veriko.mx/es/concepts/rate-limits
 */

import {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  ServerError,
  type ApiErrorEntry,
} from './errors.js';

export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Cuántas veces reintentar y cuánto esperar entre intentos. */
export interface RetryConfig {
  /** Reintentos además del primer intento. `0` los desactiva. */
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Cuando la respuesta trae `Retry-After`, ese valor gana sobre el backoff. */
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  backoffBaseMs: 500,
  backoffMaxMs: 20_000,
  respectRetryAfter: true,
};

export interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string | undefined>;
  accept?: string;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: RetryConfig;
  userAgent: string;
  acceptLanguage?: string | undefined;
  /** Sustituible en las pruebas para no dormir de verdad. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** Lee `Retry-After` en sus dos formas: segundos o fecha HTTP. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, (timestamp - Date.now()) / 1000);
}

/** Saca el nombre de archivo de `Content-Disposition`, o usa el de respaldo. */
export function filenameFromContentDisposition(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  for (const part of value.split(';')) {
    const candidate = part.trim();
    if (candidate.toLowerCase().startsWith('filename=')) {
      const name = candidate.slice('filename='.length).trim().replace(/^"|"$/g, '');
      if (name) return name;
    }
  }
  return fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly userAgent: string;
  private readonly acceptLanguage: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry;
    this.userAgent = options.userAgent;
    this.acceptLanguage = options.acceptLanguage;
    this.sleep = options.sleep ?? defaultSleep;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request(options: RequestOptions): Promise<RawResponse> {
    const url = this.buildUrl(options.path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: options.accept ?? 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.acceptLanguage) headers['accept-language'] = this.acceptLanguage;
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers[name.toLowerCase()] = value;
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    const attempts = this.retry.maxRetries + 1;
    let lastConnectionError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const isLast = attempt === attempts - 1;
      let response: RawResponse;
      try {
        response = await this.send(url, options.method, payload, headers);
      } catch (cause) {
        lastConnectionError = cause;
        if (isLast) break;
        await this.sleep(this.sleepFor(attempt, undefined));
        continue;
      }

      if (response.status < 400) return response;

      const retryAfter = parseRetryAfter(response.headers['retry-after']);
      if (RETRYABLE_STATUSES.has(response.status) && !isLast) {
        await this.sleep(this.sleepFor(attempt, retryAfter));
        continue;
      }

      throw toApiError(response, retryAfter);
    }

    throw new ConnectionError(
      `No se pudo contactar a ${this.baseUrl} tras ${String(attempts)} intento(s): ` +
        describe(lastConnectionError),
      attempts,
      { cause: lastConnectionError },
    );
  }

  /** Milisegundos de espera antes del siguiente intento. */
  sleepFor(attempt: number, retryAfterSeconds: number | undefined): number {
    if (this.retry.respectRetryAfter && retryAfterSeconds !== undefined) {
      return Math.max(0, Math.min(retryAfterSeconds * 1000, this.retry.backoffMaxMs * 3));
    }
    const window = Math.min(this.retry.backoffBaseMs * 2 ** attempt, this.retry.backoffMaxMs);
    return window / 2 + Math.random() * (window / 2);
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send(
    url: string,
    method: string,
    payload: string | undefined,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: method.toUpperCase(),
        headers,
        body: payload,
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers: responseHeaders,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Convierte una respuesta de error en la excepción que le corresponde. */
export function toApiError(response: RawResponse, retryAfter: number | undefined): ApiError {
  let document: Record<string, unknown> = {};
  try {
    const text = new TextDecoder().decode(response.body);
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') document = parsed as Record<string, unknown>;
    }
  } catch {
    // Un cuerpo ilegible no cambia el estado: el error se construye igual.
  }

  const entries: ApiErrorEntry[] = Array.isArray(document['errors'])
    ? (document['errors'] as unknown[]).filter(
        (entry): entry is ApiErrorEntry => typeof entry === 'object' && entry !== null,
      )
    : [];
  const first = entries[0];
  const meta = (document['meta'] ?? {}) as Record<string, unknown>;
  const requestId = typeof meta['request_id'] === 'string' ? meta['request_id'] : undefined;

  const init = {
    status: response.status,
    code: first?.code,
    detail: first?.detail,
    pointer: first?.source?.pointer,
    errors: entries,
    requestId,
    meta,
    headers: response.headers,
  };
  const message = first?.detail ?? `La API respondió ${String(response.status)} sin cuerpo legible`;

  switch (response.status) {
    case 401:
      return new AuthenticationError(message, init);
    case 403:
      return new ForbiddenError(message, init);
    case 404:
      return new NotFoundError(message, init);
    case 409:
      return new ConflictError(message, init);
    case 400:
    case 413:
    case 422:
      return new InvalidRequestError(message, init);
    case 429:
      return new RateLimitError(message, { ...init, retryAfter });
    default:
      return response.status >= 500 ? new ServerError(message, init) : new ApiError(message, init);
  }
}
