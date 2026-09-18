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
  VerikoError,
  type ApiErrorEntry,
} from './errors.js';

export {
  DEFAULT_RETRY,
  RETRYABLE_STATUSES,
  Transport,
  parseRetryAfter,
  type RetryConfig,
} from './http.js';

export {
  CEP_FORMATS,
  RETRYABLE_OUTCOMES,
  TERMINAL_STATUSES,
  WEBHOOK_EVENTS,
  hasCep,
  isTerminal,
  type CepDocument,
  type CepFormat,
  type ErrorObject,
  type RetryPolicy,
  type RetryState,
  type ValidateTransferParams,
  type Validation,
  type ValidationAttributes,
  type ValidationRequest,
  type ValidationStatus,
  type WebhookEvent,
  type WebhookEventName,
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

export type { components, paths } from './generated/openapi.js';
