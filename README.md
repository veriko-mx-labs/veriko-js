# @veriko-mx/sdk · JavaScript and TypeScript SDK for the Veriko API

Official [Veriko](https://veriko.mx) client for Node.
It validates Mexican SPEI transfers against the Banco de México CEP, downloads the official
receipt and verifies webhook signatures.

No runtime dependencies. Types generated from the OpenAPI spec. Node 18 or later, in ESM and
CommonJS.

```ts
import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko(); // reads VERIKO_API_KEY from the environment

const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  beneficiaryAccount: '012180004412345678',
});

console.log(validation.attributes.status); // 'valid'
```

## What the CEP is

The **Comprobante Electrónico de Pago (CEP)** is the document that **Banco de México (Banxico)**
issues for every transfer that goes through SPEI, the Mexican interbank payment system. It carries
the digital seal and the original string of the receiving institution, so it proves that a transfer
happened and for what amount.

The CEP has no tax effect: it does not replace an invoice.

Banxico offers a portal to look one up by hand, one receipt at a time.

## What the API does

The API looks up the CEP and returns a verdict in the `status` field:

| verdict           | meaning                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `queued`          | The API accepted the validation and has not started it                              |
| `processing`      | The query to Banxico is running                                                     |
| `valid`           | Banxico returned a CEP that matches the data sent                                   |
| `not_found`       | Banxico has no CEP with that data. It can be temporary: a CEP takes time to publish |
| `cep_unavailable` | Banxico could not answer. It says nothing about the transfer                        |
| `invalid`         | Banxico answered in a way the API does not recognize                                |
| `returned`        | The payment settled and the beneficiary institution returned it afterwards          |
| `failed`          | The API rejected the data or stopped because of a problem in the data sent          |
| `error`           | Processing failed. The reason is in `error_code`                                    |

With a `valid` verdict, the receipt is available as XML and PDF. A `valid` is the verdict at the
time of the query: Banxico can report the return up to 72 hours later, and the validation changes
to `returned`.

## The operation families

The client groups the 75 M2M operations of the API into eleven families:

| family                 | what it covers                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `client.validations`   | Validate by fields or by image, get, list, export, recheck payment status, delete, the retry policy and the receipt download |
| `client.webhooks`      | Register endpoints, rotate their secret, send a test event and read the delivery history                                     |
| `client.catalog`       | SPEI bank catalog, SPEI non-business-day calendar, issuing bank of a card and Banxico service status                         |
| `client.beneficiaries` | Saved beneficiary accounts and the bulk import, as a full cycle                                                              |
| `client.usage`         | Validation quota, rate limits and the API activity log                                                                       |
| `client.account`       | Profile and default retry policy of the account                                                                              |
| `client.dashboard`     | Dashboard summary                                                                                                            |
| `client.plans`         | Catalog and comparison of public plans, with no API key                                                                      |
| `client.insights`      | Summary, trends, top banks and top beneficiaries                                                                             |
| `client.finance`       | Summary, statement, previews, downloads and CEP exports                                                                      |
| `client.billing`       | Active subscription                                                                                                          |

The three most used operations are also on the client root as shortcuts: `validateTransfer()`,
`getValidation()` and `getCep()`.

## Installation

```bash
npm install @veriko-mx/sdk
```

The SDK runs on Node 18 or later, in ESM and CommonJS, and uses only `fetch`, `FormData`,
`ReadableStream` and `node:crypto`. CI runs the tests on Node 18, 20, 22 and 24. Bun 1.4 runs the
examples, the streaming downloads and the webhook verification; it is not part of CI. The SDK is not
tested on Deno, in browsers or on edge runtimes: webhook verification needs `node:crypto`.

While the version is `0.x`, a minor version can adjust the public surface of the SDK. Version
`1.0.0` is reserved for a stable production integration.

## Authentication

Get the API key from the dashboard ([app.veriko.mx](https://app.veriko.mx)). It starts with
`veriko_`. The client reads it from the `VERIKO_API_KEY` environment variable:

```bash
export VERIKO_API_KEY=veriko_your_key_here
```

Only `client.plans.listPublic()` and `client.plans.getPublicPlanComparison()` work without a key,
and they send no `Authorization` header. Every other call keeps the API authentication: a request
with no key, or with a key that does not have the shape the dashboard issues (`veriko_` and 64
lowercase hexadecimal characters), throws `ConfigurationError` before it reaches the network.

The `apiKey` option takes it directly when another mechanism manages it:

```ts
const client = new Veriko({ apiKey: 'veriko_your_key_here' });
```

## Validate a transfer

The operation requires the amount, the beneficiary account and **the tracking key or the numeric
reference**. Sending both narrows the search. The send date is optional: when it is missing or
unusable, the API tries candidate dates against Banxico, and rejects with `422` (`preflight_failed`
with `send_date_required`) only when it has nothing to guess it from. The sender and receiver banks
are optional and improve identification. The API rejects a request with no account with `422`
(`preflight_failed` with the field error `account_required`) and does not look it up among the saved
beneficiaries. When the account is not known, `candidateAccounts` replaces `beneficiaryAccount`.

A `preflight_failed` rejection means the data contradicts itself or a field is malformed. It
happens before Banxico is queried, it consumes no quota, and `error.errors` lists one entry per
field.

```ts
import { Veriko } from '@veriko-mx/sdk';

const client = new Veriko();

const validation = await client.validateTransfer({
  sendDate: '2025-03-15', // YYYY-MM-DD, the send date
  amount: 15000.5, // in pesos, with cents
  trackingKey: 'MXBA20250315001234',
  numericReference: '1234567',
  senderBank: 'BANCO NACIONAL DE MEXICO',
  receiverBank: 'BBVA MEXICO',
  beneficiaryAccount: '012180004412345678', // CLABE, card or DiMo phone
});

if (validation.attributes.status === 'valid') {
  console.log('Payment confirmed in', validation.attributes.processing_time_ms, 'ms');
}
```

Arguments use `camelCase` and travel with the English name the API expects (`send_date`,
`amount`, `tracking_key`). What the API returns keeps its own names (`banxico_status`,
`processing_time_ms`), because the type is generated from the spec.

`amount` takes a number or a decimal string. The SDK rejects `NaN`, an empty value and a non-numeric
string with `InvalidRequestError` (`invalid_amount`) before it sends anything.

#### Names from earlier versions

Field names from earlier versions keep working for existing integrations and emit a
`DeprecationWarning`. They are not part of the typed API, and a future version removes them. Sending
an earlier name and its current name together throws `InvalidRequestError` (`alias_conflict`). In
responses, the current names (`request_data.send_date`, `ocr_result.amount`,
`normalized_data.tracking_key`, among others) are the ones that serialize.

Every call consumes plan quota, charged when the API accepts the request.

The per-attempt timeout is 60 seconds by default (`timeoutMs`), because the API can take up to 45
seconds on a synchronous validation before it answers `202`.

### From the receipt

```ts
const validation = await client.validations.validateOcr({
  image: 'receipt.png', // path, Buffer or Uint8Array
  beneficiaryAccount: '012180004412345678', // required for a DiMo phone
});
```

The SDK reads the file and encodes it in base64. `imageUrl` takes a receipt already published over
HTTPS, and when both `image` and `imageUrl` are sent, the API considers only `image`. Formats: JPEG,
PNG, WebP or a PDF of 1 to 3 pages, up to 12 MB.

`candidateAccounts` replaces `beneficiaryAccount` when the image does not show the account.

`senderBank` and `receiverBank` correct the bank read from the receipt. They carry the 4 or 5 digit
SPEI code (`'40012'`), which replaces the one read before Banxico is queried. A value in any other
format, such as a name, is ignored and the one read is kept.

`client.validations.image(id)` downloads the receipt of an OCR validation.

### Without waiting for the verdict

For volume, the API accepts the request and answers with the identifier:

```ts
const queued = await client.validations.enqueue({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
});

const validation = await client.validations.waitFor(queued.id); // polls until the verdict
```

`enqueue()` and `enqueueOcr()` are separate methods and not an option of `validate()`, so the return
type of each is fixed.

`waitFor()` sends the `ETag` of the previous response on every round, so a poll that finds no
change does not download the same body again. It waits for the verdict to settle, not only for the
status to be terminal: a validation with retries in progress reaches `not_found` and keeps changing
afterwards. That distinction is `isSettled()`, next to `isTerminal()` and `hasCep()`. Only the
outcomes the retry policy repeats (`not_found`, `cep_unavailable` and `error`) keep the cycle open.

The pause between polls follows the server. It is the longer of `pollIntervalMs` (2 seconds by
default) and the wait the API asks for in `Retry-After` or `meta.next_poll_after_seconds`. The wait
ends at the `expires_at` of the validation, plus a short grace period, when the API reported one,
and after five minutes otherwise. Set it with `timeoutMs`. When it runs out, `waitFor()` throws
`TimeoutError`, which carries `resourceId` and `timeoutMs`. `waitFor()` accepts a validation id or
the result of `enqueue()` and takes the call options of every method.

The alternative to polling is to subscribe to the `validation.completed` webhook.

### When the API answers `202`

A synchronous `validate()` or `validateOcr()` can run past 45 seconds of Banxico querying. The API
then answers `202` with `async_reason: 'sync_deadline'` and keeps working in the background. The
result carries `queued` with what the acknowledgment says:

```ts
const result = await client.validateTransfer(params);

if (result.queued) {
  console.log(result.queued.asyncReason); // 'sync_deadline'
  console.log(result.queued.nextPollAfterSeconds);
  console.log(result.queued.expiresAt);
  const validation = await client.validations.waitFor(result.id);
}
```

`validateAndWait()` and `validateOcrAndWait()` do both steps: they call the operation and, when
the API answers `202`, poll with the hints of the acknowledgment.

```ts
const validation = await client.validations.validateAndWait(params, { timeoutMs: 120_000 });
```

### Your own reference

`clientRef` is a reference of your own, from 1 to 64 characters, with no line breaks or emoji. It
relates the validation to an order of yours. It must not contain personal data.

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

`validateOcr()`, `enqueue()` and `enqueueOcr()` accept it too. It returns in
`attributes.client_ref`, in listings and in validation webhooks, and `list()`, `stats()` and
`export()` use it as an exact-match filter. In a webhook, `parseWebhook()` delivers it in
`event.data.attributes.client_ref`. The API rejects a reference that breaks the rules with `422`
(`invalid_client_ref`).

### Duplicate and account conflict

`attributes.duplicate_of` carries the `id` and `created_at` of an earlier `valid` validation of the
same account and with the same tracking key. In an OCR validation, `attributes.account_conflict`
carries the last 4 digits of the account sent (`sent_last4`) and of the one the image shows
(`read_last4`). Neither changes the verdict, and both are absent when the API does not report them.

### Several candidate accounts

`candidateAccounts` carries from 2 accounts up to the platform maximum (3 by default, never more
than 10) in a single validation, with a single quota unit.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  candidateAccounts: ['012180004412345678', '002010077777777771'],
});

console.log(validation.attributes.candidate_match?.index); // position in the list sent, from 0
console.log(validation.attributes.candidate_match?.account_last4); // 7771
```

`validateOcr()`, `enqueue()` and `enqueueOcr()` accept it too. The API queries the accounts in the
order sent and adopts the first one that matches the transfer. `attributes.candidate_match` carries
its position and its last 4 digits, and the full account is in
`attributes.normalized_data.beneficiary_account`. The verdict does not change.

Send one form or the other. The argument type prevents both, and with `beneficiaryAccount` and
`candidateAccounts` together, or with neither, the SDK throws `InvalidRequestError`
(`account_and_candidates_mutually_exclusive` or `account_required`) and does not call the API. The API
rejects a list that breaks the rules with `422` (`candidate_accounts_invalid`).

### Keep the receipt

The platform keeps the file of an image validation, and `client.validations.image(id)` downloads it.
With `retainImage: false`, it deletes the file as soon as the validation reaches a terminal state
that no longer needs it. The verdict and the extracted data are kept.

```ts
const validation = await client.validations.validateOcr({
  image: 'receipt.png',
  retainImage: false,
});
console.log(validation.attributes.image_retained); // false
```

`enqueueOcr()` accepts `retainImage` too. `image()` answers `410` with `image_not_retained` when the
file is not kept, and the API rejects a value that is not a boolean with `422`
(`invalid_retain_image`).

### List and walk the history

```ts
const page = await client.validations.list({ status: 'valid', perPage: 50 });
console.log(page.total, 'validations,', page.totalPages, 'pages');

for await (const item of client.validations.iter({ from: '2025-03-01', to: '2025-03-31' })) {
  console.log(item.id, item.attributes.status);
}
```

`iter()` is an `AsyncIterable` and requests the next page only when the previous one runs out.
`maxPages` bounds the walk. Each `Page` carries `items`, `page`, `perPage`, `total`, `totalPages`,
`hasNext` and `meta`. The API clamps `perPage` to the maximum of the operation (50 for validations,
100 for deliveries and import previews) and does not reject it. `Page.perPage` reports the value
the API applied.

The filters (`status`, `type`, `from`, `to`, `search`, `playground`, `withDeleted`, `batchId`,
`bank`, `banks`, `amountMin`, `amountMax`, `clientRef` and `retryState`) use `camelCase`. `status`
takes one state or a list, typed with `ValidationStatus`. `withDeleted: true` returns only the
validations removed from the history, while `false` returns only the active ones. `banks` filters by
several banks at once: up to 50 SPEI codes, as a list or comma-separated, and returns the validations
whose sender or receiver bank is any of them.

A listing carries fewer fields than `get()`: it leaves out the data sent, the Banxico result and the
receipt links.

`client.validations.export({ format: 'csv' })` exports the history. It also accepts `xlsx` and the
same filters. `client.validations.stats()` returns the totals with those filters.

## Download the CEP

```ts
import { writeFile } from 'node:fs/promises';
import { hasCep } from '@veriko-mx/sdk';

if (hasCep(validation)) {
  const cep = await client.getCep(validation.id, { format: 'pdf' }); // or 'xml'
  await writeFile(cep.filename, cep.content); // CEP-<id>.pdf
}
```

`getCep()` returns the file: the XML Banxico issued, with its digital seal and original string, or
the equivalent PDF. When the validation has no receipt, the API answers `404` with
`cep_not_available` and the SDK throws `NotFoundError`.

Downloads and exports return the file and not a link: `content`, `contentType`, `headers` and the
`filename` the API proposes in `Content-Disposition`. The SDK reads the name from `filename*`
(RFC 6266) first and from `filename`, including quoted names that contain `;`, otherwise.

### Stream a large download

Each download has a `*Stream()` variant that resolves to a web `ReadableStream` and does not buffer
the body: `validations.cepStream()`, `validations.imageStream()`, `validations.exportStream()`,
`webhooks.exportDeliveriesStream()`, `beneficiaries.exportStream()`,
`beneficiaries.importTemplateStream()`, `usage.exportStream()`, `finance.statementStream()`,
`finance.reportStream()`, `finance.cepsStream()` and `finance.downloadCepExportStream()`. They take
the same arguments as the buffered methods.

```ts
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const file = await client.finance.downloadCepExportStream(created.id);
console.log(file.filename, file.contentLength, file.headers['x-finance-items']);
await pipeline(Readable.fromWeb(file.stream), createWriteStream(file.filename));
```

The result carries `stream`, `contentType`, `filename`, `contentLength` (`undefined` when the response
has no `Content-Length`) and `headers`. Read the stream to the end or call `stream.cancel()`, so the
connection is released. `timeoutMs` covers the wait for the headers and not the transfer; the
`signal` of the call options cancels the transfer, and the stream then fails with
`RequestAbortedError`. A stream is not retried once it starts. An error response is read whole, so it
still throws the typed error. `finance.reportStream('monthly' | 'counterparties' | 'by-bank' |
'accounting', params)` streams the report files; the `preview` format is JSON, so use the buffered
method for it.

## Recheck the payment later

`client.validations.recheck(id)` queries Banxico again for the payment status of a `valid`
validation created at most 72 hours ago, without consuming quota.

```ts
const result = await client.validations.recheck(validation.id);

console.log(result.changed); // true if it moved from valid to returned
console.log(result.previousStatus); // 'valid'
console.log(result.validation.attributes.status); // 'returned'
```

If Banxico reports `devuelto` or `en_proceso_devolucion`, the validation changes to `returned`, keeps
its CEP, and the API emits the `validation.returned` webhook. The payment status is in
`attributes.banxico_result._payment_status`. A validation that was already `returned` answers its
current state without querying Banxico, and `checkedAt` is `null`.

Each validation accepts one recheck every 10 minutes. Before that, the SDK throws `RateLimitError`
with `recheck_rate_limited`, and `retryAfter` carries the seconds left. A validation in another
state, or older than 72 hours, throws `InvalidRequestError` with `recheck_not_eligible` or
`recheck_window_expired`. If Banxico does not deliver a readable status, it throws `ServerError`
with `recheck_unavailable`: the validation keeps its interval and a retry is possible at once.

## Delete a validation

`client.validations.delete(id)` removes a validation from the history, but the record, the CEP, the
extracted data and the receipt file keep existing. The permanent purge deletes them in two steps: the
first describes what it would delete and issues a single-use token, and the second confirms it.

```ts
const preparation = await client.validations.preparePurge(validation.id);

console.log(preparation.attributes.will_delete); // what would be deleted
console.log(preparation.attributes.expires_in); // seconds the token stays valid

const result = await client.validations.executePurge(validation.id, {
  confirmationToken: preparation.attributes.confirmation_token,
});
console.log(result.attributes.purged_at, result.attributes.file_removal);
```

**The purge is irreversible and does not return quota.** The validation stays as a tombstone: it
keeps the verdict, the dates and the amount, and carries `attributes.purged_at`. After that, the CEP,
the receipt, the retries and `recheck()` answer `410` with `validation_purged`, which the SDK throws
as `GoneError`. `file_removal` is `pending` when a file could not be deleted at that moment and the
daily sweep finishes it.

A validation in progress throws `ConflictError` with `purge_validation_in_progress`. An expired,
malformed token, or one from another validation, throws `InvalidRequestError`, and a token already
used throws `ConflictError` with `confirmation_token_already_used`. If the response of
`executePurge()` does not arrive, `client.getValidation(id)` tells whether the purge completed.

## Register a webhook

```ts
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/payments',
  events: ['validation.completed'],
});

