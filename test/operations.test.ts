/**
 * The 75 M2M operations the SDK covers, against the public spec.
 *
 * Each case calls a method with all its optional arguments and checks that what
 * reached the server exists in the spec: the method and the path, the query
 * parameters, the headers and the body fields. A body without the `retry_policy`
 * wrapper, or a filter with another name, fails here.
 *
 * Each operation must also be machine-to-machine: it accepts `ApiKeyAuth` or is
 * public with `security: []`. An operation that does not meet that cannot enter
 * this spec or the SDK.
 *
 * The second part compares the full set, without depending on tags or on a list
 * of families. A new M2M operation cannot go through without a method.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { Veriko, type ValidationFilters } from '../src/index.js';
import { PROJECT_ROOT, RecordingServer, TEST_API_KEY, makeClient } from './harness.js';

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

const spec = parse(
  readFileSync(
    process.env['VERIKO_TEST_SPEC'] ?? join(PROJECT_ROOT, 'spec', 'openapi.yaml'),
    'utf8',
  ),
) as Spec;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * `true` when the operation is machine-to-machine: it accepts the API key or is
 * public and asks for no authentication (`security: []`, or an empty alternative).
 * The operation's own `security` wins over the document's.
 */
function acceptsApiKeyIn(document: Pick<Spec, 'security'>, operation: Operation): boolean {
  const schemes = operation.security ?? document.security ?? [];
  return (
    schemes.length === 0 ||
    schemes.some(
      (alternative) => 'ApiKeyAuth' in alternative || Object.keys(alternative).length === 0,
    )
  );
}

function acceptsApiKey(operation: Operation): boolean {
  return acceptsApiKeyIn(spec, operation);
}

/** Every operation of a spec, whatever its HTTP method. */
function operationsOf(document: Pick<Spec, 'paths'>): Operation[] {
  return Object.values(document.paths).flatMap((item) =>
    HTTP_METHODS.map((method) => item[method] as Operation | undefined).filter(
      (operation): operation is Operation => operation !== undefined,
    ),
  );
}

/** The M2M set of a spec: what the SDK has to cover, derived and never listed by hand. */
function m2mSet(document: Pick<Spec, 'paths' | 'security'>): Set<string> {
  return new Set(
    operationsOf(document)
      .filter((operation) => acceptsApiKeyIn(document, operation))
      .map((operation) => operation.operationId),
  );
}

/** Every operation of the spec. */
function allOperations(): Operation[] {
  return operationsOf(spec);
}

function resolveParameter(parameter: Parameter): Parameter {
  if (!parameter.$ref) return parameter;
  const resolved = spec.components.parameters[parameter.$ref.split('/').pop() ?? ''];
  assert.ok(resolved, `the spec does not declare the parameter ${parameter.$ref}`);
  return resolved;
}

function resolveSchema(schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema;
  return spec.components.schemas[schema.$ref.split('/').pop() ?? ''];
}

/** The spec operation a request corresponds to. Literal paths win over those with `{id}`. */
function locate(method: string, pathname: string): { template: string; operation: Operation } {
  const found = Object.entries(spec.paths)
    .filter(([template, item]) => {
      const pattern = new RegExp(`^${template.replace(/\{[^/]+\}/g, '[^/]+')}$`);
      return item[method.toLowerCase()] !== undefined && pattern.test(pathname);
    })
    .sort(([a], [b]) => Number(a.includes('{')) - Number(b.includes('{')))[0];
  assert.ok(found, `the spec does not declare ${method} ${pathname}`);
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
  banks: ['40012', '40014', '40072'],
  amountMin: 1000.5,
  amountMax: 50000,
  clientRef: 'order-4812',
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
  /** The case passes every query parameter the operation declares. */
  allQuery?: true;
  /** The case passes every body field the schema declares. */
  allBody?: true;
  /** Body fields the case omits because they exclude another one it does pass. */
  without?: readonly string[];
}

const CANDIDATES = ['012180004412345678', '002010077777777771'];
const PURGE_TOKEN = 'eyJhZG1pbl9pZCI6Ii4uLiJ9.q1w2e3r4t5y6u7i8o9p0';

