/** Retries, idempotency, per-call options, response metadata, errors and webhooks. */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ApiPromise,
  ConflictError,
  ConnectionError,
  DEFAULT_RETRY,
  ERROR_CODES,
  GoneError,
  InvalidRequestError,
  NotModifiedError,
  OLD_SIGNATURE_HEADER,
  PayloadTooLargeError,
  QuotaExceededError,
  RateLimitError,
  RequestAbortedError,
  RequestTimeoutError,
  ServerError,
  SignatureVerificationError,
  TimeoutError,
  Transport,
  Veriko,
  isCepExportTerminal,
  isSettled,
  oldSignatureFromHeaders,
  parseWebhook,
  verifyWebhook,
  verifyWebhookHeaders,
  verifyWebhookTimestamped,
  type Validation,
} from '../src/index.js';
import { filenameFromContentDisposition, resetApiDeprecationWarnings } from '../src/http.js';
import { RecordingServer, TEST_API_KEY, makeClient, type Recording } from './harness.js';

const TRANSFER = {
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
};
const VALIDATION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const WEBHOOK_ID = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

function error(status: number, code: string, headers: Record<string, string> = {}): Recording {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    json: {
      errors: [{ status: String(status), code, detail: `detail of ${code}` }],
      meta: { request_id: 'req-1', validation_id: 'v-1' },
    },
  };
}