console.log(endpoint.attributes.secret); // 64 hex
```

The signing secret travels **once**, in this response. If it is lost,
`client.webhooks.regenerateSecret(endpoint.id)` returns a new one. The previous secret keeps signing
for 24 hours: each delivery then carries `X-Webhook-Signature-Old`, and
`attributes.previous_secret_expires_at` says until when. Pass `{ immediate: true }` to revoke the
previous secret at once, for example when it was exposed.

```ts
const rotated = await client.webhooks.regenerateSecret(endpoint.id, { immediate: true });
console.log(rotated.attributes.secret);
```

`client.webhooks.test(endpoint.id)` sends a test event and tells whether the receiver accepted it.
Test deliveries do not count toward the consecutive-failure counter that turns an endpoint off after
three in a row. When that happens, the state is `auto_disabled`, and
`client.webhooks.update(id, { status: 'active' })` reactivates it.

The attempt history is in `client.webhooks.deliveries()`, with or without an endpoint identifier, and
`iterDeliveries()` walks it. `exportDeliveries()` downloads it as CSV or XLSX. Filters exist only on
the global listing: with an endpoint and a filter, or with a list of up to 20 endpoints, the SDK
queries that listing with `endpoint_id`. A list of more than 20 endpoints throws `ConfigurationError`.

```ts
const failed = await client.webhooks.deliveries({
  status: ['failed', 'retrying'],
  responseStatus: ['5xx', 'none'],
  from: '2026-10-01',
  minAttempt: 2,
});
```

`status`, `eventType` and `responseStatus` take one value or a list. `responseStatus` accepts an exact
code (`404`), a family (`'5xx'`) or `'none'` for deliveries with no response. `from` and `to` bound the
creation date, `validationId` keeps the deliveries of one validation, `minResponseTimeMs` the slow
responses, and `q` searches the identifier, the endpoint, the event, the validation and the HTTP
code. `exportDeliveries()` accepts the same filters and `limit`.

## Catalog and Banxico status

```ts
const banks = await client.catalog.banks(); // SPEI institutions with their code
const calendar = await client.catalog.speiCalendar(2026); // SPEI non-business days of the year
const card = await client.catalog.binLookup('455632'); // issuing bank of a card
const status = await client.catalog.banxicoStatus();

