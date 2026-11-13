/**
 * Check: `src/generated/openapi.ts` is up to date with `spec/openapi.yaml`.
 *
 * The file is generated but versioned: the package compiles without a network and
 * the diff of a spec change is read in review. This check regenerates into a
 * string and compares, so nobody edits it by hand or forgets to
 * regenerate it after the spec changes.
 */

import { readFileSync } from 'node:fs';

import { GENERATED as GENERATED_PATH, generate } from './generate-types.mjs';

const GENERATED = 'src/generated/openapi.ts';

const current = readFileSync(GENERATED_PATH, 'utf8').replace(/\r\n/g, '\n');
const expected = (await generate()).replace(/\r\n/g, '\n');

if (current !== expected) {
  console.error(`\n${GENERATED} is not up to date with spec/openapi.yaml.`);
  console.error('Regenerate with: npm run gen:types');
  process.exit(1);
}

console.log(`${GENERATED} is up to date with spec/openapi.yaml.`);