describe('hardening', () => {
  let server: RecordingServer;
  let sleeps: number[];
  let client: Veriko;

  before(async () => {
    server = await RecordingServer.start();
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.reset();
    sleeps = [];
    client = makeClient(server, sleeps);
  });

  describe('retries only repeat what is safe to repeat', () => {
    it('a POST without an Idempotency-Key is not repeated after a 503', async () => {
      server.enqueueInline(error(503, 'service_unavailable'), 3);
      await assert.rejects(
        () =>
          client.webhooks.create({
            url: 'https://example.com/h',
            events: ['validation.completed'],
          }),
        ServerError,
      );
      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('a POST without a key is repeated after a 429, which is rejected before it runs', async () => {
      server.enqueue('validate-429').enqueue('webhook-created');
      await client.webhooks.create({
        url: 'https://example.com/h',
        events: ['validation.completed'],
      });
      assert.equal(server.requests.length, 2);
      assert.deepEqual(sleeps, [7000]);
    });

    it('a PUT is repeated after a 503', async () => {
      server.enqueueInline(error(503, 'service_unavailable')).enqueue('webhook-updated');
      await client.webhooks.update(WEBHOOK_ID, { description: 'x' });
      assert.equal(server.requests.length, 2);
    });

    it('a POST that carries a key is repeated with the same key', async () => {
      server.enqueueInline(error(502, 'bad_gateway')).enqueue('retries-cancelled');
      await client.validations.cancelRetries(VALIDATION_ID);
      assert.equal(server.requests.length, 2);
      assert.equal(server.header(0, 'idempotency-key'), server.header(1, 'idempotency-key'));
    });

    for (const status of [408, 504]) {
      it(`a GET is repeated after a ${String(status)}`, async () => {
        server.enqueueInline(error(status, 'transient')).enqueue('webhooks-list');
        await client.webhooks.list();
        assert.equal(server.requests.length, 2);
      });

      it(`a POST with a key is repeated after a ${String(status)}, and one without is not`, async () => {
        server.enqueueInline(error(status, 'transient')).enqueue('retries-cancelled');
        await client.validations.cancelRetries(VALIDATION_ID);
        assert.equal(server.requests.length, 2);

        server.reset();
        server.enqueueInline(error(status, 'transient')).enqueue('webhook-created');
        await assert.rejects(
          client.webhooks.create({
            url: 'https://myapp.example.com/h',
            events: ['validation.completed'],
          }),
        );
        assert.equal(server.requests.length, 1);
      });
    }

    it('every operation that accepts Idempotency-Key sends one', async () => {
      server.enqueue('retry-policy-updated').enqueue('retries-cancelled');
      server.enqueue('account-retry-policy-updated').enqueue('finance-cep-export-queued');
      const policy = {
        enabled: true,
        max_retries: 1,
        interval_seconds: 600,
        outcomes: ['error' as const],
      };
      await client.validations.setRetryPolicy(VALIDATION_ID, policy);
      await client.validations.cancelRetries(VALIDATION_ID);
      await client.account.updateMyRetryPolicy(policy);
      await client.finance.createCepExport({ from: '2026-04-01', to: '2026-04-30' });
      for (let index = 0; index < 4; index += 1) {
        assert.match(server.header(index, 'idempotency-key') ?? '', /^[A-Za-z0-9_-]{1,255}$/);
      }
    });

    it('the key of the call wins over the one of the params', async () => {
      server.enqueue('validate-valid');
      await client.validateTransfer(
        { ...TRANSFER, idempotencyKey: 'from-params' },
        { idempotencyKey: 'from-call' },
      );
      assert.equal(server.header(0, 'idempotency-key'), 'from-call');
    });

    it('a key outside the allowed pattern is rejected before it is sent', async () => {
      await assert.rejects(
        () => client.validateTransfer(TRANSFER, { idempotencyKey: 'not valid!' }),
        (cause: unknown) =>
          cause instanceof InvalidRequestError &&
          cause.code === ERROR_CODES.INVALID_IDEMPOTENCY_KEY &&
          cause.local,
      );
      assert.equal(server.requests.length, 0);
    });

    it('a Retry-After above the limit is not shortened: the error carries it', async () => {
      server.enqueueInline(error(429, 'rate_limit_exceeded', { 'Retry-After': '90' }));
      await assert.rejects(
        () => client.validateTransfer(TRANSFER),
        (cause: unknown) =>
          cause instanceof RateLimitError && cause.retryAfter === 90 && cause.kind === 'rate_limit',
      );
      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('a Retry-After within the limit is waited in full', async () => {
      const patient = makeClient(server, sleeps, { retry: { maxRetryAfterMs: 120_000 } });
      server.enqueueInline(error(429, 'rate_limit_exceeded', { 'Retry-After': '90' }));
      server.enqueue('validate-valid');
      await patient.validateTransfer(TRANSFER);
      assert.deepEqual(sleeps, [90_000]);
    });

    it('a 429 quota_exceeded is a QuotaExceededError and is not repeated', async () => {
      server.enqueue('validate-429-quota');
      await assert.rejects(
        () => client.validateTransfer(TRANSFER),
        (cause: unknown) =>
          cause instanceof QuotaExceededError &&
          cause.kind === 'quota' &&
          cause.limit === 80 &&
          cause.remaining === 0 &&
          cause.resetAt?.getTime() === 1742048400 * 1000,
      );
      assert.equal(server.requests.length, 1);
    });

    it('a 409 idempotency_key_in_progress waits and repeats the same key', async () => {
      server.enqueueInline(
        error(409, ERROR_CODES.IDEMPOTENCY_KEY_IN_PROGRESS, { 'Retry-After': '2' }),
      );
      server.enqueue('validate-valid');
      const result = await client.validateTransfer(TRANSFER);
      assert.equal(result.attributes.status, 'valid');
      assert.deepEqual(sleeps, [2000]);
      assert.equal(server.header(0, 'idempotency-key'), server.header(1, 'idempotency-key'));
    });

    it('the wait on a 409 in progress is bounded', async () => {
      const short = makeClient(server, sleeps, { retry: { maxInProgressWaitMs: 5000 } });
      server.enqueueInline(
        error(409, ERROR_CODES.IDEMPOTENCY_KEY_IN_PROGRESS, { 'Retry-After': '2' }),
        10,
      );
      await assert.rejects(
        () => short.validateTransfer(TRANSFER),
        (cause: unknown) =>
          cause instanceof ConflictError && cause.inProgress && cause.retryAfter === 2,
      );
      assert.deepEqual(sleeps, [2000, 2000]);
      assert.equal(server.requests.length, 3);
    });

    it('maxRetries: 0 per call makes a single attempt', async () => {
      server.enqueueInline(error(503, 'service_unavailable'), 3);
      await assert.rejects(() => client.validateTransfer(TRANSFER, { maxRetries: 0 }), ServerError);
      assert.equal(server.requests.length, 1);
    });
  });

  describe('errors', () => {
    it('exposes hint, docs_url, every code and the validation id', async () => {
      server.enqueueInline({
        status: 422,
        json: {
          errors: [
            { status: '422', code: 'validation_error', detail: 'Invalid.' },
            {
              status: '422',
              code: 'required',
              detail: 'send_date is required.',
              hint: 'Send the date.',
              docs_url: 'https://docs.veriko.mx/en/how-to/validate-spei',
              source: { pointer: '/data/attributes/send_date' },
            },
          ],
          meta: { request_id: 'abc', validation_id: 'val-9' },
        },
      });
      await assert.rejects(
        () => client.validateTransfer(TRANSFER),
        (cause: unknown) => {
          assert.ok(cause instanceof InvalidRequestError);
          assert.equal(cause.code, 'validation_error');
          assert.deepEqual(cause.codes, ['validation_error', 'required']);
          assert.ok(cause.hasCode('required'));
          assert.equal(cause.validationId, 'val-9');
          assert.equal(cause.errors[1]?.hint, 'Send the date.');
          assert.equal(cause.errors[1].docs_url, 'https://docs.veriko.mx/en/how-to/validate-spei');
          assert.equal(cause.local, false);
          return true;
        },
      );
    });

    it('hint and docsUrl of the first entry are on the error', async () => {
      server.enqueueInline({
        status: 404,
        json: {
          errors: [
            { status: '404', code: 'cep_not_available', detail: 'd', hint: 'h', docs_url: 'u' },
          ],
          meta: {},
        },
      });
      await assert.rejects(
        () => client.validations.cep(VALIDATION_ID),
        (cause: unknown) =>
          cause instanceof Error &&
          'hint' in cause &&
          cause.hint === 'h' &&
          'docsUrl' in cause &&
          cause.docsUrl === 'u',
      );
    });

    it('a 410 is a GoneError', async () => {
      server.enqueue('validation-purged-410');
      await assert.rejects(() => client.validations.cep(VALIDATION_ID), GoneError);
    });

    it('a 413 is a PayloadTooLargeError, still an InvalidRequestError', async () => {
      server.enqueueInline(error(413, 'body_too_large'));
      await assert.rejects(
        () => client.validateTransfer(TRANSFER),
        (cause: unknown) =>
          cause instanceof PayloadTooLargeError && cause instanceof InvalidRequestError,
      );
    });

    it('a 304 is a NotModifiedError with the ETag', async () => {
      server.enqueue('not-modified');
      await assert.rejects(
        () => client.validations.get(VALIDATION_ID, { ifNoneMatch: 'W/"1"' }),
        (cause: unknown) => cause instanceof NotModifiedError && cause.etag === 'W/"3-not_found"',
      );
    });

    it('errors raised before sending are marked local and use the API code', async () => {
      await assert.rejects(
        () =>
          client.validateTransfer({
            sendDate: '2025-03-15',
            amount: 1,
            beneficiaryAccount: '012180004412345678',
          }),
        (cause: unknown) =>
          cause instanceof InvalidRequestError &&
          cause.local &&
          cause.code === 'tracking_key_or_reference_required',
      );
    });

    it('a non-finite amount is rejected instead of sent as NaN', async () => {
      await assert.rejects(
        () => client.validateTransfer({ ...TRANSFER, amount: 'abc' }),
        (cause: unknown) => cause instanceof InvalidRequestError && cause.code === 'invalid_amount',
      );
      assert.equal(server.requests.length, 0);
    });

    it('a decimal string amount is sent as the number it spells', async () => {
      server.enqueue('validate-valid');
      await client.validateTransfer({ ...TRANSFER, amount: '15000.50' });
      assert.equal(server.json(0)['amount'], 15000.5);
    });
  });

  describe('response metadata', () => {
    it('withResponse adds the status, rate limit, replay flag and request id', async () => {
      server.enqueueInline({
        status: 200,
        headers: {
          'Idempotent-Replayed': 'true',
          'X-RateLimit-Limit': '80',
          'X-RateLimit-Remaining': '79',
          'X-RateLimit-Reset': '1742048400',
          'X-Quota-Limit': '1000',
          'X-Quota-Used': '10',
          'X-Quota-Remaining': '990',
          'X-Quota-Reset': '2026-12-01T00:00:00Z',
          ETag: 'W/"7"',
          Deprecation: 'date="2026-11-11"',
          Sunset: 'Mon, 01 Mar 2027 00:00:00 GMT',
        },
        json: {
          data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'valid' } },
          meta: { request_id: 'rid', version: '1.212.1' },
        },
      });
      const noticed: string[] = [];
      resetApiDeprecationWarnings();
      const watched = new Veriko({
        transport: new Transport({
          baseUrl: server.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          retry: DEFAULT_RETRY,
          userAgent: 'test',
          onDeprecation: (notice) => {
            noticed.push(`${notice.method} ${notice.path} ${notice.sunset ?? ''}`);
          },
        }),
      });
      const call = watched.validateTransfer(TRANSFER);
      assert.ok(call instanceof ApiPromise);
      assert.ok(call instanceof Promise);
      const { data, response } = await call.withResponse();
      assert.equal(data.attributes.status, 'valid');
      assert.equal(response.status, 200);
      assert.equal(response.requestId, 'rid');
      assert.equal(response.apiVersion, '1.212.1');
      assert.equal(response.replayed, true);
      assert.deepEqual(response.rateLimit, {
        limit: 80,
        remaining: 79,
        reset: new Date(1742048400 * 1000),
      });
      assert.deepEqual(response.quota, {
        limit: 1000,
        used: 10,
        remaining: 990,
        reset: '2026-12-01T00:00:00Z',
      });
      assert.equal(response.etag, 'W/"7"');
      assert.equal(response.attempts, 1);
      assert.equal(noticed.length, 1);
      assert.match(noticed[0] ?? '', /POST \/validate Mon, 01 Mar 2027/);
    });

    it('the plain await still resolves to the resource', async () => {
      server.enqueue('validate-valid');
      const validation = await client.validateTransfer(TRANSFER);
      assert.equal(validation.attributes.status, 'valid');
    });

    it('reports how many attempts a call took', async () => {
      server.enqueue('validate-503').enqueue('validate-valid');
      const { response } = await client.validateTransfer(TRANSFER).withResponse();
      assert.equal(response.attempts, 2);
    });

    it('the client-level onResponse hook sees every successful response', async () => {
      const seen: number[] = [];
      const hooked = new Veriko({
        transport: new Transport({
          baseUrl: server.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          retry: DEFAULT_RETRY,
          userAgent: 'test',
          onResponse: (meta) => {
            seen.push(meta.status);
          },
        }),
      });
      server.enqueue('banxico-status');
      await hooked.catalog.banxicoStatus();
      assert.deepEqual(seen, [200]);
    });
  });

  describe('per-call options', () => {
    it('Accept-Language and extra headers travel on the call', async () => {
      server.enqueue('banxico-status');
      await client.catalog.banxicoStatus({ acceptLanguage: 'en', headers: { 'X-Trace': 't1' } });
      assert.equal(server.header(0, 'accept-language'), 'en');
      assert.equal(server.header(0, 'x-trace'), 't1');
    });

    it('Authorization cannot be overridden per call', async () => {
      await assert.rejects(
        () => client.catalog.banxicoStatus({ headers: { Authorization: 'Bearer x' } }),
        /Authorization/,
      );
    });

    it('an AbortSignal that is already aborted never reaches the network', async () => {
      await assert.rejects(
        () => client.catalog.banxicoStatus({ signal: AbortSignal.abort() }),
        RequestAbortedError,
      );
      assert.equal(server.requests.length, 0);
    });

    it('an AbortSignal cuts the wait between retries', async () => {
      const controller = new AbortController();
      const slow = new Veriko({
        transport: new Transport({
          baseUrl: server.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          retry: DEFAULT_RETRY,
          userAgent: 'test',
          sleep: () => new Promise<void>(() => undefined),
        }),
      });
      server.enqueue('validate-503', 2);
      const pending = slow.validateTransfer(TRANSFER, { signal: controller.signal });
      setTimeout(() => {
        controller.abort();
      }, 50);
      await assert.rejects(() => pending, RequestAbortedError);
    });

    it('timeoutMs per call raises a RequestTimeoutError, a ConnectionError', async () => {
      const hanging = new Veriko({
        transport: new Transport({
          baseUrl: server.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 5000,
          retry: { ...DEFAULT_RETRY, maxRetries: 0 },
          userAgent: 'test',
          fetchImpl: (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
            }),
        }),
      });
      await assert.rejects(
        () => hanging.catalog.banxicoStatus({ timeoutMs: 20 }),
        (cause: unknown) =>
          cause instanceof RequestTimeoutError &&
          cause instanceof ConnectionError &&
          cause.timeoutMs === 20,
      );
    });

    it('a POST that timed out is not repeated without a key', async () => {
      let calls = 0;
      const hanging = new Veriko({
        transport: new Transport({
          baseUrl: server.baseUrl,
          apiKey: TEST_API_KEY,
          timeoutMs: 20,
          retry: { ...DEFAULT_RETRY, maxRetries: 2, backoffBaseMs: 1 },
          userAgent: 'test',
          fetchImpl: () => {
            calls += 1;
            return Promise.reject(new TypeError('fetch failed'));
          },
        }),
      });
      await assert.rejects(
        () =>
          hanging.webhooks.create({
            url: 'https://example.com/h',
            events: ['validation.completed'],
          }),
        ConnectionError,
      );
      assert.equal(calls, 1);
    });
  });

  describe('queued validations and polling', () => {
    it('a 202 from validate() is typed as queued', async () => {
      server.enqueue('validate-sync-deadline');
      const result = await client.validateTransfer(TRANSFER);
      assert.equal(result.attributes.status, 'processing');
      assert.ok(result.queued);
      assert.equal(result.queued.asyncReason, 'sync_deadline');
      assert.equal(result.queued.nextPollAfterSeconds, 3);
      assert.equal(result.queued.etag, 'W/"1-processing"');
      assert.equal(result.queued.expiresAt, '2025-03-15T15:22:10Z');
    });

    it('a 200 from validate() has no queued marker', async () => {
      server.enqueue('validate-valid');
      assert.equal((await client.validateTransfer(TRANSFER)).queued, undefined);
    });

    it('validateAndWait polls after a 202 and returns the verdict', async () => {
      server.enqueue('validate-sync-deadline').enqueue('validate-valid');
      const pauses: number[] = [];
      const result = await client.validations.validateAndWait(TRANSFER, {
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      });
      assert.equal(result.attributes.status, 'valid');
      assert.equal(server.requests.length, 2);
      assert.equal(server.request(1).method, 'GET');
      assert.equal(server.header(1, 'if-none-match'), 'W/"1-processing"');
    });

    it('waitFor never sleeps less than meta.next_poll_after_seconds', async () => {
      const processing = (poll: number): Recording => ({
        status: 200,
        headers: { ETag: 'W/"1"' },
        json: {
          data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'processing' } },
          meta: { next_poll_after_seconds: poll },
        },
      });
      server.enqueueInline(processing(15)).enqueue('validate-valid');
      const pauses: number[] = [];
      await client.validations.waitFor(VALIDATION_ID, {
        pollIntervalMs: 1000,
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      });
      assert.deepEqual(pauses, [15_000]);
    });

    it('waitFor honors Retry-After and defaults to the 2 second suggestion', async () => {
      server.enqueueInline({
        status: 200,
        headers: { 'Retry-After': '4' },
        json: { data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'queued' } } },
      });
      server.enqueueInline({
        status: 200,
        json: { data: { type: 'validation', id: VALIDATION_ID, attributes: { status: 'queued' } } },
      });
      server.enqueue('validate-valid');
      const pauses: number[] = [];
      await client.validations.waitFor(VALIDATION_ID, {
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      });
      assert.deepEqual(pauses, [4000, 2000]);
    });

    it('waitFor stops at expires_at plus a grace when the API reports one', async () => {
      const soon = new Date(Date.now() + 1000).toISOString();
      server.enqueueInline(
        {
          status: 200,
          json: {
            data: {
              type: 'validation',
              id: VALIDATION_ID,
              attributes: { status: 'processing', expires_at: soon },
            },
          },
        },
        50,
      );
      await assert
        .rejects(
          () =>
            client.validations.waitFor(VALIDATION_ID, {
              sleep: () => new Promise((r) => setTimeout(r, 15)),
            }),
          (cause: unknown) =>
            cause instanceof TimeoutError && cause.timeoutMs > 25_000 && cause.timeoutMs < 40_000,
        )
        .catch(() => undefined);
    });

    it('a valid verdict is settled even if a retry policy is configured', () => {
      const validation = {
        id: 'x',
        type: 'validation',
        attributes: { status: 'valid', retry_state: { enabled: true, terminal_state: null } },
      } as unknown as Validation;
      assert.equal(isSettled(validation), true);
    });

    it('waitForCepExport polls until the export is terminal', async () => {
      server.enqueue('finance-cep-export-queued').enqueue('finance-cep-export-ready');
      const pauses: number[] = [];
      const exported = await client.finance.waitForCepExport(VALIDATION_ID, {
        sleep: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      });
      assert.equal(exported.attributes?.status, 'ready');
      assert.deepEqual(pauses, [2000]);
    });

    it('waitForCepExport times out', async () => {
      server.enqueue('finance-cep-export-queued', 2);
      await assert.rejects(
        () =>
          client.finance.waitForCepExport(VALIDATION_ID, {
            timeoutMs: 0,
            sleep: () => Promise.resolve(),
          }),
        TimeoutError,
      );
    });

    it('terminal CEP export states', () => {
      assert.deepEqual(
        ['queued', 'building', 'ready', 'failed', 'expired'].map(isCepExportTerminal),
        [false, false, true, true, true],
      );
    });
  });

  describe('requests', () => {
    it('the import preview sends buckets as buckets[]', async () => {
      server.enqueue('beneficiaries-import-preview');
      await client.beneficiaries.importPreview(7, { buckets: ['valid', 'fatal'] });
      const url = new URL(server.request(0).url, 'http://x');
      assert.deepEqual(url.searchParams.getAll('buckets[]'), ['valid', 'fatal']);
      assert.deepEqual(url.searchParams.getAll('buckets'), []);
    });

    it('regenerateSecret sends immediate when asked', async () => {
      server.enqueue('webhook-secret-rotated').enqueue('webhook-secret-rotated');
      await client.webhooks.regenerateSecret(WEBHOOK_ID, { immediate: true });
      await client.webhooks.regenerateSecret(WEBHOOK_ID);
      assert.deepEqual(server.json(0), { immediate: true });
      assert.equal(server.request(1).body.length, 0);
    });

    it('a query of more than 20 delivery endpoints fails before it is sent', async () => {
      const ids = Array.from({ length: 21 }, (_, index) => `id-${String(index)}`);
      await assert.rejects(() => client.webhooks.deliveries(ids), /at most 20/);
      assert.equal(server.requests.length, 0);
    });

    it('downloads keep the response headers', async () => {
      server.enqueue('finance-ceps');
      const file = await client.finance.getCeps({ from: '2026-04-01', to: '2026-04-30' });
      assert.equal(typeof file.headers['content-type'], 'string');
    });

    it('an import file named .json is sent as application/json', async () => {
      server.enqueue('beneficiaries-import-created');
      await client.beneficiaries.importStart(new Uint8Array([123, 125]), { filename: 'list.json' });
      assert.match(server.request(0).body.toString('utf8'), /Content-Type: application\/json/);
    });
  });

  describe('Content-Disposition', () => {
    it('reads filename*, quoted names with semicolons and plain names', () => {
      assert.equal(
        filenameFromContentDisposition(
          'attachment; filename="a.csv"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.csv',
          'x',
        ),
        'résumé.csv',
      );
      assert.equal(
        filenameFromContentDisposition('attachment; filename="a;b.csv"', 'x'),
        'a;b.csv',
      );
      assert.equal(
        filenameFromContentDisposition('attachment; filename=plain.csv', 'x'),
        'plain.csv',
      );
      assert.equal(filenameFromContentDisposition(undefined, 'fallback.csv'), 'fallback.csv');
    });
  });
});