console.log(status.attributes.status); // 'operational'
```

`banxicoStatus()` tells a `cep_unavailable` caused by the transfer from an outage of the service, and
`banxicoTimeseries()` returns the latency or verdict series per window.

`speiCalendar()` returns `SpeiCalendar`: `attributes.non_business_days` carries the Monday to Friday
non-business days (`YYYY-MM-DD`), `attributes.source` the CNBV provision published in the DOF, and
`coveredYears` the years with a calendar. Saturdays and Sundays are always non-business days and do
not repeat in the list. The query consumes no quota. A year with no calendar throws `NotFoundError`
with `spei_calendar_year_not_covered`.

## Beneficiaries

`client.beneficiaries` stores the accounts you pay: CLABE, card or DiMo phone. The type is detected
from the length of the number, and a phone requires `bankCode`.

```ts
const beneficiary = await client.beneficiaries.create({
  accountNumber: '012180004412345678',
  label: 'Supplier ABC',
});

const found = await client.beneficiaries.lookup('012180004412345678'); // the account already saved
console.log(found.attributes.bank_name);

const check = await client.beneficiaries.validateAccount({
  account: '01218000441234567',
  type: 'clabe',
});
console.log(check.attributes.checksum_valid, check.attributes.bank?.name); // completes the 17-digit CLABE
```

`validateAccount()` checks an account number without saving it: type, length, check digit and bank.
`type` is optional (`'clabe'` or `'bin'`).

Registering an archived account reactivates it: the API answers `200` instead of `201` and
`beneficiary.reactivated` is `true`. Without `label`, the account keeps its alias. Registering an
account that is already active throws `InvalidRequestError` with `beneficiary_already_registered`.

`client.beneficiaries.list()` walks the full list and does not paginate. `delete()` archives an
account without deleting it, and `list({ withArchived: true })` returns only the archived ones.
`export()` downloads it as CSV or XLSX.

### Bulk import

The import is a cycle: download the template, upload the file, review the rows and confirm.

```ts
const template = await client.beneficiaries.importTemplate({ format: 'csv' }); // 1. download
const started = await client.beneficiaries.importStart('beneficiaries.csv'); // 2. upload
await client.beneficiaries.importWait(started.id); // 3. wait for the preview

