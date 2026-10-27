/**
 * Comprobación: `src/generated/openapi.ts` está al día con `spec/openapi.yaml`.
 *
 * El archivo se genera, pero se versiona: así el paquete se compila sin red y
 * el diff de un cambio del spec se lee en la revisión. Esta comprobación regenera en
 * un temporal y compara, de modo que nadie lo edite a mano ni se olvide de
 * regenerarlo tras cambiar el spec.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GENERATED = 'src/generated/openapi.ts';
// Se invoca el CLI con el propio Node en lugar de `npx`: en Windows, spawn de un
// `.cmd` sin shell falla con EINVAL desde Node 20.
const CLI = join('node_modules', 'openapi-typescript', 'bin', 'cli.js');
const temp = mkdtempSync(join(tmpdir(), 'veriko-types-'));
const candidato = join(temp, 'openapi.ts');

try {
  execFileSync(process.execPath, [CLI, 'spec/openapi.yaml', '-o', candidato], {
    stdio: 'inherit',
  });

  const actual = readFileSync(GENERATED, 'utf8').replace(/\r\n/g, '\n');
  const esperado = readFileSync(candidato, 'utf8').replace(/\r\n/g, '\n');

  if (actual !== esperado) {
    console.error(`\n${GENERATED} no está al día con spec/openapi.yaml.`);
    console.error('Regenera con: npm run gen:types');
    process.exit(1);
  }

  console.log(`${GENERATED} está al día con spec/openapi.yaml.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
