/**
 * The operations of the API, grouped by family.
 *
 * Each family is a property of the client: `client.validations`, `client.webhooks`,
 * `client.catalog` and the rest. The three most frequent methods remain at the root of
 * the client, because they are the short path of the main use case.
 *
 * Every method returns an `ApiPromise` and accepts `CallOptions` as its last argument:
 * `signal`, `timeoutMs`, `maxRetries`, `idempotencyKey`, `headers` and `acceptLanguage`.
 * `.withResponse()` adds the status and the headers to the resource.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  OCR_PARAM_ALIASES,
  TRANSFER_PARAM_ALIASES,
  fillDashboardSummary,
  fillFinanceSummary,
  fillValidation,
  fillValidationSummary,
  resolveAliases,
  toBoolean,
} from './aliases.js';
import {
  ApiError,
  ConfigurationError,
  ERROR_CODES,
  InvalidRequestError,
  NotModifiedError,
  TimeoutError,
} from './errors.js';
import type { components } from './generated/openapi.js';
import {
  defaultSleep,
  filenameFromContentDisposition,
  type CallOptions,
  type RawResponse,
  type Send,
  type Transport,
} from './http.js';
import {
  checkedId,
  joinList,
  pathSegment,
  readData,
  readDocument,
  readList,
  readMeta,
  type EntityId,
  type Query,
} from './internal.js';
import { iteratePages, parsePage, type IterOptions, type Page } from './pagination.js';
import { ApiPromise, type CallState } from './response.js';
import {
  CEP_FORMATS,
  EXPORT_FORMATS,
  IMPORT_TEMPLATE_FORMATS,
  isCepExportTerminal,
  isImportSettled,
  isSettled,
  type ApiUsage,
  type Bank,
  type BankList,
  type BanksOptions,
  type BanxicoStatus,
  type BanxicoTimeseries,
  type Beneficiary,
  type BeneficiaryImportCommitted,
  type BeneficiaryImportJob,
  type BeneficiaryImportRow,
  type BeneficiaryImportStarted,
  type AccountValidation,
  type BeneficiaryLookup,
  type BillingSubscription,
  type BinLookup,
  type CanonicalOcrParams,
  type CanonicalTransferParams,
  type CepDocument,
  type CepStream,
  type CepOptions,
  type CreateBeneficiaryParams,
  type CreatedBeneficiary,
  type CreateWebhookParams,
  type DashboardSummary,
  type DashboardSummaryParams,
  type DeliveriesParams,
  type DeliveryFilters,
  type DownloadedFile,
  type DownloadedStream,
  type EditImportRowParams,
  type ExecutePurgeParams,
  type ExportBeneficiariesParams,
  type ExportDeliveriesParams,
  type ExportFormat,
  type ExportUsageParams,
  type ExportValidationsParams,
  type FinanceAccountingParams,
  type FinanceCepExport,
  type FinanceCepExportParams,
  type FinanceCepsParams,
  type FinanceReport,
  type FinanceReportStreamParams,
  type FinanceParams,
  type FinancePreview,
  type FinancePreviewParams,
  type FinanceStatementParams,
  type FinanceSummary,
  type GetValidationOptions,
  type ImportPreviewParams,
  type ImportStartOptions,
  type ImportTemplateFormat,
  type ImportTemplateOptions,
  type InsightsOverview,
  type InsightsTopBanks,
  type InsightsTopBeneficiaries,
  type InsightsTrends,
  type ListBeneficiariesParams,
  type ListValidationsParams,
  type OcrValidationRequest,
  type PublicPlanComparison,
  type PublicPlans,
  type PurgePreparation,
  type PurgeResult,
  type QueuedInfo,
  type QueuedValidation,
  type RecheckResult,
  type RegenerateSecretParams,
  type RetryAttempt,
  type RetryPolicy,
  type RetryStateResource,
  type SpeiCalendar,
  type SpeiCalendarOptions,
  type TelegramDispatch,
  type TimeseriesParams,
  type UpdateBeneficiaryParams,
  type UpdateWebhookParams,
  type UsageBreakdown,
  type UsageBreakdownParams,
  type UsageHeatmap,
  type UsageHeatmapParams,
  type UsageHistory,
  type UsageHistoryParams,
  type UsageLimits,
  type UsageSummary,
  type UserInsightsTopBanksParams,
  type UserInsightsTopBeneficiariesParams,
  type UserInsightsTrendsParams,
  type UserProfile,
  type UserRetryPolicy,
  type ValidateAccountParams,
  type ValidateOcrParams,
  type ValidateTransferParams,
  type Validation,
  type ValidationFilters,
  type ValidationQueuedResource,
  type ValidationRecheckMeta,
  type ValidationRequest,
  type ValidationResult,
  type ValidationStats,
  type ValidationSummary,
  type ValidationWithEtag,
  type WaitForOptions,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookSubscriptionEvent,
  type WebhookTestResult,
} from './types.js';

type Schemas = components['schemas'];

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
/** The server suggests 2 seconds on every poll; this is the pause when it says nothing. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IMPORT_POLL_INTERVAL_MS = 2_000;
/** Time after `expires_at` that `waitFor()` keeps polling, so it can read the `ttl_expired` verdict. */
const EXPIRY_GRACE_MS = 30_000;

const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_ACCEPT =
  'image/png, image/jpeg, image/webp, application/pdf, application/octet-stream, application/json';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/** The most delivery endpoints a single query accepts. */
const MAX_ENDPOINT_FILTER = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

function flag(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? '1' : '0';
}

/** An error the SDK raises before sending: the API would answer `422` with the same code. */
function localError(message: string, code: string): InvalidRequestError {
  return new InvalidRequestError(message, { status: 422, code, local: true });
}

/**
 * The filters of a query, with the name the API expects.
 *
 * `test/spec.test.ts` compares the keys of this result with the parameters of
 * `GET /v1/validations`, so a new filter in the spec does not go unnoticed.
 */
export function filtersToQuery(filters: ValidationFilters): Query {
  return {
    status: joinList(filters.status),
    type: filters.type,
    from: filters.from,
    to: filters.to,
    search: filters.search,
    playground: filters.playground ? '1' : undefined,
    with_deleted: flag(filters.withDeleted),
    batch_id: filters.batchId,
    bank: filters.bank,
    banks: joinList(filters.banks),
    amount_min: filters.amountMin,
    amount_max: filters.amountMax,
    client_ref: filters.clientRef,
    retry_state: filters.retryState,
  };
}

/** Splits the endpoint, or the list of endpoints, from the arguments of a deliveries query. */
function deliveriesArguments<T extends object>(
  first: string | readonly string[] | T | undefined,
  second: T | undefined,
): [string | readonly string[] | undefined, T] {
  if (typeof first === 'string' || Array.isArray(first)) {
    return [first as string | readonly string[], second ?? ({} as T)];
  }
  return [undefined, (first as T | undefined) ?? ({} as T)];
}

/** One or several endpoints for the `endpoint_id` filter, comma-separated. */
function endpointIds(webhookId: string | readonly string[] | undefined): string | undefined {
  if (webhookId === undefined) return undefined;
  const ids = typeof webhookId === 'string' ? [webhookId] : webhookId;
  if (ids.length > MAX_ENDPOINT_FILTER) {
    throw new ConfigurationError(
      `A deliveries query accepts at most ${String(MAX_ENDPOINT_FILTER)} endpoints; got ${String(ids.length)}`,
    );
  }
  return ids.map((id) => checkedId(id)).join(',');
}

/** The filters of a deliveries query, with the name and value the API expects. */
export function deliveryFiltersToQuery(filters: DeliveryFilters): Query {
  const responseStatus = filters.responseStatus;
  return {
    status: joinList(filters.status),
    event_type: joinList(filters.eventType),
    response_status:
      responseStatus === undefined
        ? undefined
        : typeof responseStatus === 'object'
          ? responseStatus.map(String).join(',')
          : String(responseStatus),
    validation_id: filters.validationId,
    q: filters.q,
    from: filters.from,
    to: filters.to,
    min_attempt: filters.minAttempt,
    min_response_time_ms: filters.minResponseTimeMs,
  };
}

function hasValues(query: Query): boolean {
  return Object.values(query).some((value) => value !== undefined);
}

function idempotencyHeader(key: string | undefined): Record<string, string | undefined> {
  return { 'idempotency-key': key };
}

/**
 * The account of the request: a single one, or a list of candidates, never both.
 *
 * How many candidates the platform admits is decided by the API, which answers `422`
 * with `candidate_accounts_invalid` when the list does not comply.
 */
function accountFields(
  beneficiaryAccount: string | undefined,
  candidateAccounts: readonly string[] | undefined,
): Pick<ValidationRequest, 'beneficiary_account' | 'candidate_accounts'> {
  if (candidateAccounts === undefined) {
    return beneficiaryAccount ? { beneficiary_account: beneficiaryAccount } : {};
  }
  if (beneficiaryAccount) {
    throw localError(
      'Send beneficiaryAccount or candidateAccounts, not both',
      ERROR_CODES.ACCOUNT_AND_CANDIDATES_MUTUALLY_EXCLUSIVE,
    );
  }
  if (!Array.isArray(candidateAccounts)) {
    throw localError(
      'candidateAccounts is an array of accounts',
      ERROR_CODES.CANDIDATE_ACCOUNTS_INVALID,
    );
  }
  return { candidate_accounts: (candidateAccounts as readonly string[]).slice() };
}

/** A decimal amount as a number, without letting `NaN` or `Infinity` through. */
function amountValue(amount: number | string): number {
  const value = typeof amount === 'string' ? Number(amount.trim()) : amount;
  if (typeof amount === 'string' && amount.trim() === '') {
    throw localError('amount is empty', 'invalid_amount');
  }
  if (!Number.isFinite(value)) {
    throw localError(`amount is not a finite number: ${String(amount)}`, 'invalid_amount');
  }
  return value;
}

/** The body of a validation by fields, with its prior check. */
function directBody(input: ValidateTransferParams): ValidationRequest {
  const params = resolveAliases<CanonicalTransferParams>(input, TRANSFER_PARAM_ALIASES);
  if (!params.trackingKey && !params.numericReference) {
    throw localError(
      'trackingKey or numericReference is required to find the transfer in the CEP',
      ERROR_CODES.TRACKING_KEY_OR_REFERENCE_REQUIRED,
    );
  }
  if (params.candidateAccounts === undefined && !params.beneficiaryAccount) {
    throw localError(
      'beneficiaryAccount is required, or candidateAccounts when it is not known which ' +
        'account it was: the API does not look it up among the saved beneficiaries',
      ERROR_CODES.ACCOUNT_REQUIRED,
    );
  }

  const body: ValidationRequest = accountFields(
    params.beneficiaryAccount,
    params.candidateAccounts,
  );
  if (params.amount !== undefined) body.amount = amountValue(params.amount);
  if (params.sendDate !== undefined) body.send_date = params.sendDate;
  if (params.trackingKey !== undefined) body.tracking_key = params.trackingKey;
  if (params.numericReference !== undefined) body.numeric_reference = params.numericReference;
  if (params.senderBank !== undefined) body.sender_bank = params.senderBank;
  if (params.receiverBank !== undefined) body.receiver_bank = params.receiverBank;
  if (params.recipientIsBank !== undefined) {
    body.recipient_is_bank = toBoolean(params.recipientIsBank);
  }
  if (params.retryPolicy !== undefined) body.retry_policy = params.retryPolicy;
  if (params.clientRef !== undefined) body.client_ref = params.clientRef;
  return body;
}

