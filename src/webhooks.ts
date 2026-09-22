/**
 * Verificación de la firma de un webhook.
 *
 * Cada entrega llega firmada con HMAC-SHA256 del cuerpo, usando el secreto que
 * devolvió `POST /v1/webhooks` al registrar el endpoint. La firma viaja en
 * hexadecimal, prefijada por el algoritmo:
 *
 *     X-Webhook-Signature: sha256=<hex>
 *
 * Lo que se firma es el cuerpo tal como llegó. Interpretar el JSON y volver a
 * serializarlo cambia los bytes, porque el orden de las claves, los espacios y
 * el escape de los caracteres no ASCII no se conservan, y la firma deja de
 * cuadrar. En Express, eso significa `express.raw()` en la ruta del webhook.
 *
 * @see https://docs.veriko.mx/es/concepts/webhooks-architecture
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { SignatureVerificationError } from './errors.js';
import type { Validation, WebhookEvent } from './types.js';

/** Cabecera de la firma. */
export const SIGNATURE_HEADER = 'X-Webhook-Signature';

/** Otras cabeceras de una entrega. */
export const EVENT_HEADER = 'X-Veriko-Event';
export const DELIVERY_ID_HEADER = 'X-Veriko-Delivery-Id';
export const TIMESTAMP_HEADER = 'X-Veriko-Timestamp';

const SIGNATURE_PREFIX = 'sha256=';

/** `true` cuando `data` es el recurso JSON:API de una validación. */
function isValidationResource(data: unknown): data is Validation {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'validation';
}

type Payload = string | Uint8Array;

function toBuffer(payload: Payload): Buffer {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
}

/** Devuelve el HMAC-SHA256 hexadecimal del cuerpo, sin el prefijo `sha256=`. */
export function computeSignature(payload: Payload, secret: string): string {
  return createHmac('sha256', secret).update(toBuffer(payload)).digest('hex');
}

/**
 * Comprueba la firma de una entrega. Devuelve `true` o `false`, sin lanzar.
 *
 * Acepta el valor de la cabecera con o sin el prefijo `sha256=`. La comparación
 * es en tiempo constante, para no filtrar información por el tiempo de
 * respuesta.
 *
 * @param payload El cuerpo crudo de la petición, sin reserializar.
 * @param signature El valor de la cabecera `X-Webhook-Signature`.
 * @param secret El secreto del endpoint, entregado al registrarlo.
 */
export function verifyWebhook(
  payload: Payload,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  let received = signature.trim();
  if (received.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    received = received.slice(SIGNATURE_PREFIX.length);
  }
  const expected = computeSignature(payload, secret);
  const receivedBuffer = Buffer.from(received.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Busca la cabecera de firma en cualquiera de sus grafías.
 *
 * Los nombres de cabecera no distinguen mayúsculas, y cada framework los
 * entrega a su manera.
 */
export function signatureFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const wanted = SIGNATURE_HEADER.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Verifica la firma y devuelve el evento ya interpretado.
 *
 * @throws {SignatureVerificationError} Si la firma no cuadra con el cuerpo. En
 * ese caso el cuerpo no se interpreta.
 */
export function parseWebhook(
  payload: Payload,
  signature: string | null | undefined,
  secret: string,
): WebhookEvent {
  if (!verifyWebhook(payload, signature, secret)) {
    throw new SignatureVerificationError(
      'La firma de la entrega no cuadra con el cuerpo recibido. Revisa que el ' +
        'cuerpo sea el crudo, sin reserializar, y que el secreto sea el del ' +
        'endpoint que envía.',
    );
  }

  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new SignatureVerificationError('El cuerpo de la entrega no es un objeto JSON');
  }

  const document = parsed as Record<string, unknown>;
  const data = document['data'];
  const validation = isValidationResource(data) ? data : undefined;

  const event: WebhookEvent = {
    event: typeof document['event'] === 'string' ? document['event'] : '',
  };
  if (typeof document['timestamp'] === 'string') event.timestamp = document['timestamp'];
  if (validation) event.data = validation;
  if (document['meta'] && typeof document['meta'] === 'object') {
    event.meta = document['meta'] as Record<string, unknown>;
  }
  return event;
}
