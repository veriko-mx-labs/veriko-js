/** Client construction: key, API root and headers. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  API_KEY_ENV_VAR,
  Account,
  Beneficiaries,
  Billing,
  buildUserAgent,
  Catalog,
  ConfigurationError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
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
import { PROJECT_ROOT, RecordingServer, TEST_API_KEY } from './harness.js';

const TRANSFER = {
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
};

describe('default timeout', () => {
  it('exceeds the 45 s the API can take before it answers 202', () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
  });
});

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

  it('without an API key it builds the client for its public operations', () => {
    const client = new Veriko();

    assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  });

  it('without an API key it rejects an authenticated operation before it reaches the network', async () => {
    const client = new Veriko({ apiKey: '', baseUrl: server.baseUrl });

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => error instanceof ConfigurationError,
    );
    assert.equal(server.requests.length, 0);
  });

  for (const [label, key] of [
    ['without the prefix', '0123456789abcdef'.repeat(4)],
    ['with another prefix', `other_${'0123456789abcdef'.repeat(4)}`],
    ['too short', 'veriko_x'],
    ['too long', `${TEST_API_KEY}0`],
    ['in uppercase', `veriko_${'0123456789ABCDEF'.repeat(4)}`],
    ['with spaces', ` ${TEST_API_KEY}\n`],
  ] as const) {
    it(`with a key ${label} rejects the operation before it reaches the network`, async () => {
      const client = new Veriko({ apiKey: key, baseUrl: server.baseUrl, maxRetries: 0 });

      await assert.rejects(
        () => client.validateTransfer(TRANSFER),
        (error: unknown) =>
          error instanceof ConfigurationError && !error.message.includes(key.trim()),
      );
      assert.equal(server.requests.length, 0);
    });
  }

  it('a malformed key from the environment does not reach the network either', async () => {
    process.env[API_KEY_ENV_VAR] = 'veriko_from_env';
    const client = new Veriko({ baseUrl: server.baseUrl });

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => error instanceof ConfigurationError,
    );
    assert.equal(server.requests.length, 0);
  });

  it('a malformed key does not block the public operations', async () => {
    const client = new Veriko({ apiKey: 'veriko_x', baseUrl: server.baseUrl });
    server.enqueue('public-plans');

    await client.plans.listPublic();

    assert.equal(server.requests.length, 1);
    assert.equal(server.header(0, 'authorization'), undefined);
  });

  it('the key is read from the environment', () => {
    process.env[API_KEY_ENV_VAR] = TEST_API_KEY;

    const client = new Veriko();

    assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  });

  it('the API root can point somewhere else', () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl: 'http://127.0.0.1:9999/v1/' });

    assert.equal(client.baseUrl, 'http://127.0.0.1:9999/v1');
  });

  it('the request identifies itself with the SDK User-Agent', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl: server.baseUrl });
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    const agent = server.header(0, 'user-agent') ?? '';
    assert.ok(agent.startsWith(`veriko-sdk-js/${VERSION} (`), agent);
    assert.match(agent, /^\S+ \((node|deno|bun) [^;]+; \S+ \S+\)$/);
  });

  it('the User-Agent carries the wrapping product first and the suffix last', () => {
    const agent = buildUserAgent('veriko-mcp/0.2.0 (stdio)', 'mi-app/1.0');

    assert.ok(agent.startsWith(`veriko-mcp/0.2.0 (stdio) veriko-sdk-js/${VERSION} (`));
    assert.ok(agent.endsWith(') mi-app/1.0'));
  });

  it('the operations group into eleven families', () => {
    const client = new Veriko({ apiKey: TEST_API_KEY });

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

  it('the SDK version is the one in package.json', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    assert.equal(VERSION, manifest.version);
  });

  it('the message language is negotiated by header', async () => {
    const client = new Veriko({
      apiKey: TEST_API_KEY,
      baseUrl: server.baseUrl,
      acceptLanguage: 'en',
    });
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    assert.equal(server.header(0, 'accept-language'), 'en');
  });
});
