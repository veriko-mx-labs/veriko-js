/** El cliente: las operaciones de la API que este SDK cubre. */

import { randomUUID } from 'node:crypto';

import { ConfigurationError, InvalidRequestError } from './errors.js';
import {
  DEFAULT_RETRY,
  Transport,
  filenameFromContentDisposition,
  type RetryConfig,
} from './http.js';
import { CEP_FORMATS, type CepDocument, type CepFormat } from './types.js';
import type { ValidateTransferParams, Validation, ValidationRequest } from './types.js';

export const DEFAULT_BASE_URL = 'https://api.veriko.mx/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const API_KEY_ENV_VAR = 'VERIKO_API_KEY';
export const BASE_URL_ENV_VAR = 'VERIKO_BASE_URL';

/** La versión que viaja en el `User-Agent`. La actualiza `scripts/finish-build.mjs`. */
export const VERSION = '0.1.0';

export interface VerikoOptions {
  /** La clave de API. Por omisión, `VERIKO_API_KEY`. */
  apiKey?: string;
  /** La raíz de la API. Por omisión, `VERIKO_BASE_URL` o producción. */
  baseUrl?: string;
  /** Milisegundos de espera por intento. */
  timeoutMs?: number;
  /**
   * Reintentos automáticos además del primer intento. `0` los desactiva. Sólo
   * se reintenta lo que admite reintento: los `5xx`, el `408` y el `429`.
   */
  maxRetries?: number;
  /** `es` o `en`, para el idioma de `error.detail`. */
  acceptLanguage?: string;
  /** Configuración de reintentos completa. Gana sobre `maxRetries`. */
  retry?: Partial<RetryConfig>;
  userAgentSuffix?: string;
  /** Transporte ya construido. Las pruebas lo usan para no salir a la red. */
  transport?: Transport;
}

/**
 * Cliente de la API de Veriko.
 *
 * La clave de API se lee de `options.apiKey` o, si no se pasa, de la variable de
 * entorno `VERIKO_API_KEY`. Empieza con `veriko_` y se obtiene en el panel:
 * https://app.veriko.mx
 *
 * ```ts
 * const client = new Veriko();
 *
 * const validation = await client.validateTransfer({
 *   fecha: '2025-03-15',
 *   monto: 15000.5,
 *   claveRastreo: 'MXBA20250315001234',
 *   cuentaBeneficiaria: '012180004412345678',
 * });
 * ```
 */
export class Veriko {
  private readonly transport: Transport;

  constructor(options: VerikoOptions = {}) {
    const apiKey = options.apiKey ?? process.env[API_KEY_ENV_VAR] ?? '';
    if (!options.transport && !apiKey) {
      throw new ConfigurationError(
        `Falta la clave de API. Pásala como new Veriko({ apiKey }) o pon ${API_KEY_ENV_VAR} ` +
          'en el entorno. Se obtiene en https://app.veriko.mx',
      );
    }

    const suffix = options.userAgentSuffix ? ` ${options.userAgentSuffix}` : '';
    this.transport =
      options.transport ??
      new Transport({
        baseUrl: options.baseUrl ?? process.env[BASE_URL_ENV_VAR] ?? DEFAULT_BASE_URL,
        apiKey,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retry: {
          ...DEFAULT_RETRY,
          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          ...options.retry,
        },
        userAgent: `veriko-js/${VERSION} (+https://github.com/veriko-mx-labs/veriko-js)${suffix}`,
        acceptLanguage: options.acceptLanguage,
      });
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * Valida una transferencia SPEI contra el CEP de Banxico.
   *
   * `POST /v1/validate`. Devuelve el veredicto en `attributes.status`: `valid`,
   * `not_found`, `cep_unavailable`, `returned` o `error`.
   *
   * La operación exige `claveRastreo` o `referenciaNumerica`. Enviar las dos
   * precisa la búsqueda. La fecha es la de envío, en `YYYY-MM-DD`.
   *
   * Un `not_found` inmediato no equivale a una transferencia inexistente: un
   * CEP tarda en publicarse. `retryPolicy` deja a la API consultando de nuevo y
   * avisando por webhook cuando el veredicto cambia.
   *
   * Cada llamada consume cuota del plan, y se descuenta al aceptar la petición.
   */
  async validateTransfer(params: ValidateTransferParams): Promise<Validation> {
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

    const response = await this.transport.request({
      method: 'POST',
      path: '/validate',
      body,
      headers: { 'idempotency-key': params.idempotencyKey ?? newIdempotencyKey() },
    });
    return readValidation(response.body);
  }

  /**
   * Lee una validación por su identificador.
   *
   * `GET /v1/validations/{id}`. Es la operación con la que se sigue una
   * validación que quedó reintentando: el veredicto final aparece cuando
   * `attributes.status` alcanza un estado terminal.
   */
  async getValidation(validationId: string): Promise<Validation> {
    const response = await this.transport.request({
      method: 'GET',
      path: `/validations/${pathSegment(validationId)}`,
    });
    return readValidation(response.body);
  }

  /**
   * Descarga el CEP oficial de una validación.
   *
   * `GET /v1/validations/{id}/cep`. Devuelve el archivo: el XML que emitió
   * Banxico, con su sello digital y su cadena original, o el PDF equivalente.
   *
   * Existe cuando la validación tiene comprobante (`hasCep()`). Cuando no, la
   * API responde `404` con `cep_not_available` y el SDK lo lanza como
   * `NotFoundError`.
   */
  async getCep(validationId: string, options: { format?: CepFormat } = {}): Promise<CepDocument> {
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
      content: response.body,
      contentType: response.headers['content-type'] ?? accept,
      format,
      filename: filenameFromContentDisposition(
        response.headers['content-disposition'],
        `CEP-${validationId}.${format}`,
      ),
    };
  }
}

function readValidation(body: Uint8Array): Validation {
  const document: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!document || typeof document !== 'object' || !('data' in document)) {
    throw new ConfigurationError('La respuesta no trae el recurso `data` de la validación');
  }
  return (document as { data: Validation }).data;
}

/**
 * Una clave por llamada, estable entre los reintentos de esa misma llamada.
 *
 * Reintentar un `POST` sin clave de idempotencia puede duplicar la validación,
 * y su cargo, cuando la respuesta se perdió pero la petición llegó. Con clave,
 * el reintento devuelve la respuesta original.
 *
 * Esta clave no sobrevive al proceso que la generó. La que protege un reenvío
 * posterior es la que se pasa en `idempotencyKey`.
 */
function newIdempotencyKey(): string {
  return `veriko-js-${randomUUID().replace(/-/g, '')}`;
}

/** Un identificador que va en la ruta no puede traer barras ni espacios. */
function pathSegment(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || /[/?#]/.test(cleaned)) {
    throw new ConfigurationError(
      `Identificador de validación inservible: ${JSON.stringify(value)}`,
    );
  }
  return encodeURIComponent(cleaned);
}
