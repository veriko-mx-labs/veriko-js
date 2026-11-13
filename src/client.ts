/** The client: the entry point of the SDK and the operation families. */

import {
  DEFAULT_RETRY,
  Transport,
  type AcceptLanguage,
  type CallOptions,
  type RetryConfig,
} from './http.js';
import {
  Account,
  Beneficiaries,
  Billing,
  Catalog,
  Dashboard,
  Finance,
  Insights,
  Plans,
  Usage,
  Validations,
  Webhooks,
} from './resources.js';
import type { ApiPromise, DeprecationNotice, ResponseMeta } from './response.js';
import type {
  CepDocument,
  CepOptions,
  GetValidationOptions,
  ValidateTransferParams,
  ValidationResult,
  ValidationWithEtag,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.veriko.mx/v1';
/**
 * Wait per attempt. The API can take up to 45 s on a synchronous validation before it
 * answers `202`, so the default sits above that limit.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const API_KEY_ENV_VAR = 'VERIKO_API_KEY';
export const BASE_URL_ENV_VAR = 'VERIKO_BASE_URL';

/** The version that travels in the `User-Agent`. `test/client.test.ts` compares it with `package.json`. */
export const VERSION = '0.6.0';

interface RuntimeGlobals {
  Deno?: { version?: { deno?: string } };
}

/** The runtime and its version: `node`, `deno` or `bun`. */
function runtime(): string {
  const deno = (globalThis as unknown as RuntimeGlobals).Deno?.version?.deno;
  if (deno) return `deno ${deno}`;
  const versions = typeof process !== 'undefined' ? process.versions : undefined;
  if (versions?.bun) return `bun ${versions.bun}`;
  return `node ${versions?.node ?? 'unknown'}`;
}

/** Reads an environment variable where the runtime has one. */
function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

/**
 * The SDK `User-Agent`: `veriko-sdk-js/<version> (<runtime> <version>; <os> <architecture>)`,
 * with the wrapping product in front and the integrator's suffix at the end. It carries
 * only runtime, system and architecture.
 */
export function buildUserAgent(prefix?: string, suffix?: string): string {
  const platform = typeof process !== 'undefined' ? process.platform : 'unknown';
  const arch = typeof process !== 'undefined' ? process.arch : 'unknown';
  const own = `veriko-sdk-js/${VERSION} (${runtime()}; ${platform} ${arch})`;
  return [prefix, own, suffix].filter((part) => part !== undefined && part !== '').join(' ');
}

export interface VerikoOptions {
  /** The API key. Defaults to `VERIKO_API_KEY`. */
  apiKey?: string;
  /** The root of the API. Defaults to `VERIKO_BASE_URL` or production. */
  baseUrl?: string;
  /**
   * Milliseconds to wait per attempt. Defaults to 60,000: the API can take up to 45 s on a
   * synchronous validation before it answers `202`.
   */
  timeoutMs?: number;
  /**
   * Automatic retries in addition to the first attempt. `0` disables them. What is retried:
   * `5xx`, `408` and `429`, and for a `POST` only when it carries an `Idempotency-Key` (or
   * on `429`). `429` with `quota_exceeded` is never retried.
   */
  maxRetries?: number;
  /** `es` or `en`, the language of `error.detail`. Overridable per call. */
  acceptLanguage?: AcceptLanguage;
  /** Full retry configuration. It wins over `maxRetries`. */
  retry?: Partial<RetryConfig>;
  /** Text appended to the end of the `User-Agent`, separated by a space. */
  userAgentSuffix?: string;
  /**
   * Product that wraps the SDK and goes before its token in the `User-Agent`, for example
   * `veriko-mcp/0.2.0 (stdio)`.
   */
  userAgentPrefix?: string;
  /** Receives the metadata of every successful response. */
  onResponse?: (meta: ResponseMeta) => void;
  /**
   * Receives the `Deprecation` and `Sunset` headers of a response, once per distinct pair.
   * Without it, the SDK emits a process warning (`VERIKO_API_DEPRECATION`).
   */
  onDeprecation?: (notice: DeprecationNotice) => void;
  /** An already built transport. Tests use it to avoid the network. */
  transport?: Transport;
}

/**
 * Client of the Veriko API.
 *
 * The API key is read from `options.apiKey` or, when it is not passed, from the
 * `VERIKO_API_KEY` environment variable. It starts with `veriko_` and is obtained in the
 * dashboard: https://app.veriko.mx
 *
 * Every method returns a promise that also offers `.withResponse()`, and accepts as its
 * last argument `{ signal, timeoutMs, maxRetries, idempotencyKey, headers, acceptLanguage }`.
 *
 * Operations are grouped by family:
 *
 * - `client.validations`: validate, query, retry and download.
 * - `client.webhooks`: endpoints and their delivery history.
 * - `client.catalog`: banks and the status of the Banxico service.
 * - `client.beneficiaries`: saved accounts and their bulk import.
 * - `client.usage`: quota, limits and activity log.
 * - `client.account`: profile and default retry policy.
 * - `client.dashboard`: dashboard summary.
 * - `client.plans`: catalog and comparison of public plans.
 * - `client.insights`: aggregated account metrics.
 * - `client.finance`: summaries and financial downloads.
 * - `client.billing`: active subscription.
 *
 * The three most frequent ones are also at the root, as a shortcut:
 *
 * ```ts
 * const client = new Veriko();
 *
 * const validation = await client.validateTransfer({
 *   sendDate: '2025-03-15',
 *   amount: 15000.5,
 *   trackingKey: 'MXBA20250315001234',
 *   beneficiaryAccount: '012180004412345678',
 * });
 * ```
 */
export class Veriko {
  private readonly transport: Transport;

  /** Validate, query, retry and download. */
  readonly validations: Validations;
  /** Webhook endpoints and their delivery history. */
  readonly webhooks: Webhooks;
  /** Bank catalog and status of the Banxico service. */
  readonly catalog: Catalog;
  /** Saved beneficiary accounts and their bulk import. */
  readonly beneficiaries: Beneficiaries;
  /** Quota, limits and activity log. */
  readonly usage: Usage;
  /** Profile and preferences of the authenticated account. */
  readonly account: Account;
  /** Dashboard summary. */
  readonly dashboard: Dashboard;
  /** Public plan catalog. */
  readonly plans: Plans;
  /** Aggregated account metrics. */
  readonly insights: Insights;
  /** Financial summaries and downloads. */
  readonly finance: Finance;
  /** Active subscription of the account. */
  readonly billing: Billing;

  constructor(options: VerikoOptions = {}) {
    const apiKey = options.apiKey ?? env(API_KEY_ENV_VAR) ?? '';
    this.transport =
      options.transport ??
      new Transport({
        baseUrl: options.baseUrl ?? env(BASE_URL_ENV_VAR) ?? DEFAULT_BASE_URL,
        apiKey,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retry: {
          ...DEFAULT_RETRY,
          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          ...options.retry,
        },
        userAgent: buildUserAgent(options.userAgentPrefix, options.userAgentSuffix),
        acceptLanguage: options.acceptLanguage,
        onResponse: options.onResponse,
        onDeprecation: options.onDeprecation,
      });

    this.validations = new Validations(this.transport);
    this.webhooks = new Webhooks(this.transport);
    this.catalog = new Catalog(this.transport);
    this.beneficiaries = new Beneficiaries(this.transport);
    this.usage = new Usage(this.transport);
    this.account = new Account(this.transport);
    this.dashboard = new Dashboard(this.transport);
    this.plans = new Plans(this.transport);
    this.insights = new Insights(this.transport);
    this.finance = new Finance(this.transport);
    this.billing = new Billing(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * Shortcut for `client.validations.validate()`.
   *
   * Validates a SPEI transfer against Banxico's CEP. `POST /v1/validate`. Returns the
   * verdict in `attributes.status`: `valid`, `not_found`, `cep_unavailable`, `invalid`,
   * `returned`, `failed` or `error`. When the Banxico query passes 45 seconds, the result
   * carries `queued` and `attributes.status` is `processing`.
   *
   * The operation requires `beneficiaryAccount`, or `candidateAccounts` when it is not known
   * which account it was (one of the two, not both), and `trackingKey` or `numericReference`.
   * Sending both of the latter narrows the search. The date (`sendDate`) is the send date,
   * as `YYYY-MM-DD`, and is optional: without it the API tries candidate dates.
   * `clientRef` is a reference of your own that returns in the validation and in webhooks.
   *
   * An immediate `not_found` does not mean the transfer does not exist: a CEP takes time to
   * be published. `retryPolicy` leaves the API querying again and notifying by webhook when
   * the verdict changes.
   *
   * Each call consumes quota of the plan, charged when the request is accepted.
   */
  validateTransfer(
    params: ValidateTransferParams,
    options?: CallOptions,
  ): ApiPromise<ValidationResult> {
    return this.validations.validate(params, options);
  }

  /**
   * Shortcut for `client.validations.get()`.
   *
   * Reads a validation by its identifier. `GET /v1/validations/{id}`. It is the operation
   * that follows a validation left retrying: the final verdict appears when
   * `attributes.status` reaches a terminal state.
   */
  getValidation(
    validationId: string,
    options: GetValidationOptions = {},
  ): ApiPromise<ValidationWithEtag> {
    return this.validations.get(validationId, options);
  }

  /**
   * Shortcut for `client.validations.cep()`.
   *
   * Downloads the official CEP of a validation. `GET /v1/validations/{id}/cep`. Returns the
   * file: the XML that Banxico issued, with its digital seal and original string, or the
   * equivalent PDF.
   */
  getCep(validationId: string, options: CepOptions = {}): ApiPromise<CepDocument> {
    return this.validations.cep(validationId, options);
  }
}
