/** Validar una transferencia: lo que se envía y lo que se lee de vuelta. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { InvalidRequestError, Veriko, hasCep, isTerminal } from '../src/index.js';
import { RecordingServer, makeClient } from './harness.js';

describe('validateTransfer', () => {
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

  it('el veredicto valid trae comprobante', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      fecha: '2025-03-15',
      monto: 15000.5,
      claveRastreo: 'MXBA20250315001234',
      referenciaNumerica: '1234567',
      emisor: 'BANCO NACIONAL DE MEXICO',
      receptor: 'BBVA MEXICO',
      cuentaBeneficiaria: '012180004412345678',
    });

    assert.equal(validation.attributes.status, 'valid');
    assert.equal(validation.attributes.banxico_status, 'valid');
    assert.equal(validation.id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(validation.attributes.processing_time_ms, 1320);
    assert.equal(hasCep(validation), true);
    assert.equal(isTerminal(validation.attributes.status), true);
  });

  it('el veredicto not_found no trae comprobante', async () => {
    server.enqueue('validate-not-found');

    const validation = await client.validateTransfer({
      fecha: '2025-03-16',
      monto: 15000.5,
      claveRastreo: 'MXBA20250316000001',
    });

    assert.equal(validation.attributes.status, 'not_found');
    assert.equal(hasCep(validation), false);
  });

  it('el veredicto returned sigue entregando el comprobante', async () => {
    server.enqueue('validate-returned');

    const validation = await client.validateTransfer({
      fecha: '2025-03-15',
      monto: 15000.5,
      claveRastreo: 'MXBA20250315001234',
    });

    assert.equal(validation.attributes.status, 'returned');
    assert.equal(hasCep(validation), true);
  });

  it('la petición lleva los campos con el nombre de la API', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      fecha: '2025-03-15',
      monto: 15000.5,
      claveRastreo: 'MXBA20250315001234',
      cuentaBeneficiaria: '012180004412345678',
      emisor: 'BANCO NACIONAL DE MEXICO',
    });

    const sent = server.request(0);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/validate');
    assert.equal(server.header(0, 'authorization'), 'Bearer veriko_prueba');
    assert.deepEqual(server.json(0), {
      fecha: '2025-03-15',
      monto: 15000.5,
      clave_rastreo: 'MXBA20250315001234',
      cuenta_beneficiaria: '012180004412345678',
      emisor: 'BANCO NACIONAL DE MEXICO',
    });
  });

  it('los campos que no se pasan no viajan', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      fecha: '2025-03-15',
      monto: 15000.5,
      claveRastreo: 'MXBA20250315001234',
    });

    const body = server.json(0);
    assert.equal('referencia_numerica' in body, false);
    assert.equal('retry_policy' in body, false);
    assert.equal('receptor' in body, false);
  });

  it('la política de reintentos viaja en el cuerpo', async () => {
    server.enqueue('validate-not-found');

    await client.validateTransfer({
      fecha: '2025-03-16',
      monto: 15000.5,
      claveRastreo: 'MXBA20250316000001',
      retryPolicy: {
        enabled: true,
        max_retries: 3,
        interval_seconds: 600,
        outcomes: ['not_found', 'cep_unavailable'],
      },
    });

    assert.deepEqual(server.json(0)['retry_policy'], {
      enabled: true,
      max_retries: 3,
      interval_seconds: 600,
      outcomes: ['not_found', 'cep_unavailable'],
    });
  });

  it('sin identificador de transferencia no se llama a la API', async () => {
    await assert.rejects(
      () => client.validateTransfer({ fecha: '2025-03-15', monto: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'clave_or_ref_required');
        return true;
      },
    );

    assert.equal(server.requests.length, 0);
  });

  it('leer una validación por su identificador', async () => {
    server.enqueue('validation-retrying');

    const validation = await client.getValidation('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    assert.equal(server.request(0).url, '/v1/validations/f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(validation.attributes.retry_state?.enabled, true);
    assert.equal(validation.attributes.retry_state.attempts_completed, 2);
    assert.equal(validation.attributes.retry_state.next_attempt_at, '2025-03-15T14:42:11Z');
  });
});
