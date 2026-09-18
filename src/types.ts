/**
 * Tipos del dominio.
 *
 * Los que describen lo que viaja por el cable salen del spec de OpenAPI, no se
 * escriben a mano: `src/generated/openapi.ts` lo genera `openapi-typescript`
 * desde `spec/openapi.yaml`, que es copia de la versión pública publicada en
 * https://docs.veriko.mx/openapi.yaml.
 *
 * Este archivo pone nombres cortos sobre esos tipos y añade los que el SDK
 * necesita y el spec no describe, como la forma de una entrega de webhook.
 */

import type { components, operations } from './generated/openapi.js';

type Schemas = components['schemas'];

/** El cuerpo JSON de una respuesta, por operación y estado. */
type JsonBody<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** El recurso `data` de un cuerpo con la forma `{ data?: ... }`. */
type DataOf<B> = B extends { data?: infer D } ? NonNullable<D> : never;

/** El `data` de la respuesta de una operación, tal como lo tipa el spec. */
type ResourceOf<
  Op extends keyof operations,
  Code extends keyof operations[Op]['responses'],
> = DataOf<JsonBody<operations[Op]['responses'][Code]>>;

/** Recurso JSON:API de una validación SPEI, tal como lo devuelve la API. */
export type Validation = Schemas['Validation'];

/** Política de reintentos automáticos de una validación. */
export type RetryPolicy = Schemas['RetryPolicy'];

/**
 * Cuerpo de `POST /v1/validate`.
 *
 * Éste no sale del generador. El schema del spec lleva un `anyOf` que sólo
 * expresa «hace falta `clave_rastreo` o `referencia_numerica`», y
 * `openapi-typescript` lo traduce a `{...} | unknown`, que TypeScript colapsa a
 * `unknown`. El tipo se escribe aquí con los mismos campos, y
 * `test/spec.test.ts` falla si el spec añade, quita o renombra alguno.
 */
export interface ValidationRequest {
  /** Fecha de la transferencia en formato ISO 8601 (`YYYY-MM-DD`). */
  fecha: string;
  /** Importe en pesos, mayor que cero y con hasta dos decimales. */
  monto: number;
  /** Clave de rastreo, de 1 a 30 caracteres. */
  clave_rastreo?: string;
  /** Referencia numérica, de 1 a 7 dígitos. */
  referencia_numerica?: string;
  /** Nombre o código SPEI del banco emisor. */
  emisor?: string;
  /** Nombre o código SPEI del banco receptor. */
  receptor?: string;
  /** CLABE (18 dígitos), tarjeta (16) o celular DiMo (10) del beneficiario. */
  cuenta_beneficiaria?: string;
  /** `1` cuando el beneficiario es la propia institución receptora. */
  receptor_participante?: 0 | 1;
  /** Política de reintentos automáticos de la API. */
  retry_policy?: RetryPolicy;
}

/**
 * Los campos de `ValidationRequest`, para el candado que los compara con el
 * spec. El orden es el del spec.
 */
export const VALIDATION_REQUEST_FIELDS = [
  'fecha',
  'monto',
  'clave_rastreo',
  'referencia_numerica',
  'emisor',
  'receptor',
  'cuenta_beneficiaria',
  'receptor_participante',
  'retry_policy',
] as const;

/**
 * Cuerpo de `POST /v1/validate-ocr`.
 *
 * Tampoco sale del generador, por la misma razón que `ValidationRequest`: el
 * `anyOf` que exige `image` o `image_url` se traduce a `unknown`. Los campos son
 * los del spec, y `test/spec.test.ts` falla si cambian.
 */
export interface OcrValidationRequest {
  /** La imagen del comprobante en base64. JPEG, PNG o WebP, de hasta 12 MB. */
  image?: string;
  /** URL pública (HTTPS) de la imagen. Si también viaja `image`, sólo se considera ésta. */
  image_url?: string;
  /** CLABE (18 dígitos), tarjeta (16) o celular DiMo (10). Obligatoria para DiMo. */
  cuenta_beneficiaria?: string;
  /** Política de reintentos automáticos de la API. */
  retry_policy?: RetryPolicy;
}

/** Los campos de `OcrValidationRequest`, para el candado que los compara con el spec. */
export const OCR_VALIDATION_REQUEST_FIELDS = [
  'image',
  'image_url',
  'cuenta_beneficiaria',
  'retry_policy',
] as const;

/** Estado resumido del ciclo de reintentos, tal como viaja en la respuesta. */
export type RetryState = Schemas['RetryStateCompact'];

/** Una entrada del arreglo `errors`. */
export type ErrorObject = Schemas['ErrorObject'];

/** Los atributos de una validación. */
export type ValidationAttributes = Validation['attributes'];

