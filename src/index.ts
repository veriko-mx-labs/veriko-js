/**
 * SDK oficial de Veriko para JavaScript y TypeScript.
 *
 * Veriko valida transferencias SPEI mexicanas contra el CEP (Comprobante
 * Electrónico de Pago) que emite el Banco de México, y devuelve un veredicto.
 *
 * ```ts
 * import { Veriko, hasCep } from '@veriko-mx/sdk';
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

export {
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
  IMPORT_TEMPLATE_FORMATS,
  IMPORT_TERMINAL_STATUSES,
  RETRYABLE_OUTCOMES,
  TERMINAL_STATUSES,
  WEBHOOK_EVENTS,
  hasCep,
  isImportSettled,
  isImportTerminal,
  isSettled,
  isTerminal,
  type ApiUsage,
  type BillingSubscription,
  type Bank,
  type BankList,
  type BanksOptions,
  type BanxicoMetric,
  type BanxicoStatus,
  type BanxicoTimeseries,
  type BanxicoWindow,
  type Beneficiary,
  type BeneficiaryAccountType,
  type BeneficiaryImportCommitted,
  type BeneficiaryImportJob,
  type BeneficiaryImportRow,
  type BeneficiaryImportStarted,
  type BeneficiaryLookup,
  type BinLookup,
  type CepDocument,
  type CepFormat,
  type CreateBeneficiaryParams,
  type CreateWebhookParams,
  type DeliveriesParams,
  type DeliveryEventType,
  type DeliveryStatus,
  type DashboardSummary,
  type DashboardSummaryParams,
  type DownloadedFile,
  type EditImportRowParams,
  type ErrorObject,
  type ExportBeneficiariesParams,
  type ExportDeliveriesParams,
  type ExportFormat,
  type ExportUsageParams,
  type ExportValidationsParams,
  type FinanceAccountingParams,
  type FinanceCepsParams,
  type FinanceDecimal,
  type FinanceParams,
  type FinancePreview,
  type FinancePreviewFormat,
  type FinancePreviewParams,
  type FinanceStatementFormat,
  type FinanceStatementParams,
  type FinanceSummary,
  type GetValidationOptions,
  type IdempotentOptions,
  type ImportParseMode,
  type ImportPreviewParams,
  type ImportRowBucket,
  type ImportStartOptions,
  type ImportTemplateFormat,
  type ImportTemplateOptions,
  type InsightsOverview,
  type InsightsTopBanks,
  type UserInsightsTopBanksParams,
  type InsightsTopBeneficiaries,
  type UserInsightsTopBeneficiariesParams,
  type InsightsTrends,
  type ListBeneficiariesParams,
  type ListValidationsParams,
  type OcrValidationRequest,
  type QueuedValidation,
  type RetryAttempt,
  type RetryPolicy,
  type RetryState,
  type RetryStateFilter,
  type RetryStateResource,
  type PublicPlanComparison,
  type PublicPlans,
  type TelegramDispatch,
  type TimeseriesParams,
  type UpdateBeneficiaryParams,
  type UpdateWebhookParams,
  type UserInsightsTrendsParams,
  type UserProfile,
  type UserRetryPolicy,
  type UsageBreakdown,
  type UsageBreakdownParams,
  type UsageHeatmap,
  type UsageHeatmapParams,
  type UsageHistory,
  type UsageHistoryParams,
  type UsageLimits,
  type UsageSummary,
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
