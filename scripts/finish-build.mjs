/**
 * Cierra el build dual.
 *
 * `tsc` emite los dos árboles, pero Node decide si un `.js` es ESM o CommonJS
 * por el `type` del `package.json` más cercano. Sin estos dos archivos, el
 * árbol de `dist/cjs` se interpreta como ESM —el `package.json` raíz dice
 * `"type": "module"`— y `require('@veriko/sdk')` falla.
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
