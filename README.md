# @veriko/sdk · SDK de JavaScript y TypeScript para la API del CEP

Cliente oficial de [Veriko](https://veriko.mx) para Node. Valida transferencias SPEI mexicanas
contra el CEP de Banco de México, descarga el comprobante oficial y verifica la firma de los
webhooks.

Sin dependencias de runtime. Tipos generados del spec de OpenAPI. Node 18 o superior, en ESM y en
CommonJS.

```ts
import { Veriko } from '@veriko/sdk';

const client = new Veriko(); // lee VERIKO_API_KEY del entorno

const validation = await client.validateTransfer({
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
  cuentaBeneficiaria: '012180004412345678',
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
| `valid`           | Banxico devolvió un CEP que coincide con los datos enviados                            |
| `not_found`       | Banxico no tiene un CEP con esos datos. Puede ser temporal: un CEP tarda en publicarse |
| `cep_unavailable` | Banxico no pudo responder. No dice nada sobre la transferencia                         |
| `returned`        | El pago se liquidó y la institución beneficiaria lo devolvió después                   |
| `invalid`         | Los datos enviados no forman una consulta válida                                       |
| `error`           | Fallo durante el procesamiento; el motivo viaja en `error_code`                        |

La distinción entre `not_found` y `cep_unavailable` es la que importa al integrar: el primero es
una respuesta de Banxico sobre la transferencia, el segundo es la ausencia de respuesta.

Con veredicto `valid`, el comprobante queda disponible en XML y en PDF.

## Instalación

El paquete todavía no está publicado en npm. Mientras tanto se instala desde el repositorio:

```bash
npm install "github:veriko-mx-labs/veriko-js"
```

## Autenticación

La clave de API se obtiene en el panel ([app.veriko.mx](https://app.veriko.mx)) y empieza con
`veriko_`. El cliente la toma de la variable de entorno `VERIKO_API_KEY`:

```bash
export VERIKO_API_KEY=veriko_tu_clave_aqui
```

La opción `apiKey` la recibe directamente cuando la gestiona otro mecanismo:

```ts
const client = new Veriko({ apiKey: 'veriko_tu_clave_aqui' });
```

## Validar una transferencia

La operación exige la fecha de envío, el importe y **la clave de rastreo o la referencia
numérica**. Enviar las dos precisa la búsqueda. El banco emisor, el receptor y la cuenta
beneficiaria son opcionales y mejoran la identificación.

```ts
import { Veriko } from '@veriko/sdk';

const client = new Veriko();

const validation = await client.validateTransfer({
  fecha: '2025-03-15', // YYYY-MM-DD, la fecha de envío
  monto: 15000.5, // en pesos, con centavos
  claveRastreo: 'MXBA20250315001234',
  referenciaNumerica: '1234567',
  emisor: 'BANCO NACIONAL DE MEXICO',
  receptor: 'BBVA MEXICO',
  cuentaBeneficiaria: '012180004412345678', // CLABE, tarjeta o celular DiMo
});

if (validation.attributes.status === 'valid') {
  console.log('Pago confirmado en', validation.attributes.processing_time_ms, 'ms');
}
```

Los argumentos van en `camelCase` y viajan con el nombre que la API espera. Lo que la API devuelve
conserva el suyo (`banxico_status`, `processing_time_ms`), porque es el tipo generado del spec.

Cada llamada consume cuota del plan, y se descuenta al aceptar la petición.

## Descargar el CEP

```ts
import { writeFile } from 'node:fs/promises';
import { hasCep } from '@veriko/sdk';

if (hasCep(validation)) {
  const cep = await client.getCep(validation.id, { format: 'pdf' }); // o 'xml'
  await writeFile(cep.filename, cep.content); // CEP-<id>.pdf
}
```

`getCep()` devuelve el archivo: el XML que emitió Banxico, con su sello digital y su cadena
original, o el PDF equivalente. Cuando la validación no tiene comprobante, la API responde `404`
con `cep_not_available` y el SDK lanza `NotFoundError`.

## Verificar la firma de un webhook

Cada entrega llega firmada con HMAC-SHA256 del cuerpo, usando el secreto que devolvió
`POST /v1/webhooks` al registrar el endpoint:

```
X-Webhook-Signature: sha256=<hex>
```

Lo que se firma es el cuerpo **tal como llegó**. Interpretar el JSON y volver a serializarlo
cambia los bytes y la firma deja de cuadrar. En Express, eso significa `express.raw()` en la ruta
del webhook, no `express.json()`.

```ts
import express from 'express';
import { SignatureVerificationError, parseWebhook } from '@veriko/sdk';

const app = express();
const SECRET = process.env.VERIKO_WEBHOOK_SECRET;

app.post('/hooks/veriko', express.raw({ type: 'application/json' }), (request, response) => {
  let evento;
  try {
    evento = parseWebhook(request.body, request.get('X-Webhook-Signature'), SECRET);
  } catch (error) {
    if (error instanceof SignatureVerificationError) return response.sendStatus(400);
    throw error;
  }

  response.sendStatus(200); // responder 2xx primero, procesar después

  if (evento.event === 'validation.completed') {
    console.log(evento.data.id, evento.data.attributes.status);
  }
});
```

`verifyWebhook(payload, signature, secret)` hace la misma comprobación y devuelve `true` o `false`,
para decidir el código de respuesta aparte. La comparación es en tiempo constante.

El receptor completo está en [`examples/express-webhook.mjs`](examples/express-webhook.mjs).

### Las cuatro cabeceras de una entrega

| cabecera               | contenido                                             |
| ---------------------- | ----------------------------------------------------- |
| `X-Webhook-Signature`  | `sha256=` seguido del HMAC en hexadecimal             |
| `X-Veriko-Event`       | Tipo de evento, por ejemplo `validation.completed`    |
| `X-Veriko-Delivery-Id` | Identificador de la entrega, estable entre reintentos |
| `X-Veriko-Timestamp`   | Momento del envío, ISO 8601 con sufijo `Z`            |

El `Delivery-Id` es el valor que permite descartar entregas repetidas.

## Reintentos

Hay dos mecanismos distintos con el mismo nombre.

**Los del cliente** repiten una petición que falló por causas pasajeras. El SDK reintenta los
`5xx`, el `408` y el `429`, y respeta el `Retry-After` de la respuesta cuando lo trae. El resto de
los `4xx` no se reintenta, porque la petición hay que corregirla antes de repetirla.

```ts
const client = new Veriko({ maxRetries: 3 }); // 0 los desactiva; por omisión son 2
```

**Los de la API** siguen consultando a Banxico durante horas, porque un CEP tarda en publicarse, y
avisan por webhook cuando el veredicto cambia.

```ts
const validation = await client.validateTransfer({
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
  retryPolicy: {
    enabled: true,
    max_retries: 3,
    interval_seconds: 600, // de 300 a 86 400
    outcomes: ['not_found', 'cep_unavailable'], // qué veredictos reintentar
  },
});
```

El avance del ciclo se lee en `(await client.getValidation(id)).attributes.retry_state`, o se
espera al webhook `validation.retry.resolved`.

## Idempotencia

Reintentar un `POST` sin clave de idempotencia puede duplicar la validación, y su cargo, cuando la
respuesta se perdió pero la petición llegó. Con clave, la repetición devuelve la respuesta original
durante 24 horas.

```ts
const validation = await client.validateTransfer({
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
  idempotencyKey: 'pedido-4f3a2b1c', // el identificador del intento de negocio
});
```

La clave se deriva del intento de negocio —el número de pedido, de lote o de transacción—, no se
genera al azar en cada envío: una clave aleatoria por reintento anula la protección.

Sin `idempotencyKey`, el SDK genera una por llamada y la repite en sus propios reintentos. Esa
clave no sobrevive al proceso que la generó, así que un reenvío posterior sí se ejecuta dos veces.

## Errores

Todas las excepciones heredan de `VerikoError`. Las de la API traen `code`, que es el contrato
estable, y `detail`, que se traduce y puede reformularse entre versiones.

```ts
import { InvalidRequestError, NotFoundError, RateLimitError } from '@veriko/sdk';

try {
  const validation = await client.validateTransfer(params);
} catch (error) {
  if (error instanceof InvalidRequestError) {
    // 400, 413, 422 — un 422 trae una entrada por campo inválido
    for (const entrada of error.errors) {
      console.error(entrada.code, entrada.source?.pointer);
    }
  } else if (error instanceof RateLimitError) {
    console.error('esperar', error.retryAfter, 'segundos');
  } else if (error instanceof NotFoundError) {
    // 404
  }
}
```

| excepción                    | estado                                     |
| ---------------------------- | ------------------------------------------ |
| `AuthenticationError`        | `401`                                      |
| `ForbiddenError`             | `403`                                      |
| `NotFoundError`              | `404`                                      |
| `ConflictError`              | `409`                                      |
| `InvalidRequestError`        | `400`, `413`, `422`                        |
| `RateLimitError`             | `429`                                      |
| `ServerError`                | `5xx`                                      |
| `ConnectionError`            | Sin respuesta, con los reintentos agotados |
| `SignatureVerificationError` | La firma de un webhook no cuadra           |

Cada error de la API trae `requestId`, que identifica la petición en los registros del sistema.

## Los tipos

Los tipos de lo que viaja por el cable se generan del spec de OpenAPI y se versionan en
[`src/generated/openapi.ts`](src/generated/openapi.ts):

```bash
npm run gen:types    # openapi-typescript sobre spec/openapi.yaml
```

La copia de `spec/openapi.yaml` sale de
[docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml), que es la versión **pública**
del spec, filtrada por visibilidad. El bundle interno de la aplicación no se usa aquí, y
`npm run check:spec-public` lo comprueba en cada ejecución del CI.

Ese spec es neutral de marca por diseño de la plataforma, así que sus ejemplos citan un host
genérico. La raíz real de la API la fija el SDK en `DEFAULT_BASE_URL`.

El tipo del cuerpo de `POST /v1/validate` es la única excepción y se escribe a mano: su schema
lleva un `anyOf` que el generador traduce a `unknown`. `test/spec.test.ts` falla si el spec añade,
quita o renombra alguno de sus campos.

Además de los tipos con nombre corto, el paquete reexporta `components` y `paths` completos, por si
hace falta una operación que el SDK todavía no envuelve.

## Alcance de esta versión

`validateTransfer()`, `getValidation()`, `getCep()` y la verificación de webhooks.

Fuera del alcance por ahora: el modo asíncrono (`?async=1`) con sondeo por `ETag`, la validación
por OCR de una imagen, la importación masiva, los beneficiarios y las finanzas. Esas operaciones se
consumen con cualquier cliente HTTP contra la [referencia](https://docs.veriko.mx).

## Desarrollo

```bash
npm install
npm test               # compila a dist-test/ y corre node --test
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run build          # dist/esm y dist/cjs
```

Ninguna prueba llama a la API. El arnés levanta un servidor HTTP local que sirve las respuestas
guardadas en [`test/recordings/`](test/recordings).

## Enlaces

- Documentación de la API: [docs.veriko.mx](https://docs.veriko.mx)
- Spec de OpenAPI: [docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml)
- SDK de Python: [veriko-mx-labs/veriko-python](https://github.com/veriko-mx-labs/veriko-python)
- Ejemplos en otros lenguajes: [veriko-mx-labs/examples](https://github.com/veriko-mx-labs/examples)
- El CEP, en detalle: [docs.veriko.mx/es/concepts/cep-concept](https://docs.veriko.mx/es/concepts/cep-concept)
- Registro de cambios: [CHANGELOG.md](CHANGELOG.md)

## Licencia

MIT — ver [`LICENSE`](LICENSE).
