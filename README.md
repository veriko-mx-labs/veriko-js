# @veriko-mx/sdk · SDK de JavaScript y TypeScript para la API de Veriko

Cliente oficial de [Veriko](https://veriko.mx) para Node.
Valida transferencias SPEI contra el CEP de Banxico, descarga el comprobante oficial y verifica la
firma de los webhooks.

Sin dependencias en tiempo de ejecución. Tipos generados del spec de OpenAPI. Node 18 o superior, en
ESM y en CommonJS.

```ts
import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko(); // lee VERIKO_API_KEY del entorno

const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
});

console.log(validation.attributes.status); // 'valid'
```

## Qué es el CEP

El **Comprobante Electrónico de Pago (CEP)** es el documento que expide el **Banco de México
(Banxico)** por cada transferencia que pasa por el SPEI, el sistema de pagos interbancarios
mexicano. Contiene el sello digital y la cadena original de la institución receptora, de modo que
acredita que una transferencia ocurrió y por qué importe.

El CEP no tiene efectos fiscales: no sustituye a una factura.

Su consulta manual se hace en el portal de Banxico, un comprobante a la vez.

## Qué hace la API

La API consulta el CEP y devuelve un veredicto en el campo `status`:

| veredicto         | significado                                                                            |
| ----------------- | -------------------------------------------------------------------------------------- |
| `queued`          | La API aceptó la validación y todavía no la inicia                                     |
| `processing`      | La consulta a Banxico está en curso                                                    |
| `valid`           | Banxico devolvió un CEP que coincide con los datos enviados                            |
| `not_found`       | Banxico no tiene un CEP con esos datos. Puede ser temporal: un CEP tarda en publicarse |
| `cep_unavailable` | Banxico no pudo responder. No dice nada sobre la transferencia                         |
| `invalid`         | Banxico respondió de una forma que la API no reconoce                                  |
| `returned`        | El pago se liquidó y la institución beneficiaria lo devolvió después                   |
| `failed`          | La API rechazó los datos o se detuvo por un problema en los datos enviados             |
| `error`           | Falló el procesamiento. El motivo viaja en `error_code`                                |

Con veredicto `valid`, el comprobante queda disponible en XML y en PDF. Un `valid` es el veredicto
del momento de la consulta: Banxico puede reportar la devolución hasta 72 horas después, y la
validación pasa a `returned`.

## Las familias de operaciones

El cliente agrupa las 75 operaciones M2M de la API en once familias:

| familia                | qué cubre                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.validations`   | Validar por campos o por imagen, consultar, listar, exportar, revisar el estado de pago, borrar, la política de reintentos y la descarga del comprobante |
| `client.webhooks`      | Registrar endpoints, rotar su secreto, enviar un evento de prueba y leer el historial de entregas                                                        |
| `client.catalog`       | Catálogo de bancos SPEI, calendario de días inhábiles SPEI, banco emisor de una tarjeta y estado del servicio de Banxico                                 |
| `client.beneficiaries` | Cuentas beneficiarias guardadas y la importación masiva, como ciclo completo                                                                             |
| `client.usage`         | Cuota de validaciones, límites de tasa y registro de actividad de la API                                                                                 |
| `client.account`       | Perfil y política de reintentos predeterminada de la cuenta                                                                                              |
| `client.dashboard`     | Resumen del panel                                                                                                                                        |
| `client.plans`         | Catálogo y comparación de planes públicos, sin clave de API                                                                                              |
| `client.insights`      | Resumen, tendencias, bancos y beneficiarios principales                                                                                                  |
| `client.finance`       | Resumen, estado de cuenta, vistas previas, descargas y exportaciones de CEP                                                                              |
| `client.billing`       | Suscripción activa                                                                                                                                       |

Las tres operaciones de uso más frecuente están también en la raíz del cliente, como atajo:
`validateTransfer()`, `getValidation()` y `getCep()`.

## Instalación

```bash
npm install @veriko-mx/sdk
```

El SDK corre en Node 18 o superior, en ESM y en CommonJS, y sólo usa `fetch`, `FormData`,
`ReadableStream` y `node:crypto`. El CI corre las pruebas en Node 18, 20, 22 y 24. Bun 1.4 ejecuta
los ejemplos, las descargas en flujo y la verificación de webhooks; no forma parte del CI. El SDK no
está probado en Deno, en navegadores ni en entornos de borde: la verificación de webhooks necesita
`node:crypto`.

Mientras la versión sea `0.x`, una versión menor puede ajustar la superficie pública del SDK.
La versión `1.0.0` se reservará para una integración estable en producción.

## Autenticación

La clave de API se obtiene en el panel ([app.veriko.mx](https://app.veriko.mx)) y empieza con
`veriko_`. El cliente la toma de la variable de entorno `VERIKO_API_KEY`:

```bash
export VERIKO_API_KEY=veriko_tu_clave_aqui
```

Sólo `client.plans.listPublic()` y `client.plans.getPublicPlanComparison()` se pueden usar sin
clave y no envían `Authorization`. El resto conserva la autenticación de la API: una petición sin
clave, o con una clave que no tiene la forma de las que emite el panel (`veriko_` y 64 caracteres
hexadecimales en minúscula), lanza `ConfigurationError` antes de salir a la red.

La opción `apiKey` la recibe directamente cuando la gestiona otro mecanismo:

```ts
const client = new Veriko({ apiKey: 'veriko_tu_clave_aqui' });
```

## Validar una transferencia

La operación exige el importe, la cuenta beneficiaria y **la clave de rastreo o la referencia
numérica**. Enviar las dos precisa la búsqueda. La fecha de envío es opcional: si falta o no es
utilizable, la API prueba fechas candidatas contra Banxico, y rechaza con `422` (`preflight_failed`
con `send_date_required`) sólo cuando no tiene datos para adivinarla. El banco emisor y el receptor
son opcionales y mejoran la identificación. La API rechaza con `422` (`preflight_failed` con el
error de campo `account_required`) una petición sin cuenta: no la busca entre los beneficiarios
guardados. Cuando no se sabe cuál fue la cuenta, `candidateAccounts` sustituye a
`beneficiaryAccount`.

Un rechazo `preflight_failed` significa que los datos se contradicen o que un campo está mal
formado. Ocurre antes de consultar a Banxico, no consume cuota y `error.errors` trae una entrada por
campo.

```ts
import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko();

const validation = await client.validateTransfer({
  sendDate: '2025-03-15', // YYYY-MM-DD, la fecha de envío
  amount: 15000.5, // en pesos, con centavos
  trackingKey: 'MXBA20250315001234',
  numericReference: '1234567',
  senderBank: 'BANCO NACIONAL DE MEXICO',
  receiverBank: 'BBVA MEXICO',
  beneficiaryAccount: '012180004412345678', // CLABE, tarjeta o celular DiMo
});

if (validation.attributes.status === 'valid') {
  console.log('Pago confirmado en', validation.attributes.processing_time_ms, 'ms');
}
```

Los argumentos van en `camelCase` y viajan con el nombre en inglés que la API espera (`send_date`,
`amount`, `tracking_key`). Lo que la API devuelve conserva el suyo (`banxico_status`,
`processing_time_ms`), porque es el tipo generado del spec.

`amount` acepta un número o una cadena decimal. El SDK rechaza `NaN`, un valor vacío y una cadena no
numérica con `InvalidRequestError` (`invalid_amount`) antes de enviar nada.

#### Nombres de versiones anteriores

Los nombres de campo de versiones anteriores siguen funcionando para las integraciones existentes y
emiten un `DeprecationWarning`. No forman parte de la API tipada y una versión futura los quitará.
Enviar un nombre anterior junto con su nombre actual lanza `InvalidRequestError`
(`alias_conflict`). En las respuestas, los nombres actuales (`request_data.send_date`,
`ocr_result.amount`, `normalized_data.tracking_key`, entre otros) son los que se serializan.

Cada llamada consume cuota del plan, que se cobra cuando la API acepta la petición.

El tiempo de espera por intento es de 60 segundos de forma predeterminada (`timeoutMs`), porque la
API puede tardar hasta 45 segundos en una validación síncrona antes de responder `202`.

### Desde el comprobante

```ts
const validation = await client.validations.validateOcr({
  image: 'receipt.png', // ruta, Buffer o Uint8Array
  beneficiaryAccount: '012180004412345678', // obligatoria para un celular DiMo
});
```

El SDK lee el archivo y lo codifica en base64. `imageUrl` recibe un comprobante ya publicado por
HTTPS, y si se envían `image` e `imageUrl` a la vez, la API considera sólo `image`. Formatos: JPEG,
PNG, WebP o un PDF de 1 a 3 páginas, de hasta 12 MB.

`candidateAccounts` sustituye a `beneficiaryAccount` cuando la imagen no muestra la cuenta.

`senderBank` y `receiverBank` corrigen el banco leído del comprobante. Llevan el código SPEI de 4 o
5 dígitos (`'40012'`), que reemplaza al leído antes de consultar a Banxico. Un valor en cualquier
otro formato, como un nombre, se ignora y se conserva el leído.

`client.validations.image(id)` descarga el comprobante de una validación por imagen.

### Sin esperar al veredicto

Para volumen, la API acepta la petición y responde con el identificador:

```ts
const queued = await client.validations.enqueue({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
});

const validation = await client.validations.waitFor(queued.id); // consulta hasta el veredicto
```

`enqueue()` y `enqueueOcr()` son métodos aparte y no una opción de `validate()`, para que el tipo de
retorno de cada uno sea fijo.

`waitFor()` envía el `ETag` de la respuesta anterior en cada ronda, así que una consulta que no
encuentra cambios no vuelve a descargar el mismo cuerpo. Espera a que el veredicto se asiente, no
sólo a que el estado sea terminal: una validación con reintentos en curso llega a `not_found` y
sigue cambiando después. Esa distinción es `isSettled()`, junto a `isTerminal()` y `hasCep()`. Sólo
los resultados que la política de reintentos repite (`not_found`, `cep_unavailable` y `error`)
mantienen abierto el ciclo.

La pausa entre consultas sigue al servidor. Es la mayor entre `pollIntervalMs` (2 segundos de forma
predeterminada) y la espera que la API pide en `Retry-After` o en `meta.next_poll_after_seconds`. La
espera termina en el `expires_at` de la validación, más un breve margen, cuando la API lo informó, y
a los cinco minutos en caso contrario. Se ajusta con `timeoutMs`. Cuando se agota, `waitFor()` lanza
`TimeoutError`, que trae `resourceId` y `timeoutMs`. `waitFor()` acepta el id de una validación o el
resultado de `enqueue()` y recibe las opciones de llamada de todos los métodos.

La alternativa a consultar es suscribirse al webhook `validation.completed`.

### Cuando la API responde `202`

Un `validate()` o `validateOcr()` síncrono puede pasar de los 45 segundos de consulta a Banxico. La
API responde entonces `202` con `async_reason: 'sync_deadline'` y sigue trabajando en segundo plano.
El resultado trae `queued` con lo que dice el acuse:

```ts
const result = await client.validateTransfer(params);

if (result.queued) {
  console.log(result.queued.asyncReason); // 'sync_deadline'
  console.log(result.queued.nextPollAfterSeconds);
  console.log(result.queued.expiresAt);
  const validation = await client.validations.waitFor(result.id);
}
```

`validateAndWait()` y `validateOcrAndWait()` hacen los dos pasos: llaman a la operación y, cuando
la API responde `202`, consultan con las indicaciones del acuse.

```ts
const validation = await client.validations.validateAndWait(params, { timeoutMs: 120_000 });
```

### Referencia propia

`clientRef` es una referencia tuya, de 1 a 64 caracteres, sin saltos de línea ni emoji. Relaciona la
validación con un pedido tuyo. No debe contener datos personales.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
  clientRef: 'order-4812',
});
console.log(validation.attributes.client_ref); // order-4812

const page = await client.validations.list({ clientRef: 'order-4812' });
```

`validateOcr()`, `enqueue()` y `enqueueOcr()` también la aceptan. Vuelve en `attributes.client_ref`,
en los listados y en los webhooks de validación, y `list()`, `stats()` y `export()` la usan como
filtro de coincidencia exacta. En un webhook, `parseWebhook()` la entrega en
`event.data.attributes.client_ref`. La API rechaza con `422` (`invalid_client_ref`) una referencia
que incumple las reglas.

### Duplicado y conflicto de cuenta

`attributes.duplicate_of` trae el `id` y el `created_at` de una validación `valid` anterior de la
misma cuenta y con la misma clave de rastreo. En una validación por imagen,
`attributes.account_conflict` trae los últimos 4 dígitos de la cuenta enviada (`sent_last4`) y de la
que muestra la imagen (`read_last4`). Ninguno cambia el veredicto, y los dos están ausentes cuando
la API no los informa.

### Varias cuentas candidatas

`candidateAccounts` lleva desde 2 cuentas hasta el máximo de la plataforma (3 de forma
predeterminada, nunca más de 10) en una sola validación, con una sola unidad de cuota.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  candidateAccounts: ['012180004412345678', '002010077777777771'],
});