/** Returns the receipt in base64, reading it from disk when it is a path. */
async function encodeImage(image: Uint8Array | string): Promise<string> {
  if (typeof image !== 'string') return Buffer.from(image).toString('base64');
  let content: Buffer;
  try {
    content = await readFile(image);
  } catch (cause) {
    const missing =
      typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
    throw new ConfigurationError(
      missing
        ? `The image file does not exist: ${image}`
        : `The image file ${image} could not be read: ${String(cause)}`,
    );
  }
  return content.toString('base64');
}

/** The body of a validation by OCR, with its prior check. */
async function ocrBody(input: ValidateOcrParams): Promise<OcrValidationRequest> {
  const params = resolveAliases<CanonicalOcrParams>(input, OCR_PARAM_ALIASES);
  if (params.image === undefined && !params.imageUrl) {
    throw localError(
      'The receipt image is required: pass `image` or `imageUrl`',
      'image_or_image_url_required',
    );
  }

  const body: OcrValidationRequest = {};
  if (params.image !== undefined) body.image = await encodeImage(params.image);
  if (params.imageUrl) body.image_url = params.imageUrl;
  Object.assign(
    body,
    accountFields(params.beneficiaryAccount || undefined, params.candidateAccounts),
  );
  if (params.retryPolicy !== undefined) body.retry_policy = params.retryPolicy;
  if (params.clientRef !== undefined) body.client_ref = params.clientRef;
  if (params.retainImage !== undefined) body.retain_image = params.retainImage;
  if (params.senderBank !== undefined) body.sender_bank = params.senderBank;
  if (params.receiverBank !== undefined) body.receiver_bank = params.receiverBank;
  if (params.recipientIsBank !== undefined) {
    body.recipient_is_bank = toBoolean(params.recipientIsBank);
  }
  return body;
}

function pollHint(response: RawResponse): number | undefined {
  let poll: unknown;
  if (response.body.length > 0) {
    try {
      poll = readMeta(readDocument(response))['next_poll_after_seconds'];
    } catch {
      // A body that is not JSON carries no hint.
    }
  }
  if (typeof poll === 'number') return poll;
  const header = Number(response.headers['retry-after']);
  return response.headers['retry-after'] !== undefined && Number.isFinite(header)
    ? header
    : undefined;
}

function queuedInfo(response: RawResponse, data: ValidationQueuedResource): QueuedInfo {
  const meta = readMeta(readDocument(response));
  const reason = meta['async_reason'];
  return {
    asyncReason: typeof reason === 'string' ? reason : undefined,
    nextPollAfterSeconds: pollHint(response),
    etag: response.headers['etag'],
    location: response.headers['location'],
    expiresAt: data.attributes?.expires_at,
  };
}

function readQueued(response: RawResponse): QueuedValidation {
  const document = readDocument(response);
  const data = document['data'] as ValidationQueuedResource | undefined;
  if (!data?.id) {
    throw new ApiError('The 202 response has no validation identifier', {
      status: response.status,
      headers: response.headers,
    });
  }
  const info = queuedInfo(response, data);
  return {
    id: data.id,
    status: data.attributes?.status ?? 'queued',
    etag: info.etag,
    location: info.location,
    nextPollAfterSeconds: info.nextPollAfterSeconds,
    asyncReason: info.asyncReason,
    expiresAt: info.expiresAt,
    data,
  };
}

/** The result of `validate()`: the verdict on `200`, the reduced resource with `queued` on `202`. */
function readValidated(response: RawResponse): ValidationResult {
  const validation: ValidationResult = fillValidation(
    readData<Validation>(response, 'of the validation'),
  );
  if (response.status === 202) {
    validation.queued = queuedInfo(response, validation as unknown as ValidationQueuedResource);
  }
  return validation;
}

async function cepDownload(
  send: Send,
  validationId: string,
  options: CepOptions,
  stream: boolean,
): Promise<CepDocument | CepStream> {
  const format = options.format ?? 'xml';
  if (!CEP_FORMATS.includes(format)) {
    throw new ConfigurationError(`The CEP format is 'xml' or 'pdf'; got ${JSON.stringify(format)}`);
  }
  const accept = format === 'xml' ? 'application/xml' : 'application/pdf';
  const response = await send({
    method: 'GET',
    path: `/validations/${pathSegment(validationId)}/cep`,
    query: { format },
    accept: `${accept}, application/json`,
    stream,
  });
  const name = `CEP-${validationId}.${format}`;
  const type = response.headers['content-type'] ?? accept;
  return stream
    ? { validationId, format, ...toStream(response, name, type) }
    : { validationId, format, ...toFile(response, name, type) };
}

async function imageDownload(
  send: Send,
  validationId: string,
  stream: boolean,
): Promise<DownloadedFile | DownloadedStream> {
  const response = await send({
    method: 'GET',
    path: `/validations/${pathSegment(validationId)}/image`,
    accept: IMAGE_ACCEPT,
    stream,
  });
  const contentType = response.headers['content-type'] ?? 'image/png';
  const extension = IMAGE_EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] ?? '';
  const name = `receipt-${validationId}${extension}`;
  return stream ? toStream(response, name, contentType) : toFile(response, name, contentType);
}

async function templateDownload(
  send: Send,
  options: ImportTemplateOptions,
  stream: boolean,
): Promise<DownloadedFile | DownloadedStream> {
  const format = options.format ?? 'csv';
  if (!IMPORT_TEMPLATE_FORMATS.includes(format)) {
    throw new ConfigurationError(
      `The template format is 'csv', 'xlsx', 'xls', 'txt' or 'json'; got ${JSON.stringify(format)}`,
    );
  }
  const accept = TEMPLATE_CONTENT_TYPES[format];
  const response = await send({
    method: 'GET',
    path: '/beneficiaries/imports/template',
    query: { format },
    accept: `${accept}, application/octet-stream, application/json`,
    stream,
  });
  const name = `beneficiaries-template.${format}`;
  const type = response.headers['content-type'] ?? accept;
  return stream ? toStream(response, name, type) : toFile(response, name, type);
}

/** The stream of a response made with `stream: true`. */
function toStream(response: RawResponse, filename: string, contentType: string): DownloadedStream {
  if (!response.stream) {
    throw new Error('The response carries no stream');
  }
  const length = Number(response.headers['content-length']);
  return {
    stream: response.stream,
    contentType,
    filename: filenameFromContentDisposition(response.headers['content-disposition'], filename),
    contentLength: Number.isInteger(length) && length >= 0 ? length : undefined,
    headers: response.headers,
  };
}

function toFile(response: RawResponse, filename: string, contentType: string): DownloadedFile {
  return {
    content: response.body,
    contentType,
    filename: filenameFromContentDisposition(response.headers['content-disposition'], filename),
    headers: response.headers,
  };
}

function notModified(what: string, response: RawResponse): NotModifiedError {
  return new NotModifiedError(`${what} has not changed since the ETag given`, {
    status: 304,
    headers: response.headers,
  });
}

/** Downloads an export in CSV or XLSX; with `stream`, hands the body over unread. */
function exportFile(
  send: Send,
  path: string,
  format: ExportFormat,
  query: Query,
  fallbackName: string,
  extraAccept?: string,
  stream?: false,
): Promise<DownloadedFile>;
function exportFile(
  send: Send,
  path: string,
  format: ExportFormat,
  query: Query,
  fallbackName: string,
  extraAccept: string | undefined,
  stream: true,
): Promise<DownloadedStream>;
async function exportFile(
  send: Send,
  path: string,
  format: ExportFormat,
  query: Query,
  fallbackName: string,
  extraAccept?: string,
  stream?: boolean,
): Promise<DownloadedFile | DownloadedStream> {
  if (!EXPORT_FORMATS.includes(format)) {
    throw new ConfigurationError(
      `The export format is 'csv' or 'xlsx'; got ${JSON.stringify(format)}`,
    );
  }
  const accept = EXPORT_CONTENT_TYPES[format];
  const response = await send({
    method: 'GET',
    path,
    query: { ...query, format },
    accept: [accept, extraAccept, 'application/json'].filter(Boolean).join(', '),
    stream,
  });
  const name = `${fallbackName}.${format}`;
  const type = response.headers['content-type'] ?? accept;
  return stream ? toStream(response, name, type) : toFile(response, name, type);
}

/** Merges the options of a wait into the options of each request of its polling. */
function pollCall(options: WaitForOptions): CallOptions {
  const call: CallOptions = { ...options };
  const loose = call as Record<string, unknown>;
  delete loose['timeoutMs'];
  delete loose['pollIntervalMs'];
  delete loose['sleep'];
  delete loose['requestTimeoutMs'];
  if (options.requestTimeoutMs !== undefined) call.timeoutMs = options.requestTimeoutMs;
  return call;
}

/** The pause before the next poll: never shorter than the server asks. */
function pollPause(
  floorMs: number | undefined,
  defaultMs: number,
  hintSeconds: number | undefined,
): number {
  const base = floorMs ?? defaultMs;
  return hintSeconds === undefined ? base : Math.max(base, hintSeconds * 1000);
}

/** Runs a call made of several calls, remembering the last response of the whole. */
function chain<T>(options: CallOptions, run: (call: CallOptions) => Promise<T>): ApiPromise<T> {
  const state: CallState = {};
  const call: CallOptions = {
    ...options,
    onResponse: (meta) => {
      state.last = meta;
      options.onResponse?.(meta);
    },
  };
  return ApiPromise.wrap(run(call), state);
}

type ValidationRead =
  | { notModified: true; response: RawResponse }
  | { notModified: false; validation: ValidationWithEtag; response: RawResponse };

async function readValidation(
  send: Send,
  validationId: string,
  ifNoneMatch: string | undefined,
): Promise<ValidationRead> {
  const response = await send({
    method: 'GET',
    path: `/validations/${pathSegment(validationId)}`,
    headers: { 'if-none-match': ifNoneMatch },
  });
  if (response.status === 304) return { notModified: true, response };

  const validation: ValidationWithEtag = fillValidation(
    readData<Validation>(response, 'of the validation'),
  );
  const etag = response.headers['etag'];
  if (etag) validation.etag = etag;
  return { notModified: false, validation, response };
}

// ── Validations ─────────────────────────────────────────────────────────────

/**
 * SPEI validations: create them, follow them and download what they produce.
 *
 * A validation purged with `executePurge()` answers `410` (`GoneError`) with
 * `validation_purged` on the CEP, the receipt, the retries and the later recheck.
 */
export class Validations {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // Create

