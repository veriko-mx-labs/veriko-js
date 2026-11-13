# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [0.6.0] - 2026-11-13

### Added

- `beneficiaries.validateAccount({ account, type })`: checks an account number without saving it (type,
  length, check digit and bank). It returns `AccountValidation`.
- `validateOcr()`, `enqueueOcr()` and `validations.validateOcr()` accept `recipientIsBank`.
- `userAgentPrefix`: the product that wraps the SDK goes before its token, as the MCP server does.
- `buildUserAgent()` returns the header the client sends.
- Per-call options as the last argument of every method: `signal`, `timeoutMs`, `maxRetries`,
  `idempotencyKey`, `headers`, `acceptLanguage` and `onResponse`. `Authorization` cannot be
  overridden through `headers`.
- `ApiPromise`: every method returns a `Promise` that also offers `.withResponse()`, which resolves
  `{ data, response }`. `ResponseMeta` carries `status`, `headers`, `requestId`, `apiVersion`, `meta`,
  `rateLimit`, `quota`, `replayed`, `etag`, `location`, `retryAfter`, `deprecation`, `sunset`, `link`
  and `attempts`.
- The client options `onResponse` and `onDeprecation`. Without an `onDeprecation` handler, a response
  with `Deprecation` or `Sunset` emits one process warning (`VERIKO_API_DEPRECATION`) per endpoint.
- Error classes `NotModifiedError` (`304`), `GoneError` (`410`), `PayloadTooLargeError` (`413`, a
  subclass of `InvalidRequestError`), `QuotaExceededError` (a subclass of `RateLimitError`),
  `RequestTimeoutError` (a subclass of `ConnectionError`) and `RequestAbortedError`.
- `ApiError` exposes `hint`, `docsUrl`, `pointer`, `codes`, `hasCode()`, `validationId`, `retryAfter`
  and `local`, next to the full `errors` list. `RateLimitError` adds `kind`, `limit`, `remaining` and
  `resetAt`, and `ConflictError` adds `inProgress`. `ConnectionError` adds `attempts`.
- `ERROR_CODES` and `IDEMPOTENCY_KEY_PATTERN`.
- `validations.validateAndWait()` and `validations.validateOcrAndWait()`. `validate()` and
  `validateOcr()` return `ValidationResult`, whose `queued` field carries the `202` acknowledgment
  (`asyncReason`, `nextPollAfterSeconds`, `expiresAt`, `etag`, `location`).
- `finance.waitForCepExport()`, `CEP_EXPORT_TERMINAL_STATUSES` and `isCepExportTerminal()`.
- `webhooks.regenerateSecret(id, { immediate })`. With `immediate: true`, the previous secret stops
  being valid at once.
- `OLD_SIGNATURE_HEADER`, `oldSignatureFromHeaders()` and `verifyWebhookHeaders()`. `parseWebhook()`
  and the verification functions accept a list of secrets, for a rotation. `parseWebhook()` also
  accepts the request headers instead of the signature value, and verifies the timestamped signature
  and `X-Webhook-Signature-Old` within the tolerance window.
- `WebhookEvent.rawData`: the `data` of the body for events that are not about a validation.
- `DownloadedFile.headers` and `Page.meta`.
- `*Stream()` variants of the large downloads, which resolve to a `DownloadedStream` (a web
  `ReadableStream` with `contentType`, `filename`, `contentLength` and `headers`) and do not buffer the
  body: `validations.cepStream()`, `validations.imageStream()`, `validations.exportStream()`,
  `webhooks.exportDeliveriesStream()`, `beneficiaries.exportStream()`,
  `beneficiaries.importTemplateStream()`, `usage.exportStream()`, `finance.statementStream()`,
  `finance.reportStream()`, `finance.cepsStream()` and `finance.downloadCepExportStream()`. The
  buffered methods are unchanged.
- `WebhookEvent` is a union discriminated by `event`: `ValidationWebhookEvent`,
  `ValidationReturnedWebhookEvent` (with `attributes.payment_status` typed), `BillingWebhookEvent` and
  `TestWebhookEvent`. `parseWebhook()` returns `WebhookEvent` or `UnknownWebhookEvent`, and
  `isKnownWebhookEvent()` tells them apart. `VALIDATION_WEBHOOK_EVENTS` and `BILLING_WEBHOOK_EVENTS`
  list the names.