console.log(validation.attributes.candidate_match?.index); // posición en la lista enviada, desde 0
console.log(validation.attributes.candidate_match?.account_last4); // 7771
```

`validateOcr()`, `enqueue()` y `enqueueOcr()` también la aceptan. La API consulta las cuentas en el
orden enviado y adopta la primera que coincide con la transferencia. `attributes.candidate_match`
trae su posición y sus últimos 4 dígitos, y la cuenta completa está en
`attributes.normalized_data.beneficiary_account`. El veredicto no cambia.

Envía una forma o la otra. El tipo del argumento impide las dos, y con `beneficiaryAccount` y
`candidateAccounts` juntos, o con ninguno, el SDK lanza `InvalidRequestError`
(`account_and_candidates_mutually_exclusive` o `account_required`) y no llama a la API. La API
rechaza con `422` (`candidate_accounts_invalid`) una lista que incumple las reglas.

### Conservar el comprobante

La plataforma conserva el archivo de una validación por imagen, y `client.validations.image(id)` lo
descarga. Con `retainImage: false`, borra el archivo en cuanto la validación llega a un estado
terminal que ya no lo necesita. El veredicto y los datos extraídos se conservan.

```ts
const validation = await client.validations.validateOcr({
  image: 'receipt.png',
  retainImage: false,
});
console.log(validation.attributes.image_retained); // false
```

`enqueueOcr()` también acepta `retainImage`. `image()` responde `410` con `image_not_retained` cuando
el archivo no se conserva, y la API rechaza con `422` (`invalid_retain_image`) un valor que no es
booleano.

### Listar y recorrer el historial

```ts
const page = await client.validations.list({ status: 'valid', perPage: 50 });
console.log(page.total, 'validaciones,', page.totalPages, 'páginas');

