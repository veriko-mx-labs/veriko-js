/**
 * Las operaciones de la API, agrupadas por familia.
 *
 * Cada familia es una propiedad del cliente: `client.validations`,
 * `client.webhooks`, `client.catalog` y las demás. Los tres métodos de uso más
 * frecuente siguen en la raíz del cliente, porque son el camino corto del caso de
 * uso principal.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ApiError, ConfigurationError, InvalidRequestError, TimeoutError } from './errors.js';
import type { components } from './generated/openapi.js';
import {
  defaultSleep,
  filenameFromContentDisposition,
  type RawResponse,
  type Transport,
} from './http.js';
import {
  checkedId,
  joinList,
  newIdempotencyKey,
  pathSegment,
  readData,
  readDocument,
  readList,
  readMeta,
  type EntityId,
  type Query,
} from './internal.js';
import { iteratePages, parsePage, type IterOptions, type Page } from './pagination.js';
import {
  CEP_FORMATS,
  EXPORT_FORMATS,
  IMPORT_TEMPLATE_FORMATS,
  isImportSettled,
  isSettled,
  type ApiUsage,
  type Beneficiary,
  type BeneficiaryImportCommitted,
  type BeneficiaryImportJob,
  type BeneficiaryImportRow,
  type BeneficiaryImportStarted,
  type BeneficiaryLookup,
  type CreateBeneficiaryParams,
  type EditImportRowParams,
  type ExportBeneficiariesParams,
  type ExportUsageParams,
  type ImportPreviewParams,
  type ImportStartOptions,
  type ImportTemplateFormat,
  type ImportTemplateOptions,
  type ListBeneficiariesParams,
  type UpdateBeneficiaryParams,
  type UsageBreakdown,
  type UsageBreakdownParams,
  type UsageHeatmap,
  type UsageHeatmapParams,
  type UsageHistory,
  type UsageHistoryParams,
  type UsageLimits,
  type UsageSummary,
  type BillingSubscription,
  type DashboardSummary,
  type DashboardSummaryParams,
  type FinanceAccountingParams,
  type FinanceCepsParams,
  type FinanceParams,
  type FinancePreview,
  type FinancePreviewParams,
  type FinanceStatementParams,
  type FinanceSummary,
  type InsightsOverview,
  type InsightsTopBanks,
  type UserInsightsTopBanksParams,
  type InsightsTopBeneficiaries,
  type UserInsightsTopBeneficiariesParams,
  type InsightsTrends,
  type UserInsightsTrendsParams,
  type PublicPlanComparison,
  type PublicPlans,
  type UserProfile,
  type UserRetryPolicy,
  type Bank,
  type BankList,
  type BanksOptions,
  type BanxicoStatus,
  type BanxicoTimeseries,
  type BinLookup,
  type CepDocument,
  type CepFormat,
  type CreateWebhookParams,
  type DeliveriesParams,
  type DownloadedFile,
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
  type RetryStateResource,
  type TelegramDispatch,
  type TimeseriesParams,
  type UpdateWebhookParams,
  type ValidateOcrParams,
  type ValidateTransferParams,
  type Validation,
  type ValidationFilters,
  type ValidationQueuedResource,
  type ValidationRequest,
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
const DEFAULT_POLL_INTERVAL_MS = 5_000;

const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const IMAGE_ACCEPT =
  'image/png, image/jpeg, image/webp, application/octet-stream, application/json';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

// ── Ayudantes ───────────────────────────────────────────────────────────────

function flag(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? '1' : '0';
}

/**
 * Los filtros de una consulta, con el nombre que la API espera.
 *
 * `test/spec.test.ts` compara las claves de este resultado con los parámetros de
 * `GET /v1/validations`, de modo que un filtro nuevo del spec no pase inadvertido.
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
    amount_min: filters.amountMin,
    amount_max: filters.amountMax,
    retry_state: filters.retryState,
  };
}

function idempotencyHeader(key: string | undefined): Record<string, string | undefined> {
  return { 'idempotency-key': key };
}

/** El cuerpo de una validación por campos, con su comprobación previa. */
function directBody(params: ValidateTransferParams): ValidationRequest {
  if (!params.claveRastreo && !params.referenciaNumerica) {
    throw new InvalidRequestError(
      'Hace falta claveRastreo o referenciaNumerica para buscar la transferencia en el CEP',
      { status: 422, code: 'clave_or_ref_required' },
    );
  }

  const body: ValidationRequest = {
    fecha: params.fecha,
    monto: typeof params.monto === 'string' ? Number(params.monto) : params.monto,
  };
  if (params.claveRastreo !== undefined) body.clave_rastreo = params.claveRastreo;
  if (params.referenciaNumerica !== undefined) {
    body.referencia_numerica = params.referenciaNumerica;
  }
  if (params.cuentaBeneficiaria !== undefined) {
    body.cuenta_beneficiaria = params.cuentaBeneficiaria;
  }
  if (params.emisor !== undefined) body.emisor = params.emisor;
  if (params.receptor !== undefined) body.receptor = params.receptor;
  if (params.receptorParticipante !== undefined) {
    body.receptor_participante = params.receptorParticipante;
  }
  if (params.retryPolicy !== undefined) body.retry_policy = params.retryPolicy;
  return body;
}

/** Devuelve la imagen en base64, leyéndola del disco cuando es una ruta. */
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
        ? `No existe el archivo de imagen: ${image}`
        : `No se pudo leer el archivo de imagen ${image}: ${String(cause)}`,
    );
  }
  return content.toString('base64');
}

/** El cuerpo de una validación por imagen, con su comprobación previa. */
async function ocrBody(params: ValidateOcrParams): Promise<OcrValidationRequest> {
  if (params.image === undefined && !params.imageUrl) {
    throw new InvalidRequestError(
      'Hace falta la imagen del comprobante: pasa `image` o `imageUrl`',
      { status: 422, code: 'image_required' },
    );
  }

  const body: OcrValidationRequest = {};
  if (params.image !== undefined) body.image = await encodeImage(params.image);
  if (params.imageUrl) body.image_url = params.imageUrl;
  if (params.cuentaBeneficiaria) body.cuenta_beneficiaria = params.cuentaBeneficiaria;
  if (params.retryPolicy !== undefined) body.retry_policy = params.retryPolicy;
  return body;
}

function readQueued(response: RawResponse): QueuedValidation {
  const document = readDocument(response);
  const data = document['data'] as ValidationQueuedResource | undefined;
  if (!data?.id) {
    throw new ApiError('La respuesta 202 no trae el identificador de la validación', {
      status: response.status,
      headers: response.headers,
    });
  }
  const poll = readMeta(document)['next_poll_after_seconds'];
  return {
    id: data.id,
    status: data.attributes?.status ?? 'queued',
    etag: response.headers['etag'],
    location: response.headers['location'],
    nextPollAfterSeconds: typeof poll === 'number' ? poll : undefined,
    data,
  };
}