for await (const row of client.beneficiaries.iterImportPreview(started.id, {
  buckets: ['correctable'],
})) {
  // 4. review
  if (row.id !== undefined) {
    await client.beneficiaries.importEditRow(started.id, row.id, { parsedBankCode: '40012' });
  }
}

await client.beneficiaries.importCommit(started.id); // 5. confirm
```

`importStart()` takes the bytes of the file or its path and uploads it as `multipart/form-data`. The
formats are CSV, XLS, XLSX, TXT, JSON and PDF, up to 20 MB, and the SDK sends the content type that
matches the extension. Only one import can be open at a time: another one answers `422` with
`import_already_in_flight`. Nothing is persisted until `importCommit()`. `importWait()` waits for
`preview_ready` or a final state, which is what `isImportSettled()` tells apart. The status
endpoint exposes no `ETag`, so each round downloads the body. `importCancel()` cancels an import that
is not yet confirmed.

The preview query filters rows with `buckets` (`valid`, `correctable`, `fatal`, `duplicate_account`,
`duplicate_alias`). The SDK sends it as `buckets[]`, which is the form the API reads.

## Usage

```ts
const summary = await client.usage.summary();
console.log(summary.attributes?.used, 'of', summary.attributes?.limit);

const history = await client.usage.history({ months: 6 });
const limits = await client.usage.limits();
```

`summary()` carries the quota of the current plan and `limits()` the rate limits, which are separate
from that quota. `breakdown()`, `heatmap()` and `apiUsage()` break the usage down, and
`client.usage.export({ format: 'csv' })` downloads the activity log.

## CEP exports

`client.finance.createCepExport()` starts an export of CEPs as an archive. It accepts an
`Idempotency-Key`, and `waitForCepExport()` polls until the export reaches a terminal state:

```ts
const created = await client.finance.createCepExport({ from: '2026-10-01', to: '2026-10-31' });
const ready = await client.finance.waitForCepExport(created.id);
console.log(ready.attributes?.status); // 'ready'
```

The terminal statuses are `ready`, `failed` and `expired`, listed in `CEP_EXPORT_TERMINAL_STATUSES`
and checked by `isCepExportTerminal()`. `waitForCepExport()` honors `Retry-After` and takes the same
options as `waitFor()`.

## Conditional reads

`client.validations.get()`, `client.catalog.banks()` and `client.catalog.speiCalendar()` accept
`ifNoneMatch`. The response carries the `ETag` in `etag`, and when nothing changed the API answers
`304`, which the SDK throws as `NotModifiedError` with the `etag` of the current representation.

```ts
import { NotModifiedError } from '@veriko-mx/sdk';

