/**
 * Finishes the dual build.
 *
 * `tsc` emits both trees, but Node decides whether a `.js` is ESM or CommonJS
 * from the `type` of the nearest `package.json`. Without these two files, the
 * `dist/cjs` tree is read as ESM, because the root `package.json` says
 * `"type": "module"`, and `require('@veriko-mx/sdk')` fails.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const targets = [
  ['dist/esm', 'module'],
  ['dist/cjs', 'commonjs'],
];

for (const [dir, type] of targets) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }, null, 2) + '\n');
  console.log(`${dir}/package.json → type: ${type}`);
}