function toFile(response: RawResponse, filename: string, contentType: string): DownloadedFile {
  return {
    content: response.body,
    contentType,
    filename: filenameFromContentDisposition(response.headers['content-disposition'], filename),
  };
}

function notModified(what: string, response: RawResponse): ApiError {
  return new ApiError(`${what} no cambió desde el ETag indicado`, {
    status: 304,
    headers: response.headers,
  });
}

/** Descarga una exportación en CSV o en XLSX. */
async function exportFile(
  transport: Transport,
  path: string,
  format: ExportFormat,
  query: Query,
  fallbackName: string,
  extraAccept?: string,
): Promise<DownloadedFile> {
  if (!EXPORT_FORMATS.includes(format)) {
    throw new ConfigurationError(
      `El formato de exportación es 'csv' o 'xlsx'; llegó ${JSON.stringify(format)}`,
    );
  }
  const accept = EXPORT_CONTENT_TYPES[format];
  const response = await transport.request({
    method: 'GET',
    path,
    query: { ...query, format },
    accept: [accept, extraAccept, 'application/json'].filter(Boolean).join(', '),
  });
  return toFile(response, `${fallbackName}.${format}`, response.headers['content-type'] ?? accept);
}

// ── Validaciones ────────────────────────────────────────────────────────────

/** Validaciones SPEI: crearlas, seguirlas y descargar lo que producen. */
export class Validations {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // Crear

  /**
   * Valida una transferencia SPEI contra el CEP de Banxico.
   *
   * `POST /v1/validate`. Devuelve el veredicto en `attributes.status`. Para
   * volumen está `enqueue()`, que acepta la petición y deja el veredicto para
   * después.
   */
  async validate(params: ValidateTransferParams): Promise<Validation> {
    const response = await this.post('/validate', directBody(params), params.idempotencyKey, false);
    return readData<Validation>(response, 'de la validación');
  }

  /**
   * Valida una transferencia a partir de la imagen del comprobante.
   *
   * `POST /v1/validate-ocr`. La imagen se lee del disco cuando `image` es una
   * ruta, y se codifica en base64 aquí. Formatos: JPEG, PNG o WebP.
   *
   * `imageUrl` sirve para una imagen ya publicada en HTTPS. Si se envían las
   * dos, la API sólo considera `image`.
   */
  async validateOcr(params: ValidateOcrParams): Promise<Validation> {
    const response = await this.post(
      '/validate-ocr',
      await ocrBody(params),
      params.idempotencyKey,
      false,
    );
    return readData<Validation>(response, 'de la validación');
  }

  /**
   * Encola una validación por campos y devuelve el acuse.
   *
   * `POST /v1/validate?async=1`. Acepta los mismos argumentos que `validate()`.
   * La API responde `202` con el identificador; el veredicto se recoge con
   * `waitFor()`, o llega por webhook.
   *
   * @see https://docs.veriko.mx/es/concepts/async-validations
   */
  async enqueue(params: ValidateTransferParams): Promise<QueuedValidation> {
    const response = await this.post('/validate', directBody(params), params.idempotencyKey, true);
    return readQueued(response);
  }

  /**
   * Encola una validación por imagen y devuelve el acuse.
   *
   * `POST /v1/validate-ocr?async=1`. Acepta los mismos argumentos que
   * `validateOcr()`.
   */
  async enqueueOcr(params: ValidateOcrParams): Promise<QueuedValidation> {
    const response = await this.post(
      '/validate-ocr',
      await ocrBody(params),
      params.idempotencyKey,
      true,
    );
    return readQueued(response);
  }

  private post(
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    async: boolean,
  ): Promise<RawResponse> {
    return this.transport.request({
      method: 'POST',
      path,
      body,
      query: async ? { async: 1 } : undefined,
      headers: idempotencyHeader(idempotencyKey ?? newIdempotencyKey()),
    });
  }

  // Consultar

  /**
   * Lee una validación por su identificador.
   *
   * `GET /v1/validations/{id}`. Con `ifNoneMatch` la API responde `304` cuando
   * nada cambió desde ese `ETag`, y el SDK lo lanza como `ApiError` con
   * `status` 304. El `ETag` de cada lectura queda en `etag`.
   */
  async get(validationId: string, options: GetValidationOptions = {}): Promise<ValidationWithEtag> {
    const result = await this.read(validationId, options.ifNoneMatch);
    if (result.notModified) throw notModified('La validación', result.response);
    return result.validation;
  }

  private async read(
    validationId: string,
    ifNoneMatch: string | undefined,
  ): Promise<
    | { notModified: true; response: RawResponse }
    | { notModified: false; validation: ValidationWithEtag }
  > {
    const response = await this.transport.request({
      method: 'GET',
      path: `/validations/${pathSegment(validationId)}`,
      headers: { 'if-none-match': ifNoneMatch },
    });
    if (response.status === 304) return { notModified: true, response };

    const validation: ValidationWithEtag = readData<Validation>(response, 'de la validación');
    const etag = response.headers['etag'];
    if (etag) validation.etag = etag;
    return { notModified: false, validation };
  }