- `verifyDelivery()`, which checks a delivery from its headers and takes `requireTimestamp`, and
  `attemptTimestamp()`. The parsed event carries `deliveryId` and `attemptTimestamp`, and takes the
  event name from `X-Veriko-Event` when the body has none. Header lookup accepts the CGI spelling
  (`HTTP_X_WEBHOOK_SIGNATURE`).
- `npm run test:examples` and a CI job that run every file in `examples/` against the recorded
  responses.
- The retry options `maxRetryAfterMs` (60 seconds) and `maxInProgressWaitMs` (120 seconds).
- A per-call `acceptLanguage`, which sets the language of `error.detail` for that call.

### Changed

- The arguments of `validateTransfer()`, `validations.validate()`, `validateOcr()`, `enqueue()` and
  `enqueueOcr()` use the English names of the API: `sendDate`, `amount`, `trackingKey`,
  `numericReference`, `senderBank`, `receiverBank`, `beneficiaryAccount`, `candidateAccounts` and
  `recipientIsBank`. The body always goes out with the English names (`send_date`, `amount`, and so on).
- `recipientIsBank` is a boolean and is sent as one. `0` and `1` are still accepted, and the SDK
  converts them.
- Responses expose the English names (`request_data`, `ocr_result`, `normalized_data`,
  `confidence_by_field`, the listings, the finance summary and the detected accounts). If the API sends
  only a name from an earlier version, the SDK fills in the current name with the same value.
- The `User-Agent` becomes `veriko-sdk-js/<version> (<runtime> <version>; <system> <architecture>)`, for
  example `veriko-sdk-js/0.6.0 (node 22.11.0; linux x64)`. The runtime is `node`, `deno` or `bun`. It
  carries no other machine data. `userAgentSuffix` is still appended at the end.
- A `POST` is retried only when it carries an `Idempotency-Key`. The six operations that accept the
  header generate one when the caller gives none: `validate()`, `validateOcr()` (and so `enqueue()`
  and `enqueueOcr()`), `setRetryPolicy()`, `cancelRetries()`, `account.updateMyRetryPolicy()` and
  `finance.createCepExport()`.
- A `409` with `idempotency_key_in_progress` waits for `Retry-After` (or the backoff) and repeats the
  request with the same key, up to `maxInProgressWaitMs` of accumulated waiting.
- `Retry-After` is honored in full. When it is longer than `maxRetryAfterMs`, the call throws the typed
  error with `retryAfter` set, and does not wait.
- `waitFor()` pauses at least as long as `Retry-After` or `meta.next_poll_after_seconds` ask, ends at
  the `expires_at` of the validation (with a 30 second grace period) or after five minutes, and sends
  the `ETag` of the acknowledgment on its first poll. It accepts the call options.
- `isSettled()` keeps the polling open only for the outcomes the retry policy repeats (`not_found`,
  `cep_unavailable` and `error`).
- Errors the SDK raises before sending a request use the English codes of the API
  (`tracking_key_or_reference_required`, `account_required`,
  `account_and_candidates_mutually_exclusive`, `candidate_accounts_invalid`,
  `image_or_image_url_required`, `invalid_amount`, `invalid_idempotency_key`) and set `local: true`.
- The preview query sends the `buckets` filter as `buckets[]`, which is the form the API reads.
- The Content-Disposition parser reads `filename*` (RFC 6266) and quoted names that contain `;`.
- `ValidationFilters.status` is typed with `ValidationStatus`, and the card fields of
  `AccountValidation` are nullable.
- `WebhookEvent` is a union and no longer an interface with `event: string`. Code that reads
  `event.data` keeps compiling; for `billing.*` and `test` events, `data` is `undefined` and the body
  is in `rawData`. A validation event without the validation resource, or a `validation.returned`
  without `payment_status`, comes back as `UnknownWebhookEvent`.
- The webhook example is `examples/webhook-receiver.mjs`. It uses `node:http` and no longer needs
  Express.
