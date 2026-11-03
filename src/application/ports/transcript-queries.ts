/**
 * The transcript reads a VM can answer, as the services that may meet a VM
 * session ask them (#276 stage 4).
 *
 * TranscriptStore is synchronous: the Mac's transcripts are files on its own
 * disk. A VM session's are on the VM, asked for over the agent's link, so
 * their answer can only come later. The services that read a session's
 * transcripts for the session work page, the Plan tab, issue ownership and
 * worktree cleanup all read them inside async work already, so rather than
 * a prefetching cache that every one of them would have to fill first (and
 * that could serve a stale answer), they depend on this: the same reads, each
 * answering now or later. They `await` every read.
 *
 * FileTranscriptStore fits as it is (a plain value is an answer now), so a
 * caller that only ever sees local sessions, and every existing test fake,
 * is unchanged. RoutingTranscriptStore is the one that answers later.
 */
import type {TranscriptQueryMethod} from '../../domain/agent/protocol';
import type {TranscriptStore} from './transcript-store';

/** An answer now, or one to wait for. */
export type Awaitable<T> = T | Promise<T>;

/** TranscriptStore's reads that a VM's agent answers (TRANSCRIPT_QUERY_METHODS), each now or later. */
export type TranscriptQueries = {
    [K in TranscriptQueryMethod]: (
        ...args: Parameters<TranscriptStore[K]>
    ) => Awaitable<ReturnType<TranscriptStore[K]>>;
};

/** A whole TranscriptStore whose VM-answerable reads may answer later; the rest stay synchronous. */
export type AwaitableTranscriptStore = Omit<TranscriptStore, TranscriptQueryMethod> & TranscriptQueries;
