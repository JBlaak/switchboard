/**
 * The HTTP server Claude's question hook posts to.
 *
 * Each local Claude session is launched with a PreToolUse `http` hook pointed
 * at `POST /ask/<launchId>` here. The CLI holds that request open until we
 * reply, which is what lets the renderer show the questions and the user
 * answer them in Switchboard; if the request closes first (the hook's own
 * timeout, the session stopped, the CLI interrupted) the CLI asks in its
 * terminal instead and the pending set is withdrawn.
 *
 * Loopback only, on a random port, behind a per-run secret: any local process
 * can reach 127.0.0.1, and without the token one could answer a session's
 * questions for it.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { parseQuestionHookInput, QUESTION_HOOK_TOKEN_HEADER } from '../../domain/questions/question';
import type { Logger } from '../../application/ports/logger';
import type { QuestionHookEndpoint } from '../../application/ports/question-hook';
import type { QuestionService } from '../../application/services/question-service';

/** Far more than any question set; a body this big is not from the CLI. */
const MAX_BODY_BYTES = 1024 * 1024;

const ASK_PATH = /^\/ask\/([^/?#]+)$/;

export interface QuestionHookServerDeps {
  /**
   * Where valid requests go. Only `receive`, so the composition root can build
   * the server before the service that reads its address.
   */
  receiver: Pick<QuestionService, 'receive'>;
  log: Logger;
}

export class QuestionHookServer implements QuestionHookEndpoint {
  readonly token = crypto.randomBytes(32).toString('hex');
  readonly #tokenBuffer = Buffer.from(this.token);
  #server: http.Server | null = null;
  #url: string | null = null;

  constructor(private readonly deps: QuestionHookServerDeps) {}

  get url(): string | null {
    return this.#url;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    const server = http.createServer((req, res) => this.#handle(req, res));
    // A held request is the normal case: the CLI's hook timeout (ten minutes)
    // governs how long one may wait, not ours. Node's defaults would cut it at
    // five minutes (requestTimeout); headers still have to arrive promptly.
    server.requestTimeout = 0;
    server.timeout = 0;
    this.#server = server;

    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.#server = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        server.on('error', (err) => this.deps.log.error('[questions] hook server error:', err.message));
        const { port } = server.address() as AddressInfo;
        this.#url = `http://127.0.0.1:${port}`;
        this.deps.log.info(`[questions] hook server listening on ${this.#url}`);
        resolve();
      });
    });
  }

  /**
   * Stop listening and drop every held request. Each drop withdraws its
   * pending set, and the CLI falls back to its own prompt.
   */
  stop(): void {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#url = null;
    server.close();
    server.closeAllConnections();
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const match = req.method === 'POST' ? ASK_PATH.exec(req.url ?? '') : null;
    if (!match) return this.#end(res, 404);
    if (!this.#authorised(req.headers[QUESTION_HOOK_TOKEN_HEADER.toLowerCase()])) return this.#end(res, 401);

    let launchId: string;
    try {
      launchId = decodeURIComponent(match[1]);
    } catch {
      return this.#end(res, 404);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.setHeader('Connection', 'close');
        this.#end(res, 413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      this.#dispatch(launchId, Buffer.concat(chunks).toString('utf8'), res);
    });
  }

  #dispatch(launchId: string, raw: string, res: http.ServerResponse): void {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const asked = parseQuestionHookInput(body);
    // Not something we can show: no decision, so the CLI carries on as usual.
    if (!asked) return this.#json(res, {});

    let replied = false;
    const handle = this.deps.receiver.receive(launchId, asked, (json) => {
      if (replied) return;
      replied = true;
      this.#json(res, json);
    });

    // 'close' on the response fires when the connection goes away as well as
    // after a normal finish; only the former withdraws.
    res.on('close', () => {
      if (!replied) {
        replied = true;
        handle.withdraw();
      }
    });
  }

  #authorised(header: string | string[] | undefined): boolean {
    if (typeof header !== 'string') return false;
    const given = Buffer.from(header);
    return given.length === this.#tokenBuffer.length && crypto.timingSafeEqual(given, this.#tokenBuffer);
  }

  #json(res: http.ServerResponse, json: Record<string, unknown>): void {
    if (res.headersSent || res.destroyed) return;
    const payload = JSON.stringify(json);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  #end(res: http.ServerResponse, status: number): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status);
    res.end();
  }
}
