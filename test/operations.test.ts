/**
 * Las 49 operaciones que cubre el SDK, contra el spec.
 *
 * Cada caso llama a un método con todos sus argumentos opcionales y comprueba que
 * lo que llegó al servidor existe en el spec: el método y la ruta, los parámetros
 * de consulta, las cabeceras y los campos del cuerpo. Un cuerpo sin el envoltorio
 * `retry_policy`, o un filtro con otro nombre, fallan aquí.
 *
 * Además cada operación tiene que ser de máquina a máquina: la que sólo acepta la
 * cookie de sesión es de la interfaz y no entra en el SDK, en ninguna versión.
 *
 * La segunda parte compara el conjunto cubierto con las familias del spec, de modo
 * que una operación nueva de máquina a máquina en ellas no pase sin método.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import type { ValidationFilters, Veriko } from '../src/index.js';
import { PROJECT_ROOT, RecordingServer, makeClient } from './harness.js';

interface Parameter {
  name?: string;
  in?: string;
  $ref?: string;
}

interface Schema {
  $ref?: string;
  properties?: Record<string, unknown>;
}

interface Operation {
  operationId: string;
  tags?: string[];
  security?: Record<string, unknown>[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

interface Spec {
  security?: Record<string, unknown>[];
  paths: Record<string, Record<string, unknown>>;
  components: { parameters: Record<string, Parameter>; schemas: Record<string, Schema> };
}

const spec = parse(readFileSync(join(PROJECT_ROOT, 'spec', 'openapi.yaml'), 'utf8')) as Spec;

/**
 * `true` si la operación se usa de máquina a máquina: acepta la clave de API o es
 * pública y no pide autenticación. La que sólo acepta la cookie es de la interfaz.
 */
function acceptsApiKey(operation: Operation): boolean {
  const schemes = operation.security ?? spec.security ?? [];
  return schemes.length === 0 || schemes.some((alternative) => 'ApiKeyAuth' in alternative);
}

/** Todas las operaciones del spec. */
function allOperations(): Operation[] {
  return Object.values(spec.paths).flatMap((item) =>
    ['get', 'post', 'put', 'delete', 'patch']
      .map((method) => item[method] as Operation | undefined)
      .filter((operation): operation is Operation => operation !== undefined),
  );
}

function resolveParameter(parameter: Parameter): Parameter {
  if (!parameter.$ref) return parameter;
  const resolved = spec.components.parameters[parameter.$ref.split('/').pop() ?? ''];
  assert.ok(resolved, `el spec no declara el parámetro ${parameter.$ref}`);
  return resolved;
}

function resolveSchema(schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema;
  return spec.components.schemas[schema.$ref.split('/').pop() ?? ''];
}

/** La operación del spec a la que corresponde una petición. Las rutas literales ganan a las con `{id}`. */
function locate(method: string, pathname: string): { template: string; operation: Operation } {
  const found = Object.entries(spec.paths)
    .filter(([template, item]) => {
      const pattern = new RegExp(`^${template.replace(/\{[^/]+\}/g, '[^/]+')}$`);
      return item[method.toLowerCase()] !== undefined && pattern.test(pathname);
    })
    .sort(([a], [b]) => Number(a.includes('{')) - Number(b.includes('{')))[0];
  assert.ok(found, `el spec no declara ${method} ${pathname}`);
  return { template: found[0], operation: found[1][method.toLowerCase()] as Operation };
}

function declared(template: string, operation: Operation, where: string): string[] {
  const shared = (spec.paths[template]?.['parameters'] ?? []) as Parameter[];
  return [...shared, ...(operation.parameters ?? [])]
    .map(resolveParameter)
    .filter((parameter) => parameter.in === where)
    .map((parameter) => parameter.name ?? '');
}

const ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const WEBHOOK = '9f8e7d6c-5b4a-3210-fedc-ba9876543210';
const IMPORT = 42;
const ROW = 102;

const FILTERS = {
  status: ['valid', 'not_found'],
  type: 'ocr',
  from: '2025-01-01',
  to: '2025-03-31',
  search: 'scotiabank',
  playground: true,
  withDeleted: true,
  batchId: 42,
  bank: '012',
  amountMin: 1000.5,
  amountMax: 50000,
  retryState: 'pending',
} as const satisfies Required<ValidationFilters>;

const POLICY = {
  enabled: true,
  max_retries: 3,
  interval_seconds: 600,
  outcomes: ['not_found', 'cep_unavailable'],
} as const satisfies {
  enabled: boolean;
  max_retries: number;
  interval_seconds: number;
  outcomes: string[];
};

