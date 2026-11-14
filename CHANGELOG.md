# Registro de cambios

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versiones según [SemVer](https://semver.org/lang/es/).

## [0.6.1] - 2026-11-14

### Cambiado

- El README, el registro de cambios, la guía de contribución y la ficha del paquete en npm están en
  español. La API, los nombres y el comportamiento no cambian.

## [0.6.0] - 2026-11-13

### Añadido

- `beneficiaries.validateAccount({ account, type })`: comprueba un número de cuenta sin guardarlo
  (tipo, longitud, dígito verificador y banco). Devuelve `AccountValidation`.
- `validateOcr()`, `enqueueOcr()` y `validations.validateOcr()` aceptan `recipientIsBank`.
- `userAgentPrefix`: el producto que envuelve al SDK va antes de su token, igual que en el servidor MCP.
- `buildUserAgent()` devuelve la cabecera que envía el cliente.
- Opciones por llamada como último argumento de todos los métodos: `signal`, `timeoutMs`,
  `maxRetries`, `idempotencyKey`, `headers`, `acceptLanguage` y `onResponse`. `Authorization` no se
  puede sustituir mediante `headers`.
- `ApiPromise`: todos los métodos devuelven una `Promise` que además ofrece `.withResponse()`, que
  se resuelve en `{ data, response }`. `ResponseMeta` trae `status`, `headers`, `requestId`,
  `apiVersion`, `meta`, `rateLimit`, `quota`, `replayed`, `etag`, `location`, `retryAfter`,
  `deprecation`, `sunset`, `link` y `attempts`.
- Las opciones de cliente `onResponse` y `onDeprecation`. Sin un manejador `onDeprecation`, una
  respuesta con `Deprecation` o `Sunset` emite un aviso de proceso (`VERIKO_API_DEPRECATION`) por
  endpoint.
- Las clases de error `NotModifiedError` (`304`), `GoneError` (`410`), `PayloadTooLargeError` (`413`,
  subclase de `InvalidRequestError`), `QuotaExceededError` (subclase de `RateLimitError`),
  `RequestTimeoutError` (subclase de `ConnectionError`) y `RequestAbortedError`.
- `ApiError` expone `hint`, `docsUrl`, `pointer`, `codes`, `hasCode()`, `validationId`, `retryAfter` y
  `local`, junto a la lista completa `errors`. `RateLimitError` añade `kind`, `limit`, `remaining` y
  `resetAt`, y `ConflictError` añade `inProgress`. `ConnectionError` añade `attempts`.
- `ERROR_CODES` e `IDEMPOTENCY_KEY_PATTERN`.
- `validations.validateAndWait()` y `validations.validateOcrAndWait()`. `validate()` y
  `validateOcr()` devuelven `ValidationResult`, cuyo campo `queued` trae el acuse `202`
  (`asyncReason`, `nextPollAfterSeconds`, `expiresAt`, `etag`, `location`).
- `finance.waitForCepExport()`, `CEP_EXPORT_TERMINAL_STATUSES` e `isCepExportTerminal()`.
- `webhooks.regenerateSecret(id, { immediate })`. Con `immediate: true`, el secreto anterior deja de
  valer de inmediato.
- `OLD_SIGNATURE_HEADER`, `oldSignatureFromHeaders()` y `verifyWebhookHeaders()`. `parseWebhook()` y
  las funciones de verificación aceptan una lista de secretos, para una rotación. `parseWebhook()`
  acepta además las cabeceras de la petición en lugar del valor de la firma, y verifica la firma con
  marca de tiempo y `X-Webhook-Signature-Old` dentro de la ventana de tolerancia.
- `WebhookEvent.rawData`: el `data` del cuerpo en los eventos que no son de una validación.
- `DownloadedFile.headers` y `Page.meta`.
- Variantes `*Stream()` de las descargas grandes, que se resuelven en un `DownloadedStream` (un
  `ReadableStream` web con `contentType`, `filename`, `contentLength` y `headers`) y no guardan el
  cuerpo en memoria: `validations.cepStream()`, `validations.imageStream()`,
  `validations.exportStream()`, `webhooks.exportDeliveriesStream()`, `beneficiaries.exportStream()`,
  `beneficiaries.importTemplateStream()`, `usage.exportStream()`, `finance.statementStream()`,
  `finance.reportStream()`, `finance.cepsStream()` y `finance.downloadCepExportStream()`. Los métodos
  que devuelven el cuerpo completo no cambian.
- `WebhookEvent` es una unión discriminada por `event`: `ValidationWebhookEvent`,
  `ValidationReturnedWebhookEvent` (con `attributes.payment_status` tipado), `BillingWebhookEvent` y
  `TestWebhookEvent`. `parseWebhook()` devuelve `WebhookEvent` o `UnknownWebhookEvent`, e
  `isKnownWebhookEvent()` los distingue. `VALIDATION_WEBHOOK_EVENTS` y `BILLING_WEBHOOK_EVENTS` listan
  los nombres.
- `verifyDelivery()`, que comprueba una entrega a partir de sus cabeceras y acepta
  `requireTimestamp`, y `attemptTimestamp()`. El evento interpretado trae `deliveryId` y
  `attemptTimestamp`, y toma el nombre del evento de `X-Veriko-Event` cuando el cuerpo no lo trae. La
  búsqueda de cabeceras acepta la grafía CGI (`HTTP_X_WEBHOOK_SIGNATURE`).
- Las opciones de reintento `maxRetryAfterMs` (60 segundos) y `maxInProgressWaitMs` (120 segundos).

### Cambiado

- Los argumentos de `validateTransfer()`, `validations.validate()`, `validateOcr()`, `enqueue()` y
  `enqueueOcr()` usan los nombres en inglés de la API: `sendDate`, `amount`, `trackingKey`,
  `numericReference`, `senderBank`, `receiverBank`, `beneficiaryAccount`, `candidateAccounts` y
  `recipientIsBank`. El cuerpo sale siempre con los nombres en inglés (`send_date`, `amount`, etcétera).
- `recipientIsBank` es booleano y se envía como booleano. `0` y `1` se siguen aceptando, y el SDK los
  convierte.
- Las respuestas exponen los nombres en inglés (`request_data`, `ocr_result`, `normalized_data`,
  `confidence_by_field`, los listados, el resumen de finanzas y las cuentas detectadas). Si la API
  envía sólo un nombre de una versión anterior, el SDK completa el nombre actual con el mismo valor.
- El `User-Agent` pasa a ser `veriko-sdk-js/<versión> (<entorno> <versión>; <sistema> <arquitectura>)`,
  por ejemplo `veriko-sdk-js/0.6.0 (node 22.11.0; linux x64)`. El entorno es `node`, `deno` o `bun`. No
  lleva ningún otro dato de la máquina. `userAgentSuffix` se sigue añadiendo al final.
- Un `POST` se reintenta sólo cuando lleva un `Idempotency-Key`. Las seis operaciones que aceptan la
  cabecera generan una cuando quien llama no da ninguna: `validate()`, `validateOcr()` (y por tanto
  `enqueue()` y `enqueueOcr()`), `setRetryPolicy()`, `cancelRetries()`,
  `account.updateMyRetryPolicy()` y `finance.createCepExport()`.
- Un `409` con `idempotency_key_in_progress` espera el `Retry-After` (o la espera creciente) y repite
  la petición con la misma clave, hasta `maxInProgressWaitMs` de espera acumulada.
- `Retry-After` se respeta completo. Cuando es mayor que `maxRetryAfterMs`, la llamada lanza el error
  tipado con `retryAfter` establecido, y no espera.
- `waitFor()` hace una pausa al menos tan larga como piden `Retry-After` o
  `meta.next_poll_after_seconds`, termina en el `expires_at` de la validación (con 30 segundos de
  margen) o a los cinco minutos, y envía el `ETag` del acuse en su primera consulta. Acepta las
  opciones de llamada.
- `isSettled()` mantiene abierta la consulta sólo para los resultados que la política de reintentos
  repite (`not_found`, `cep_unavailable` y `error`).
- Los errores que el SDK lanza antes de enviar una petición usan los códigos en inglés de la API
  (`tracking_key_or_reference_required`, `account_required`,
  `account_and_candidates_mutually_exclusive`, `candidate_accounts_invalid`,
  `image_or_image_url_required`, `invalid_amount`, `invalid_idempotency_key`) y fijan `local: true`.
- La consulta de la vista previa envía el filtro `buckets` como `buckets[]`, que es la forma que lee
  la API.
- El intérprete de Content-Disposition lee `filename*` (RFC 6266) y los nombres entre comillas que
  contienen `;`.
- `ValidationFilters.status` se tipa con `ValidationStatus`, y los campos de tarjeta de
  `AccountValidation` aceptan `null`.
- `WebhookEvent` es una unión y ya no una interfaz con `event: string`. El código que lee `event.data`
  sigue compilando; en los eventos `billing.*` y `test`, `data` es `undefined` y el cuerpo está en
  `rawData`. Un evento de validación sin el recurso de la validación, o un `validation.returned` sin
  `payment_status`, llega como `UnknownWebhookEvent`.

### Obsoleto

Los nombres de campo de versiones anteriores siguen funcionando para las integraciones existentes y
emiten un aviso de obsolescencia. No forman parte de la API tipada y una versión futura los quitará.
Enviar un nombre anterior junto con su nombre actual lanza `InvalidRequestError`
(`alias_conflict`).

### Corregido

- El tiempo de espera predeterminado pasa de 30 a 60 segundos: la API puede tardar hasta 45 segundos
  en una validación síncrona antes de responder `202`, y con 30 el SDK abandonaba la petición antes.
  `timeoutMs` se sigue fijando por cliente.
- `quota_exceeded` ya no se reintenta aunque llegue con `429`: la cuota del plan no se repone en
  segundos, así que el error se lanza de inmediato. `rate_limit_exceeded` se sigue reintentando.
- `WEBHOOK_EVENTS` coincide con los tipos de evento del contrato: se quita `validation_import.completed`,
  que no existe, y se añaden `billing.payment_succeeded`, `billing.payment_failed`,
  `billing.trial_will_end`, `billing.subscription_canceled` y `billing.invoice_upcoming`.
- `Webhooks.deliveries()` y sus variantes lanzan `ConfigurationError` cuando el filtro de endpoint
  trae más de 20 endpoints, porque la API acepta 20 como máximo.
- `amount` rechaza `NaN`, un valor vacío y una cadena no numérica con `invalid_amount`.
- La comparación de firmas corre en tiempo constante y funciona con entradas no ASCII.
- La lectura de `process.env` está protegida, así que el cliente carga en entornos que no tienen
  `process`.
- Las importaciones suben un archivo `.json` con su propio tipo de contenido.

## [0.5.4] - 2026-11-09

### Cambiado

- Los tipos traen `attributes.account_cross_checked` en `Validation`: vale `true` cuando la cuenta consultada en Banxico es
  del propio cliente. Con `false`, un `valid` confirma que la transferencia existe, pero no que se pagó a la
  cuenta esperada. También traen `meta.async_reason` en el acuse `202`.
- `validateTransfer()` y `validateOcr()` documentan que la API responde `202` en `processing` cuando la
  consulta a Banxico pasa de 45 segundos; el veredicto se recoge con `get()`.
- `amount` documenta el tope de 13 dígitos enteros.

## [0.5.3] - 2026-11-08

### Cambiado

- Una operación autenticada comprueba la forma de la clave de API antes de enviar la petición. Si la clave
  no es `veriko_` seguida de 64 caracteres hexadecimales en minúscula, lanza `ConfigurationError` y no sale
  a la red. El mensaje del error no incluye la clave.

## [0.5.2] - 2026-11-08

### Cambiado

- `sendDate` es opcional en `validateTransfer()`, `validations.validate()` y `ValidationRequest`.
  Si falta o no es utilizable, la API prueba fechas candidatas contra
  Banxico; sólo rechaza con `422` (`send_date_required`) cuando no tiene datos para adivinarla.

## [0.5.1] - 2026-11-06

### Añadido

- Exportaciones de CEP en segundo plano, para rangos que no conviene descargar en una sola petición:
  `finance.createCepExport()` pide el ZIP de un rango y devuelve la exportación en `queued`;
  `finance.listCepExports()` lista las recientes; `finance.getCepExport()` consulta su estado, que es
  terminal en `ready`, `failed` o `expired`; y `finance.downloadCepExport()` descarga el ZIP cuando está
  en `ready`. Los tipos son `FinanceCepExport` y `FinanceCepExportParams`.
- `WebhookEndpoint.previous_secret_expires_at`: hasta cuándo se acepta la firma con el secreto anterior
  después de `webhooks.regenerateSecret()`.
- `Validation.error_message` y `WebhookDelivery.error_message`: el motivo legible cuando la validación no
  se confirmó.

## [0.5.0] - 2026-10-27

### Cambiado

- `account.myProfile()` sigue el contrato público de la API. `UserProfile` ya no incluye `role`, y
  `permissions` lista los permisos efectivos con claves como `validations.records.read` en lugar de
  pares `resource:action`. Si tu integración leía `role`, usa `roles`.

### Añadido

- `UserProfile.platform_access`: `true` cuando la cuenta puede entrar al panel de administración.
- `UserProfile.roles`: los roles vigentes de la cuenta, cada uno con `key`, `scope_type` (`platform` u
  `organization`) y `scope_id`.

## [0.4.14] - 2026-10-15

### Añadido

- `beneficiaries.create()` devuelve `CreatedBeneficiary`, con `reactivated`: `true` cuando el alta reactivó una
  cuenta archivada con el mismo número (la API responde `200` con `meta.reactivated`) y `false` en un alta
  nueva.

## [0.4.13] - 2026-10-15

### Añadido

- `catalog.speiCalendar()` (`GET /v1/public/spei-calendar/{year}`): el calendario de días inhábiles
  SPEI de un año. Devuelve `SpeiCalendar`, con `non_business_days` y `source` en `attributes` y los
  años con calendario en `coveredYears`. Admite `ifNoneMatch`, y su `ETag` queda en `etag`. No
  consume cuota. Un año sin calendario se lanza como `NotFoundError` con
  `spei_calendar_year_not_covered`.
- `validations.validateOcr()` y `validations.enqueueOcr()` aceptan `senderBank` y `receiverBank`:
  la clave SPEI de 4 o 5 dígitos sustituye al banco leído del comprobante antes de consultar a
  Banxico.
- `validations.list()`, `validations.stats()` y `validations.export()` aceptan `banks`, hasta 50
  claves SPEI en lista o separadas por comas; filtra por banco emisor o receptor.
- `webhooks.deliveries()`, `webhooks.iterDeliveries()` y `webhooks.exportDeliveries()` aceptan
  `responseStatus`, `validationId`, `q`, `from`, `to`, `minAttempt` y `minResponseTimeMs`.
  `status`, `eventType` y `responseStatus` admiten una lista, y el endpoint una lista de hasta 20.
  Nuevo tipo `DeliveryFilters`.

## [0.4.12] - 2026-10-02

### Añadido

- `validations.recheck()` (`POST /v1/validations/{id}/recheck`): vuelve a consultar a Banxico el
  estado de pago de una validación `valid` creada hace 72 horas como máximo, sin consumir cuota.
  Devuelve `RecheckResult` con la validación y con `checkedAt`, `changed` y `previousStatus`. Si
  Banxico reporta la devolución, la validación pasa a `returned`. No se reintenta sola.
- `validations.preparePurge()` y `validations.executePurge()`: el borrado definitivo de una
  validación, en dos pasos. Devuelven `PurgePreparation` y `PurgeResult`. `executePurge()` no se
  reintenta sola. Los tipos de `Validation` añaden `purged_at`.
- `candidateAccounts` en `validateTransfer()`, `validations.validate()`, `validations.validateOcr()`,
  `validations.enqueue()` y `validations.enqueueOcr()`: de 2 a 3 cuentas en una sola validación y con
  una sola unidad de cuota. Los tipos de `Validation` añaden `candidate_match`, con la posición y los
  últimos 4 dígitos de la cuenta que coincidió.
- `retainImage` en `validations.validateOcr()` y `validations.enqueueOcr()`, y `image_retained` en los
  tipos de `Validation`: con `retainImage: false` la plataforma no conserva el archivo del
  comprobante.
- El evento `validation.returned` en `WEBHOOK_EVENTS`, que avisa cuando una validación `valid` pasa
  después a `returned`, y `payment_status` (`PaymentStatus`) en `event.data.attributes`.

### Cambiado

- `beneficiaryAccount` deja de ser obligatoria cuando se envía `candidateAccounts`. Sin ninguna de
  las dos, el SDK lanza `InvalidRequestError` con `account_required`, y con las dos, con
  `account_and_candidates_mutually_exclusive`. En los dos casos no llama a la API.

## [0.4.11] - 2026-10-01

### Añadido

- `clientRef` en `validateTransfer()`, `validations.validate()`, `validations.validateOcr()`,
  `validations.enqueue()` y `validations.enqueueOcr()`: una referencia propia de 1 a 64 caracteres
  que vuelve en `attributes.client_ref`.
- El filtro `clientRef`, de coincidencia exacta, en `validations.list()`, `validations.iter()`,
  `validations.stats()` y `validations.export()`.
- Los tipos de `Validation` añaden `client_ref`, `duplicate_of` y `account_conflict`.
- `verifyWebhookTimestamped()` comprueba la cabecera `X-Webhook-Signature-Timestamped`
  (`t=<segundos>,v1=<hex>`): compara en tiempo constante el HMAC-SHA256 de `<t>.<cuerpo>` con cada
  `v1` y rechaza la entrega cuando `t` se aleja del reloj más de `toleranceSeconds`, 300 por
  omisión. `timestampedSignatureFromHeaders()` encuentra la cabecera en cualquiera de sus grafías.
  `verifyWebhook()` no cambia.
- `parseWebhook()` entrega el `client_ref` en `event.data.attributes` cuando el webhook de
  validación lo trae.

### Cambiado

- `beneficiaryAccount` es obligatoria en `validateTransfer()`, `validations.validate()` y
  `validations.enqueue()`. Sin ella, el SDK lanza `InvalidRequestError` con `account_required` y no
  llama a la API.

## [0.4.10] - 2026-09-29

### Cambiado

- Los tipos documentan los códigos por campo con que el `422` de la validación rechaza, antes de
  consultar a Banxico, una petición cuyos datos se contradicen. Llegan en `errors[].code` de
  `InvalidRequestError`. Ningún rechazo `preflight_failed` de esa ruta consume cuota, sea por datos
  que se contradicen o por un campo mal formado.

## [0.4.9] - 2026-09-28

### Añadido

- Los tipos de `usage.summary()` y `billing.getSubscription()` añaden `quota_kind` (`cycle` o
  `trial`) y `renews`: una cuenta que aún no activa el plan gratuito consume validaciones de
  prueba, que no se reponen. `account.myProfile()` añade `plan_name` a la suscripción.

## [0.4.8] - 2026-09-27

### Cambiado

- `validations.validateOcr()` y `validations.enqueueOcr()` documentan el comprobante en PDF, de 1 a
  3 páginas.
- `validations.image()` acepta un comprobante en PDF y lo nombra con la extensión `.pdf`.

## [0.4.7] - 2026-09-26

### Añadido

- El webhook de validación trae `data.attributes.banxico_confirmed` cuando
  Banxico ya confirmó el pago: monto, fecha, clave de rastreo, ambos bancos y
  la cuenta del beneficiario enmascarada.

## [0.4.6] - 2026-09-24

### Cambiado

- Las respuestas `429` declaran `meta.retry_after`, con el mismo valor que la cabecera
  `Retry-After`.
- Los tipos documentan los códigos de error de validación y de filtros: `invalid_bank_code`, `intra_bank_no_cep`, `invalid_field_type`,
  `invalid_filter` y `webhook_description_too_long`.

## [0.4.0] - 2026-09-19

### Añadido

- Las 18 operaciones M2M que faltaban: perfil y política de reintentos de cuenta,
  resumen del panel, planes públicos, insights, finanzas y suscripción. Los planes
  públicos se solicitan sin cabecera `Authorization`.

### Cambiado

- `validateAccount()` deja de formar parte del SDK: su operación ya no es M2M
  pública. En `0.x` esta retirada es incompatible.
- Los reportes mensuales, por contraparte, por banco y contables usan `csv` por
  omisión, igual que el contrato público. `preview` se solicita explícitamente.

## [0.3.0] - 2026-09-18

La superficie pasa de 27 operaciones a 49: se suman las familias `beneficiaries` y
`usage`. Con ellas, el SDK cubre todas las operaciones de máquina a máquina de sus
cinco familias.

### Añadido

- `client.beneficiaries`: registrar, listar, cambiar y archivar cuentas beneficiarias;
  resolución de una cuenta en la lista propia (`lookup`); exportación en CSV y XLSX; y la
  importación masiva como ciclo (`importTemplate`, `importStart`, `importStatus`,
  `importPreview`, `iterImportPreview`, `importEditRow`, `importRemoveRow`,
  `importCommit`, `importCancel` e `importWait`).
- `client.usage`: cuota del plan (`summary`), historial mensual (`history`), desglose por
  operación (`breakdown`), límites de tasa (`limits`), mapa de calor (`heatmap`),
  métricas de la API (`apiUsage`) y su exportación (`export`).
- Los tipos de las respuestas y de los argumentos de las dos familias.
- `isImportSettled()` e `isImportTerminal()`: la condición que espera `importWait()`
  (`preview_ready` o un estado final).
- Subida de archivos `multipart/form-data` en el transporte, sin dependencias de runtime, y
  parámetros de consulta repetidos para el filtro `buckets` de la vista previa.

### Cambiado

- `TimeoutError` expone `resourceId`, el recurso que se esperaba, porque ahora lo lanzan
  `waitFor()` y `importWait()`. `validationId` sigue disponible como alias.

## [0.2.0] - 2026-09-18

La superficie pasa de 3 operaciones a 27: las familias `validations`, `webhooks`
y `catalog`.

### Añadido

- `client.validations`: validación por imagen (`validateOcr`), modo asíncrono
  (`enqueue`, `enqueueOcr`) con sondeo por `ETag` (`waitFor`), listado con
  paginación (`list`, `iter`), estadísticas, exportación en CSV y XLSX, imagen
  del comprobante, intentos de reintento, cambio de la política de reintentos,
  cancelación, retirada del historial y envío del comprobante a Telegram.
- `client.webhooks`: registrar, listar, cambiar y retirar endpoints; evento de
  prueba; rotación del secreto; historial de entregas con paginación
  (`deliveries`, `iterDeliveries`) y su exportación.
- `client.catalog`: catálogo de bancos SPEI, banco emisor de una tarjeta y
  estado del servicio de Banxico con su serie temporal.
- `Page<T>` y los iteradores `iter()` e `iterDeliveries()`, que son
  `AsyncIterable` y piden la página siguiente sólo cuando la anterior se agota.
- `isSettled()`: distingue un veredicto firme de uno terminal que todavía puede
  cambiar porque hay reintentos en marcha. Es lo que espera `waitFor()`.
- `TimeoutError`, que `waitFor()` lanza al agotar su tiempo.
- Los tipos de las respuestas y de los argumentos de las tres familias, y `operations`
  reexportado junto a `components` y `paths`.

### Cambiado

- `validateTransfer()`, `getValidation()` y `getCep()` siguen en la raíz del
  cliente y se comportan igual: ahora delegan en la familia correspondiente.
- `getValidation()` admite `ifNoneMatch`, y la validación que devuelve trae el
  `etag` de la respuesta.
- `CepDocument` extiende `DownloadedFile`, el tipo de cualquier archivo que
  devuelve la API.
- Una respuesta correcta que no es JSON, o que no trae `data`, se lanza como
  `ApiError`. Antes era un `SyntaxError` o un `ConfigurationError`.

## [0.1.0] - 2026-09-18

Primera versión del SDK oficial de JavaScript y TypeScript.

### Añadido

- `Veriko.validateTransfer()`: valida una transferencia SPEI contra el CEP de
  Banxico (`POST /v1/validate`), con la política de reintentos de la API
  (`retryPolicy`) y la cabecera `Idempotency-Key`.
- `Veriko.getValidation()`: lee una validación por su identificador, con el
  estado del ciclo de reintentos.
- `Veriko.getCep()`: descarga el comprobante oficial en XML o en PDF.
- `verifyWebhook()` y `parseWebhook()`: verificación HMAC-SHA256 de la firma de
  una entrega, con comparación en tiempo constante.
- Reintentos automáticos de los `5xx`, el `408` y el `429`, con espera
  exponencial y respeto del `Retry-After` de la respuesta.
- Jerarquía de errores por estado HTTP, con el `code` de la API, el arreglo
  completo de `errors` y el `requestId`.
- Tipos del spec público de OpenAPI, reexportados como `components` y `paths`.
- Distribución dual ESM y CommonJS, sin dependencias de runtime. Node 18 o
  superior.