  /**
   * Validates a SPEI transfer against Banxico's CEP.
   *
   * `POST /v1/validate`. Returns the verdict in `attributes.status`. For volume there is
   * `enqueue()`, which accepts the request and leaves the verdict for later.
   *
   * The account goes in `beneficiaryAccount`, or in `candidateAccounts` when it is not
   * known which it was: from 2 accounts up to the platform maximum (3 by default, 10 at
   * most) in one validation and with one unit of quota. Send one of the two, not both. The
   * API does not look the account up among the saved beneficiaries. The account that
   * matched is in `attributes.candidate_match`.
   *
   * `clientRef` is a reference of your own, from 1 to 64 characters, that returns in
   * `attributes.client_ref` and in webhooks, and that `list()` accepts as an exact filter.
   *
   * `attributes.account_cross_checked` is `true` when the account queried at Banxico is the
   * client's own. With `false`, a `valid` confirms the transfer exists, but not that it was
   * paid to the expected account.
   *
   * The call carries an `Idempotency-Key`, generated when `idempotencyKey` is missing, so
   * the SDK can repeat it after a lost response without running it twice.
   *
   * When the Banxico query takes more than 45 seconds, the API answers `202` and the
   * validation continues in the background. The result then carries `queued`, its
   * `attributes.status` is `processing`, and the verdict is collected with `waitFor()`.
   * `validateAndWait()` does both steps.
   */
  validate(params: ValidateTransferParams, options?: CallOptions): ApiPromise<ValidationResult> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: '/validate',
        body: directBody(params),
        idempotent: true,
        headers: idempotencyHeader(params.idempotencyKey),
      });
      return readValidated(response);
    });
  }

  /**
   * Validates a transfer from the receipt, as an image or a PDF.
   *
   * `POST /v1/validate-ocr`. The file is read from disk when `image` is a path, and encoded
   * in base64 here. Formats: JPEG, PNG, WebP or a PDF of 1 to 3 pages.
   *
   * `imageUrl` serves for a receipt already published over HTTPS. If both are sent, the API
   * considers only `image`.
   *
   * `candidateAccounts` replaces `beneficiaryAccount` when the image does not show the
   * account and it is not known which it was, with one unit of quota. Send one of the two,
   * not both.
   *
   * `retainImage` is `true` by default: the platform keeps the file and `image()` serves
   * it. With `false` it deletes it as soon as the validation reaches a terminal state in
   * which it no longer needs it, and `attributes.image_retained` is `false`.
   *
   * Like `validate()`, it carries an `Idempotency-Key` and answers `202` with `queued` when
   * the Banxico query passes 45 seconds.
   */
  validateOcr(params: ValidateOcrParams, options?: CallOptions): ApiPromise<ValidationResult> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: '/validate-ocr',
        body: await ocrBody(params),
        idempotent: true,
        headers: idempotencyHeader(params.idempotencyKey),
      });
      return readValidated(response);
    });
  }

  /**
   * Validates a transfer and waits for the verdict.
   *
   * It calls `validate()` and, when the API answers `202`, polls with `waitFor()` using the
   * `expires_at` and the poll interval of the acknowledgment. `options` applies to the
   * request and to the wait.
   */
  validateAndWait(
    params: ValidateTransferParams,
    options: WaitForOptions = {},
  ): ApiPromise<ValidationWithEtag> {
    return chain(pollCall(options), async (call) => {
      const result = await this.validate(params, call);
      return this.settle(result, options, call);
    });
  }

  /** The same as `validateAndWait()`, from the receipt. */
  validateOcrAndWait(
    params: ValidateOcrParams,
    options: WaitForOptions = {},
  ): ApiPromise<ValidationWithEtag> {
    return chain(pollCall(options), async (call) => {
      const result = await this.validateOcr(params, call);
      return this.settle(result, options, call);
    });
  }

  private async settle(
    result: ValidationResult,
    options: WaitForOptions,
    call: CallOptions,
  ): Promise<ValidationWithEtag> {
    if (!result.queued) return result;
    const queued: QueuedValidation = {
      id: result.id,
      status: result.attributes.status ?? 'processing',
      etag: result.queued.etag,
      location: result.queued.location,
      nextPollAfterSeconds: result.queued.nextPollAfterSeconds,
      asyncReason: result.queued.asyncReason,
      expiresAt: result.queued.expiresAt,
      data: result as unknown as ValidationQueuedResource,
    };
    return this.waitFor(queued, { ...options, onResponse: call.onResponse });
  }

  /**
   * Queues a validation by fields and returns the acknowledgment.
   *
   * `POST /v1/validate?async=1`. It accepts the same arguments as `validate()`. The API
   * answers `202` with the identifier; the verdict is collected with `waitFor()`, or
   * arrives by webhook.
   *
   * @see https://docs.veriko.mx/en/concepts/async-validations
   */
  enqueue(params: ValidateTransferParams, options?: CallOptions): ApiPromise<QueuedValidation> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: '/validate',
        body: directBody(params),
        query: { async: 1 },
        idempotent: true,
        headers: idempotencyHeader(params.idempotencyKey),
      });
      return readQueued(response);
    });
  }

  /**
   * Queues a validation by OCR and returns the acknowledgment.
   *
   * `POST /v1/validate-ocr?async=1`. It accepts the same arguments as `validateOcr()`.
   */
  enqueueOcr(params: ValidateOcrParams, options?: CallOptions): ApiPromise<QueuedValidation> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: '/validate-ocr',
        body: await ocrBody(params),
        query: { async: 1 },
        idempotent: true,
        headers: idempotencyHeader(params.idempotencyKey),
      });
      return readQueued(response);
    });
  }

  // Query

  /**
   * Reads a validation by its identifier.
   *
   * `GET /v1/validations/{id}`. With `ifNoneMatch` the API answers `304` when nothing
   * changed since that `ETag`, and the SDK throws it as `NotModifiedError`. The `ETag` of
   * each read is in `etag`.
   */
  get(validationId: string, options: GetValidationOptions = {}): ApiPromise<ValidationWithEtag> {
    return this.transport.call(options, async (send) => {
      const result = await readValidation(send, validationId, options.ifNoneMatch);
      if (result.notModified) throw notModified('The validation', result.response);
      return result.validation;
    });
  }

  /**
   * Lists the validations of the account, with filters and pagination.
   *
   * `GET /v1/validations`. A list carries fewer fields than `get()`. `clientRef` filters by
   * exact match with the reference sent when validating.
   */
  list(
    params: ListValidationsParams = {},
    options?: CallOptions,
  ): ApiPromise<Page<ValidationSummary>> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/validations',
        query: { page: params.page, per_page: params.perPage, ...filtersToQuery(params) },
      });
      const page = parsePage<ValidationSummary>(response);
      for (const item of page.items) fillValidationSummary(item);
      return page;
    });
  }

  /**
   * Walks every validation that matches the filters.
   *
   * It requests each page when the previous one runs out. `maxPages` bounds the walk, and
   * `page` sets the starting page.
   *
   * ```ts
   * for await (const validation of client.validations.iter({ status: 'valid' })) {
   *   console.log(validation.id);
   * }
   * ```
   */
  iter(
    params: ListValidationsParams & IterOptions = {},
    options?: CallOptions,
  ): AsyncIterable<ValidationSummary> {
    const { maxPages, page, ...filters } = params;
    return iteratePages((number) => this.list({ ...filters, page: number }, options), {
      startPage: page ?? 1,
      maxPages,
    });
  }

  /**
   * The totals of the validations of the account, with the same filters.
   *
   * `GET /v1/validations/stats`.
   */
  stats(filters: ValidationFilters = {}, options?: CallOptions): ApiPromise<ValidationStats> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/validations/stats',
        query: filtersToQuery(filters),
      });
      return readData<ValidationStats>(response, 'of the statistics');
    });
  }

  /**
   * The attempts of the retry cycle of a validation.
   *
   * `GET /v1/validations/{id}/retry-attempts`.
   */
  retryAttempts(validationId: string, options?: CallOptions): ApiPromise<RetryAttempt[]> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: `/validations/${pathSegment(validationId)}/retry-attempts`,
      });
      return readList<RetryAttempt>(response, 'of the attempts');
    });
  }

  /**
   * Polls a validation until its verdict is settled.
   *
   * It is the pair of `enqueue()`. Pass the identifier, or the acknowledgment itself to
   * use its `expires_at` and poll interval. Each poll sends `If-None-Match` with the `ETag`
   * of the previous response, so a poll that finds no changes does not download the same
   * body again.
   *
   * The pause between polls is never shorter than what the server asks, in `Retry-After`
   * or `meta.next_poll_after_seconds` (2 seconds); `pollIntervalMs` raises that floor.
   * Without `timeoutMs`, the wait lasts until `expires_at` when the API reported one, and
   * five minutes otherwise.
   *
   * It waits for `isSettled()`, not `isTerminal()`: a validation with retries running
   * reaches `not_found` and keeps changing afterwards.
   *
   * @throws {TimeoutError} If the wait runs out without a settled verdict.
   */
  waitFor(
    target: string | QueuedValidation,
    options: WaitForOptions = {},
  ): ApiPromise<ValidationWithEtag> {
    return this.transport.call(pollCall(options), async (send) => {
      const validationId = typeof target === 'string' ? target : target.id;
      const sleep = options.sleep ?? defaultSleep;
      const started = performance.now();

      const expiryOf = (value: string | undefined | null): number | undefined => {
        if (!value) return undefined;
        const time = Date.parse(value);
        return Number.isNaN(time) ? undefined : time;
      };
      let expiresAt = typeof target === 'string' ? undefined : expiryOf(target.expiresAt);
      let hint: number | undefined;
      let etag = typeof target === 'string' ? undefined : target.etag;
      let latest: ValidationWithEtag | undefined;

      // Without `timeoutMs`, the wait lasts until `expires_at` plus a grace period, fixed
      // the first time the API reports it; five minutes until then.
      let deadline = started + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      let deadlineFromExpiry = false;
      const fixDeadline = (): void => {
        if (options.timeoutMs !== undefined || deadlineFromExpiry || expiresAt === undefined)
          return;
        deadlineFromExpiry = true;
        deadline = performance.now() + Math.max(expiresAt - Date.now(), 0) + EXPIRY_GRACE_MS;
      };
      fixDeadline();

      for (;;) {
        const result = await readValidation(send, validationId, etag);
        hint = pollHint(result.response);
        if (!result.notModified) {
          latest = result.validation;
          etag = result.validation.etag;
          const attributes = latest.attributes as { expires_at?: string | null };
          expiresAt = expiryOf(attributes.expires_at) ?? expiresAt;
        }
        if (latest && isSettled(latest)) return latest;
        fixDeadline();
        if (performance.now() >= deadline) {
          const total = deadline - started;
          throw new TimeoutError(
            `Validation ${validationId} did not reach a settled verdict within ${String(Math.round(total))} ms`,
            validationId,
            Math.round(total),
          );
        }
        await sleep(pollPause(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, hint));
      }
    });
  }

  // Files

  /**
   * Downloads the official CEP of a validation as XML or PDF.
   *
   * `GET /v1/validations/{id}/cep`. Returns the file: the XML that Banxico issued, with its
   * digital seal and original string, or the equivalent PDF.
   *
   * It exists when the validation has a receipt (`hasCep()`). When it does not, the API
   * answers `404` with `cep_not_available` and the SDK throws `NotFoundError`.
   */
  cep(validationId: string, options: CepOptions = {}): ApiPromise<CepDocument> {
    return this.transport.call(
      options,
      (send) => cepDownload(send, validationId, options, false) as Promise<CepDocument>,
    );
  }

  /**
   * Like `cep()`, but hands the body over as a `ReadableStream` and does not buffer it.
   * See `DownloadedStream`.
   */
  cepStream(validationId: string, options: CepOptions = {}): ApiPromise<CepStream> {
    return this.transport.call(
      options,
      (send) => cepDownload(send, validationId, options, true) as Promise<CepStream>,
    );
  }

  /**
   * Downloads the receipt of a validation by OCR: an image or a PDF.
   *
   * `GET /v1/validations/{id}/image`. Answers `410` (`GoneError`) with `image_not_retained`
   * when the validation was created with `retainImage: false`.
   */
  image(validationId: string, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(
      options,
      (send) => imageDownload(send, validationId, false) as Promise<DownloadedFile>,
    );
  }

  /** Like `image()`, but hands the body over as a `ReadableStream`. See `DownloadedStream`. */
  imageStream(validationId: string, options?: CallOptions): ApiPromise<DownloadedStream> {
    return this.transport.call(
      options,
      (send) => imageDownload(send, validationId, true) as Promise<DownloadedStream>,
    );
  }

  /**
   * Exports the validation history as CSV or XLSX.
   *
   * `GET /v1/validations/export`. It accepts the same filters as `list()`.
   */
  export(params: ExportValidationsParams = {}, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/validations/export',
        params.format ?? 'csv',
        { ...filtersToQuery(params), limit: params.limit },
        'validations',
      ),
    );
  }

  /** Like `export()`, but hands the body over as a `ReadableStream`. See `DownloadedStream`. */
  exportStream(
    params: ExportValidationsParams = {},
    options?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/validations/export',
        params.format ?? 'csv',
        { ...filtersToQuery(params), limit: params.limit },
        'validations',
        undefined,
        true,
      ),
    );
  }

  // Change

  /**
   * Changes the retry policy of a specific validation.
   *
   * `PUT /v1/validations/{id}/retry-policy`. Returns the state of the retry cycle, not the
   * full validation. It carries an `Idempotency-Key`, generated when missing.
   */
  setRetryPolicy(
    validationId: string,
    policy: RetryPolicy,
    options?: CallOptions,
  ): ApiPromise<RetryStateResource> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'PUT',
        path: `/validations/${pathSegment(validationId)}/retry-policy`,
        body: { retry_policy: policy },
        idempotent: true,
      });
      return readData<RetryStateResource>(response, 'of the retry state');
    });
  }

  /**
   * Stops the pending retry cycle of a validation.
   *
   * `POST /v1/validations/{id}/cancel-retries`. If the cycle is no longer active, the API
   * answers `422` with `retry_not_active`. It carries an `Idempotency-Key`, generated when
   * missing.
   */
  cancelRetries(validationId: string, options?: CallOptions): ApiPromise<RetryStateResource> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/validations/${pathSegment(validationId)}/cancel-retries`,
        idempotent: true,
      });
      return readData<RetryStateResource>(response, 'of the retry state');
    });
  }

  /**
   * Removes a validation from the history.
   *
   * `DELETE /v1/validations/{id}`. The API answers `204` with no body.
   */
  delete(validationId: string, options?: CallOptions): ApiPromise<void> {
    return this.transport.call(options, async (send) => {
      await send({ method: 'DELETE', path: `/validations/${pathSegment(validationId)}` });
    });
  }

  /**
   * Sends the receipt to the Telegram chat linked to the account.
   *
   * `POST /v1/validations/{id}/cep/send-telegram`. The API acknowledges with `202`: the
   * delivery happens later. The SDK does not repeat this call after a lost response,
   * because it could send the message twice.
   */
  sendCepToTelegram(validationId: string, options?: CallOptions): ApiPromise<TelegramDispatch> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/validations/${pathSegment(validationId)}/cep/send-telegram`,
      });
      return readData<TelegramDispatch>(response, 'of the delivery');
    });
  }

  // Recheck and purge

  /**
   * Queries Banxico again for the payment state of a `valid` validation.
   *
   * `POST /v1/validations/{id}/recheck`. It does not consume quota. A `valid` is the
   * verdict of the moment of the query: Banxico can report the return hours or days later.
   * If it reports it, the validation becomes `returned`, keeps its CEP, and the API emits
   * the `validation.returned` webhook.
   *
   * A `valid` created at most 72 hours ago is queried. A `returned` answers its current
   * state without querying Banxico, with `checkedAt` as `null`. Any other, or a `valid`
   * outside the window, answers `422` with `recheck_not_eligible` or
   * `recheck_window_expired`.
   *
   * Each validation admits one query every 10 minutes: earlier, it answers `429` with
   * `recheck_rate_limited`, and `RateLimitError.retryAfter` carries the seconds left. If
   * Banxico does not deliver a readable state it answers `503` with `recheck_unavailable`,
   * and the validation keeps its interval. A purged validation answers `410` with
   * `validation_purged`. The SDK does not retry this call on its own: each of those
   * responses already carries its wait.
   *
   * @see https://docs.veriko.mx/en/concepts/cep-concept
   */
  recheck(validationId: string, options?: CallOptions): ApiPromise<RecheckResult> {
    return this.transport.call({ ...options, maxRetries: 0 }, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/validations/${pathSegment(validationId)}/recheck`,
      });
      const document = readDocument(response);
      const validation = fillValidation(document['data'] as Validation | undefined);
      if (!validation?.id) {
        throw new ApiError('The response has no `data` resource of the validation', {
          status: response.status,
          headers: response.headers,
        });
      }
      const recheck = readMeta(document)['recheck'] as Partial<ValidationRecheckMeta> | undefined;
      return {
        validation,
        checkedAt: recheck?.checked_at ?? null,
        changed: recheck?.changed === true,
        previousStatus: recheck?.previous_status ?? 'valid',
      };
    });
  }

  /**
   * Describes what the permanent deletion of a validation would erase.
   *
   * `POST /v1/validations/{id}/purge/prepare`. It changes nothing: it returns what would be
   * erased, what the tombstone would keep and a single-use `confirmation_token` that
   * expires in `expires_in` seconds and that `executePurge()` requires.
   *
   * It admits only a validation of your own in a terminal state. A validation in progress
   * answers `409` with `purge_validation_in_progress`, and one already purged, `410` with
   * `validation_purged`.
   *
   * @see https://docs.veriko.mx/en/how-to/purge-a-validation
   */
  preparePurge(validationId: string, options?: CallOptions): ApiPromise<PurgePreparation> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/validations/${pathSegment(validationId)}/purge/prepare`,
      });
      return readData<PurgePreparation>(response, 'of the purge preparation');
    });
  }

  /**
   * Permanently deletes the content of a validation.
   *
   * `POST /v1/validations/{id}/purge/execute`. It is the second step: `confirmationToken`
   * is the one `preparePurge()` returned for this same validation. **The deletion is
   * irreversible** and does not return quota. The validation remains as a tombstone: it
   * keeps the verdict, the dates and the amount, and carries `attributes.purged_at`.
   *
   * A missing, malformed, expired or other-validation token answers `422`; one already
   * used, `409` with `confirmation_token_already_used`. If the response does not arrive,
   * `get()` tells whether the purge completed: a purged validation carries `purged_at`. The
   * SDK does not retry this call on its own.
   *
   * @see https://docs.veriko.mx/en/how-to/purge-a-validation
   */
  executePurge(
    validationId: string,
    params: ExecutePurgeParams,
    options?: CallOptions,
  ): ApiPromise<PurgeResult> {
    return this.transport.call({ ...options, maxRetries: 0 }, async (send) => {
      if (!params.confirmationToken) {
        throw localError(
          'confirmationToken is required: preparePurge() returns it',
          'confirmation_token_missing',
        );
      }
      const response = await send({
        method: 'POST',
        path: `/validations/${pathSegment(validationId)}/purge/execute`,
        body: { confirmation_token: params.confirmationToken },
      });
      return readData<PurgeResult>(response, 'of the purge');
    });
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/**
 * The events of an endpoint, with their prior check.
 *
 * It takes the wide type because a caller from JavaScript can omit them, and the type of
 * `create()` declares them required.
 */
function subscribedEvents(
  events: readonly WebhookSubscriptionEvent[] | undefined,
): WebhookSubscriptionEvent[] {
  if (!events?.length) {
    throw localError('An endpoint subscribes to at least one event', 'events_required');
  }
  return [...events];
}

/** Webhook endpoints and their delivery history. */
export class Webhooks {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Registers an endpoint and returns its signing secret.
   *
   * `POST /v1/webhooks`. The secret travels **once**, in `attributes.secret` of this
   * response: store it on receipt. If it is lost, rotate it with `regenerateSecret()`. The
   * SDK does not repeat this call after a lost response, because it could register the
   * endpoint twice.
   */
  create(params: CreateWebhookParams, options?: CallOptions): ApiPromise<WebhookEndpoint> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['CreateWebhookRequest'] = {
        url: params.url,
        events: subscribedEvents(params.events),
      };
      if (params.description !== undefined) body.description = params.description;
      const response = await send({ method: 'POST', path: '/webhooks', body });
      return readData<WebhookEndpoint>(response, 'of the endpoint');
    });
  }

  /**
   * Lists the registered endpoints, without their secrets.
   *
   * `GET /v1/webhooks`.
   */
  list(options?: CallOptions): ApiPromise<WebhookEndpoint[]> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/webhooks' });
      return readList<WebhookEndpoint>(response, 'of the endpoints');
    });
  }

  /**
   * Changes the URL, the subscribed events, the label or the state of an endpoint.
   *
   * `PUT /v1/webhooks/{id}`. An endpoint the system turned off is reactivated with
   * `status: 'active'`; `auto_disabled` cannot be assigned from the API.
   */
  update(
    webhookId: string,
    params: UpdateWebhookParams,
    options?: CallOptions,
  ): ApiPromise<WebhookEndpoint> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['UpdateWebhookRequest'] = {};
      if (params.url !== undefined) body.url = params.url;
      if (params.events !== undefined) body.events = subscribedEvents(params.events);
      if (params.description !== undefined) body.description = params.description;
      if (params.status !== undefined) body.status = params.status;
      if (Object.keys(body).length === 0) {
        throw localError(
          'Nothing to change: pass url, events, description or status',
          'empty_update',
        );
      }
      const response = await send({
        method: 'PUT',
        path: `/webhooks/${pathSegment(webhookId)}`,
        body,
      });
      return readData<WebhookEndpoint>(response, 'of the endpoint');
    });
  }

  /**
   * Removes an endpoint.
   *
   * `DELETE /v1/webhooks/{id}`. The API answers `204`.
   */
  delete(webhookId: string, options?: CallOptions): ApiPromise<void> {
    return this.transport.call(options, async (send) => {
      await send({ method: 'DELETE', path: `/webhooks/${pathSegment(webhookId)}` });
    });
  }

  /**
   * Sends a test event to the endpoint.
   *
   * `POST /v1/webhooks/{id}/test`. Test deliveries do not count toward the counter of
   * consecutive failures.
   */
  test(webhookId: string, options?: CallOptions): ApiPromise<WebhookTestResult> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/webhooks/${pathSegment(webhookId)}/test`,
      });
      return readData<WebhookTestResult>(response, 'of the test');
    });
  }

  /**
   * Rotates the signing secret of an endpoint.
   *
   * `POST /v1/webhooks/{id}/regenerate-secret`. The new secret comes in `attributes.secret`,
   * and it is the last time the API delivers it.
   *
   * Without `immediate`, the previous secret keeps signing for 24 hours: each delivery
   * carries `X-Webhook-Signature-Old`, and `attributes.previous_secret_expires_at` says
   * until when. Verify with both secrets in the meantime. With `immediate: true` the
   * previous secret stops being valid at once; use it if the secret was exposed.
   */
  regenerateSecret(
    webhookId: string,
    params: RegenerateSecretParams = {},
    options?: CallOptions,
  ): ApiPromise<WebhookEndpoint> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/webhooks/${pathSegment(webhookId)}/regenerate-secret`,
        body: params.immediate === undefined ? undefined : { immediate: params.immediate },
      });
      return readData<WebhookEndpoint>(response, 'of the endpoint');
    });
  }

  // Deliveries

  /**
   * Lists the delivery attempts.
   *
   * With `webhookId` it queries those of that endpoint; without it, those of all of them.
   * Filters exist only in the global list, so with `webhookId` and a filter the request
   * goes to `GET /v1/webhooks/deliveries` with `endpoint_id`. A list of up to 20 endpoints
   * always goes to that list.
   */
  deliveries(params?: DeliveriesParams, options?: CallOptions): ApiPromise<Page<WebhookDelivery>>;
  deliveries(
    webhookId: string | readonly string[],
    params?: DeliveriesParams,
    options?: CallOptions,
  ): ApiPromise<Page<WebhookDelivery>>;
  deliveries(
    first?: string | readonly string[] | DeliveriesParams,
    second?: DeliveriesParams | CallOptions,
    third?: CallOptions,
  ): ApiPromise<Page<WebhookDelivery>> {
    const byEndpoint = typeof first === 'string' || Array.isArray(first);
    const options = byEndpoint ? third : (second as CallOptions | undefined);
    return this.transport.call(options, async (send) => {
      const [webhookId, params] = deliveriesArguments<DeliveriesParams>(
        first,
        second as DeliveriesParams | undefined,
      );
      const filters = deliveryFiltersToQuery(params);
      const paging = { page: params.page, per_page: params.perPage };
      const response =
        typeof webhookId === 'string' && !hasValues(filters)
          ? await send({
              method: 'GET',
              path: `/webhooks/${pathSegment(webhookId)}/deliveries`,
              query: paging,
            })
          : await send({
              method: 'GET',
              path: '/webhooks/deliveries',
              query: { ...paging, endpoint_id: endpointIds(webhookId), ...filters },
            });
      return parsePage<WebhookDelivery>(response);
    });
  }

  /**
   * Walks every delivery attempt, page by page.
   *
   * It accepts the same arguments as `deliveries()`, plus `maxPages`.
   */
  iterDeliveries(
    params?: DeliveriesParams & IterOptions,
    options?: CallOptions,
  ): AsyncIterable<WebhookDelivery>;
  iterDeliveries(
    webhookId: string | readonly string[],
    params?: DeliveriesParams & IterOptions,
    options?: CallOptions,
  ): AsyncIterable<WebhookDelivery>;
  iterDeliveries(
    first?: string | readonly string[] | (DeliveriesParams & IterOptions),
    second?: (DeliveriesParams & IterOptions) | CallOptions,
    third?: CallOptions,
  ): AsyncIterable<WebhookDelivery> {
    const byEndpoint = typeof first === 'string' || Array.isArray(first);
    const options = byEndpoint ? third : (second as CallOptions | undefined);
    const [webhookId, params] = deliveriesArguments<DeliveriesParams & IterOptions>(
      first,
      second as (DeliveriesParams & IterOptions) | undefined,
    );
    const { maxPages, page, ...filters } = params;

    return iteratePages(
      (number) =>
        webhookId === undefined
          ? this.deliveries({ ...filters, page: number }, options)
          : this.deliveries(webhookId, { ...filters, page: number }, options),
      { startPage: page ?? 1, maxPages },
    );
  }

  /**
   * Exports the delivery history as CSV or XLSX.
   *
   * With `webhookId`, those of that endpoint; without it, those of all of them. It accepts
   * the filters of `deliveries()`, and as there a filter with `webhookId`, or a list of
   * endpoints, takes the request to the global list.
   */
  exportDeliveries(
    params?: ExportDeliveriesParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedFile>;
  exportDeliveries(
    webhookId: string | readonly string[],
    params?: ExportDeliveriesParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedFile>;
  exportDeliveries(
    first?: string | readonly string[] | ExportDeliveriesParams,
    second?: ExportDeliveriesParams | CallOptions,
    third?: CallOptions,
  ): ApiPromise<DownloadedFile> {
    return this.deliveriesExport(first, second, third, false) as ApiPromise<DownloadedFile>;
  }

  /**
   * Like `exportDeliveries()`, but hands the body over as a `ReadableStream`. See
   * `DownloadedStream`.
   */
  exportDeliveriesStream(
    params?: ExportDeliveriesParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedStream>;
  exportDeliveriesStream(
    webhookId: string | readonly string[],
    params?: ExportDeliveriesParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedStream>;
  exportDeliveriesStream(
    first?: string | readonly string[] | ExportDeliveriesParams,
    second?: ExportDeliveriesParams | CallOptions,
    third?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.deliveriesExport(first, second, third, true) as ApiPromise<DownloadedStream>;
  }

  private deliveriesExport(
    first: string | readonly string[] | ExportDeliveriesParams | undefined,
    second: ExportDeliveriesParams | CallOptions | undefined,
    third: CallOptions | undefined,
    stream: boolean,
  ): ApiPromise<DownloadedFile | DownloadedStream> {
    const byEndpoint = typeof first === 'string' || Array.isArray(first);
    const options = byEndpoint ? third : (second as CallOptions | undefined);
    return this.transport.call(options, (send) => {
      const [webhookId, params] = deliveriesArguments<ExportDeliveriesParams>(
        first,
        second as ExportDeliveriesParams | undefined,
      );
      const filters = deliveryFiltersToQuery(params);
      const format = params.format ?? 'csv';

      if (typeof webhookId === 'string' && !hasValues(filters)) {
        return exportFile(
          send,
          `/webhooks/${pathSegment(webhookId)}/deliveries/export`,
          format,
          { limit: params.limit },
          `deliveries-${webhookId}`,
          undefined,
          stream as true,
        );
      }
      return exportFile(
        send,
        '/webhooks/deliveries/export',
        format,
        { limit: params.limit, endpoint_id: endpointIds(webhookId), ...filters },
        typeof webhookId === 'string' ? `deliveries-${webhookId}` : 'deliveries',
        undefined,
        stream as true,
      );
    });
  }
}

// ── Catalog ─────────────────────────────────────────────────────────────────

/** Open data: the bank catalog, the SPEI calendar and the service status. */
export class Catalog {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Lists the institutions that participate in SPEI, with their code.
   *
   * `GET /v1/public/banks`. With `ifNoneMatch` the API answers `304` when the catalog did
   * not change, and the SDK throws it as `NotModifiedError`. The `ETag` of each read is in
   * `etag`.
   */
  banks(options: BanksOptions = {}): ApiPromise<BankList> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/public/banks',
        headers: { 'if-none-match': options.ifNoneMatch },
      });
      if (response.status === 304) throw notModified('The catalog', response);

      const banks: BankList = readList<Bank>(response, 'of the banks');
      const etag = response.headers['etag'];
      if (etag) banks.etag = etag;
      return banks;
    });
  }

  /**
   * Resolves the issuing bank of a card from its first digits.
   *
   * `GET /v1/public/bin-lookup/{bin}`.
   */
  binLookup(bin: string, options?: CallOptions): ApiPromise<BinLookup> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: `/public/bin-lookup/${pathSegment(bin)}`,
      });
      return readData<BinLookup>(response, 'of the BIN');
    });
  }

  /**
   * The calendar of SPEI non-business days of a year, with the provision it comes from.
   *
   * `GET /v1/public/spei-calendar/{year}`. It does not consume quota. A year without a
   * calendar is thrown as `NotFoundError` with `spei_calendar_year_not_covered`. With
   * `ifNoneMatch` the API answers `304` when the calendar did not change, and the SDK
   * throws it as `NotModifiedError`. The `ETag` of each read is in `etag`, and the years
   * with a calendar in `coveredYears`.
   */
  speiCalendar(year: number, options: SpeiCalendarOptions = {}): ApiPromise<SpeiCalendar> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: `/public/spei-calendar/${pathSegment(String(year))}`,
        headers: { 'if-none-match': options.ifNoneMatch },
      });
      if (response.status === 304) throw notModified('The calendar', response);

      const calendar = readData<SpeiCalendar>(response, 'of the calendar');
      const covered = readMeta(readDocument(response))['covered_years'];
      calendar.coveredYears = Array.isArray(covered)
        ? covered.filter((item): item is number => typeof item === 'number')
        : [];
      const etag = response.headers['etag'];
      if (etag) calendar.etag = etag;
      return calendar;
    });
  }

  /**
   * Status of the Banxico query service.
   *
   * `GET /v1/status/banxico`. It serves to tell a `cep_unavailable` of the transfer itself
   * from an outage of the service.
   */
  banxicoStatus(options?: CallOptions): ApiPromise<BanxicoStatus> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/status/banxico' });
      return readData<BanxicoStatus>(response, 'of the status');
    });
  }

  /**
   * Time series of the health of the Banxico service.
   *
   * `GET /v1/status/banxico/timeseries`.
   */
  banxicoTimeseries(
    params: TimeseriesParams = {},
    options?: CallOptions,
  ): ApiPromise<BanxicoTimeseries> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/status/banxico/timeseries',
        query: { metric: params.metric, window: params.window },
      });
      return readData<BanxicoTimeseries>(response, 'of the series');
    });
  }
}