const CASES: Case[] = [
  {
    operationId: 'validateDirect',
    recording: 'validate-valid',
    allBody: true,
    call: (client) =>
      client.validations.validate({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        numericReference: '1234567',
        senderBank: 'BANCO NACIONAL DE MEXICO',
        receiverBank: 'BBVA MEXICO',
        beneficiaryAccount: '012180004412345678',
        recipientIsBank: true,
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        idempotencyKey: 'order-1',
      }),
    without: ['candidate_accounts'],
  },
  {
    operationId: 'validateDirect',
    recording: 'validate-candidates',
    allBody: true,
    call: (client) =>
      client.validations.validate({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        numericReference: '1234567',
        senderBank: 'BANCO NACIONAL DE MEXICO',
        receiverBank: 'BBVA MEXICO',
        candidateAccounts: CANDIDATES,
        recipientIsBank: true,
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        idempotencyKey: 'order-1',
      }),
    without: ['beneficiary_account'],
  },
  {
    operationId: 'validateDirect',
    recording: 'validate-queued',
    allQuery: true,
    allBody: true,
    call: (client) =>
      client.validations.enqueue({
        sendDate: '2025-03-15',
        amount: 15000.5,
        trackingKey: 'MXBA20250315001234',
        numericReference: '1234567',
        senderBank: 'BANCO NACIONAL DE MEXICO',
        receiverBank: 'BBVA MEXICO',
        beneficiaryAccount: '012180004412345678',
        recipientIsBank: true,
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        idempotencyKey: 'order-1',
      }),
    without: ['candidate_accounts'],
  },
  {
    operationId: 'validateOcr',
    recording: 'validate-ocr',
    allBody: true,
    call: (client) =>
      client.validations.validateOcr({
        image: Buffer.from('image'),
        imageUrl: 'https://example.mx/comprobante.png',
        beneficiaryAccount: '012180004412345678',
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        retainImage: false,
        senderBank: '40012',
        receiverBank: '40002',
        recipientIsBank: true,
        idempotencyKey: 'order-2',
      }),
    without: ['candidate_accounts'],
  },
  {
    operationId: 'validateOcr',
    recording: 'validate-ocr',
    allBody: true,
    call: (client) =>
      client.validations.validateOcr({
        image: Buffer.from('image'),
        imageUrl: 'https://example.mx/comprobante.png',
        candidateAccounts: CANDIDATES,
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        retainImage: true,
        senderBank: '40012',
        receiverBank: '40002',
        recipientIsBank: true,
        idempotencyKey: 'order-2',
      }),
    without: ['beneficiary_account'],
  },
  {
    operationId: 'validateOcr',
    recording: 'validate-queued',
    allQuery: true,
    allBody: true,
    call: (client) =>
      client.validations.enqueueOcr({
        image: Buffer.from('image'),
        imageUrl: 'https://example.mx/comprobante.png',
        beneficiaryAccount: '012180004412345678',
        retryPolicy: POLICY,
        clientRef: 'order-4812',
        retainImage: false,
        senderBank: '40012',
        receiverBank: '40002',
        recipientIsBank: true,
        idempotencyKey: 'order-2',
      }),
    without: ['candidate_accounts'],
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
    call: (client) => client.validations.setRetryPolicy(ID, POLICY, { idempotencyKey: 'order-3' }),
  },
  {
    operationId: 'cancelValidationRetries',
    recording: 'retries-cancelled',
    call: (client) => client.validations.cancelRetries(ID, { idempotencyKey: 'order-4' }),
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
    operationId: 'recheckValidation',
    recording: 'validation-recheck-returned',
    call: (client) => client.validations.recheck(ID),
  },
  {
    operationId: 'prepareValidationPurge',
    recording: 'validation-purge-prepare',
    call: (client) => client.validations.preparePurge(ID),
  },
  {
    operationId: 'executeValidationPurge',
    recording: 'validation-purge-executed',
    allBody: true,
    call: (client) => client.validations.executePurge(ID, { confirmationToken: PURGE_TOKEN }),
  },
  {
    operationId: 'createWebhook',
    recording: 'webhook-created',
    allBody: true,
    call: (client) =>
      client.webhooks.create({
        url: 'https://myapp.example.com/hooks/payments',
        events: ['validation.completed'],
        description: 'Cash payments',
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
        url: 'https://myapp.example.com/hooks/new',
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
    allBody: true,
    call: (client) => client.webhooks.regenerateSecret(WEBHOOK, { immediate: true }),
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
        status: ['retrying', 'failed'],
        eventType: 'validation.completed',
        responseStatus: ['5xx', 'none'],
        validationId: ID,
        q: 'erp.example.com',
        from: '2026-10-01',
        to: '2026-10-15T23:59:59Z',
        minAttempt: 2,
        minResponseTimeMs: 3000,
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
      client.webhooks.exportDeliveries([WEBHOOK, WEBHOOK], {
        format: 'xlsx',
        limit: 100,
        status: 'failed',
        eventType: ['validation.failed', 'validation.error'],
        responseStatus: 404,
        validationId: ID,
        q: 'erp.example.com',
        from: '2026-10-01',
        to: '2026-10-15',
        minAttempt: 2,
        minResponseTimeMs: 3000,
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
    operationId: 'getSpeiCalendar',
    recording: 'spei-calendar',
    call: (client) => client.catalog.speiCalendar(2026, { ifNoneMatch: '"a1b2c3d4e5f6"' }),
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
        label: 'Supplier X',
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
        label: 'Supplier Y',
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
    operationId: 'lookupBeneficiaryAccount',
    recording: 'beneficiary-lookup',
    allQuery: true,
    call: (client) => client.beneficiaries.lookup('012180004412345678'),
  },
  {
    operationId: 'validateAccount',
    recording: 'beneficiary-validate-account',
    allQuery: true,
    call: (client) =>
      client.beneficiaries.validateAccount({ account: '01218000441234567', type: 'clabe' }),
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
      client.beneficiaries.importStart(Buffer.from('account,alias\n012180004412345678,X\n'), {
        parseMode: 'free',
        filename: 'list.csv',
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
        parsedLabel: 'Supplier X',
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
  {
    operationId: 'myProfile',
    recording: 'account-profile',
    call: (client) => client.account.myProfile(),
  },
  {
    operationId: 'getMyRetryPolicy',
    recording: 'account-retry-policy',
    call: (client) => client.account.getMyRetryPolicy(),
  },
  {
    operationId: 'updateMyRetryPolicy',
    recording: 'account-retry-policy-updated',
    allBody: true,
    call: (client) => client.account.updateMyRetryPolicy(POLICY, { idempotencyKey: 'order-5' }),
  },
  {
    operationId: 'getDashboardSummary',
    recording: 'dashboard-summary',
    allQuery: true,
    call: (client) => client.dashboard.getSummary({ limit: 5 }),
  },
  {
    operationId: 'listPublicPlans',
    recording: 'public-plans',
    call: (client) => client.plans.listPublic(),
  },
  {
    operationId: 'getPublicPlanComparison',
    recording: 'public-plan-comparison',
    call: (client) => client.plans.getPublicPlanComparison(),
  },
  {
    operationId: 'getUserInsightsOverview',
    recording: 'insights-overview',
    call: (client) => client.insights.getOverview(),
  },
  {
    operationId: 'getUserInsightsTrends',
    recording: 'insights-trends',
    allQuery: true,
    call: (client) => client.insights.getTrends({ range: '30d', metric: 'latency' }),
  },
  {
    operationId: 'getUserInsightsTopBanks',
    recording: 'insights-top-banks',
    allQuery: true,
    call: (client) => client.insights.getTopBanks({ metric: 'errors', limit: 10 }),
  },
  {
    operationId: 'getUserInsightsTopBeneficiaries',
    recording: 'insights-top-beneficiaries',
    allQuery: true,
    call: (client) => client.insights.getTopBeneficiaries({ limit: 10 }),
  },
  {
    operationId: 'getFinanceSummary',
    recording: 'finance-summary',
    allQuery: true,
    call: (client) => client.finance.getSummary({ month: '2026-04', userId: ID }),
  },
  {
    operationId: 'getFinanceStatement',
    recording: 'finance-statement',
    allQuery: true,
    call: (client) => client.finance.getStatement({ month: '2026-04', format: 'pdf', userId: ID }),
  },
  {
    operationId: 'getFinanceMonthly',
    recording: 'finance-monthly',
    allQuery: true,
    call: (client) =>
      client.finance.getMonthly({ month: '2026-04', format: 'preview', userId: ID, limit: 100 }),
  },
  {
    operationId: 'getFinanceCounterparties',
    recording: 'finance-counterparties',
    allQuery: true,
    call: (client) =>
      client.finance.getCounterparties({
        month: '2026-04',
        format: 'preview',
        userId: ID,
        limit: 100,
      }),
  },
  {
    operationId: 'getFinanceByBank',
    recording: 'finance-by-bank',
    allQuery: true,
    call: (client) =>
      client.finance.getByBank({ month: '2026-04', format: 'preview', userId: ID, limit: 100 }),
  },
  {
    operationId: 'getFinanceAccounting',
    recording: 'finance-accounting',
    allQuery: true,
    call: (client) =>
      client.finance.getAccounting({
        month: '2026-04',
        format: 'preview',
        userId: ID,
        limit: 100,
        decimal: 'dot',
      }),
  },
  {
    operationId: 'getFinanceCeps',
    recording: 'finance-ceps',
    allQuery: true,
    call: (client) => client.finance.getCeps({ from: '2026-04-01', to: '2026-04-30', userId: ID }),
  },
  {
    operationId: 'createFinanceCepExport',
    recording: 'finance-cep-export-queued',
    allBody: true,
    call: (client) =>
      client.finance.createCepExport({
        from: '2026-04-01',
        to: '2026-04-30',
        userId: ID,
        idempotencyKey: 'order-6',
      }),
  },
  {
    operationId: 'listFinanceCepExports',
    recording: 'finance-cep-exports',
    call: (client) => client.finance.listCepExports(),
  },
  {
    operationId: 'getFinanceCepExport',
    recording: 'finance-cep-export-ready',
    call: (client) => client.finance.getCepExport(ID),
  },
  {
    operationId: 'downloadFinanceCepExport',
    recording: 'finance-ceps',
    call: (client) => client.finance.downloadCepExport(ID),
  },
  {
    operationId: 'billingGetSubscription',
    recording: 'billing-subscription',
    call: (client) => client.billing.getSubscription(),
  },
];

/** The full M2M surface derives from the public spec. */
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
  'recheckValidation',
  'prepareValidationPurge',
  'executeValidationPurge',
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
  'getSpeiCalendar',
  'banxicoPublicStatus',
  'banxicoPublicTimeseries',
  'createBeneficiary',
  'listBeneficiaries',
  'updateBeneficiary',
  'deleteBeneficiary',
  'lookupBeneficiaryAccount',
  'validateAccount',
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
  'myProfile',
  'getMyRetryPolicy',
  'updateMyRetryPolicy',
  'getDashboardSummary',
  'listPublicPlans',
  'getPublicPlanComparison',
  'getUserInsightsOverview',
  'getUserInsightsTrends',
  'getUserInsightsTopBanks',
  'getUserInsightsTopBeneficiaries',
  'getFinanceSummary',
  'getFinanceStatement',
  'getFinanceMonthly',
  'getFinanceCounterparties',
  'getFinanceByBank',
  'getFinanceAccounting',
  'getFinanceCeps',
  'createFinanceCepExport',
  'listFinanceCepExports',
  'getFinanceCepExport',
  'downloadFinanceCepExport',
  'billingGetSubscription',
];

/**
 * It must stay empty: the test below prevents turning it into a permanent allowlist.
 */
const KNOWN_GAPS = new Set<string>();

function m2mOperationIds(): Set<string> {
  return m2mSet(spec);
}

function coverageErrors(
  contract: ReadonlySet<string>,
  implemented: ReadonlySet<string>,
  knownGaps: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const missing = [...contract].filter(
    (operationId) => !implemented.has(operationId) && !knownGaps.has(operationId),
  );
  const obsolete = [...implemented].filter((operationId) => !contract.has(operationId));
  const implementedGaps = [...knownGaps].filter((operationId) => implemented.has(operationId));
  const staleGaps = [...knownGaps].filter((operationId) => !contract.has(operationId));

  if (missing.length) errors.push(`Missing methods for M2M: ${missing.sort().join(', ')}`);
  if (obsolete.length)
    errors.push(`Methods outside the M2M contract: ${obsolete.sort().join(', ')}`);
  if (implementedGaps.length)
    errors.push(`known_gaps already has a method: ${implementedGaps.sort().join(', ')}`);
  if (staleGaps.length)
    errors.push(`known_gaps no longer exists in the contract: ${staleGaps.sort().join(', ')}`);
  return errors;
}

/** What the cases sent, by operation: the query parameters and the body fields. */
const SENT = new Map<string, { query: Set<string>; body: Set<string> }>();

describe('what the SDK sends exists in the spec', () => {
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
        assert.ok(acceptsApiKey(operation), `${template} does not accept the API key`);

        const queryNames = declared(template, operation, 'query');
        // PHP reads a repeated value as an array only under `name[]`.
        const sentQuery = [...url.searchParams.keys()].map((name) => name.replace(/\[\]$/, ''));
        for (const name of sentQuery) {
          assert.ok(
            queryNames.includes(name),
            `${template}: the spec does not declare the parameter ${name}`,
          );
        }
        const seen = SENT.get(testCase.operationId) ?? { query: new Set(), body: new Set() };
        SENT.set(testCase.operationId, seen);
        for (const name of sentQuery) seen.query.add(name);

        if (testCase.allQuery) assert.deepEqual([...sentQuery].sort(), [...queryNames].sort());

        const headerNames = declared(template, operation, 'header').map((name) =>
          name.toLowerCase(),
        );
        for (const name of ['idempotency-key', 'if-none-match']) {
          if (name in sent.headers) {
            assert.ok(
              headerNames.includes(name),
              `${template}: the spec does not declare the header ${name}`,
            );
          }
        }

        if (sent.body.length > 0) {
          const contentType = (sent.headers['content-type'] ?? '').split(';')[0] ?? '';
          const schema = resolveSchema(operation.requestBody?.content?.[contentType]?.schema);
          assert.ok(
            schema?.properties,
            `${template}: the spec does not describe the body ${contentType}`,
          );
          // In a multipart form, the fields are the `name` of each part.
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
          for (const key of bodyKeys) seen.body.add(key);
          for (const key of bodyKeys) {
            assert.ok(
              key in schema.properties,
              `${template}: the spec does not declare the field ${key}`,
            );
          }
          if (testCase.allBody) {
            assert.deepEqual(
              [...bodyKeys].sort(),
              Object.entries(schema.properties)
                // The previous names (`x-alias-of`) are accepted, and the SDK does not send them.
                .filter(([, property]) => !(property as { 'x-alias-of'?: string })['x-alias-of'])
                .map(([key]) => key)
                .filter((key) => !(testCase.without ?? []).includes(key))
                .sort(),
            );
          }
        }
      } finally {
        await server.close();
      }
    });
  }
});

describe('the covered set of M2M operations', () => {
  const implemented = new Set(SDK_OPERATIONS);
  const covered = new Set(CASES.map((testCase) => testCase.operationId));

  it('covers exactly the M2M operations the spec declares, with no partial families', () => {
    const contract = m2mOperationIds();

    // The set comes from `spec/openapi.yaml` (the operations that accept `ApiKeyAuth` or have
    // `security: []`), not from a count or a list written here: when the contract adds or
    // removes an operation, this fails until the SDK follows.
    assert.equal(implemented.size, SDK_OPERATIONS.length, 'SDK_OPERATIONS has a duplicate');
    assert.ok(contract.size > 0);
    assert.deepEqual([...implemented].sort(), [...contract].sort());
    assert.deepEqual(covered, implemented);
    assert.deepEqual(coverageErrors(contract, implemented, KNOWN_GAPS), []);
  });

  it('no query parameter or body field of the spec is left without support', () => {
    const unsupported: string[] = [];
    for (const [template, item] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as Operation | undefined;
        if (!operation || !implemented.has(operation.operationId)) continue;
        const sent = SENT.get(operation.operationId) ?? { query: new Set(), body: new Set() };

        for (const name of declared(template, operation, 'query')) {
          if (!sent.query.has(name)) unsupported.push(`${operation.operationId}: query ${name}`);
        }
        const content = Object.values(operation.requestBody?.content ?? {})[0];
        const properties = resolveSchema(content?.schema)?.properties ?? {};
        for (const [name, property] of Object.entries(properties)) {
          // The previous names (`x-alias-of`) are accepted, and the SDK does not send them.
          if ((property as { 'x-alias-of'?: string })['x-alias-of']) continue;
          if (!sent.body.has(name)) unsupported.push(`${operation.operationId}: body ${name}`);
        }
      }
    }

    assert.deepEqual(
      unsupported,
      [],
      `Parameters of the spec that no method sends: ${unsupported.join('; ')}`,
    );
  });

  it('every operation of the spec has a unique operationId', () => {
    const ids = allOperations().map((operation) => operation.operationId);

    assert.ok(ids.every((id) => typeof id === 'string' && id !== ''));
    assert.equal(new Set(ids).size, ids.length);
  });

  it('derives the M2M set from the security of each operation', () => {
    const operation = (security?: Record<string, unknown>[]): Record<string, unknown> => ({
      operationId: '',
      responses: {},
      ...(security === undefined ? {} : { security }),
    });
    const fake = {
      security: [{ BearerAuth: [] }],
      paths: {
        '/a': { get: { ...operation(), operationId: 'inherits' } },
        '/b': { get: { ...operation([{ ApiKeyAuth: [] }]), operationId: 'apiKey' } },
        '/c': { get: { ...operation([]), operationId: 'public' } },
        '/d': { post: { ...operation([{ BearerAuth: [] }]), operationId: 'bearerOnly' } },
        '/e': {
          delete: { ...operation([{ BearerAuth: [] }, { ApiKeyAuth: [] }]), operationId: 'either' },
        },
        '/f': { head: { ...operation([{}]), operationId: 'anonymousAlternative' } },
        '/g': { patch: { ...operation([{ CookieAuth: [] }]), operationId: 'cookieOnly' } },
      },
    } as unknown as Spec;

    assert.deepEqual(
      [...m2mSet(fake)].sort(),
      ['anonymousAlternative', 'apiKey', 'either', 'public'].sort(),
    );
    // With an `ApiKeyAuth` default, an operation without its own `security` is M2M.
    assert.ok(m2mSet({ ...fake, security: [{ ApiKeyAuth: [] }] }).has('inherits'));
    // A document with no default and an operation without `security` is public.
    assert.ok(m2mSet({ ...fake, security: undefined }).has('inherits'));
  });

  it('every operation of the spec accepts the API key', () => {
    const withoutApiKey = allOperations()
      .filter((operation) => !acceptsApiKey(operation))
      .map((operation) => operation.operationId);

    assert.deepEqual(
      withoutApiKey,
      [],
      `Operations that do not accept the API key: ${withoutApiKey.join(', ')}`,
    );
    assert.deepEqual(
      withoutApiKey.filter((operationId) => implemented.has(operationId)),
      [],
    );
  });

  it('requires the exceptions list to be empty before release', () => {
    assert.equal(KNOWN_GAPS.size, 0, 'known_gaps must be empty before releasing the SDK');
  });

  it('fails closed if an M2M operation is added, removed or hidden', () => {
    const contract = m2mOperationIds();
    const removed = 'myProfile';
    const future = 'futureM2mOperation';

    assert.deepEqual(coverageErrors(new Set([...contract, future]), implemented, new Set()), [
      `Missing methods for M2M: ${future}`,
    ]);
    assert.deepEqual(
      coverageErrors(
        new Set([...contract].filter((operationId) => operationId !== removed)),
        implemented,
        new Set(),
      ),
      [`Methods outside the M2M contract: ${removed}`],
    );
    assert.deepEqual(coverageErrors(contract, implemented, new Set([removed])), [
      `known_gaps already has a method: ${removed}`,
    ]);
    assert.deepEqual(coverageErrors(contract, implemented, new Set([future])), [
      `known_gaps no longer exists in the contract: ${future}`,
    ]);
  });
});

it('the public plans work without an API key and send no Authorization', async () => {
  const server = await RecordingServer.start();
  try {
    server.enqueue('public-plans');
    const client = new Veriko({ apiKey: '', baseUrl: server.baseUrl, maxRetries: 0 });

    await client.plans.listPublic();

    assert.equal(server.header(0, 'authorization'), undefined);
  } finally {
    await server.close();
  }
});

it('the finance reports keep csv as the default format', async () => {
  const server = await RecordingServer.start();
  try {
    server.enqueue('deliveries-export-csv', 4);
    const client = new Veriko({ apiKey: TEST_API_KEY, baseUrl: server.baseUrl, maxRetries: 0 });

    await client.finance.getMonthly({ month: '2026-04' });
    await client.finance.getCounterparties({ month: '2026-04' });
    await client.finance.getByBank({ month: '2026-04' });
    await client.finance.getAccounting({ month: '2026-04' });

    const expectedPaths = [
      '/v1/finance/monthly',
      '/v1/finance/counterparties',
      '/v1/finance/by-bank',
      '/v1/finance/accounting',
    ];
    for (const [index, expectedPath] of expectedPaths.entries()) {
      const url = new URL(server.request(index).url, 'http://localhost');
      assert.equal(url.pathname, expectedPath);
      assert.equal(url.searchParams.get('month'), '2026-04');
      assert.equal(url.searchParams.get('format'), 'csv');
    }
  } finally {
    await server.close();
  }
});