interface Case {
  operationId: string;
  recording: string;
  call: (client: Veriko) => Promise<unknown>;
  /** El caso pasa todos los parámetros de consulta que declara la operación. */
  allQuery?: true;
  /** El caso pasa todos los campos del cuerpo que declara el schema. */
  allBody?: true;
}

const CASES: Case[] = [
  {
    operationId: 'validateDirect',
    recording: 'validate-valid',
    allBody: true,
    call: (client) =>
      client.validations.validate({
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        referenciaNumerica: '1234567',
        emisor: 'BANCO NACIONAL DE MEXICO',
        receptor: 'BBVA MEXICO',
        cuentaBeneficiaria: '012180004412345678',
        receptorParticipante: 1,
        retryPolicy: POLICY,
        idempotencyKey: 'pedido-1',
      }),
  },
  {
    operationId: 'validateDirect',
    recording: 'validate-queued',
    allQuery: true,
    allBody: true,
    call: (client) =>
      client.validations.enqueue({
        fecha: '2025-03-15',
        monto: 15000.5,
        claveRastreo: 'MXBA20250315001234',
        referenciaNumerica: '1234567',
        emisor: 'BANCO NACIONAL DE MEXICO',
        receptor: 'BBVA MEXICO',
        cuentaBeneficiaria: '012180004412345678',
        receptorParticipante: 1,
        retryPolicy: POLICY,
        idempotencyKey: 'pedido-1',
      }),
  },
  {
    operationId: 'validateOcr',
    recording: 'validate-ocr',
    allBody: true,
    call: (client) =>
      client.validations.validateOcr({
        image: Buffer.from('imagen'),
        imageUrl: 'https://ejemplo.mx/comprobante.png',
        cuentaBeneficiaria: '012180004412345678',
        retryPolicy: POLICY,
        idempotencyKey: 'pedido-2',
      }),
  },
  {
    operationId: 'validateOcr',
    recording: 'validate-queued',
    allQuery: true,
    allBody: true,
    call: (client) =>
      client.validations.enqueueOcr({
        image: Buffer.from('imagen'),
        imageUrl: 'https://ejemplo.mx/comprobante.png',
        cuentaBeneficiaria: '012180004412345678',
        retryPolicy: POLICY,
        idempotencyKey: 'pedido-2',
      }),
  },
  {
    operationId: 'listValidations',
    recording: 'validations-page1',
    allQuery: true,
    call: (client) => client.validations.list({ ...FILTERS, page: 2, perPage: 5 }),
  },
  {
    operationId: 'validationStats',
    recording: 'validations-stats',
    allQuery: true,
    call: (client) => client.validations.stats(FILTERS),
  },
  {
    operationId: 'exportValidations',
    recording: 'validations-export-csv',
    allQuery: true,
    call: (client) => client.validations.export({ ...FILTERS, format: 'xlsx', limit: 500 }),
  },
  {
    operationId: 'getValidation',
    recording: 'validate-valid',
    call: (client) => client.validations.get(ID, { ifNoneMatch: 'W/"3-not_found"' }),
  },
  {
    operationId: 'downloadCep',
    recording: 'cep-pdf',
    allQuery: true,
    call: (client) => client.validations.cep(ID, { format: 'pdf' }),
  },
  {
    operationId: 'getValidationImage',
    recording: 'validation-image',
    call: (client) => client.validations.image(ID),
  },
  {
    operationId: 'listValidationRetryAttempts',
    recording: 'retry-attempts',
    call: (client) => client.validations.retryAttempts(ID),
  },
  {
    operationId: 'updateValidationRetryPolicy',
    recording: 'retry-policy-updated',
    allBody: true,
    call: (client) => client.validations.setRetryPolicy(ID, POLICY, { idempotencyKey: 'pedido-3' }),
  },
  {
    operationId: 'cancelValidationRetries',
    recording: 'retries-cancelled',
    call: (client) => client.validations.cancelRetries(ID, { idempotencyKey: 'pedido-4' }),
  },
  {
    operationId: 'deleteValidation',
    recording: 'no-content',
    call: (client) => client.validations.delete(ID),
  },
  {
    operationId: 'sendCepToTelegram',
    recording: 'telegram-accepted',
    call: (client) => client.validations.sendCepToTelegram(ID),
  },
  {
    operationId: 'createWebhook',
    recording: 'webhook-created',
    allBody: true,
    call: (client) =>
      client.webhooks.create({
        url: 'https://miapp.example.com/hooks/pagos',
        events: ['validation.completed'],
        description: 'Pagos de contado',
      }),
  },
  {
    operationId: 'listWebhooks',
    recording: 'webhooks-list',
    call: (client) => client.webhooks.list(),
  },
  {
    operationId: 'updateWebhook',
    recording: 'webhook-updated',
    allBody: true,
    call: (client) =>
      client.webhooks.update(WEBHOOK, {
        url: 'https://miapp.example.com/hooks/nuevo',
        events: ['validation.completed', 'validation.failed'],
        description: null,
        status: 'active',
      }),
  },
  {
    operationId: 'deleteWebhook',
    recording: 'no-content',
    call: (client) => client.webhooks.delete(WEBHOOK),
  },
  {
    operationId: 'sendWebhookTest',
    recording: 'webhook-test-ok',
    call: (client) => client.webhooks.test(WEBHOOK),
  },
  {
    operationId: 'regenerateWebhookSecret',
    recording: 'webhook-secret-rotated',
    call: (client) => client.webhooks.regenerateSecret(WEBHOOK),
  },
  {
    operationId: 'listWebhookDeliveries',
    recording: 'webhook-deliveries',
    allQuery: true,
    call: (client) => client.webhooks.deliveries(WEBHOOK, { page: 2, perPage: 10 }),
  },
  {
    operationId: 'listAllDeliveries',
    recording: 'webhook-deliveries',
    allQuery: true,
    call: (client) =>
      client.webhooks.deliveries(WEBHOOK, {
        page: 2,
        perPage: 10,
        status: 'retrying',
        eventType: 'validation.completed',
      }),
  },
  {
    operationId: 'listAllDeliveries',
    recording: 'webhook-deliveries',
    call: (client) => client.webhooks.deliveries({ status: 'failed' }),
  },
  {
    operationId: 'exportWebhookDeliveries',
    recording: 'deliveries-export-csv',
    allQuery: true,
    call: (client) => client.webhooks.exportDeliveries(WEBHOOK, { format: 'csv', limit: 100 }),
  },
  {
    operationId: 'exportAllDeliveries',
    recording: 'deliveries-export-csv',
    allQuery: true,
    call: (client) =>
      client.webhooks.exportDeliveries(WEBHOOK, {
        format: 'xlsx',
        limit: 100,
        status: 'failed',
        eventType: 'validation.failed',
      }),
  },
  {
    operationId: 'listBanks',
    recording: 'banks',
    call: (client) => client.catalog.banks({ ifNoneMatch: '"a1b2c3d4e5f6"' }),
  },
  {
    operationId: 'lookupBin',
    recording: 'bin-lookup',
    call: (client) => client.catalog.binLookup('455632'),
  },
  {
    operationId: 'banxicoPublicStatus',
    recording: 'banxico-status',
    call: (client) => client.catalog.banxicoStatus(),
  },
  {
    operationId: 'banxicoPublicTimeseries',
    recording: 'banxico-timeseries',
    allQuery: true,
    call: (client) => client.catalog.banxicoTimeseries({ metric: 'verdict', window: '7d' }),
  },
  {
    operationId: 'createBeneficiary',
    recording: 'beneficiary-created',
    allBody: true,
    call: (client) =>
      client.beneficiaries.create({
        accountNumber: '5512345678',
        bankCode: '40012',
        label: 'Proveedor X',
      }),
  },
  {
    operationId: 'listBeneficiaries',
    recording: 'beneficiaries-list',
    allQuery: true,
    call: (client) => client.beneficiaries.list({ withArchived: false }),
  },
  {
    operationId: 'updateBeneficiary',
    recording: 'beneficiary-updated',
    allBody: true,
    call: (client) =>
      client.beneficiaries.update(12, {
        label: 'Proveedor Y',
        accountNumber: '012180004412345678',
        bankCode: '40012',
      }),
  },
  {
    operationId: 'deleteBeneficiary',
    recording: 'no-content',
    call: (client) => client.beneficiaries.delete(12),
  },
  {
    operationId: 'validateAccount',
    recording: 'account-validation',
    allQuery: true,
    call: (client) => client.beneficiaries.validateAccount('012180004412345678', { type: 'clabe' }),
  },
  {
    operationId: 'lookupBeneficiaryAccount',
    recording: 'beneficiary-lookup',
    allQuery: true,
    call: (client) => client.beneficiaries.lookup('012180004412345678'),
  },
  {
    operationId: 'exportBeneficiaries',
    recording: 'beneficiaries-export-csv',
    allQuery: true,
    call: (client) =>
      client.beneficiaries.export({ format: 'xlsx', withArchived: true, limit: 10 }),
  },
  {
    operationId: 'downloadBeneficiaryImportTemplate',
    recording: 'beneficiaries-import-template',
    allQuery: true,
    call: (client) => client.beneficiaries.importTemplate({ format: 'xlsx' }),
  },
  {
    operationId: 'createBeneficiaryImport',
    recording: 'beneficiaries-import-created',
    allBody: true,
    call: (client) =>
      client.beneficiaries.importStart(Buffer.from('cuenta,alias\n012180004412345678,X\n'), {
        parseMode: 'free',
        filename: 'lista.csv',
      }),
  },
  {
    operationId: 'getBeneficiaryImport',
    recording: 'beneficiaries-import-status',
    call: (client) => client.beneficiaries.importStatus(IMPORT),
  },
  {
    operationId: 'cancelBeneficiaryImport',
    recording: 'no-content',
    call: (client) => client.beneficiaries.importCancel(IMPORT),
  },
  {
    operationId: 'getBeneficiaryImportPreview',
    recording: 'beneficiaries-import-preview',
    allQuery: true,
    call: (client) =>
      client.beneficiaries.importPreview(IMPORT, { page: 2, perPage: 5, buckets: ['valid'] }),
  },
  {
    operationId: 'patchBeneficiaryImportRow',
    recording: 'beneficiaries-import-row-updated',
    allBody: true,
    call: (client) =>
      client.beneficiaries.importEditRow(IMPORT, ROW, {
        parsedAccount: '012180004412345678',
        parsedLabel: 'Proveedor X',
        parsedAccountType: 'clabe',
        parsedBankCode: '40012',
        parsedBankName: 'BBVA MEXICO',
      }),
  },
  {
    operationId: 'deleteBeneficiaryImportRow',
    recording: 'no-content',
    call: (client) => client.beneficiaries.importRemoveRow(IMPORT, ROW),
  },
  {
    operationId: 'commitBeneficiaryImport',
    recording: 'beneficiaries-import-committed',
    call: (client) => client.beneficiaries.importCommit(IMPORT),
  },
  {
    operationId: 'getUsageSummary',
    recording: 'usage-summary',
    call: (client) => client.usage.summary(),
  },
  {
    operationId: 'getUsageHistory',
    recording: 'usage-history',
    allQuery: true,
    call: (client) => client.usage.history({ months: 3 }),
  },
  {
    operationId: 'getUsageBreakdown',
    recording: 'usage-breakdown',
    allQuery: true,
    call: (client) => client.usage.breakdown({ period: 'current' }),
  },
  {
    operationId: 'getUsageLimits',
    recording: 'usage-limits',
    call: (client) => client.usage.limits(),
  },
  {
    operationId: 'getUsageHeatmap',
    recording: 'usage-heatmap',
    allQuery: true,
    call: (client) => client.usage.heatmap({ days: 30 }),
  },
  {
    operationId: 'getApiUsage',
    recording: 'api-usage',
    call: (client) => client.usage.apiUsage(),
  },
  {
    operationId: 'exportApiUsage',
    recording: 'api-usage-export-csv',
    allQuery: true,
    call: (client) =>
      client.usage.export({ format: 'xlsx', from: '2025-01-01', to: '2025-03-31', limit: 100 }),
  },
];

