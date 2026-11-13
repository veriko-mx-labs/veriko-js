/**
 * Tests over `spec/openapi.yaml`.
 *
 * The spec in this repository is a copy of the one at https://docs.veriko.mx/openapi.yaml.
 * These tests fail if the copy does not meet the contract of that API.
 *
 * The second part compares the types of the bodies of `POST /v1/validate` and
 * `POST /v1/validate-ocr`, which are written by hand, with the fields the spec
 * declares.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

import { OCR_VALIDATION_REQUEST_FIELDS, VALIDATION_REQUEST_FIELDS } from '../src/types.js';
import { PROJECT_ROOT } from './harness.js';

const SPEC_PATH = join(PROJECT_ROOT, 'spec', 'openapi.yaml');

interface SpecDocument {
  openapi: string;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<
      string,
      {
        properties?: Record<string, { 'x-alias-of'?: string } | undefined>;
        required?: string[];
        anyOf?: unknown;
        allOf?: unknown;
        not?: unknown;
      }
    >;
  };
}

const raw = readFileSync(SPEC_PATH, 'utf8');
const spec = parse(raw) as SpecDocument;

/** The canonical fields of a schema: those that are not an alias of another. */
function canonicalFields(
  properties: NonNullable<SpecDocument['components']['schemas'][string]['properties']>,
): string[] {
  return Object.entries(properties)
    .filter(([, property]) => property?.['x-alias-of'] === undefined)
    .map(([name]) => name);
}

/** The aliases of a schema, with the canonical field they point to. */
function aliasFields(
  properties: NonNullable<SpecDocument['components']['schemas'][string]['properties']>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, property]) => property?.['x-alias-of'] !== undefined)
      .map(([name, property]) => [name, property?.['x-alias-of']]),
  );
}

describe('the spec in the repository is the public one', () => {
  it('declares no administration route', () => {
    const admin = Object.keys(spec.paths).filter((route) => route.startsWith('/admin'));

    assert.deepEqual(admin, []);
  });

  it('declares the public routes', () => {
    assert.ok(Object.keys(spec.paths).length > 50);
    assert.ok('/validate' in spec.paths);
    assert.ok('/validations/{id}/cep' in spec.paths);
    assert.ok('/webhooks' in spec.paths);
  });

  it('keeps no internal bundle extensions', () => {
    for (const marker of ['x-visibility:', 'x-permission:', 'x-admin-notes:']) {
      assert.equal(raw.includes(marker), false, `the spec keeps ${marker}`);
    }
  });

  it('the generated types declare no administration routes', () => {
    const generated = readFileSync(join(PROJECT_ROOT, 'src', 'generated', 'openapi.ts'), 'utf8');

    assert.equal(/^ +"\/admin/m.test(generated), false);
  });
});

describe('the body of POST /v1/validate follows the spec', () => {
  const schema = spec.components.schemas['ValidationRequest'];

  it('has the same fields as the SDK type', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(canonicalFields(schema.properties), [...VALIDATION_REQUEST_FIELDS]);
  });

  it('declares none of the previous names', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(aliasFields(schema.properties), {});
  });

  it('requires amount and one of the two ways to give the account', () => {
    assert.deepEqual(schema?.required, ['amount']);
    assert.deepEqual(schema.allOf, [
      { oneOf: [{ required: ['beneficiary_account'] }, { required: ['candidate_accounts'] }] },
    ]);
  });
});

describe('the body of POST /v1/validate-ocr follows the spec', () => {
  const schema = spec.components.schemas['OcrValidationRequest'];

  it('has the same fields as the SDK type', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(canonicalFields(schema.properties), [...OCR_VALIDATION_REQUEST_FIELDS]);
  });

  it('declares none of the previous names', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(aliasFields(schema.properties), {});
  });

  it('requires the image or its URL', () => {
    assert.deepEqual(schema?.anyOf, [{ required: ['image'] }, { required: ['image_url'] }]);
  });

  it('does not admit the account and the candidates together', () => {
    assert.deepEqual(schema?.not, { required: ['beneficiary_account', 'candidate_accounts'] });
  });
});
