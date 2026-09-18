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

import type { components } from './generated/openapi.js';

type Schemas = components['schemas'];

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
 * `true` cuando hay comprobante que descargar.
 *
 * Se deriva de `links.cep_xml`, que es lo que publica el servidor. Un
 * `returned` nacido de `cep_unavailable` no lo trae.
 */
export function hasCep(validation: Validation): boolean {
  return Boolean(validation.links?.cep_xml);
}

/** Formatos en los que la API entrega el comprobante. */
export const CEP_FORMATS = ['xml', 'pdf'] as const;
export type CepFormat = (typeof CEP_FORMATS)[number];

/** El CEP de Banxico descargado: el archivo, no un enlace. */
export interface CepDocument {
  validationId: string;
  /** El contenido del archivo. */
  content: Uint8Array;
  contentType: string;
  format: CepFormat;
  /** Nombre de descarga que propone la API, con el formato `CEP-<id>.<ext>`. */
  filename: string;
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
