/** La familia `client.usage`: la cuota del plan y el registro de actividad. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ConfigurationError, Veriko } from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

describe('client.usage', () => {
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

  it('la cuota del plan trae el nivel de aviso', async () => {
    server.enqueue('usage-summary');

    const summary = await client.usage.summary();

    assert.equal(server.request(0).url, '/v1/usage/summary');
    assert.equal(summary.attributes?.plan_slug, 'basic');
    assert.equal(summary.attributes.limit, 1000);
    assert.equal(summary.attributes.remaining, 580);
    assert.equal(summary.attributes.tone, 'ok');
  });

  it('el historial mensual, de más reciente a más antiguo', async () => {
    server.enqueue('usage-history');

    const history = await client.usage.history({ months: 6 });

    assert.equal(query(0).get('months'), '6');
    assert.equal(history.attributes?.history?.length, 2);
    assert.equal(history.attributes.history[0]?.period, '2026-04');
    assert.equal(history.attributes.history[0].used, 420);
  });

  it('sin argumentos, el historial va sin consulta', async () => {
    server.enqueue('usage-history');

    await client.usage.history();

    assert.equal(server.request(0).url, '/v1/usage/history');
  });

  it('el desglose por operación', async () => {
    server.enqueue('usage-breakdown');

    const breakdown = await client.usage.breakdown({ period: '2026-04' });

    assert.equal(query(0).get('period'), '2026-04');
    assert.equal(breakdown.attributes?.operations?.[0]?.operation, 'validation');
  });

  it('los límites de tasa por contexto', async () => {
    server.enqueue('usage-limits');

    const limits = await client.usage.limits();

    assert.equal(server.request(0).url, '/v1/usage/limits');
    assert.equal(limits.attributes?.rate_limits?.['login']?.ip_per_minute, 10);
    assert.equal(limits.attributes.notes?.length, 1);
  });

  it('el mapa de calor por día y hora', async () => {
    server.enqueue('usage-heatmap');

    const heatmap = await client.usage.heatmap({ days: 30 });

    assert.equal(query(0).get('days'), '30');
    assert.equal(heatmap.attributes?.max_count, 48);
    assert.equal(heatmap.attributes.buckets?.[0]?.hour_of_day, 10);
  });

  it('las métricas de uso de la API', async () => {
    server.enqueue('api-usage');

    const usage = await client.usage.apiUsage();

    assert.equal(server.request(0).url, '/v1/api/usage');
    assert.equal(usage.requests_today, 42);
    assert.equal(usage.quota?.used, 420);
  });

  it('exportar el registro de actividad en CSV', async () => {
    server.enqueue('api-usage-export-csv');

    const file = await client.usage.export({ from: '2026-05-01', to: '2026-05-16', limit: 500 });

    assert.equal(query(0).get('format'), 'csv');
    assert.equal(query(0).get('from'), '2026-05-01');
    assert.equal(query(0).get('to'), '2026-05-16');
    assert.equal(query(0).get('limit'), '500');
    assert.equal(file.filename, 'actividad_api_2026-05-16.csv');
    assert.equal(Buffer.from(file.content).toString('utf8').startsWith('fecha,hora'), true);
  });

  it('un formato de exportación fuera de la lista no llega a la API', async () => {
    await assert.rejects(
      // @ts-expect-error `pdf` no es un formato de exportación
      () => client.usage.export({ format: 'pdf' }),
      ConfigurationError,
    );

    assert.equal(server.requests.length, 0);
  });
});
