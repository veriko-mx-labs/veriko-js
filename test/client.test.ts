/** Construcción del cliente: clave, raíz de la API y cabeceras. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  API_KEY_ENV_VAR,
  ConfigurationError,
  DEFAULT_BASE_URL,
  VERSION,
  Veriko,
} from '../src/index.js';
import { RecordingServer } from './harness.js';

const TRANSFER = {
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
};

describe('new Veriko()', () => {
  let server: RecordingServer;
  let claveOriginal: string | undefined;

  before(async () => {
    server = await RecordingServer.start();
    claveOriginal = process.env[API_KEY_ENV_VAR];
  });

  after(async () => {
    await server.close();
    if (claveOriginal === undefined) Reflect.deleteProperty(process.env, API_KEY_ENV_VAR);
    else process.env[API_KEY_ENV_VAR] = claveOriginal;
  });

  beforeEach(() => {
    server.requests.length = 0;
    Reflect.deleteProperty(process.env, API_KEY_ENV_VAR);
  });

  it('sin clave de API falla al construir', () => {
    assert.throws(
      () => new Veriko(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /VERIKO_API_KEY/);
        return true;
      },
    );
  });

  it('la clave se lee del entorno', () => {
    process.env[API_KEY_ENV_VAR] = 'veriko_del_entorno';

    const client = new Veriko();

    assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  });

  it('la raíz de la API se puede apuntar a otro sitio', () => {
    const client = new Veriko({ apiKey: 'veriko_x', baseUrl: 'http://127.0.0.1:9999/v1/' });

    assert.equal(client.baseUrl, 'http://127.0.0.1:9999/v1');
  });

  it('la petición se identifica con el User-Agent del SDK', async () => {
    const client = new Veriko({ apiKey: 'veriko_x', baseUrl: server.baseUrl });
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    assert.ok(server.header(0, 'user-agent')?.startsWith(`veriko-js/${VERSION}`));
  });

  it('el idioma de los mensajes se negocia por cabecera', async () => {
    const client = new Veriko({
      apiKey: 'veriko_x',
      baseUrl: server.baseUrl,
      acceptLanguage: 'en',
    });
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    assert.equal(server.header(0, 'accept-language'), 'en');
  });
});
