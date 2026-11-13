/**
 * `spec/openapi.yaml` is the copy of the spec at https://docs.veriko.mx/openapi.yaml, and the
 * generated types come from it.
 *
 * This check fails if the copy does not meet the contract of that API.
 */

import { readFileSync } from 'node:fs';

const SPEC = 'spec/openapi.yaml';
const GENERATED = 'src/generated/openapi.ts';

const failures = [];

const spec = readFileSync(SPEC, 'utf8');
const routes = spec.split('\n').filter((line) => /^ {2}\/[a-z]/i.test(line));
const adminRoutes = routes.filter((line) => line.trimStart().startsWith('/admin'));

if (adminRoutes.length > 0) {
  failures.push(
    `${SPEC} carries ${adminRoutes.length} /admin route(s). It is the internal bundle.`,
  );
}
if (routes.length === 0) {
  failures.push(`${SPEC} declares no route.`);
}

for (const marker of ['x-visibility', 'x-permission', 'x-admin-notes', 'x-auth', 'x-integration']) {
  if (spec.includes(`${marker}:`)) {
    failures.push(
      `${SPEC} keeps the internal extension \`${marker}\`. It is the unsanitized bundle.`,
    );
  }
}

if (/\bCookieAuth\b/.test(spec)) {
  failures.push(`${SPEC} keeps CookieAuth. The public M2M contract declares only ApiKeyAuth.`);
}

const generated = readFileSync(GENERATED, 'utf8');
if (/^ +"\/admin/m.test(generated)) {
  failures.push(`${GENERATED} declares /admin routes. Regenerate from the public spec.`);
}
if (/\bCookieAuth\b/.test(generated)) {
  failures.push(`${GENERATED} keeps CookieAuth types. Regenerate from the public spec.`);
}

if (failures.length > 0) {
  console.error('The spec in this repository is not the public one:\n');
  for (const failure of failures) console.error(`  · ${failure}`);
  console.error('\nCorrect source: https://docs.veriko.mx/openapi.yaml');
  process.exit(1);
}

console.log(`${SPEC}: ${routes.length} public routes, 0 /admin routes.`);
