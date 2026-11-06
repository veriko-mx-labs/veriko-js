/** Exportaciones de CEP en segundo plano: lo que devuelve cada método de `client.finance`. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Veriko } from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('client.finance: exportaciones de CEP', () => {
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

  it('createCepExport envía el rango y devuelve la exportación en cola', async () => {
    server.enqueue('finance-cep-export-queued');

    const exportacion = await client.finance.createCepExport({
      from: '2026-04-01',
      to: '2026-04-30',
      idempotencyKey: 'pedido-7',
    });

    const enviada = server.request(0);
    assert.equal(enviada.method, 'POST');
    assert.equal(enviada.url, '/v1/finance/ceps/exports');
    assert.deepEqual(JSON.parse(enviada.body.toString('utf8')), {
      from: '2026-04-01',
      to: '2026-04-30',
    });
    assert.equal(enviada.headers['idempotency-key'], 'pedido-7');
    assert.equal(exportacion.id, ID);
    assert.equal(exportacion.attributes?.status, 'queued');
    assert.equal(exportacion.links?.self, `/v1/finance/ceps/exports/${ID}`);
  });

  it('getCepExport trae el enlace de descarga cuando está lista', async () => {
    server.enqueue('finance-cep-export-ready');

    const exportacion = await client.finance.getCepExport(ID);

    assert.equal(server.request(0).url, `/v1/finance/ceps/exports/${ID}`);
    assert.equal(exportacion.attributes?.status, 'ready');
    assert.equal(exportacion.attributes.item_count, 42);
    assert.equal(exportacion.links?.download, `/v1/finance/ceps/exports/${ID}/download`);
  });

  it('listCepExports devuelve los recursos', async () => {
    server.enqueue('finance-cep-exports');

    const exportaciones = await client.finance.listCepExports();

    assert.equal(server.request(0).url, '/v1/finance/ceps/exports');
    assert.deepEqual(
      exportaciones.map((exportacion) => exportacion.id),
      [ID],
    );
  });

  it('downloadCepExport devuelve el ZIP', async () => {
    server.enqueue('finance-ceps');

    const archivo = await client.finance.downloadCepExport(ID);

    assert.equal(server.request(0).url, `/v1/finance/ceps/exports/${ID}/download`);
    assert.equal(archivo.contentType, 'application/zip');
    assert.equal(archivo.filename, 'finance-ceps.zip');
  });
});