- The recordings follow the 1.212.1 responses: `Deprecation`, `Sunset` and `Link` headers and
  `meta.field_names_notice` on the seven operations that announce the field-name change, 24-character
  request ids and the trace counters of the purge.
- The generated types and their JSDoc use the English text of the spec (`x-translations.en`), and
  leave out the field names from earlier versions. `npm run gen:types` runs `scripts/generate-types.mjs`.
- The operations coverage test derives the M2M set from `spec/openapi.yaml` and compares it with the
  methods one to one.
- The prose of the package, the runtime error messages, the fallback file names of the downloads and
  the examples are in English. The README documents every feature above.

### Deprecated

Field names from earlier versions keep working for existing integrations and emit a deprecation
warning. They are not part of the typed API, and a future version removes them. Sending an earlier
name and its current name together throws `InvalidRequestError` (`alias_conflict`).

### Fixed

- The default timeout goes from 30 to 60 seconds: the API can take up to 45 seconds on a synchronous
  validation before it answers `202`, and with 30 the SDK abandoned the request first. `timeoutMs` is
  still set per client.
- `quota_exceeded` is no longer retried even when it arrives with `429`: the plan quota does not refill
  in seconds, so the error is thrown at once. `rate_limit_exceeded` is still retried.
- `WEBHOOK_EVENTS` matches the event types of the contract: `validation_import.completed`, which does
  not exist, is removed, and `billing.payment_succeeded`, `billing.payment_failed`,
  `billing.trial_will_end`, `billing.subscription_canceled` and `billing.invoice_upcoming` are added.
- `Webhooks.deliveries()` and its variants throw `ConfigurationError` when the endpoint filter has more
  than 20 endpoints, as the API accepts at most 20.
- `amount` rejects `NaN`, an empty value and a non-numeric string with `invalid_amount`.
- The signature comparison is constant-time and works with non-ASCII input.
- Reading `process.env` is guarded, so the client loads in runtimes that have no `process`.
- Imports upload a `.json` file with its own content type.

## [0.5.4] - 2026-11-09

### Changed

- The bundled spec moves to the `1.181.7` public contract. The generated types carry
  `attributes.account_cross_checked` on `Validation`: it is `true` when the account queried at Banxico
  belongs to the client itself. With `false`, a `valid` confirms that the transfer exists, but not that
  it was paid to the expected account. They also carry `meta.async_reason` in the `202` acknowledgment.
- `validateTransfer()` and `validateOcr()` document that the API answers `202` in `processing` when the
  Banxico query passes 45 seconds; the verdict is collected with `get()`.
- `amount` documents the cap of 13 integer digits.

## [0.5.3] - 2026-11-08

### Changed

- An authenticated operation checks the shape of the API key before it sends the request. If the key is
  not `veriko_` followed by 64 lowercase hexadecimal characters, it throws `ConfigurationError` and does
  not reach the network. The error message does not include the key.

## [0.5.2] - 2026-11-08

### Changed

- `sendDate` is optional in `validateTransfer()`, `validations.validate()` and `ValidationRequest`, as in
  the `1.168.2` public contract. If it is missing or unusable, the API tries candidate dates against
  Banxico; it rejects with `422` (`send_date_required`) only when it has nothing to guess it from.

## [0.5.1] - 2026-11-06

### Added

- Background CEP exports, for ranges that are not worth downloading in a single request:
  `finance.createCepExport()` requests the ZIP of a range and returns the export in `queued`;
  `finance.listCepExports()` lists the recent ones; `finance.getCepExport()` reads its state, which is
  terminal in `ready`, `failed` or `expired`; and `finance.downloadCepExport()` downloads the ZIP when it
  is `ready`. The types are `FinanceCepExport` and `FinanceCepExportParams`.
- `WebhookEndpoint.previous_secret_expires_at`: until when the signature with the previous secret is
  accepted after `webhooks.regenerateSecret()`.
- `Validation.error_message` and `WebhookDelivery.error_message`: the readable reason when the
  validation was not confirmed.

### Changed

- `DashboardSummary`: `comenzar_milestones_completed` is now `onboarding_milestones_completed`.

