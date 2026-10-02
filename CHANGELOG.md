# Registro de cambios

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versiones según [SemVer](https://semver.org/lang/es/).

## [No publicado]

Sin cambios todavía.

## [0.4.12] — 2026-10-02

### Añadido

- `validations.recheck()` (`POST /v1/validations/{id}/recheck`): vuelve a consultar a Banxico el
  estado de pago de una validación `valid` creada hace 72 horas como máximo, sin consumir cuota.
  Devuelve `RecheckResult` con la validación y con `checkedAt`, `changed` y `previousStatus`. Si
  Banxico reporta la devolución, la validación pasa a `returned`. No se reintenta sola.
- `validations.preparePurge()` y `validations.executePurge()`: el borrado definitivo de una
  validación, en dos pasos. Devuelven `PurgePreparation` y `PurgeResult`. `executePurge()` no se
  reintenta sola. Los tipos de `Validation` añaden `purged_at`.
- `cuentasCandidatas` en `validateTransfer()`, `validations.validate()`, `validations.validateOcr()`,
  `validations.enqueue()` y `validations.enqueueOcr()`: de 2 a 3 cuentas en una sola validación y con
  una sola unidad de cuota. Los tipos de `Validation` añaden `candidate_match`, con la posición y los
  últimos 4 dígitos de la cuenta que coincidió.
- `retainImage` en `validations.validateOcr()` y `validations.enqueueOcr()`, y `image_retained` en los
  tipos de `Validation`: con `retainImage: false` la plataforma no conserva el archivo del
  comprobante.
- El evento `validation.returned` en `WEBHOOK_EVENTS`, que avisa cuando una validación `valid` pasa
  después a `returned`, y `payment_status` (`PaymentStatus`) en `evento.data.attributes`.

### Cambiado

- `cuentaBeneficiaria` deja de ser obligatoria cuando se envía `cuentasCandidatas`. Sin ninguna de
  las dos, el SDK lanza `InvalidRequestError` con `cuenta_required`, y con las dos, con
  `cuenta_y_candidatas_excluyentes`. En los dos casos no llama a la API.

## [0.4.11] — 2026-10-01

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
- `parseWebhook()` entrega el `client_ref` en `evento.data.attributes` cuando el webhook de
  validación lo trae.

### Cambiado

- `cuentaBeneficiaria` es obligatoria en `validateTransfer()`, `validations.validate()` y
  `validations.enqueue()`. Sin ella, el SDK lanza `InvalidRequestError` con `cuenta_required` y no
  llama a la API.

## [0.4.10] — 2026-09-29

### Cambiado

- Las descripciones de los tipos documentan los códigos por campo con que el `422` de la
  validación rechaza una petición cuyos datos se contradicen, antes de consultar a Banxico:
  `clabe_receptor_mismatch`, `tarjeta_receptor_mismatch` y `clave_longitud_invalida`. Llegan en
  `errors[].code` de `InvalidRequestError`. Ningún rechazo `preflight_failed` de esa ruta consume
  cuota, sea por datos que se contradicen o por un campo mal formado.

## [0.4.9] — 2026-09-28

### Añadido

- Los tipos de `usage.summary()` y `billing.getSubscription()` añaden `quota_kind` (`cycle` o
  `trial`) y `renews`: una cuenta que aún no activa el plan gratuito consume validaciones de
  prueba, que no se reponen. `account.myProfile()` añade `plan_name` a la suscripción.

## [0.4.8] — 2026-09-27

### Cambiado

- `validations.validateOcr()` y `validations.enqueueOcr()` documentan el comprobante en PDF, de 1 a
  3 páginas.
- `validations.image()` acepta un comprobante en PDF y lo nombra con la extensión `.pdf`.

## [0.4.7] — 2026-09-26

### Añadido

- El webhook de validación trae `data.attributes.banxico_confirmed` cuando
  Banxico ya confirmó el pago: monto, fecha, clave de rastreo, ambos bancos y
  la cuenta del beneficiario enmascarada.

## [0.4.6] — 2026-09-24

### Cambiado

- Los tipos siguen la versión 1.60.0 del spec público. Las respuestas `429`
  declaran `meta.retry_after`, con el mismo valor que la cabecera `Retry-After`.
- Las descripciones de los tipos documentan los códigos de error de validación y
  de filtros: `invalid_bank_code`, `intra_bank_no_cep`, `invalid_field_type`,
  `invalid_filter` y `webhook_description_too_long`.

## [0.4.5] — 2026-09-22

Sin cambios en la API. Actualiza documentación y metadatos.

## [0.4.4] — 2026-09-20

Sin cambios de superficie.

## [0.4.3] — 2026-09-20

Sin cambios de superficie.

## [0.4.0] — 2026-09-19

### Añadido

- Las 18 operaciones M2M que faltaban: perfil y política de reintentos de cuenta,
  resumen del panel, planes públicos, insights, finanzas y suscripción. Los planes
  públicos se solicitan sin cabecera `Authorization`.
- La prueba de superficie compara las 66 operaciones completas del spec público y
  ejercita rutas contra grabaciones sanitizadas en un servidor HTTP local.

### Cambiado

- `validateAccount()` deja de formar parte del SDK: su operación ya no es M2M
  pública. En `0.x` esta retirada es incompatible.
- Los reportes mensuales, por contraparte, por banco y contables usan `csv` por
  omisión, igual que el contrato público. `preview` se solicita explícitamente.

## [0.3.0] — 2026-09-18

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
- Los tipos de las respuestas y de los argumentos de las dos familias, tomados del spec.
- `isImportSettled()` e `isImportTerminal()`: la condición que espera `importWait()`
  (`preview_ready` o un estado final).
- Subida de archivos `multipart/form-data` en el transporte, sin dependencias de runtime, y
  parámetros de consulta repetidos para el filtro `buckets` de la vista previa.
- `test/operations.test.ts` cubre las 49 operaciones, con sus cuerpos multipart.

### Cambiado

- `TimeoutError` expone `resourceId`, el recurso que se esperaba, porque ahora lo lanzan
  `waitFor()` y `importWait()`. `validationId` sigue disponible como alias.

## [0.2.0] — 2026-09-18

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
- Los tipos de las respuestas y de los argumentos de las tres familias, tomados
  del spec, y `operations` reexportado junto a `components` y `paths`.
- `OcrValidationRequest`, escrito a mano por el mismo `anyOf` que afecta a
  `ValidationRequest`, con su prueba en `test/spec.test.ts`.
- `test/operations.test.ts`: contrasta cada operación con el spec (método, ruta,
  parámetros, cabeceras y campos del cuerpo), exige que sea de máquina a máquina
  (que acepte la clave de API o sea pública) y comprueba que las familias del
  spec no traigan operaciones así sin método.
- El ejemplo `examples/async-and-webhooks.mjs`.

### Cambiado

- `validateTransfer()`, `getValidation()` y `getCep()` siguen en la raíz del
  cliente y se comportan igual: ahora delegan en la familia correspondiente.
- `getValidation()` admite `ifNoneMatch`, y la validación que devuelve trae el
  `etag` de la respuesta.
- `CepDocument` extiende `DownloadedFile`, el tipo de cualquier archivo que
  devuelve la API.
- Una respuesta correcta que no es JSON, o que no trae `data`, se lanza como
  `ApiError`. Antes era un `SyntaxError` o un `ConfigurationError`.
- `VERSION` se compara con `package.json` en las pruebas.

## [0.1.0] — 2026-09-18

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
- Tipos generados del spec público de OpenAPI (`spec/openapi.yaml`, copia de
  `docs.veriko.mx/openapi.yaml`), versionados en `src/generated/openapi.ts`, y
  reexportados como `components` y `paths`.
- Distribución dual ESM y CommonJS, sin dependencias de runtime. Node 18 o
  superior.
- Ejemplos para Node (`examples/validate.mjs`) y para un webhook en Express
  (`examples/express-webhook.mjs`).