describe('webhook signatures during a rotation', () => {
  const CURRENT = 'a'.repeat(64);
  const PREVIOUS = 'b'.repeat(64);
  const BODY =
    '{"event":"validation.completed","timestamp":"2026-01-01T00:00:00Z","data":{"type":"validation","id":"v","attributes":{"status":"valid"}}}';
  const NOW = new Date(1_700_000_000_000);
  const T = '1700000000';
  const timestamped = (secret: string, t = T): string =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${BODY}`).digest('hex')}`;

  it('verifyWebhook accepts a list of secrets', () => {
    const signature = createHmac('sha256', PREVIOUS).update(BODY).digest('hex');
    assert.equal(verifyWebhook(BODY, signature, [CURRENT, PREVIOUS]), true);
    assert.equal(verifyWebhook(BODY, signature, [CURRENT]), false);
    assert.equal(verifyWebhook(BODY, signature, []), false);
  });

  it('a signature with non-ASCII characters is rejected without throwing', () => {
    assert.equal(verifyWebhook(BODY, 'sha256=ñññ'.padEnd(80, 'é'), CURRENT), false);
    assert.equal(
      verifyWebhookTimestamped(BODY, `t=${T},v1=ñ${'é'.repeat(63)}`, CURRENT, { now: NOW }),
      false,
    );
  });

  it('verifyWebhookTimestamped accepts a list of secrets', () => {
    assert.equal(
      verifyWebhookTimestamped(BODY, timestamped(PREVIOUS), [CURRENT, PREVIOUS], { now: NOW }),
      true,
    );
  });

  it('verifyWebhookHeaders accepts the current signature', () => {
    const headers = { 'X-Webhook-Signature-Timestamped': timestamped(CURRENT) };
    assert.equal(verifyWebhookHeaders(BODY, headers, CURRENT, { now: NOW }), true);
  });

  it('verifyWebhookHeaders accepts the -Old signature signed with the previous secret', () => {
    const headers = {
      'x-webhook-signature-timestamped': timestamped(CURRENT),
      'X-Webhook-Signature-Old': timestamped(PREVIOUS),
    };
    assert.equal(OLD_SIGNATURE_HEADER, 'X-Webhook-Signature-Old');
    assert.equal(oldSignatureFromHeaders(headers), timestamped(PREVIOUS));
    assert.equal(
      verifyWebhookHeaders(BODY, { 'x-webhook-signature-old': timestamped(PREVIOUS) }, PREVIOUS, {
        now: NOW,
      }),
      true,
    );
    assert.equal(verifyWebhookHeaders(BODY, headers, [CURRENT, PREVIOUS], { now: NOW }), true);
  });

  it('the time window defaults to 5 minutes and is configurable', () => {
    const headers = { 'X-Webhook-Signature-Timestamped': timestamped(CURRENT) };
    const later = new Date(NOW.getTime() + 301_000);
    assert.equal(verifyWebhookHeaders(BODY, headers, CURRENT, { now: later }), false);
    assert.equal(
      verifyWebhookHeaders(BODY, headers, CURRENT, { now: later, toleranceSeconds: 600 }),
      true,
    );
  });

  it('parseWebhook with headers verifies freshness and exposes rawData', () => {
    const headers = { 'X-Webhook-Signature-Timestamped': timestamped(CURRENT) };
    const event = parseWebhook(BODY, headers, CURRENT, { now: NOW });
    assert.equal(event.event, 'validation.completed');
    assert.ok(event.data);
    assert.ok(event.rawData);
    assert.throws(
      () => parseWebhook(BODY, headers, CURRENT, { now: new Date(NOW.getTime() + 3_600_000) }),
      SignatureVerificationError,
    );
  });

  it('parseWebhook with headers does not fall back to the plain signature', () => {
    const plain = createHmac('sha256', CURRENT).update(BODY).digest('hex');
    assert.throws(
      () => parseWebhook(BODY, { 'X-Webhook-Signature': plain }, CURRENT, { now: NOW }),
      SignatureVerificationError,
    );
  });

  it('a billing event keeps its data in rawData', () => {
    const body =
      '{"event":"billing.payment_failed","timestamp":"2026-01-01T00:00:00Z","data":{"invoice":"in_1"}}';
    const signature = createHmac('sha256', CURRENT).update(body).digest('hex');
    const event = parseWebhook(body, signature, CURRENT);
    assert.equal(event.data, undefined);
    assert.deepEqual(event.rawData, { invoice: 'in_1' });
  });
});
