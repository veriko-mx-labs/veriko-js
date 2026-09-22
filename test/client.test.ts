/** Construcción del cliente: clave, raíz de la API y cabeceras. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  API_KEY_ENV_VAR,
  Account,
  Beneficiaries,
  Billing,
  Catalog,
  ConfigurationError,
  DEFAULT_BASE_URL,
  Dashboard,
  Finance,
  Insights,
  Plans,
  Usage,
  VERSION,
  Validations,
  Veriko,
  Webhooks,
} from '../src/index.js';
import { PROJECT_ROOT, RecordingServer } from './harness.js';

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

  it('sin clave de API construye el cliente para sus operaciones públicas', () => {
    const client = new Veriko();

    assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  });

  it('sin clave de API rechaza una operación autenticada antes de salir a la red', async () => {
    const client = new Veriko({ apiKey: '', baseUrl: server.baseUrl });

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => error instanceof ConfigurationError,
    );
    assert.equal(server.requests.length, 0);
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

  it('las operaciones se agrupan en once familias', () => {
    const client = new Veriko({ apiKey: 'veriko_x' });

    assert.ok(client.validations instanceof Validations);
    assert.ok(client.webhooks instanceof Webhooks);
    assert.ok(client.catalog instanceof Catalog);
    assert.ok(client.beneficiaries instanceof Beneficiaries);
    assert.ok(client.usage instanceof Usage);
    assert.ok(client.account instanceof Account);
    assert.ok(client.dashboard instanceof Dashboard);
    assert.ok(client.plans instanceof Plans);
    assert.ok(client.insights instanceof Insights);
    assert.ok(client.finance instanceof Finance);
    assert.ok(client.billing instanceof Billing);
  });

  it('la versión del SDK es la del package.json', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    assert.equal(VERSION, manifest.version);
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
