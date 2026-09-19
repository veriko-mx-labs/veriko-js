/** Las constantes que espejan datos del spec siguen siendo iguales a él. */

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
} from '../src/types.js';
import { PROJECT_ROOT } from './harness.js';

interface Schema {
  $ref?: string;
  enum?: string[];
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
  throw new Error(`el spec no declara ${operationId}`);
}

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split('/').pop() ?? '';
  const resolved = spec.components.schemas[name];
  assert.ok(resolved, `el spec no declara ${schema.$ref}`);
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
  assert.ok(parameter?.schema, `${operationId} no declara el parámetro ${name}`);
  return parameter.schema;
}

describe('las constantes que espejan el spec', () => {
  it('conservan los nueve estados de validación', () => {
    const validation = properties(spec.components.schemas['Validation']!);
    const attributes = properties(validation['attributes']!);
    const statuses = ['queued', 'processing', ...TERMINAL_STATUSES];

    assert.deepEqual([...statuses].sort(), [...(attributes['status']?.enum ?? [])].sort());
  });

  it('conserva los resultados reintentables', () => {
    const policy = properties(spec.components.schemas['RetryPolicy']!);

    assert.deepEqual(
      [...RETRYABLE_OUTCOMES].sort(),
      [...(policy['outcomes']?.items?.enum ?? [])].sort(),
    );
  });

  it('conserva los formatos del CEP', () => {
    assert.deepEqual(
      [...CEP_FORMATS].sort(),
      [...(parameterSchema('downloadCep', 'format').enum ?? [])].sort(),
    );
  });

  it('conserva los formatos de todas las exportaciones', () => {
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