/** Las 49 operaciones de esta versión. */
const SDK_OPERATIONS = [
  'validateDirect',
  'validateOcr',
  'listValidations',
  'getValidation',
  'downloadCep',
  'getValidationImage',
  'validationStats',
  'exportValidations',
  'listValidationRetryAttempts',
  'updateValidationRetryPolicy',
  'cancelValidationRetries',
  'deleteValidation',
  'sendCepToTelegram',
  'createWebhook',
  'listWebhooks',
  'updateWebhook',
  'deleteWebhook',
  'sendWebhookTest',
  'regenerateWebhookSecret',
  'listWebhookDeliveries',
  'listAllDeliveries',
  'exportWebhookDeliveries',
  'exportAllDeliveries',
  'listBanks',
  'lookupBin',
  'banxicoPublicStatus',
  'banxicoPublicTimeseries',
  'createBeneficiary',
  'listBeneficiaries',
  'updateBeneficiary',
  'deleteBeneficiary',
  'validateAccount',
  'lookupBeneficiaryAccount',
  'exportBeneficiaries',
  'downloadBeneficiaryImportTemplate',
  'createBeneficiaryImport',
  'getBeneficiaryImport',
  'cancelBeneficiaryImport',
  'getBeneficiaryImportPreview',
  'patchBeneficiaryImportRow',
  'deleteBeneficiaryImportRow',
  'commitBeneficiaryImport',
  'getUsageSummary',
  'getUsageHistory',
  'getUsageBreakdown',
  'getUsageLimits',
  'getUsageHeatmap',
  'getApiUsage',
  'exportApiUsage',
];

