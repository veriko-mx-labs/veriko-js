/**
 * Pagination: one page, and the way to walk all of them.
 *
 * Collections of the API travel with `meta.pagination`. The SDK returns a `Page`
 * with the items and the counters. To walk a whole collection, every family has
 * `iter*` iterators that request the next page only when the previous one runs out.
 *
 * `perPage` is clamped to the maximum of the operation, not rejected: 50 for
 * validations, 100 for deliveries and import previews. `Page.perPage` reports the
 * value the API applied.
 *
 * @see https://docs.veriko.mx/en/concepts/pagination
 */

import { ApiError } from './errors.js';
import type { RawResponse } from './http.js';
import { readDocument, readMeta } from './internal.js';

/** One page of results, with the counters the API returned. */
export interface Page<T> {
  items: T[];
  /** Number of this page, starting at 1. */
  page: number;
  /** Page size the API applied. */
  perPage: number;
  /** Items that match the query, across all pages. */
  total: number;
  totalPages: number;
  /** `true` when at least one page is left to request. */
  hasNext: boolean;
  /** The `meta` object of the response, `pagination` included. */
  meta: Record<string, unknown>;
}

/** Options of the iterators. */
export interface IterOptions {
  /** How many pages to walk at most. Without it, all of them. */
  maxPages?: number;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Turns a collection response into a `Page`. */
export function parsePage<T>(response: RawResponse): Page<T> {
  const document = readDocument(response);
  const data = document['data'];
  if (!Array.isArray(data)) {
    throw new ApiError('The response has no `data` list', {
      status: response.status,
      headers: response.headers,
    });
  }
  const items = data as T[];
  const meta = readMeta(document);
  const rawPagination = meta['pagination'];
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
    meta,
  };
}

/**
 * Walks the pages one by one and yields their items.
 *
 * It requests the next one only when the previous one ran out, so a consumer that
 * stops halfway does not spend extra requests.
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
