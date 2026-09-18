# Registro de cambios

Formato de [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versiones según [SemVer](https://semver.org/lang/es/).

## [No publicado]

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

[No publicado]: https://github.com/veriko-mx-labs/veriko-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/veriko-mx-labs/veriko-js/releases/tag/v0.1.0
