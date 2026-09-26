/** Cada respuesta grabada coincide con el schema de la operación que representa. */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Ajv, type ValidateFunction } from 'ajv';
import { parse } from 'yaml';

import { PROJECT_ROOT } from './harness.js';

type JsonObject = Record<string, unknown>;

interface Recording {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
}

const RECORDINGS_DIR = join(PROJECT_ROOT, 'test', 'recordings');
const spec = parse(readFileSync(join(PROJECT_ROOT, 'spec', 'openapi.yaml'), 'utf8')) as JsonObject;
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const OPERATION_RECORDINGS: Record<string, readonly string[]> = {
  myProfile: ['account-profile'],
  getDashboardSummary: ['dashboard-summary'],
  getMyRetryPolicy: ['account-retry-policy'],
  updateMyRetryPolicy: ['account-retry-policy-updated'],
  listPublicPlans: ['public-plans'],
  getPublicPlanComparison: ['public-plan-comparison'],
  getUserInsightsOverview: ['insights-overview'],
  getUserInsightsTrends: ['insights-trends'],
  getUserInsightsTopBanks: ['insights-top-banks'],
  getUserInsightsTopBeneficiaries: ['insights-top-beneficiaries'],
  getFinanceSummary: ['finance-summary'],
  getFinanceStatement: ['finance-statement'],
  getFinanceMonthly: ['finance-monthly'],
  getFinanceCounterparties: ['finance-counterparties'],
  getFinanceByBank: ['finance-by-bank'],
  getFinanceAccounting: ['finance-accounting'],
  getFinanceCeps: ['finance-ceps'],
  billingGetSubscription: ['billing-subscription'],
  exportApiUsage: ['api-usage-export-csv'],
  getApiUsage: ['api-usage'],
  listBanks: ['banks'],
  banxicoPublicStatus: ['banxico-status'],
  banxicoPublicTimeseries: ['banxico-timeseries'],
  exportBeneficiaries: ['beneficiaries-export-csv'],
  commitBeneficiaryImport: ['beneficiaries-import-committed'],
  createBeneficiaryImport: ['beneficiaries-import-created'],
  getBeneficiaryImport: ['beneficiaries-import-parsing', 'beneficiaries-import-status'],
  getBeneficiaryImportPreview: ['beneficiaries-import-preview'],
  patchBeneficiaryImportRow: ['beneficiaries-import-row-updated'],
  downloadBeneficiaryImportTemplate: ['beneficiaries-import-template'],
  listBeneficiaries: ['beneficiaries-list'],
  createBeneficiary: ['beneficiary-created'],
  lookupBeneficiaryAccount: ['beneficiary-lookup'],
  updateBeneficiary: ['beneficiary-updated'],
  lookupBin: ['bin-lookup'],
  downloadCep: ['cep-404', 'cep-pdf', 'cep-xml'],
  exportAllDeliveries: ['deliveries-export-csv'],
  deleteValidation: ['no-content'],
  getValidation: ['not-modified', 'validation-queued-status', 'validation-retrying'],
  cancelValidationRetries: ['retries-cancelled'],
  listValidationRetryAttempts: ['retry-attempts'],
  updateValidationRetryPolicy: ['retry-policy-updated'],
  sendCepToTelegram: ['telegram-accepted'],
  getUsageBreakdown: ['usage-breakdown'],
  getUsageHeatmap: ['usage-heatmap'],
  getUsageHistory: ['usage-history'],
  getUsageLimits: ['usage-limits'],
  getUsageSummary: ['usage-summary'],
  validateDirect: [
    'validate-401',
    'validate-409',
    'validate-422',
    'validate-429',
    'validate-503',
    'validate-not-found',
    'validate-queued',
    'validate-returned',
    'validate-valid',
  ],
  validateOcr: ['validate-ocr'],
  getValidationImage: ['validation-image'],
  listValidations: ['validations-empty', 'validations-page1', 'validations-page2'],
  exportValidations: ['validations-export-csv', 'validations-export-xlsx'],
  validationStats: ['validations-stats'],
  createWebhook: ['webhook-created'],
  listAllDeliveries: ['webhook-deliveries', 'webhook-deliveries-page1', 'webhook-deliveries-page2'],
  regenerateWebhookSecret: ['webhook-secret-rotated'],
  sendWebhookTest: ['webhook-test-failed', 'webhook-test-ok'],
  updateWebhook: ['webhook-updated'],
  listWebhooks: ['webhooks-list'],
};

// Son cuerpos entrantes para probar la firma y el parser, no respuestas de una operación.
const NON_RESPONSE_RECORDINGS = new Set([
  'webhook-retry-resolved',
  'webhook-validation-completed',
  'webhook-validation-banxico-confirmed',
]);

