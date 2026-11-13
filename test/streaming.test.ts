/** Streaming downloads: the `*Stream()` variants hand the body over without reading it. */

import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  NotFoundError,
  RequestAbortedError,
  Veriko,
  type DownloadedFile,
  type DownloadedStream,
} from '../src/index.js';
import { RecordingServer, TEST_API_KEY, makeClient } from './harness.js';

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const WEBHOOK = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

interface Case {
  name: string;
  recording: string;
  path: string;
  buffered: (client: Veriko) => Promise<DownloadedFile>;
  streamed: (client: Veriko) => Promise<DownloadedStream>;
}

const CASES: Case[] = [
  {
    name: 'validations.cepStream (PDF)',
    recording: 'cep-pdf',
    path: `/v1/validations/${ID}/cep?format=pdf`,
    buffered: (client) => client.validations.cep(ID, { format: 'pdf' }),
    streamed: (client) => client.validations.cepStream(ID, { format: 'pdf' }),
  },
  {
    name: 'validations.cepStream (XML)',
    recording: 'cep-xml',
    path: `/v1/validations/${ID}/cep?format=xml`,
    buffered: (client) => client.validations.cep(ID),
    streamed: (client) => client.validations.cepStream(ID),
  },
  {
    name: 'validations.imageStream',
    recording: 'validation-image',
    path: `/v1/validations/${ID}/image`,
    buffered: (client) => client.validations.image(ID),
    streamed: (client) => client.validations.imageStream(ID),
  },
  {
    name: 'validations.exportStream',
    recording: 'validations-export-xlsx',
    path: '/v1/validations/export?format=xlsx',
    buffered: (client) => client.validations.export({ format: 'xlsx' }),
    streamed: (client) => client.validations.exportStream({ format: 'xlsx' }),
  },
  {
    name: 'webhooks.exportDeliveriesStream (global)',
    recording: 'deliveries-export-csv',
    path: '/v1/webhooks/deliveries/export?format=csv',
    buffered: (client) => client.webhooks.exportDeliveries(),
    streamed: (client) => client.webhooks.exportDeliveriesStream(),
  },
  {
    name: 'webhooks.exportDeliveriesStream (one endpoint)',
    recording: 'deliveries-export-csv',
    path: `/v1/webhooks/${WEBHOOK}/deliveries/export?format=csv`,
    buffered: (client) => client.webhooks.exportDeliveries(WEBHOOK),
    streamed: (client) => client.webhooks.exportDeliveriesStream(WEBHOOK),
  },
  {
    name: 'beneficiaries.exportStream',
    recording: 'beneficiaries-export-csv',
    path: '/v1/beneficiaries/export?format=csv',
    buffered: (client) => client.beneficiaries.export(),
    streamed: (client) => client.beneficiaries.exportStream(),
  },
  {
    name: 'beneficiaries.importTemplateStream',
    recording: 'beneficiaries-import-template',
    path: '/v1/beneficiaries/imports/template?format=csv',
    buffered: (client) => client.beneficiaries.importTemplate(),
    streamed: (client) => client.beneficiaries.importTemplateStream(),
  },
  {
    name: 'usage.exportStream',
    recording: 'api-usage-export-csv',
    path: '/v1/api/usage/export?format=csv',
    buffered: (client) => client.usage.export(),
    streamed: (client) => client.usage.exportStream(),
  },
  {
    name: 'finance.statementStream',
    recording: 'finance-statement',
    path: '/v1/finance/statement?month=2026-04&format=pdf',
    buffered: (client) => client.finance.getStatement({ month: '2026-04' }),
    streamed: (client) => client.finance.statementStream({ month: '2026-04' }),
  },
  {
    name: 'finance.cepsStream',
    recording: 'finance-ceps',
    path: '/v1/finance/ceps?from=2026-04-01&to=2026-04-30',
    buffered: (client) => client.finance.getCeps({ from: '2026-04-01', to: '2026-04-30' }),
    streamed: (client) => client.finance.cepsStream({ from: '2026-04-01', to: '2026-04-30' }),
  },
  {
    name: 'finance.downloadCepExportStream',
    recording: 'finance-ceps',
    path: `/v1/finance/ceps/exports/${ID}/download`,
    buffered: (client) => client.finance.downloadCepExport(ID),
    streamed: (client) => client.finance.downloadCepExportStream(ID),
  },
  {
    name: 'finance.reportStream (accounting)',
    recording: 'deliveries-export-csv',
    path: '/v1/finance/accounting?month=2026-04&decimal=dot&format=csv',
    buffered: async (client) =>
      (await client.finance.getAccounting({ month: '2026-04', decimal: 'dot' })) as DownloadedFile,
    streamed: (client) =>
      client.finance.reportStream('accounting', { month: '2026-04', decimal: 'dot' }),
  },
];