for await (const item of client.validations.iter({ from: '2025-03-01', to: '2025-03-31' })) {
  console.log(item.id, item.attributes.status);
}
```

`iter()` es un `AsyncIterable` y pide la página siguiente sólo cuando se agota la anterior.
`maxPages` acota el recorrido. Cada `Page` trae `items`, `page`, `perPage`, `total`, `totalPages`,
`hasNext` y `meta`. La API limita `perPage` al máximo de la operación (50 en validaciones, 100 en
entregas y vistas previas de importación) y no lo rechaza. `Page.perPage` informa el valor que la
API aplicó.

Los filtros (`status`, `type`, `from`, `to`, `search`, `playground`, `withDeleted`, `batchId`,
`bank`, `banks`, `amountMin`, `amountMax`, `clientRef` y `retryState`) van en `camelCase`. `status`
acepta un estado o una lista, tipados con `ValidationStatus`. `withDeleted: true` devuelve sólo las
validaciones quitadas del historial, y `false` sólo las activas. `banks` filtra por varios bancos a
la vez: hasta 50 códigos SPEI, como lista o separados por comas, y devuelve las validaciones cuyo
banco emisor o receptor sea cualquiera de ellos.

Un listado trae menos campos que `get()`: deja fuera los datos enviados, el resultado de Banxico y
los enlaces del comprobante.

`client.validations.export({ format: 'csv' })` exporta el historial. También acepta `xlsx` y los
mismos filtros. `client.validations.stats()` devuelve los totales con esos filtros.

## Descargar el CEP

```ts
import { writeFile } from 'node:fs/promises';
import { hasCep } from '@veriko-mx/sdk';

if (hasCep(validation)) {
  const cep = await client.getCep(validation.id, { format: 'pdf' }); // o 'xml'
  await writeFile(cep.filename, cep.content); // CEP-<id>.pdf
}
```

`getCep()` devuelve el archivo: el XML que Banxico emitió, con su sello digital y su cadena
original, o el PDF equivalente. Cuando la validación no tiene comprobante, la API responde `404` con
`cep_not_available` y el SDK lanza `NotFoundError`.

Las descargas y las exportaciones devuelven el archivo y no un enlace: `content`, `contentType`,
`headers` y el `filename` que la API propone en `Content-Disposition`. El SDK lee el nombre primero
de `filename*` (RFC 6266) y, si no está, de `filename`, incluidos los nombres entre comillas que
contienen `;`.

### Descargar en flujo un archivo grande

Cada descarga tiene una variante `*Stream()` que se resuelve en un `ReadableStream` web y no guarda
el cuerpo en memoria: `validations.cepStream()`, `validations.imageStream()`,
`validations.exportStream()`, `webhooks.exportDeliveriesStream()`, `beneficiaries.exportStream()`,
`beneficiaries.importTemplateStream()`, `usage.exportStream()`, `finance.statementStream()`,
`finance.reportStream()`, `finance.cepsStream()` y `finance.downloadCepExportStream()`. Reciben los
mismos argumentos que los métodos que guardan el cuerpo completo.

```ts
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const file = await client.finance.downloadCepExportStream(created.id);
console.log(file.filename, file.contentLength, file.headers['x-finance-items']);
await pipeline(Readable.fromWeb(file.stream), createWriteStream(file.filename));
```

El resultado trae `stream`, `contentType`, `filename`, `contentLength` (`undefined` cuando la
respuesta no trae `Content-Length`) y `headers`. Lee el flujo hasta el final o llama a
`stream.cancel()`, para que se libere la conexión. `timeoutMs` cubre la espera de las cabeceras y no
la transferencia; el `signal` de las opciones de llamada cancela la transferencia, y el flujo falla
entonces con `RequestAbortedError`. Un flujo no se reintenta una vez que empieza. Una respuesta de
error se lee completa, así que sigue lanzando el error tipado.
`finance.reportStream('monthly' | 'counterparties' | 'by-bank' | 'accounting', params)` entrega los
archivos de los reportes en flujo; el formato `preview` es JSON, así que para ese usa el método que
devuelve el cuerpo completo.

## Revisar el pago después

`client.validations.recheck(id)` consulta de nuevo a Banxico el estado de pago de una validación
`valid` creada hace 72 horas como máximo, sin consumir cuota.

```ts
const result = await client.validations.recheck(validation.id);

