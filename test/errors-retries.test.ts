/** Errors by HTTP status, retries and idempotency. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  DEFAULT_RETRY,
  InvalidRequestError,
  RateLimitError,
  Transport,
  Veriko,
  parseRetryAfter,
} from '../src/index.js';
import { RecordingServer, TEST_API_KEY, makeClient } from './harness.js';

const TRANSFER = {
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
};

describe('API errors', () => {
  let server: RecordingServer;
  let client: Veriko;
  let sleeps: number[];

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    sleeps = [];
    client = makeClient(server, sleeps);
  });

  it('a 422 exposes every entry, not only the first', async () => {
    server.enqueue('validate-422');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'required');
        assert.equal(error.pointer, '/data/attributes/send_date');
        assert.equal(error.errors.length, 2);
        assert.deepEqual(
          error.errors.map((entry) => entry.code),
          ['required', 'invalid_clabe_checksum'],
        );
        assert.equal(error.requestId, 'a1b2c3d4e5f66f5e4d3c2b1a');
        return true;
      },
    );
  });

  it('a 401 is an authentication error', async () => {
    server.enqueue('validate-401');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof AuthenticationError);
        assert.equal(error.code, 'unauthorized');
        assert.match(error.message, /HTTP 401 unauthorized/);
        assert.match(error.message, /request_id=a8b9c0d1e2f33f2e1d0c9b8a/);
        return true;
      },
    );
  });

  it('a 409 signals the idempotency key in progress', async () => {
    server.enqueue('validate-409', 30);

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, 'idempotency_key_in_progress');
        return true;
      },
    );
  });

  it('an exhausted 429 exposes the seconds to wait', async () => {
    server.enqueue('validate-429', 3);

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.retryAfter, 7);
        assert.equal(error.headers['x-ratelimit-remaining'], '0');
        return true;
      },
    );
  });
});

describe('retries', () => {
  let server: RecordingServer;
  let sleeps: number[];

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    sleeps = [];
  });

  it('a 503 is retried and the second response wins', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503').enqueue('validate-valid');

    const validation = await client.validateTransfer(TRANSFER);

    assert.equal(validation.attributes.status, 'valid');
    assert.equal(server.requests.length, 2);
  });

  it('a 429 waits what Retry-After says', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-429').enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    // `Retry-After: 7` wins over the client's own backoff.
    assert.deepEqual(sleeps, [7000]);
  });

  it('a 429 quota_exceeded is not retried', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-429-quota');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => error instanceof RateLimitError && error.code === 'quota_exceeded',
    );

    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('a 422 is not retried', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-422');

    await assert.rejects(() => client.validateTransfer(TRANSFER));

    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('with maxRetries at 0 the first 429 is thrown', async () => {
    const client = makeClient(server, sleeps, { maxRetries: 0 });
    server.enqueue('validate-429');

    await assert.rejects(() => client.validateTransfer(TRANSFER), RateLimitError);

    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('the own backoff is used when there is no Retry-After', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503', 2).enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every((wait) => wait > 0));
    // Exponential: the second wait is longer than the first even with jitter.
    assert.ok((sleeps[1] ?? 0) > (sleeps[0] ?? 0) / 2);
  });

  it('with no server on the other side a connection error is thrown', async () => {
    const transport = new Transport({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: TEST_API_KEY,
      timeoutMs: 500,
      retry: { ...DEFAULT_RETRY, maxRetries: 1, backoffBaseMs: 10 },
      userAgent: 'veriko-js/test',
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const client = new Veriko({ transport });

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof ConnectionError);
        assert.equal(error.attempts, 2);
        return true;
      },
    );

    assert.equal(sleeps.length, 1);
  });
});

describe('idempotency', () => {
  let server: RecordingServer;
  let sleeps: number[];

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    sleeps = [];
  });

  it('the caller key travels as given', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid');

    await client.validateTransfer({ ...TRANSFER, idempotencyKey: 'order-4f3a2b1c' });

    assert.equal(server.header(0, 'idempotency-key'), 'order-4f3a2b1c');
  });

  it('without a key the SDK sets one and repeats it in the retries', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503').enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    const first = server.header(0, 'idempotency-key');
    const second = server.header(1, 'idempotency-key');
    assert.ok(first);
    // The same key on the retry: it is what prevents the duplicate validation.
    assert.equal(first, second);
    assert.match(first, /^veriko-js-[0-9a-f]{32}$/);
  });

  it('two different calls do not share a key', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid', 2);

    await client.validateTransfer(TRANSFER);
    await client.validateTransfer(TRANSFER);

    assert.notEqual(server.header(0, 'idempotency-key'), server.header(1, 'idempotency-key'));
  });

  it('the generated key meets the API pattern', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    const key = server.header(0, 'idempotency-key') ?? '';
    assert.ok(key.length >= 1 && key.length <= 255);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });
});

describe('Retry-After', () => {
  it('in seconds', () => {
    assert.equal(parseRetryAfter('12'), 12);
  });

  it('as an HTTP date', () => {
    const wait = parseRetryAfter('Wed, 21 Oct 2099 07:28:00 GMT');
    assert.ok(wait !== undefined && wait > 0);
  });

  it('missing or unreadable', () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
  });
});