// ── Beneficiaries ───────────────────────────────────────────────────────────

const IMPORT_CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const TEMPLATE_CONTENT_TYPES: Record<ImportTemplateFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  json: 'application/json',
};

/** The content of an import file, its name and its type. */
async function importFile(
  file: Uint8Array | string,
  filename: string | undefined,
): Promise<{ content: Uint8Array; filename: string; contentType: string }> {
  let content: Uint8Array;
  let name: string;
  if (typeof file === 'string') {
    try {
      content = await readFile(file);
    } catch {
      throw new ConfigurationError(`The file does not exist: ${file}`);
    }
    name = filename ?? basename(file);
  } else {
    content = file;
    name = filename ?? 'beneficiaries.csv';
  }
  return {
    content,
    filename: name,
    contentType: IMPORT_CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
  };
}

function noValidFields(what: string): InvalidRequestError {
  return localError(`Nothing to change: pass ${what}`, 'no_valid_fields');
}

/** Saved beneficiary accounts and their bulk import. */
export class Beneficiaries {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // The allow list

  /**
   * Registers a beneficiary account.
   *
   * `POST /v1/beneficiaries`. The type is detected by length: CLABE (18 digits), card (16)
   * or DiMo phone (10). For a phone, `bankCode` is required; for CLABE and card it is
   * derived from the number. Registering an archived account reactivates it: the API
   * answers `200` instead of `201` and `reactivated` is `true`. Without `label`, the
   * reactivated account keeps its alias. An active account with the same number is thrown
   * as `InvalidRequestError` with `beneficiary_already_registered`. The SDK does not repeat
   * this call after a lost response.
   */
  create(params: CreateBeneficiaryParams, options?: CallOptions): ApiPromise<CreatedBeneficiary> {
    return this.transport.call(options, async (send) => {
      // A caller from JavaScript can omit it; the type declares it required.
      const accountNumber: string | undefined = params.accountNumber;
      if (!accountNumber) {
        throw localError(
          'accountNumber is required to register the beneficiary',
          'account_number_required',
        );
      }
      const body: Schemas['CreateBeneficiaryRequest'] = { account_number: accountNumber };
      if (params.bankCode !== undefined) body.bank_code = params.bankCode;
      if (params.label !== undefined) body.label = params.label;

      const response = await send({ method: 'POST', path: '/beneficiaries', body });
      const beneficiary = readData<CreatedBeneficiary>(response, 'of the beneficiary');
      beneficiary.reactivated = readMeta(readDocument(response))['reactivated'] === true;
      return beneficiary;
    });
  }

