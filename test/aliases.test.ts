/** English names and previous Spanish names: inputs, outputs and warnings. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  InvalidRequestError,
  Veriko,
  type ValidateOcrParams,
  type ValidateTransferParams,
} from '../src/index.js';
import { fillValidation, resetDeprecationWarnings } from '../src/aliases.js';
import { RecordingServer, makeClient } from './harness.js';

/** The previous names are not part of the typed API: they reach the SDK through an untyped path. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function legacy<T>(params: object): T {
  return params as T;
}

const OLD_TRANSFER_FIELDS = {
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
  referenciaNumerica: '1234567',
  emisor: 'BANCO NACIONAL DE MEXICO',
  receptor: 'BBVA MEXICO',
  cuentaBeneficiaria: '012180004412345678',
  receptorParticipante: 1,
} as const;
const OLD_TRANSFER = legacy<ValidateTransferParams>(OLD_TRANSFER_FIELDS);

describe('deprecated input names', () => {
  let server: RecordingServer;
  let client: Veriko;
  let warnings: { message: string; type: unknown }[];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalEmit = process.emitWarning;

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    process.emitWarning = originalEmit;
    await server.close();
  });

  beforeEach(() => {
    server.reset();
    client = makeClient(server, []);
    warnings = [];
    resetDeprecationWarnings();
    process.emitWarning = (message: string | Error, type?: unknown) => {
      warnings.push({ message: String(message), type });
    };
  });

  it('the previous names keep working and travel with the English name', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer(OLD_TRANSFER);

    assert.deepEqual(server.json(0), {
      send_date: '2025-03-15',
      amount: 15000.5,
      tracking_key: 'MXBA20250315001234',
      numeric_reference: '1234567',
      sender_bank: 'BANCO NACIONAL DE MEXICO',
      receiver_bank: 'BBVA MEXICO',
      beneficiary_account: '012180004412345678',
      recipient_is_bank: true,
    });
  });

  it('each previous name warns once, as a DeprecationWarning', async () => {
    server.enqueue('validate-valid');
    server.enqueue('validate-valid');

    await client.validateTransfer(OLD_TRANSFER);
    const first = warnings.length;
    await client.validateTransfer(OLD_TRANSFER);

    assert.equal(first, Object.keys(OLD_TRANSFER).length);
    assert.equal(warnings.length, first);
    for (const warning of warnings) assert.equal(warning.type, 'DeprecationWarning');
    assert.ok(
      warnings.some((warning) =>
        warning.message.startsWith('`claveRastreo` is deprecated: use `trackingKey`.'),
      ),
    );
  });

  it('there are no warnings with the English names', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 100,
      trackingKey: 'X',
      beneficiaryAccount: '012180004412345678',
    });

    assert.deepEqual(warnings, []);
  });

  it('without process.emitWarning the warning is skipped and the call goes on', async () => {
    server.enqueue('validate-valid');
    // @ts-expect-error simulates a runtime without emitWarning
    process.emitWarning = undefined;

    await client.validateTransfer(OLD_TRANSFER);

    assert.equal(server.requests.length, 1);
  });

  it('a previous name and its new name together fail before reaching the API', async () => {
    const both = {
      sendDate: '2025-03-15',
      fecha: '2025-03-15',
      amount: 100,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    };

    await assert.rejects(
      () => client.validateTransfer({ ...both }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'alias_conflict');
        assert.match(error.message, /sendDate or fecha/);
        return true;
      },
    );
    assert.equal(server.requests.length, 0);
  });

  it('amount and monto together also fail', async () => {
    await assert.rejects(
      () =>
        client.validateTransfer({
          trackingKey: 'X',
          beneficiaryAccount: '012180004412345678',
          amount: 1,
          monto: 1,
        } as never),
      (error: unknown) => error instanceof InvalidRequestError && error.code === 'alias_conflict',
    );
    assert.equal(server.requests.length, 0);
  });

  it('the OCR accepts the previous names and sends the English ones', async () => {
    server.enqueue('validate-ocr');

    await client.validations.validateOcr(
      legacy<ValidateOcrParams>({
        image: Buffer.from('png'),
        cuentaBeneficiaria: '012180004412345678',
        bancoEmisor: '40012',
        bancoReceptor: '40002',
      }),
    );

    const body = server.json(0);
    assert.equal(body['beneficiary_account'], '012180004412345678');
    assert.equal(body['sender_bank'], '40012');
    assert.equal(body['receiver_bank'], '40002');
    for (const old of ['cuenta_beneficiaria', 'banco_emisor', 'banco_receptor']) {
      assert.equal(old in body, false);
    }
  });

  it('cuentasCandidatas, the previous name, travels as candidate_accounts', async () => {
    server.enqueue('validate-candidates');

    await client.validateTransfer(
      legacy<ValidateTransferParams>({
        sendDate: '2025-03-15',
        amount: 100,
        trackingKey: 'X',
        cuentasCandidatas: ['012180004412345678', '002010077777777771'],
      }),
    );

    assert.deepEqual(server.json(0)['candidate_accounts'], [
      '012180004412345678',
      '002010077777777771',
    ]);
    assert.equal('cuentas_candidatas' in server.json(0), false);
  });

  it('recipientIsBank accepts 1 and 0, and sends a boolean', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      amount: 100,
      trackingKey: 'X',
      beneficiaryAccount: '012180004412345678',
      recipientIsBank: 0,
    });

    assert.equal(server.json(0)['recipient_is_bank'], false);
  });
});

describe('deprecated output names', () => {
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

  it('the validation exposes the English names and the old field gives the same value', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    const requestData = validation.attributes.request_data as Record<string, unknown>;
    assert.equal(requestData['send_date'], '2025-03-15');
    assert.equal(requestData['fecha'], requestData['send_date']);
    assert.equal(requestData['monto'], 15000.5);
    assert.equal(requestData['cuenta_beneficiaria'], requestData['beneficiary_account']);
    assert.equal(requestData['emisor'], 'BANCO NACIONAL DE MEXICO');
    // The old ones are not serialized: the JSON that is forwarded carries only the English names.
    assert.equal('fecha' in JSON.parse(JSON.stringify(requestData)), false);
  });

  it('if the API sends only Spanish, the English appears with the same value', () => {
    const legacy = {
      attributes: {
        request_data: { fecha: '2025-03-15', monto: 9 },
        normalized_data: { clave_rastreo: 'X', emisor_name: 'BANORTE' },
      },
    };

    fillValidation(legacy);

    assert.equal(legacy.attributes.request_data['send_date' as keyof object], '2025-03-15');
    assert.deepEqual(Object.keys(legacy.attributes.request_data).sort(), [
      'amount',
      'fecha',
      'monto',
      'send_date',
    ]);
    assert.equal(legacy.attributes.normalized_data['tracking_key' as keyof object], 'X');
    assert.equal(legacy.attributes.normalized_data['sender_bank_name' as keyof object], 'BANORTE');
  });

  it('a listing exposes numeric_reference and the old referencia_numerica', async () => {
    server.enqueue('validations-page1');

    const page = await client.validations.list();

    const attributes = page.items[0]?.attributes as Record<string, unknown>;
    assert.equal(attributes['numeric_reference'], '1234567');
    assert.equal(attributes['referencia_numerica'], '1234567');
  });

  it('the finance summary exposes statement_folio and the old folio', async () => {
    server.enqueue('finance-summary');

    const summary = await client.finance.summary({ month: '2026-04' });

    const attributes = summary.attributes as Record<string, unknown>;
    assert.equal(attributes['statement_folio'], 'A3F12B9C0D4E');
    assert.equal(attributes['folio'], 'A3F12B9C0D4E');
    assert.ok(Array.isArray(attributes['top_banks_emisor']));
  });
});