## [0.5.0] - 2026-10-27

### Changed

- `account.myProfile()` follows the `1.111.0` public contract. `UserProfile` no longer includes `role`,
  and `permissions` lists the effective permissions with keys such as `validations.records.read`
  instead of `resource:action` pairs. If your integration read `role`, use `roles`.

### Added

- `UserProfile.platform_access`: `true` when the account can enter the administration panel.
- `UserProfile.roles`: the current roles of the account, each with `key`, `scope_type` (`platform` or
  `organization`) and `scope_id`.

## [0.4.14] - 2026-10-15

### Added

- `beneficiaries.create()` returns `CreatedBeneficiary`, with `reactivated`: `true` when the
  registration reactivated an archived account with the same number (the API answers `200` with
  `meta.reactivated`) and `false` on a new registration.

## [0.4.13] - 2026-10-15

### Added

- `catalog.speiCalendar()` (`GET /v1/public/spei-calendar/{year}`): the SPEI non-business-day calendar of
  a year. It returns `SpeiCalendar`, with `non_business_days` and `source` in `attributes` and the years
  with a calendar in `coveredYears`. It accepts `ifNoneMatch`, and its `ETag` is in `etag`. It consumes
  no quota. A year with no calendar throws `NotFoundError` with `spei_calendar_year_not_covered`.
- `validations.validateOcr()` and `validations.enqueueOcr()` accept `senderBank` and `receiverBank`:
  the 4 or 5 digit SPEI code replaces the bank read from the receipt before Banxico is queried.
- `validations.list()`, `validations.stats()` and `validations.export()` accept `banks`, up to 50 SPEI
  codes as a list or comma-separated; it filters by sender or receiver bank.
- `webhooks.deliveries()`, `webhooks.iterDeliveries()` and `webhooks.exportDeliveries()` accept
  `responseStatus`, `validationId`, `q`, `from`, `to`, `minAttempt` and `minResponseTimeMs`. `status`,
  `eventType` and `responseStatus` take a list, and the endpoint takes a list of up to 20. New type
  `DeliveryFilters`.

## [0.4.12] - 2026-10-02

### Added

- `validations.recheck()` (`POST /v1/validations/{id}/recheck`): queries Banxico again for the payment
  status of a `valid` validation created at most 72 hours ago, without consuming quota. It returns
  `RecheckResult` with the validation and with `checkedAt`, `changed` and `previousStatus`. If Banxico
  reports the return, the validation changes to `returned`. It does not retry on its own.
- `validations.preparePurge()` and `validations.executePurge()`: the permanent purge of a validation, in
  two steps. They return `PurgePreparation` and `PurgeResult`. `executePurge()` does not retry on its
  own. The `Validation` types add `purged_at`.
- `candidateAccounts` in `validateTransfer()`, `validations.validate()`, `validations.validateOcr()`,
  `validations.enqueue()` and `validations.enqueueOcr()`: from 2 to 3 accounts in a single validation
  and with a single quota unit. The `Validation` types add `candidate_match`, with the position and the
  last 4 digits of the account that matched.
- `retainImage` in `validations.validateOcr()` and `validations.enqueueOcr()`, and `image_retained` in
  the `Validation` types: with `retainImage: false` the platform does not keep the receipt file.
- The `validation.returned` event in `WEBHOOK_EVENTS`, which notifies when a `valid` validation changes
  to `returned` afterwards, and `payment_status` (`PaymentStatus`) in `evento.data.attributes`.

### Changed

- `beneficiaryAccount` is no longer required when `candidateAccounts` is sent. With neither, the SDK
  throws `InvalidRequestError` with `cuenta_required`, and with both, with
  `cuenta_y_candidatas_excluyentes`. In both cases it does not call the API.

## [0.4.11] - 2026-10-01

### Added

- `clientRef` in `validateTransfer()`, `validations.validate()`, `validations.validateOcr()`,
  `validations.enqueue()` and `validations.enqueueOcr()`: a reference of your own, from 1 to 64
  characters, that returns in `attributes.client_ref`.
- The exact-match `clientRef` filter in `validations.list()`, `validations.iter()`,
  `validations.stats()` and `validations.export()`.