console.log(result.changed); // true si pasó de valid a returned
console.log(result.previousStatus); // 'valid'
console.log(result.validation.attributes.status); // 'returned'
```

Si Banxico reporta `devuelto` o `en_proceso_devolucion`, la validación pasa a `returned`, conserva
su CEP y la API emite el webhook `validation.returned`. El estado de pago está en
`attributes.banxico_result._payment_status`. Una validación que ya estaba en `returned` responde su
estado actual sin consultar a Banxico, y `checkedAt` es `null`.

Cada validación acepta una revisión cada 10 minutos. Antes de eso, el SDK lanza `RateLimitError`
con `recheck_rate_limited`, y `retryAfter` trae los segundos que faltan. Una validación en otro
estado, o de más de 72 horas, lanza `InvalidRequestError` con `recheck_not_eligible` o
`recheck_window_expired`. Si Banxico no entrega un estado legible, lanza `ServerError` con
`recheck_unavailable`: la validación conserva su intervalo y se puede reintentar de inmediato.

## Borrar una validación

`client.validations.delete(id)` quita una validación del historial, pero el registro, el CEP, los
datos extraídos y el archivo del comprobante siguen existiendo. La purga permanente los borra en dos
pasos: el primero describe lo que borraría y emite un token de un solo uso, y el segundo lo
confirma.

```ts
const preparation = await client.validations.preparePurge(validation.id);

console.log(preparation.attributes.will_delete); // lo que se borraría
console.log(preparation.attributes.expires_in); // segundos de vigencia del token

const result = await client.validations.executePurge(validation.id, {
  confirmationToken: preparation.attributes.confirmation_token,
});
console.log(result.attributes.purged_at, result.attributes.file_removal);
```

**La purga es irreversible y no devuelve cuota.** La validación queda como una lápida: conserva el
veredicto, las fechas y el importe, y trae `attributes.purged_at`. Después, el CEP, el comprobante,
los reintentos y `recheck()` responden `410` con `validation_purged`, que el SDK lanza como
`GoneError`. `file_removal` es `pending` cuando un archivo no se pudo borrar en ese momento y la
barrida diaria lo termina.

Una validación en curso lanza `ConflictError` con `purge_validation_in_progress`. Un token vencido,
mal formado o de otra validación lanza `InvalidRequestError`, y un token ya usado lanza
`ConflictError` con `confirmation_token_already_used`. Si no llega la respuesta de `executePurge()`,
`client.getValidation(id)` dice si la purga se completó.

## Registrar un webhook

```ts
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/payments',
  events: ['validation.completed'],
});

console.log(endpoint.attributes.secret); // 64 hex
```

El secreto de firma viaja **una sola vez**, en esta respuesta. Si se pierde,
`client.webhooks.regenerateSecret(endpoint.id)` devuelve uno nuevo. El secreto anterior sigue
firmando durante 24 horas: cada entrega trae entonces `X-Webhook-Signature-Old`, y
`attributes.previous_secret_expires_at` dice hasta cuándo. Pasa `{ immediate: true }` para revocar el
secreto anterior de inmediato, por ejemplo cuando quedó expuesto.

```ts
const rotated = await client.webhooks.regenerateSecret(endpoint.id, { immediate: true });
console.log(rotated.attributes.secret);
```

`client.webhooks.test(endpoint.id)` envía un evento de prueba y dice si el receptor lo aceptó. Las
entregas de prueba no cuentan para el contador de fallos consecutivos que apaga un endpoint después
de tres seguidos. Cuando eso pasa, el estado es `auto_disabled`, y
`client.webhooks.update(id, { status: 'active' })` lo reactiva.

El historial de intentos está en `client.webhooks.deliveries()`, con o sin identificador de endpoint,
e `iterDeliveries()` lo recorre. `exportDeliveries()` lo descarga en CSV o XLSX. Los filtros existen
sólo en el listado global: con un endpoint y un filtro, o con una lista de hasta 20 endpoints, el SDK
consulta ese listado con `endpoint_id`. Una lista de más de 20 endpoints lanza `ConfigurationError`.

```ts
const failed = await client.webhooks.deliveries({
  status: ['failed', 'retrying'],
  responseStatus: ['5xx', 'none'],
  from: '2026-10-01',
  minAttempt: 2,
});
```

`status`, `eventType` y `responseStatus` aceptan un valor o una lista. `responseStatus` acepta un
código exacto (`404`), una familia (`'5xx'`) o `'none'` para las entregas sin respuesta. `from` y
`to` acotan la fecha de creación, `validationId` conserva las entregas de una validación,
`minResponseTimeMs` las respuestas lentas, y `q` busca en el identificador, el endpoint, el evento,
la validación y el código HTTP. `exportDeliveries()` acepta los mismos filtros y `limit`.

## Catálogo y estado de Banxico

```ts
const banks = await client.catalog.banks(); // instituciones SPEI con su código
const calendar = await client.catalog.speiCalendar(2026); // días inhábiles SPEI del año
const card = await client.catalog.binLookup('455632'); // banco emisor de una tarjeta
const status = await client.catalog.banxicoStatus();

console.log(status.attributes.status); // 'operational'
```

`banxicoStatus()` distingue un `cep_unavailable` causado por la transferencia de una caída del
servicio, y `banxicoTimeseries()` devuelve la serie de latencia o de veredictos por ventana.

`speiCalendar()` devuelve `SpeiCalendar`: `attributes.non_business_days` trae los días inhábiles de
lunes a viernes (`YYYY-MM-DD`), `attributes.source` la disposición de la CNBV publicada en el DOF, y
`coveredYears` los años con calendario. Los sábados y domingos son siempre inhábiles y no se repiten
en la lista. La consulta no consume cuota. Un año sin calendario lanza `NotFoundError` con
`spei_calendar_year_not_covered`.

## Beneficiarios

`client.beneficiaries` guarda las cuentas a las que pagas: CLABE, tarjeta o celular DiMo. El tipo se
detecta por la longitud del número, y un celular exige `bankCode`.

```ts
const beneficiary = await client.beneficiaries.create({
  accountNumber: '012180004412345678',
  label: 'Proveedor ABC',
});

const found = await client.beneficiaries.lookup('012180004412345678'); // la cuenta ya guardada
console.log(found.attributes.bank_name);

