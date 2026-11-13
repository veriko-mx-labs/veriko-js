/**
 * Runs every file in `examples/` against the recorded-responses server of the tests.
 *
 * Each example is a real child process: it reads `VERIKO_API_KEY` and `VERIKO_BASE_URL` from
 * the environment, as a person running it would, and finds the SDK as `@veriko-mx/sdk`,
 * which resolves to the built package. Nothing leaves the machine.
 *
 * For each example this script lists the responses the server returns, in order, and what the
 * example must request and print. An example that is not listed fails the run, so a new one
 * cannot skip the check.
 *
 * Run `npm run test:examples`: it builds the package and the tests first.
 */

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'dist-test', 'test', 'harness.js');
const EXAMPLES = join(ROOT, 'examples');

if (!existsSync(HARNESS) || !existsSync(join(ROOT, 'dist', 'esm', 'index.js'))) {
  console.error('Build first: npm run build && npm run pretest (or npm run test:examples).');
  process.exit(1);
}

const { RecordingServer, TEST_API_KEY } = await import(HARNESS);

const TIMEOUT_MS = 60_000;
const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/**
 * What each example does against the recordings: the responses in order, the requests that
 * must reach the server (`METHOD path`, without the query), and the text it must print.
 */
const SCRIPTS = {
  'validate.mjs': {
    recordings: ['validate-valid', 'cep-pdf'],
    requests: ['POST /v1/validate', `GET /v1/validations/${ID}/cep`],
    output: ['Verdict:    valid', 'CEP saved to'],
    files: 1,
  },
  'async-and-webhooks.mjs': {
    recordings: [
      'webhook-created',
      'webhook-test-ok',
      'validate-queued',
      'validate-queued',
      'validate-valid',
      'cep-pdf',
      'validate-valid',
      'cep-pdf',
    ],
    requests: [
      'POST /v1/webhooks',
      `POST /v1/webhooks/${'9f8e7d6c-5b4a-3210-fedc-ba9876543210'}/test`,
      'POST /v1/validate',
      'POST /v1/validate',
      `GET /v1/validations/${ID}`,
      `GET /v1/validations/${ID}/cep`,
      `GET /v1/validations/${ID}`,
      `GET /v1/validations/${ID}/cep`,
    ],
    output: ['registered', 'Test delivered', 'Queued 2 validations', '-> valid'],
    files: 1,
  },
  'm2m-surface.mjs': {
    recordings: ['public-plans', 'account-profile', 'insights-trends', 'finance-statement'],
    requests: [
      'GET /v1/plans/public',
      'GET /v1/users/me',
      'GET /v1/insights/trends',
      'GET /v1/finance/statement',
    ],
    output: [],
    files: 1,
  },
};

/** A receiver that is a server: the script starts it, delivers to it and stops it. */
const SERVERS = new Set(['webhook-receiver.mjs']);

const failures = [];

function fail(example, message) {
  failures.push(`${example}: ${message}`);
  console.error(`  FAIL ${message}`);
}

/** Runs one example to completion and returns what it printed. */
function runToEnd(example, environment, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(EXAMPLES, example)], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
  });
}

