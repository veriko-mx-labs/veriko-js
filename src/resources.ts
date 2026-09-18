/**
 * Las operaciones de la API, agrupadas por familia.
 *
 * Cada familia es una propiedad del cliente: `client.validations`,
 * `client.webhooks` y `client.catalog`. Los tres métodos que estrenó la versión
 * 0.1.0 siguen en la raíz del cliente, porque son el camino corto del caso de
 * uso principal.
 */

import { readFile } from 'node:fs/promises';
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
  type Query,
} from './internal.js';
import { iteratePages, parsePage, type IterOptions, type Page } from './pagination.js';
import {
  CEP_FORMATS,
  EXPORT_FORMATS,
  isSettled,
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
    accept: `${accept}, application/json`,
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
