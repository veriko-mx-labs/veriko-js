/** La familia `client.validations`. */

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

  /** La consulta de la petición `index`, ya interpretada. */
  function query(index: number): URLSearchParams {
    return new URL(server.request(index).url, 'http://localhost').searchParams;
  }

  describe('validateOcr', () => {
    it('la imagen viaja en base64 cuando se pasa como bytes', async () => {
      server.enqueue('validate-ocr');
      const image = Buffer.from('\x89PNG\r\n\x1a\n imagen de prueba', 'latin1');

      const validation = await client.validations.validateOcr({
        image,
        cuentaBeneficiaria: '012180004412345678',
      });

      assert.equal(validation.attributes.validation_type, 'ocr');
      assert.equal(validation.attributes.status, 'valid');
      const sent = server.request(0);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/validate-ocr');
      const body = server.json(0);
      assert.equal(Buffer.from(String(body['image']), 'base64').equals(image), true);
      assert.equal(body['cuenta_beneficiaria'], '012180004412345678');
    });

    it('un Uint8Array y un Buffer viajan igual', async () => {
      server.enqueue('validate-ocr', 2);
      const bytes = new Uint8Array([1, 2, 3, 250, 251]);

      await client.validations.validateOcr({ image: bytes });
      await client.validations.validateOcr({ image: Buffer.from(bytes) });

      assert.equal(server.json(0)['image'], server.json(1)['image']);
      assert.equal(server.json(0)['image'], Buffer.from(bytes).toString('base64'));
    });

    it('lee la imagen de una ruta', async () => {
      server.enqueue('validate-ocr');
      const directory = mkdtempSync(join(tmpdir(), 'veriko-ocr-'));
      try {
        const file = join(directory, 'comprobante.png');
        writeFileSync(file, 'contenido del comprobante');

        await client.validations.validateOcr({ image: file });

        const sent = Buffer.from(String(server.json(0)['image']), 'base64').toString('utf8');
        assert.equal(sent, 'contenido del comprobante');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('clientRef viaja como client_ref', async () => {
      server.enqueue('validate-ocr-conflict');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        clientRef: 'orden-4812',
      });

      assert.equal(server.json(0)['client_ref'], 'orden-4812');
      assert.equal(validation.attributes.client_ref, 'orden-4812');
    });

    it('la validación expone el duplicado y el conflicto de cuenta', async () => {
      server.enqueue('validate-ocr-conflict');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        cuentaBeneficiaria: '012180004412345678',
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

    it('imageUrl viaja sola, sin image', async () => {
      server.enqueue('validate-ocr');

      await client.validations.validateOcr({ imageUrl: 'https://ejemplo.mx/comprobante.png' });

      assert.deepEqual(server.json(0), { image_url: 'https://ejemplo.mx/comprobante.png' });
    });

    it('sin imagen ni URL no se llama a la API', async () => {
      await assert.rejects(
        () => client.validations.validateOcr({}),
        (error: unknown) => {
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.code, 'image_required');
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('una ruta que no existe se detiene antes de la API', async () => {
      await assert.rejects(
        () => client.validations.validateOcr({ image: 'no-existe-este-archivo.png' }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /No existe el archivo de imagen/);
          return true;
        },
      );

      assert.equal(server.requests.length, 0);
    });

    it('genera una clave de idempotencia y respeta la que se pasa', async () => {
      server.enqueue('validate-ocr', 2);

      await client.validations.validateOcr({ imageUrl: 'https://ejemplo.mx/a.png' });
      await client.validations.validateOcr({
        imageUrl: 'https://ejemplo.mx/a.png',
        idempotencyKey: 'pedido-4f3a2b1c',
      });

      assert.match(server.header(0, 'idempotency-key') ?? '', /^veriko-js-[0-9a-f]{32}$/);
      assert.equal(server.header(1, 'idempotency-key'), 'pedido-4f3a2b1c');
    });
  });

  describe('modo asíncrono', () => {
    it('encolar devuelve el acuse sin veredicto', async () => {
      server.enqueue('validate-queued');

      const queued = await client.validations.enqueue({
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        cuentaBeneficiaria: '012180004412345678',
      });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.equal(queued.id, VALIDATION_ID);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.etag, 'W/"0-queued"');
      assert.equal(queued.location, `/v1/validations/${VALIDATION_ID}`);
      assert.equal(queued.nextPollAfterSeconds, 3);
      assert.equal(queued.data.attributes?.expires_at, '2025-03-15T15:22:10Z');
    });

    it('encolar lleva clientRef en los dos caminos', async () => {
      server.enqueue('validate-queued', 2);

      await client.validations.enqueue({
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        cuentaBeneficiaria: '012180004412345678',
        clientRef: 'orden-4812',
      });
      await client.validations.enqueueOcr({ image: Buffer.from('png'), clientRef: 'orden-4812' });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.equal(server.json(0)['client_ref'], 'orden-4812');
      assert.equal(server.request(1).url, '/v1/validate-ocr?async=1');
      assert.equal(server.json(1)['client_ref'], 'orden-4812');
    });

    it('encolar una imagen', async () => {
      server.enqueue('validate-queued');

      const queued = await client.validations.enqueueOcr({ image: Buffer.from('png') });

      assert.equal(server.request(0).url, '/v1/validate-ocr?async=1');
      assert.equal(queued.id, VALIDATION_ID);
    });

    it('encolar sin identificador de transferencia no llama a la API', async () => {
      await assert.rejects(
        () =>
          client.validations.enqueue({
            fecha: '2025-03-15',
            monto: 100,
            cuentaBeneficiaria: '012180004412345678',
          }),
        InvalidRequestError,
      );

      assert.equal(server.requests.length, 0);
    });
  });

  describe('get', () => {
    it('devuelve la validación con el ETag de la respuesta', async () => {
      server.enqueue('validation-retrying');

      const validation = await client.validations.get(VALIDATION_ID);

      assert.equal(validation.id, VALIDATION_ID);
      assert.equal(validation.etag, 'W/"3-not_found"');
      assert.equal(server.header(0, 'if-none-match'), undefined);
    });

    it('con ifNoneMatch manda la cabecera, y un 304 se lanza como ApiError', async () => {
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

    it('un identificador inservible no llega a la API', async () => {
      await assert.rejects(() => client.validations.get('a/b'), ConfigurationError);
      await assert.rejects(() => client.validations.delete('  '), ConfigurationError);

      assert.equal(server.requests.length, 0);
    });

    it('el atajo de la raíz y la familia hacen lo mismo', async () => {
      server.enqueue('validate-valid', 2);
      const params = {
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        cuentaBeneficiaria: '012180004412345678',
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

    it('sondea hasta el veredicto', async () => {
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

    it('manda el ETag de la respuesta anterior', async () => {
      server.enqueue('validation-queued-status');
      server.enqueue('validate-valid');

      await client.validations.waitFor(VALIDATION_ID, { sleep: pauses().sleep });

      assert.equal(server.header(0, 'if-none-match'), undefined);
      assert.equal(server.header(1, 'if-none-match'), 'W/"0-queued"');
    });

    it('un 304 no interrumpe el sondeo', async () => {
      server.enqueue('validation-queued-status');
      server.enqueue('not-modified');
      server.enqueue('validate-valid');

      const validation = await client.validations.waitFor(VALIDATION_ID, { sleep: pauses().sleep });

      assert.equal(validation.attributes.status, 'valid');
      assert.equal(server.requests.length, 3);
      assert.equal(server.header(1, 'if-none-match'), 'W/"0-queued"');
      assert.equal(server.header(2, 'if-none-match'), 'W/"0-queued"');
    });

    it('un not_found con reintentos en marcha no es un veredicto firme', async () => {
      server.enqueue('validation-retrying');
      server.enqueue('validate-valid');
      const { sleep, waited } = pauses();

      const validation = await client.validations.waitFor(VALIDATION_ID, { sleep });

      assert.equal(validation.attributes.status, 'valid');
      assert.equal(waited.length, 1);
    });

    it('un not_found sin reintentos sí lo es', async () => {
      server.enqueue('validate-not-found');

      const validation = await client.validations.waitFor(VALIDATION_ID, {
        sleep: pauses().sleep,
      });

      assert.equal(validation.attributes.status, 'not_found');
      assert.equal(server.requests.length, 1);
    });

    it('se rinde al agotar el tiempo', async () => {
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

    it('un error de la API se propaga', async () => {
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
      ['valid sin reintentos', validation('valid', { enabled: false }), true],
      ['valid sin retry_state', validation('valid'), true],
      ['not_found sin retry_state', validation('not_found'), true],
      ['queued', validation('queued'), false],
      ['processing', validation('processing'), false],
      [
        'not_found con el ciclo activo y terminal_state nulo',
        validation('not_found', { enabled: true, terminal_state: null }),
        false,
      ],
      [
        'not_found con el ciclo activo y terminal_state pending',
        validation('not_found', { enabled: true, terminal_state: 'pending' }),
        false,
      ],
      [
        'not_found con reintentos agotados',
        validation('not_found', { enabled: true, terminal_state: 'exhausted' }),
        true,
      ],
      [
        'not_found con reintentos cancelados',
        validation('not_found', { enabled: false, terminal_state: 'cancelled' }),
        true,
      ],
      [
        'valid tras resolverse el ciclo',
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
    it('list devuelve una página con sus contadores', async () => {
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

    it('una lista vacía no tiene página siguiente', async () => {
      server.enqueue('validations-empty');

      const page = await client.validations.list();

      assert.deepEqual(page.items, []);
      assert.equal(page.total, 0);
      assert.equal(page.hasNext, false);
    });

    it('sin filtros la ruta va limpia', async () => {
      server.enqueue('validations-page1');

      await client.validations.list();

      assert.equal(server.request(0).url, '/v1/validations');
    });

    it('los filtros viajan con el nombre de la API', async () => {
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

    it('clientRef filtra el listado, la exportación y las estadísticas', async () => {
      server.enqueue('validations-page1');
      server.enqueue('validations-export-csv');
      server.enqueue('validations-stats');

      await client.validations.list({ clientRef: 'orden 4812' });
      await client.validations.export({ clientRef: 'orden 4812' });
      await client.validations.stats({ clientRef: 'orden 4812' });

      for (const index of [0, 1, 2]) {
        assert.equal(query(index).get('client_ref'), 'orden 4812');
      }
    });

    it('withDeleted false pide sólo las activas, y playground false no viaja', async () => {
      server.enqueue('validations-page1');

      await client.validations.list({ withDeleted: false });

      assert.equal(query(0).get('with_deleted'), '0');
      assert.equal(query(0).has('playground'), false);
    });

    it('iter pide la página siguiente sola', async () => {
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

    it('iter no pide nada hasta que se consume', () => {
      client.validations.iter({ perPage: 2 });

      assert.equal(server.requests.length, 0);
    });

    it('iter se detiene en la última página', async () => {
      server.enqueue('validations-page2');

      const seen: string[] = [];
      for await (const validation of client.validations.iter({ page: 2, perPage: 2 })) {
        seen.push(validation.id);
      }

      assert.equal(seen.length, 1);
      assert.equal(server.requests.length, 1);
    });

    it('iter respeta maxPages', async () => {
      server.enqueue('validations-page1');

      const seen: string[] = [];
      for await (const validation of client.validations.iter({ perPage: 2, maxPages: 1 })) {
        seen.push(validation.id);
      }

      assert.equal(seen.length, 2);
      assert.equal(server.requests.length, 1);
    });

    it('cortar el recorrido a mitad de página no gasta peticiones de más', async () => {
      server.enqueue('validations-page1');

      for await (const validation of client.validations.iter({ perPage: 2 })) {
        assert.ok(validation.id);
        break;
      }

      assert.equal(server.requests.length, 1);
    });

    it('stats lleva los mismos filtros', async () => {
      server.enqueue('validations-stats');

      const stats = await client.validations.stats({ from: '2025-03-01', withDeleted: false });

      assert.equal(stats.attributes?.total, 47);
      assert.equal(stats.attributes.by_type?.ocr, 17);
      assert.equal(server.request(0).url.startsWith('/v1/validations/stats?'), true);
      assert.equal(query(0).get('from'), '2025-03-01');
      assert.equal(query(0).get('with_deleted'), '0');
    });
  });

  describe('reintentos', () => {
    it('lista los intentos del ciclo', async () => {
      server.enqueue('retry-attempts');

      const attempts = await client.validations.retryAttempts(VALIDATION_ID);

      assert.deepEqual(
        attempts.map((attempt) => attempt.attempt_number),
        [1, 2],
      );
      assert.equal(attempts[1]?.new_status, 'valid');
    });

    it('cambiar la política envuelve el cuerpo en retry_policy', async () => {
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
      assert.equal(server.header(0, 'idempotency-key'), undefined);
    });

    it('cambiar la política admite una clave de idempotencia', async () => {
      server.enqueue('retry-policy-updated');

      await client.validations.setRetryPolicy(
        VALIDATION_ID,
        { enabled: false },
        { idempotencyKey: 'pedido-9' },
      );

      assert.equal(server.header(0, 'idempotency-key'), 'pedido-9');
    });

    it('cancelar los reintentos pendientes', async () => {
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

  describe('archivos', () => {
    it('descarga la imagen del comprobante', async () => {
      server.enqueue('validation-image');

      const image = await client.validations.image(VALIDATION_ID);

      assert.equal(Buffer.from(image.content).subarray(0, 4).toString('latin1'), '\x89PNG');
      assert.equal(image.contentType, 'image/png');
      assert.equal(image.filename, `comprobante-${VALIDATION_ID}.png`);
      assert.match(server.header(0, 'accept') ?? '', /image\/png/);
    });

    it('descarga el comprobante en PDF con su extensión', async () => {
      server.enqueue('validation-image-pdf');

      const file = await client.validations.image(VALIDATION_ID);

      assert.equal(Buffer.from(file.content).subarray(0, 5).toString('latin1'), '%PDF-');
      assert.equal(file.contentType, 'application/pdf');
      assert.equal(file.filename, `comprobante-${VALIDATION_ID}.pdf`);
      assert.match(server.header(0, 'accept') ?? '', /application\/pdf/);
    });

    it('exporta el historial en CSV', async () => {
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

    it('exporta el historial en XLSX', async () => {
      server.enqueue('validations-export-xlsx');

      const file = await client.validations.export({ format: 'xlsx' });

      assert.equal(query(0).get('format'), 'xlsx');
      assert.match(server.header(0, 'accept') ?? '', /spreadsheetml\.sheet/);
      assert.equal(file.filename, 'veriko_validaciones_2025-03-15.xlsx');
      assert.equal(Buffer.from(file.content).subarray(0, 2).toString('latin1'), 'PK');
    });

    it('un formato de exportación fuera de la lista no llega a la API', async () => {
      await assert.rejects(
        // @ts-expect-error `pdf` no es un formato de exportación
        () => client.validations.export({ format: 'pdf' }),
        ConfigurationError,
      );

      assert.equal(server.requests.length, 0);
    });

    it('cep por la familia y por el atajo de la raíz devuelven lo mismo', async () => {
      server.enqueue('cep-pdf', 2);

      const fromFamily = await client.validations.cep(VALIDATION_ID, { format: 'pdf' });
      const fromRoot = await client.getCep(VALIDATION_ID, { format: 'pdf' });

      assert.equal(fromFamily.filename, fromRoot.filename);
      assert.deepEqual(fromFamily.content, fromRoot.content);
      assert.equal(server.request(0).url, server.request(1).url);
    });
  });

  describe('retirar y enviar', () => {
    it('retira una validación del historial', async () => {
      server.enqueue('no-content');

      await client.validations.delete(VALIDATION_ID);

      assert.equal(server.request(0).method, 'DELETE');
      assert.equal(server.request(0).url, `/v1/validations/${VALIDATION_ID}`);
    });

    it('envía el comprobante a Telegram', async () => {
      server.enqueue('telegram-accepted');

      const dispatch = await client.validations.sendCepToTelegram(VALIDATION_ID);

      assert.equal(dispatch.attributes?.queued, true);
      assert.equal(server.request(0).method, 'POST');
      assert.equal(server.request(0).url, `/v1/validations/${VALIDATION_ID}/cep/send-telegram`);
    });
  });

  describe('varias cuentas candidatas', () => {
    it('encolar las lleva en los dos caminos', async () => {
      server.enqueue('validate-queued', 2);
      const candidates = ['012180004412345678', '002010077777777771'];

      await client.validations.enqueue({
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        cuentasCandidatas: candidates,
      });
      await client.validations.enqueueOcr({
        image: Buffer.from('png'),
        cuentasCandidatas: candidates,
      });

      assert.equal(server.request(0).url, '/v1/validate?async=1');
      assert.deepEqual(server.json(0)['cuentas_candidatas'], candidates);
      assert.equal('cuenta_beneficiaria' in server.json(0), false);
      assert.equal(server.request(1).url, '/v1/validate-ocr?async=1');
      assert.deepEqual(server.json(1)['cuentas_candidatas'], candidates);
    });

    it('validar una imagen con candidatas no envía la cuenta', async () => {
      server.enqueue('validate-ocr');

      await client.validations.validateOcr({
        imageUrl: 'https://ejemplo.mx/comprobante.png',
        cuentasCandidatas: ['012180004412345678', '002010077777777771'],
      });

      assert.deepEqual(server.json(0), {
        image_url: 'https://ejemplo.mx/comprobante.png',
        cuentas_candidatas: ['012180004412345678', '002010077777777771'],
      });
    });
  });

  describe('retainImage', () => {
    it('false viaja y la validación dice que no conserva el archivo', async () => {
      server.enqueue('validate-ocr-not-retained');

      const validation = await client.validations.validateOcr({
        image: Buffer.from('png'),
        retainImage: false,
      });

      assert.equal(server.json(0)['retain_image'], false);
      assert.equal(validation.attributes.image_retained, false);
      assert.equal(validation.attributes.image_path, undefined);
    });

    it('sin retainImage no viaja y la validación no informa nada', async () => {
      server.enqueue('validate-ocr');

      const validation = await client.validations.validateOcr({ image: Buffer.from('png') });

      assert.equal('retain_image' in server.json(0), false);
      assert.equal(validation.attributes.image_retained, undefined);
      assert.equal(validation.attributes.purged_at, undefined);
    });

    it('true también viaja en el camino asíncrono', async () => {
      server.enqueue('validate-queued');

      await client.validations.enqueueOcr({ image: Buffer.from('png'), retainImage: true });

      assert.equal(server.json(0)['retain_image'], true);
    });
  });

  describe('recheck', () => {
    it('una validación que pasa a returned', async () => {
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

    it('una validación que sigue valid', async () => {
      server.enqueue('validation-recheck-unchanged');

      const result = await client.validations.recheck(VALIDATION_ID);

      assert.equal(result.changed, false);
      assert.equal(result.previousStatus, 'valid');
      assert.equal(result.validation.attributes.status, 'valid');
    });

    it('el estado del pago queda en banxico_result', async () => {
      server.enqueue('validation-recheck-returned');

      const { validation } = await client.validations.recheck(VALIDATION_ID);

      const status = (validation.attributes.banxico_result as { _payment_status?: PaymentStatus })
        ._payment_status;
      assert.equal(status?.code, 'devuelto');
      assert.equal(status.reversed, true);
      assert.equal(status.settled, false);
    });

    it('una revisión antes de tiempo no se reintenta sola', async () => {
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

    it('una revisión con Banxico caído no se reintenta sola', async () => {
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

    it('una validación purgada responde 410', async () => {
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

  describe('borrado definitivo', () => {
    const TOKEN = 'eyJhZG1pbl9pZCI6Ii4uLiJ9.q1w2e3r4t5y6u7i8o9p0';

    it('preparar devuelve el token y lo que se borraría', async () => {
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

    it('ejecutar envía el token y devuelve lo borrado', async () => {
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

    it('ejecutar sin token no llama a la API', async () => {
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

    it('ejecutar no se reintenta solo', async () => {
      server.enqueue('validate-503');
      server.enqueue('validation-purge-executed');

      await assert.rejects(
        () => client.validations.executePurge(VALIDATION_ID, { confirmationToken: TOKEN }),
        ServerError,
      );

      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    });

    it('una validación purgada queda como una lápida', async () => {
      server.enqueue('validation-purged-tombstone');

      const validation = await client.validations.get(VALIDATION_ID);

      assert.equal(validation.attributes.purged_at, '2026-10-02T09:30:00Z');
      assert.equal(validation.attributes.status, 'valid');
      assert.deepEqual(validation.attributes.normalized_data, { monto: 15000.5 });
      assert.equal(validation.attributes.request_data, undefined);
      assert.equal(hasCep(validation), false);
    });
  });
});