- The `Validation` types add `client_ref`, `duplicate_of` and `account_conflict`.
- `verifyWebhookTimestamped()` checks the `X-Webhook-Signature-Timestamped` header
  (`t=<seconds>,v1=<hex>`): it compares in constant time the HMAC-SHA256 of `<t>.<body>` with each `v1`
  and rejects the delivery when `t` is further from the clock than `toleranceSeconds`, 300 by default.
  `timestampedSignatureFromHeaders()` finds the header under any capitalization. `verifyWebhook()` does
  not change.
- `parseWebhook()` delivers the `client_ref` in `evento.data.attributes` when the validation webhook
  carries it.

### Changed

- `beneficiaryAccount` is required in `validateTransfer()`, `validations.validate()` and
  `validations.enqueue()`. Without it, the SDK throws `InvalidRequestError` with `cuenta_required` and
  does not call the API.

## [0.4.10] - 2026-09-29

### Changed

- The type descriptions document the per-field codes with which the validation `422` rejects a request
  whose data contradicts itself, before Banxico is queried: `clabe_receptor_mismatch`,
  `tarjeta_receptor_mismatch` and `clave_longitud_invalida`. They arrive in `errors[].code` of
  `InvalidRequestError`. No `preflight_failed` rejection on that route consumes quota, whether the data
  contradicts itself or a field is malformed.

## [0.4.9] - 2026-09-28

### Added

- The types of `usage.summary()` and `billing.getSubscription()` add `quota_kind` (`cycle` or `trial`)
  and `renews`: an account that has not yet activated the free plan consumes trial validations, which do
  not refill. `account.myProfile()` adds `plan_name` to the subscription.

## [0.4.8] - 2026-09-27

### Changed

- `validations.validateOcr()` and `validations.enqueueOcr()` document the receipt as a PDF of 1 to 3
  pages.
- `validations.image()` accepts a PDF receipt and names it with the `.pdf` extension.

## [0.4.7] - 2026-09-26

### Added

- The validation webhook carries `data.attributes.banxico_confirmed` when Banxico has already confirmed
  the payment: amount, date, tracking key, both banks and the masked beneficiary account.

## [0.4.6] - 2026-09-24

### Changed

- The types follow version 1.60.0 of the public spec. The `429` responses declare `meta.retry_after`,
  with the same value as the `Retry-After` header.
- The type descriptions document the validation and filter error codes: `invalid_bank_code`,
  `intra_bank_no_cep`, `invalid_field_type`, `invalid_filter` and `webhook_description_too_long`.

## [0.4.5] - 2026-09-22

No API changes. It updates documentation and metadata.

## [0.4.4] - 2026-09-20

No surface changes.

## [0.4.3] - 2026-09-20

No surface changes.

## [0.4.0] - 2026-09-19

### Added

- The 18 M2M operations that were missing: account profile and retry policy, dashboard summary, public
  plans, insights, finance and subscription. The public plans are requested without an `Authorization`
  header.
- The surface test compares the full 66 operations of the public spec and exercises routes against
  sanitized recordings on a local HTTP server.

### Changed

- `validateAccount()` is no longer part of the SDK: its operation is no longer public M2M. In `0.x`
  this removal is incompatible.
- The monthly, counterparty, bank and accounting reports use `csv` by default, as the public contract
  does. `preview` is requested explicitly.

## [0.3.0] - 2026-09-18

The surface goes from 27 operations to 49: the `beneficiaries` and `usage` families are added. With
them, the SDK covers all the machine-to-machine operations of its five families.

### Added

- `client.beneficiaries`: register, list, change and archive beneficiary accounts; resolve an account
  in your own list (`lookup`); export as CSV and XLSX; and the bulk import as a cycle (`importTemplate`,
  `importStart`, `importStatus`, `importPreview`, `iterImportPreview`, `importEditRow`,
  `importRemoveRow`, `importCommit`, `importCancel` and `importWait`).
- `client.usage`: plan quota (`summary`), monthly history (`history`), breakdown by operation
  (`breakdown`), rate limits (`limits`), heat map (`heatmap`), API metrics (`apiUsage`) and its export
  (`export`).
