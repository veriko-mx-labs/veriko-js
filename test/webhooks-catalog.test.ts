/** Las familias `client.webhooks` y `client.catalog`. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  ApiError,
  ConfigurationError,
  InvalidRequestError,
  Veriko,
  type CreateWebhookParams,
} from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

const WEBHOOK_ID = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

describe('client.webhooks y client.catalog', () => {
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

  /** La consulta de la petición `index`, ya interpretada. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  describe('endpoints', () => {
    it('registrar un endpoint devuelve el secreto', async () => {
      server.enqueue('webhook-created');

      const endpoint = await client.webhooks.create({
        url: 'https://miapp.example.com/hooks/pagos',
        events: ['validation.completed'],
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/webhooks');
      assert.deepEqual(server.json(0), {
        url: 'https://miapp.example.com/hooks/pagos',
        events: ['validation.completed'],
      });
      // El secreto viaja una sola vez, al registrar.
      assert.equal(endpoint.attributes.secret, 'whsec_3f9a1c7e5d2b48a6b0c1d2e3f4a5b6c7');
      assert.equal(endpoint.id, WEBHOOK_ID);
      assert.equal(endpoint.attributes.status, 'active');
    });

    it('la etiqueta viaja como description', async () => {
      server.enqueue('webhook-created');

      await client.webhooks.create({
        url: 'https://miapp.example.com/hooks/pagos',
        events: ['validation.completed'],
        description: 'Pagos de contado',
      });

      assert.equal(server.json(0)['description'], 'Pagos de contado');
    });

    it('registrar sin eventos no llega a la API', async () => {
      const expectRejected = (params: CreateWebhookParams): Promise<void> =>
        assert.rejects(
          () => client.webhooks.create(params),
          (error: unknown) => {
            assert.ok(error instanceof InvalidRequestError);
            assert.equal(error.code, 'events_required');
            return true;
          },
        );

      await expectRejected({ url: 'https://miapp.example.com/hooks', events: [] });
      // Desde JavaScript, `events` puede faltar del todo.
      await expectRejected({ url: 'https://miapp.example.com/hooks' } as CreateWebhookParams);

      assert.equal(server.requests.length, 0);
    });

    it('listar endpoints no trae secretos', async () => {
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

    it('cambiar los eventos suscritos', async () => {
      server.enqueue('webhook-updated');

      const endpoint = await client.webhooks.update(WEBHOOK_ID, {
        events: ['validation.completed', 'validation.failed'],
      });

      const sent = server.request(0);
      assert.equal(sent.method, 'PUT');
      assert.equal(sent.url, `/v1/webhooks/${WEBHOOK_ID}`);
      assert.deepEqual(server.json(0), { events: ['validation.completed', 'validation.failed'] });
      assert.equal(endpoint.attributes.events?.length, 2);
    });

    it('reactivar un endpoint apagado', async () => {
      server.enqueue('webhook-updated');

      await client.webhooks.update(WEBHOOK_ID, { status: 'active' });

      assert.deepEqual(server.json(0), { status: 'active' });
    });

    it('description null borra la etiqueta', async () => {
      server.enqueue('webhook-updated');

      await client.webhooks.update(WEBHOOK_ID, { description: null });

      assert.deepEqual(server.json(0), { description: null });
    });

    it('un cambio vacío no llega a la API', async () => {
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

    it('vaciar los eventos no llega a la API', async () => {
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

    it('retirar un endpoint', async () => {
      server.enqueue('no-content');

      await client.webhooks.delete(WEBHOOK_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}`);
    });

    it('evento de prueba entregado', async () => {
      server.enqueue('webhook-test-ok');

      const result = await client.webhooks.test(WEBHOOK_ID);

      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}/test`);
      assert.equal(result.attributes?.delivered, true);
      assert.equal(result.attributes.http_status, 200);
      assert.equal(result.attributes.error, undefined);
    });

    it('un evento de prueba fallido explica el motivo', async () => {
      server.enqueue('webhook-test-failed');

      const result = await client.webhooks.test(WEBHOOK_ID);

      assert.equal(result.attributes?.delivered, false);
      assert.match(result.attributes.error ?? '', /tiempo límite/);
    });

    it('rotar el secreto devuelve el nuevo', async () => {
      server.enqueue('webhook-secret-rotated');

      const endpoint = await client.webhooks.regenerateSecret(WEBHOOK_ID);

      assert.equal(endpoint.attributes.secret, 'whsec_a1b2c3d4e5f60718293a4b5c6d7e8f90');
      assert.equal(server.request(0).url, `/v1/webhooks/${WEBHOOK_ID}/regenerate-secret`);
    });
  });

  describe('entregas', () => {
    it('las de un endpoint', async () => {
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

    it('las de todos los endpoints admiten filtros', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries({ status: 'retrying', eventType: 'validation.completed' });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('status'), 'retrying');
      assert.equal(query(0).get('event_type'), 'validation.completed');
      assert.equal(query(0).has('endpoint_id'), false);
    });

    it('con un endpoint y un filtro se consulta el listado global', async () => {
      server.enqueue('webhook-deliveries');

      await client.webhooks.deliveries(WEBHOOK_ID, { status: 'failed' });

      // La ruta por endpoint no admite `status`: el filtro se descartaría en silencio.
      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries?'), true);
      assert.equal(query(0).get('endpoint_id'), WEBHOOK_ID);
      assert.equal(query(0).get('status'), 'failed');
    });

    it('iterDeliveries con una sola página no pide otra', async () => {
      server.enqueue('webhook-deliveries');

      const seen: string[] = [];
      for await (const delivery of client.webhooks.iterDeliveries(WEBHOOK_ID)) {
        seen.push(delivery.id);
      }

      assert.equal(seen.length, 2);
      assert.equal(server.requests.length, 1);
    });

    it('iterDeliveries pide la página siguiente sola', async () => {
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

    it('iterDeliveries sin endpoint recorre el listado global', async () => {
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

    it('exportar las de un endpoint', async () => {
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

    it('exportar las de todos, con filtros', async () => {
      server.enqueue('deliveries-export-csv');

      await client.webhooks.exportDeliveries({ status: 'failed', limit: 50 });

      assert.equal(server.request(0).url.startsWith('/v1/webhooks/deliveries/export?'), true);
      assert.equal(query(0).get('status'), 'failed');
      assert.equal(query(0).get('limit'), '50');
    });

    it('exportar con un formato fuera de la lista no llega a la API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` no es un formato de exportación
        () => client.webhooks.exportDeliveries({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('catálogo', () => {
    it('el catálogo de bancos', async () => {
      server.enqueue('banks');

      const banks = await client.catalog.banks();

      assert.equal(server.request(0).url, '/v1/public/banks');
      assert.equal(banks.length, 3);
      assert.equal(banks[0]?.attributes.code, '40012');
      assert.equal(banks[0].attributes.name, 'BBVA MEXICO');
      assert.deepEqual(banks[0].attributes.aliases, ['bancomer', 'bbva bancomer']);
      assert.equal(banks.etag, '"a1b2c3d4e5f6"');
    });

    it('el catálogo admite ETag, y un 304 se lanza como ApiError', async () => {
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

    it('el banco emisor de una tarjeta', async () => {
      server.enqueue('bin-lookup');

      const bin = await client.catalog.binLookup('455632');

      assert.equal(server.request(0).url, '/v1/public/bin-lookup/455632');
      assert.equal(bin.attributes.bank_name, 'BBVA MEXICO');
      assert.equal(bin.attributes.banxico_code, '40012');
      assert.equal(bin.attributes.card_brand, 'VISA');
    });

    it('el estado del servicio de Banxico', async () => {
      server.enqueue('banxico-status');

      const status = await client.catalog.banxicoStatus();

      assert.equal(server.request(0).url, '/v1/status/banxico');
      assert.equal(status.attributes.status, 'operational');
      assert.equal(status.attributes.status_label, 'Operativo');
    });

    it('la serie temporal del servicio', async () => {
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

    it('sin argumentos la serie temporal va sin consulta', async () => {
      server.enqueue('banxico-timeseries');

      await client.catalog.banxicoTimeseries();

      assert.equal(server.request(0).url, '/v1/status/banxico/timeseries');
    });
  });
});