const check = await client.beneficiaries.validateAccount({
  account: '01218000441234567',
  type: 'clabe',
});
console.log(check.attributes.checksum_valid, check.attributes.bank?.name); // completa la CLABE de 17 dígitos
```

`validateAccount()` comprueba un número de cuenta sin guardarlo: tipo, longitud, dígito verificador y
banco. `type` es opcional (`'clabe'` o `'bin'`).

Registrar una cuenta archivada la reactiva: la API responde `200` en lugar de `201` y
`beneficiary.reactivated` es `true`. Sin `label`, la cuenta conserva su alias. Registrar una cuenta
que ya está activa lanza `InvalidRequestError` con `beneficiary_already_registered`.

`client.beneficiaries.list()` recorre la lista completa y no pagina. `delete()` archiva una cuenta
sin borrarla, y `list({ withArchived: true })` devuelve sólo las archivadas. `export()` la descarga
en CSV o XLSX.

### Importación masiva

La importación es un ciclo: descargar la plantilla, subir el archivo, revisar las filas y confirmar.

```ts
const template = await client.beneficiaries.importTemplate({ format: 'csv' }); // 1. descargar
const started = await client.beneficiaries.importStart('beneficiaries.csv'); // 2. subir
await client.beneficiaries.importWait(started.id); // 3. esperar la vista previa

for await (const row of client.beneficiaries.iterImportPreview(started.id, {
  buckets: ['correctable'],
})) {
  // 4. revisar
  if (row.id !== undefined) {
    await client.beneficiaries.importEditRow(started.id, row.id, { parsedBankCode: '40012' });
  }
}

await client.beneficiaries.importCommit(started.id); // 5. confirmar
```

`importStart()` recibe los bytes del archivo o su ruta y lo sube como `multipart/form-data`. Los
formatos son CSV, XLS, XLSX, TXT, JSON y PDF, de hasta 20 MB, y el SDK envía el tipo de contenido que
corresponde a la extensión. Sólo puede haber una importación abierta a la vez: otra responde `422`
con `import_already_in_flight`. Nada se guarda hasta `importCommit()`. `importWait()` espera
`preview_ready` o un estado final, que es lo que distingue `isImportSettled()`. El endpoint de estado
no expone `ETag`, así que cada ronda descarga el cuerpo. `importCancel()` cancela una importación que
aún no se confirma.

La consulta de la vista previa filtra filas con `buckets` (`valid`, `correctable`, `fatal`,
`duplicate_account`, `duplicate_alias`). El SDK lo envía como `buckets[]`, que es la forma que lee la
API.

## Consumo

```ts
const summary = await client.usage.summary();
console.log(summary.attributes?.used, 'de', summary.attributes?.limit);

const history = await client.usage.history({ months: 6 });
const limits = await client.usage.limits();
```

`summary()` trae la cuota del plan vigente y `limits()` los límites de tasa, que son aparte de esa
cuota. `breakdown()`, `heatmap()` y `apiUsage()` desglosan el consumo, y
`client.usage.export({ format: 'csv' })` descarga el registro de actividad.

## Exportaciones de CEP

`client.finance.createCepExport()` inicia una exportación de CEP como archivo comprimido. Acepta un
`Idempotency-Key`, y `waitForCepExport()` consulta hasta que la exportación llega a un estado
terminal:

```ts
const created = await client.finance.createCepExport({ from: '2026-10-01', to: '2026-10-31' });
const ready = await client.finance.waitForCepExport(created.id);
console.log(ready.attributes?.status); // 'ready'
```

Los estados terminales son `ready`, `failed` y `expired`, listados en `CEP_EXPORT_TERMINAL_STATUSES`
y comprobados por `isCepExportTerminal()`. `waitForCepExport()` respeta `Retry-After` y recibe las
mismas opciones que `waitFor()`.

## Lecturas condicionales

`client.validations.get()`, `client.catalog.banks()` y `client.catalog.speiCalendar()` aceptan
`ifNoneMatch`. La respuesta trae el `ETag` en `etag`, y cuando nada cambió la API responde `304`, que
el SDK lanza como `NotModifiedError` con el `etag` de la representación vigente.

```ts
import { NotModifiedError } from '@veriko-mx/sdk';

const validation = await client.validations.get(id);

try {
  await client.validations.get(id, { ifNoneMatch: validation.etag });
} catch (error) {
  if (!(error instanceof NotModifiedError)) throw error;
}
```

## Verificar la firma de un webhook

Cada entrega llega firmada con el HMAC-SHA256 del cuerpo, con el secreto que `POST /v1/webhooks`
devolvió al registrar el endpoint:

```
X-Webhook-Signature: sha256=<hex>
```

Lo que se firma es el cuerpo **exactamente como llegó**. Interpretar el JSON y volver a serializarlo
cambia los bytes y la firma deja de coincidir. En Express, eso significa `express.raw()` en la ruta
del webhook, no `express.json()`.

```ts
import express from 'express';
import { SignatureVerificationError, isKnownWebhookEvent, parseWebhook } from '@veriko-mx/sdk';

const app = express();
const SECRET = process.env.VERIKO_WEBHOOK_SECRET;

app.post('/hooks/veriko', express.raw({ type: 'application/json' }), (request, response) => {
  let event;
  try {
    event = parseWebhook(request.body, request.headers, SECRET);
  } catch (error) {
    if (error instanceof SignatureVerificationError) return response.sendStatus(400);
    throw error;
  }

  response.sendStatus(200); // responde 2xx primero, procesa después

  if (isKnownWebhookEvent(event) && event.event === 'validation.completed') {
    console.log(event.data.id, event.data.attributes.status);
  }
});
```

`parseWebhook(payload, signatureOrHeaders, secret, options)` recibe el valor de
`X-Webhook-Signature` o las cabeceras de la petición. Con las cabeceras, verifica la firma con marca
de tiempo dentro de una ventana, lo que además protege contra repeticiones. Con sólo el valor de la
firma, prueba el origen y nada sobre la vigencia.

El evento es una unión discriminada por `event`. En los siete eventos `validation.*`, `event.data` es
la validación, y `validation.returned` además tipa `attributes.payment_status`. En los cinco eventos
`billing.*` y en `test`, la API no publica la forma de `data`, así que está en `event.rawData`. Un
evento que esta versión no conoce, o un evento de validación cuyo cuerpo no es el documentado, llega
como `UnknownWebhookEvent`. `isKnownWebhookEvent(event)` lo reduce a `WebhookEvent`, y un
`switch (event.event)` cubre entonces todos los casos:

```ts
const event = parseWebhook(request.body, request.headers, SECRET);
if (!isKnownWebhookEvent(event)) return; // acusa recibo y revisa event.rawData después