  /**
   * Lists the saved beneficiary accounts.
   *
   * `GET /v1/beneficiaries`. Not paginated: it returns the whole list. `withArchived: true`
   * brings only the archived ones and `false` only the active ones.
   */
  list(params: ListBeneficiariesParams = {}, options?: CallOptions): ApiPromise<Beneficiary[]> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/beneficiaries',
        query: { with_archived: flag(params.withArchived) },
      });
      return readList<Beneficiary>(response, 'of the beneficiaries');
    });
  }

  /**
   * Changes the label, the account or the bank of a beneficiary.
   *
   * `PUT /v1/beneficiaries/{id}`. A new `accountNumber` derives the type and the bank
   * again; `bankCode` applies only to phone-type accounts.
   */
  update(
    beneficiaryId: EntityId,
    params: UpdateBeneficiaryParams,
    options?: CallOptions,
  ): ApiPromise<Beneficiary> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['UpdateBeneficiaryRequest'] = {};
      if (params.label !== undefined) body.label = params.label;
      if (params.accountNumber !== undefined) body.account_number = params.accountNumber;
      if (params.bankCode !== undefined) body.bank_code = params.bankCode;
      if (Object.keys(body).length === 0) throw noValidFields('label, accountNumber or bankCode');

      const response = await send({
        method: 'PUT',
        path: `/beneficiaries/${pathSegment(String(beneficiaryId))}`,
        body,
      });
      return readData<Beneficiary>(response, 'of the beneficiary');
    });
  }

  /**
   * Archives a beneficiary.
   *
   * `DELETE /v1/beneficiaries/{id}`. The record is not deleted: it leaves the active list
   * and is queried with `withArchived: true`. A later registration of the same account
   * reactivates it. The API answers `204`.
   */
  delete(beneficiaryId: EntityId, options?: CallOptions): ApiPromise<void> {
    return this.transport.call(options, async (send) => {
      await send({
        method: 'DELETE',
        path: `/beneficiaries/${pathSegment(String(beneficiaryId))}`,
      });
    });
  }

  /**
   * Resolves a specific account within the own list.
   *
   * `GET /v1/beneficiaries/lookup`. Returns the bank data when the account is among the
   * saved ones; otherwise the API answers `404`.
   */
  lookup(account: string, options?: CallOptions): ApiPromise<BeneficiaryLookup> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/beneficiaries/lookup',
        query: { account },
      });
      return readData<BeneficiaryLookup>(response, 'of the account');
    });
  }

  /**
   * Checks the structure of an account number, without querying Banxico.
   *
   * `GET /v1/beneficiaries/validate-account`. The type is detected by length: CLABE (18
   * digits), card (16) or DiMo phone (10). The CLABE check digit or the card Luhn is
   * verified, and the bank is resolved. `type` forces the interpretation: `clabe` resolves
   * the bank by prefix even if the CLABE is incomplete, and `bin` resolves it as a card
   * BIN.
   *
   * A malformed number is not an error: the API answers `200` and reflects it in
   * `attributes.checksum_valid` and `attributes.account_type`. It does not consume quota.
   */
  validateAccount(
    params: ValidateAccountParams,
    options?: CallOptions,
  ): ApiPromise<AccountValidation> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/beneficiaries/validate-account',
        query: { account: params.account, type: params.type },
      });
      return readData<AccountValidation>(response, 'of the account');
    });
  }

  /**
   * Exports the beneficiary list as CSV or XLSX.
   *
   * `GET /v1/beneficiaries/export`. Numbers come out masked except the CLABE; `limit` only
   * lowers the cap of 100,000 rows.
   */
  export(
    params: ExportBeneficiariesParams = {},
    options?: CallOptions,
  ): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/beneficiaries/export',
        params.format ?? 'csv',
        { with_archived: flag(params.withArchived), limit: params.limit },
        'beneficiaries',
        'application/octet-stream',
      ),
    );
  }

  /** Like `export()`, but hands the body over as a `ReadableStream`. See `DownloadedStream`. */
  exportStream(
    params: ExportBeneficiariesParams = {},
    options?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/beneficiaries/export',
        params.format ?? 'csv',
        { with_archived: flag(params.withArchived), limit: params.limit },
        'beneficiaries',
        'application/octet-stream',
        true,
      ),
    );
  }

  // Bulk import

  /**
   * Downloads the template for the bulk import.
   *
   * `GET /v1/beneficiaries/imports/template`. It is the starting point of the cycle:
   * download, fill in, upload, review and confirm.
   */
  importTemplate(options: ImportTemplateOptions = {}): ApiPromise<DownloadedFile> {
    return this.transport.call(
      options,
      (send) => templateDownload(send, options, false) as Promise<DownloadedFile>,
    );
  }

  /** Like `importTemplate()`, but hands the body over as a `ReadableStream`. */
  importTemplateStream(options: ImportTemplateOptions = {}): ApiPromise<DownloadedStream> {
    return this.transport.call(
      options,
      (send) => templateDownload(send, options, true) as Promise<DownloadedStream>,
    );
  }

  /**
   * Uploads a file and opens an import job.
   *
   * `POST /v1/beneficiaries/imports`. `file` is the bytes of the file or its path, which
   * the SDK reads from disk. Formats: CSV, XLS, XLSX, TXT, JSON or PDF, up to 20 MB. Only
   * one import can be open at a time: another answers `422` with `import_already_in_flight`.
   * `parseMode` is `template` (canonical headers) or `free` (free format). The response is
   * a `202` with the job in state `pending`; nothing is persisted until `importCommit()`.
   * The SDK does not repeat this call after a lost response.
   */
  importStart(
    file: Uint8Array | string,
    options: ImportStartOptions = {},
  ): ApiPromise<BeneficiaryImportStarted> {
    return this.transport.call(options, async (send) => {
      const upload = await importFile(file, options.filename);
      const form = new FormData();
      form.append('parse_mode', options.parseMode ?? 'template');
      form.append(
        'file',
        new Blob([upload.content], { type: upload.contentType }),
        upload.filename,
      );

      const response = await send({ method: 'POST', path: '/beneficiaries/imports', body: form });
      return readData<BeneficiaryImportStarted>(response, 'of the import');
    });
  }

  /**
   * Reads the state of an import job and its counters.
   *
   * `GET /v1/beneficiaries/imports/{id}`.
   */
  importStatus(importId: EntityId, options?: CallOptions): ApiPromise<BeneficiaryImportJob> {
    return this.transport.call(options, (send) => this.readImport(send, importId));
  }

  private async readImport(send: Send, importId: EntityId): Promise<BeneficiaryImportJob> {
    const response = await send({
      method: 'GET',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}`,
    });
    return readData<BeneficiaryImportJob>(response, 'of the import');
  }

  /**
   * Cancels an import that has not been confirmed yet.
   *
   * `DELETE /v1/beneficiaries/imports/{id}`. It admits the states `pending`, `parsing` and
   * `preview_ready`; with a terminal one or `committing`, the API answers `404`. Accounts
   * that a confirmation already persisted are archived one by one with `delete()`. The API
   * answers `204`.
   */
  importCancel(importId: EntityId, options?: CallOptions): ApiPromise<void> {
    return this.transport.call(options, async (send) => {
      await send({
        method: 'DELETE',
        path: `/beneficiaries/imports/${pathSegment(String(importId))}`,
      });
    });
  }

  /**
   * Lists the rows extracted from the import, paginated.
   *
   * `GET /v1/beneficiaries/imports/{id}/preview`. Available in `preview_ready` or later.
   * `buckets` filters by group (`valid`, `correctable`, `fatal`, `duplicate_account`,
   * `duplicate_alias`); the SDK sends it as `buckets[]`, which is the form the API reads.
   */
  importPreview(
    importId: EntityId,
    params: ImportPreviewParams = {},
    options?: CallOptions,
  ): ApiPromise<Page<BeneficiaryImportRow>> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: `/beneficiaries/imports/${pathSegment(String(importId))}/preview`,
        query: { page: params.page, per_page: params.perPage, 'buckets[]': params.buckets },
      });
      return parsePage<BeneficiaryImportRow>(response);
    });
  }

  /**
   * Walks every row of the preview, page by page.
   *
   * It accepts the same arguments as `importPreview()`, plus `maxPages`.
   */
  iterImportPreview(
    importId: EntityId,
    params: ImportPreviewParams & IterOptions = {},
    options?: CallOptions,
  ): AsyncIterable<BeneficiaryImportRow> {
    const { maxPages, page, ...filters } = params;
    return iteratePages(
      (number) => this.importPreview(importId, { ...filters, page: number }, options),
      { startPage: page ?? 1, maxPages },
    );
  }

  /**
   * Corrects a row of the preview before confirming.
   *
   * `PATCH /v1/beneficiaries/imports/{id}/rows/{row_id}`. Only the fields present are
   * overwritten; the row is processed again and its group can change with the correction.
   */
  importEditRow(
    importId: EntityId,
    rowId: EntityId,
    params: EditImportRowParams,
    options?: CallOptions,
  ): ApiPromise<BeneficiaryImportRow> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['PatchBeneficiaryImportRowRequest'] = {};
      if (params.parsedAccount !== undefined) body.parsed_account = params.parsedAccount;
      if (params.parsedLabel !== undefined) body.parsed_label = params.parsedLabel;
      if (params.parsedAccountType !== undefined) {
        body.parsed_account_type = params.parsedAccountType;
      }
      if (params.parsedBankCode !== undefined) body.parsed_bank_code = params.parsedBankCode;
      if (params.parsedBankName !== undefined) body.parsed_bank_name = params.parsedBankName;
      if (Object.keys(body).length === 0) throw noValidFields('any of the parsed* fields');

      const response = await send({
        method: 'PATCH',
        path: `/beneficiaries/imports/${pathSegment(String(importId))}/rows/${pathSegment(String(rowId))}`,
        body,
      });
      return readData<BeneficiaryImportRow>(response, 'of the row');
    });
  }

  /**
   * Removes a row from the preview.
   *
   * `DELETE /v1/beneficiaries/imports/{id}/rows/{row_id}`. The API answers `204`.
   */
  importRemoveRow(importId: EntityId, rowId: EntityId, options?: CallOptions): ApiPromise<void> {
    return this.transport.call(options, async (send) => {
      await send({
        method: 'DELETE',
        path: `/beneficiaries/imports/${pathSegment(String(importId))}/rows/${pathSegment(String(rowId))}`,
      });
    });
  }

  /**
   * Confirms the import and triggers the persistence of its rows.
   *
   * `POST /v1/beneficiaries/imports/{id}/commit`. The operation is asynchronous: the
   * response is a `202` with the job in `committing`, and the result is followed with
   * `importWait()`. The SDK does not repeat this call after a lost response.
   */
  importCommit(importId: EntityId, options?: CallOptions): ApiPromise<BeneficiaryImportCommitted> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'POST',
        path: `/beneficiaries/imports/${pathSegment(String(importId))}/commit`,
      });
      return readData<BeneficiaryImportCommitted>(response, 'of the import');
    });
  }

  /**
   * Polls an import until its progress stops.
   *
   * It waits for `isImportSettled()`: `preview_ready` or a final state. Unlike
   * `validations.waitFor()`, there is no `ETag` to reuse here: the status endpoint does
   * not expose one, so each poll downloads the whole body.
   *
   * @throws {TimeoutError} If `timeoutMs` runs out before a settled state.
   */
  importWait(importId: EntityId, options: WaitForOptions = {}): ApiPromise<BeneficiaryImportJob> {
    return this.transport.call(pollCall(options), async (send) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
      const sleep = options.sleep ?? defaultSleep;
      const deadline = performance.now() + timeoutMs;

      for (;;) {
        const job = await this.readImport(send, importId);
        if (isImportSettled(job)) return job;
        if (performance.now() >= deadline) {
          throw new TimeoutError(
            `Import ${String(importId)} did not reach preview_ready or a final state within ${String(timeoutMs)} ms`,
            String(importId),
            timeoutMs,
          );
        }
        await sleep(pollIntervalMs);
      }
    });
  }
}

// ── Usage ───────────────────────────────────────────────────────────────────

/** Usage and limits: the quota of the plan and the activity log. */
export class Usage {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * The validation quota of the current plan.
   *
   * `GET /v1/usage/summary`. It carries the limit, what is used, what is left and the
   * warning level in `attributes.tone`.
   */
  summary(options?: CallOptions): ApiPromise<UsageSummary> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/usage/summary' });
      return readData<UsageSummary>(response, 'of the usage');
    });
  }

  /**
   * The monthly usage of the last `months` months.
   *
   * `GET /v1/usage/history`. From most recent to oldest. The limit that accompanies each
   * row is today's, not the one in force that month.
   */
  history(params: UsageHistoryParams = {}, options?: CallOptions): ApiPromise<UsageHistory> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/usage/history',
        query: { months: params.months },
      });
      return readData<UsageHistory>(response, 'of the history');
    });
  }

  /**
   * Breaks the usage down by type of counted operation.
   *
   * `GET /v1/usage/breakdown`. `period` is `current` for the current month or a `YYYY-MM`
   * string.
   */
  breakdown(params: UsageBreakdownParams = {}, options?: CallOptions): ApiPromise<UsageBreakdown> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/usage/breakdown',
        query: { period: params.period },
      });
      return readData<UsageBreakdown>(response, 'of the breakdown');
    });
  }

  /**
   * The applicable rate limits, by context.
   *
   * `GET /v1/usage/limits`. Only the configuration in force, with no live counters; they
   * are separate from the monthly quota of `summary()`.
   */
  limits(options?: CallOptions): ApiPromise<UsageLimits> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/usage/limits' });
      return readData<UsageLimits>(response, 'of the limits');
    });
  }

  /**
   * The validations grouped by day and hour.
   *
   * `GET /v1/usage/heatmap`. It covers the last `days` days (90 at most) and carries only
   * the cells with at least one validation.
   */
  heatmap(params: UsageHeatmapParams = {}, options?: CallOptions): ApiPromise<UsageHeatmap> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/usage/heatmap',
        query: { days: params.days },
      });
      return readData<UsageHeatmap>(response, 'of the heat map');
    });
  }

  /**
   * The API usage metrics of the account.
   *
   * `GET /v1/api/usage`. It gathers today's and the month's requests, the quota of the
   * plan, the latest requests and the status of the Banxico service.
   */
  apiUsage(options?: CallOptions): ApiPromise<ApiUsage> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/api/usage' });
      return readData<ApiUsage>(response, 'of the metrics');
    });
  }

  /**
   * Exports the activity log as CSV or XLSX.
   *
   * `GET /v1/api/usage/export`. `from` and `to` bound the range, both inclusive; `limit`
   * only lowers the cap of 100,000 rows.
   */
  export(params: ExportUsageParams = {}, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/api/usage/export',
        params.format ?? 'csv',
        { from: params.from, to: params.to, limit: params.limit },
        'api-activity',
      ),
    );
  }

  /** Like `export()`, but hands the body over as a `ReadableStream`. See `DownloadedStream`. */
  exportStream(
    params: ExportUsageParams = {},
    options?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      exportFile(
        send,
        '/api/usage/export',
        params.format ?? 'csv',
        { from: params.from, to: params.to, limit: params.limit },
        'api-activity',
        undefined,
        true,
      ),
    );
  }
}

// ── Account, dashboard, plans, insights, finance and billing ───────────────

/** Profile and preferences of the authenticated account. */
export class Account {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/users/me`. */
  myProfile(options?: CallOptions): ApiPromise<UserProfile> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/users/me' });
      return readData<UserProfile>(response, 'of the profile');
    });
  }

  profile(options?: CallOptions): ApiPromise<UserProfile> {
    return this.myProfile(options);
  }

  /** `GET /v1/users/me/retry-policy`. */
  getMyRetryPolicy(options?: CallOptions): ApiPromise<UserRetryPolicy> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/users/me/retry-policy' });
      return readData<UserRetryPolicy>(response, 'of the retry policy');
    });
  }

  retryPolicy(options?: CallOptions): ApiPromise<UserRetryPolicy> {
    return this.getMyRetryPolicy(options);
  }

  /** `PUT /v1/users/me/retry-policy`. It carries an `Idempotency-Key`, generated when missing. */
  updateMyRetryPolicy(policy: RetryPolicy, options?: CallOptions): ApiPromise<UserRetryPolicy> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['UpdateUserRetryPolicyRequest'] = { retry_policy: policy };
      const response = await send({
        method: 'PUT',
        path: '/users/me/retry-policy',
        body,
        idempotent: true,
      });
      return readData<UserRetryPolicy>(response, 'of the retry policy');
    });
  }
}

