/** Errores por estado HTTP, reintentos e idempotencia. */

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
import { RecordingServer, makeClient } from './harness.js';

const TRANSFER = {
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
};

describe('errores de la API', () => {
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

  it('un 422 expone todas las entradas, no sólo la primera', async () => {
    server.enqueue('validate-422');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'required');
        assert.equal(error.pointer, '/data/attributes/fecha');
        assert.equal(error.errors.length, 2);
        assert.deepEqual(
          error.errors.map((entry) => entry.code),
          ['required', 'invalid_clabe_checksum'],
        );
        assert.equal(error.requestId, 'a1b2c3d4e5f6');
        return true;
      },
    );
  });

  it('un 401 es error de autenticación', async () => {
    server.enqueue('validate-401');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof AuthenticationError);
        assert.equal(error.code, 'unauthorized');
        assert.match(error.message, /HTTP 401 unauthorized/);
        assert.match(error.message, /request_id=a8b9c0d1e2f3/);
        return true;
      },
    );
  });

  it('un 409 señala la clave de idempotencia en curso', async () => {
    server.enqueue('validate-409');

    await assert.rejects(
      () => client.validateTransfer(TRANSFER),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, 'idempotency_key_in_progress');
        return true;
      },
    );
  });

  it('un 429 agotado expone los segundos de espera', async () => {
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

describe('reintentos', () => {
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

  it('un 503 se reintenta y la segunda respuesta gana', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503').enqueue('validate-valid');

    const validation = await client.validateTransfer(TRANSFER);

    assert.equal(validation.attributes.status, 'valid');
    assert.equal(server.requests.length, 2);
  });

  it('un 429 espera lo que dice Retry-After', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-429').enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    // `Retry-After: 7` gana sobre el backoff propio del cliente.
    assert.deepEqual(sleeps, [7000]);
  });

  it('un 422 no se reintenta', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-422');

    await assert.rejects(() => client.validateTransfer(TRANSFER));

    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('con maxRetries en 0 el primer 429 se lanza', async () => {
    const client = makeClient(server, sleeps, { maxRetries: 0 });
    server.enqueue('validate-429');

    await assert.rejects(() => client.validateTransfer(TRANSFER), RateLimitError);

    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it('el backoff propio se usa cuando no hay Retry-After', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503', 2).enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every((espera) => espera > 0));
    // Exponencial: la segunda espera es mayor que la primera aun con fluctuación.
    assert.ok((sleeps[1] ?? 0) > (sleeps[0] ?? 0) / 2);
  });

  it('sin servidor al otro lado se lanza un error de conexión', async () => {
    const transport = new Transport({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'veriko_x',
      timeoutMs: 500,
      retry: { ...DEFAULT_RETRY, maxRetries: 1, backoffBaseMs: 10 },
      userAgent: 'veriko-js/prueba',
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

describe('idempotencia', () => {
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

  it('la clave del integrador viaja tal cual', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid');

    await client.validateTransfer({ ...TRANSFER, idempotencyKey: 'pedido-4f3a2b1c' });

    assert.equal(server.header(0, 'idempotency-key'), 'pedido-4f3a2b1c');
  });

  it('sin clave el SDK pone una y la repite en los reintentos', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-503').enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    const primera = server.header(0, 'idempotency-key');
    const segunda = server.header(1, 'idempotency-key');
    assert.ok(primera);
    // La misma clave en el reintento: es lo que evita la validación duplicada.
    assert.equal(primera, segunda);
    assert.match(primera, /^veriko-js-[0-9a-f]{32}$/);
  });

  it('dos llamadas distintas no comparten clave', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid', 2);

    await client.validateTransfer(TRANSFER);
    await client.validateTransfer(TRANSFER);

    assert.notEqual(server.header(0, 'idempotency-key'), server.header(1, 'idempotency-key'));
  });

  it('la clave generada cumple el patrón de la API', async () => {
    const client = makeClient(server, sleeps);
    server.enqueue('validate-valid');

    await client.validateTransfer(TRANSFER);

    const clave = server.header(0, 'idempotency-key') ?? '';
    assert.ok(clave.length >= 1 && clave.length <= 255);
    assert.match(clave, /^[A-Za-z0-9_-]+$/);
  });
});

describe('Retry-After', () => {
  it('en segundos', () => {
    assert.equal(parseRetryAfter('12'), 12);
  });

  it('como fecha HTTP', () => {
    const espera = parseRetryAfter('Wed, 21 Oct 2099 07:28:00 GMT');
    assert.ok(espera !== undefined && espera > 0);
  });

  it('ausente o ilegible', () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(''), undefined);
    assert.equal(parseRetryAfter('pronto'), undefined);
  });
});
