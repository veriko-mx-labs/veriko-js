# @veriko-mx/sdk · SDK de JavaScript y TypeScript para la API del CEP

Cliente oficial de [Veriko](https://veriko.mx) para Node. Valida transferencias SPEI mexicanas
contra el CEP de Banco de México, descarga el comprobante oficial y verifica la firma de los
webhooks.

Sin dependencias de runtime. Tipos generados del spec de OpenAPI. Node 18 o superior, en ESM y en
CommonJS.

```ts
import { Veriko } from '@veriko-mx/sdk';

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

## Las familias de operaciones

El cliente agrupa las 66 operaciones M2M de la API en once familias:

| familia                | qué cubre                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `client.validations`   | Validar por campos o por imagen, consultar, listar, exportar, la política de reintentos y la descarga del comprobante |
| `client.webhooks`      | Registrar endpoints, rotar su secreto, enviar un evento de prueba y leer el historial de entregas                     |
| `client.catalog`       | Catálogo de bancos SPEI, banco emisor de una tarjeta y estado del servicio de Banxico                                 |
| `client.beneficiaries` | Cuentas beneficiarias guardadas y la importación masiva, como ciclo completo                                          |
| `client.usage`         | Cuota de validaciones, límites de tasa y registro de actividad de la API                                              |
| `client.account`       | Perfil y política de reintentos predeterminada de la cuenta                                                           |
| `client.dashboard`     | Resumen del panel                                                                                                     |
| `client.plans`         | Catálogo y comparación de planes públicos, sin clave de API                                                           |
| `client.insights`      | Resumen, tendencias, bancos y beneficiarios principales                                                               |
| `client.finance`       | Resumen, estado de cuenta, vistas previas y descargas financieras                                                     |
| `client.billing`       | Suscripción activa                                                                                                    |

Las tres operaciones de uso más frecuente están también en la raíz del cliente, como atajo:
`validateTransfer()`, `getValidation()` y `getCep()`.

## Instalación

```bash
npm install @veriko-mx/sdk
```

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
clave falla localmente antes de salir a la red.

La opción `apiKey` la recibe directamente cuando la gestiona otro mecanismo:

```ts
const client = new Veriko({ apiKey: 'veriko_tu_clave_aqui' });
```

## Validar una transferencia

La operación exige la fecha de envío, el importe y **la clave de rastreo o la referencia
numérica**. Enviar las dos precisa la búsqueda. El banco emisor, el receptor y la cuenta
beneficiaria son opcionales y mejoran la identificación.

```ts
import { Veriko } from '@veriko-mx/sdk';

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

### Desde la imagen del comprobante

```ts
const validation = await client.validations.validateOcr({
  image: 'comprobante.png', // ruta, Buffer o Uint8Array
  cuentaBeneficiaria: '012180004412345678', // obligatoria para celular DiMo
});
```

El SDK lee el archivo y lo codifica en base64. `imageUrl` recibe una imagen ya publicada en HTTPS, y
si se envían `image` e `imageUrl`, la API sólo considera `image`. Formatos: JPEG, PNG o WebP, de
hasta 12 MB.

La imagen de una validación por OCR se descarga con `client.validations.image(id)`.

### Sin esperar al veredicto

Para volumen, la API acepta la petición y responde con el identificador:

```ts
const queued = await client.validations.enqueue({
  fecha: '2025-03-15',
  monto: 15000.5,
  claveRastreo: 'MXBA20250315001234',
});

const validation = await client.validations.waitFor(queued.id); // sondea hasta el veredicto
```

`enqueue()` y `enqueueOcr()` son métodos aparte y no una opción de `validate()`, de modo que el
tipo de retorno de cada uno es fijo.

`waitFor()` manda el `ETag` de la respuesta anterior en cada vuelta, así que un sondeo que no
encuentra cambios no descarga otra vez el mismo cuerpo. Espera a que el veredicto quede firme, no
sólo a que el estado sea terminal: una validación con reintentos en marcha llega a `not_found` y
sigue cambiando después. Esa distinción es `isSettled()`, junto a `isTerminal()` y `hasCep()`.

El tiempo de espera se fija con `timeoutMs` (cinco minutos por omisión) y la pausa entre sondeos con
`pollIntervalMs` (cinco segundos). Al agotarse el primero, `waitFor()` lanza `TimeoutError`.

La alternativa a sondear es suscribirse al webhook `validation.completed`.

### Listar y recorrer el historial

```ts
const page = await client.validations.list({ status: 'valid', perPage: 50 });
console.log(page.total, 'validaciones,', page.totalPages, 'páginas');

for await (const item of client.validations.iter({ from: '2025-03-01', to: '2025-03-31' })) {
  console.log(item.id, item.attributes.status);
}
```

`iter()` es un `AsyncIterable` y pide la página siguiente sólo cuando la anterior se agota. Con
`maxPages` se acota el recorrido. Cada `Page` trae `items`, `page`, `perPage`, `total`,
`totalPages` y `hasNext`.

Los filtros (`status`, `type`, `from`, `to`, `search`, `playground`, `withDeleted`, `batchId`,
`bank`, `amountMin`, `amountMax` y `retryState`) van en `camelCase`. `status` acepta un estado o una
lista, y `withDeleted: true` devuelve sólo las validaciones retiradas, mientras que `false` devuelve
sólo las activas.

Un listado trae menos campos que `get()`: no incluye los datos enviados, el resultado de Banxico ni
los enlaces al comprobante.

El historial se exporta con `client.validations.export({ format: 'csv' })`, que admite también
`xlsx` y los mismos filtros. `client.validations.stats()` devuelve los totales con esos filtros.

## Descargar el CEP

```ts
import { writeFile } from 'node:fs/promises';
import { hasCep } from '@veriko-mx/sdk';

if (hasCep(validation)) {
  const cep = await client.getCep(validation.id, { format: 'pdf' }); // o 'xml'
  await writeFile(cep.filename, cep.content); // CEP-<id>.pdf
}
```

`getCep()` devuelve el archivo: el XML que emitió Banxico, con su sello digital y su cadena
original, o el PDF equivalente. Cuando la validación no tiene comprobante, la API responde `404`
con `cep_not_available` y el SDK lanza `NotFoundError`.

Las descargas y las exportaciones devuelven el archivo y no un enlace: `content`, `contentType` y
el `filename` que propone la API en `Content-Disposition`.

## Registrar un webhook

```ts
const endpoint = await client.webhooks.create({
  url: 'https://miapp.example.com/hooks/pagos',
  events: ['validation.completed'],
});

console.log(endpoint.attributes.secret); // whsec_… La API no lo vuelve a entregar
```

El secreto de firma viaja **una sola vez**, en esta respuesta. Si se pierde,
`client.webhooks.regenerateSecret(endpoint.id)` devuelve uno nuevo, y el anterior deja de valer.

`client.webhooks.test(endpoint.id)` manda un evento de prueba y dice si el receptor lo aceptó. Las
entregas de prueba no cuentan para el contador de fallos consecutivos que apaga un endpoint a los
tres seguidos. Cuando eso pasa, el estado queda en `auto_disabled` y se reactiva con
`client.webhooks.update(id, { status: 'active' })`.

El historial de intentos está en `client.webhooks.deliveries()`, con o sin identificador de
endpoint, y se recorre con `iterDeliveries()`. `exportDeliveries()` lo descarga en CSV o en XLSX.
Los filtros `status` y `eventType` sólo existen en el listado global: con un endpoint y un filtro,
el SDK consulta ese listado con `endpoint_id`.

## Catálogo y estado de Banxico

```ts
const banks = await client.catalog.banks(); // instituciones SPEI con su código
const card = await client.catalog.binLookup('455632'); // banco emisor de una tarjeta
const status = await client.catalog.banxicoStatus();

console.log(status.attributes.status); // 'operational'
```

`banxicoStatus()` sirve para distinguir un `cep_unavailable` propio de la transferencia de una caída
del servicio, y `banxicoTimeseries()` devuelve la serie de latencia o de veredictos por ventana.

## Beneficiarios

`client.beneficiaries` guarda las cuentas a las que se paga: CLABE, tarjeta o celular DiMo. El tipo
se detecta por la longitud del número, y un celular exige `bankCode`.

```ts
const beneficiary = await client.beneficiaries.create({
  accountNumber: '012180004412345678',
  label: 'Proveedor ABC',
});

const found = await client.beneficiaries.lookup('012180004412345678'); // la cuenta ya guardada
console.log(found.attributes.bank_name);
```

La lista completa se recorre con `client.beneficiaries.list()`, que no pagina, y `delete()` archiva una cuenta sin
borrarla: `list({ withArchived: true })` devuelve sólo las archivadas. `export()` la baja en CSV o en
XLSX.

### Importación masiva

La importación es un ciclo: descargar la plantilla, subir el archivo, revisar las filas y confirmar.

```ts
const template = await client.beneficiaries.importTemplate({ format: 'csv' }); // 1. descargar
const started = await client.beneficiaries.importStart('beneficiarios.csv'); // 2. subir
await client.beneficiaries.importWait(started.id); // 3. esperar la vista previa

for await (const row of client.beneficiaries.iterImportPreview(started.id)) {
  // 4. revisar
  if (row.id !== undefined && row.attributes?.status === 'correctable') {
    await client.beneficiaries.importEditRow(started.id, row.id, { parsedBankCode: '40012' });
  }
}

await client.beneficiaries.importCommit(started.id); // 5. confirmar
```

`importStart()` recibe los bytes del archivo o su ruta, y lo sube como `multipart/form-data`. Nada
se persiste hasta `importCommit()`. `importWait()` espera a `preview_ready` o a un estado final,
que es lo que distingue `isImportSettled()`; el endpoint de estado no expone `ETag`, así que cada
vuelta descarga el cuerpo. Una importación que todavía no se confirmó se cancela con
`importCancel()`.

## Consumo

```ts
const summary = await client.usage.summary();
console.log(summary.attributes?.used, 'de', summary.attributes?.limit);

const history = await client.usage.history({ months: 6 });
const limits = await client.usage.limits();
```

`summary()` trae la cuota del plan en curso y `limits()` los límites de tasa, que son ajenos a esa
cuota. `breakdown()`, `heatmap()` y `apiUsage()` desglosan el consumo, y
`client.usage.export({ format: 'csv' })` baja el registro de actividad.

## Lecturas condicionales

`client.validations.get()` y `client.catalog.banks()` admiten `ifNoneMatch`. La respuesta trae el
`ETag` en `etag`, y cuando nada cambió la API responde `304`, que el SDK lanza como `ApiError` con
`status` 304.

```ts
import { ApiError } from '@veriko-mx/sdk';

const validation = await client.validations.get(id);

try {
  await client.validations.get(id, { ifNoneMatch: validation.etag });
} catch (error) {
  if (!(error instanceof ApiError && error.status === 304)) throw error;
}
```

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
import { SignatureVerificationError, parseWebhook } from '@veriko-mx/sdk';

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
espera al webhook `validation.retry.resolved`. Los intentos ya hechos están en
`client.validations.retryAttempts(id)`.

La política de una validación ya creada se cambia con `client.validations.setRetryPolicy(id, policy)`
y el ciclo se detiene con `client.validations.cancelRetries(id)`. Las dos devuelven el estado del
ciclo, no la validación completa.

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

La clave se deriva del intento de negocio (el número de pedido, de lote o de transacción), no se
genera al azar en cada envío: una clave aleatoria por reintento anula la protección.

Sin `idempotencyKey`, el SDK genera una por llamada y la repite en sus propios reintentos. Esa
clave no sobrevive al proceso que la generó, así que un reenvío posterior sí se ejecuta dos veces.
Esto vale para `validate()`, `validateOcr()`, `enqueue()` y `enqueueOcr()`. `setRetryPolicy()` y
`cancelRetries()` aceptan la clave, pero el SDK no genera una por su cuenta.

## Errores

Todas las excepciones heredan de `VerikoError`. Las de la API traen `code`, que es el contrato
estable, y `detail`, que se traduce y puede reformularse entre versiones.

```ts
import { InvalidRequestError, NotFoundError, RateLimitError } from '@veriko-mx/sdk';

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

| excepción                    | estado                                          |
| ---------------------------- | ----------------------------------------------- |
| `AuthenticationError`        | `401`                                           |
| `ForbiddenError`             | `403`                                           |
| `NotFoundError`              | `404`                                           |
| `ConflictError`              | `409`                                           |
| `InvalidRequestError`        | `400`, `413`, `422`                             |
| `RateLimitError`             | `429`                                           |
| `ServerError`                | `5xx`                                           |
| `ConnectionError`            | Sin respuesta, con los reintentos agotados      |
| `TimeoutError`               | `waitFor()` o `importWait()` agotaron su tiempo |
| `SignatureVerificationError` | La firma de un webhook no cuadra                |

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

Cada método devuelve el recurso `data` de la respuesta, tipado por el spec: `validation.attributes`,
`endpoint.attributes.secret`, `bank.attributes.name`.

Los cuerpos de `POST /v1/validate` y de `POST /v1/validate-ocr` son la única excepción y se escriben
a mano: sus schemas llevan un `anyOf` que el generador traduce a `unknown`. `test/spec.test.ts`
falla si el spec añade, quita o renombra alguno de sus campos.

Además de los tipos con nombre corto, el paquete reexporta `components`, `operations` y `paths`
completos, por si hace falta una operación que el SDK todavía no envuelve.

## Superficie M2M

El SDK cubre exactamente las 66 operaciones que el spec público clasifica como M2M: `security: []`
para las públicas, o una alternativa con `ApiKeyAuth` para las autenticadas. No se infiere de
`x-auth`, etiquetas ni familias. Cualquier operación que sólo admita `CookieAuth` queda fuera.

Las 18 incorporadas en esta alineación son el perfil y su política de reintentos, el resumen del
panel, los dos endpoints públicos de planes, las cuatro vistas de insights, las siete operaciones
financieras y la suscripción. Por ejemplo:

```ts
const profile = await client.account.myProfile();
const trends = await client.insights.getTrends({ range: '30d', metric: 'latency' });
const statement = await client.finance.getStatement({ month: '2026-04', format: 'pdf' });
await writeFile(statement.filename, statement.content);
```

Los reportes mensual, por contraparte, por banco y contable conservan el default de la API:
`format: 'csv'`. Usa `format: 'preview'` explícitamente cuando necesites la respuesta JSON para
procesarla en memoria.

La importación masiva de validaciones, las sesiones de usuario y el playground siguen fuera: sólo
aceptan cookie de sesión. La corrección también retira el antiguo `validateAccount()`; ya no forma
parte del contrato M2M público.

## Desarrollo

```bash
npm install
npm test               # compila a dist-test/ y corre node --test
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run build          # dist/esm y dist/cjs
```

`test/operations.test.ts` compara el conjunto completo de métodos con el spec filtrado, ejerce cada
ruta contra un servidor HTTP local y falla si aparece una operación M2M sin método, un método ajeno
al contrato o una excepción temporal que no se eliminó.

Ninguna prueba llama a la API. El arnés levanta un servidor HTTP local que sirve las respuestas
guardadas en [`test/recordings/`](test/recordings), recortadas de los ejemplos del spec público.

## Enlaces

- Documentación de la API: [docs.veriko.mx](https://docs.veriko.mx)
- Spec de OpenAPI: [docs.veriko.mx/openapi.yaml](https://docs.veriko.mx/openapi.yaml)
- SDK de Python: [veriko-mx-labs/veriko-python](https://github.com/veriko-mx-labs/veriko-python)
- Ejemplos en otros lenguajes: [veriko-mx-labs/examples](https://github.com/veriko-mx-labs/examples)
- El CEP, en detalle: [docs.veriko.mx/es/concepts/cep-concept](https://docs.veriko.mx/es/concepts/cep-concept)
- Registro de cambios: [CHANGELOG.md](CHANGELOG.md)

## Licencia

MIT — ver [`LICENSE`](LICENSE).
