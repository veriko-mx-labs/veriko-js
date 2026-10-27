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
 * Cada entrega lleva además una segunda firma que incluye la hora del intento:
 *
 *     X-Webhook-Signature-Timestamped: t=<segundos>,v1=<hex>
 *
 * `v1` es el HMAC-SHA256 de `<t>.<cuerpo>`. Con ella el receptor puede descartar
 * una entrega vieja que alguien vuelva a enviar.
 *
 * @see https://docs.veriko.mx/es/concepts/webhooks-architecture
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { SignatureVerificationError } from './errors.js';
import type { WebhookEvent, WebhookValidation } from './types.js';

/** Cabecera de la firma. */
export const SIGNATURE_HEADER = 'X-Webhook-Signature';

/** Cabecera de la firma que incluye la hora del intento. */
export const TIMESTAMPED_SIGNATURE_HEADER = 'X-Webhook-Signature-Timestamped';

/** Ventana recomendada entre `t` y el reloj del receptor, en segundos. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Otras cabeceras de una entrega. */
export const EVENT_HEADER = 'X-Veriko-Event';
export const DELIVERY_ID_HEADER = 'X-Veriko-Delivery-Id';
export const TIMESTAMP_HEADER = 'X-Veriko-Timestamp';

const SIGNATURE_PREFIX = 'sha256=';

/** `true` cuando `data` es el recurso JSON:API de una validación. */
function isValidationResource(data: unknown): data is WebhookValidation {
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

/** Las opciones de `verifyWebhookTimestamped()`. */
export interface VerifyTimestampedOptions {
  /** La ventana entre `t` y el reloj del receptor, en segundos. Por omisión, 300 (5 minutos). */
  toleranceSeconds?: number;
  /** La hora actual. Por omisión, la del reloj del sistema; se pasa en las pruebas. */
  now?: Date;
}

const UNIX_SECONDS = /^[0-9]{1,15}$/;

/**
 * Separa `t=<segundos>,v1=<hex>` en la hora y las firmas `v1`.
 *
 * Admite varias `v1` y descarta las claves que no conoce. Devuelve `undefined`
 * cuando falta `t`, cuando trae más de una, o cuando no es un entero de segundos.
 */
function parseTimestamped(header: string): { timestamp: string; digests: string[] } | undefined {
  const times: string[] = [];
  const digests: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') times.push(value);
    else if (key === 'v1') digests.push(value.toLowerCase());
  }
  const timestamp = times[0];
  if (times.length !== 1 || timestamp === undefined || !UNIX_SECONDS.test(timestamp)) {
    return undefined;
  }
  return { timestamp, digests };
}

/**
 * Comprueba la firma con marca de tiempo de una entrega. Devuelve `true` o
 * `false`, sin lanzar.
 *
 * Acepta el valor de la cabecera `X-Webhook-Signature-Timestamped`:
 * `t=<segundos>,v1=<hex>`. Calcula el HMAC-SHA256 de `<t>.<cuerpo>`, lo compara
 * en tiempo constante con cada `v1` y rechaza la entrega cuando `t` se aleja del
 * reloj del receptor más de `toleranceSeconds`.
 *
 * La ventana se mide contra `t`, la hora de ese intento, y no contra el campo
 * `timestamp` del cuerpo, que es la hora del evento. Un reintento llega hasta
 * unas 8,6 horas después del evento, pero con una `t` nueva.
 *
 * @param payload El cuerpo crudo de la petición, sin reserializar.
 * @param header El valor de la cabecera `X-Webhook-Signature-Timestamped`.
 * @param secret El secreto del endpoint, entregado al registrarlo.
 * @param options La ventana y la hora actual.
 */
export function verifyWebhookTimestamped(
  payload: Payload,
  header: string | null | undefined,
  secret: string,
  options: VerifyTimestampedOptions = {},
): boolean {
  if (!header || !secret) return false;
  const parsed = parseTimestamped(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (!(Math.abs(nowSeconds - Number(parsed.timestamp)) <= tolerance)) return false;

  const signed = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), toBuffer(payload)]);
  const expected = Buffer.from(createHmac('sha256', secret).update(signed).digest('hex'), 'utf8');
  // Se comparan todas, sin cortar en la primera que cuadra.
  let matched = false;
  for (const digest of parsed.digests) {
    const received = Buffer.from(digest, 'utf8');
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      matched = true;
    }
  }
  return matched;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** El valor de una cabecera, sin distinguir mayúsculas. */
function headerValue(headers: HeaderBag, header: string): string | undefined {
  const wanted = header.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Busca la cabecera de firma en cualquiera de sus grafías.
 *
 * Los nombres de cabecera no distinguen mayúsculas, y cada framework los
 * entrega a su manera.
 */
export function signatureFromHeaders(headers: HeaderBag): string | undefined {
  return headerValue(headers, SIGNATURE_HEADER);
}

/** Busca la cabecera de la firma con marca de tiempo en cualquiera de sus grafías. */
export function timestampedSignatureFromHeaders(headers: HeaderBag): string | undefined {
  return headerValue(headers, TIMESTAMPED_SIGNATURE_HEADER);
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
