/**
 * Corre las pruebas compiladas con el corredor de Node.
 *
 * Los archivos se enumeran aquí y se pasan uno a uno. Ni el glob (`--test
 * "dir/*.test.js"`) ni la ruta de directorio sirven en todas las versiones y
 * sistemas que este paquete soporta: el glob necesita Node 21 o superior, y el
 * directorio con separadores de Windows se interpreta como módulo.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const DIR = 'dist-test/test';

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `${DIR}/${name}`);

if (files.length === 0) {
  console.error(`No hay pruebas compiladas en ${DIR}. Corre primero: npm run pretest`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
