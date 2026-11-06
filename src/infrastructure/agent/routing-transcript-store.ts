/**
 * The transcript store that knows where VM sessions' transcripts are (#276 stage 4).
 *
 * A local folder is a directory under the Mac's `~/.claude/projects`, read by
 * FileTranscriptStore exactly as before. A VM folder
 * (`vm:<user>@<host>:<port>:<encoded>`, see `vm-paths.ts`) is a directory
 * under the VM's own `~/.claude/projects`, so its reads go to that host's
 * agent as a `transcript-query`: the agent calls the same method on its own
 * FileTranscriptStore with `<encoded>` as the folder and answers with the
 * result as JSON.
 *
 * The answers speak the VM's paths, so each path in them comes back VM-named
 * (`vmPath`): a location's `cwd`, a resolved project path, a session's
 * `projectPath`. A service can then hand them straight to git, whose routing
 * adapter sends a VM-named path back to the same VM.
 *
 * Why it lives here, an adapter: like FileTranscriptStore it is the thing
 * behind a port, and it speaks the agent protocol's method names. Nothing in
 * the application layer has to learn that a folder can be on a VM.
 *
 * Why it answers later (AwaitableTranscriptStore, not TranscriptStore): a VM's
 * answer comes over the link. The services that meet VM sessions read their
 * transcripts inside async work already and `await` each read; see
 * `transcript-queries.ts`. Everything else keeps FileTranscriptStore and its
 * synchronous answers.
 *
 * A VM read never throws and never dials. A host that is not connected, an
 * agent that fails or times out, or an answer of the wrong shape answers
 * empty, as a folder with no transcripts would: the services poll, and a
 * poll must not start an ssh that may want a 1Password approval nobody is
 * looking at. The reads the agent does not answer (not in
 * TRANSCRIPT_QUERY_METHODS) answer empty for a VM folder straight away.
 */
import {splitVmFolder, splitVmPath, vmPath, type VmHost} from '../../domain/agent/vm-paths';
import type {TranscriptQueryMethod} from '../../domain/agent/protocol';
import type {Session} from '../../domain/session/session';
import type {IssueRef} from '../../domain/session-work/model';
import type {Logger} from '../../application/ports/logger';
import type {AwaitableTranscriptStore} from '../../application/ports/transcript-queries';
import type {
    TranscriptLocation,
    TranscriptProducts,
    TranscriptSeed,
    TranscriptStore,
} from '../../application/ports/transcript-store';

/**
 * A host's link, as far as transcripts go: `AgentConnection.transcriptQuery`.
 * Answers the method's return value as the agent sent it (parsed JSON); rejects
 * when the agent fails or does not answer in time.
 */
export interface TranscriptQueryLink {
    transcriptQuery(method: TranscriptQueryMethod, args: unknown[]): Promise<unknown>;
}

export interface RoutingTranscriptStoreDeps {
    /** The Mac's own transcripts: every local folder goes here, unchanged. */
    local: TranscriptStore;
    /** The host's link while it is connected; null when it is not. Must never dial. */
    link(host: VmHost): TranscriptQueryLink | null;
    log: Logger;
}

export class RoutingTranscriptStore implements AwaitableTranscriptStore {
    constructor(private readonly deps: RoutingTranscriptStoreDeps) {}

    // ── The reads a VM answers ──

