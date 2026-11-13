/** The constants that mirror spec data stay equal to it. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import {
  CEP_FORMATS,
  EXPORT_FORMATS,
  RETRYABLE_OUTCOMES,
  TERMINAL_STATUSES,
  WEBHOOK_EVENTS,
} from '../src/types.js';
import { PROJECT_ROOT } from './harness.js';

interface Schema {
  $ref?: string;
  enum?: string[];
  'x-terminal-values'?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  allOf?: Schema[];
}

interface Parameter {
  name?: string;
  schema?: Schema;
}

interface Operation {
  operationId: string;
  parameters?: Parameter[];
}

interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
}

const spec = parse(readFileSync(join(PROJECT_ROOT, 'spec', 'openapi.yaml'), 'utf8')) as Spec;

function operation(operationId: string): Operation {
  for (const item of Object.values(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const candidate = item[method] as Operation | undefined;
      if (candidate?.operationId === operationId) return candidate;
    }
  }
  throw new Error(`the spec does not declare ${operationId}`);
}

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split('/').pop() ?? '';
  const resolved = spec.components.schemas[name];
  assert.ok(resolved, `the spec does not declare ${schema.$ref}`);
  return resolved;
}

function properties(schema: Schema): Record<string, Schema> {
  const resolved = resolveSchema(schema);
  return Object.assign(
    {},
    ...(resolved.allOf ?? []).map(properties),
    resolved.properties ?? {},
  ) as Record<string, Schema>;
}

function parameterSchema(operationId: string, name: string): Schema {
  const parameter = operation(operationId).parameters?.find((item) => item.name === name);
  assert.ok(parameter?.schema, `${operationId} does not declare the parameter ${name}`);
  return parameter.schema;
}

describe('the constants that mirror the spec', () => {
  it('keep the validation states and which are terminal', () => {
    const validation = properties(spec.components.schemas['Validation']!);
    const attributes = properties(validation['attributes']!);
    const status = attributes['status'];
    const statuses = ['queued', 'processing', ...TERMINAL_STATUSES];

    assert.deepEqual([...statuses].sort(), [...(status?.enum ?? [])].sort());
    assert.deepEqual(
      [...TERMINAL_STATUSES].sort(),
      [...(status?.['x-terminal-values'] ?? [])].sort(),
    );
  });

  it('keeps the retryable outcomes', () => {
    const policy = properties(spec.components.schemas['RetryPolicy']!);

    assert.deepEqual(
      [...RETRYABLE_OUTCOMES].sort(),
      [...(policy['outcomes']?.items?.enum ?? [])].sort(),
    );
  });

  it('keeps the validation events an endpoint subscribes to', () => {
    const request = properties(spec.components.schemas['CreateWebhookRequest']!);
    const subscribable = request['events']?.items?.enum ?? [];
    const validationEvents = WEBHOOK_EVENTS.filter((event) => event.startsWith('validation.'));

    assert.deepEqual(
      validationEvents.filter((event) => !subscribable.includes(event)),
      [],
    );
    assert.deepEqual(
      subscribable.filter(
        (event) => event.startsWith('validation.') && !validationEvents.includes(event as never),
      ),
      [],
    );
  });

  it('WEBHOOK_EVENTS lists the event types of the contract, billing.* included', () => {
    assert.deepEqual(
      [...WEBHOOK_EVENTS],
      [
        'validation.completed',
        'validation.failed',
        'validation.error',
        'validation.retry.scheduled',
        'validation.retry.resolved',
        'validation.retry.exhausted',
        'validation.returned',
        'billing.payment_succeeded',
        'billing.payment_failed',
        'billing.trial_will_end',
        'billing.subscription_canceled',
        'billing.invoice_upcoming',
      ],
    );
  });

  it('keeps the CEP formats', () => {
    assert.deepEqual(
      [...CEP_FORMATS].sort(),
      [...(parameterSchema('downloadCep', 'format').enum ?? [])].sort(),
    );
  });

  it('keeps the formats of every export', () => {
    const operationIds = [
      'exportValidations',
      'exportWebhookDeliveries',
      'exportAllDeliveries',
      'exportBeneficiaries',
      'exportApiUsage',
    ];
    for (const operationId of operationIds) {
      assert.deepEqual(
        [...EXPORT_FORMATS].sort(),
        [...(parameterSchema(operationId, 'format').enum ?? [])].sort(),
      );
    }
  });
});