/** Summary of the account dashboard. */
export class Dashboard {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/summary`. */
  getSummary(
    params: DashboardSummaryParams = {},
    options?: CallOptions,
  ): ApiPromise<DashboardSummary> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/summary',
        query: { limit: params.limit },
      });
      return fillDashboardSummary(readData<DashboardSummary>(response, 'of the dashboard summary'));
    });
  }

  summary(
    params: DashboardSummaryParams = {},
    options?: CallOptions,
  ): ApiPromise<DashboardSummary> {
    return this.getSummary(params, options);
  }
}

/** Plan catalog that needs no API key. */
export class Plans {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/plans/public`. */
  listPublic(options?: CallOptions): ApiPromise<PublicPlans> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/plans/public', authenticated: false });
      return readData<PublicPlans>(response, 'of the public plans');
    });
  }

  list(options?: CallOptions): ApiPromise<PublicPlans> {
    return this.listPublic(options);
  }

  /** `GET /v1/plans/public/comparison`. */
  getPublicPlanComparison(options?: CallOptions): ApiPromise<PublicPlanComparison> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/plans/public/comparison',
        authenticated: false,
      });
      return readData<PublicPlanComparison>(response, 'of the plan comparison');
    });
  }

  comparison(options?: CallOptions): ApiPromise<PublicPlanComparison> {
    return this.getPublicPlanComparison(options);
  }
}