const validation = await client.validations.get(id);

try {
  await client.validations.get(id, { ifNoneMatch: validation.etag });
} catch (error) {
  if (!(error instanceof NotModifiedError)) throw error;
}
```

## Verify the signature of a webhook

Each delivery arrives signed with the HMAC-SHA256 of the body, using the secret that
`POST /v1/webhooks` returned when the endpoint was registered:

```
X-Webhook-Signature: sha256=<hex>
```

What is signed is the body **exactly as it arrived**. Parsing the JSON and serializing it again
changes the bytes and the signature no longer matches. In Express, that means `express.raw()` on the
webhook route, not `express.json()`.

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

  response.sendStatus(200); // answer 2xx first, process afterwards

  if (isKnownWebhookEvent(event) && event.event === 'validation.completed') {
    console.log(event.data.id, event.data.attributes.status);
  }
});
```

`parseWebhook(payload, signatureOrHeaders, secret, options)` takes either the value of
`X-Webhook-Signature` or the headers of the request. With the headers, it verifies the timestamped
signature inside a time window, which also protects against replays. With only the signature value,
it proves the origin and nothing about freshness.

The event is a union discriminated by `event`. For the seven `validation.*` events, `event.data` is
the validation, and `validation.returned` also types `attributes.payment_status`. For the five
`billing.*` events and for `test`, the API does not publish the shape of `data`, so it is in
`event.rawData`. An event this version does not know, or a validation event whose body is not the
documented one, comes back as `UnknownWebhookEvent`. `isKnownWebhookEvent(event)` narrows to
`WebhookEvent`, and a `switch (event.event)` then covers every case:

