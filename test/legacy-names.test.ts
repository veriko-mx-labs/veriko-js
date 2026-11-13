/**
 * Names from earlier versions: they keep working at runtime and stay out of everything public.
 *
 * The map lives in `src/aliases.ts`, which `index.ts` does not export. The first block checks
 * that none of its names appears in the declarations, the exports, the README, the CHANGELOG or
 * the examples; the second, that each one still works.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import * as sdk from '../src/index.js';
import {
  OCR_PARAM_ALIASES,
  TRANSFER_PARAM_ALIASES,
  legacyNames,
  resetDeprecationWarnings,
} from '../src/aliases.js';
import { PROJECT_ROOT, RecordingServer, makeClient } from './harness.js';

const NAMES = legacyNames();

/** The name as a whole word; `x-finance-folio` is a header name, not the old field. */
function mentions(text: string): string[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(${NAMES.join('|')})(?![A-Za-z0-9_])`, 'g');
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] ?? ''))];
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe('names from earlier versions stay out of the public surface', () => {
  let declarations: string;

  before(() => {
    declarations = mkdtempSync(join(tmpdir(), 'veriko-dts-'));
    const tsc = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        '-p',
        join(PROJECT_ROOT, 'tsconfig.build.json'),
        '--emitDeclarationOnly',
        '--declaration',
        '--declarationMap',
        'false',
        '--outDir',
        declarations,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  after(() => {
    rmSync(declarations, { recursive: true, force: true });
  });

  it('the map is not empty', () => {
    assert.ok(NAMES.length > 30);
    assert.ok(NAMES.includes('monto'));
  });

  it('no declaration of the package mentions them, and index does not reach the module', () => {
    const files = filesUnder(declarations).filter((file) => file.endsWith('.d.ts'));
    assert.ok(files.length > 5);
    for (const file of files) {
      // The module with the map is internal: only `index` and what it exports are public.
      if (file.endsWith('aliases.d.ts') || file.endsWith('legacy-names.d.ts')) continue;
      const hits = mentions(readFileSync(file, 'utf8'));
      assert.deepEqual(hits, [], `${file} mentions ${hits.join(', ')}`);
    }
    const index = readFileSync(join(declarations, 'index.d.ts'), 'utf8');
    assert.equal(index.includes('aliases'), false);
  });

  it('no exported symbol is named after one', () => {
    const exported = Object.keys(sdk);
    assert.deepEqual(
      exported.filter((name) => NAMES.includes(name)),
      [],
    );
    assert.equal('legacyNames' in sdk, false);
    assert.equal('resolveAliases' in sdk, false);
  });

  it('the README, the CHANGELOG and the examples do not mention them', () => {
    const files = [
      join(PROJECT_ROOT, 'README.md'),
      join(PROJECT_ROOT, 'CHANGELOG.md'),
      ...filesUnder(join(PROJECT_ROOT, 'examples')),
    ];
    for (const file of files) {
      const hits = mentions(readFileSync(file, 'utf8'));
      assert.deepEqual(hits, [], `${file} mentions ${hits.join(', ')}`);
    }
  });

  it('the source outside the map does not mention them either', () => {
    const files = filesUnder(join(PROJECT_ROOT, 'src')).filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('aliases.ts') &&
        !file.endsWith('legacy-names.ts') &&
        !file.includes('generated'),
    );
    for (const file of files) {
      const hits = mentions(readFileSync(file, 'utf8'));
      assert.deepEqual(hits, [], `${file} mentions ${hits.join(', ')}`);
    }
  });
});

describe('names from earlier versions still work at runtime', () => {
  let server: RecordingServer;
  let warnings: string[];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalEmit = process.emitWarning;

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    process.emitWarning = originalEmit;
    await server.close();
  });

  beforeEach(() => {
    server.reset();
    warnings = [];
    resetDeprecationWarnings();
    process.emitWarning = (message: string | Error) => {
      warnings.push(String(message));
    };
  });

  const SAMPLES: Record<string, unknown> = {
    sendDate: '2025-03-15',
    amount: 100,
    trackingKey: 'KEY',
    numericReference: '1234567',
    senderBank: 'BBVA',
    receiverBank: 'BANAMEX',
    beneficiaryAccount: '012180004412345678',
    candidateAccounts: ['012180004412345678', '002010077777777771'],
    recipientIsBank: true,
  };

  /** What the wire name of a current argument is. */
  const WIRE: Record<string, string> = {
    sendDate: 'send_date',
    amount: 'amount',
    trackingKey: 'tracking_key',
    numericReference: 'numeric_reference',
    senderBank: 'sender_bank',
    receiverBank: 'receiver_bank',
    beneficiaryAccount: 'beneficiary_account',
    candidateAccounts: 'candidate_accounts',
    recipientIsBank: 'recipient_is_bank',
  };

  /** The arguments every call needs, without the field under test. */
  function base(without: string[]): Record<string, unknown> {
    const params: Record<string, unknown> = { trackingKey: 'KEY', amount: 100 };
    if (!without.includes('beneficiaryAccount') && !without.includes('candidateAccounts')) {
      params['beneficiaryAccount'] = '012180004412345678';
    }
    for (const name of without) params[name] = undefined;
    return params;
  }

  for (const [oldName, current] of Object.entries(TRANSFER_PARAM_ALIASES)) {
    it(`${oldName} in validateTransfer is sent as ${WIRE[current] ?? current} and warns`, async () => {
      server.enqueue('validate-valid');
      const value = oldName === 'receptorParticipante' ? 1 : SAMPLES[current];
      const params = { ...base([current]), [oldName]: value };

      await makeClient(server, []).validateTransfer(params as never);

      const body = server.json(0);
      const wire = WIRE[current];
      assert.ok(wire);
      assert.deepEqual(body[wire], current === 'recipientIsBank' ? true : value);
      assert.equal(oldName in body, false);
      assert.ok(
        warnings.some((message) => message.includes(oldName)),
        `no warning for ${oldName}`,
      );
    });
  }

  for (const [oldName, current] of Object.entries(OCR_PARAM_ALIASES)) {
    it(`${oldName} in validateOcr is sent as ${WIRE[current] ?? current} and warns`, async () => {
      server.enqueue('validate-ocr');
      const value = oldName === 'receptorParticipante' ? 1 : SAMPLES[current];

      await makeClient(server, []).validations.validateOcr({
        image: Buffer.from('png'),
        [oldName]: value,
      });

      const wire = WIRE[current];
      assert.ok(wire);
      const body = server.json(0);
      assert.ok(wire in body, `${wire} was not sent`);
      assert.equal(oldName in body, false);
      assert.ok(warnings.some((message) => message.includes(oldName)));
    });
  }

  it('warns once per name', async () => {
    server.enqueue('validate-valid', 2);
    const client = makeClient(server, []);
    const params = { ...base(['amount']), monto: 100 };

    await client.validateTransfer(params as never);
    await client.validateTransfer(params as never);

    assert.equal(warnings.filter((message) => message.includes('monto')).length, 1);
  });

  it('a name from an earlier version together with the current one is rejected', async () => {
    const params = { ...base([]), monto: 100 };

    await assert.rejects(
      makeClient(server, []).validateTransfer(params as never),
      (error: unknown) =>
        error instanceof sdk.InvalidRequestError && error.code === 'alias_conflict',
    );
    assert.equal(server.requests.length, 0);
  });
});
