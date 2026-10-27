/**
 * Verificación de la firma con marca de tiempo de un webhook.
 *
 * La cabecera es `X-Webhook-Signature-Timestamped: t=<segundos>,v1=<hex>`, y `v1`
 * es el HMAC-SHA256 de `<t>.<cuerpo>` con el secreto del endpoint.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOLERANCE_SECONDS,
  TIMESTAMPED_SIGNATURE_HEADER,
  parseWebhook,
  timestampedSignatureFromHeaders,
  verifyWebhook,
  verifyWebhookTimestamped,
} from '../src/index.js';
import { recordedBody } from './harness.js';

const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const AHORA_SEGUNDOS = 1_700_000_000;
const T = String(AHORA_SEGUNDOS);
const AHORA = new Date(AHORA_SEGUNDOS * 1000);
const PAYLOAD = recordedBody('webhook-validation-completed');

function en(segundos: number): Date {
  return new Date((AHORA_SEGUNDOS + segundos) * 1000);
}

function v1(payload: Buffer, t: number, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(payload)
    .digest('hex');
}

function cabecera(payload: Buffer, t = AHORA_SEGUNDOS, secret = SECRET): string {
  return `t=${String(t)},v1=${v1(payload, t, secret)}`;
}

describe('verifyWebhookTimestamped', () => {
  it('el vector fijo de la firma', () => {
    // El HMAC-SHA256 de `1700000000.{"event":"test"}` con el secreto de las pruebas.
    const header =
      't=1700000000,v1=9b5ddb2ae0c5514e340f612c3424deb50a1e17b12767ae8550d6388096c92e10';

    assert.equal(
      verifyWebhookTimestamped(Buffer.from('{"event":"test"}'), header, SECRET, { now: AHORA }),
      true,
    );
  });

  it('acepta una firma correcta dentro de la ventana', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), SECRET, { now: AHORA }),
      true,
    );
  });

  it('admite texto y Uint8Array además de Buffer', () => {
    const texto = PAYLOAD.toString('utf8');

    assert.equal(verifyWebhookTimestamped(texto, cabecera(PAYLOAD), SECRET, { now: AHORA }), true);
    assert.equal(
      verifyWebhookTimestamped(new Uint8Array(PAYLOAD), cabecera(PAYLOAD), SECRET, { now: AHORA }),
      true,
    );
  });

  it('mide la ventana hacia el pasado y hacia el futuro', () => {
    const header = cabecera(PAYLOAD);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: en(299) }), true);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: en(-299) }), true);
  });

  it('acepta el borde de la ventana y rechaza un segundo más', () => {
    const header = cabecera(PAYLOAD);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: en(300) }), true);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: en(301) }), false);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: en(-301) }), false);
  });

  it('rechaza una entrega vieja que se repite', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), SECRET, { now: en(3600) }),
      false,
    );
  });

  it('ajusta la ventana con toleranceSeconds', () => {
    const header = cabecera(PAYLOAD);

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { toleranceSeconds: 60, now: en(61) }),
      false,
    );
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { toleranceSeconds: 60, now: en(60) }),
      true,
    );
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { toleranceSeconds: 3600, now: en(3600) }),
      true,
    );
  });

  it('la ventana por omisión son cinco minutos', () => {
    assert.equal(DEFAULT_TOLERANCE_SECONDS, 300);
  });

  it('sin now usa el reloj del sistema', () => {
    const ahora = Math.floor(Date.now() / 1000);

    assert.equal(verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD, ahora), SECRET), true);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD, ahora - 3600), SECRET), false);
  });

  it('una hora actual inválida no acepta nada', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), SECRET, { now: new Date(Number.NaN) }),
      false,
    );
  });

  it('rechaza un cuerpo alterado', () => {
    const alterado = Buffer.from(PAYLOAD.toString('utf8').replace('"valid"', '"not_found"'));

    assert.notEqual(alterado.toString('utf8'), PAYLOAD.toString('utf8'));
    assert.equal(
      verifyWebhookTimestamped(alterado, cabecera(PAYLOAD), SECRET, { now: AHORA }),
      false,
    );
  });

  it('reserializar el JSON rompe la firma', () => {
    const reserializado = Buffer.from(
      JSON.stringify(JSON.parse(PAYLOAD.toString('utf8')), null, 2),
    );

    assert.equal(
      verifyWebhookTimestamped(reserializado, cabecera(PAYLOAD), SECRET, { now: AHORA }),
      false,
    );
  });

  it('rechaza otro secreto', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), 'otro_secreto', { now: AHORA }),
      false,
    );
  });

  it('cambiar t sin volver a firmar invalida la firma', () => {
    // Quien repite una entrega vieja no puede ponerle una `t` nueva: `t` está firmada.
    const renovada = `t=${String(AHORA_SEGUNDOS + 3000)},v1=${v1(PAYLOAD, AHORA_SEGUNDOS)}`;

    assert.equal(verifyWebhookTimestamped(PAYLOAD, renovada, SECRET, { now: en(3000) }), false);
  });

  it('la firma del cuerpo solo no sirve como firma con marca de tiempo', () => {
    const sola = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, `t=${T},v1=${sola}`, SECRET, { now: AHORA }),
      false,
    );
  });

  it('con varias v1 basta con que una cuadre', () => {
    const buena = v1(PAYLOAD, AHORA_SEGUNDOS);
    const mala = '0'.repeat(64);
    const verificar = (header: string): boolean =>
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: AHORA });

    assert.equal(verificar(`t=${T},v1=${mala},v1=${buena}`), true);
    assert.equal(verificar(`t=${T},v1=${buena},v1=${mala}`), true);
    assert.equal(verificar(`t=${T},v1=${mala},v1=${'1'.repeat(64)}`), false);
  });

  it('ignora las claves que no conoce y los espacios', () => {
    const firma = v1(PAYLOAD, AHORA_SEGUNDOS);
    const verificar = (header: string): boolean =>
      verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: AHORA });

    assert.equal(verificar(` v0=abc , t=${T} , v1=${firma} , v2=otra`), true);
    assert.equal(verificar(`v1=${firma},t=${T}`), true);
  });

  it('acepta la firma en mayúsculas', () => {
    const header = `t=${T},v1=${v1(PAYLOAD, AHORA_SEGUNDOS).toUpperCase()}`;

    assert.equal(verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: AHORA }), true);
  });

  it('rechaza sin lanzar una cabecera mal formada', () => {
    const malas: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      '   ',
      'basura',
      't=,v1=',
      `t=${T}`,
      `v1=${'a'.repeat(64)}`,
      `t=ayer,v1=${'a'.repeat(64)}`,
      `t=-${T},v1=${'a'.repeat(64)}`,
      `t=${T}.5,v1=${'a'.repeat(64)}`,
      `t=1e9,v1=${'a'.repeat(64)}`,
      `t=١٧٠٠٠٠٠٠٠٠,v1=${'a'.repeat(64)}`,
      `t=${'9'.repeat(40)},v1=${'a'.repeat(64)}`,
      `t=${T},t=${T},v1=${'a'.repeat(64)}`,
      `t=${T},v1=`,
      `t=${T},v1=áéíóú`,
      `sha256=${'a'.repeat(64)}`,
    ];

    for (const header of malas) {
      assert.equal(
        verifyWebhookTimestamped(PAYLOAD, header, SECRET, { now: AHORA }),
        false,
        String(header),
      );
    }
  });

  it('sin secreto no se acepta', () => {
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD, AHORA_SEGUNDOS, ''), '', { now: AHORA }),
      false,
    );
  });

  it('las dos firmas conviven y la de siempre no cambia', () => {
    const antigua = `sha256=${createHmac('sha256', SECRET).update(PAYLOAD).digest('hex')}`;

    assert.equal(verifyWebhook(PAYLOAD, antigua, SECRET), true);
    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), SECRET, { now: AHORA }),
      true,
    );
    // La firma de siempre no cubre la hora, y la nueva no se confunde con ella.
    assert.equal(verifyWebhook(PAYLOAD, cabecera(PAYLOAD), SECRET), false);
    assert.equal(verifyWebhookTimestamped(PAYLOAD, antigua, SECRET, { now: AHORA }), false);
  });

  it('se verifica antes de interpretar el evento', () => {
    const antigua = `sha256=${createHmac('sha256', SECRET).update(PAYLOAD).digest('hex')}`;

    assert.equal(
      verifyWebhookTimestamped(PAYLOAD, cabecera(PAYLOAD), SECRET, { now: AHORA }),
      true,
    );
    const evento = parseWebhook(PAYLOAD, antigua, SECRET);

    assert.equal(evento.event, 'validation.completed');
  });
});

describe('timestampedSignatureFromHeaders', () => {
  it('encuentra la cabecera en cualquiera de sus grafías', () => {
    const valor = 't=1,v1=abc';

    assert.equal(timestampedSignatureFromHeaders({ [TIMESTAMPED_SIGNATURE_HEADER]: valor }), valor);
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature-timestamped': valor }),
      valor,
    );
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature-timestamped': [valor] }),
      valor,
    );
    // La firma de siempre no se confunde con la nueva.
    assert.equal(
      timestampedSignatureFromHeaders({ 'x-webhook-signature': 'sha256=abc' }),
      undefined,
    );
  });

  it('el nombre de la cabecera', () => {
    assert.equal(TIMESTAMPED_SIGNATURE_HEADER, 'X-Webhook-Signature-Timestamped');
  });
});
