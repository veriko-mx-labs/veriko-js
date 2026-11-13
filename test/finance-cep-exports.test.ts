/** Background CEP exports: what each `client.finance` method returns. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Veriko } from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('client.finance: CEP exports', () => {
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

  it('createCepExport sends the range and returns the queued export', async () => {
    server.enqueue('finance-cep-export-queued');

    const exportJob = await client.finance.createCepExport({
      from: '2026-04-01',
      to: '2026-04-30',
      idempotencyKey: 'order-7',
    });

    const sent = server.request(0);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/finance/ceps/exports');
    assert.deepEqual(JSON.parse(sent.body.toString('utf8')), {
      from: '2026-04-01',
      to: '2026-04-30',
    });
    assert.equal(sent.headers['idempotency-key'], 'order-7');
    assert.equal(exportJob.id, ID);
    assert.equal(exportJob.attributes?.status, 'queued');
    assert.equal(exportJob.links?.self, `/v1/finance/ceps/exports/${ID}`);
  });

  it('getCepExport carries the download link when it is ready', async () => {
    server.enqueue('finance-cep-export-ready');

    const exportJob = await client.finance.getCepExport(ID);

    assert.equal(server.request(0).url, `/v1/finance/ceps/exports/${ID}`);
    assert.equal(exportJob.attributes?.status, 'ready');
    assert.equal(exportJob.attributes.item_count, 42);
    assert.equal(exportJob.links?.download, `/v1/finance/ceps/exports/${ID}/download`);
  });

  it('listCepExports returns the resources', async () => {
    server.enqueue('finance-cep-exports');

    const exports = await client.finance.listCepExports();

    assert.equal(server.request(0).url, '/v1/finance/ceps/exports');
    assert.deepEqual(
      exports.map((exportJob) => exportJob.id),
      [ID],
    );
  });

  it('downloadCepExport returns the ZIP', async () => {
    server.enqueue('finance-ceps');

    const file = await client.finance.downloadCepExport(ID);

    assert.equal(server.request(0).url, `/v1/finance/ceps/exports/${ID}/download`);
    assert.equal(file.contentType, 'application/zip');
    assert.equal(file.filename, 'finance-ceps.zip');
  });
});
