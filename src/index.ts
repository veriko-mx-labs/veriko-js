/**
 * SDK oficial de Veriko para JavaScript y TypeScript.
 *
 * Veriko valida transferencias SPEI mexicanas contra el CEP (Comprobante
 * Electrónico de Pago) que emite el Banco de México, y devuelve un veredicto.
 *
 * ```ts
 * import { Veriko, hasCep } from '@veriko/sdk';
 *
 * const client = new Veriko(); // lee VERIKO_API_KEY del entorno
 *
 * const validation = await client.validateTransfer({
 *   fecha: '2025-03-15',
 *   monto: 15000.5,
 *   claveRastreo: 'MXBA20250315001234',
 *   cuentaBeneficiaria: '012180004412345678',
 * });
 *
 * if (hasCep(validation)) {
 *   const cep = await client.getCep(validation.id, { format: 'pdf' });
 *   await writeFile(cep.filename, cep.content);
 * }
 * ```
 *
 * Documentación de la API: https://docs.veriko.mx
 */

export {
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  VERSION,
  Veriko,
  type VerikoOptions,
} from './client.js';

export {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  ConnectionError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
  TimeoutError,
  VerikoError,
  type ApiErrorEntry,
} from './errors.js';

export { Catalog, Validations, Webhooks } from './resources.js';

export { type IterOptions, type Page } from './pagination.js';

export {
  DEFAULT_RETRY,
  RETRYABLE_STATUSES,
  Transport,
  parseRetryAfter,
  type RetryConfig,
} from './http.js';

export {
  CEP_FORMATS,
  EXPORT_FORMATS,
  RETRYABLE_OUTCOMES,
  TERMINAL_STATUSES,
  WEBHOOK_EVENTS,
  hasCep,
  isSettled,
  isTerminal,
  type Bank,
  type BankList,
  type BanksOptions,
  type BanxicoMetric,
  type BanxicoStatus,
  type BanxicoTimeseries,
  type BanxicoWindow,
  type BinLookup,
  type CepDocument,
  type CepFormat,
  type CreateWebhookParams,
  type DeliveriesParams,
  type DeliveryEventType,
  type DeliveryStatus,
  type DownloadedFile,
  type ErrorObject,
  type ExportDeliveriesParams,
  type ExportFormat,
  type ExportValidationsParams,
  type GetValidationOptions,
  type IdempotentOptions,
  type ListValidationsParams,
  type OcrValidationRequest,
  type QueuedValidation,
  type RetryAttempt,
  type RetryPolicy,
  type RetryState,
  type RetryStateFilter,
  type RetryStateResource,
  type TelegramDispatch,
  type TimeseriesParams,
  type UpdateWebhookParams,
  type ValidateOcrParams,
  type ValidateTransferParams,
  type Validation,
  type ValidationAttributes,
  type ValidationFilters,
  type ValidationQueuedResource,
  type ValidationRequest,
  type ValidationStats,
  type ValidationStatus,
  type ValidationSummary,
  type ValidationType,
  type ValidationWithEtag,
  type WaitForOptions,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
  type WebhookEventName,
  type WebhookStatus,
  type WebhookSubscriptionEvent,
  type WebhookTestResult,
} from './types.js';

export {
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  computeSignature,
  parseWebhook,
  signatureFromHeaders,
  verifyWebhook,
} from './webhooks.js';

export type { components, operations, paths } from './generated/openapi.js';
