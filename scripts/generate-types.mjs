/**
 * Generates `src/generated/openapi.ts` from `spec/openapi.yaml`.
 *
 * The spec carries each text in Spanish with its English version in `x-translations.en`.
 * The generated types are public, so this script swaps the English text in before
 * `openapi-typescript` runs: descriptions, summaries, titles and examples come from
 * `x-translations.en`, and the Spanish text stays only where a node has no English.
 *
 * It also leaves the field names from earlier versions out of the types: a property that
 * has a current name beside it is dropped, and a mention in a text becomes the current name.
 * The names come from `src/legacy-names.ts`, the module the SDK uses at runtime.
 *
 *     node scripts/generate-types.mjs [--out path]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { parse } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SPEC = join(ROOT, 'spec', 'openapi.yaml');
export const GENERATED = join(ROOT, 'src', 'generated', 'openapi.ts');

/** Loads `src/legacy-names.ts`, which has no imports, without building the package. */
async function loadLegacyNames() {
  const source = readFileSync(join(ROOT, 'src', 'legacy-names.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const url = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  return import(url);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces each text of a node by its English version, everywhere in the document. */
function useEnglish(node) {
  if (Array.isArray(node)) {
    node.forEach(useEnglish);
    return;
  }
  if (!isObject(node)) return;
  const english = node['x-translations']?.en;
  if (isObject(english)) {
    for (const [key, value] of Object.entries(english)) node[key] = structuredClone(value);
  }
  for (const value of Object.values(node)) useEnglish(value);
}

/** Drops each property that has its current name beside it, and the mentions in the texts. */
function dropLegacyNames(document, legacy) {
  const pairs = new Map(); // old name -> set of current names
  const first = new Map(); // old name -> the current name used in texts
  for (const map of [
    ...legacy.RESPONSE_ALIAS_MAPS,
    legacy.TRANSFER_PARAM_ALIASES,
    legacy.OCR_PARAM_ALIASES,
  ]) {
    for (const [oldName, current] of Object.entries(map)) {
      if (!pairs.has(oldName)) pairs.set(oldName, new Set());
      pairs.get(oldName).add(current);
      if (!first.has(oldName)) first.set(oldName, current);
    }
  }

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (typeof item === 'string') node[index] = first.get(item) ?? rewrite(item, first);
        else walk(item);
      });
      return;
    }
    if (!isObject(node)) return;
    if (isObject(node.properties)) {
      for (const [name, targets] of pairs) {
        if (!(name in node.properties)) continue;
        if (
          ![...targets].some((target) => target in node.properties) &&
          !isAlias(node.properties[name])
        )
          continue;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the name comes from the map
        delete node.properties[name];
        if (Array.isArray(node.required))
          node.required = node.required.filter((item) => item !== name);
        if (Array.isArray(node.required) && node.required.length === 0) delete node.required;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && key !== '$ref') node[key] = rewrite(value, first);
      else if (key === 'legacy_fields' && Array.isArray(value)) {
        node[key] = value.map((item) => first.get(item) ?? item);
      } else walk(value);
    }
  };
  walk(document);
}

function isAlias(property) {
  return isObject(property) && 'x-alias-of' in property;
}

/**
 * Texts the spec only has in Spanish, and that name a previous field or are a Spanish
 * sample. They are written in English here, so the generated types hold no name from
 * earlier versions.
 */
const TEXT_FIXES = [
  ['Banco emisor', 'Sender bank'],
  ['Banco receptor', 'Receiver bank'],
  [
    'No encontramos ningún beneficiario para esa cuenta.',
    'No beneficiary was found for that account.',
  ],
  [/\bfolio\b/g, 'statement number'],
];

/** A previous name in a text becomes the current one: in backticks, in a path or as a whole snake_case or camelCase word. */
function rewrite(text, first) {
  const current = (name) => first.get(name);
  let result = text.replace(/`([^`]+)`/g, (whole, inner) => {
    const replaced = inner.replace(/[A-Za-z_]+/g, (word) => current(word) ?? word);
    return `\`${replaced}\``;
  });
  result = result.replace(
    /(?<![A-Za-z0-9_-])[a-z]+(?:_[a-z]+|[A-Z][a-z]+)+(?![A-Za-z0-9_])/g,
    (word) => current(word) ?? word,
  );
  for (const [from, to] of TEXT_FIXES) result = result.replaceAll(from, to);
  return result;
}

const HEADER = `/**
 * This file was auto-generated by openapi-typescript.
 * Do not make direct changes to the file.
 */

`;

/** The generated source, as `openapi-typescript` writes it for the English spec. */
export async function generate() {
  const { default: openapiTS, astToString } = await import('openapi-typescript');
  const document = parse(readFileSync(SPEC, 'utf8'));
  useEnglish(document);
  dropLegacyNames(document, await loadLegacyNames());
  const ast = await openapiTS(document);
  return `${HEADER}${astToString(ast)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--out');
  const out = index === -1 ? GENERATED : resolve(process.argv[index + 1]);
  writeFileSync(out, await generate());
  console.log(`Wrote ${out}`);
}