switch (event.event) {
  case 'validation.returned':
    event.data.attributes.payment_status.code; // tipado
    break;
  case 'validation.completed':
    event.data.attributes.banxico_confirmed?.amount;
    break;
}
```

Con las cabeceras, el evento trae además `deliveryId` (`X-Veriko-Delivery-Id`) y `attemptTimestamp`
(la `t` de la firma con marca de tiempo). Un cuerpo sin `event` lo toma de `X-Veriko-Event`.

`verifyWebhook(payload, signature, secret)` hace la misma comprobación y devuelve `true` o `false`,
para decidir el código de respuesta por separado. La comparación corre en tiempo constante y funciona
con cualquier entrada, incluidos los caracteres no ASCII.

El receptor completo está en [`examples/webhook-receiver.mjs`](examples/webhook-receiver.mjs). Usa
`node:http`; la versión con Express sólo cambia en `express.raw()`.

### Rotar el secreto

`secret` acepta una cadena o una lista. Durante una rotación, pasa el secreto nuevo y el anterior:
una entrega se verifica si su firma coincide con cualquiera de los dos, en
`X-Webhook-Signature-Timestamped` o en `X-Webhook-Signature-Old`.

```ts
const event = parseWebhook(request.body, request.headers, [NEW_SECRET, PREVIOUS_SECRET]);
```

Quita el secreto anterior cuando pase `previous_secret_expires_at`.

### Una devolución posterior

`validation.returned` avisa cuando una validación que había salido `valid` pasa después a
`returned`. El endpoint sólo recibe los eventos a los que se suscribió, así que añádelo junto a
`validation.completed`:

```ts
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/payments',
  events: ['validation.completed', 'validation.returned'],
});
```

El cuerpo es el de `validation.completed` más `attributes.payment_status`, que `parseWebhook()`
entrega en `event.data.attributes.payment_status`:

```ts
if (isKnownWebhookEvent(event) && event.event === 'validation.returned') {
  console.log(event.data.attributes.payment_status.code); // devuelto o en_proceso_devolucion
}
```

`checked_at` es el instante de la consulta. En cualquier otro evento, `payment_status` está ausente.
El evento no se emite al crear la validación: una operación que llega ya devuelta se entrega con
`validation.completed` y `status=returned`.

### Lo que Banxico confirmó

Cuando `banxico_status` es `valid`, o `returned` con un CEP descargado, `event.data.attributes`
trae además `banxico_confirmed`: el importe, la fecha, la clave de rastreo, los dos bancos y la
cuenta beneficiaria (enmascarada a los últimos 4 dígitos), tal como Banxico los confirmó. Compáralo
con el pedido antes de liberar la mercancía: la imagen de un comprobante puede mostrar un importe
distinto del que Banxico confirmó.

### Las cabeceras de una entrega

| cabecera                          | contenido                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `X-Webhook-Signature`             | `sha256=` seguido del HMAC en hexadecimal                                       |
| `X-Webhook-Signature-Timestamped` | `t=<segundos>,v1=<hex>`: firma de `<t>.<cuerpo>` con la hora del intento        |
| `X-Webhook-Signature-Old`         | El mismo formato, firmado con el secreto anterior. Presente durante la rotación |
| `X-Veriko-Event`                  | Tipo de evento, por ejemplo `validation.completed`                              |
| `X-Veriko-Delivery-Id`            | Identificador de la entrega, estable entre reintentos                           |
| `X-Veriko-Timestamp`              | Momento del envío, ISO 8601 con sufijo `Z`                                      |

El `Delivery-Id` es el valor que permite descartar las entregas repetidas.

### Firma con marca de tiempo

`X-Webhook-Signature-Timestamped` firma la hora del intento junto con el cuerpo, para que el receptor
pueda descartar una entrega vieja que alguien reenvía. `X-Webhook-Signature` no cambia.

```ts
import { verifyWebhookTimestamped } from '@veriko-mx/sdk';

if (
  !verifyWebhookTimestamped(
    request.body, // el cuerpo crudo
    request.get('X-Webhook-Signature-Timestamped'),
    SECRET,
  )
) {
  return response.sendStatus(400);
}
```

`verifyWebhookTimestamped(payload, header, secret, { toleranceSeconds, now })` devuelve `true` o
`false`. Calcula el HMAC-SHA256 de `<t>.<cuerpo>`, lo compara en tiempo constante con cada `v1` de la
cabecera, y rechaza la entrega si `t` está más lejos del reloj del receptor que `toleranceSeconds`,
300 de forma predeterminada. `now` fija la hora actual con un `Date`, para pruebas.
`verifyDelivery(payload, headers, secret, options)` comprueba juntas la firma con marca de tiempo y la
`-Old`, y `verifyWebhookHeaders()` es la misma comprobación. Con `requireTimestamp: false`, una
entrega sin firma con marca de tiempo válida recurre a `X-Webhook-Signature`, que no protege contra
una repetición. `attemptTimestamp(header)` lee `t`. `timestampedSignatureFromHeaders(headers)`,
`oldSignatureFromHeaders(headers)` y `signatureFromHeaders(headers)` encuentran cada cabecera con
cualquier combinación de mayúsculas y minúsculas.

La ventana se aplica a `t`, la hora del intento, y no al campo `timestamp` del cuerpo, que es la hora
del evento. Un reintento llega hasta unas 8.6 horas después del evento, pero trae una `t` recién
generada. Medir la ventana contra el `timestamp` del cuerpo rechazaría reintentos legítimos. La
ventana no sustituye a la deduplicación: guarda el `Delivery-Id` al menos 24 horas.

## Reintentos

Dos mecanismos distintos comparten el nombre.

**Los del cliente** repiten una petición que falló por causas transitorias. El SDK reintenta `5xx`,
`408` y `429`, y respeta completo el `Retry-After` de la respuesta. Un `Retry-After` mayor que
`retry.maxRetryAfterMs` (60 segundos de forma predeterminada) no se espera: la llamada lanza el
error tipado, con `retryAfter` establecido. Los demás `4xx` no se reintentan, porque hay que corregir
la petición antes de repetirla. Un `429` con `quota_exceeded` tampoco se reintenta: la cuota del plan
no se repone en segundos.

Un `POST` se reintenta sólo cuando lleva un `Idempotency-Key`. Sin él, una repetición podría duplicar
la operación. `recheck()` y `executePurge()` nunca reintentan: la primera tiene su propio límite de
una revisión cada 10 minutos, y la purga es irreversible.

```ts
const client = new Veriko({ maxRetries: 3 }); // 0 los apaga; el valor predeterminado es 2
```

**Los de la API** siguen consultando a Banxico durante horas, porque un CEP tarda en publicarse, y
avisan por webhook cuando el veredicto cambia.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  retryPolicy: {
    enabled: true,
    max_retries: 3,
    interval_seconds: 600, // de 300 a 86,400
    outcomes: ['not_found', 'cep_unavailable'], // qué veredictos reintentar
  },
});
```