  /**
   * Lista las validaciones de la cuenta, con filtros y paginación.
   *
   * `GET /v1/validations`. Un listado trae menos campos que `get()`.
   */
  async list(params: ListValidationsParams = {}): Promise<Page<ValidationSummary>> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/validations',
      query: { page: params.page, per_page: params.perPage, ...filtersToQuery(params) },
    });
    return parsePage<ValidationSummary>(response);
  }

  /**
   * Recorre todas las validaciones que casan con los filtros.
   *
   * Pide cada página cuando la anterior se agota. `maxPages` acota el recorrido,
   * y `page` fija la página de partida.
   *
   * ```ts
   * for await (const validation of client.validations.iter({ status: 'valid' })) {
   *   console.log(validation.id);
   * }
   * ```
   */
  iter(params: ListValidationsParams & IterOptions = {}): AsyncIterable<ValidationSummary> {
    const { maxPages, page, ...filters } = params;
    return iteratePages((number) => this.list({ ...filters, page: number }), {
      startPage: page ?? 1,
      maxPages,
    });
  }

  /**
   * Los totales de las validaciones de la cuenta, con los mismos filtros.
   *
   * `GET /v1/validations/stats`.
   */
  async stats(filters: ValidationFilters = {}): Promise<ValidationStats> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/validations/stats',
      query: filtersToQuery(filters),
    });
    return readData<ValidationStats>(response, 'de las estadísticas');
  }

  /**
   * Los intentos del ciclo de reintentos de una validación.
   *
   * `GET /v1/validations/{id}/retry-attempts`.
   */
  async retryAttempts(validationId: string): Promise<RetryAttempt[]> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/validations/${pathSegment(validationId)}/retry-attempts`,
    });
    return readList<RetryAttempt>(response, 'de los intentos');
  }

  /**
   * Sondea una validación hasta que su veredicto queda firme.
   *
   * Es la pareja de `enqueue()`. Manda `If-None-Match` con el `ETag` de la
   * respuesta anterior, así que un sondeo que no encuentra cambios no descarga
   * otra vez el mismo cuerpo.
   *
   * Espera a `isSettled()`, no a `isTerminal()`: una validación con reintentos
   * en marcha llega a `not_found` y sigue cambiando después.
   *
   * @throws {TimeoutError} Si se agota `timeoutMs` sin veredicto firme.
   */
  async waitFor(validationId: string, options: WaitForOptions = {}): Promise<ValidationWithEtag> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = options.sleep ?? defaultSleep;
    const deadline = performance.now() + timeoutMs;

    let etag: string | undefined;
    let latest: ValidationWithEtag | undefined;

    for (;;) {
      const result = await this.read(validationId, etag);
      if (!result.notModified) {
        latest = result.validation;
        etag = result.validation.etag;
      }
      if (latest && isSettled(latest)) return latest;
      if (performance.now() >= deadline) {
        throw new TimeoutError(
          `La validación ${validationId} no alcanzó un veredicto firme en ${String(timeoutMs)} ms`,
          validationId,
          timeoutMs,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  // Archivos

  /**
   * Descarga el CEP oficial de una validación en XML o en PDF.
   *
   * `GET /v1/validations/{id}/cep`. Devuelve el archivo: el XML que emitió
   * Banxico, con su sello digital y su cadena original, o el PDF equivalente.
   *
   * Existe cuando la validación tiene comprobante (`hasCep()`). Cuando no, la
   * API responde `404` con `cep_not_available` y el SDK lo lanza como
   * `NotFoundError`.
   */
  async cep(validationId: string, options: { format?: CepFormat } = {}): Promise<CepDocument> {
    const format = options.format ?? 'xml';
    if (!CEP_FORMATS.includes(format)) {
      throw new ConfigurationError(
        `El formato del CEP es 'xml' o 'pdf'; llegó ${JSON.stringify(format)}`,
      );
    }

    const accept = format === 'xml' ? 'application/xml' : 'application/pdf';
    const response = await this.transport.request({
      method: 'GET',
      path: `/validations/${pathSegment(validationId)}/cep`,
      query: { format },
      accept: `${accept}, application/json`,
    });

    return {
      validationId,
      format,
      ...toFile(
        response,
        `CEP-${validationId}.${format}`,
        response.headers['content-type'] ?? accept,
      ),
    };
  }

  /**
   * Descarga la imagen del comprobante de una validación por OCR.
   *
   * `GET /v1/validations/{id}/image`.
   */
  async image(validationId: string): Promise<DownloadedFile> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/validations/${pathSegment(validationId)}/image`,
      accept: IMAGE_ACCEPT,
    });
    const contentType = response.headers['content-type'] ?? 'image/png';
    const extension = IMAGE_EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] ?? '';
    return toFile(response, `comprobante-${validationId}${extension}`, contentType);
  }

  /**
   * Exporta el historial de validaciones en CSV o en XLSX.
   *
   * `GET /v1/validations/export`. Admite los mismos filtros que `list()`.
   */
  export(params: ExportValidationsParams = {}): Promise<DownloadedFile> {
    return exportFile(
      this.transport,
      '/validations/export',
      params.format ?? 'csv',
      { ...filtersToQuery(params), limit: params.limit },
      'validaciones',
    );
  }

  // Cambiar

  /**
   * Cambia la política de reintentos de una validación concreta.
   *
   * `PUT /v1/validations/{id}/retry-policy`. Devuelve el estado del ciclo de
   * reintentos, no la validación completa.
   */
  async setRetryPolicy(
    validationId: string,
    policy: RetryPolicy,
    options: IdempotentOptions = {},
  ): Promise<RetryStateResource> {
    const response = await this.transport.request({
      method: 'PUT',
      path: `/validations/${pathSegment(validationId)}/retry-policy`,
      body: { retry_policy: policy },
      headers: idempotencyHeader(options.idempotencyKey),
    });
    return readData<RetryStateResource>(response, 'del estado de reintentos');
  }

  /**
   * Detiene el ciclo de reintentos pendientes de una validación.
   *
   * `POST /v1/validations/{id}/cancel-retries`. Si el ciclo ya no está activo,
   * la API responde `422` con `retry_not_active`.
   */
  async cancelRetries(
    validationId: string,
    options: IdempotentOptions = {},
  ): Promise<RetryStateResource> {
    const response = await this.transport.request({
      method: 'POST',
      path: `/validations/${pathSegment(validationId)}/cancel-retries`,
      headers: idempotencyHeader(options.idempotencyKey),
    });
    return readData<RetryStateResource>(response, 'del estado de reintentos');
  }

  /**
   * Retira una validación del historial.
   *
   * `DELETE /v1/validations/{id}`. La API responde `204` y no devuelve cuerpo.
   */
  async delete(validationId: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/validations/${pathSegment(validationId)}`,
    });
  }

  /**
   * Envía el comprobante al chat de Telegram vinculado a la cuenta.
   *
   * `POST /v1/validations/{id}/cep/send-telegram`. La API acusa con `202`: el
   * envío ocurre después.
   */
  async sendCepToTelegram(validationId: string): Promise<TelegramDispatch> {
    const response = await this.transport.request({
      method: 'POST',
      path: `/validations/${pathSegment(validationId)}/cep/send-telegram`,
    });
    return readData<TelegramDispatch>(response, 'del envío');
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Los eventos de un endpoint, con su comprobación previa.
 *
 * Recibe el tipo ancho porque quien llama desde JavaScript puede omitirlos, y el
 * tipo de `create()` los declara obligatorios.
 */
function subscribedEvents(
  events: readonly WebhookSubscriptionEvent[] | undefined,
): WebhookSubscriptionEvent[] {
  if (!events?.length) {
    throw new InvalidRequestError('Un endpoint se suscribe al menos a un evento', {
      status: 422,
      code: 'events_required',
    });
  }
  return [...events];
}

/** Endpoints de webhook y su historial de entregas. */
export class Webhooks {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Registra un endpoint y devuelve su secreto de firma.
   *
   * `POST /v1/webhooks`. El secreto viaja **una sola vez**, en
   * `attributes.secret` de esta respuesta: guárdalo al recibirlo. Si se pierde,
   * se rota con `regenerateSecret()`.
   */
  async create(params: CreateWebhookParams): Promise<WebhookEndpoint> {
    const body: Schemas['CreateWebhookRequest'] = {
      url: params.url,
      events: subscribedEvents(params.events),
    };
    if (params.description !== undefined) body.description = params.description;

    const response = await this.transport.request({ method: 'POST', path: '/webhooks', body });
    return readData<WebhookEndpoint>(response, 'del endpoint');
  }

  /**
   * Lista los endpoints registrados, sin sus secretos.
   *
   * `GET /v1/webhooks`.
   */
  async list(): Promise<WebhookEndpoint[]> {
    const response = await this.transport.request({ method: 'GET', path: '/webhooks' });
    return readList<WebhookEndpoint>(response, 'de los endpoints');
  }

  /**
   * Cambia la URL, los eventos suscritos, la etiqueta o el estado de un endpoint.
   *
   * `PUT /v1/webhooks/{id}`. Un endpoint que el sistema apagó se reactiva con
   * `status: 'active'`; `auto_disabled` no se puede asignar desde la API.
   */
  async update(webhookId: string, params: UpdateWebhookParams): Promise<WebhookEndpoint> {
    const body: Schemas['UpdateWebhookRequest'] = {};
    if (params.url !== undefined) body.url = params.url;
    if (params.events !== undefined) body.events = subscribedEvents(params.events);
    if (params.description !== undefined) body.description = params.description;
    if (params.status !== undefined) body.status = params.status;
    if (Object.keys(body).length === 0) {
      throw new InvalidRequestError(
        'No hay nada que cambiar: pasa url, events, description o status',
        { status: 422, code: 'empty_update' },
      );
    }

    const response = await this.transport.request({
      method: 'PUT',
      path: `/webhooks/${pathSegment(webhookId)}`,
      body,
    });
    return readData<WebhookEndpoint>(response, 'del endpoint');
  }

  /**
   * Retira un endpoint.
   *
   * `DELETE /v1/webhooks/{id}`. La API responde `204`.
   */
  async delete(webhookId: string): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/webhooks/${pathSegment(webhookId)}`,
    });
  }

  /**
   * Envía un evento de prueba al endpoint.
   *
   * `POST /v1/webhooks/{id}/test`. Las entregas de prueba no cuentan para el
   * contador de fallos consecutivos.
   */
  async test(webhookId: string): Promise<WebhookTestResult> {
    const response = await this.transport.request({
      method: 'POST',
      path: `/webhooks/${pathSegment(webhookId)}/test`,
    });
    return readData<WebhookTestResult>(response, 'de la prueba');
  }

  /**
   * Rota el secreto de firma de un endpoint.
   *
   * `POST /v1/webhooks/{id}/regenerate-secret`. El secreto nuevo viene en
   * `attributes.secret`, y es la última vez que la API lo entrega.
   */
  async regenerateSecret(webhookId: string): Promise<WebhookEndpoint> {
    const response = await this.transport.request({
      method: 'POST',
      path: `/webhooks/${pathSegment(webhookId)}/regenerate-secret`,
    });
    return readData<WebhookEndpoint>(response, 'del endpoint');
  }

  // Entregas

  /**
   * Lista los intentos de entrega.
   *
   * Con `webhookId` consulta los de ese endpoint; sin él, los de todos. Los
   * filtros `status` y `eventType` sólo existen en el listado global, así que con
   * `webhookId` y un filtro la petición va a `GET /v1/webhooks/deliveries` con
   * `endpoint_id`.
   */
  deliveries(params?: DeliveriesParams): Promise<Page<WebhookDelivery>>;
  deliveries(webhookId: string, params?: DeliveriesParams): Promise<Page<WebhookDelivery>>;
  async deliveries(
    first?: string | DeliveriesParams,
    second?: DeliveriesParams,
  ): Promise<Page<WebhookDelivery>> {
    const webhookId = typeof first === 'string' ? first : undefined;
    const params: DeliveriesParams = (typeof first === 'string' ? second : first) ?? {};
    const filtered = params.status !== undefined || params.eventType !== undefined;

    const paging = { page: params.page, per_page: params.perPage };
    const response =
      webhookId !== undefined && !filtered
        ? await this.transport.request({
            method: 'GET',
            path: `/webhooks/${pathSegment(webhookId)}/deliveries`,
            query: paging,
          })
        : await this.transport.request({
            method: 'GET',
            path: '/webhooks/deliveries',
            query: {
              ...paging,
              endpoint_id: webhookId === undefined ? undefined : checkedId(webhookId),
              status: params.status,
              event_type: params.eventType,
            },
          });
    return parsePage<WebhookDelivery>(response);
  }

  /**
   * Recorre todos los intentos de entrega, página a página.
   *
   * Acepta los mismos argumentos que `deliveries()`, más `maxPages`.
   */
  iterDeliveries(params?: DeliveriesParams & IterOptions): AsyncIterable<WebhookDelivery>;
  iterDeliveries(
    webhookId: string,
    params?: DeliveriesParams & IterOptions,
  ): AsyncIterable<WebhookDelivery>;
  iterDeliveries(
    first?: string | (DeliveriesParams & IterOptions),
    second?: DeliveriesParams & IterOptions,
  ): AsyncIterable<WebhookDelivery> {
    const webhookId = typeof first === 'string' ? first : undefined;
    const options: DeliveriesParams & IterOptions =
      (typeof first === 'string' ? second : first) ?? {};
    const { maxPages, page, ...filters } = options;

    return iteratePages(
      (number) =>
        webhookId === undefined
          ? this.deliveries({ ...filters, page: number })
          : this.deliveries(webhookId, { ...filters, page: number }),
      { startPage: page ?? 1, maxPages },
    );
  }

  /**
   * Exporta el historial de entregas en CSV o en XLSX.
   *
   * Con `webhookId`, las de ese endpoint; sin él, las de todos. Como en
   * `deliveries()`, un filtro con `webhookId` lleva la petición al listado global.
   */
  exportDeliveries(params?: ExportDeliveriesParams): Promise<DownloadedFile>;
  exportDeliveries(webhookId: string, params?: ExportDeliveriesParams): Promise<DownloadedFile>;
  exportDeliveries(
    first?: string | ExportDeliveriesParams,
    second?: ExportDeliveriesParams,
  ): Promise<DownloadedFile> {
    const webhookId = typeof first === 'string' ? first : undefined;
    const params: ExportDeliveriesParams = (typeof first === 'string' ? second : first) ?? {};
    const filtered = params.status !== undefined || params.eventType !== undefined;
    const format = params.format ?? 'csv';

    if (webhookId !== undefined && !filtered) {
      return exportFile(
        this.transport,
        `/webhooks/${pathSegment(webhookId)}/deliveries/export`,
        format,
        { limit: params.limit },
        `entregas-${webhookId}`,
      );
    }
    return exportFile(
      this.transport,
      '/webhooks/deliveries/export',
      format,
      {
        limit: params.limit,
        endpoint_id: webhookId === undefined ? undefined : checkedId(webhookId),
        status: params.status,
        event_type: params.eventType,
      },
      webhookId === undefined ? 'entregas' : `entregas-${webhookId}`,
    );
  }
}

