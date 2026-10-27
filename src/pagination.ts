/**
 * Paginación: una página, y la forma de recorrerlas todas.
 *
 * Las colecciones de la API viajan con `meta.pagination`. El SDK devuelve una
 * `Page` con los elementos y los contadores. Para recorrer una colección entera
 * están los iteradores `iter*` de cada familia, que piden la página siguiente
 * sólo cuando la anterior se agota.
 *
 * @see https://docs.veriko.mx/es/concepts/pagination
 */

import { ApiError } from './errors.js';
import type { RawResponse } from './http.js';
import { readDocument, readMeta } from './internal.js';

/** Una página de resultados, con los contadores que devolvió la API. */
export interface Page<T> {
  items: T[];
  /** Número de esta página, empezando en 1. */
  page: number;
  perPage: number;
  /** Elementos que casan con la consulta, sumando todas las páginas. */
  total: number;
  totalPages: number;
  /** `true` cuando queda al menos una página por pedir. */
  hasNext: boolean;
}

/** Opciones de los iteradores. */
export interface IterOptions {
  /** Cuántas páginas recorrer como máximo. Sin él, se recorren todas. */
  maxPages?: number;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Convierte una respuesta de colección en una `Page`. */
export function parsePage<T>(response: RawResponse): Page<T> {
  const document = readDocument(response);
  const data = document['data'];
  if (!Array.isArray(data)) {
    throw new ApiError('La respuesta no trae la lista `data`', {
      status: response.status,
      headers: response.headers,
    });
  }
  const items = data as T[];
  const rawPagination = readMeta(document)['pagination'];
  const pagination =
    rawPagination && typeof rawPagination === 'object'
      ? (rawPagination as Record<string, unknown>)
      : {};

  const page = count(pagination['page'], 1);
  const totalPages = count(pagination['total_pages'], 1);
  return {
    items,
    page,
    perPage: count(pagination['per_page'], items.length),
    total: count(pagination['total'], items.length),
    totalPages,
    hasNext: page < totalPages,
  };
}

/**
 * Recorre las páginas una a una y va entregando sus elementos.
 *
 * Pide la siguiente sólo cuando la anterior se agotó, de modo que un consumidor
 * que corta a la mitad no gasta peticiones de más.
 */
export async function* iteratePages<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  options: { startPage?: number; maxPages?: number } = {},
): AsyncGenerator<T, void, undefined> {
  let current = options.startPage ?? 1;
  let pagesRead = 0;
  for (;;) {
    const page = await fetchPage(current);
    yield* page.items;
    pagesRead += 1;
    if (options.maxPages !== undefined && pagesRead >= options.maxPages) return;
    if (!page.hasNext || page.items.length === 0) return;
    current += 1;
  }
}