Lee el avance del ciclo en `(await client.getValidation(id)).attributes.retry_state`, o espera el
webhook `validation.retry.resolved`. Los intentos ya hechos están en
`client.validations.retryAttempts(id)`.

`client.validations.setRetryPolicy(id, policy)` cambia la política de una validación existente, y
`client.validations.cancelRetries(id)` detiene el ciclo. Las dos devuelven el estado del ciclo, no la
validación completa.

## Idempotencia

Reintentar un `POST` sin clave de idempotencia puede duplicar la validación, y su cobro, cuando la
respuesta se perdió pero la petición llegó. Con clave, la repetición devuelve la respuesta original
durante 24 horas.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  idempotencyKey: 'order-4f3a2b1c', // el identificador del intento de negocio
});
```

Deriva la clave del intento de negocio (el número de pedido, de lote o de transacción). No generes
una aleatoria en cada envío: una clave aleatoria por reintento anula la protección. Una clave tiene de
1 a 255 caracteres entre letras, dígitos, `_` y `-`. El SDK rechaza cualquier otra clave con
`InvalidRequestError` (`invalid_idempotency_key`) antes de enviar nada.

Sin `idempotencyKey`, el SDK genera una por llamada y la repite en sus propios reintentos. Esa clave
no sobrevive al proceso que la generó, así que un reenvío posterior sí se ejecuta dos veces. Esto
aplica a las seis operaciones que aceptan la cabecera: `validate()`, `validateOcr()` (y por tanto
`enqueue()` y `enqueueOcr()`), `setRetryPolicy()`, `cancelRetries()`,
`account.updateMyRetryPolicy()` y `finance.createCepExport()`.

Cuando la primera petición con una clave sigue en curso, la API responde `409` con
`idempotency_key_in_progress`. El SDK espera el `Retry-After` (o su propia espera creciente) y repite
la petición con la misma clave, hasta `retry.maxInProgressWaitMs` de espera acumulada, 120 segundos
de forma predeterminada. `ConflictError.inProgress` distingue ese caso de otros conflictos cuando la
espera se agota. Reutilizar una clave con un cuerpo distinto responde `422` con
`idempotency_key_reused`.

## Opciones por llamada

Todos los métodos reciben un último argumento con las opciones de esa llamada:

```ts
const controller = new AbortController();

const validation = await client.validations.get(id, {
  signal: controller.signal, // aborta la llamada, con reintentos y esperas incluidos
  timeoutMs: 10_000, // por intento
  maxRetries: 0,
  acceptLanguage: 'en', // idioma de error.detail
  headers: { 'X-Trace-Id': traceId }, // cabeceras extra; Authorization no se puede sustituir
});
```

`idempotencyKey` y `onResponse` también son opciones por llamada. Una llamada que quien la hizo
aborta lanza `RequestAbortedError` y nunca se reintenta. Un intento que excede `timeoutMs` lanza
`RequestTimeoutError`, una subclase de `ConnectionError`, cuando se agotan los reintentos.
`ConnectionError.attempts` dice cuántos intentos se hicieron. `retry` en el cliente ajusta los límites
de reintento (`maxRetryAfterMs`, `maxInProgressWaitMs`) para todas las llamadas.

## Metadatos de la respuesta

Todos los métodos devuelven una `ApiPromise`, una `Promise` que además ofrece `.withResponse()`.
`await` sigue devolviendo el recurso. `.withResponse()` devuelve también los metadatos de la
respuesta:

```ts
const { data, response } = await client.validateTransfer(params).withResponse();

console.log(response.requestId); // el valor que debes citar al contactar a soporte
console.log(response.rateLimit?.remaining);
console.log(response.quota?.remaining);
console.log(response.replayed); // true cuando la API repitió una respuesta guardada
console.log(response.attempts); // peticiones que tomó, con reintentos incluidos
```

`ResponseMeta` trae `status`, `headers`, `requestId`, `apiVersion`, `meta`, `rateLimit`, `quota`,
`replayed`, `etag`, `location`, `retryAfter`, `deprecation`, `sunset`, `link` y `attempts`. Una
descarga trae también `headers` en el `DownloadedFile`.

Para observar cada respuesta sin cambiar las llamadas, pasa `onResponse` al cliente o a una llamada.
Para enterarte de que un endpoint está obsoleto, pasa `onDeprecation`: recibe las cabeceras
`Deprecation`, `Sunset` y `Link` de la respuesta. Sin manejador, el SDK emite un aviso de proceso
(`VERIKO_API_DEPRECATION`) por endpoint.

```ts
const client = new Veriko({
  onResponse: (meta) => metrics.record(meta.requestId, meta.attempts),
  onDeprecation: (notice) => logger.warn(notice.path, notice.sunset),
});
```

## Errores

Toda excepción hereda de `VerikoError`. Las de la API traen `code`, que es el contrato estable, y
`detail`, que viene traducido y puede cambiar de redacción entre versiones. Ramifica por `code`,
nunca por `detail`.

```ts
import { InvalidRequestError, NotFoundError, RateLimitError } from '@veriko-mx/sdk';