describe('the *Stream() downloads', () => {
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

  for (const testCase of CASES) {
    it(`${testCase.name} sends the same request and yields the same bytes`, async () => {
      server.enqueue(testCase.recording, 2);

      const file = await testCase.buffered(client);
      const streamed = await testCase.streamed(client);

      assert.equal(server.request(1).method, 'GET');
      assert.equal(server.request(1).url, server.request(0).url);
      assert.equal(server.request(1).url, testCase.path);
      assert.ok(streamed.stream instanceof ReadableStream);
      assert.equal(streamed.contentType, file.contentType);
      assert.equal(streamed.filename, file.filename);
      assert.deepEqual(streamed.headers, file.headers);
      assert.equal(streamed.contentLength, file.content.length);
      assert.deepEqual(await drain(streamed.stream), file.content);
    });
  }

  it('exposes the headers of the file next to the stream', async () => {
    server.enqueueInline({
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="ceps-2026-04.zip"',
        'X-Finance-Items': '42',
      },
      body_base64: Buffer.from('zip bytes').toString('base64'),
    });

    const file = await client.finance.downloadCepExportStream(ID);

    assert.equal(file.filename, 'ceps-2026-04.zip');
    assert.equal(file.headers['x-finance-items'], '42');
    assert.equal(file.contentLength, 9);
    assert.equal(Buffer.from(await drain(file.stream)).toString('utf8'), 'zip bytes');
  });

  it('keeps the buffered API unchanged: it still returns the bytes', async () => {
    server.enqueue('cep-pdf');

    const file = await client.validations.cep(ID, { format: 'pdf' });

    assert.ok(file.content instanceof Uint8Array);
    assert.ok(file.content.length > 0);
    assert.equal('stream' in file, false);
  });

  it('turns an error response into the typed error, read whole', async () => {
    server.enqueue('cep-404');

    await assert.rejects(client.validations.cepStream(ID), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.status, 404);
      return true;
    });
  });

  it('reports the response metadata through withResponse()', async () => {
    server.enqueue('finance-ceps');

    const { data, response } = await client.finance.downloadCepExportStream(ID).withResponse();

    assert.equal(response.status, 200);
    assert.equal(response.attempts, 1);
    await data.stream.cancel();
  });

  it('rejects the preview of a report, which is not a file', async () => {
    await assert.rejects(
      client.finance.reportStream('monthly', {
        month: '2026-04',
        format: 'preview' as unknown as 'csv',
      }),
      /preview/,
    );
    assert.equal(server.requests.length, 0);
  });

  it('rejects an unknown report', async () => {
    await assert.rejects(
      client.finance.reportStream('nope' as unknown as 'monthly', { month: '2026-04' }),
      /report is/,
    );
  });
});

describe('streaming is not buffering', () => {
  let release: (() => void) | undefined;
  let serverResponse: ServerResponse | undefined;
  let closedEarly = false;

  const http = createServer((request, response) => {
    serverResponse = response;
    response.on('close', () => {
      if (!response.writableEnded) closedEarly = true;
    });
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="big.zip"',
    });
    response.write('first-chunk');
    release = () => {
      response.end('-last-chunk');
    };
    request.resume();
  });
  let baseUrl = '';

  before(async () => {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    baseUrl = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/v1`;
  });

  after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    closedEarly = false;
    release = undefined;
    serverResponse = undefined;
  });

  it('resolves and yields the first chunk while the server is still sending', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl, maxRetries: 0 });

    const file = await client.finance.downloadCepExportStream(ID);
    assert.equal(file.filename, 'big.zip');
    assert.ok(release, 'the server has not finished the response');
    assert.equal(serverResponse?.writableEnded, false);

    const reader = file.stream.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value ?? new Uint8Array()).toString('utf8'), 'first-chunk');

    release();
    const rest = await reader.read();
    assert.equal(Buffer.from(rest.value ?? new Uint8Array()).toString('utf8'), '-last-chunk');
    assert.equal((await reader.read()).done, true);
  });

  it('fails the stream with RequestAbortedError when the signal aborts mid-transfer', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl, maxRetries: 0 });
    const controller = new AbortController();

    const file = await client.finance.downloadCepExportStream(ID, { signal: controller.signal });
    const reader = file.stream.getReader();
    await reader.read();
    controller.abort();

    await assert.rejects(reader.read(), (error: unknown) => error instanceof RequestAbortedError);
  });

  it('closes the connection when the caller cancels the stream', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl, maxRetries: 0 });

    const file = await client.finance.downloadCepExportStream(ID);
    await file.stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(closedEarly, true);
  });

  it('does not apply the request timeout to the transfer', async () => {
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl, maxRetries: 0, timeoutMs: 50 });

    const file = await client.finance.downloadCepExportStream(ID);
    await new Promise((resolve) => setTimeout(resolve, 150));
    release?.();

    assert.equal(Buffer.from(await drain(file.stream)).toString('utf8'), 'first-chunk-last-chunk');
  });
});
