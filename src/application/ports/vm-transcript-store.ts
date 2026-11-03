/**
 * Where the Mac keeps what it last heard of each VM session's transcript
 * (#276 stage 3).
 *
 * A VM session's transcript lives on the VM, so the Mac only knows its title,
 * first prompt and PR links while it can ask. Keeping the last answer is what
 * lets those rows keep their titles across a restart and while the VM is off.
 * Like the session cache it is a copy that can be thrown away and fetched
 * again; unlike it, nothing on the Mac's disk can rebuild it, so it is stored
 * apart and never touched by a local re-index.
 */
import type {CachedSession} from '../../domain/session/session';

/** One VM session's transcript, as last fetched from its host. */
export interface VmTranscriptEntry {
    sessionId: string;
    /** `agentHostKey` of the host it was fetched from. */
    hostKey: string;
    /** The folder the session ran in, absolute on the VM. */
    cwd: string;
    /** The transcript file's mtime on the VM, epoch ms: what decides whether an answer is news. */
    mtimeMs: number;
    /** The parsed transcript, without the text kept only in the search index. */
    transcript: CachedSession;
}

export interface VmTranscriptStore {
    all(): VmTranscriptEntry[];
    /** Insert, or replace the entry of the same session. */
    put(entry: VmTranscriptEntry): void;
    delete(sessionId: string): void;
}
