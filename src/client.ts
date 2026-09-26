/** El cliente: la entrada al SDK y las familias de operaciones. */

import { DEFAULT_RETRY, Transport, type RetryConfig } from './http.js';
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
import type {
  CepDocument,
  CepFormat,
  GetValidationOptions,
  ValidateTransferParams,
  Validation,
  ValidationWithEtag,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.veriko.mx/v1';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const API_KEY_ENV_VAR = 'VERIKO_API_KEY';
export const BASE_URL_ENV_VAR = 'VERIKO_BASE_URL';

/** La versión que viaja en el `User-Agent`. `test/client.test.ts` la compara con `package.json`. */
export const VERSION = '0.4.7';

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
 * Las operaciones se agrupan por familia:
 *
 * - `client.validations`: validar, consultar, reintentar y descargar.
 * - `client.webhooks`: endpoints y su historial de entregas.
 * - `client.catalog`: bancos y estado del servicio de Banxico.
 * - `client.beneficiaries`: cuentas guardadas y su importación masiva.
 * - `client.usage`: cuota, límites y registro de actividad.
 * - `client.account`: perfil y política de reintentos predeterminada.
 * - `client.dashboard`: resumen del panel.
 * - `client.plans`: catálogo y comparación de planes públicos.
 * - `client.insights`: métricas agregadas de la cuenta.
 * - `client.finance`: resúmenes y descargas financieras.
 * - `client.billing`: suscripción activa.
 *
 * Las tres de uso más frecuente están también en la raíz, como atajo:
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

  /** Validar, consultar, reintentar y descargar. */
  readonly validations: Validations;
  /** Endpoints de webhook y su historial de entregas. */
  readonly webhooks: Webhooks;
  /** Catálogo de bancos y estado del servicio de Banxico. */
  readonly catalog: Catalog;
  /** Cuentas beneficiarias guardadas y su importación masiva. */
  readonly beneficiaries: Beneficiaries;
  /** Cuota, límites y registro de actividad. */
  readonly usage: Usage;
  /** Perfil y preferencias de la cuenta autenticada. */
  readonly account: Account;
  /** Resumen del panel. */
  readonly dashboard: Dashboard;
  /** Catálogo público de planes. */
  readonly plans: Plans;
  /** Métricas agregadas de la cuenta. */
  readonly insights: Insights;
  /** Resúmenes y descargas financieras. */
  readonly finance: Finance;
  /** Suscripción activa de la cuenta. */
  readonly billing: Billing;

  constructor(options: VerikoOptions = {}) {
    const apiKey = options.apiKey ?? process.env[API_KEY_ENV_VAR] ?? '';
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
   * Atajo de `client.validations.validate()`.
   *
   * Valida una transferencia SPEI contra el CEP de Banxico. `POST /v1/validate`.
   * Devuelve el veredicto en `attributes.status`: `valid`, `not_found`,
   * `cep_unavailable`, `returned` o `error`.
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
  validateTransfer(params: ValidateTransferParams): Promise<Validation> {
    return this.validations.validate(params);
  }

  /**
   * Atajo de `client.validations.get()`.
   *
   * Lee una validación por su identificador. `GET /v1/validations/{id}`. Es la
   * operación con la que se sigue una validación que quedó reintentando: el
   * veredicto final aparece cuando `attributes.status` alcanza un estado
   * terminal.
   */
  getValidation(
    validationId: string,
    options: GetValidationOptions = {},
  ): Promise<ValidationWithEtag> {
    return this.validations.get(validationId, options);
  }

  /**
   * Atajo de `client.validations.cep()`.
   *
   * Descarga el CEP oficial de una validación. `GET /v1/validations/{id}/cep`.
   * Devuelve el archivo: el XML que emitió Banxico, con su sello digital y su
   * cadena original, o el PDF equivalente.
   */
  getCep(validationId: string, options: { format?: CepFormat } = {}): Promise<CepDocument> {
    return this.validations.cep(validationId, options);
  }
}