// ── Catálogo ────────────────────────────────────────────────────────────────

/** Datos abiertos: el catálogo de bancos y el estado del servicio. */
export class Catalog {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Lista las instituciones participantes en SPEI con su código.
   *
   * `GET /v1/public/banks`. Con `ifNoneMatch` la API responde `304` cuando el
   * catálogo no cambió, y el SDK lo lanza como `ApiError` con `status` 304. El
   * `ETag` de cada lectura queda en `etag`.
   */
  async banks(options: BanksOptions = {}): Promise<BankList> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/public/banks',
      headers: { 'if-none-match': options.ifNoneMatch },
    });
    if (response.status === 304) throw notModified('El catálogo', response);

    const banks: BankList = readList<Bank>(response, 'de los bancos');
    const etag = response.headers['etag'];
    if (etag) banks.etag = etag;
    return banks;
  }

  /**
   * Resuelve el banco emisor de una tarjeta por sus primeros dígitos.
   *
   * `GET /v1/public/bin-lookup/{bin}`.
   */
  async binLookup(bin: string): Promise<BinLookup> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/public/bin-lookup/${pathSegment(bin)}`,
    });
    return readData<BinLookup>(response, 'del BIN');
  }

  /**
   * Estado del servicio de consulta de Banxico.
   *
   * `GET /v1/status/banxico`. Sirve para distinguir un `cep_unavailable` propio de
   * la transferencia de una caída del servicio.
   */
  async banxicoStatus(): Promise<BanxicoStatus> {
    const response = await this.transport.request({ method: 'GET', path: '/status/banxico' });
    return readData<BanxicoStatus>(response, 'del estado');
  }

  /**
   * Serie temporal de la salud del servicio de Banxico.
   *
   * `GET /v1/status/banxico/timeseries`.
   */
  async banxicoTimeseries(params: TimeseriesParams = {}): Promise<BanxicoTimeseries> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/status/banxico/timeseries',
      query: { metric: params.metric, window: params.window },
    });
    return readData<BanxicoTimeseries>(response, 'de la serie');
  }
}

// ── Beneficiarios ───────────────────────────────────────────────────────────

const IMPORT_CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

const TEMPLATE_CONTENT_TYPES: Record<ImportTemplateFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  json: 'application/json',
};

const DEFAULT_IMPORT_POLL_INTERVAL_MS = 2_000;

/** El contenido de un archivo de importación, su nombre y su tipo. */
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
      throw new ConfigurationError(`No existe el archivo: ${file}`);
    }
    name = filename ?? basename(file);
  } else {
    content = file;
    name = filename ?? 'beneficiarios.csv';
  }
  return {
    content,
    filename: name,
    contentType: IMPORT_CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
  };
}

function noValidFields(what: string): InvalidRequestError {
  return new InvalidRequestError(`No hay nada que cambiar: pasa ${what}`, {
    status: 422,
    code: 'no_valid_fields',
  });
}

/** Cuentas beneficiarias guardadas y su importación masiva. */
export class Beneficiaries {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // La lista blanca

  /**
   * Registra una cuenta beneficiaria.
   *
   * `POST /v1/beneficiaries`. El tipo se detecta por longitud: CLABE (18 dígitos),
   * tarjeta (16) o celular DiMo (10). Para un celular, `bankCode` es obligatorio;
   * en CLABE y tarjeta se deriva del número. Un alta de una cuenta archivada la
   * reactiva.
   */
  async create(params: CreateBeneficiaryParams): Promise<Beneficiary> {
    // Quien llama desde JavaScript puede omitirlo; el tipo lo declara obligatorio.
    const accountNumber: string | undefined = params.accountNumber;
    if (!accountNumber) {
      throw new InvalidRequestError('Hace falta accountNumber para registrar el beneficiario', {
        status: 422,
        code: 'account_number_required',
      });
    }
    const body: Schemas['CreateBeneficiaryRequest'] = { account_number: accountNumber };
    if (params.bankCode !== undefined) body.bank_code = params.bankCode;
    if (params.label !== undefined) body.label = params.label;

    const response = await this.transport.request({ method: 'POST', path: '/beneficiaries', body });
    return readData<Beneficiary>(response, 'del beneficiario');
  }

  /**
   * Lista las cuentas beneficiarias guardadas.
   *
   * `GET /v1/beneficiaries`. Sin paginar: devuelve la lista completa.
   * `withArchived: true` trae sólo las archivadas y `false` sólo las activas.
   */
  async list(params: ListBeneficiariesParams = {}): Promise<Beneficiary[]> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/beneficiaries',
      query: { with_archived: flag(params.withArchived) },
    });
    return readList<Beneficiary>(response, 'de los beneficiarios');
  }

  /**
   * Cambia la etiqueta, la cuenta o el banco de un beneficiario.
   *
   * `PUT /v1/beneficiaries/{id}`. Un `accountNumber` nuevo vuelve a derivar el
   * tipo y el banco; `bankCode` sólo se aplica sobre cuentas de tipo celular.
   */
  async update(beneficiaryId: EntityId, params: UpdateBeneficiaryParams): Promise<Beneficiary> {
    const body: Schemas['UpdateBeneficiaryRequest'] = {};
    if (params.label !== undefined) body.label = params.label;
    if (params.accountNumber !== undefined) body.account_number = params.accountNumber;
    if (params.bankCode !== undefined) body.bank_code = params.bankCode;
    if (Object.keys(body).length === 0) throw noValidFields('label, accountNumber o bankCode');

    const response = await this.transport.request({
      method: 'PUT',
      path: `/beneficiaries/${pathSegment(String(beneficiaryId))}`,
      body,
    });
    return readData<Beneficiary>(response, 'del beneficiario');
  }

  /**
   * Archiva un beneficiario.
   *
   * `DELETE /v1/beneficiaries/{id}`. El registro no se borra: sale de la lista
   * activa y se consulta con `withArchived: true`. Un alta posterior con la misma
   * cuenta lo reactiva. La API responde `204`.
   */
  async delete(beneficiaryId: EntityId): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/beneficiaries/${pathSegment(String(beneficiaryId))}`,
    });
  }

  /**
   * Resuelve una cuenta concreta dentro de la lista propia.
   *
   * `GET /v1/beneficiaries/lookup`. Devuelve los datos del banco cuando la cuenta
   * está entre las guardadas; si no, la API responde `404`.
   */
  async lookup(account: string): Promise<BeneficiaryLookup> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/beneficiaries/lookup',
      query: { account },
    });
    return readData<BeneficiaryLookup>(response, 'de la cuenta');
  }

  /**
   * Exporta la lista de beneficiarios en CSV o en XLSX.
   *
   * `GET /v1/beneficiaries/export`. Los números salen enmascarados salvo la CLABE;
   * `limit` sólo baja el tope de 100 000 filas.
   */
  export(params: ExportBeneficiariesParams = {}): Promise<DownloadedFile> {
    return exportFile(
      this.transport,
      '/beneficiaries/export',
      params.format ?? 'csv',
      { with_archived: flag(params.withArchived), limit: params.limit },
      'beneficiarios',
      'application/octet-stream',
    );
  }

  // Importación masiva

  /**
   * Descarga la plantilla para la importación masiva.
   *
   * `GET /v1/beneficiaries/imports/template`. Es el punto de partida del ciclo:
   * descargar, rellenar, subir, revisar y confirmar.
   */
  async importTemplate(options: ImportTemplateOptions = {}): Promise<DownloadedFile> {
    const format = options.format ?? 'csv';
    if (!IMPORT_TEMPLATE_FORMATS.includes(format)) {
      throw new ConfigurationError(
        `El formato de plantilla es 'csv', 'xlsx', 'xls', 'txt' o 'json'; llegó ${JSON.stringify(format)}`,
      );
    }
    const accept = TEMPLATE_CONTENT_TYPES[format];
    const response = await this.transport.request({
      method: 'GET',
      path: '/beneficiaries/imports/template',
      query: { format },
      accept: `${accept}, application/octet-stream, application/json`,
    });
    return toFile(
      response,
      `beneficiarios-plantilla.${format}`,
      response.headers['content-type'] ?? accept,
    );
  }

  /**
   * Sube un archivo y abre un trabajo de importación.
   *
   * `POST /v1/beneficiaries/imports`. `file` son los bytes del archivo o su ruta,
   * que el SDK lee del disco. `parseMode` es `template` (encabezados canónicos) o
   * `free` (formato libre). La respuesta es un `202` con el trabajo en estado
   * `pending`; nada se persiste hasta `importCommit()`.
   */
  async importStart(
    file: Uint8Array | string,
    options: ImportStartOptions = {},
  ): Promise<BeneficiaryImportStarted> {
    const upload = await importFile(file, options.filename);
    const form = new FormData();
    form.append('parse_mode', options.parseMode ?? 'template');
    form.append('file', new Blob([upload.content], { type: upload.contentType }), upload.filename);

    const response = await this.transport.request({
      method: 'POST',
      path: '/beneficiaries/imports',
      body: form,
    });
    return readData<BeneficiaryImportStarted>(response, 'de la importación');
  }

  /**
   * Lee el estado de un trabajo de importación y sus contadores.
   *
   * `GET /v1/beneficiaries/imports/{id}`.
   */
  async importStatus(importId: EntityId): Promise<BeneficiaryImportJob> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}`,
    });
    return readData<BeneficiaryImportJob>(response, 'de la importación');
  }

  /**
   * Cancela una importación que todavía no se confirmó.
   *
   * `DELETE /v1/beneficiaries/imports/{id}`. Admite los estados `pending`,
   * `parsing` y `preview_ready`; con uno terminal o en `committing`, la API
   * responde `404`. Las cuentas que una confirmación ya persistió se archivan una
   * a una con `delete()`. La API responde `204`.
   */
  async importCancel(importId: EntityId): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}`,
    });
  }

  /**
   * Lista las filas extraídas de la importación, paginadas.
   *
   * `GET /v1/beneficiaries/imports/{id}/preview`. Disponible en `preview_ready` o
   * después. `buckets` filtra por grupo (`valid`, `correctable`, `fatal`,
   * `duplicate_account`, `duplicate_alias`).
   */
  async importPreview(
    importId: EntityId,
    params: ImportPreviewParams = {},
  ): Promise<Page<BeneficiaryImportRow>> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}/preview`,
      query: { page: params.page, per_page: params.perPage, buckets: params.buckets },
    });
    return parsePage<BeneficiaryImportRow>(response);
  }

  /**
   * Recorre todas las filas de la vista previa, página a página.
   *
   * Acepta los mismos argumentos que `importPreview()`, más `maxPages`.
   */
  iterImportPreview(
    importId: EntityId,
    params: ImportPreviewParams & IterOptions = {},
  ): AsyncIterable<BeneficiaryImportRow> {
    const { maxPages, page, ...filters } = params;
    return iteratePages((number) => this.importPreview(importId, { ...filters, page: number }), {
      startPage: page ?? 1,
      maxPages,
    });
  }

  /**
   * Corrige una fila de la vista previa antes de confirmar.
   *
   * `PATCH /v1/beneficiaries/imports/{id}/rows/{row_id}`. Sólo los campos
   * presentes se sobrescriben; la fila se reprocesa y su grupo puede cambiar con
   * la corrección.
   */
  async importEditRow(
    importId: EntityId,
    rowId: EntityId,
    params: EditImportRowParams,
  ): Promise<BeneficiaryImportRow> {
    const body: Schemas['PatchBeneficiaryImportRowRequest'] = {};
    if (params.parsedAccount !== undefined) body.parsed_account = params.parsedAccount;
    if (params.parsedLabel !== undefined) body.parsed_label = params.parsedLabel;
    if (params.parsedAccountType !== undefined) {
      body.parsed_account_type = params.parsedAccountType;
    }
    if (params.parsedBankCode !== undefined) body.parsed_bank_code = params.parsedBankCode;
    if (params.parsedBankName !== undefined) body.parsed_bank_name = params.parsedBankName;
    if (Object.keys(body).length === 0) throw noValidFields('alguno de los campos parsed*');

    const response = await this.transport.request({
      method: 'PATCH',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}/rows/${pathSegment(String(rowId))}`,
      body,
    });
    return readData<BeneficiaryImportRow>(response, 'de la fila');
  }

  /**
   * Quita una fila de la vista previa.
   *
   * `DELETE /v1/beneficiaries/imports/{id}/rows/{row_id}`. La API responde `204`.
   */
  async importRemoveRow(importId: EntityId, rowId: EntityId): Promise<void> {
    await this.transport.request({
      method: 'DELETE',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}/rows/${pathSegment(String(rowId))}`,
    });
  }

  /**
   * Confirma la importación y dispara la persistencia de sus filas.
   *
   * `POST /v1/beneficiaries/imports/{id}/commit`. La operación es asíncrona: la
   * respuesta es un `202` con el trabajo en `committing`, y el resultado se sigue
   * con `importWait()`.
   */
  async importCommit(importId: EntityId): Promise<BeneficiaryImportCommitted> {
    const response = await this.transport.request({
      method: 'POST',
      path: `/beneficiaries/imports/${pathSegment(String(importId))}/commit`,
    });
    return readData<BeneficiaryImportCommitted>(response, 'de la importación');
  }

  /**
   * Sondea una importación hasta que su avance se detiene.
   *
   * Espera a `isImportSettled()`: `preview_ready` o un estado final. A diferencia
   * de `validations.waitFor()`, aquí no hay `ETag` que reutilizar: el endpoint de
   * estado no lo expone, así que cada sondeo descarga el cuerpo entero.
   *
   * @throws {TimeoutError} Si se agota `timeoutMs` sin llegar a un estado firme.
   */
  async importWait(
    importId: EntityId,
    options: WaitForOptions = {},
  ): Promise<BeneficiaryImportJob> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS;
    const sleep = options.sleep ?? defaultSleep;
    const deadline = performance.now() + timeoutMs;

    for (;;) {
      const job = await this.importStatus(importId);
      if (isImportSettled(job)) return job;
      if (performance.now() >= deadline) {
        throw new TimeoutError(
          `La importación ${String(importId)} no llegó a preview_ready ni a un estado final en ${String(timeoutMs)} ms`,
          String(importId),
          timeoutMs,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}

// ── Consumo ─────────────────────────────────────────────────────────────────

/** Consumo y límites: la cuota del plan y el registro de actividad. */
export class Usage {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Devuelve la cuota de validaciones del plan en curso.
   *
   * `GET /v1/usage/summary`. Trae el límite, lo consumido, lo restante y el nivel
   * de aviso en `attributes.tone`.
   */
  async summary(): Promise<UsageSummary> {
    const response = await this.transport.request({ method: 'GET', path: '/usage/summary' });
    return readData<UsageSummary>(response, 'del consumo');
  }

  /**
   * Devuelve el consumo mensual de los últimos `months` meses.
   *
   * `GET /v1/usage/history`. De más reciente a más antiguo. El límite que
   * acompaña a cada fila es el de hoy, no el que regía aquel mes.
   */
  async history(params: UsageHistoryParams = {}): Promise<UsageHistory> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/usage/history',
      query: { months: params.months },
    });
    return readData<UsageHistory>(response, 'del historial');
  }

  /**
   * Desglosa el consumo por tipo de operación contabilizada.
   *
   * `GET /v1/usage/breakdown`. `period` es `current` para el mes en curso o una
   * cadena `YYYY-MM`.
   */
  async breakdown(params: UsageBreakdownParams = {}): Promise<UsageBreakdown> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/usage/breakdown',
      query: { period: params.period },
    });
    return readData<UsageBreakdown>(response, 'del desglose');
  }

  /**
   * Devuelve los límites de tasa aplicables, por contexto.
   *
   * `GET /v1/usage/limits`. Sólo la configuración vigente, sin contadores en
   * vivo; son ajenos a la cuota mensual de `summary()`.
   */
  async limits(): Promise<UsageLimits> {
    const response = await this.transport.request({ method: 'GET', path: '/usage/limits' });
    return readData<UsageLimits>(response, 'de los límites');
  }

  /**
   * Devuelve las validaciones agrupadas por día y hora.
   *
   * `GET /v1/usage/heatmap`. Cubre los últimos `days` días (máximo 90) y sólo trae
   * las celdas con al menos una validación.
   */
  async heatmap(params: UsageHeatmapParams = {}): Promise<UsageHeatmap> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/usage/heatmap',
      query: { days: params.days },
    });
    return readData<UsageHeatmap>(response, 'del mapa de calor');
  }

  /**
   * Devuelve las métricas de uso de la API de la cuenta.
   *
   * `GET /v1/api/usage`. Reúne las peticiones de hoy y del mes, la cuota del plan,
   * las últimas peticiones y el estado del servicio de Banxico.
   */
  async apiUsage(): Promise<ApiUsage> {
    const response = await this.transport.request({ method: 'GET', path: '/api/usage' });
    return readData<ApiUsage>(response, 'de las métricas');
  }

  /**
   * Exporta el registro de actividad en CSV o en XLSX.
   *
   * `GET /v1/api/usage/export`. `from` y `to` acotan el rango, las dos inclusive;
   * `limit` sólo baja el tope de 100 000 filas.
   */
  export(params: ExportUsageParams = {}): Promise<DownloadedFile> {
    return exportFile(
      this.transport,
      '/api/usage/export',
      params.format ?? 'csv',
      { from: params.from, to: params.to, limit: params.limit },
      'actividad-api',
    );
  }
}

// ── Cuenta, panel, planes, insights, finanzas y facturación ────────────────

/** Perfil y preferencias de la cuenta autenticada. */
export class Account {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/users/me`. */
  async myProfile(): Promise<UserProfile> {
    const response = await this.transport.request({ method: 'GET', path: '/users/me' });
    return readData<UserProfile>(response, 'del perfil');
  }

  profile(): Promise<UserProfile> {
    return this.myProfile();
  }

  /** `GET /v1/users/me/retry-policy`. */
  async getMyRetryPolicy(): Promise<UserRetryPolicy> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/users/me/retry-policy',
    });
    return readData<UserRetryPolicy>(response, 'de la política de reintentos');
  }

  retryPolicy(): Promise<UserRetryPolicy> {
    return this.getMyRetryPolicy();
  }

  /** `PUT /v1/users/me/retry-policy`. */
  async updateMyRetryPolicy(
    policy: RetryPolicy,
    options: IdempotentOptions = {},
  ): Promise<UserRetryPolicy> {
    const body: Schemas['UpdateUserRetryPolicyRequest'] = { retry_policy: policy };
    const response = await this.transport.request({
      method: 'PUT',
      path: '/users/me/retry-policy',
      body,
      headers: idempotencyHeader(options.idempotencyKey),
    });
    return readData<UserRetryPolicy>(response, 'de la política de reintentos');
  }
}

