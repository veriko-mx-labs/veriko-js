# Registro de cambios

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versiones según [SemVer](https://semver.org/lang/es/).

## [No publicado]

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
  `ValidationRequest`, con su candado en `test/spec.test.ts`.
- `test/operations.test.ts`: contrasta cada operación con el spec (método, ruta,
  parámetros, cabeceras y campos del cuerpo) y comprueba que las familias del
  spec no traigan operaciones sin método.
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

### Pendiente para versiones siguientes

- Beneficiarios, con su importación masiva.
- Métricas de consumo.

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

### Pendiente para versiones siguientes

- Modo asíncrono (`?async=1`) y sondeo con `ETag`.
- Validación por OCR de una imagen de comprobante.
- Beneficiarios, importación masiva y finanzas.

[No publicado]: https://github.com/veriko-mx-labs/veriko-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/veriko-mx-labs/veriko-js/releases/tag/v0.2.0
[0.1.0]: https://github.com/veriko-mx-labs/veriko-js/releases/tag/v0.1.0