```ts
const event = parseWebhook(request.body, request.headers, SECRET);
if (!isKnownWebhookEvent(event)) return; // acknowledge it and look at event.rawData later

switch (event.event) {
  case 'validation.returned':
    event.data.attributes.payment_status.code; // typed
    break;
  case 'validation.completed':
    event.data.attributes.banxico_confirmed?.amount;
    break;
}
```

With the headers, the event also carries `deliveryId` (`X-Veriko-Delivery-Id`) and `attemptTimestamp`
(the `t` of the timestamped signature). A body without `event` takes it from `X-Veriko-Event`.

`verifyWebhook(payload, signature, secret)` makes the same check and returns `true` or `false`, to
decide the response code separately. The comparison runs in constant time and works with any input,
non-ASCII included.

The complete receiver is in [`examples/webhook-receiver.mjs`](examples/webhook-receiver.mjs). It uses
`node:http`; the Express version differs only in `express.raw()`.

### Rotate the secret

`secret` accepts one string or a list. During a rotation, pass the new secret and the previous one:
a delivery verifies if its signature matches any of them, in `X-Webhook-Signature-Timestamped` or in
`X-Webhook-Signature-Old`.

```ts
const event = parseWebhook(request.body, request.headers, [NEW_SECRET, PREVIOUS_SECRET]);
```

Drop the previous secret once `previous_secret_expires_at` has passed.

### A later return

`validation.returned` notifies when a validation that had come out `valid` changes to `returned`
afterwards. The endpoint receives only the events it subscribed to, so add it next to
`validation.completed`:

```ts
const endpoint = await client.webhooks.create({
  url: 'https://myapp.example.com/hooks/payments',
  events: ['validation.completed', 'validation.returned'],
});
```

The body is that of `validation.completed` plus `attributes.payment_status`, which `parseWebhook()`
delivers in `event.data.attributes.payment_status`:

```ts
if (isKnownWebhookEvent(event) && event.event === 'validation.returned') {
  console.log(event.data.attributes.payment_status.code); // devuelto or en_proceso_devolucion
}
```

`checked_at` is the instant of the query. In every other event, `payment_status` is absent. The event
is not emitted when the validation is created: an operation that arrives already returned is
delivered with `validation.completed` and `status=returned`.

### What Banxico confirmed

When `banxico_status` is `valid`, or `returned` with a downloaded CEP, `event.data.attributes` also
carries `banxico_confirmed`: the amount, the date, the tracking key, both banks and the beneficiary
account (masked to the last 4 digits), as Banxico confirmed them. Compare it with the order before
you release the goods: the image of a receipt can show an amount different from the one Banxico
confirmed.

### The headers of a delivery

| header                            | content                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `X-Webhook-Signature`             | `sha256=` followed by the HMAC in hexadecimal                             |
| `X-Webhook-Signature-Timestamped` | `t=<seconds>,v1=<hex>`: signature of `<t>.<body>` with the attempt time   |
| `X-Webhook-Signature-Old`         | The same format, signed with the previous secret. Present during rotation |
| `X-Veriko-Event`                  | Event type, for example `validation.completed`                            |
| `X-Veriko-Delivery-Id`            | Identifier of the delivery, stable across retries                         |
| `X-Veriko-Timestamp`              | Moment of sending, ISO 8601 with a `Z` suffix                             |

The `Delivery-Id` is the value that lets you discard repeated deliveries.

### Timestamped signature

`X-Webhook-Signature-Timestamped` signs the attempt time together with the body, so the receiver can
discard an old delivery that someone sends again. `X-Webhook-Signature` does not change.

```ts
import { verifyWebhookTimestamped } from '@veriko-mx/sdk';

if (
  !verifyWebhookTimestamped(
    request.body, // the raw body
    request.get('X-Webhook-Signature-Timestamped'),
    SECRET,
  )
) {
  return response.sendStatus(400);
}
```

`verifyWebhookTimestamped(payload, header, secret, { toleranceSeconds, now })` returns `true` or
`false`. It computes the HMAC-SHA256 of `<t>.<body>`, compares it in constant time with each `v1` of
the header, and rejects the delivery if `t` is further from the receiver's clock than
`toleranceSeconds`, 300 by default. `now` sets the current time with a `Date`, for tests.
`verifyDelivery(payload, headers, secret, options)` checks the timestamped and the `-Old` signature
together, and `verifyWebhookHeaders()` is the same check. With `requireTimestamp: false`, a delivery
with no valid timestamped signature falls back to `X-Webhook-Signature`, which gives no protection
against a replay. `attemptTimestamp(header)` reads `t`. `timestampedSignatureFromHeaders(headers)`, `oldSignatureFromHeaders(headers)` and
`signatureFromHeaders(headers)` find each header under any capitalization.

The window applies to `t`, the attempt time, and not to the `timestamp` field of the body, which is
the event time. A retry arrives up to about 8.6 hours after the event, but carries a freshly
generated `t`. Measuring the window against the `timestamp` of the body would reject legitimate
retries. The window does not replace deduplication: store the `Delivery-Id` for at least 24 hours.

## Retries

Two different mechanisms share the name.

**The client's** repeat a request that failed for transient causes. The SDK retries `5xx`, `408` and
`429`, and honors the `Retry-After` of the response in full. A `Retry-After` longer than
`retry.maxRetryAfterMs` (60 seconds by default) is not waited out: the call throws the typed error,
with `retryAfter` set. The other `4xx` are not retried, because the request has to be fixed before it
is repeated. A `429` with `quota_exceeded` is not retried either: the plan quota does not refill in
seconds.