/** Aggregated metrics of the authenticated account. */
export class Insights {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/insights/overview`. */
  getOverview(options?: CallOptions): ApiPromise<InsightsOverview> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/insights/overview' });
      return readData<InsightsOverview>(response, 'of insights');
    });
  }

  overview(options?: CallOptions): ApiPromise<InsightsOverview> {
    return this.getOverview(options);
  }

  /** `GET /v1/insights/trends`. */
  getTrends(
    params: UserInsightsTrendsParams = {},
    options?: CallOptions,
  ): ApiPromise<InsightsTrends> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/insights/trends',
        query: { range: params.range, metric: params.metric },
      });
      return readData<InsightsTrends>(response, 'of the trends');
    });
  }

  trends(params: UserInsightsTrendsParams = {}, options?: CallOptions): ApiPromise<InsightsTrends> {
    return this.getTrends(params, options);
  }

  /** `GET /v1/insights/top-banks`. */
  getTopBanks(
    params: UserInsightsTopBanksParams = {},
    options?: CallOptions,
  ): ApiPromise<InsightsTopBanks> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/insights/top-banks',
        query: { metric: params.metric, limit: params.limit },
      });
      return readData<InsightsTopBanks>(response, 'of the top banks');
    });
  }

  topBanks(
    params: UserInsightsTopBanksParams = {},
    options?: CallOptions,
  ): ApiPromise<InsightsTopBanks> {
    return this.getTopBanks(params, options);
  }

  /** `GET /v1/insights/top-beneficiaries`. */
  getTopBeneficiaries(
    params: UserInsightsTopBeneficiariesParams = {},
    options?: CallOptions,
  ): ApiPromise<InsightsTopBeneficiaries> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/insights/top-beneficiaries',
        query: { limit: params.limit },
      });
      return readData<InsightsTopBeneficiaries>(response, 'of the top beneficiaries');
    });
  }

  topBeneficiaries(
    params: UserInsightsTopBeneficiariesParams = {},
    options?: CallOptions,
  ): ApiPromise<InsightsTopBeneficiaries> {
    return this.getTopBeneficiaries(params, options);
  }
}

const FINANCE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
};

function financeFile(
  send: Send,
  path: string,
  query: Query,
  format: string,
  fallback: string,
  includeFormat?: boolean,
  stream?: false,
): Promise<DownloadedFile>;
function financeFile(
  send: Send,
  path: string,
  query: Query,
  format: string,
  fallback: string,
  includeFormat: boolean,
  stream: true,
): Promise<DownloadedStream>;
async function financeFile(
  send: Send,
  path: string,
  query: Query,
  format: string,
  fallback: string,
  includeFormat = true,
  stream = false,
): Promise<DownloadedFile | DownloadedStream> {
  const contentType = FINANCE_CONTENT_TYPES[format] ?? 'application/octet-stream';
  const response = await send({
    method: 'GET',
    path,
    query: includeFormat ? { ...query, format } : query,
    accept: `${contentType}, application/json`,
    stream,
  });
  const name = `${fallback}.${format}`;
  const type = response.headers['content-type'] ?? contentType;
  return stream ? toStream(response, name, type) : toFile(response, name, type);
}

const FINANCE_REPORTS: Record<FinanceReport, { path: string; fallback: string }> = {
  monthly: { path: '/finance/monthly', fallback: 'monthly-finance' },
  counterparties: { path: '/finance/counterparties', fallback: 'counterparties' },
  'by-bank': { path: '/finance/by-bank', fallback: 'finance-by-bank' },
  accounting: { path: '/finance/accounting', fallback: 'accounting' },
};

/** Financial summaries and downloads. */
export class Finance {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/finance/summary`. */
  getSummary(params: FinanceParams, options?: CallOptions): ApiPromise<FinanceSummary> {
    return this.transport.call(options, async (send) => {
      const response = await send({
        method: 'GET',
        path: '/finance/summary',
        query: { month: params.month, user_id: params.userId },
      });
      return fillFinanceSummary(readData<FinanceSummary>(response, 'of the financial summary'));
    });
  }