async function runClientExample(example, script) {
  const server = await RecordingServer.start();
  const cwd = mkdtempSync(join(tmpdir(), 'veriko-example-'));
  try {
    for (const recording of script.recordings) server.enqueue(recording);
    const { code, output } = await runToEnd(
      example,
      {
        ...process.env,
        VERIKO_API_KEY: TEST_API_KEY,
        VERIKO_BASE_URL: server.baseUrl,
      },
      cwd,
    );
    if (code !== 0) fail(example, `exited with ${String(code)}\n${output}`);

    const sent = server.requests.map((request) => `${request.method} ${request.url.split('?')[0]}`);
    for (const [index, expected] of script.requests.entries()) {
      const received = sent[index];
      if (received !== expected) {
        fail(example, `request ${String(index)} was "${received}", expected "${expected}"`);
      }
    }
    if (sent.length !== script.requests.length) {
      fail(example, `${String(sent.length)} requests, expected ${String(script.requests.length)}`);
    }
    for (const text of script.output) {
      if (!output.includes(text)) fail(example, `the output has no "${text}"\n${output}`);
    }
    const written = readdirSync(cwd);
    if (script.files !== undefined && written.length < script.files) {
      fail(example, `wrote ${String(written.length)} file(s), expected ${String(script.files)}`);
    }
    for (const request of server.requests) {
      if (request.url.includes('/plans/public')) continue;
      if (request.headers['authorization'] !== `Bearer ${TEST_API_KEY}`) {
        fail(example, 'a request went out without the API key of the environment');
      }
    }
    if (!failures.some((entry) => entry.startsWith(`${example}:`))) {
      console.log(`  ok   ${String(sent.length)} request(s), ${String(written.length)} file(s)`);
    }
  } finally {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function recordedDelivery(name) {
  const document = JSON.parse(
    readFileSync(join(ROOT, 'test', 'recordings', `${name}.json`), 'utf8'),
  );
  return Buffer.from(JSON.stringify(document.json), 'utf8');
}

function signedHeaders(body, secret, id) {
  const t = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(body)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Webhook-Signature-Timestamped': `t=${String(t)},v1=${digest}`,
    'X-Veriko-Delivery-Id': id,
  };
}

async function runReceiver(example) {
  const secret = 'example-webhook-secret';
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(process.execPath, [join(EXAMPLES, example)], {
    env: { ...process.env, VERIKO_WEBHOOK_SECRET: secret, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes('listening') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!output.includes('listening')) {
      fail(example, `it did not start\n${output}`);
      return;
    }

    const url = `http://127.0.0.1:${String(port)}/hooks/veriko`;
    const post = async (body, headers) => {
      const reply = await fetch(url, { method: 'POST', body, headers });
      return reply.status;
    };

    const completed = recordedDelivery('webhook-validation-banxico-confirmed');
    const returned = recordedDelivery('webhook-validation-returned');
    const retry = recordedDelivery('webhook-retry-resolved');

    const results = [
      [
        'a signed validation.completed',
        await post(completed, signedHeaders(completed, secret, 'd-1')),
        200,
      ],
      [
        'the same delivery again',
        await post(completed, signedHeaders(completed, secret, 'd-1')),
        200,
      ],
      [
        'a signed validation.returned',
        await post(returned, signedHeaders(returned, secret, 'd-2')),
        200,
      ],
      ['a signed retry event', await post(retry, signedHeaders(retry, secret, 'd-3')), 200],
      [
        'a body signed with another secret',
        await post(completed, signedHeaders(completed, 'other', 'd-4')),
        400,
      ],
      [
        'a delivery with no signature',
        await post(completed, { 'Content-Type': 'application/json' }),
        400,
      ],
    ];
    for (const [label, status, expected] of results) {
      if (status !== expected)
        fail(example, `${label} answered ${String(status)}, expected ${String(expected)}`);
    }

    // The receiver answers first and processes after, so give it a moment to print.
    await new Promise((r) => setTimeout(r, 300));
    for (const text of [
      '[validation.completed]',
      '[validation.returned]',
      '[validation.retry.resolved]',
    ]) {
      if (!output.includes(text)) fail(example, `the output has no "${text}"\n${output}`);
    }
    const completedLines = output
      .split('\n')
      .filter((line) => line.includes('[validation.completed]'));
    if (completedLines.length !== 1) {
      fail(example, `the repeated delivery was processed ${String(completedLines.length)} times`);
    }
    if (!failures.some((entry) => entry.startsWith(`${example}:`))) {
      console.log('  ok   6 deliveries: verified, deduplicated and rejected as expected');
    }
  } finally {
    child.kill('SIGTERM');
  }
}

const present = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith('.mjs'))
  .sort();
for (const example of present) {
  if (!(example in SCRIPTS) && !SERVERS.has(example)) {
    fail(example, 'it has no entry in scripts/run-examples.mjs');
  }
}
for (const example of [...Object.keys(SCRIPTS), ...SERVERS]) {
  if (!present.includes(example)) fail(example, 'the script lists a file that does not exist');
}

for (const example of present) {
  console.log(`examples/${example}`);
  if (SERVERS.has(example)) await runReceiver(example);
  else if (example in SCRIPTS) await runClientExample(example, SCRIPTS[example]);
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem(s) running the examples.`);
  process.exit(1);
}
console.log('\nThe examples ran against the recordings.');