/** Estado del ciclo de vida de una validación. */
export type ValidationStatus = NonNullable<ValidationAttributes['status']>;

/** Veredictos que admiten reintento automático. */
export const RETRYABLE_OUTCOMES = ['not_found', 'cep_unavailable', 'error'] as const;

/** Estados en los que una validación ya no cambia por sí sola. */
export const TERMINAL_STATUSES = [
  'valid',
  'not_found',
  'cep_unavailable',
  'invalid',
  'returned',
  'failed',
  'error',
] as const;

/** `true` cuando el estado ya no va a cambiar sin una acción externa. */
export function isTerminal(status: string | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]);
}

/**
 * `true` cuando el veredicto ya no va a cambiar, ni por reintentos.
 *
 * `isTerminal()` mira sólo el estado. Un `not_found` es terminal para la consulta
 * que lo produjo, pero si la validación tiene un ciclo de reintentos en marcha la
 * API va a volver a preguntar a Banxico, y el veredicto puede cambiar. Ésta es la
 * condición que espera `waitFor()`.
 */
export function isSettled(validation: Validation): boolean {
  if (!isTerminal(validation.attributes.status)) return false;
  const state = validation.attributes.retry_state;
  const cycleAlive =
    state?.enabled === true &&
    (state.terminal_state === undefined ||
      state.terminal_state === null ||
      state.terminal_state === 'pending');
  return !cycleAlive;
}

/**
 * `true` cuando hay comprobante que descargar.
 *
 * Se deriva de `links.cep_xml`, que es lo que publica el servidor. Un
 * `returned` nacido de `cep_unavailable` no lo trae.
 */
export function hasCep(validation: Validation): boolean {
  return Boolean(validation.links?.cep_xml);
}

/** Una validación leída con `get()`, con el `ETag` de la respuesta. */
export type ValidationWithEtag = Validation & {
  /** Se manda como `ifNoneMatch` en la lectura siguiente. */
  etag?: string;
};

/** Formatos en los que la API entrega el comprobante. */
export const CEP_FORMATS = ['xml', 'pdf'] as const;
export type CepFormat = (typeof CEP_FORMATS)[number];

/** Formatos de las exportaciones. */
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Un archivo que devuelve la API: el CEP, una imagen o una exportación. */
export interface DownloadedFile {
  /** El contenido del archivo. */
  content: Uint8Array;
  contentType: string;
  /** El nombre que propone `Content-Disposition`. */
  filename: string;
}

/** El CEP de Banxico descargado: el archivo, no un enlace. */
export interface CepDocument extends DownloadedFile {
  validationId: string;
  format: CepFormat;
}