  summary(params: FinanceParams, options?: CallOptions): ApiPromise<FinanceSummary> {
    return this.getSummary(params, options);
  }

  /**
   * `GET /v1/finance/statement`. The response headers of the file are in `headers`:
   * `x-finance-folio` carries the number of the statement. A PDF keeps at most 1,000 rows.
   */
  getStatement(params: FinanceStatementParams, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        '/finance/statement',
        { month: params.month, user_id: params.userId },
        params.format ?? 'pdf',
        'statement',
      ),
    );
  }

  statement(params: FinanceStatementParams, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.getStatement(params, options);
  }

  /**
   * Like `getStatement()`, but hands the body over as a `ReadableStream`. See
   * `DownloadedStream`; `headers['x-finance-folio']` carries the statement number.
   */
  statementStream(
    params: FinanceStatementParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        '/finance/statement',
        { month: params.month, user_id: params.userId },
        params.format ?? 'pdf',
        'statement',
        true,
        true,
      ),
    );
  }

  /**
   * Like `getMonthly()`, `getCounterparties()`, `getByBank()` and `getAccounting()` in a file
   * format, but hands the body over as a `ReadableStream`. `report` names the report. The
   * `preview` format is not a file: use the buffered method for it.
   */
  reportStream(
    report: FinanceReport,
    params: FinanceReportStreamParams,
    options?: CallOptions,
  ): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) => {
      const route = FINANCE_REPORTS[report] as { path: string; fallback: string } | undefined;
      if (!route) {
        throw new ConfigurationError(
          `The report is 'monthly', 'counterparties', 'by-bank' or 'accounting'; got ${JSON.stringify(report)}`,
        );
      }
      const format = params.format ?? 'csv';
      if ((format as string) === 'preview') {
        throw new ConfigurationError('The preview is not a file: use the buffered method.');
      }
      return financeFile(
        send,
        route.path,
        {
          month: params.month,
          user_id: params.userId,
          limit: params.limit,
          ...(report === 'accounting' ? { decimal: params.decimal } : {}),
        },
        format,
        route.fallback,
        true,
        true,
      );
    });
  }

  private preview(
    path: string,
    params: FinancePreviewParams,
    fallback: string,
    options: CallOptions | undefined,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.transport.call(options, async (send) => {
      const format = params.format ?? 'csv';
      const query = { month: params.month, user_id: params.userId, limit: params.limit };
      if (format !== 'preview') return financeFile(send, path, query, format, fallback);
      const response = await send({ method: 'GET', path, query: { ...query, format } });
      return readData<FinancePreview>(response, `of ${fallback}`);
    });
  }

  /** `GET /v1/finance/monthly`. */
  getMonthly(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/monthly', params, 'monthly-finance', options);
  }

  monthly(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.getMonthly(params, options);
  }

  /** `GET /v1/finance/counterparties`. */
  getCounterparties(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/counterparties', params, 'counterparties', options);
  }

  counterparties(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.getCounterparties(params, options);
  }

  /** `GET /v1/finance/by-bank`. */
  getByBank(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/by-bank', params, 'finance-by-bank', options);
  }

  byBank(
    params: FinancePreviewParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.getByBank(params, options);
  }

  /** `GET /v1/finance/accounting`. */
  getAccounting(
    params: FinanceAccountingParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.transport.call(options, async (send) => {
      const format = params.format ?? 'csv';
      const query = {
        month: params.month,
        user_id: params.userId,
        limit: params.limit,
        decimal: params.decimal,
      };
      if (format !== 'preview')
        return financeFile(send, '/finance/accounting', query, format, 'accounting');
      const response = await send({
        method: 'GET',
        path: '/finance/accounting',
        query: { ...query, format },
      });
      return readData<FinancePreview>(response, 'of accounting');
    });
  }

  accounting(
    params: FinanceAccountingParams,
    options?: CallOptions,
  ): ApiPromise<FinancePreview | DownloadedFile> {
    return this.getAccounting(params, options);
  }

  /**
   * `GET /v1/finance/ceps`. A ZIP of the CEPs of a range; `headers['x-finance-items']`
   * carries the number of files.
   */
  getCeps(params: FinanceCepsParams, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        '/finance/ceps',
        { from: params.from, to: params.to, user_id: params.userId },
        'zip',
        'ceps',
        false,
      ),
    );
  }

  ceps(params: FinanceCepsParams, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.getCeps(params, options);
  }

  /**
   * Like `getCeps()`, but hands the ZIP over as a `ReadableStream`. See `DownloadedStream`;
   * `headers['x-finance-items']` carries the number of files.
   */
  cepsStream(params: FinanceCepsParams, options?: CallOptions): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        '/finance/ceps',
        { from: params.from, to: params.to, user_id: params.userId },
        'zip',
        'ceps',
        false,
        true,
      ),
    );
  }

  /**
   * Requests the ZIP of CEPs of a range to be built in the background.
   *
   * `POST /v1/finance/ceps/exports`. Returns the export in `queued`. If one of the same
   * range is already running, it returns that one. It carries an `Idempotency-Key`,
   * generated when `idempotencyKey` is missing. Follow it with `waitForCepExport()`.
   */
  createCepExport(
    params: FinanceCepExportParams,
    options?: CallOptions,
  ): ApiPromise<FinanceCepExport> {
    return this.transport.call(options, async (send) => {
      const body: Schemas['CreateCepArchiveRequest'] = { from: params.from, to: params.to };
      if (params.userId !== undefined) body.user_id = params.userId;
      const response = await send({
        method: 'POST',
        path: '/finance/ceps/exports',
        body,
        idempotent: true,
        headers: idempotencyHeader(params.idempotencyKey),
      });
      return readData<FinanceCepExport>(response, 'of the CEP export');
    });
  }

  /** The recent CEP exports, most recent first. `GET /v1/finance/ceps/exports`. */
  listCepExports(options?: CallOptions): ApiPromise<FinanceCepExport[]> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/finance/ceps/exports' });
      return readList<FinanceCepExport>(response, 'of the CEP exports');
    });
  }

  /**
   * The state of a CEP export. `GET /v1/finance/ceps/exports/{id}`.
   *
   * `attributes.status` is terminal in `ready`, `failed` or `expired`; with `ready`,
   * `links.download` carries the path of the file.
   */
  getCepExport(exportId: string, options?: CallOptions): ApiPromise<FinanceCepExport> {
    return this.transport.call(options, (send) => this.readCepExport(send, exportId));
  }

  private async readCepExport(send: Send, exportId: string): Promise<FinanceCepExport> {
    const response = await send({
      method: 'GET',
      path: `/finance/ceps/exports/${pathSegment(exportId)}`,
    });
    return readData<FinanceCepExport>(response, 'of the CEP export');
  }

  /**
   * Polls a CEP export until it reaches `ready`, `failed` or `expired`.
   *
   * The pause between polls honors `Retry-After` when the response carries it, and
   * `pollIntervalMs` (2 seconds by default) otherwise. It resolves with the export in its
   * terminal state; check `attributes.status` before downloading.
   *
   * @throws {TimeoutError} If `timeoutMs` (five minutes by default) runs out first.
   */
  waitForCepExport(exportId: string, options: WaitForOptions = {}): ApiPromise<FinanceCepExport> {
    return this.transport.call(pollCall(options), async (send) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const sleep = options.sleep ?? defaultSleep;
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const response = await send({
          method: 'GET',
          path: `/finance/ceps/exports/${pathSegment(exportId)}`,
        });
        const exported = readData<FinanceCepExport>(response, 'of the CEP export');
        if (isCepExportTerminal(exported.attributes?.status)) return exported;
        if (performance.now() >= deadline) {
          throw new TimeoutError(
            `CEP export ${exportId} did not reach a terminal state within ${String(timeoutMs)} ms`,
            exportId,
            timeoutMs,
          );
        }
        await sleep(
          pollPause(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, pollHint(response)),
        );
      }
    });
  }

  /**
   * The ZIP of a CEP export in `ready`. `GET /v1/finance/ceps/exports/{id}/download`.
   * `headers['x-finance-items']` carries the number of files.
   */
  downloadCepExport(exportId: string, options?: CallOptions): ApiPromise<DownloadedFile> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        `/finance/ceps/exports/${pathSegment(exportId)}/download`,
        {},
        'zip',
        'ceps',
        false,
      ),
    );
  }

  /**
   * Like `downloadCepExport()`, but hands the ZIP over as a `ReadableStream`, which is the
   * way to take a large archive to disk without holding it in memory. See `DownloadedStream`.
   */
  downloadCepExportStream(exportId: string, options?: CallOptions): ApiPromise<DownloadedStream> {
    return this.transport.call(options, (send) =>
      financeFile(
        send,
        `/finance/ceps/exports/${pathSegment(exportId)}/download`,
        {},
        'zip',
        'ceps',
        false,
        true,
      ),
    );
  }
}

/** Active subscription of the authenticated account. */
export class Billing {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/billing/subscription`. */
  getSubscription(options?: CallOptions): ApiPromise<BillingSubscription> {
    return this.transport.call(options, async (send) => {
      const response = await send({ method: 'GET', path: '/billing/subscription' });
      return readData<BillingSubscription>(response, 'of the subscription');
    });
  }

  subscription(options?: CallOptions): ApiPromise<BillingSubscription> {
    return this.getSubscription(options);
  }
}
