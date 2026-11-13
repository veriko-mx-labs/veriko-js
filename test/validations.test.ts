/** The family `client.validations`. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ApiError,
  ConfigurationError,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  Veriko,
  hasCep,
  isSettled,
  type PaymentStatus,
  type Validation,
} from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const VALIDATION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('client.validations', () => {
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
    server.reset();
    sleeps = [];
    client = makeClient(server, sleeps);
  });

  /** The query of request `index`, already parsed. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  describe('validateOcr', () => {
    it('the image travels in base64 when passed as bytes', async () => {
      server.enqueue('validate-ocr');
      const image = Buffer.from('\x89PNG\r\n\x1a\n test image', 'latin1');

      const validation = await client.validations.validateOcr({
        image,
        beneficiaryAccount: '012180004412345678',
      });

      assert.equal(validation.attributes.validation_type, 'ocr');
      assert.equal(validation.attributes.status, 'valid');
      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/validate-ocr');
      const body = server.json(0);
      assert.equal(Buffer.from(String(body['image']), 'base64').equals(image), true);
      assert.equal(body['beneficiary_account'], '012180004412345678');
    });

    it('a Uint8Array and a Buffer travel the same', async () => {
      server.enqueue('validate-ocr', 2);
      const bytes = new Uint8Array([1, 2, 3, 250, 251]);

      await client.validations.validateOcr({ image: bytes });
      await client.validations.validateOcr({ image: Buffer.from(bytes) });

      assert.equal(server.json(0)['image'], server.json(1)['image']);
      assert.equal(server.json(0)['image'], Buffer.from(bytes).toString('base64'));
    });

    it('reads the image from a path', async () => {
      server.enqueue('validate-ocr');
      const directory = mkdtempSync(join(tmpdir(), 'veriko-ocr-'));
      try {
        const file = join(directory, 'comprobante.png');
        writeFileSync(file, 'receipt content');

        await client.validations.validateOcr({ image: file });

        const sent = Buffer.from(String(server.json(0)['image']), 'base64').toString('utf8');
        assert.equal(sent, 'receipt content');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('clientRef travels as client_ref', async () => {
      server.enqueue('validate-ocr-conflict');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        clientRef: 'order-4812',
      });

      assert.equal(server.json(0)['client_ref'], 'order-4812');
      assert.equal(validation.attributes.client_ref, 'order-4812');
    });

    it('the validation exposes the duplicate and the account conflict', async () => {
      server.enqueue('validate-ocr-conflict');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        beneficiaryAccount: '012180004412345678',
      });

      assert.deepEqual(validation.attributes.duplicate_of, {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        created_at: '2025-04-09T09:15:00Z',
      });
      assert.deepEqual(validation.attributes.account_conflict, {
        sent_last4: '5678',
        read_last4: '9012',
      });
      assert.equal(validation.attributes.status, 'not_found');
    });

    it('imageUrl travels alone, without image', async () => {
      server.enqueue('validate-ocr');

      await client.validations.validateOcr({ imageUrl: 'https://example.mx/comprobante.png' });

      assert.deepEqual(server.json(0), { image_url: 'https://example.mx/comprobante.png' });
    });

    it('without an image or a URL the API is not called', async () => {
      await assert.rejects(
        () => client.validations.validateOcr({}),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'image_or_image_url_required');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('a path that does not exist stops before the API', async () => {
      await assert.rejects(
        () => client.validations.validateOcr({ image: 'this-file-does-not-exist.png' }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /The image file does not exist/);
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('generates an idempotency key and respects the one passed', async () => {
      server.enqueue('validate-ocr', 2);

      await client.validations.validateOcr({ imageUrl: 'https://example.mx/a.png' });
      await client.validations.validateOcr({
        imageUrl: 'https://example.mx/a.png',
        idempotencyKey: 'order-4f3a2b1c',
      });

      assert.match(server.header(0, 'idempotency-key') ?? '', /^veriko-js-[0-9a-f]{32}$/);
      assert.equal(server.header(1, 'idempotency-key'), 'order-4f3a2b1c');
    });
  });

  describe('asynchronous mode', () => {
    it('enqueue returns the acknowledgment with no verdict', async () => {
      server.enqueue('validate-queued');

      const queued = await client.validations.enqueue({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        beneficiaryAccount: '012180004412345678',
      });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.equal(queued.id, VALIDATION_ID);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.etag, 'W/"0-queued"');
      assert.equal(queued.location, `/v1/validations/${VALIDATION_ID}`);
      assert.equal(queued.nextPollAfterSeconds, 3);
      assert.equal(queued.data.attributes?.expires_at, '2025-03-15T15:22:10Z');
    });

    it('enqueue carries clientRef on both paths', async () => {
      server.enqueue('validate-queued', 2);

      await client.validations.enqueue({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        beneficiaryAccount: '012180004412345678',
        clientRef: 'order-4812',
      });
      await client.validations.enqueueOcr({ image: Buffer.from('png'), clientRef: 'order-4812' });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.equal(server.json(0)['client_ref'], 'order-4812');
      assert.equal(server.request(1).url, '/v1/validate-ocr?async=1');
      assert.equal(server.json(1)['client_ref'], 'order-4812');
    });

    it('enqueue an image', async () => {
      server.enqueue('validate-queued');

      const queued = await client.validations.enqueueOcr({ image: Buffer.from('png') });

      assert.equal(server.request(0).url, '/v1/validate-ocr?async=1');
      assert.equal(queued.id, VALIDATION_ID);
    });

    it('enqueue without a transfer identifier does not call the API', async () => {
      await assert.rejects(
        () =>
          client.validations.enqueue({
            sendDate: '2025-03-15',
            amount: 100,
            beneficiaryAccount: '012180004412345678',
          }),
        InvalidRequestError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('get', () => {
    it('returns the validation with the ETag of the response', async () => {
      server.enqueue('validation-retrying');

      const validation = await client.validations.get(VALIDATION_ID);

      assert.equal(validation.id, VALIDATION_ID);
      assert.equal(validation.etag, 'W/"3-not_found"');
      assert.equal(server.header(0, 'if-none-match'), undefined);
    });

    it('with ifNoneMatch it sends the header, and a 304 is thrown as ApiError', async () => {
      server.enqueue('not-modified');

      await assert.rejects(
        () => client.validations.get(VALIDATION_ID, { ifNoneMatch: 'W/"3-not_found"' }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 304);
          return true;
        },
      );

      assert.equal(server.header(0, 'if-none-match'), 'W/"3-not_found"');
    });

    it('an unusable identifier does not reach the API', async () => {
      await assert.rejects(() => client.validations.get('a/b'), ConfigurationError);
      await assert.rejects(() => client.validations.delete('  '), ConfigurationError);

      assert.equal(server.requests.length, 0);
    });

    it('the root shortcut and the family do the same', async () => {
      server.enqueue('validate-valid', 2);
      const params = {
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        beneficiaryAccount: '012180004412345678',
      };

      const fromRoot = await client.validateTransfer(params);
      const fromFamily = await client.validations.validate(params);

      assert.equal(fromRoot.id, fromFamily.id);
      assert.deepEqual(server.json(0), server.json(1));
    });
  });

  describe('waitFor', () => {
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

    it('polls until the verdict', async () => {
      server.enqueue('validation-queued-status');
      server.enqueue('validate-valid');
      const { sleep, waited } = pauses();

      const validation = await client.validations.waitFor(VALIDATION_ID, {
        pollIntervalMs: 2000,
        sleep,
      });

      assert.equal(validation.attributes.status, 'valid');
      assert.deepEqual(waited, [2000]);
      assert.equal(server.requests.length, 2);
    });

    it('sends the ETag of the previous response', async () => {
      server.enqueue('validation-queued-status');
      server.enqueue('validate-valid');

      await client.validations.waitFor(VALIDATION_ID, { sleep: pauses().sleep });

      assert.equal(server.header(0, 'if-none-match'), undefined);
      assert.equal(server.header(1, 'if-none-match'), 'W/"0-queued"');
    });

    it('a 304 does not interrupt the polling', async () => {
      server.enqueue('validation-queued-status');
      server.enqueue('not-modified');
      server.enqueue('validate-valid');

      const validation = await client.validations.waitFor(VALIDATION_ID, { sleep: pauses().sleep });

      assert.equal(validation.attributes.status, 'valid');
      assert.equal(server.requests.length, 3);
      assert.equal(server.header(1, 'if-none-match'), 'W/"0-queued"');
      assert.equal(server.header(2, 'if-none-match'), 'W/"0-queued"');
    });

    it('a not_found with retries in progress is not a settled verdict', async () => {
      server.enqueue('validation-retrying');
      server.enqueue('validate-valid');
      const { sleep, waited } = pauses();

      const validation = await client.validations.waitFor(VALIDATION_ID, { sleep });

      assert.equal(validation.attributes.status, 'valid');
      assert.equal(waited.length, 1);
    });

    it('a not_found without retries is', async () => {
      server.enqueue('validate-not-found');

      const validation = await client.validations.waitFor(VALIDATION_ID, {
        sleep: pauses().sleep,
      });

      assert.equal(validation.attributes.status, 'not_found');
      assert.equal(server.requests.length, 1);
    });

    it('gives up when the time runs out', async () => {
      server.enqueue('validation-retrying', 2);

      await assert.rejects(
        () => client.validations.waitFor(VALIDATION_ID, { timeoutMs: 0, sleep: pauses().sleep }),
        (error: unknown) => {
          assert.ok(error instanceof TimeoutError);
          assert.equal(error.validationId, VALIDATION_ID);
          assert.equal(error.timeoutMs, 0);
          return true;
        },
      );
    });

    it('an API error propagates', async () => {
      server.enqueue('cep-404');

      await assert.rejects(
        () => client.validations.waitFor(VALIDATION_ID, { sleep: pauses().sleep }),
        NotFoundError,
      );
    });
  });

  describe('isSettled', () => {
    const validation = (status: string, retryState?: Record<string, unknown>): Validation =>
      ({
        id: VALIDATION_ID,
        type: 'validation',
        attributes: { status, ...(retryState ? { retry_state: retryState } : {}) },
      }) as unknown as Validation;

    const cases: [string, Validation, boolean][] = [
      ['valid without retries', validation('valid', { enabled: false }), true],
      ['valid without retry_state', validation('valid'), true],
      ['not_found without retry_state', validation('not_found'), true],
      ['queued', validation('queued'), false],
      ['processing', validation('processing'), false],
      [
        'not_found with an active cycle and a null terminal_state',
        validation('not_found', { enabled: true, terminal_state: null }),
        false,
      ],
      [
        'not_found with an active cycle and terminal_state pending',
        validation('not_found', { enabled: true, terminal_state: 'pending' }),
        false,
      ],
      [
        'not_found with exhausted retries',
        validation('not_found', { enabled: true, terminal_state: 'exhausted' }),
        true,
      ],
      [
        'not_found with canceled retries',
        validation('not_found', { enabled: false, terminal_state: 'cancelled' }),
        true,
      ],
      [
        'valid after the cycle resolves',
        validation('valid', { enabled: true, terminal_state: 'resolved' }),
        true,
      ],
    ];

    for (const [label, subject, expected] of cases) {
      it(label, () => {
        assert.equal(isSettled(subject), expected);
      });
    }
  });

  describe('list e iter', () => {
    it('list returns a page with its counters', async () => {
      server.enqueue('validations-page1');

      const page = await client.validations.list({ perPage: 2, status: 'valid' });

      assert.equal(page.items.length, 2);
      assert.equal(page.page, 1);
      assert.equal(page.perPage, 2);
      assert.equal(page.total, 3);
      assert.equal(page.totalPages, 2);
      assert.equal(page.hasNext, true);
      assert.deepEqual(
        page.items.map((item) => item.attributes.status),
        ['valid', 'not_found'],
      );
      assert.equal(page.items[0]?.attributes.tracking_key, 'MXBA20250315001234');
      assert.equal(query(0).get('per_page'), '2');
      assert.equal(query(0).get('status'), 'valid');
    });

    it('an empty list has no next page', async () => {
      server.enqueue('validations-empty');

      const page = await client.validations.list();

      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
      assert.equal(page.hasNext, false);
    });

    it('without filters the path goes clean', async () => {
      server.enqueue('validations-page1');

      await client.validations.list();

      assert.equal(server.request(0).url, '/v1/validations');
    });

    it('the filters travel under the API name', async () => {
      server.enqueue('validations-page1');

      await client.validations.list({
        status: ['valid', 'not_found'],
        type: 'ocr',
        from: '2025-03-01',
        to: '2025-03-31',
        playground: true,
        withDeleted: true,
        batchId: 42,
        amountMin: 1000.5,
        retryState: 'pending',
        page: 3,
        perPage: 50,
      });

      const sent = query(0);
      assert.equal(sent.get('status'), 'valid,not_found');
      assert.equal(sent.get('type'), 'ocr');
      assert.equal(sent.get('from'), '2025-03-01');
      assert.equal(sent.get('to'), '2025-03-31');
      assert.equal(sent.get('playground'), '1');
      assert.equal(sent.get('with_deleted'), '1');
      assert.equal(sent.get('batch_id'), '42');
      assert.equal(sent.get('amount_min'), '1000.5');
      assert.equal(sent.get('retry_state'), 'pending');
      assert.equal(sent.get('page'), '3');
      assert.equal(sent.get('per_page'), '50');
    });

    it('clientRef filters the listing, the export and the statistics', async () => {
      server.enqueue('validations-page1');
      server.enqueue('validations-export-csv');
      server.enqueue('validations-stats');

      await client.validations.list({ clientRef: 'order 4812' });
      await client.validations.export({ clientRef: 'order 4812' });
      await client.validations.stats({ clientRef: 'order 4812' });

      for (const index of [0, 1, 2]) {
        assert.equal(query(index).get('client_ref'), 'order 4812');
      }
    });

    it('withDeleted false asks for the active ones only, and playground false does not travel', async () => {
      server.enqueue('validations-page1');

      await client.validations.list({ withDeleted: false });

      assert.equal(query(0).get('with_deleted'), '0');
      assert.equal(query(0).has('playground'), false);
    });

    it('iter requests the next page on its own', async () => {
      server.enqueue('validations-page1');
      server.enqueue('validations-page2');

      const seen: string[] = [];
      for await (const validation of client.validations.iter({ perPage: 2 })) {
        seen.push(validation.id);
      }

      assert.equal(seen.length, 3);
      assert.equal(server.requests.length, 2);
      assert.equal(query(1).get('page'), '2');
    });

    it('iter requests nothing until it is consumed', () => {
      client.validations.iter({ perPage: 2 });

      assert.equal(server.requests.length, 0);
    });

    it('iter stops at the last page', async () => {
      server.enqueue('validations-page2');

      const seen: string[] = [];
      for await (const validation of client.validations.iter({ page: 2, perPage: 2 })) {
        seen.push(validation.id);
      }

      assert.equal(seen.length, 1);
      assert.equal(server.requests.length, 1);
    });

    it('iter respects maxPages', async () => {
      server.enqueue('validations-page1');

      const seen: string[] = [];
      for await (const validation of client.validations.iter({ perPage: 2, maxPages: 1 })) {
        seen.push(validation.id);
      }

      assert.equal(seen.length, 2);
      assert.equal(server.requests.length, 1);
    });

    it('cutting the walk mid-page does not spend extra requests', async () => {
      server.enqueue('validations-page1');

      for await (const validation of client.validations.iter({ perPage: 2 })) {
        assert.ok(validation.id);
        break;
      }

      assert.equal(server.requests.length, 1);
    });

    it('stats carries the same filters', async () => {
      server.enqueue('validations-stats');

      const stats = await client.validations.stats({ from: '2025-03-01', withDeleted: false });

      assert.equal(stats.attributes?.total, 47);
      assert.equal(stats.attributes.by_type?.ocr, 17);
      assert.equal(server.request(0).url.startsWith('/v1/validations/stats?'), true);
      assert.equal(query(0).get('from'), '2025-03-01');
      assert.equal(query(0).get('with_deleted'), '0');
    });
  });

  describe('retries', () => {
    it('lists the attempts of the cycle', async () => {
      server.enqueue('retry-attempts');

      const attempts = await client.validations.retryAttempts(VALIDATION_ID);

      assert.deepEqual(
        attempts.map((attempt) => attempt.attempt_number),
        [1, 2],
      );
      assert.equal(attempts[1]?.new_status, 'valid');
    });

    it('changing the policy wraps the body in retry_policy', async () => {
      server.enqueue('retry-policy-updated');

      const result = await client.validations.setRetryPolicy(VALIDATION_ID, {
        enabled: true,
        max_retries: 3,
        interval_seconds: 600,
        outcomes: ['not_found'],
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.url, `/v1/validations/${VALIDATION_ID}/retry-policy`);
      assert.deepEqual(server.json(0), {
        retry_policy: {
          enabled: true,
          max_retries: 3,
          interval_seconds: 600,
          outcomes: ['not_found'],
        },
      });
      assert.equal(result.attributes?.retry_state?.terminal_state, 'pending');
      assert.ok(server.header(0, 'idempotency-key'));
    });

    it('changing the policy accepts an idempotency key', async () => {
      server.enqueue('retry-policy-updated');

      await client.validations.setRetryPolicy(
        VALIDATION_ID,
        { enabled: false },
        { idempotencyKey: 'order-9' },
      );

      assert.equal(server.header(0, 'idempotency-key'), 'order-9');
    });

    it('cancel the pending retries', async () => {
      server.enqueue('retries-cancelled');

      const result = await client.validations.cancelRetries(VALIDATION_ID);

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, `/v1/validations/${VALIDATION_ID}/cancel-retries`);
      assert.equal(sent.body.length, 0);
      assert.equal(result.attributes?.retry_state?.terminal_state, 'cancelled');
      assert.equal(result.attributes.retry_state.cancelled_at, '2025-03-15T15:00:00Z');
    });
  });

  describe('files', () => {
    it('downloads the receipt image', async () => {
      server.enqueue('validation-image');

      const image = await client.validations.image(VALIDATION_ID);

      assert.equal(Buffer.from(image.content).subarray(0, 4).toString('latin1'), '\x89PNG');
      assert.equal(image.contentType, 'image/png');
      assert.equal(image.filename, `comprobante-${VALIDATION_ID}.png`);
      assert.match(server.header(0, 'accept') ?? '', /image\/png/);
    });

    it('downloads the receipt as PDF with its extension', async () => {
      server.enqueue('validation-image-pdf');

      const file = await client.validations.image(VALIDATION_ID);

      assert.equal(Buffer.from(file.content).subarray(0, 5).toString('latin1'), '%PDF-');
      assert.equal(file.contentType, 'application/pdf');
      assert.equal(file.filename, `comprobante-${VALIDATION_ID}.pdf`);
      assert.match(server.header(0, 'accept') ?? '', /application\/pdf/);
    });

    it('exports the history as CSV', async () => {
      server.enqueue('validations-export-csv');

      const file = await client.validations.export({ status: 'valid', limit: 100 });

      assert.equal(query(0).get('format'), 'csv');
      assert.equal(query(0).get('status'), 'valid');
      assert.equal(query(0).get('limit'), '100');
      assert.match(server.header(0, 'accept') ?? '', /^text\/csv/);
      assert.equal(file.filename, 'validaciones-2025-03.csv');
      assert.equal(file.contentType, 'text/csv; charset=utf-8');
      assert.equal(Buffer.from(file.content).toString('utf8').startsWith('id,fecha,monto'), true);
    });

    it('exports the history as XLSX', async () => {
      server.enqueue('validations-export-xlsx');

      const file = await client.validations.export({ format: 'xlsx' });

      assert.equal(query(0).get('format'), 'xlsx');
      assert.match(server.header(0, 'accept') ?? '', /spreadsheetml\.sheet/);
      assert.equal(file.filename, 'veriko_validaciones_2025-03-15.xlsx');
      assert.equal(Buffer.from(file.content).subarray(0, 2).toString('latin1'), 'PK');
    });

    it('an export format outside the list does not reach the API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` is not an export format
        () => client.validations.export({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('cep through the family and through the root shortcut return the same', async () => {
      server.enqueue('cep-pdf', 2);

      const fromFamily = await client.validations.cep(VALIDATION_ID, { format: 'pdf' });
      const fromRoot = await client.getCep(VALIDATION_ID, { format: 'pdf' });

      assert.equal(fromFamily.filename, fromRoot.filename);
      assert.deepEqual(fromFamily.content, fromRoot.content);
      assert.equal(server.request(0).url, server.request(1).url);
    });
  });

  describe('remove and send', () => {
    it('removes a validation from the history', async () => {
      server.enqueue('no-content');

      await client.validations.delete(VALIDATION_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, `/v1/validations/${VALIDATION_ID}`);
    });

    it('sends the receipt to Telegram', async () => {
      server.enqueue('telegram-accepted');

      const dispatch = await client.validations.sendCepToTelegram(VALIDATION_ID);

      assert.equal(dispatch.attributes?.queued, true);
      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, `/v1/validations/${VALIDATION_ID}/cep/send-telegram`);
    });
  });

  describe('several candidate accounts', () => {
    it('enqueue carries them on both paths', async () => {
      server.enqueue('validate-queued', 2);
      const candidates = ['012180004412345678', '002010077777777771'];

      await client.validations.enqueue({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        candidateAccounts: candidates,
      });
      await client.validations.enqueueOcr({
        image: Buffer.from('png'),
        candidateAccounts: candidates,
      });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.deepEqual(server.json(0)['candidate_accounts'], candidates);
      assert.equal('beneficiary_account' in server.json(0), false);
      assert.equal(server.request(1).url, '/v1/validate-ocr?async=1');
      assert.deepEqual(server.json(1)['candidate_accounts'], candidates);
    });

    it('validating an image with candidates does not send the account', async () => {
      server.enqueue('validate-ocr');

      await client.validations.validateOcr({
        imageUrl: 'https://example.mx/comprobante.png',
        candidateAccounts: ['012180004412345678', '002010077777777771'],
      });

      assert.deepEqual(server.json(0), {
        image_url: 'https://example.mx/comprobante.png',
        candidate_accounts: ['012180004412345678', '002010077777777771'],
      });
    });
  });

  describe('retainImage', () => {
    it('false travels and the validation says it does not keep the file', async () => {
      server.enqueue('validate-ocr-not-retained');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        retainImage: false,
      });

      assert.equal(server.json(0)['retain_image'], false);
      assert.equal(validation.attributes.image_retained, false);
      assert.equal(validation.attributes.image_path, undefined);
    });

    it('without retainImage it does not travel and the validation reports nothing', async () => {
      server.enqueue('validate-ocr');

      const validation = await client.validations.validateOcr({ image: Buffer.from('png') });

      assert.equal('retain_image' in server.json(0), false);
      assert.equal(validation.attributes.image_retained, undefined);
      assert.equal(validation.attributes.purged_at, undefined);
    });

    it('true also travels on the asynchronous path', async () => {
      server.enqueue('validate-queued');

      await client.validations.enqueueOcr({ image: Buffer.from('png'), retainImage: true });

      assert.equal(server.json(0)['retain_image'], true);
    });
  });

  describe('corrected banks', () => {
    it('senderBank and receiverBank travel in the OCR body', async () => {
      server.enqueue('validate-queued');

      await client.validations.enqueueOcr({
        image: Buffer.from('png'),
        senderBank: '40012',
        receiverBank: '40002',
      });

      assert.equal(server.json(0)['sender_bank'], '40012');
      assert.equal(server.json(0)['receiver_bank'], '40002');
    });

    it('without them the body does not carry them', async () => {
      server.enqueue('validate-ocr');

      await client.validations.validateOcr({ image: Buffer.from('png') });

      assert.equal('sender_bank' in server.json(0), false);
      assert.equal('receiver_bank' in server.json(0), false);
    });

    it('several banks travel comma-separated', async () => {
      server.enqueue('validations-page1');
      server.enqueue('validations-stats');

      await client.validations.list({ banks: ['40012', '40014'], bank: '40072' });
      await client.validations.stats({ banks: '40012,40014' });

      assert.equal(query(0).get('banks'), '40012,40014');
      assert.equal(query(0).get('bank'), '40072');
      assert.equal(query(1).get('banks'), '40012,40014');
    });
  });

  describe('recheck', () => {
    it('a validation that changes to returned', async () => {
      server.enqueue('validation-recheck-returned');

      const result = await client.validations.recheck(VALIDATION_ID);

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, `/v1/validations/${VALIDATION_ID}/recheck`);
      assert.equal(sent.body.length, 0);
      assert.equal(result.changed, true);
      assert.equal(result.previousStatus, 'valid');
      assert.equal(result.checkedAt, '2026-10-02T09:15:44Z');
      assert.equal(result.validation.id, VALIDATION_ID);
      assert.equal(result.validation.attributes.status, 'returned');
      assert.equal(hasCep(result.validation), true);
    });

    it('a validation that stays valid', async () => {
      server.enqueue('validation-recheck-unchanged');

      const result = await client.validations.recheck(VALIDATION_ID);

      assert.equal(result.changed, false);
      assert.equal(result.previousStatus, 'valid');
      assert.equal(result.validation.attributes.status, 'valid');
    });

    it('the payment status is stored in banxico_result', async () => {
      server.enqueue('validation-recheck-returned');

      const { validation } = await client.validations.recheck(VALIDATION_ID);

      const status = (validation.attributes.banxico_result as { _payment_status?: PaymentStatus })
        ._payment_status;
      assert.equal(status?.code, 'devuelto');
      assert.equal(status.reversed, true);
      assert.equal(status.settled, false);
    });

    it('an early recheck is not retried on its own', async () => {
      server.enqueue('validate-429');

      await assert.rejects(
        () => client.validations.recheck(VALIDATION_ID),
        (error: unknown) => {
          assert.ok(error instanceof RateLimitError);
          assert.equal(error.retryAfter, 7);
          return true;
        },
      );

      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('a recheck with Banxico down is not retried on its own', async () => {
      server.enqueue('validate-503');

      await assert.rejects(
        () => client.validations.recheck(VALIDATION_ID),
        (error: unknown) => {
          assert.ok(error instanceof ServerError);
          assert.equal(error.status, 503);
          return true;
        },
      );

      assert.equal(server.requests.length, 1);
    });

    it('a purged validation answers 410', async () => {
      server.enqueue('validation-purged-410');

      await assert.rejects(
        () => client.validations.recheck(VALIDATION_ID),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 410);
          assert.equal(error.code, 'validation_purged');
          return true;
        },
      );
    });
  });

  describe('permanent purge', () => {
    const TOKEN = 'eyJhZG1pbl9pZCI6Ii4uLiJ9.q1w2e3r4t5y6u7i8o9p0';

    it('prepare returns the token and what would be deleted', async () => {
      server.enqueue('validation-purge-prepare');

      const preparation = await client.validations.preparePurge(VALIDATION_ID);

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, `/v1/validations/${VALIDATION_ID}/purge/prepare`);
      assert.equal(sent.body.length, 0);
      assert.equal(preparation.id, VALIDATION_ID);
      assert.equal(preparation.attributes.confirmation_token, TOKEN);
      assert.equal(preparation.attributes.expires_in, 120);
      assert.equal(preparation.attributes.irreversible, true);
      assert.equal(preparation.attributes.will_delete.image, true);
      assert.equal(preparation.attributes.will_keep.includes('purged_at'), true);
      assert.equal(preparation.attributes.refunds_quota, false);
      assert.deepEqual(preparation.attributes.same_image_validation_ids, []);
    });

    it('execute sends the token and returns what was deleted', async () => {
      server.enqueue('validation-purge-executed');

      const result = await client.validations.executePurge(VALIDATION_ID, {
        confirmationToken: TOKEN,
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, `/v1/validations/${VALIDATION_ID}/purge/execute`);
      assert.deepEqual(server.json(0), { confirmation_token: TOKEN });
      assert.equal(result.id, VALIDATION_ID);
      assert.equal(result.attributes.purged_at, '2026-10-02T09:30:00Z');
      assert.equal(result.attributes.file_removal, 'complete');
      assert.equal(result.attributes.deleted.webhook_deliveries, 1);
    });

    it('execute without a token does not call the API', async () => {
      await assert.rejects(
        () => client.validations.executePurge(VALIDATION_ID, { confirmationToken: '' }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'confirmation_token_missing');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('execute is not retried on its own', async () => {
      server.enqueue('validate-503');
      server.enqueue('validation-purge-executed');

      await assert.rejects(
        () => client.validations.executePurge(VALIDATION_ID, { confirmationToken: TOKEN }),
        ServerError,
      );

      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('a purged validation stays as a tombstone', async () => {
      server.enqueue('validation-purged-tombstone');

      const validation = await client.validations.get(VALIDATION_ID);

      assert.equal(validation.attributes.purged_at, '2026-10-02T09:30:00Z');
      assert.equal(validation.attributes.status, 'valid');
      assert.deepEqual(validation.attributes.normalized_data, { amount: 15000.5 });
      assert.equal(validation.attributes.request_data, undefined);
      assert.equal(hasCep(validation), false);
    });
  });
});