- The types of the responses and the arguments of both families, taken from the spec.
- `isImportSettled()` and `isImportTerminal()`: the condition `importWait()` waits for (`preview_ready`
  or a final state).
- `multipart/form-data` file upload in the transport, with no runtime dependencies, and repeated query
  parameters for the `buckets` filter of the preview.
- `test/operations.test.ts` covers the 49 operations, with their multipart bodies.

### Changed

- `TimeoutError` exposes `resourceId`, the resource that was awaited, because `waitFor()` and
  `importWait()` now throw it. `validationId` stays available as an alias.

## [0.2.0] - 2026-09-18

The surface goes from 3 operations to 27: the `validations`, `webhooks` and `catalog` families.

### Added

- `client.validations`: validation by image (`validateOcr`), asynchronous mode (`enqueue`,
  `enqueueOcr`) with `ETag` polling (`waitFor`), paginated listing (`list`, `iter`), statistics, export
  as CSV and XLSX, receipt image, retry attempts, change of the retry policy, cancellation, removal
  from the history and sending the receipt to Telegram.
- `client.webhooks`: register, list, change and remove endpoints; test event; secret rotation; paginated
  delivery history (`deliveries`, `iterDeliveries`) and its export.
- `client.catalog`: SPEI bank catalog, issuing bank of a card and Banxico service status with its time
  series.
- `Page<T>` and the iterators `iter()` and `iterDeliveries()`, which are `AsyncIterable` and request the
  next page only when the previous one runs out.
- `isSettled()`: tells a settled verdict from a terminal one that can still change because retries are in
  progress. It is what `waitFor()` waits for.
- `TimeoutError`, which `waitFor()` throws when it runs out of time.
- The types of the responses and the arguments of the three families, taken from the spec, and
  `operations` re-exported next to `components` and `paths`.
- `OcrValidationRequest`, written by hand for the same `anyOf` that affects `ValidationRequest`, with
  its test in `test/spec.test.ts`.
- `test/operations.test.ts`: checks every operation against the spec (method, route, parameters, headers
  and body fields), requires it to be machine-to-machine (it accepts the API key or is public) and
  checks that the spec families carry no such operation without a method.
- The example `examples/async-and-webhooks.mjs`.

### Changed

- `validateTransfer()`, `getValidation()` and `getCep()` stay on the client root and behave the same:
  they now delegate to the matching family.
- `getValidation()` accepts `ifNoneMatch`, and the validation it returns carries the `etag` of the
  response.
- `CepDocument` extends `DownloadedFile`, the type of any file the API returns.
- A successful response that is not JSON, or that carries no `data`, is thrown as `ApiError`. Before, it
  was a `SyntaxError` or a `ConfigurationError`.
- `VERSION` is compared with `package.json` in the tests.

## [0.1.0] - 2026-09-18

First version of the official JavaScript and TypeScript SDK.

### Added

- `Veriko.validateTransfer()`: validates a SPEI transfer against the Banxico CEP (`POST /v1/validate`),
  with the retry policy of the API (`retryPolicy`) and the `Idempotency-Key` header.
- `Veriko.getValidation()`: reads a validation by its identifier, with the state of the retry cycle.
- `Veriko.getCep()`: downloads the official receipt as XML or PDF.
- `verifyWebhook()` and `parseWebhook()`: HMAC-SHA256 verification of the signature of a delivery, with
  constant-time comparison.
- Automatic retries of `5xx`, `408` and `429`, with exponential backoff and respect for the
  `Retry-After` of the response.
- An error hierarchy by HTTP status, with the `code` of the API, the full `errors` array and the
  `requestId`.
- Types generated from the public OpenAPI spec (`spec/openapi.yaml`, a copy of
  `docs.veriko.mx/openapi.yaml`), versioned in `src/generated/openapi.ts`, and re-exported as
  `components` and `paths`.
- Dual ESM and CommonJS distribution, with no runtime dependencies. Node 18 or later.
- Examples for Node (`examples/validate.mjs`) and for an Express webhook
  (`examples/express-webhook.mjs`).