describe('lo que el SDK envía existe en el spec', () => {
  for (const testCase of CASES) {
    const label = `${testCase.operationId}: ${testCase.recording}`;

    it(label, async () => {
      const server = await RecordingServer.start();
      try {
        server.enqueue(testCase.recording);
        await testCase.call(makeClient(server, []));

        const sent = server.request(0);
        const url = new URL(sent.url, 'http://localhost');
        const { template, operation } = locate(sent.method, url.pathname.replace(/^\/v1/, ''));

        assert.equal(operation.operationId, testCase.operationId, `${sent.method} ${url.pathname}`);
        assert.ok(acceptsApiKey(operation), `${template} sólo acepta la cookie de sesión`);

        const queryNames = declared(template, operation, 'query');
        const sentQuery = [...url.searchParams.keys()];
        for (const name of sentQuery) {
          assert.ok(
            queryNames.includes(name),
            `${template}: el spec no declara el parámetro ${name}`,
          );
        }
        if (testCase.allQuery) assert.deepEqual([...sentQuery].sort(), [...queryNames].sort());

        const headerNames = declared(template, operation, 'header').map((name) =>
          name.toLowerCase(),
        );
        for (const name of ['idempotency-key', 'if-none-match']) {
          if (name in sent.headers) {
            assert.ok(
              headerNames.includes(name),
              `${template}: el spec no declara la cabecera ${name}`,
            );
          }
        }

        if (sent.body.length > 0) {
          const contentType = (sent.headers['content-type'] ?? '').split(';')[0] ?? '';
          const schema = resolveSchema(operation.requestBody?.content?.[contentType]?.schema);
          assert.ok(
            schema?.properties,
            `${template}: el spec no describe el cuerpo ${contentType}`,
          );
          // En un formulario multipart, los campos son los `name` de cada parte.
          const bodyKeys =
            contentType === 'application/json'
              ? Object.keys(server.json(0))
              : [
                  ...new Set(
                    [...sent.body.toString('latin1').matchAll(/; name="([^"]+)"/g)].map(
                      (match) => match[1] ?? '',
                    ),
                  ),
                ];
          for (const key of bodyKeys) {
            assert.ok(key in schema.properties, `${template}: el spec no declara el campo ${key}`);
          }
          if (testCase.allBody) {
            assert.deepEqual([...bodyKeys].sort(), Object.keys(schema.properties).sort());
          }
        }
      } finally {
        await server.close();
      }
    });
  }
});

