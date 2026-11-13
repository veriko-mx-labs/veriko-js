/**
 * Runs the compiled tests with the Node test runner.
 *
 * The files are listed here and passed one by one. Neither the glob (`--test
 * "dir/*.test.js"`) nor the directory path works on every version and system
 * this package supports: the glob needs Node 21 or later, and a directory with
 * Windows separators is read as a module.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const DIR = 'dist-test/test';

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `${DIR}/${name}`);

if (files.length === 0) {
  console.error(`There are no compiled tests in ${DIR}. Run first: npm run pretest`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
