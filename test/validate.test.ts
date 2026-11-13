/** Validate a transfer: what is sent and what is read back. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { InvalidRequestError, Veriko, hasCep, isTerminal } from '../src/index.js';
import { RecordingServer, TEST_API_KEY, makeClient } from './harness.js';

describe('validateTransfer', () => {
  let server: RecordingServer;
  let client: Veriko;
  let sleeps: number[];

  before(async () => {
    server = await RecordingServer.start();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
    sleeps = [];
    client = makeClient(server, sleeps);
  });

  it('the valid verdict carries a receipt', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      numericReference: '1234567',
      senderBank: 'BANCO NACIONAL DE MEXICO',
      receiverBank: 'BBVA MEXICO',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal(validation.attributes.status, 'valid');
    assert.equal(validation.attributes.banxico_status, 'valid');
    assert.equal(validation.id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(validation.attributes.processing_time_ms, 1320);
    assert.equal(hasCep(validation), true);
    assert.equal(isTerminal(validation.attributes.status), true);
  });

  it('the not_found verdict carries no receipt', async () => {
    server.enqueue('validate-not-found');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-16',
      amount: 15000.5,
      trackingKey: 'MXBA20250316000001',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal(validation.attributes.status, 'not_found');
    assert.equal(hasCep(validation), false);
  });

  it('the returned verdict still delivers the receipt', async () => {
    server.enqueue('validate-returned');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal(validation.attributes.status, 'returned');
    assert.equal(hasCep(validation), true);
  });

  it('the request carries the fields under the API name', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
      senderBank: 'BANCO NACIONAL DE MEXICO',
    });

    const sent = server.request(0);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/v1/validate');
    assert.equal(server.header(0, 'authorization'), `Bearer ${TEST_API_KEY}`);
    assert.deepEqual(server.json(0), {
      send_date: '2025-03-15',
      amount: 15000.5,
      tracking_key: 'MXBA20250315001234',
      beneficiary_account: '012180004412345678',
      sender_bank: 'BANCO NACIONAL DE MEXICO',
    });
  });

  it('without a date, the body does not carry it', async () => {
    // The date is optional: without it the API tries candidate dates against Banxico.
    server.enqueue('validate-valid');

    await client.validateTransfer({
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    const body = server.json(0);
    assert.equal('send_date' in body, false);
    assert.equal(body['amount'], 15000.5);
  });

  it('the fields that are not passed do not travel', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    const body = server.json(0);
    assert.equal('numeric_reference' in body, false);
    assert.equal('retry_policy' in body, false);
    assert.equal('receiver_bank' in body, false);
  });

  it('the retry policy travels in the body', async () => {
    server.enqueue('validate-not-found');

    await client.validateTransfer({
      sendDate: '2025-03-16',
      amount: 15000.5,
      trackingKey: 'MXBA20250316000001',
      beneficiaryAccount: '012180004412345678',
      retryPolicy: {
        enabled: true,
        max_retries: 3,
        interval_seconds: 600,
        outcomes: ['not_found', 'cep_unavailable'],
      },
    });

    assert.deepEqual(server.json(0)['retry_policy'], {
      enabled: true,
      max_retries: 3,
      interval_seconds: 600,
      outcomes: ['not_found', 'cep_unavailable'],
    });
  });

  it('without a transfer identifier the API is not called', async () => {
    await assert.rejects(
      () =>
        client.validateTransfer({
          sendDate: '2025-03-15',
          amount: 100,
          beneficiaryAccount: '012180004412345678',
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'tracking_key_or_reference_required');
        return true;
      },
    );

    assert.equal(server.requests.length, 0);
  });

  it('without a beneficiary account the API is not called', async () => {
    await assert.rejects(
      () =>
        client.validateTransfer({
          sendDate: '2025-03-15',
          amount: 100,
          trackingKey: 'MXBA20250315001234',
          beneficiaryAccount: '',
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'account_required');
        return true;
      },
    );

    assert.equal(server.requests.length, 0);
  });

  it('clientRef travels as client_ref and returns in the validation', async () => {
    server.enqueue('validate-valid-client-ref');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
      clientRef: 'order-4812',
    });

    assert.equal(server.json(0)['client_ref'], 'order-4812');
    assert.equal(validation.attributes.client_ref, 'order-4812');
  });

  it('without clientRef it does not travel and the validation does not carry it', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal('client_ref' in server.json(0), false);
    assert.equal(validation.attributes.client_ref, undefined);
    assert.equal(validation.attributes.duplicate_of, undefined);
    assert.equal(validation.attributes.account_conflict, undefined);
  });

  it('an empty clientRef reaches the API so that it rejects it', async () => {
    server.enqueue('validate-valid');

    await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
      clientRef: '',
    });

    assert.equal(server.json(0)['client_ref'], '');
  });

  it('read a validation by its identifier', async () => {
    server.enqueue('validation-retrying');

    const validation = await client.getValidation('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    assert.equal(server.request(0).url, '/v1/validations/f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(validation.attributes.retry_state?.enabled, true);
    assert.equal(validation.attributes.retry_state.attempts_completed, 2);
    assert.equal(validation.attributes.retry_state.next_attempt_at, '2025-03-15T14:42:11Z');
  });

  it('candidateAccounts travels instead of the account and the validation says which one won', async () => {
    server.enqueue('validate-candidates');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      candidateAccounts: ['012180004412345678', '002010077777777771'],
    });

    const body = server.json(0);
    assert.deepEqual(body['candidate_accounts'], ['012180004412345678', '002010077777777771']);
    assert.equal('beneficiary_account' in body, false);
    assert.deepEqual(validation.attributes.candidate_match, { index: 1, account_last4: '7771' });
  });

  it('without candidates the validation carries no candidate_match', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal('candidate_accounts' in server.json(0), false);
    assert.equal(validation.attributes.candidate_match, undefined);
  });

  it('the account and the candidates together do not reach the API', async () => {
    const both = {
      sendDate: '2025-03-15',
      amount: 100,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
      candidateAccounts: ['012180004412345678', '002010077777777771'],
    };

    await assert.rejects(
      // @ts-expect-error the account and the candidates are mutually exclusive
      () => client.validateTransfer(both),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'account_and_candidates_mutually_exclusive');
        return true;
      },
    );
    const ocr = {
      image: Buffer.from('png'),
      beneficiaryAccount: both.beneficiaryAccount,
      candidateAccounts: both.candidateAccounts,
    };
    await assert.rejects(
      // @ts-expect-error the account and the candidates are mutually exclusive
      () => client.validations.validateOcr(ocr),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'account_and_candidates_mutually_exclusive');
        return true;
      },
    );

    assert.equal(server.requests.length, 0);
  });

  it('a string is not an array of candidates', async () => {
    await assert.rejects(
      () =>
        client.validateTransfer({
          sendDate: '2025-03-15',
          amount: 100,
          trackingKey: 'MXBA20250315001234',
          // @ts-expect-error a string is not an array of accounts
          candidateAccounts: '012180004412345678',
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidRequestError);
        assert.equal(error.code, 'candidate_accounts_invalid');
        return true;
      },
    );

    assert.equal(server.requests.length, 0);
  });

  it('a list that does not comply reaches the API so that it rejects it', async () => {
    server.enqueue('validate-candidates');

    await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 100,
      trackingKey: 'MXBA20250315001234',
      candidateAccounts: ['012180004412345678'],
    });

    assert.deepEqual(server.json(0)['candidate_accounts'], ['012180004412345678']);
  });
  it('a direct valid carries the cross-checked account', async () => {
    server.enqueue('validate-valid');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal(validation.attributes.account_cross_checked, true);
  });

  it('with a slow Banxico it returns the validation in processing', async () => {
    // Without `?async=1`, the API answers `202` when Banxico takes longer than 45 seconds.
    server.enqueue('validate-sync-deadline');

    const validation = await client.validateTransfer({
      sendDate: '2025-03-15',
      amount: 15000.5,
      trackingKey: 'MXBA20250315001234',
      beneficiaryAccount: '012180004412345678',
    });

    assert.equal(validation.id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    assert.equal(validation.attributes.status, 'processing');
    assert.equal(isTerminal(validation.attributes.status), false);
  });
});