function asObject(value: unknown, message = 'se esperaba un objeto'): JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonObject;
}

function resolve(node: JsonObject): JsonObject {
  const reference = node['$ref'];
  if (typeof reference !== 'string') return node;
  let current: unknown = spec;
  for (const part of reference.replace(/^#\//, '').split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    current = asObject(current)[key];
  }
  return asObject(current, `el spec no resuelve ${reference}`);
}

function operations(): JsonObject[] {
  const paths = asObject(spec['paths']);
  return Object.values(paths).flatMap((value) => {
    const item = asObject(value);
    return ['get', 'post', 'put', 'patch', 'delete']
      .map((method) => item[method])
      .filter((operation): operation is JsonObject => operation !== undefined)
      .map((operation) => asObject(operation));
  });
}

function operationById(operationId: string): JsonObject {
  const operation = operations().find((candidate) => candidate['operationId'] === operationId);
  assert.ok(operation, `el spec no declara ${operationId}`);
  return operation;
}

function responseSchema(operationId: string, recording: Recording): JsonObject | undefined {
  const responses = asObject(operationById(operationId)['responses']);
  const response = resolve(asObject(responses[String(recording.status)]));
  if (recording.json === undefined) return undefined;
  const contentType = Object.entries(recording.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    .split(';', 1)[0];
  assert.ok(contentType, `${operationId} no declara el tipo de la grabación`);
  const content = asObject(response['content']);
  const media = asObject(content[contentType], `${operationId} no declara ${contentType}`);
  return asObject(media['schema']);
}

function validatorFor(schema: JsonObject): ValidateFunction {
  const document = structuredClone(spec);
  document['$schema'] = 'http://json-schema.org/draft-07/schema#';
  document['x-recording-schema'] = schema;
  document['$ref'] = '#/x-recording-schema';
  return ajv.compile(document);
}

function applicableSchemas(schema: JsonObject, value: unknown): JsonObject[] {
  const resolved = resolve(schema);
  const schemas = [resolved];
  for (const part of (resolved['allOf'] as unknown[] | undefined) ?? []) {
    schemas.push(...applicableSchemas(asObject(part), value));
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    for (const candidate of (resolved[keyword] as unknown[] | undefined) ?? []) {
      const child = asObject(candidate);
      if (validatorFor(child)(value)) schemas.push(...applicableSchemas(child, value));
    }
  }
  return schemas;
}

function assertOnlyDeclared(value: unknown, source: JsonObject | JsonObject[], path = '$'): void {
  const sources = Array.isArray(source) ? source : [source];
  const schemas = sources.flatMap((schema) => applicableSchemas(schema, value));
  if (Array.isArray(value)) {
    const items = schemas.flatMap((schema) => (schema['items'] ? [asObject(schema['items'])] : []));
    value.forEach((item, index) => {
      assertOnlyDeclared(item, items, `${path}[${String(index)}]`);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, childValue] of Object.entries(value)) {
    const declared = schemas.flatMap((schema) => {
      const properties = asObject(schema['properties'] ?? {});
      return properties[key] ? [asObject(properties[key])] : [];
    });
    const allowsExtra = schemas.some((schema) => {
      const extra = schema['additionalProperties'];
      return extra === true || Boolean(extra && typeof extra === 'object');
    });
    assert.ok(declared.length > 0 || allowsExtra, `${path}.${key} no existe en el spec`);
    if (declared.length > 0) assertOnlyDeclared(childValue, declared, `${path}.${key}`);
  }
}

function recordingCases(): Array<[string, string]> {
  return Object.entries(OPERATION_RECORDINGS).flatMap(([operationId, recordings]) =>
    recordings.map((recording): [string, string] => [operationId, recording]),
  );
}

function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(RECORDINGS_DIR, `${name}.json`), 'utf8')) as Recording;
}

describe('las grabaciones siguen el spec', () => {
  it('todas tienen un contrato o son cuerpos entrantes', () => {
    const mapped = new Set(recordingCases().map(([, recording]) => recording));
    for (const recording of NON_RESPONSE_RECORDINGS) mapped.add(recording);
    const present = readdirSync(RECORDINGS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''));

    assert.deepEqual([...mapped].sort(), present.sort());
  });

  for (const [operationId, name] of recordingCases()) {
    it(`${name}: ${operationId}`, () => {
      const recording = loadRecording(name);
      const schema = responseSchema(operationId, recording);
      if (!schema) return;
      const validate = validatorFor(schema);

      assert.ok(validate(recording.json), `${name}: ${ajv.errorsText(validate.errors)}`);
      assertOnlyDeclared(recording.json, schema, name);
    });
  }
});