describe('el conjunto de operaciones cubierto', () => {
  it('son las 49 de esta versión', () => {
    const covered = [...new Set(CASES.map((testCase) => testCase.operationId))].sort();

    assert.equal(SDK_OPERATIONS.length, 49);
    assert.deepEqual(covered, [...SDK_OPERATIONS].sort());
  });

  it('las familias del spec no traen operaciones de máquina a máquina sin método', () => {
    const families = new Set([
      'Validations',
      'Webhooks',
      'Public',
      'Banxico Status',
      'Beneficiaries',
      'Usage',
    ]);
    const machineToMachine = allOperations()
      .filter((operation) => operation.tags?.some((tag) => families.has(tag)))
      .filter(acceptsApiKey)
      .map((operation) => operation.operationId);

    assert.deepEqual(machineToMachine.sort(), [...SDK_OPERATIONS].sort());
  });

  it('ninguna operación que sólo acepta la cookie de sesión tiene método', () => {
    const cookieOnly = allOperations()
      .filter((operation) => !acceptsApiKey(operation))
      .map((operation) => operation.operationId);

    // La importación masiva de validaciones es una de ellas.
    assert.ok(cookieOnly.includes('createValidationImport'));
    assert.deepEqual(
      cookieOnly.filter((operationId) => SDK_OPERATIONS.includes(operationId)),
      [],
    );
  });
});
