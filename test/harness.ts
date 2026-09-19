/**
 * Arnés de pruebas: un servidor local que sirve respuestas grabadas.
 *
 * Ninguna prueba llama a la API de Veriko. Lo que se prueba es el SDK contra
 * respuestas guardadas en `test/recordings/`, servidas por un servidor HTTP de
 * verdad en `127.0.0.1`.
 *
 * El arnés pasa por HTTP real en lugar de sustituir `fetch`. Así se ejercita lo
 * que el SDK ejecuta en producción: cabeceras, códigos de estado y cuerpos
 * binarios.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RETRY, Transport } from '../src/http.js';
import { Veriko } from '../src/client.js';

/**
 * La raíz del repositorio, buscada hacia arriba desde este archivo.
 *
 * Las pruebas se compilan a `dist-test/` antes de correr, así que la distancia
 * hasta la raíz cambia según desde dónde se lea. El `package.json` es el ancla.
 */
function findProjectRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('No se encontró la raíz del repositorio');
    dir = parent;
  }
  return dir;
}

export const PROJECT_ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const RECORDINGS_DIR = join(PROJECT_ROOT, 'test', 'recordings');

interface Recording {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  body_base64?: string;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Lee una respuesta grabada de `test/recordings/<name>.json`. */
export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(RECORDINGS_DIR, `${name}.json`), 'utf8')) as Recording;
}

/** El cuerpo de una entrega, en los bytes exactos que viajarían. */
export function recordedBody(name: string): Buffer {
  return Buffer.from(JSON.stringify(loadRecording(name).json), 'utf8');
}

function toResponse(recording: Recording): RecordedResponse {
  const headers = { ...(recording.headers ?? {}) };
  let body: Buffer;
  if (recording.json !== undefined) {
    body = Buffer.from(JSON.stringify(recording.json), 'utf8');
    headers['Content-Type'] ??= 'application/json; charset=utf-8';
  } else if (recording.body_base64 !== undefined) {
    body = Buffer.from(recording.body_base64, 'base64');
  } else {
    body = Buffer.alloc(0);
  }
  return { status: recording.status, headers, body };
}

/** Sirve, en orden, las respuestas encoladas; guarda lo que recibió. */
export class RecordingServer {
  readonly requests: CapturedRequest[] = [];
  private readonly queue: RecordedResponse[] = [];
  private readonly server: Server;
  private port = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<RecordingServer> {
    const holder: { instance?: RecordingServer } = {};
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const captured: CapturedRequest = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name.toLowerCase(),
              Array.isArray(value) ? (value[0] ?? '') : (value ?? ''),
            ]),
          ),
          body: Buffer.concat(chunks),
        };
        holder.instance?.requests.push(captured);
        const recorded = holder.instance?.next() ?? {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from('{"errors":[{"code":"no_recording_left"}],"meta":{}}'),
        };
        response.writeHead(recorded.status, {
          ...recorded.headers,
          Connection: 'close',
          'Content-Length': String(recorded.body.length),
        });
        response.end(recorded.body);
      });
    });

    const instance = new RecordingServer(server);
    holder.instance = instance;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    instance.port = typeof address === 'object' && address ? address.port : 0;
    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}/v1`;
  }

  enqueue(name: string, times = 1): this {
    for (let index = 0; index < times; index += 1) {
      this.queue.push(toResponse(loadRecording(name)));
    }
    return this;
  }

  /** Vacía las peticiones recibidas y las respuestas que quedaban por servir. */
  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
  }

  private next(): RecordedResponse | undefined {
    return this.queue.shift();
  }

  request(index: number): CapturedRequest {
    const captured = this.requests[index];
    if (!captured) {
      throw new Error(`El servidor no recibió ninguna petición en la posición ${String(index)}`);
    }
    return captured;
  }

  header(index: number, name: string): string | undefined {
    return this.request(index).headers[name.toLowerCase()];
  }

  json(index: number): Record<string, unknown> {
    return JSON.parse(this.request(index).body.toString('utf8')) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/**
 * Un cliente apuntado al servidor de respuestas grabadas.
 *
 * No duerme de verdad: las esperas entre reintentos se anotan en `sleeps`, que
 * es lo que las pruebas comprueban.
 */
export function makeClient(
  server: RecordingServer,
  sleeps: number[],
  options: { maxRetries?: number; respectRetryAfter?: boolean } = {},
): Veriko {
  const transport = new Transport({
    baseUrl: server.baseUrl,
    apiKey: 'veriko_prueba',
    timeoutMs: 5000,
    retry: {
      ...DEFAULT_RETRY,
      maxRetries: options.maxRetries ?? 2,
      backoffBaseMs: 10,
      respectRetryAfter: options.respectRetryAfter ?? true,
    },
    userAgent: 'veriko-js/prueba',
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return new Veriko({ transport });
}
