/** Descargar el CEP: el archivo que emite Banxico, no un enlace. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ConfigurationError, NotFoundError, type Veriko } from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const VALIDATION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('getCep', () => {
  let server: RecordingServer;
  let client: Veriko;

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    client = makeClient(server, []);
  });

  it('descarga el comprobante en XML', async () => {
    server.enqueue('cep-xml');

    const cep = await client.getCep(VALIDATION_ID);

    assert.equal(server.request(0).url, `/v1/validations/${VALIDATION_ID}/cep?format=xml`);
    assert.equal(cep.format, 'xml');
    assert.equal(cep.contentType, 'application/xml');
    assert.equal(cep.filename, `CEP-${VALIDATION_ID}.xml`);
    const texto = Buffer.from(cep.content).toString('utf8');
    assert.ok(texto.startsWith('<?xml'));
    assert.ok(texto.includes('SPEI_Tercero'));
  });

  it('descarga el comprobante en PDF', async () => {
    server.enqueue('cep-pdf');

    const cep = await client.getCep(VALIDATION_ID, { format: 'pdf' });

    assert.ok(server.request(0).url.endsWith('format=pdf'));
    assert.equal(server.header(0, 'accept'), 'application/pdf, application/json');
    assert.equal(cep.format, 'pdf');
    assert.ok(Buffer.from(cep.content).subarray(0, 5).toString('latin1') === '%PDF-');
  });

  it('sin comprobante la API responde 404', async () => {
    server.enqueue('cep-404');

    await assert.rejects(
      () => client.getCep(VALIDATION_ID),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.code, 'cep_not_available');
        return true;
      },
    );
  });

  it('un formato fuera de la lista no llega a la API', async () => {
    await assert.rejects(
      () => client.getCep(VALIDATION_ID, { format: 'docx' as 'pdf' }),
      ConfigurationError,
    );

    assert.equal(server.requests.length, 0);
  });

  it('un identificador con barras no se interpola en la ruta', async () => {
    await assert.rejects(() => client.getCep('../../otra/ruta'), ConfigurationError);

    assert.equal(server.requests.length, 0);
  });
});
