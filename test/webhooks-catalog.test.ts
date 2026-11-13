/** The `client.webhooks` and `client.catalog` families. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ApiError,
  ConfigurationError,
  InvalidRequestError,
  NotFoundError,
  Veriko,
  type CreateWebhookParams,
} from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const WEBHOOK_ID = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

describe('client.webhooks and client.catalog', () => {
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

  /** The query of request `index`, already parsed. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  describe('endpoints', () => {
    it('registering an endpoint returns the secret', async () => {
      server.enqueue('webhook-created');

      const endpoint = await client.webhooks.create({
        url: 'https://myapp.example.com/hooks/payments',
        events: ['validation.completed'],
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/webhooks');
      assert.deepEqual(server.json(0), {
        url: 'https://myapp.example.com/hooks/payments',
        events: ['validation.completed'],
      });
      // The secret travels once, on registration.
      assert.equal(
        endpoint.attributes.secret,
        'a0b1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff',
      );
      assert.equal(endpoint.id, WEBHOOK_ID);
      assert.equal(endpoint.attributes.status, 'active');
    });

    it('the label travels as description', async () => {
      server.enqueue('webhook-created');

      await client.webhooks.create({
        url: 'https://myapp.example.com/hooks/payments',
        events: ['validation.completed'],
        description: 'Cash payments',
      });

      assert.equal(server.json(0)['description'], 'Cash payments');
    });

    it('registering without events does not reach the API', async () => {
      const expectRejected = (params: CreateWebhookParams): Promise<void> =>
        assert.rejects(
          () => client.webhooks.create(params),
          (error: unknown) => {
            assert.ok(error instanceof InvalidRequestError);
            assert.equal(error.code, 'events_required');
            return true;
          },
        );

      await expectRejected({ url: 'https://myapp.example.com/hooks', events: [] });
      // From JavaScript, `events` can be missing altogether.
      await expectRejected({ url: 'https://myapp.example.com/hooks' } as CreateWebhookParams);

      assert.equal(server.requests.length, 0);
    });

    it('listing endpoints carries no secrets', async () => {
      server.enqueue('webhooks-list');

      const endpoints = await client.webhooks.list();

      assert.equal(server.request(0).url, '/v1/webhooks');
      assert.equal(endpoints.length, 2);
      assert.equal(
        endpoints.every((endpoint) => endpoint.attributes.secret === undefined),
        true,
      );
      assert.equal(endpoints[0]?.attributes.secret_hint, '...b6c7');
      assert.equal(endpoints[1]?.attributes.status, 'auto_disabled');
      assert.equal(endpoints[1].attributes.consecutive_failures, 3);
    });

    it('change the subscribed events', async () => {
      server.enqueue('webhook-updated');

      const endpoint = await client.webhooks.update(WEBHOOK_ID, {
        events: ['validation.completed', 'validation.failed'],
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.url, `/v1/webhooks/${WEBHOOK_ID}`);
      assert.deepEqual(server.json(0), { events: ['validation.completed', 'validation.failed'] });
      assert.equal(endpoint.attributes.events.length, 2);
    });

    it('reactivate a disabled endpoint', async () => {
      server.enqueue('webhook-updated');

      await client.webhooks.update(WEBHOOK_ID, { status: 'active' });

      assert.deepEqual(server.json(0), { status: 'active' });
    });

    it('description null clears the label', async () => {
      server.enqueue('webhook-updated');

      await client.webhooks.update(WEBHOOK_ID, { description: null });

      assert.deepEqual(server.json(0), { description: null });
    });

    it('an empty change does not reach the API', async () => {
      await assert.rejects(
        () => client.webhooks.update(WEBHOOK_ID, {}),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'empty_update');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('emptying the events does not reach the API', async () => {
      await assert.rejects(
        () => client.webhooks.update(WEBHOOK_ID, { events: [] }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'events_required');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('remove an endpoint', async () => {
      server.enqueue('no-content');

      await client.webhooks.delete(WEBHOOK_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}`);
    });

    it('test event delivered', async () => {
      server.enqueue('webhook-test-ok');

      const result = await client.webhooks.test(WEBHOOK_ID);

      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}/test`);
      assert.equal(result.attributes?.delivered, true);
      assert.equal(result.attributes.http_status, 200);
      // The contract requires `error` and declares it `string | null`: in a
      // successful delivery it travels as null, not absent.
      assert.equal(result.attributes.error, null);
    });

    it('a failed test event explains the reason', async () => {
      server.enqueue('webhook-test-failed');

      const result = await client.webhooks.test(WEBHOOK_ID);

      assert.equal(result.attributes?.delivered, false);
      assert.match(result.attributes.error ?? '', /tiempo límite/);
    });

    it('rotating the secret returns the new one', async () => {
      server.enqueue('webhook-secret-rotated');

      const endpoint = await client.webhooks.regenerateSecret(WEBHOOK_ID);

      assert.equal(
        endpoint.attributes.secret,
        'ffeeddccbbaa99887766554433221100f9e8d7c6b5a4938271605f4e3d2c1b0a',
      );
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}/regenerate-secret`);
    });
  });

  describe('deliveries', () => {
    it('those of one endpoint', async () => {
      server.enqueue('webhook-deliveries');

      const page = await client.webhooks.deliveries(WEBHOOK_ID, { perPage: 2 });

      assert.equal(
        server.request(0).url.startsWith(`/v1/webhooks/${WEBHOOK_ID}/deliveries?`),
        true,
      );
      assert.equal(query(0).get('per_page'), '2');
      assert.equal(page.items.length, 2);
      assert.equal(page.items[0]?.attributes.status, 'success');
      assert.equal(page.items[0].attributes.response_status, 200);
      assert.equal(page.items[1]?.attributes.status, 'retrying');
      assert.equal(page.items[1].attributes.error_message, 'Service Unavailable');
    });

    it('those of all endpoints accept filters', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries({ status: 'retrying', eventType: 'validation.completed' });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('status'), 'retrying');
      assert.equal(query(0).get('event_type'), 'validation.completed');
      assert.equal(query(0).has('endpoint_id'), false);
    });

    it('with an endpoint and a filter the global listing is queried', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries(WEBHOOK_ID, { status: 'failed' });

      // The per-endpoint route does not accept `status`: the filter would be dropped silently.
      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('endpoint_id'), WEBHOOK_ID);
      assert.equal(query(0).get('status'), 'failed');
    });

    it('multi-value filters travel comma-separated', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries({
        status: ['failed', 'retrying'],
        eventType: ['validation.completed', 'validation.returned'],
        responseStatus: ['5xx', 404, 'none'],
        from: '2026-10-01',
        minAttempt: 2,
      });

      assert.equal(query(0).get('status'), 'failed,retrying');
      assert.equal(query(0).get('event_type'), 'validation.completed,validation.returned');
      assert.equal(query(0).get('response_status'), '5xx,404,none');
      assert.equal(query(0).get('from'), '2026-10-01');
      assert.equal(query(0).get('min_attempt'), '2');
    });

    it('several endpoints query the global listing', async () => {
      server.enqueue('webhook-deliveries');
      const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

      await client.webhooks.deliveries([WEBHOOK_ID, other]);

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('endpoint_id'), `${WEBHOOK_ID},${other}`);
    });

    it('with an endpoint and a new filter the global listing is also queried', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries(WEBHOOK_ID, { minResponseTimeMs: 3000 });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('endpoint_id'), WEBHOOK_ID);
      assert.equal(query(0).get('min_response_time_ms'), '3000');
    });

    it('iterDeliveries with a single page requests no other', async () => {
      server.enqueue('webhook-deliveries');

      const seen: string[] = [];
      for await (const delivery of client.webhooks.iterDeliveries(WEBHOOK_ID)) {
        seen.push(delivery.id);
      }

      assert.equal(seen.length, 2);
      assert.equal(server.requests.length, 1);
    });

    it('iterDeliveries requests the next page on its own', async () => {
      server.enqueue('webhook-deliveries-page1');
      server.enqueue('webhook-deliveries-page2');

      const seen: string[] = [];
      for await (const delivery of client.webhooks.iterDeliveries(WEBHOOK_ID, { perPage: 2 })) {
        seen.push(delivery.id);
      }

      assert.deepEqual(seen, ['1041', '1042', '1043']);
      assert.equal(server.requests.length, 2);
      assert.equal(query(1).get('page'), '2');
      assert.equal(
        server.request(1).url.startsWith(`/v1/webhooks/${WEBHOOK_ID}/deliveries?`),
        true,
      );
    });

    it('iterDeliveries without an endpoint walks the global listing', async () => {
      server.enqueue('webhook-deliveries-page1');
      server.enqueue('webhook-deliveries-page2');

      const seen: string[] = [];
      for await (const delivery of client.webhooks.iterDeliveries({ status: 'failed' })) {
        seen.push(delivery.id);
      }

      assert.equal(seen.length, 3);
      assert.equal(server.request(1).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(1).get('status'), 'failed');
      assert.equal(query(1).get('page'), '2');
    });

    it('export those of one endpoint', async () => {
      server.enqueue('deliveries-export-csv');

      const file = await client.webhooks.exportDeliveries(WEBHOOK_ID, { format: 'csv' });

      assert.equal(
        server.request(0).url.startsWith(`/v1/webhooks/${WEBHOOK_ID}/deliveries/export?`),
        true,
      );
      assert.equal(query(0).get('format'), 'csv');
      assert.equal(file.filename, 'entregas-2025-03.csv');
      assert.equal(
        Buffer.from(file.content).toString('utf8').startsWith('id,event_type,status'),
        true,
      );
    });

    it('export those of all, with filters', async () => {
      server.enqueue('deliveries-export-csv');

      await client.webhooks.exportDeliveries({ status: 'failed', limit: 50 });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries/export?'), true);
      assert.equal(query(0).get('status'), 'failed');
      assert.equal(query(0).get('limit'), '50');
    });

    it('exporting those of one endpoint with a new filter goes to the global listing', async () => {
      server.enqueue('deliveries-export-csv');

      await client.webhooks.exportDeliveries(WEBHOOK_ID, {
        q: 'erp.example.com',
        to: '2026-10-15',
        limit: 20,
      });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries/export?'), true);
      assert.equal(query(0).get('endpoint_id'), WEBHOOK_ID);
      assert.equal(query(0).get('q'), 'erp.example.com');
      assert.equal(query(0).get('to'), '2026-10-15');
      assert.equal(query(0).get('limit'), '20');
    });

    it('exporting with a format outside the list does not reach the API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` is not an export format
        () => client.webhooks.exportDeliveries({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('catalog', () => {
    it('the bank catalog', async () => {
      server.enqueue('banks');

      const banks = await client.catalog.banks();

      assert.equal(server.request(0).url, '/v1/public/banks');
      assert.equal(banks.length, 3);
      assert.equal(banks[0]?.attributes.code, '40012');
      assert.equal(banks[0].attributes.name, 'BBVA MEXICO');
      assert.deepEqual(banks[0].attributes.aliases, ['bancomer', 'bbva bancomer']);
      assert.equal(banks.etag, '"a1b2c3d4e5f6"');
    });

    it('the catalog accepts ETag, and a 304 is thrown as ApiError', async () => {
      server.enqueue('not-modified');

      await assert.rejects(
        () => client.catalog.banks({ ifNoneMatch: '"a1b2c3d4e5f6"' }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 304);
          return true;
        },
      );

      assert.equal(server.header(0, 'if-none-match'), '"a1b2c3d4e5f6"');
    });

    it('the issuing bank of a card', async () => {
      server.enqueue('bin-lookup');

      const bin = await client.catalog.binLookup('455632');

      assert.equal(server.request(0).url, '/v1/public/bin-lookup/455632');
      assert.equal(bin.attributes.bank_name, 'BBVA MEXICO');
      assert.equal(bin.attributes.banxico_code, '40012');
      assert.equal(bin.attributes.card_brand, 'VISA');
    });

    it('the SPEI non-business-day calendar of a year', async () => {
      server.enqueue('spei-calendar');

      const calendar = await client.catalog.speiCalendar(2026);

      assert.equal(server.request(0).url, '/v1/public/spei-calendar/2026');
      assert.equal(calendar.attributes.year, 2026);
      assert.equal(calendar.attributes.non_business_days.length, 10);
      assert.equal(calendar.attributes.non_business_days[0], '2026-01-01');
      assert.equal(calendar.attributes.source.issuer, 'CNBV');
      assert.equal(calendar.attributes.source.published_on, '2025-12-10');
      assert.deepEqual(calendar.coveredYears, [2024, 2025, 2026]);
      assert.equal(calendar.etag, '"a1b2c3d4e5f6"');
    });

    it('the SPEI calendar accepts ETag, and a 304 is thrown as ApiError', async () => {
      server.enqueue('not-modified');

      await assert.rejects(
        () => client.catalog.speiCalendar(2026, { ifNoneMatch: '"a1b2c3d4e5f6"' }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 304);
          return true;
        },
      );

      assert.equal(server.header(0, 'if-none-match'), '"a1b2c3d4e5f6"');
    });

    it('a year with no SPEI calendar is thrown as NotFoundError', async () => {
      server.enqueue('spei-calendar-404');

      await assert.rejects(
        () => client.catalog.speiCalendar(2030),
        (error: unknown) => {
          assert.ok(error instanceof NotFoundError);
          assert.equal(error.code, 'spei_calendar_year_not_covered');
          return true;
        },
      );
    });

    it('the status of the Banxico service', async () => {
      server.enqueue('banxico-status');

      const status = await client.catalog.banxicoStatus();

      assert.equal(server.request(0).url, '/v1/status/banxico');
      assert.equal(status.attributes.status, 'operational');
      assert.equal(status.attributes.status_label, 'Operativo');
    });

    it('the time series of the service', async () => {
      server.enqueue('banxico-timeseries');

      const series = await client.catalog.banxicoTimeseries({
        metric: 'probe_latency',
        window: '24h',
      });

      assert.equal(query(0).get('metric'), 'probe_latency');
      assert.equal(query(0).get('window'), '24h');
      assert.equal(series.attributes.unit, 'ms');
      assert.equal(series.attributes.points?.length, 2);
      assert.equal(series.attributes.points[0]?.value, 1523);
    });

    it('without arguments the time series goes with no query', async () => {
      server.enqueue('banxico-timeseries');

      await client.catalog.banxicoTimeseries();

      assert.equal(server.request(0).url, '/v1/status/banxico/timeseries');
    });
  });
});