/** Tipos de evento que emiten los webhooks salientes. */
export const WEBHOOK_EVENTS = [
  'validation.completed',
  'validation.failed',
  'validation.error',
  'validation.retry.scheduled',
  'validation.retry.resolved',
  'validation.retry.exhausted',
  'validation_import.completed',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * El cuerpo de una entrega de webhook.
 *
 * `event` se tipa como la unión conocida más `string`, de modo que un evento
 * nuevo de la API no rompa la compilación de una integración existente.
 */
export interface WebhookEvent {
  event: WebhookEventName | (string & {});
  timestamp?: string;
  data?: Validation;
  meta?: Record<string, unknown>;
}

/** Los argumentos de `validateTransfer()`. */
export interface ValidateTransferParams {
  /** Fecha de envío de la transferencia, `YYYY-MM-DD`. */
  fecha: string;
  /** Importe en pesos, mayor que cero y con hasta dos decimales. */
  monto: number | string;
  /** Clave de rastreo, de 1 a 30 caracteres. */
  claveRastreo?: string;
  /** Referencia numérica, de 1 a 7 dígitos. */
  referenciaNumerica?: string;
  /** CLABE, tarjeta o celular DiMo del beneficiario. */
  cuentaBeneficiaria?: string;
  /** Nombre o código SPEI del banco emisor. */
  emisor?: string;
  /** Nombre o código SPEI del banco receptor. */
  receptor?: string;
  /**
   * `1` cuando el beneficiario de la transferencia es la propia institución
   * receptora («Pago a Banco» en el CEP). Por omisión, `0`.
   */
  receptorParticipante?: 0 | 1;
  /** Política de reintentos automáticos de la API. */
  retryPolicy?: RetryPolicy;
  /**
   * Identificador del intento de negocio: el número de pedido, de lote o de
   * transacción. Con él, repetir la petición no duplica la validación durante
   * 24 horas.
   */
  idempotencyKey?: string;
}

// ── Familias `validations`, `webhooks` y `catalog` ──────────────────────────

/**
 * Una validación en un listado.
 *
 * Es más estrecha que `Validation`: un listado no trae ni los datos enviados ni
 * el resultado de Banxico, ni los enlaces al comprobante. `get()` devuelve la
 * completa.
 */
export type ValidationSummary = Schemas['PublicValidationListItem'];

/** Los totales de las validaciones de la cuenta. */
export type ValidationStats = ResourceOf<'validationStats', 200>;

/** Un intento del ciclo de reintentos automáticos de una validación. */
export type RetryAttempt = Schemas['RetryAttempt'];

/** Lo que devuelven el cambio de política y la cancelación: el estado del ciclo. */
export type RetryStateResource = ResourceOf<'updateValidationRetryPolicy', 200>;

/** El acuse del envío del comprobante a Telegram. */
export type TelegramDispatch = ResourceOf<'sendCepToTelegram', 202>;

/** El recurso de la respuesta `202` de una validación en cola. */
export type ValidationQueuedResource = NonNullable<Schemas['ValidationQueued']['data']>;

/**
 * El acuse de una validación en cola.
 *
 * El veredicto se recoge con `waitFor()`, o llega por webhook.
 *
 * @see https://docs.veriko.mx/es/concepts/async-validations
 */
export interface QueuedValidation {
  /** El identificador de la validación. */
  id: string;
  status: string;
  /** `ETag` de la respuesta, para el primer sondeo condicional. */
  etag: string | undefined;
  /** `Location` de la respuesta: la ruta de la validación. */
  location: string | undefined;
  /** Segundos que la API pide esperar antes del primer sondeo. */
  nextPollAfterSeconds: number | undefined;
  /** El recurso tal como lo devolvió la API, con `enqueued_at` y `expires_at`. */
  data: ValidationQueuedResource;
}

/** Un endpoint de webhook. `attributes.secret` sólo viene al registrarlo y al rotarlo. */
export type WebhookEndpoint = Schemas['WebhookEndpoint'];

/** Un intento de entrega de un webhook, con lo que respondió el receptor. */
export type WebhookDelivery = Schemas['WebhookDelivery'];

/** El resultado del evento de prueba de un endpoint. */
export type WebhookTestResult = ResourceOf<'sendWebhookTest', 200>;

/** Un evento al que se suscribe un endpoint. */
export type WebhookSubscriptionEvent = Schemas['CreateWebhookRequest']['events'][number];

/** Estado que se puede asignar a un endpoint. `auto_disabled` lo pone el sistema. */
export type WebhookStatus = NonNullable<Schemas['UpdateWebhookRequest']['status']>;

/** Una institución del catálogo SPEI. */
export type Bank = Schemas['BankResource'];

/** El catálogo de bancos, con el `ETag` de la respuesta cuando la API lo manda. */
export type BankList = Bank[] & { etag?: string };

/** El banco emisor de una tarjeta, resuelto por su BIN. */
export type BinLookup = Schemas['BinResource'];

/** Estado actual del servicio de consulta de Banxico. */
export type BanxicoStatus = Schemas['BanxicoPublicStatusResource'];

/** Serie temporal de la salud del servicio de Banxico. */
export type BanxicoTimeseries = Schemas['BanxicoPublicTimeseriesResource'];

type ListValidationsQuery = NonNullable<operations['listValidations']['parameters']['query']>;
type TimeseriesQuery = NonNullable<operations['banxicoPublicTimeseries']['parameters']['query']>;
type DeliveriesQuery = NonNullable<operations['listAllDeliveries']['parameters']['query']>;

/** Modalidad de una validación. */
export type ValidationType = NonNullable<ListValidationsQuery['type']>;

/** Estado del ciclo de reintentos, para filtrar. */
export type RetryStateFilter = NonNullable<ListValidationsQuery['retry_state']>;

/** Métrica de la serie temporal de Banxico. */
export type BanxicoMetric = NonNullable<TimeseriesQuery['metric']>;

/** Ventana de la serie temporal de Banxico. */
export type BanxicoWindow = NonNullable<TimeseriesQuery['window']>;

/** Estado de una entrega, para filtrar. */
export type DeliveryStatus = NonNullable<DeliveriesQuery['status']>;

/** Tipo de evento de una entrega, para filtrar. */
export type DeliveryEventType = NonNullable<DeliveriesQuery['event_type']>;

/** Los argumentos de `validations.validateOcr()` y `validations.enqueueOcr()`. */
export interface ValidateOcrParams {
  /**
   * La imagen del comprobante: sus bytes (`Buffer` o `Uint8Array`) o la ruta de
   * un archivo. El SDK la codifica en base64. JPEG, PNG o WebP, de hasta 12 MB.
   */
  image?: Uint8Array | string;
  /** URL pública (HTTPS) de una imagen ya publicada. Si se envía también `image`, sólo cuenta ésta. */
  imageUrl?: string;
  /** CLABE, tarjeta o celular DiMo. Obligatoria para DiMo. */
  cuentaBeneficiaria?: string;
  /** Política de reintentos automáticos de la API. */
  retryPolicy?: RetryPolicy;
  /** Identificador del intento de negocio. Con él, repetir la petición no duplica la validación. */
  idempotencyKey?: string;
}

/** Las opciones de `validations.get()`. */
export interface GetValidationOptions {
  /**
   * El `ETag` de una lectura anterior. Cuando nada cambió, la API responde `304`
   * y el SDK lo lanza como `ApiError` con `status` 304.
   */
  ifNoneMatch?: string;
}

/** Las opciones de `validations.waitFor()`. */
export interface WaitForOptions {
  /** Cuánto esperar el veredicto, en milisegundos. Por omisión, cinco minutos. */
  timeoutMs?: number;
  /** Pausa entre sondeos, en milisegundos. Por omisión, cinco segundos. */
  pollIntervalMs?: number;
  /** Sustituible en las pruebas para no dormir de verdad. */
  sleep?: (ms: number) => Promise<void>;
}

/** Los filtros que comparten el listado, las estadísticas y la exportación. */
export interface ValidationFilters {
  /** Un estado, o varios: `valid`, `not_found`, `cep_unavailable`, `returned`... */
  status?: string | readonly string[];
  /** `direct` para captura manual, `ocr` para validación por imagen. */
  type?: ValidationType;
  /** Fecha inicial inclusiva, `YYYY-MM-DD`, sobre la creación de la validación. */
  from?: string;
  /** Fecha final inclusiva, `YYYY-MM-DD`. */
  to?: string;
  /** Texto buscado en los datos enviados y en los que devolvió Banxico. */
  search?: string;
  /** Sólo las validaciones del banco de pruebas (Playground). */
  playground?: true;
  /** `true` sólo las retiradas, `false` sólo las activas; sin él, ambas. */
  withDeleted?: boolean;
  /** Identificador del trabajo de importación que generó las validaciones. */
  batchId?: number;
  /** Clave SPEI del banco emisor o receptor. */
  bank?: string;
  amountMin?: number;
  amountMax?: number;
  retryState?: RetryStateFilter;
}

/** Los argumentos de `validations.list()`. */
export interface ListValidationsParams extends ValidationFilters {
  page?: number;
  /** De 1 a 50. */
  perPage?: number;
}

/** Los argumentos de `validations.export()`. */
export interface ExportValidationsParams extends ValidationFilters {
  /** `csv` por omisión. */
  format?: ExportFormat;
  /** Tope de filas, de 1 a 100 000. */
  limit?: number;
}

/** Las opciones de `setRetryPolicy()` y `cancelRetries()`. */
export interface IdempotentOptions {
  /** Con ella, repetir la misma petición no la duplica. */
  idempotencyKey?: string;
}

/** Los argumentos de `webhooks.create()`. */
export interface CreateWebhookParams {
  /** HTTPS, de hasta 2048 caracteres y sin resolver a una dirección privada. */
  url: string;
  /** De 1 a 10 eventos. */
  events: readonly WebhookSubscriptionEvent[];
  /** Etiqueta libre para distinguir el endpoint. */
  description?: string;
}

/** Los argumentos de `webhooks.update()`. Hace falta al menos uno. */
export interface UpdateWebhookParams {
  url?: string;
  events?: readonly WebhookSubscriptionEvent[];
  /** `null` borra la etiqueta. */
  description?: string | null;
  /** `active` reactiva un endpoint que el sistema apagó; `disabled` lo pausa. */
  status?: WebhookStatus;
}

/** Los argumentos de `webhooks.deliveries()`. */
export interface DeliveriesParams {
  page?: number;
  /** De 1 a 100. */
  perPage?: number;
  status?: DeliveryStatus;
  eventType?: DeliveryEventType;
}

/** Los argumentos de `webhooks.exportDeliveries()`. */
export interface ExportDeliveriesParams {
  /** `csv` por omisión. */
  format?: ExportFormat;
  /** Tope de filas, de 1 a 100 000. */
  limit?: number;
  status?: DeliveryStatus;
  eventType?: DeliveryEventType;
}

/** Los argumentos de `catalog.banxicoTimeseries()`. */
export interface TimeseriesParams {
  /** `probe_latency` por omisión. */
  metric?: BanxicoMetric;
  /** `24h` por omisión. */
  window?: BanxicoWindow;
}

/** Las opciones de `catalog.banks()`. */
export interface BanksOptions {
  /** El `ETag` de una lectura anterior; con él, un catálogo sin cambios responde `304`. */
  ifNoneMatch?: string;
}