    public async locations(folder: string, sessionId: string): Promise<TranscriptLocation[]> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.locations(folder, sessionId);
        const answer = await this.ask(vm.host, 'locations', [vm.encoded, sessionId]);
        return listOf(answer, isLocation).map((location) => ({
            cwd: vmPath(vm.host, location.cwd),
            branch: location.branch,
            fromSubagent: location.fromSubagent,
        }));
    }

    /**
     * The session as its VM parsed it. `projectPath` is the Mac's (VM-named)
     * name for the project; the VM is asked with its own path, and the answer
     * keeps the Mac's names for the folder and project, as a local read
     * stamps the ones it was asked with.
     */
    public async readSession(folder: string, sessionId: string, projectPath: string): Promise<Session | null> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.readSession(folder, sessionId, projectPath);
        const vmSide = splitVmPath(projectPath)?.path ?? projectPath;
        const answer = await this.ask(vm.host, 'readSession', [vm.encoded, sessionId, vmSide]);
        if (!isSession(answer)) return null;
        return {...answer, folder, projectPath};
    }

    public async issueMentions(folder: string, sessionId: string, repository: string): Promise<IssueRef[]> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.issueMentions(folder, sessionId, repository);
        const answer = await this.ask(vm.host, 'issueMentions', [vm.encoded, sessionId, repository]);
        return listOf(answer, isIssueRef).map(({repository: repo, number}) => ({repository: repo, number}));
    }

    public async resolveProjectPath(folder: string): Promise<string | null> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.resolveProjectPath(folder);
        const answer = await this.ask(vm.host, 'resolveProjectPath', [vm.encoded]);
        return typeof answer === 'string' && answer ? vmPath(vm.host, answer) : null;
    }

    public async readHeadLines(folder: string, sessionId: string, byteLimit: number): Promise<string[]> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.readHeadLines(folder, sessionId, byteLimit);
        const answer = await this.ask(vm.host, 'readHeadLines', [vm.encoded, sessionId, byteLimit]);
        return listOf(answer, (line): line is string => typeof line === 'string');
    }

    public async readTail(folder: string, sessionId: string, byteLimit: number): Promise<string> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.readTail(folder, sessionId, byteLimit);
        const answer = await this.ask(vm.host, 'readTail', [vm.encoded, sessionId, byteLimit]);
        return typeof answer === 'string' ? answer : '';
    }

    public async sessionMtimeMs(folder: string, sessionId: string): Promise<number | null> {
        const vm = splitVmFolder(folder);
        if (!vm) return this.deps.local.sessionMtimeMs(folder, sessionId);
        const answer = await this.ask(vm.host, 'sessionMtimeMs', [vm.encoded, sessionId]);
        return typeof answer === 'number' && Number.isFinite(answer) ? answer : null;
    }

    // ── The rest: local only; a VM folder answers empty ──

    /** The Mac's folders. A VM's are never listed here: their rows come from VmTranscripts. */
    public listFolders(): string[] {
        return this.deps.local.listFolders();
    }

    public folderExists(folder: string): boolean {
        return splitVmFolder(folder) ? false : this.deps.local.folderExists(folder);
    }

    public listSessionIds(folder: string): string[] {
        return splitVmFolder(folder) ? [] : this.deps.local.listSessionIds(folder);
    }

    public folderIndexMtimeMs(folder: string): number {
        return splitVmFolder(folder) ? 0 : this.deps.local.folderIndexMtimeMs(folder);
    }

    public sessionFingerprint(folder: string, sessionId: string): string | null {
        return splitVmFolder(folder) ? null : this.deps.local.sessionFingerprint(folder, sessionId);
    }

    public readFrom(
        folder: string,
        sessionId: string,
        start: number,
        byteLimit: number,
    ): {text: string; size: number} | null {
        return splitVmFolder(folder) ? null : this.deps.local.readFrom(folder, sessionId, start, byteLimit);
    }

    public products(folder: string, sessionId: string): TranscriptProducts {
        return splitVmFolder(folder) ? {artifacts: [], pages: []} : this.deps.local.products(folder, sessionId);
    }

    public readSlug(folder: string, sessionId: string): string | null {
        return splitVmFolder(folder) ? null : this.deps.local.readSlug(folder, sessionId);
    }

    /** Keyed by a project path, not a folder: unchanged. */
    public ensureProjectFolder(projectPath: string, seed: TranscriptSeed): string {
        return this.deps.local.ensureProjectFolder(projectPath, seed);
    }

    /** Nothing is written into a VM's transcripts from the Mac this way; a VM folder is left alone. */
    public seedSession(folder: string, sessionId: string, lines: readonly unknown[]): void {
        if (splitVmFolder(folder)) {
            this.deps.log.warn(`[vm-transcripts] not seeding ${sessionId} into VM folder ${folder}`);
            return;
        }
        this.deps.local.seedSession(folder, sessionId, lines);
    }

    /** One query to the host's agent; undefined when it is not connected or the query failed. */
    private async ask(host: VmHost, method: TranscriptQueryMethod, args: unknown[]): Promise<unknown> {
        const link = this.deps.link(host);
        if (!link) return undefined;
        try {
            return await link.transcriptQuery(method, args);
        } catch (err) {
            this.deps.log.warn(
                `[vm-transcripts] ${method} on ${host.user}@${host.host}:${host.port} failed: ${(err as Error).message}`,
            );
            return undefined;
        }
    }
}

/** The entries of an answer that should be a list, those of the right shape; [] for anything else. */
function listOf<T>(answer: unknown, is: (entry: unknown) => entry is T): T[] {
    return Array.isArray(answer) ? answer.filter(is) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is TranscriptLocation {
    return (
        isRecord(value) &&
        typeof value.cwd === 'string' &&
        value.cwd !== '' &&
        typeof value.branch === 'string' &&
        typeof value.fromSubagent === 'boolean'
    );
}

function isIssueRef(value: unknown): value is IssueRef {
    return isRecord(value) && typeof value.repository === 'string' && typeof value.number === 'number';
}

/** Enough of a Session to be one: what every reader of it relies on. */
function isSession(value: unknown): value is Session {
    return (
        isRecord(value) &&
        typeof value.sessionId === 'string' &&
        typeof value.summary === 'string' &&
        typeof value.created === 'string' &&
        typeof value.modified === 'string' &&
        Array.isArray(value.pullRequests)
    );
}
