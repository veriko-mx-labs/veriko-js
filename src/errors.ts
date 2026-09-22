/**
 * Errores del SDK.
 *
 * La API devuelve los errores en un arreglo `errors`, y `code` es el campo estable
 * de cada entrada. `detail` se traduce según `Accept-Language` y puede reformularse
 * entre versiones. Por eso todas las excepciones exponen `code` y la
 * lista completa de `errors`: ramificar sobre el texto es el error más silencioso
 * al integrar esta API.
 *
 * @see https://docs.veriko.mx/es/concepts/errors
 */

/** Una entrada del arreglo `errors` de la API. */
export interface ApiErrorEntry {
  status?: string;
  code?: string;
  detail?: string;
  source?: { pointer?: string };
  meta?: Record<string, unknown>;
}

/** Raíz de todo lo que lanza el SDK. */
export class VerikoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Falta la clave de API, o un argumento del cliente es inservible. */
export class ConfigurationError extends VerikoError {}

/** No hubo respuesta: DNS, TLS, socket o tiempo agotado, con los reintentos ya agotados. */
export class ConnectionError extends VerikoError {
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message);
    this.attempts = attempts;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface ApiErrorInit {
  status: number;
  code?: string | undefined;
  detail?: string | undefined;
  pointer?: string | undefined;
  errors?: ApiErrorEntry[] | undefined;
  requestId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

/** La API respondió, y la respuesta fue un error. */
export class ApiError extends VerikoError {
  /** Estado HTTP. */
  readonly status: number;
  /** `errors[0].code`, el contrato estable sobre el que ramificar. */
  readonly code: string | undefined;
  /** `errors[0].detail`, texto legible y traducido. */
  readonly detail: string | undefined;
  /** `errors[0].source.pointer` cuando el rechazo señala un campo. */
  readonly pointer: string | undefined;
  /** El arreglo completo. Un `422` trae una entrada por campo inválido. */
  readonly errors: ApiErrorEntry[];
  /** `meta.request_id`, el dato con el que se investiga un caso puntual. */
  readonly requestId: string | undefined;
  readonly meta: Record<string, unknown>;
  /** Cabeceras de la respuesta, con el nombre en minúsculas. */
  readonly headers: Record<string, string>;

  constructor(message: string, init: ApiErrorInit) {
    const status = String(init.status);
    const head = init.code ? `HTTP ${status} ${init.code}` : `HTTP ${status}`;
    const suffix = init.requestId ? ` (request_id=${init.requestId})` : '';
    super(`${head}: ${message}${suffix}`);
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.pointer = init.pointer;
    this.errors = init.errors ?? [];
    this.requestId = init.requestId;
    this.meta = init.meta ?? {};
    this.headers = init.headers ?? {};
  }
}

/** `401`. Falta la clave de API o ya no es válida. */
export class AuthenticationError extends ApiError {}

/** `403`. Autenticado, pero sin permiso para esa operación. */
export class ForbiddenError extends ApiError {}

/** `404`. El recurso no existe, o el CEP no está disponible (`cep_not_available`). */
export class NotFoundError extends ApiError {}

/** `409`. Conflicto de estado; con `Idempotency-Key`, la petición anterior sigue en curso. */
export class ConflictError extends ApiError {}

/** `400`, `413` y `422`. La petición hay que corregirla antes de repetirla. */
export class InvalidRequestError extends ApiError {}

/** `429`. Límite de tasa superado, o cuota del plan agotada. */
export class RateLimitError extends ApiError {
  /**
   * Segundos que la respuesta pide esperar, cuando los trae. Es el único dato
   * necesario para reintentar sin adivinar.
   */
  readonly retryAfter: number | undefined;

  constructor(message: string, init: ApiErrorInit & { retryAfter?: number | undefined }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/** `5xx`. Admite reintento; el SDK ya lo hizo si quedaban intentos. */
export class ServerError extends ApiError {}

/** La firma de un webhook no cuadra con el cuerpo recibido. */
export class SignatureVerificationError extends VerikoError {}

/**
 * `waitFor()` o `importWait()` agotaron su tiempo sin que el recurso llegara a un
 * estado firme.
 */
export class TimeoutError extends VerikoError {
  /** El recurso que se esperaba: una validación o una importación. */
  readonly resourceId: string;
  /** El tiempo de espera que se agotó, en milisegundos. */
  readonly timeoutMs: number;

  constructor(message: string, resourceId: string, timeoutMs: number) {
    super(message);
    this.resourceId = resourceId;
    this.timeoutMs = timeoutMs;
  }

  /** Es `resourceId` cuando lo que se esperaba era una validación. */
  get validationId(): string {
    return this.resourceId;
  }
}
