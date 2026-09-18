/**
 * Candados sobre `spec/openapi.yaml`.
 *
 * El spec de este repositorio es copia de la versión pública
 * (https://docs.veriko.mx/openapi.yaml), ya filtrada por `x-visibility`. El
 * bundle interno trae las 264 rutas `/admin/*` con sus schemas, y en septiembre
 * de 2026 llegó a publicarse por un endpoint que lo leía sin filtrar. Estas
 * pruebas fallan si alguien sustituye la copia por ese bundle.
 *
 * La segunda parte compara los tipos de los cuerpos de `POST /v1/validate` y de
 * `POST /v1/validate-ocr`, que se escriben a mano, con los campos que declara el
 * spec.
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
      { properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown }
    >;
  };
}

const raw = readFileSync(SPEC_PATH, 'utf8');
const spec = parse(raw) as SpecDocument;

describe('el spec del repositorio es el público', () => {
  it('no declara ninguna ruta de administración', () => {
    const admin = Object.keys(spec.paths).filter((ruta) => ruta.startsWith('/admin'));

    assert.deepEqual(admin, []);
  });

  it('declara las rutas públicas', () => {
    assert.ok(Object.keys(spec.paths).length > 50);
    assert.ok('/validate' in spec.paths);
    assert.ok('/validations/{id}/cep' in spec.paths);
    assert.ok('/webhooks' in spec.paths);
  });

  it('no conserva las extensiones internas del bundle', () => {
    for (const marca of ['x-visibility:', 'x-permission:', 'x-admin-notes:']) {
      assert.equal(raw.includes(marca), false, `el spec conserva ${marca}`);
    }
  });

  it('los tipos generados no declaran rutas de administración', () => {
    const generated = readFileSync(join(PROJECT_ROOT, 'src', 'generated', 'openapi.ts'), 'utf8');

    assert.equal(/^ +"\/admin/m.test(generated), false);
  });
});

describe('el cuerpo de POST /v1/validate sigue al spec', () => {
  const schema = spec.components.schemas['ValidationRequest'];

  it('tiene los mismos campos que el tipo del SDK', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(Object.keys(schema.properties), [...VALIDATION_REQUEST_FIELDS]);
  });

  it('exige fecha y monto', () => {
    assert.deepEqual(schema?.required, ['fecha', 'monto']);
  });
});

describe('el cuerpo de POST /v1/validate-ocr sigue al spec', () => {
  const schema = spec.components.schemas['OcrValidationRequest'];

  it('tiene los mismos campos que el tipo del SDK', () => {
    assert.ok(schema?.properties);
    assert.deepEqual(Object.keys(schema.properties), [...OCR_VALIDATION_REQUEST_FIELDS]);
  });

  it('exige la imagen o su URL', () => {
    assert.deepEqual(schema?.anyOf, [{ required: ['image'] }, { required: ['image_url'] }]);
  });
});
