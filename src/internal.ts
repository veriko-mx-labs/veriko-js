/**
 * Ayudantes compartidos por el cliente y las familias de operaciones.
 *
 * Nada de aquí se reexporta desde `index.ts`.
 */

import { randomUUID } from 'node:crypto';

import { ApiError, ConfigurationError } from './errors.js';
import type { RawResponse } from './http.js';

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
export function newIdempotencyKey(): string {
  return `veriko-js-${randomUUID().replace(/-/g, '')}`;
}

/** Un identificador no puede venir vacío ni traer barras, signos de consulta o almohadillas. */
export function checkedId(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || /[/?#]/.test(cleaned)) {
    throw new ConfigurationError(`Identificador inservible: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

/** El identificador numérico de un recurso, que la API acepta como número o como cadena. */
export type EntityId = string | number;

/** Un identificador ya validado, listo para ir en la ruta. */
export function pathSegment(value: string): string {
  return encodeURIComponent(checkedId(value));
}

/** Los filtros de una consulta: lo que no se pasa no viaja. */
export type Query = Record<string, string | number | readonly string[] | undefined>;

/** Une una lista de valores con comas, que es como la API recibe varios estados. */
export function joinList(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.join(',');
}

function malformed(response: RawResponse, detail: string): ApiError {
  return new ApiError(detail, { status: response.status, headers: response.headers });
}

/** Lee el cuerpo de una respuesta JSON:API como un objeto. */
export function readDocument(response: RawResponse): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw malformed(response, 'La respuesta no es un documento JSON');
  }
  return parsed as Record<string, unknown>;
}

/**
 * El recurso `data` de una respuesta. `what` completa el mensaje si falta.
 *
 * El tipo lo fija quien llama: es el cast del JSON ya leído al tipo del spec.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function readData<T>(response: RawResponse, what: string): T {
  const data = readDocument(response)['data'];
  if (data === undefined || data === null) {
    throw malformed(response, `La respuesta no trae el recurso \`data\` ${what}`);
  }
  return data as T;
}

/** La lista `data` de una colección. */
export function readList<T>(response: RawResponse, what: string): T[] {
  const data = readDocument(response)['data'];
  if (!Array.isArray(data)) {
    throw malformed(response, `La respuesta no trae la lista \`data\` ${what}`);
  }
  return data as T[];
}

/** `meta` de una respuesta, o un objeto vacío cuando no viene. */
export function readMeta(document: Record<string, unknown>): Record<string, unknown> {
  const meta = document['meta'];
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}
