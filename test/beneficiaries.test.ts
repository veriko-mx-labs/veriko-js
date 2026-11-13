/** The `client.beneficiaries` family: the allowlist and its bulk import. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ConfigurationError,
  InvalidRequestError,
  TimeoutError,
  Veriko,
  isImportSettled,
  isImportTerminal,
  type BeneficiaryImportJob,
} from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const IMPORT_ID = 42;

describe('client.beneficiaries', () => {
  let server: RecordingServer;
  let client: Veriko;

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
    client = makeClient(server, []);
  });

  /** The query of request `index`, already parsed. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  /** The bytes of a wait that does not sleep, and how long it waited. */
  const pauses = (): { sleep: (ms: number) => Promise<void>; waited: number[] } => {
    const waited: number[] = [];
    return {
      waited,
      sleep: (ms: number) => {
        waited.push(ms);
        return Promise.resolve();
      },
    };
  };

  describe('the allowlist', () => {
    it('register a beneficiary', async () => {
      server.enqueue('beneficiary-created');

      const beneficiary = await client.beneficiaries.create({
        accountNumber: '012180004412345678',
        label: 'Supplier ABC',
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/beneficiaries');
      assert.deepEqual(server.json(0), {
        account_number: '012180004412345678',
        label: 'Supplier ABC',
      });
      assert.equal(beneficiary.id, '50');
      assert.equal(beneficiary.attributes.account_type, 'clabe');
      assert.equal(beneficiary.attributes.bank_name, 'BBVA MEXICO');
      assert.equal(beneficiary.reactivated, false);
    });

    it('registering an archived account reactivates it', async () => {
      server.enqueue('beneficiary-reactivated');

      const beneficiary = await client.beneficiaries.create({
        accountNumber: '012180004412345678',
      });

      assert.equal(beneficiary.reactivated, true);
      assert.equal(beneficiary.id, '42');
      assert.equal(beneficiary.attributes.status, 'active');
    });

    it('the bank of a phone travels as bank_code', async () => {
      server.enqueue('beneficiary-created');

      await client.beneficiaries.create({ accountNumber: '5512345678', bankCode: '40012' });

      assert.deepEqual(server.json(0), { account_number: '5512345678', bank_code: '40012' });
    });

    it('registering without an account does not reach the API', async () => {
      await assert.rejects(
        () => client.beneficiaries.create({ accountNumber: '' }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'account_number_required');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('listing returns the full list, without paginating', async () => {
      server.enqueue('beneficiaries-list');

      const beneficiaries = await client.beneficiaries.list();

      assert.equal(server.request(0).url, '/v1/beneficiaries');
      assert.equal(beneficiaries.length, 2);
      assert.equal(beneficiaries[0]?.attributes.status, 'active');
    });

    it('withArchived travels as one or zero', async () => {
      server.enqueue('beneficiaries-list', 2);

      await client.beneficiaries.list({ withArchived: true });
      await client.beneficiaries.list({ withArchived: false });

      assert.equal(query(0).get('with_archived'), '1');
      assert.equal(query(1).get('with_archived'), '0');
    });

    it('change the label, the account or the bank', async () => {
      server.enqueue('beneficiary-updated');

      const beneficiary = await client.beneficiaries.update(51, { label: 'Cuenta DiMo HSBC' });

      const sent = server.request(0);
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.url, '/v1/beneficiaries/51');
      assert.deepEqual(server.json(0), { label: 'Cuenta DiMo HSBC' });
      assert.equal(beneficiary.attributes.bank_name, 'HSBC');
    });

    it('an empty change does not reach the API', async () => {
      await assert.rejects(
        () => client.beneficiaries.update(51, {}),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'no_valid_fields');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('archive a beneficiary', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.delete(51);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/51');
    });

    it('resolve an account of the own list', async () => {
      server.enqueue('beneficiary-lookup');

      const found = await client.beneficiaries.lookup('012180004412345678');

      assert.equal(query(0).get('account'), '012180004412345678');
      assert.equal(found.attributes.label, 'Supplier ABC');
    });

    it('validate the structure of an account', async () => {
      server.enqueue('beneficiary-validate-account');

      const result = await client.beneficiaries.validateAccount({
        account: '01218000441234567',
        type: 'clabe',
      });

      assert.equal(server.request(0).method, 'GET');
      assert.equal(
        new URL(server.request(0).url, 'http://x').pathname,
        '/v1/beneficiaries/validate-account',
      );
      assert.equal(query(0).get('account'), '01218000441234567');
      assert.equal(query(0).get('type'), 'clabe');
      assert.equal(result.attributes.account_type, 'clabe');
      assert.equal(result.attributes.checksum_valid, true);
      assert.equal(result.attributes.auto_completed, '012180004412345678');
      assert.equal(result.attributes.bank?.name, 'BBVA MEXICO');
    });

    it('validating an account without a type does not send type', async () => {
      server.enqueue('beneficiary-validate-account');

      await client.beneficiaries.validateAccount({ account: '01218000441234567' });

      assert.equal(query(0).has('type'), false);
    });

    it('export the list as CSV', async () => {
      server.enqueue('beneficiaries-export-csv');

      const file = await client.beneficiaries.export({ withArchived: false, limit: 10 });

      assert.equal(query(0).get('format'), 'csv');
      assert.equal(query(0).get('with_archived'), '0');
      assert.equal(query(0).get('limit'), '10');
      assert.equal(file.filename, 'cuentas-2026-05-16.csv');
      assert.equal(Buffer.from(file.content).toString('utf8').startsWith('Alias,Cuenta'), true);
    });

    it('an export format outside the list does not reach the API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` is not an export format
        () => client.beneficiaries.export({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('the bulk import', () => {
    it('download the template', async () => {
      server.enqueue('beneficiaries-import-template');

      const file = await client.beneficiaries.importTemplate();

      assert.equal(query(0).get('format'), 'csv');
      assert.equal(file.filename, 'beneficiarios_plantilla.csv');
      assert.equal(Buffer.from(file.content).toString('utf8').startsWith('Alias,Cuenta'), true);
    });

    it('a template format outside the list does not reach the API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` is not a template format
        () => client.beneficiaries.importTemplate({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('uploading a file sends it as multipart', async () => {
      server.enqueue('beneficiaries-import-created');

      const started = await client.beneficiaries.importStart(
        Buffer.from('Alias,Account\nSupplier X,012180004412345678\n'),
        { parseMode: 'free', filename: 'list.csv' },
      );

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/beneficiaries/imports');
      assert.match(sent.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/);
      const body = sent.body.toString('utf8');
      assert.match(body, /name="parse_mode"\r\n\r\nfree/);
      assert.match(body, /name="file"; filename="list\.csv"/);
      assert.match(body, /Content-Type: text\/csv/i);
      assert.match(body, /Supplier X,012180004412345678/);
      assert.equal(started.id, '42');
      assert.equal(started.attributes.status, 'pending');
    });

    it('the read mode is template by default, and the name is beneficiaries.csv', async () => {
      server.enqueue('beneficiaries-import-created');

      await client.beneficiaries.importStart(Buffer.from('Alias,Account\n'));

      const body = server.request(0).body.toString('utf8');
      assert.match(body, /name="parse_mode"\r\n\r\ntemplate/);
      assert.match(body, /filename="beneficiaries\.csv"/);
    });

    it('reads the file of a path and takes its type from the extension', async () => {
      server.enqueue('beneficiaries-import-created');
      const directory = mkdtempSync(join(tmpdir(), 'veriko-import-'));
      try {
        const file = join(directory, 'list.xlsx');
        writeFileSync(file, 'content');

        await client.beneficiaries.importStart(file);

        const body = server.request(0).body.toString('utf8');
        assert.match(body, /filename="list\.xlsx"/);
        assert.match(body, /spreadsheetml\.sheet/);
        assert.match(body, /content/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('a path that does not exist stops before the API', async () => {
      await assert.rejects(
        () => client.beneficiaries.importStart('this-file-does-not-exist.csv'),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('read the state of a job, with the identifier as a number', async () => {
      server.enqueue('beneficiaries-import-status');

      const job = await client.beneficiaries.importStatus(IMPORT_ID);

      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42');
      assert.equal(job.attributes?.status, 'preview_ready');
      assert.equal(job.attributes.total_rows, 150);
      assert.equal(job.attributes.valid_count, 120);
    });

    it('an unusable identifier does not reach the API', async () => {
      await assert.rejects(
        () => client.beneficiaries.importStatus('42/commit'),
        ConfigurationError,
      );
      await assert.rejects(() => client.beneficiaries.importCancel('  '), ConfigurationError);

      assert.equal(server.requests.length, 0);
    });

    it('the preview carries the rows and the counters of the page', async () => {
      server.enqueue('beneficiaries-import-preview');

      const page = await client.beneficiaries.importPreview(IMPORT_ID, {
        page: 1,
        perPage: 25,
        buckets: ['valid', 'correctable'],
      });

      assert.equal(server.request(0).url.startsWith('/v1/beneficiaries/imports/42/preview?'), true);
      // A filter with several values travels repeated.
      assert.deepEqual(query(0).getAll('buckets[]'), ['valid', 'correctable']);
      assert.equal(query(0).get('per_page'), '25');
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 150);
      assert.equal(page.totalPages, 6);
      assert.equal(page.hasNext, true);
      assert.equal(page.items[0]?.attributes?.parsed_account_type, 'clabe');
    });

    it('walking the preview requests the next page on its own', async () => {
      server.enqueue('beneficiaries-import-preview', 2);

      const seen: string[] = [];
      for await (const row of client.beneficiaries.iterImportPreview(IMPORT_ID, {
        maxPages: 2,
      })) {
        seen.push(String(row.id));
      }

      assert.equal(seen.length, 4);
      assert.equal(server.requests.length, 2);
      assert.equal(query(1).get('page'), '2');
    });

    it('correct a row', async () => {
      server.enqueue('beneficiaries-import-row-updated');

      const row = await client.beneficiaries.importEditRow(IMPORT_ID, 102, {
        parsedAccountType: 'phone',
        parsedBankCode: '40012',
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'PATCH');
      assert.equal(sent.url, '/v1/beneficiaries/imports/42/rows/102');
      assert.deepEqual(server.json(0), { parsed_account_type: 'phone', parsed_bank_code: '40012' });
      assert.equal(row.attributes?.parsed_account, '5512345678');
    });

    it('correcting with no field does not reach the API', async () => {
      await assert.rejects(
        () => client.beneficiaries.importEditRow(IMPORT_ID, 102, {}),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'no_valid_fields');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('remove a row from the preview', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.importRemoveRow(IMPORT_ID, 102);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42/rows/102');
    });

    it('cancel an unconfirmed import', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.importCancel(IMPORT_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42');
    });

    it('confirming the import leaves the job in committing', async () => {
      server.enqueue('beneficiaries-import-committed');

      const committed = await client.beneficiaries.importCommit(IMPORT_ID);

      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42/commit');
      assert.equal(committed.attributes.status, 'committing');
    });
  });

  describe('importWait', () => {
    it('waits for the preview to be ready', async () => {
      server.enqueue('beneficiaries-import-parsing');
      server.enqueue('beneficiaries-import-status');
      const { sleep, waited } = pauses();

      const job = await client.beneficiaries.importWait(IMPORT_ID, { pollIntervalMs: 500, sleep });

      assert.equal(job.attributes?.status, 'preview_ready');
      assert.deepEqual(waited, [500]);
      assert.equal(server.requests.length, 2);
    });

    it('a job that is already ready is returned without waiting', async () => {
      server.enqueue('beneficiaries-import-status');
      const { sleep, waited } = pauses();

      await client.beneficiaries.importWait(IMPORT_ID, { sleep });

      assert.deepEqual(waited, []);
      assert.equal(server.requests.length, 1);
    });

    it('gives up when the time runs out', async () => {
      server.enqueue('beneficiaries-import-parsing', 2);

      await assert.rejects(
        () => client.beneficiaries.importWait(IMPORT_ID, { timeoutMs: 0, sleep: pauses().sleep }),
        (error: unknown) => {
          assert.ok(error instanceof TimeoutError);
          assert.equal(error.resourceId, '42');
          assert.equal(error.timeoutMs, 0);
          return true;
        },
      );
    });
  });

  describe('isImportSettled', () => {
    const job = (status: string): BeneficiaryImportJob =>
      ({ id: '42', type: 'beneficiary_import', attributes: { status } }) as BeneficiaryImportJob;

    const cases: [string, boolean][] = [
      ['pending', false],
      ['parsing', false],
      ['preview_ready', true],
      ['committing', false],
      ['completed', true],
      ['failed', true],
      ['cancelled', true],
    ];

    for (const [status, expected] of cases) {
      it(status, () => {
        assert.equal(isImportSettled(job(status)), expected);
      });
    }

    it('preview_ready is not terminal: the job keeps waiting for the review', () => {
      assert.equal(isImportTerminal('preview_ready'), false);
      assert.equal(isImportTerminal('completed'), true);
    });
  });
});