/** Resumen del panel de la cuenta. */
export class Dashboard {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/summary`. */
  async getSummary(params: DashboardSummaryParams = {}): Promise<DashboardSummary> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/summary',
      query: { limit: params.limit },
    });
    return readData<DashboardSummary>(response, 'del resumen del panel');
  }

  summary(params: DashboardSummaryParams = {}): Promise<DashboardSummary> {
    return this.getSummary(params);
  }
}

/** Catálogo de planes que no requiere clave de API. */
export class Plans {
  constructor(private readonly transport: Transport) {}

  /** `GET /v1/plans/public`. */
  async listPublic(): Promise<PublicPlans> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/plans/public',
      authenticated: false,
    });
    return readData<PublicPlans>(response, 'de los planes públicos');
  }

  list(): Promise<PublicPlans> {
    return this.listPublic();
  }

  /** `GET /v1/plans/public/comparison`. */
  async getPublicPlanComparison(): Promise<PublicPlanComparison> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/plans/public/comparison',
      authenticated: false,
    });
    return readData<PublicPlanComparison>(response, 'de la comparación de planes');
  }

  comparison(): Promise<PublicPlanComparison> {
    return this.getPublicPlanComparison();
  }
}

/** Métricas agregadas de la cuenta autenticada. */
export class Insights {
  constructor(private readonly transport: Transport) {}

  async getOverview(): Promise<InsightsOverview> {
    const response = await this.transport.request({ method: 'GET', path: '/insights/overview' });
    return readData<InsightsOverview>(response, 'de insights');
  }

  overview(): Promise<InsightsOverview> {
    return this.getOverview();
  }

  async getTrends(params: UserInsightsTrendsParams = {}): Promise<InsightsTrends> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/insights/trends',
      query: { range: params.range, metric: params.metric },
    });
    return readData<InsightsTrends>(response, 'de las tendencias');
  }

  trends(params: UserInsightsTrendsParams = {}): Promise<InsightsTrends> {
    return this.getTrends(params);
  }

  async getTopBanks(params: UserInsightsTopBanksParams = {}): Promise<InsightsTopBanks> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/insights/top-banks',
      query: { metric: params.metric, limit: params.limit },
    });
    return readData<InsightsTopBanks>(response, 'de los bancos principales');
  }

  topBanks(params: UserInsightsTopBanksParams = {}): Promise<InsightsTopBanks> {
    return this.getTopBanks(params);
  }

  async getTopBeneficiaries(
    params: UserInsightsTopBeneficiariesParams = {},
  ): Promise<InsightsTopBeneficiaries> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/insights/top-beneficiaries',
      query: { limit: params.limit },
    });
    return readData<InsightsTopBeneficiaries>(response, 'de los beneficiarios principales');
  }

  topBeneficiaries(
    params: UserInsightsTopBeneficiariesParams = {},
  ): Promise<InsightsTopBeneficiaries> {
    return this.getTopBeneficiaries(params);
  }
}

const FINANCE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
};

async function financeFile(
  transport: Transport,
  path: string,
  query: Query,
  format: string,
  fallback: string,
  includeFormat = true,
): Promise<DownloadedFile> {
  const contentType = FINANCE_CONTENT_TYPES[format] ?? 'application/octet-stream';
  const response = await transport.request({
    method: 'GET',
    path,
    query: includeFormat ? { ...query, format } : query,
    accept: `${contentType}, application/json`,
  });
  return toFile(response, `${fallback}.${format}`, response.headers['content-type'] ?? contentType);
}

/** Resúmenes y descargas financieras. */
export class Finance {
  constructor(private readonly transport: Transport) {}

  async getSummary(params: FinanceParams): Promise<FinanceSummary> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/finance/summary',
      query: { month: params.month, user_id: params.userId },
    });
    return readData<FinanceSummary>(response, 'del resumen financiero');
  }

  summary(params: FinanceParams): Promise<FinanceSummary> {
    return this.getSummary(params);
  }

  getStatement(params: FinanceStatementParams): Promise<DownloadedFile> {
    return financeFile(
      this.transport,
      '/finance/statement',
      { month: params.month, user_id: params.userId },
      params.format ?? 'pdf',
      'estado-de-cuenta',
    );
  }

  statement(params: FinanceStatementParams): Promise<DownloadedFile> {
    return this.getStatement(params);
  }

  private preview(
    path: string,
    params: FinancePreviewParams,
    fallback: string,
  ): Promise<FinancePreview | DownloadedFile> {
    const format = params.format ?? 'csv';
    if (format !== 'preview') {
      return financeFile(
        this.transport,
        path,
        { month: params.month, user_id: params.userId, limit: params.limit },
        format,
        fallback,
      );
    }
    return this.transport
      .request({
        method: 'GET',
        path,
        query: { month: params.month, user_id: params.userId, limit: params.limit, format },
      })
      .then((response) => readData<FinancePreview>(response, `de ${fallback}`));
  }

  getMonthly(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/monthly', params, 'finanzas-mensuales');
  }

  monthly(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.getMonthly(params);
  }

  getCounterparties(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/counterparties', params, 'contrapartes');
  }

  counterparties(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.getCounterparties(params);
  }

  getByBank(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.preview('/finance/by-bank', params, 'finanzas-por-banco');
  }

  byBank(params: FinancePreviewParams): Promise<FinancePreview | DownloadedFile> {
    return this.getByBank(params);
  }

  getAccounting(params: FinanceAccountingParams): Promise<FinancePreview | DownloadedFile> {
    const format = params.format ?? 'csv';
    if (format !== 'preview') {
      return financeFile(
        this.transport,
        '/finance/accounting',
        {
          month: params.month,
          user_id: params.userId,
          limit: params.limit,
          decimal: params.decimal,
        },
        format,
        'contabilidad',
      );
    }
    return this.transport
      .request({
        method: 'GET',
        path: '/finance/accounting',
        query: {
          month: params.month,
          user_id: params.userId,
          limit: params.limit,
          decimal: params.decimal,
          format,
        },
      })
      .then((response) => readData<FinancePreview>(response, 'de contabilidad'));
  }

  accounting(params: FinanceAccountingParams): Promise<FinancePreview | DownloadedFile> {
    return this.getAccounting(params);
  }

  getCeps(params: FinanceCepsParams): Promise<DownloadedFile> {
    return financeFile(
      this.transport,
      '/finance/ceps',
      { from: params.from, to: params.to, user_id: params.userId },
      'zip',
      'ceps',
      false,
    );
  }

  ceps(params: FinanceCepsParams): Promise<DownloadedFile> {
    return this.getCeps(params);
  }
}

/** Suscripción activa de la cuenta autenticada. */
export class Billing {
  constructor(private readonly transport: Transport) {}

  async getSubscription(): Promise<BillingSubscription> {
    const response = await this.transport.request({
      method: 'GET',
      path: '/billing/subscription',
    });
    return readData<BillingSubscription>(response, 'de la suscripción');
  }

  subscription(): Promise<BillingSubscription> {
    return this.getSubscription();
  }
}
