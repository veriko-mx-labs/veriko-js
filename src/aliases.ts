/**
 * English names and previous Spanish names.
 *
 * The API names its fields in English. The previous names, in Spanish, are still accepted
 * for one version as deprecated:
 *
 * - On input, `resolveAliases()` translates each previous name to the canonical one, warns
 *   once per name, and rejects the case where both arrive.
 * - On output, `fillValidation()` and its companions fill in the missing name: the English
 *   one when only the Spanish arrived, and the Spanish one, as a non-enumerable property,
 *   when only the English arrived. `JSON.stringify` and deep comparison see the English
 *   names, and older code keeps reading its own.
 *
 * Nothing here is re-exported from `index.ts`.
 */

import { InvalidRequestError } from './errors.js';
import {
  CONFIDENCE_BY_FIELD,
  COUNTERPARTY,
  DETECTED_ACCOUNT,
  FINANCE_SUMMARY,
  NORMALIZED_DATA,
  OCR_PARAM_ALIASES,
  OCR_RESULT,
  REQUEST_DATA,
  SUMMARY_ATTRIBUTES,
  TRANSFER_PARAM_ALIASES,
  legacyNames,
} from './legacy-names.js';

export { OCR_PARAM_ALIASES, TRANSFER_PARAM_ALIASES, legacyNames };

const warned = new Set<string>();

/** Forgets the warnings already issued. Only the tests use it. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}

/** Warns once per name, when the runtime allows it (Node and Bun). */
function warnDeprecated(oldName: string, newName: string): void {
  if (warned.has(oldName)) return;
  warned.add(oldName);
  if (typeof process === 'undefined' || typeof process.emitWarning !== 'function') return;
  process.emitWarning(
    `\`${oldName}\` is deprecated: use \`${newName}\`. It will be removed in a future version.`,
    'DeprecationWarning',
  );
}

/**
 * Returns a copy of `params` with each previous name translated to the canonical one.
 *
 * If both names of the same field arrive, it throws `InvalidRequestError` with the code
 * `alias_conflict`, as the API does, and nothing is sent.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function resolveAliases<Canonical>(
  params: object,
  aliases: Readonly<Record<string, string>>,
): Canonical {
  const source = params as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!(name in aliases) || value === undefined) result[name] = value;
  }
  for (const [oldName, newName] of Object.entries(aliases)) {
    if (source[oldName] === undefined) continue;
    if (source[newName] !== undefined) {
      throw new InvalidRequestError(`Send ${newName} or ${oldName}, not both`, {
        status: 422,
        code: 'alias_conflict',
        local: true,
      });
    }
    warnDeprecated(oldName, newName);
    result[newName] = source[oldName];
  }
  return result as Canonical;
}

/** `1` and `0` mean `true` and `false`: the API receives a boolean. */
export function toBoolean(value: boolean | 0 | 1 | undefined): boolean | undefined {
  return value === undefined ? undefined : Boolean(value);
}

// Output

type Json = Record<string, unknown>;
type AliasMap = Readonly<Record<string, string>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fills in, on a response object, the missing name of each pair: the canonical one
 * (enumerable) from the previous one, and the previous one (non-enumerable) from the
 * canonical one.
 */
export function fillAliases(target: unknown, aliases: AliasMap): void {
  if (!isObject(target)) return;
  for (const [oldName, newName] of Object.entries(aliases)) {
    const hasOld = target[oldName] !== undefined;
    const hasNew = target[newName] !== undefined;
    if (hasOld && !hasNew) {
      target[newName] = target[oldName];
    } else if (hasNew && !hasOld) {
      Object.defineProperty(target, oldName, {
        value: target[newName],
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

function eachItem(value: unknown, apply: (item: unknown) => void): void {
  if (Array.isArray(value)) value.forEach(apply);
}

/** Fills the Spanish/English pairs of a validation: the `data` of a response or of a webhook. */
export function fillValidation<T>(validation: T): T {
  if (!isObject(validation)) return validation;
  const attributes = validation['attributes'];
  if (!isObject(attributes)) return validation;

  fillAliases(attributes['request_data'], REQUEST_DATA);
  fillAliases(attributes['normalized_data'], NORMALIZED_DATA);

  const ocr = attributes['ocr_result'];
  fillAliases(ocr, OCR_RESULT);
  if (isObject(ocr)) {
    fillAliases(ocr['confidence_by_field'], CONFIDENCE_BY_FIELD);
    eachItem(ocr['other_accounts_detected'], (item) => {
      fillAliases(item, DETECTED_ACCOUNT);
    });
  }
  return validation;
}

/** Fills the pairs of a validation in a list. */
export function fillValidationSummary<T>(summary: T): T {
  if (isObject(summary)) fillAliases(summary['attributes'], SUMMARY_ATTRIBUTES);
  return summary;
}

/** Fills the pairs of the dashboard summary: the recent validations. */
export function fillDashboardSummary<T>(summary: T): T {
  if (!isObject(summary)) return summary;
  const relationships = summary['relationships'];
  const recent = isObject(relationships) ? relationships['recent_validations'] : undefined;
  if (isObject(recent)) {
    eachItem(recent['data'], (item) => {
      fillValidationSummary(item);
    });
  }
  return summary;
}

/** Fills the pairs of the financial summary. */
export function fillFinanceSummary<T>(summary: T): T {
  if (!isObject(summary)) return summary;
  const attributes = summary['attributes'];
  if (!isObject(attributes)) return summary;
  fillAliases(attributes, FINANCE_SUMMARY);
  eachItem(attributes['top_counterparties'], (item) => {
    fillAliases(item, COUNTERPARTY);
  });
  return summary;
}