A `POST` is retried only when it carries an `Idempotency-Key`. Without one, a repeat could duplicate
the operation. `recheck()` and `executePurge()` never retry: the first has its own limit of one
recheck every 10 minutes, and the purge is irreversible.

```ts
const client = new Veriko({ maxRetries: 3 }); // 0 turns them off; the default is 2
```

**The API's** keep querying Banxico for hours, because a CEP takes time to publish, and notify by
webhook when the verdict changes.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  retryPolicy: {
    enabled: true,
    max_retries: 3,
    interval_seconds: 600, // from 300 to 86,400
    outcomes: ['not_found', 'cep_unavailable'], // which verdicts to retry
  },
});
```

Read the progress of the cycle in `(await client.getValidation(id)).attributes.retry_state`, or wait
for the `validation.retry.resolved` webhook. The attempts already made are in
`client.validations.retryAttempts(id)`.

`client.validations.setRetryPolicy(id, policy)` changes the policy of an existing validation, and
`client.validations.cancelRetries(id)` stops the cycle. Both return the state of the cycle, not the
full validation.

## Idempotency

Retrying a `POST` without an idempotency key can duplicate the validation, and its charge, when the
response was lost but the request arrived. With a key, the repeat returns the original response for
24 hours.

```ts
const validation = await client.validateTransfer({
  sendDate: '2025-03-15',
  amount: 15000.5,
  trackingKey: 'MXBA20250315001234',
  idempotencyKey: 'order-4f3a2b1c', // the identifier of the business attempt
});
```

Derive the key from the business attempt (the order, batch or transaction number). Do not generate a
random one on each send: a random key per retry cancels the protection. A key has 1 to 255 characters
among letters, digits, `_` and `-`. The SDK rejects any other key with `InvalidRequestError`
(`invalid_idempotency_key`) before it sends anything.

Without `idempotencyKey`, the SDK generates one per call and repeats it in its own retries. That key
does not survive the process that generated it, so a later resend does run twice. This applies to the
six operations that accept the header: `validate()`, `validateOcr()` (and so `enqueue()` and
`enqueueOcr()`), `setRetryPolicy()`, `cancelRetries()`, `account.updateMyRetryPolicy()` and
`finance.createCepExport()`.

When the first request with a key is still running, the API answers `409` with
`idempotency_key_in_progress`. The SDK waits `Retry-After` (or its own backoff) and repeats the request
with the same key, up to `retry.maxInProgressWaitMs` of accumulated waiting, 120 seconds by default.
`ConflictError.inProgress` tells that case from other conflicts when the wait runs out. Reusing a key
with a different body answers `422` with `idempotency_key_reused`.

## Per-call options

Every method takes a last argument with the options of that call:

```ts
const controller = new AbortController();

const validation = await client.validations.get(id, {
  signal: controller.signal, // aborts the call, retries and waits included
  timeoutMs: 10_000, // per attempt
  maxRetries: 0,
  acceptLanguage: 'en', // language of error.detail
  headers: { 'X-Trace-Id': traceId }, // extra headers; Authorization cannot be overridden
});
```

`idempotencyKey` and `onResponse` are also per-call options. A call the caller aborts throws
`RequestAbortedError` and is never retried. An attempt that exceeds `timeoutMs` throws
`RequestTimeoutError`, a subclass of `ConnectionError`, once the retries are spent.
`ConnectionError.attempts` says how many attempts were made. `retry` on the client adjusts the retry
limits (`maxRetryAfterMs`, `maxInProgressWaitMs`) for every call.

## Response metadata

Every method returns an `ApiPromise`, a `Promise` that also offers `.withResponse()`. `await` keeps
returning the resource. `.withResponse()` also returns the metadata of the response:

```ts
const { data, response } = await client.validateTransfer(params).withResponse();

console.log(response.requestId); // the value to quote when you contact support
console.log(response.rateLimit?.remaining);
console.log(response.quota?.remaining);
console.log(response.replayed); // true when the API replayed a stored response
console.log(response.attempts); // requests it took, retries included
```

`ResponseMeta` carries `status`, `headers`, `requestId`, `apiVersion`, `meta`, `rateLimit`, `quota`,
`replayed`, `etag`, `location`, `retryAfter`, `deprecation`, `sunset`, `link` and `attempts`. A
download carries `headers` on the `DownloadedFile` too.

To observe every response without changing the calls, pass `onResponse` to the client or to a call. To
learn that an endpoint is deprecated, pass `onDeprecation`: it receives the `Deprecation`, `Sunset`
and `Link` headers of the response. Without a handler, the SDK emits one process warning
(`VERIKO_API_DEPRECATION`) per endpoint.

```ts
const client = new Veriko({
  onResponse: (meta) => metrics.record(meta.requestId, meta.attempts),
  onDeprecation: (notice) => logger.warn(notice.path, notice.sunset),
});
```

## Errors

Every exception inherits from `VerikoError`. The API ones carry `code`, which is the stable contract,
and `detail`, which is translated and can be reworded between versions. Branch on `code`, never on
`detail`.

```ts
import { InvalidRequestError, NotFoundError, RateLimitError } from '@veriko-mx/sdk';