try {
  const validation = await client.validateTransfer(params);
} catch (error) {
  if (error instanceof InvalidRequestError) {
    // 400, 413, 422: un 422 trae una entrada por campo inválido
    for (const entry of error.errors) {
      console.error(entry.code, entry.source?.pointer, entry.hint, entry.docs_url);
    }
  } else if (error instanceof RateLimitError) {
    console.error(error.kind, 'espera', error.retryAfter, 'segundos');
  } else if (error instanceof NotFoundError) {
    // 404
  }
}
```

| excepción                    | estado                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| `NotModifiedError`           | `304`, de una lectura condicional                                     |
| `AuthenticationError`        | `401`                                                                 |
| `ForbiddenError`             | `403`                                                                 |
| `NotFoundError`              | `404`                                                                 |
| `ConflictError`              | `409`                                                                 |
| `GoneError`                  | `410`, por ejemplo `validation_purged` e `image_not_retained`         |
| `InvalidRequestError`        | `400` y `422`                                                         |
| `PayloadTooLargeError`       | `413`, subclase de `InvalidRequestError`                              |
| `RateLimitError`             | `429`                                                                 |
| `QuotaExceededError`         | `429` con `quota_exceeded`, subclase de `RateLimitError`              |
| `ServerError`                | `5xx`                                                                 |
| `ApiError`                   | Cualquier otro estado de la API. Es la base de las clases anteriores  |
| `ConnectionError`            | Sin respuesta, con los reintentos agotados                            |
| `RequestTimeoutError`        | Un intento excedió `timeoutMs`, subclase de `ConnectionError`         |
| `RequestAbortedError`        | Quien hizo la llamada la abortó                                       |
| `TimeoutError`               | `waitFor()`, `waitForCepExport()` o `importWait()` agotaron su tiempo |
| `SignatureVerificationError` | La firma de un webhook no cuadra                                      |
| `ConfigurationError`         | Falta la clave de API o un argumento del cliente no se puede usar     |

Un `ApiError` trae:

- `status`, `code`, `detail`, `hint`, `docsUrl` y `pointer`, tomados de la primera entrada de
  `errors`.
- `errors`, la lista completa, y `codes`, el código de cada entrada. `hasCode(code)` revisa toda la
  lista.
- `requestId`, el valor que identifica la petición en los registros del sistema.
- `meta`, `headers`, `retryAfter` y `validationId`, la validación creada antes de que la petición
  fallara, cuando la hay.
- `local`, `true` cuando el SDK lanzó el error antes de enviar la petición. Los códigos de esos
  errores son los que respondería la API, y `ERROR_CODES` lista los que el SDK compara o lanza.

`RateLimitError` añade `kind` (`'rate_limit'` o `'quota'`), `limit`, `remaining` y `resetAt`, leídos
de las cabeceras `X-RateLimit-*`.

## Los tipos

Los tipos de lo que viaja por la red se generan del spec de OpenAPI y se versionan en
[`src/generated/openapi.ts`](src/generated/openapi.ts):

```bash
npm run gen:types    # openapi-typescript sobre spec/openapi.yaml
```

La copia de `spec/openapi.yaml` viene de
[docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml), y `npm run check:spec-public`
comprueba en cada corrida del CI que cumple el contrato de la API.

Los ejemplos de ese spec citan un host genérico. El SDK fija la raíz real de la API en
`DEFAULT_BASE_URL`.

Cada método devuelve el recurso `data` de la respuesta, tipado por el spec: `validation.attributes`,
`endpoint.attributes.secret`, `bank.attributes.name`.

Los cuerpos de `POST /v1/validate` y `POST /v1/validate-ocr` son la única excepción y se escriben a
mano: sus esquemas traen un `anyOf` que el generador convierte en `unknown`. `test/spec.test.ts`
falla si el spec agrega, quita o renombra alguno de sus campos.

Además de los tipos con nombre corto, el paquete reexporta `components`, `operations` y `paths`
completos, para cuando necesites una operación que el SDK todavía no envuelve.

## Superficie M2M

El SDK cubre exactamente las 75 operaciones del spec público: `security: []` para las públicas y
`ApiKeyAuth` para las autenticadas.

Entre ellas están el perfil y su política de reintentos, el resumen del panel, los dos endpoints
públicos de planes, las cuatro vistas de insights, las once operaciones de finanzas y la
suscripción. Por ejemplo:

```ts
const profile = await client.account.myProfile();
const trends = await client.insights.getTrends({ range: '30d', metric: 'latency' });
const statement = await client.finance.getStatement({ month: '2026-04', format: 'pdf' });
await writeFile(statement.filename, statement.content);
```

Los reportes mensual, por contraparte, por banco y contable conservan el valor predeterminado de la
API, `format: 'csv'`. Pasa `format: 'preview'` de forma explícita cuando necesites la respuesta JSON
para procesarla en memoria.

## Desarrollo

```bash
npm install
npm test               # compila a dist-test/ y corre node --test
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run build          # dist/esm y dist/cjs
npm run gen:types      # regenera src/generated desde spec/openapi.yaml
npm run test:examples  # compila y corre examples/ contra las grabaciones
```

`test/operations.test.ts` deriva el conjunto M2M de `spec/openapi.yaml` (las operaciones que aceptan
`ApiKeyAuth` o declaran `security: []`) y lo compara con los métodos, uno a uno. Ejercita cada ruta
contra un servidor HTTP local, y falla cuando una operación M2M no tiene método o un método queda
fuera del contrato. `VERIKO_TEST_SPEC=<ruta>` apunta las pruebas del spec a otro archivo de spec.

`npm run test:examples` corre cada archivo de [`examples/`](examples) como proceso hijo cuyo
`VERIKO_BASE_URL` es el servidor de grabaciones, comprueba las peticiones que envía y lo que imprime,
y entrega webhooks firmados al receptor. El CI lo corre en un trabajo aparte.

Ninguna prueba llama a la API. Las pruebas levantan un servidor HTTP local que sirve las respuestas
guardadas en [`test/recordings/`](test/recordings), recortadas de los ejemplos del spec público.

## Enlaces

- Documentación de la API: [docs.veriko.mx](https://docs.veriko.mx)
- Spec de OpenAPI: [docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml)
- SDK de Python: [veriko-mx-labs/veriko-python](https://github.com/veriko-mx-labs/veriko-python)
- Ejemplos en otros lenguajes: [veriko-mx-labs/examples](https://github.com/veriko-mx-labs/examples)
- El CEP, en detalle: [docs.veriko.mx/es/concepts/cep-concept](https://docs.veriko.mx/es/concepts/cep-concept)
- Referencia de errores: [docs.veriko.mx/es/concepts/errors](https://docs.veriko.mx/es/concepts/errors)
- Registro de cambios: [CHANGELOG.md](CHANGELOG.md)

## Licencia

MIT. Consulta [`LICENSE`](LICENSE).
