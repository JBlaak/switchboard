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
 * Two more routes take notices, answered at once: `POST /stop/<launchId>` at
 * the end of each turn, whose last message may be a grilling round, and
 * `POST /prompt/<launchId>` when a prompt goes in, which ends a round still
 * waiting. The end of a turn is also when a session that asked to be archived
 * is archived.
 *
 * And `POST /mcp/<launchId>` serves the session Switchboard's own MCP server,
 * with `archive_session` and, where a page tool is given, `show_page`.
 *
 * Loopback only, on a random port, behind a per-run secret: any local process
 * can reach 127.0.0.1, and without the token one could answer a session's
 * questions for it.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type {AddressInfo} from 'node:net';

import {parseGrillRound} from '../../domain/questions/grill';
import {archiveToolReply, type ArchiveToolOutcome, type McpTool} from '../../domain/session/archive-tool';
import {pageTool, type PageInput} from '../../domain/session/page-tool';
import {parseQuestionHookInput, parseStopHookInput, QUESTION_HOOK_TOKEN_HEADER} from '../../domain/questions/question';
import type {Logger} from '../../application/ports/logger';
import type {QuestionHookEndpoint} from '../../application/ports/question-hook';
import type {QuestionService} from '../../application/services/question-service';

/** Far more than any question set; a body this big is not from the CLI. */
const MAX_BODY_BYTES = 1024 * 1024;

