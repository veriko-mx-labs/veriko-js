/**
 * SDK errors.
 *
 * The API returns errors in an `errors` array, and `code` is the stable field of
 * each entry. `detail` is translated according to `Accept-Language` and may be
 * reworded between releases. Every exception therefore exposes `code` and the full
 * list of `errors`: branching on the text is the quietest mistake when integrating
 * this API.
 *
 * @see https://docs.veriko.mx/en/concepts/errors
 */

/** One entry of the `errors` array of the API. */
export interface ApiErrorEntry {
  /** HTTP status repeated as a string. */
  status?: string;
  /** Stable, untranslated code. The field to branch on. */
  code?: string;
  /** Human-readable text, translated according to `Accept-Language`. */
  detail?: string;
  /** The next step, in the language of `detail`. Only present for codes that have a clear one. */
  hint?: string;
  /** Page of the documentation that explains the error. */
  docs_url?: string;
  /** JSON Pointer to the body field that caused the rejection. */
  source?: { pointer?: string; parameter?: string };
  /** Context of this entry. */
  meta?: Record<string, unknown>;
}

/** Error codes the SDK compares against or raises on its own. */
export const ERROR_CODES = {
  /** `409`. A request with the same `Idempotency-Key` is still running. */
  IDEMPOTENCY_KEY_IN_PROGRESS: 'idempotency_key_in_progress',
  /** `422`. The `Idempotency-Key` was reused with a different body. */
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  /** `400`. The `Idempotency-Key` does not match `^[A-Za-z0-9_-]{1,255}$`. */
  INVALID_IDEMPOTENCY_KEY: 'invalid_idempotency_key',
  /** `429`. The rate limit was exceeded. */
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  /** `429`. The monthly quota of the plan is spent. */
  QUOTA_EXCEEDED: 'quota_exceeded',
  /** `410`. The validation was purged. */
  VALIDATION_PURGED: 'validation_purged',
  /** `410`. The validation was created with `retainImage: false`. */
  IMAGE_NOT_RETAINED: 'image_not_retained',
  /** `404`. The validation has no CEP to download. */
  CEP_NOT_AVAILABLE: 'cep_not_available',
  /** `422`. Raised by the SDK: `trackingKey` and `numericReference` are both missing. */
  TRACKING_KEY_OR_REFERENCE_REQUIRED: 'tracking_key_or_reference_required',
  /** `422`. Raised by the SDK: neither `beneficiaryAccount` nor `candidateAccounts` was given. */
  ACCOUNT_REQUIRED: 'account_required',
  /** `422`. Raised by the SDK: both `beneficiaryAccount` and `candidateAccounts` were given. */
  ACCOUNT_AND_CANDIDATES_MUTUALLY_EXCLUSIVE: 'account_and_candidates_mutually_exclusive',
  /** `422`. Raised by the SDK: `candidateAccounts` is not an array. */
  CANDIDATE_ACCOUNTS_INVALID: 'candidate_accounts_invalid',
  /** `422`. Raised by the SDK: the Spanish and the English name of a field arrived together. */
  ALIAS_CONFLICT: 'alias_conflict',
} as const;

/** Root of everything the SDK throws. */
export class VerikoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The API key is missing, or an argument of the client is unusable. */
export class ConfigurationError extends VerikoError {}

/** No response arrived: DNS, TLS, socket or timeout, with the retries already spent. */
export class ConnectionError extends VerikoError {
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options);
    this.attempts = attempts;
  }
}

/** The attempt did not finish within `timeoutMs`. Subclass of `ConnectionError`. */
export class RequestTimeoutError extends ConnectionError {
  /** The per-attempt limit that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(message: string, attempts: number, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, attempts, options);
    this.timeoutMs = timeoutMs;
  }
}

/** The caller aborted the call through its `AbortSignal`. It is never retried. */
export class RequestAbortedError extends VerikoError {}

export interface ApiErrorInit {
  status: number;
  code?: string | undefined;
  detail?: string | undefined;
  hint?: string | undefined;
  docsUrl?: string | undefined;
  pointer?: string | undefined;
  errors?: ApiErrorEntry[] | undefined;
  requestId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
  retryAfter?: number | undefined;
  /** `true` when the SDK raised the error before sending anything. */
  local?: boolean | undefined;
}

/** The API answered, and the answer was an error. */
export class ApiError extends VerikoError {
  /** HTTP status. For an error raised by the SDK, the status the API would answer with. */
  readonly status: number;
  /** `errors[0].code`, the stable contract to branch on. */
  readonly code: string | undefined;
  /** `errors[0].detail`, readable and translated text. */
  readonly detail: string | undefined;
  /** `errors[0].hint`, the next step, when the code has a clear one. */
  readonly hint: string | undefined;
  /** `errors[0].docs_url`, the documentation page that explains the code. */
  readonly docsUrl: string | undefined;
  /** `errors[0].source.pointer` when the rejection points at a field. */
  readonly pointer: string | undefined;
  /** The full array. A `422` carries one entry per invalid field. */
  readonly errors: ApiErrorEntry[];
  /** `meta.request_id`, the value to quote when investigating a specific case. */
  readonly requestId: string | undefined;
  readonly meta: Record<string, unknown>;
  /** Response headers, with lowercase names. */
  readonly headers: Record<string, string>;
  /** Seconds that `Retry-After` asks to wait, when the response carries it. */
  readonly retryAfter: number | undefined;
  /** `true` when the SDK raised the error itself, before sending the request. */
  readonly local: boolean;

