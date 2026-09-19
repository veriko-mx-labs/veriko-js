/** La familia `client.beneficiaries`: la lista blanca y su importación masiva. */

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

  /** La consulta de la petición `index`, ya interpretada. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  /** Los bytes de una espera que no duerme, y lo que esperó. */
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

  describe('la lista blanca', () => {
    it('registrar un beneficiario', async () => {
      server.enqueue('beneficiary-created');

      const beneficiary = await client.beneficiaries.create({
        accountNumber: '012180004412345678',
        label: 'Proveedor ABC',
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/beneficiaries');
      assert.deepEqual(server.json(0), {
        account_number: '012180004412345678',
        label: 'Proveedor ABC',
      });
      assert.equal(beneficiary.id, '50');
      assert.equal(beneficiary.attributes.account_type, 'clabe');
      assert.equal(beneficiary.attributes.bank_name, 'BBVA MEXICO');
    });

    it('el banco de un celular viaja como bank_code', async () => {
      server.enqueue('beneficiary-created');

      await client.beneficiaries.create({ accountNumber: '5512345678', bankCode: '40012' });

      assert.deepEqual(server.json(0), { account_number: '5512345678', bank_code: '40012' });
    });

    it('registrar sin cuenta no llega a la API', async () => {
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

    it('listar trae la lista completa, sin paginar', async () => {
      server.enqueue('beneficiaries-list');

      const beneficiaries = await client.beneficiaries.list();

      assert.equal(server.request(0).url, '/v1/beneficiaries');
      assert.equal(beneficiaries.length, 2);
      assert.equal(beneficiaries[0]?.attributes.status, 'active');
    });

    it('withArchived viaja como uno o cero', async () => {
      server.enqueue('beneficiaries-list', 2);

      await client.beneficiaries.list({ withArchived: true });
      await client.beneficiaries.list({ withArchived: false });

      assert.equal(query(0).get('with_archived'), '1');
      assert.equal(query(1).get('with_archived'), '0');
    });

    it('cambiar la etiqueta, la cuenta o el banco', async () => {
      server.enqueue('beneficiary-updated');

      const beneficiary = await client.beneficiaries.update(51, { label: 'Cuenta DiMo HSBC' });

      const sent = server.request(0);
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.url, '/v1/beneficiaries/51');
      assert.deepEqual(server.json(0), { label: 'Cuenta DiMo HSBC' });
      assert.equal(beneficiary.attributes.bank_name, 'HSBC');
    });

    it('un cambio vacío no llega a la API', async () => {
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

    it('archivar un beneficiario', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.delete(51);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/51');
    });

    it('resolver una cuenta de la lista propia', async () => {
      server.enqueue('beneficiary-lookup');

      const found = await client.beneficiaries.lookup('012180004412345678');

      assert.equal(query(0).get('account'), '012180004412345678');
      assert.equal(found.attributes.label, 'Proveedor ABC');
    });

    it('exportar la lista en CSV', async () => {
      server.enqueue('beneficiaries-export-csv');

      const file = await client.beneficiaries.export({ withArchived: false, limit: 10 });

      assert.equal(query(0).get('format'), 'csv');
      assert.equal(query(0).get('with_archived'), '0');
      assert.equal(query(0).get('limit'), '10');
      assert.equal(file.filename, 'cuentas-2026-05-16.csv');
      assert.equal(Buffer.from(file.content).toString('utf8').startsWith('Alias,Cuenta'), true);
    });

    it('un formato de exportación fuera de la lista no llega a la API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` no es un formato de exportación
        () => client.beneficiaries.export({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('la importación masiva', () => {
    it('descargar la plantilla', async () => {
      server.enqueue('beneficiaries-import-template');

      const file = await client.beneficiaries.importTemplate();

      assert.equal(query(0).get('format'), 'csv');
      assert.equal(file.filename, 'beneficiarios_plantilla.csv');
      assert.equal(Buffer.from(file.content).toString('utf8').startsWith('Alias,Cuenta'), true);
    });

    it('un formato de plantilla fuera de la lista no llega a la API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` no es un formato de plantilla
        () => client.beneficiaries.importTemplate({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('subir un archivo lo manda como multipart', async () => {
      server.enqueue('beneficiaries-import-created');

      const started = await client.beneficiaries.importStart(
        Buffer.from('Alias,Cuenta\nProveedor X,012180004412345678\n'),
        { parseMode: 'free', filename: 'lista.csv' },
      );

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/beneficiaries/imports');
      assert.match(sent.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/);
      const body = sent.body.toString('utf8');
      assert.match(body, /name="parse_mode"\r\n\r\nfree/);
      assert.match(body, /name="file"; filename="lista\.csv"/);
      assert.match(body, /Content-Type: text\/csv/i);
      assert.match(body, /Proveedor X,012180004412345678/);
      assert.equal(started.id, '42');
      assert.equal(started.attributes.status, 'pending');
    });

    it('el modo de lectura es template por omisión, y el nombre, beneficiarios.csv', async () => {
      server.enqueue('beneficiaries-import-created');

      await client.beneficiaries.importStart(Buffer.from('Alias,Cuenta\n'));

      const body = server.request(0).body.toString('utf8');
      assert.match(body, /name="parse_mode"\r\n\r\ntemplate/);
      assert.match(body, /filename="beneficiarios\.csv"/);
    });

    it('lee el archivo de una ruta y toma su tipo de la extensión', async () => {
      server.enqueue('beneficiaries-import-created');
      const directory = mkdtempSync(join(tmpdir(), 'veriko-import-'));
      try {
        const file = join(directory, 'lista.xlsx');
        writeFileSync(file, 'contenido');

        await client.beneficiaries.importStart(file);

        const body = server.request(0).body.toString('utf8');
        assert.match(body, /filename="lista\.xlsx"/);
        assert.match(body, /spreadsheetml\.sheet/);
        assert.match(body, /contenido/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('una ruta que no existe se detiene antes de la API', async () => {
      await assert.rejects(
        () => client.beneficiaries.importStart('no-existe-este-archivo.csv'),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('leer el estado de un trabajo, con el identificador como número', async () => {
      server.enqueue('beneficiaries-import-status');

      const job = await client.beneficiaries.importStatus(IMPORT_ID);

      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42');
      assert.equal(job.attributes?.status, 'preview_ready');
      assert.equal(job.attributes.total_rows, 150);
      assert.equal(job.attributes.valid_count, 120);
    });

    it('un identificador inservible no llega a la API', async () => {
      await assert.rejects(
        () => client.beneficiaries.importStatus('42/commit'),
        ConfigurationError,
      );
      await assert.rejects(() => client.beneficiaries.importCancel('  '), ConfigurationError);

      assert.equal(server.requests.length, 0);
    });

    it('la vista previa trae las filas y los contadores de la página', async () => {
      server.enqueue('beneficiaries-import-preview');

      const page = await client.beneficiaries.importPreview(IMPORT_ID, {
        page: 1,
        perPage: 25,
        buckets: ['valid', 'correctable'],
      });

      assert.equal(server.request(0).url.startsWith('/v1/beneficiaries/imports/42/preview?'), true);
      // Un filtro de varios valores viaja repetido.
      assert.deepEqual(query(0).getAll('buckets'), ['valid', 'correctable']);
      assert.equal(query(0).get('per_page'), '25');
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 150);
      assert.equal(page.totalPages, 6);
      assert.equal(page.hasNext, true);
      assert.equal(page.items[0]?.attributes?.parsed_account_type, 'clabe');
    });

    it('recorrer la vista previa pide la página siguiente sola', async () => {
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

    it('corregir una fila', async () => {
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

    it('corregir sin ningún campo no llega a la API', async () => {
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

    it('quitar una fila de la vista previa', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.importRemoveRow(IMPORT_ID, 102);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42/rows/102');
    });

    it('cancelar una importación sin confirmar', async () => {
      server.enqueue('no-content');

      await client.beneficiaries.importCancel(IMPORT_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42');
    });

    it('confirmar la importación deja el trabajo en committing', async () => {
      server.enqueue('beneficiaries-import-committed');

      const committed = await client.beneficiaries.importCommit(IMPORT_ID);

      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, '/v1/beneficiaries/imports/42/commit');
      assert.equal(committed.attributes.status, 'committing');
    });
  });

  describe('importWait', () => {
    it('espera a que la vista previa esté lista', async () => {
      server.enqueue('beneficiaries-import-parsing');
      server.enqueue('beneficiaries-import-status');
      const { sleep, waited } = pauses();

      const job = await client.beneficiaries.importWait(IMPORT_ID, { pollIntervalMs: 500, sleep });

      assert.equal(job.attributes?.status, 'preview_ready');
      assert.deepEqual(waited, [500]);
      assert.equal(server.requests.length, 2);
    });

    it('un trabajo que ya está listo se devuelve sin esperar', async () => {
      server.enqueue('beneficiaries-import-status');
      const { sleep, waited } = pauses();

      await client.beneficiaries.importWait(IMPORT_ID, { sleep });

      assert.deepEqual(waited, []);
      assert.equal(server.requests.length, 1);
    });

    it('se rinde al agotar el tiempo', async () => {
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

    it('preview_ready no es terminal: el trabajo sigue esperando la revisión', () => {
      assert.equal(isImportTerminal('preview_ready'), false);
      assert.equal(isImportTerminal('completed'), true);
    });
  });
});