const HOOK_PATH = /^\/(ask|stop|prompt|mcp)\/([^/?#]+)$/;

type Route = 'ask' | 'stop' | 'prompt' | 'mcp';

export interface QuestionHookServerDeps {
    /**
     * Where valid requests go. Only these, so the composition root can build
     * the server before the service that reads its address.
     */
    receiver: Pick<QuestionService, 'receive' | 'receiveRound' | 'promptSubmitted'>;
    /**
     * Where the archive tool's calls, and the ends of turns, go. On the Mac,
     * ArchiveToolService answers at once; on the agent the call is forwarded to
     * the Mac and answered later, so a promise is allowed too.
     */
    archiveTool?: {
        request(launchId: string): ArchiveToolOutcome | Promise<ArchiveToolOutcome>;
        turnEnded(launchId: string): void;
    };
    /**
     * Where `show_page` calls go, with a valid page. Without one (the agent on a
     * VM) the tool is not offered.
     */
    pageTool?: {show(launchId: string, page: PageInput): ArchiveToolOutcome};
    log: Logger;
}

export class QuestionHookServer implements QuestionHookEndpoint {
    public readonly token = crypto.randomBytes(32).toString('hex');
    private readonly tokenBuffer = Buffer.from(this.token);
    private server: http.Server | null = null;
    private listeningUrl: string | null = null;

    constructor(private readonly deps: QuestionHookServerDeps) {}

    public get url(): string | null {
        return this.listeningUrl;
    }

    public start(): Promise<void> {
        if (this.server) return Promise.resolve();
        const server = http.createServer((req, res) => this.handle(req, res));
        // A held request is the normal case: the CLI's hook timeout (ten minutes)
        // governs how long one may wait, not ours. Node's defaults would cut it at
        // five minutes (requestTimeout); headers still have to arrive promptly.
        server.requestTimeout = 0;
        server.timeout = 0;
        this.server = server;

        return new Promise((resolve, reject) => {
            const onError = (err: Error): void => {
                this.server = null;
                reject(err);
            };
            server.once('error', onError);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', onError);
                server.on('error', (err) => this.deps.log.error('[questions] hook server error:', err.message));
                const {port} = server.address() as AddressInfo;
                this.listeningUrl = `http://127.0.0.1:${port}`;
                this.deps.log.info(`[questions] hook server listening on ${this.listeningUrl}`);
                resolve();
            });
        });
    }

    /**
     * Stop listening and drop every held request. Each drop withdraws its
     * pending set, and the CLI falls back to its own prompt.
     */
    public stop(): void {
        const server = this.server;
        if (!server) return;
        this.server = null;
        this.listeningUrl = null;
        server.close();
        server.closeAllConnections();
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const match = req.method === 'POST' ? HOOK_PATH.exec(req.url ?? '') : null;
        if (!match) return this.end(res, 404);
        if (!this.authorised(req.headers[QUESTION_HOOK_TOKEN_HEADER.toLowerCase()])) return this.end(res, 401);

        const route = match[1] as Route;
        let launchId: string;
        try {
            launchId = decodeURIComponent(match[2]);
        } catch {
            return this.end(res, 404);
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
                this.end(res, 413);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return;
            this.dispatch(route, launchId, Buffer.concat(chunks).toString('utf8'), res);
        });
    }

    private dispatch(route: Route, launchId: string, raw: string, res: http.ServerResponse): void {
        let body: unknown;
        try {
            body = JSON.parse(raw);
        } catch {
            body = null;
        }
        if (route === 'stop') return this.stopped(launchId, body, res);
        if (route === 'mcp') return this.mcp(launchId, body, res);
        if (route === 'prompt') {
            this.json(res, {});
            this.deps.receiver.promptSubmitted(launchId);
            return;
        }

        const asked = parseQuestionHookInput(body);
        // Not something we can show: no decision, so the CLI carries on as usual.
        if (!asked) return this.json(res, {});

        let replied = false;
        const handle = this.deps.receiver.receive(launchId, asked, (json) => {
            if (replied) return;
            replied = true;
            this.json(res, json);
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

    /** The turn is over either way: let the CLI go, then look for a round in what it said. */
    private stopped(launchId: string, body: unknown, res: http.ServerResponse): void {
        this.json(res, {});
        const text = parseStopHookInput(body);
        const questions = text ? parseGrillRound(text) : null;
        if (questions) this.deps.receiver.receiveRound(launchId, questions);
        this.deps.archiveTool?.turnEnded(launchId);
    }

    private mcp(launchId: string, body: unknown, res: http.ServerResponse): void {
        const {archiveTool} = this.deps;
        if (!archiveTool) return this.end(res, 404);
        // archiveToolReply is synchronous and pure. When the outcome is only a
        // promise, the call is made once here, and the reply is built again
        // around the settled outcome; a synchronous outcome replies at once,
        // exactly as before.
        const page = this.deps.pageTool;
        const extra: McpTool[] = page ? [pageTool((input) => page.show(launchId, input))] : [];
        const call: {pending?: Promise<ArchiveToolOutcome>} = {};
        const reply = archiveToolReply(
            body,
            () => {
                const outcome = archiveTool.request(launchId);
                if (!(outcome instanceof Promise)) return outcome;
                call.pending = outcome;
                return {ok: false, message: ''};
            },
            extra,
        );
        if (call.pending) {
            void call.pending
                .catch((err: unknown): ArchiveToolOutcome => {
                    this.deps.log.error('[archive-tool] request failed:', err);
                    return {ok: false, message: 'Switchboard could not archive this session.'};
                })
                .then((outcome) => {
                    // Only an archive call is ever pending, so the page tool is not called again.
                    const settled = archiveToolReply(body, () => outcome, extra);
                    if (settled) this.json(res, settled);
                });
            return;
        }
        if (reply) this.json(res, reply);
        else this.end(res, 202);
    }

    private authorised(header: string | string[] | undefined): boolean {
        if (typeof header !== 'string') return false;
        const given = Buffer.from(header);
        return given.length === this.tokenBuffer.length && crypto.timingSafeEqual(given, this.tokenBuffer);
    }

    private json(res: http.ServerResponse, json: Record<string, unknown>): void {
        if (res.headersSent || res.destroyed) return;
        const payload = JSON.stringify(json);
        res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)});
        res.end(payload);
    }

    private end(res: http.ServerResponse, status: number): void {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(status);
        res.end();
    }
}