  constructor(message: string, init: ApiErrorInit) {
    const status = String(init.status);
    const head = init.code ? `HTTP ${status} ${init.code}` : `HTTP ${status}`;
    const suffix = init.requestId ? ` (request_id=${init.requestId})` : '';
    super(`${head}: ${message}${suffix}`);
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.hint = init.hint;
    this.docsUrl = init.docsUrl;
    this.pointer = init.pointer;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.meta = init.meta ?? {};
    this.headers = init.headers ?? {};
    this.retryAfter = init.retryAfter;
    this.local = init.local ?? false;
  }

  /** The code of every entry, in order. A `422` lists the summary first and then each field. */
  get codes(): string[] {
    return this.errors.flatMap((entry) => (entry.code ? [entry.code] : []));
  }

  /** `true` when any entry of `errors` carries `code`. */
  hasCode(code: string): boolean {
    return this.codes.includes(code);
  }

  /** `meta.validation_id`: the validation created before the request failed, when there is one. */
  get validationId(): string | undefined {
    const id = this.meta['validation_id'];
    return typeof id === 'string' ? id : undefined;
  }
}

/** `304`. The resource did not change since the `ETag` sent in `ifNoneMatch`. */
export class NotModifiedError extends ApiError {
  /** The `ETag` of the current representation. */
  get etag(): string | undefined {
    return this.headers['etag'];
  }
}

/** `401`. The API key is missing or no longer valid. */
export class AuthenticationError extends ApiError {}

/** `403`. Authenticated, but without permission for that operation. */
export class ForbiddenError extends ApiError {}

/** `404`. The resource does not exist, or the CEP is not available (`cep_not_available`). */
export class NotFoundError extends ApiError {}

/**
 * `409`. State conflict. With `Idempotency-Key`, `idempotency_key_in_progress` means the
 * first request is still running: wait `retryAfter` seconds and repeat it with the same key.
 */
export class ConflictError extends ApiError {
  /** `true` when the first request with this `Idempotency-Key` is still running. */
  get inProgress(): boolean {
    return this.code === ERROR_CODES.IDEMPOTENCY_KEY_IN_PROGRESS;
  }
}

/** `410`. The resource existed and was deleted: `validation_purged`, `image_not_retained`. */
export class GoneError extends ApiError {}

/** `400` and `422`. The request has to be corrected before it is repeated. */
export class InvalidRequestError extends ApiError {}

/** `413`. The body exceeds the cap of the operation. Subclass of `InvalidRequestError`. */
export class PayloadTooLargeError extends InvalidRequestError {}

/** `429`. Rate limit exceeded, or monthly quota spent (`quota_exceeded`). */
export class RateLimitError extends ApiError {
  /** `rate_limit` clears after `retryAfter` seconds; `quota` clears at the next cycle. */
  get kind(): 'rate_limit' | 'quota' {
    return this.code === ERROR_CODES.QUOTA_EXCEEDED ? 'quota' : 'rate_limit';
  }

  /** `X-RateLimit-Limit`: requests per window. */
  get limit(): number | undefined {
    return numberHeader(this.headers['x-ratelimit-limit']);
  }

  /** `X-RateLimit-Remaining`: requests left in the window. */
  get remaining(): number | undefined {
    return numberHeader(this.headers['x-ratelimit-remaining']);
  }

  /** `X-RateLimit-Reset`: when the window resets. */
  get resetAt(): Date | undefined {
    const reset = numberHeader(this.headers['x-ratelimit-reset']);
    return reset === undefined ? undefined : new Date(reset * 1000);
  }
}

/** `429` with `quota_exceeded`. The quota of the plan does not refill by waiting seconds. */
export class QuotaExceededError extends RateLimitError {}

/** `5xx`. Admits retry; the SDK already did it if attempts remained. */
export class ServerError extends ApiError {}

/** The signature of a webhook does not match the body received. */
export class SignatureVerificationError extends VerikoError {}

/**
 * `waitFor()`, `waitForCepExport()` or `importWait()` ran out of time before the
 * resource reached a settled state.
 */
export class TimeoutError extends VerikoError {
  /** The resource that was awaited: a validation, an import or an export. */
  readonly resourceId: string;
  /** The wait that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(message: string, resourceId: string, timeoutMs: number) {
    super(message);
    this.resourceId = resourceId;
    this.timeoutMs = timeoutMs;
  }

  /** The same as `resourceId` when the awaited resource was a validation. */
  get validationId(): string {
    return this.resourceId;
  }
}

function numberHeader(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