try {
  const validation = await client.validateTransfer(params);
} catch (error) {
  if (error instanceof InvalidRequestError) {
    // 400, 413, 422: a 422 carries one entry per invalid field
    for (const entry of error.errors) {
      console.error(entry.code, entry.source?.pointer, entry.hint, entry.docs_url);
    }
  } else if (error instanceof RateLimitError) {
    console.error(error.kind, 'wait', error.retryAfter, 'seconds');
  } else if (error instanceof NotFoundError) {
    // 404
  }
}
```

| exception                    | status                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| `NotModifiedError`           | `304`, from a conditional read                                      |
| `AuthenticationError`        | `401`                                                               |
| `ForbiddenError`             | `403`                                                               |
| `NotFoundError`              | `404`                                                               |
| `ConflictError`              | `409`                                                               |
| `GoneError`                  | `410`, for example `validation_purged` and `image_not_retained`     |
| `InvalidRequestError`        | `400` and `422`                                                     |
| `PayloadTooLargeError`       | `413`, a subclass of `InvalidRequestError`                          |
| `RateLimitError`             | `429`                                                               |
| `QuotaExceededError`         | `429` with `quota_exceeded`, a subclass of `RateLimitError`         |
| `ServerError`                | `5xx`                                                               |
| `ApiError`                   | Any other API status. It is the base of the classes above           |
| `ConnectionError`            | No response, with the retries spent                                 |
| `RequestTimeoutError`        | An attempt exceeded `timeoutMs`, a subclass of `ConnectionError`    |
| `RequestAbortedError`        | The caller aborted the call                                         |
| `TimeoutError`               | `waitFor()`, `waitForCepExport()` or `importWait()` ran out of time |
| `SignatureVerificationError` | The signature of a webhook does not match                           |
| `ConfigurationError`         | The API key is missing or an argument of the client is unusable     |

An `ApiError` carries:

- `status`, `code`, `detail`, `hint`, `docsUrl` and `pointer`, taken from the first entry of `errors`.
- `errors`, the full list, and `codes`, the code of every entry. `hasCode(code)` checks the whole list.
- `requestId`, the value that identifies the request in the system logs.
- `meta`, `headers`, `retryAfter` and `validationId`, the validation created before the request failed,
  when there is one.
- `local`, `true` when the SDK raised the error before sending the request. The codes of those errors
  are the ones the API would answer with, and `ERROR_CODES` lists the ones the SDK compares or raises.

`RateLimitError` adds `kind` (`'rate_limit'` or `'quota'`), `limit`, `remaining` and `resetAt`, read
from the `X-RateLimit-*` headers.

## Types

The types of what travels on the wire are generated from the OpenAPI spec and versioned in
[`src/generated/openapi.ts`](src/generated/openapi.ts):

```bash
npm run gen:types    # openapi-typescript over spec/openapi.yaml
```

The copy of `spec/openapi.yaml` comes from
[docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml), and `npm run check:spec-public`
checks on every CI run that it meets the API contract.

The examples in that spec cite a generic host. The SDK sets the real root of the API in
`DEFAULT_BASE_URL`.

Each method returns the `data` resource of the response, typed by the spec: `validation.attributes`,
`endpoint.attributes.secret`, `bank.attributes.name`.

The bodies of `POST /v1/validate` and `POST /v1/validate-ocr` are the only exception and are written
by hand: their schemas carry an `anyOf` that the generator turns into `unknown`.
`test/spec.test.ts` fails if the spec adds, removes or renames any of their fields.

Besides the types with a short name, the package re-exports the full `components`, `operations` and
`paths`, for when you need an operation the SDK does not wrap yet.

## M2M surface

The SDK covers exactly the 75 operations of the public spec: `security: []` for the public ones and
`ApiKeyAuth` for the authenticated ones.

Among them are the profile and its retry policy, the dashboard summary, the two public plan endpoints,
the four insights views, the eleven finance operations and the subscription. For example:

```ts
const profile = await client.account.myProfile();
const trends = await client.insights.getTrends({ range: '30d', metric: 'latency' });
const statement = await client.finance.getStatement({ month: '2026-04', format: 'pdf' });
await writeFile(statement.filename, statement.content);
```

The monthly, counterparty, bank and accounting reports keep the API default, `format: 'csv'`. Pass
`format: 'preview'` explicitly when you need the JSON response to process in memory.

## Development

```bash
npm install
npm test               # compiles to dist-test/ and runs node --test
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run build          # dist/esm and dist/cjs
npm run gen:types      # regenerates src/generated from spec/openapi.yaml
npm run test:examples  # builds, then runs examples/ against the recordings
```

`test/operations.test.ts` derives the M2M set from `spec/openapi.yaml` (the operations that accept
`ApiKeyAuth` or declare `security: []`) and compares it with the methods, one to one. It exercises
every route against a local HTTP server, and fails when an M2M operation has no method or a method
falls outside the contract. `VERIKO_TEST_SPEC=<path>` points the spec tests at another spec file.

`npm run test:examples` runs each file of [`examples/`](examples) as a child process whose
`VERIKO_BASE_URL` is the recording server, checks the requests it sends and what it prints, and
delivers signed webhooks to the receiver. CI runs it in its own job.

No test calls the API. The harness starts a local HTTP server that serves the responses stored in
[`test/recordings/`](test/recordings), trimmed from the examples of the public spec.

## Links

- API documentation: [docs.veriko.mx](https://docs.veriko.mx)
- OpenAPI spec: [docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml)
- Python SDK: [veriko-mx-labs/veriko-python](https://github.com/veriko-mx-labs/veriko-python)
- Examples in other languages: [veriko-mx-labs/examples](https://github.com/veriko-mx-labs/examples)
- The CEP in detail: [docs.veriko.mx/en/concepts/cep-concept](https://docs.veriko.mx/en/concepts/cep-concept)
- Error reference: [docs.veriko.mx/en/concepts/errors](https://docs.veriko.mx/en/concepts/errors)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [`LICENSE`](LICENSE).
