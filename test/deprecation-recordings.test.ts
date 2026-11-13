/**
 * The seven operations that announce the field-name change answer with `Deprecation`,
 * `Sunset` and `Link`, and a `meta.field_names_notice`. The recordings carry them, as the
 * 1.212.1 API sends them, so these tests exercise what an integration really receives.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Veriko, type DeprecationNotice } from '../src/index.js';
import { RecordingServer, TEST_API_KEY, loadRecording } from './harness.js';

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const AFFECTED: Array<[string, string, (client: Veriko) => Promise<unknown>]> = [
  [
    'validate-valid',
    'validate',
    (c) =>
      c.validations.validate({
        amount: 1,
        trackingKey: 'K',
        beneficiaryAccount: '012180004412345678',
      }),
  ],
  ['validations-page1', 'list', (c) => c.validations.list()],
  ['validation-queued-status', 'get', (c) => c.validations.get(ID)],
  ['validation-recheck-returned', 'recheck', (c) => c.validations.recheck(ID)],
  ['dashboard-summary', 'dashboard', (c) => c.dashboard.summary()],
  ['finance-summary', 'finance summary', (c) => c.finance.getSummary({ month: '2026-04' })],
];

describe('the recordings of the operations that announce the field-name change', () => {
  let server: RecordingServer;

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  for (const [recording, label, call] of AFFECTED) {
    it(`${label}: carries the headers and the notice, and the SDK reports them`, async () => {
      const notices: DeprecationNotice[] = [];
      const metas: Array<Record<string, unknown>> = [];
      server.enqueue(recording);
      const original = loadRecording(recording).json as { meta?: Record<string, unknown> };
      assert.equal(
        (original.meta?.['field_names_notice'] as { code?: string } | undefined)?.code,
        'legacy_response_fields',
      );

      await call(
        new Veriko({
          apiKey: TEST_API_KEY,
          baseUrl: server.baseUrl,
          maxRetries: 0,
          onDeprecation: (notice) => notices.push(notice),
          onResponse: (meta) => metas.push(meta.meta),
        }),
      );

      assert.equal(metas.length, 1);
      assert.equal(
        (metas[0]?.['field_names_notice'] as { sunset?: string } | undefined)?.sunset,
        '2027-03-01',
      );
      // The process reports each pair of headers once, so only the first call sees it.
      for (const notice of notices) {
        assert.equal(notice.sunset, 'Mon, 01 Mar 2027 00:00:00 GMT');
        assert.match(notice.link ?? '', /migrate-to-english-field-names/);
      }
    });
  }

  it('exposes Deprecation, Sunset and Retry-After through withResponse()', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl: server.baseUrl, maxRetries: 0 });
    server.enqueue('validation-queued-status');

    const { response } = await client.validations.get(ID).withResponse();

    assert.equal(response.deprecation, 'date="2026-11-11"');
    assert.equal(response.sunset, 'Mon, 01 Mar 2027 00:00:00 GMT');
    assert.match(response.link ?? '', /rel="deprecation"/);
    assert.equal(response.retryAfter, 2);
  });
});
