/**
 * The phone's chat view of a session: its transcript as messages, followed
 * while the phone has the view open.
 *
 * A phone subscribes to a session (`chat-subscribe`) and gets the latest
 * messages at once (`chat`), then what the transcript gains (`chat-append`)
 * until it unsubscribes or its connection ends. The transcript is the CLI's
 * file, which nothing tells us about, so a subscribed one is looked at once a
 * second and read from where the last read stopped: a long session's
 * transcript runs to tens of megabytes, and only its new end is read.
 *
 * Only a session with a transcript on this Mac has a chat: not a plain
 * terminal, and not an SSH or VM session, whose transcript is on another
 * machine. Those answer `available: false`.
 */
import {chatMessagesOf, takeLines, type ChatMessage} from '../../domain/session/chat';
import type {ClientMessage} from '../../domain/phone/protocol';
import type {SessionRegistry} from '../model/session-registry';
import type {Timers, TimerHandle} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {DeviceConnection} from '../ports/phone-access';
import type {TranscriptStore} from '../ports/transcript-store';

/** How often a subscribed transcript is looked at. */
export const CHAT_POLL_MS = 1000;
/** How much of a transcript's end the first read takes. */
export const CHAT_FIRST_READ_BYTES = 4 * 1024 * 1024;
/** How much one later read takes; a tick reads on until it is caught up. */
export const CHAT_READ_BYTES = 1024 * 1024;
/** The most messages a `chat` carries: the latest ones. */
export const MAX_CHAT_MESSAGES = 200;

export interface PhoneChatServiceDeps {
    registry: Pick<SessionRegistry, 'find'>;
    transcripts: Pick<TranscriptStore, 'readFrom'>;
    timers: Timers;
    log: Logger;
}

/** One phone following one session's chat. */
interface Subscription {
    readonly connection: DeviceConnection;
    /** The session's current id, which is also its transcript's name. */
    sessionId: string;
    readonly folder: string;
    /** The byte the next read starts at. */
    offset: number;
    midLine: boolean;
}

type ChatRequest = Extract<ClientMessage, {type: 'chat-subscribe' | 'chat-unsubscribe'}>;

export class PhoneChatService {
    /** By connection id, then by session id. */
    private readonly subscriptions = new Map<string, Map<string, Subscription>>();
    private poller: TimerHandle | null = null;

    constructor(private readonly deps: PhoneChatServiceDeps) {}

    public message(connection: DeviceConnection, message: ChatRequest): void {
        if (message.type === 'chat-subscribe') this.subscribe(connection, message.sessionId);
        else this.unsubscribe(connection, message.sessionId);
    }

    public disconnected(connection: DeviceConnection): void {
        this.subscriptions.delete(connection.id);
        this.stopPollingIfIdle();
    }

    /**
     * A fork or plan accept moved the session onto a new transcript: each
     * subscriber's chat starts over from it, under the new id, which the phone
     * has just been told of (`session-rekeyed`).
     */
    public sessionForked(oldId: string, newId: string): void {
        if (oldId === newId) return;
        for (const byId of this.subscriptions.values()) {
            const subscription = byId.get(oldId);
            if (!subscription) continue;
            byId.delete(oldId);
            subscription.sessionId = newId;
            byId.set(newId, subscription);
            this.startOver(subscription);
        }
    }

    private subscribe(connection: DeviceConnection, requested: string): void {
        const found = this.deps.registry.find(requested);
        const folder = found && !found.session.isPlainTerminal ? found.session.projectFolder : null;
        if (!found || !folder) {
            connection.send({type: 'chat', sessionId: found?.key ?? requested, available: false, messages: []});
            return;
        }
        let byId = this.subscriptions.get(connection.id);
        if (!byId) {
            byId = new Map();
            this.subscriptions.set(connection.id, byId);
        }
        const subscription: Subscription = {connection, sessionId: found.key, folder, offset: 0, midLine: false};
        byId.set(found.key, subscription);
        this.startOver(subscription);
        this.schedulePoll();
    }

    private unsubscribe(connection: DeviceConnection, requested: string): void {
        const byId = this.subscriptions.get(connection.id);
        if (!byId) return;
        const sessionId = this.deps.registry.find(requested)?.key ?? requested;
        byId.delete(sessionId);
        if (byId.size === 0) this.subscriptions.delete(connection.id);
        this.stopPollingIfIdle();
    }

    /** The latest messages, whole, from a read of the transcript's end. */
    private startOver(subscription: Subscription): void {
        const {sessionId} = subscription;
        const size = this.sizeOf(subscription) ?? 0;
        subscription.offset = Math.max(0, size - CHAT_FIRST_READ_BYTES);
        subscription.midLine = subscription.offset > 0;
        const messages = this.readOn(subscription, CHAT_FIRST_READ_BYTES).slice(-MAX_CHAT_MESSAGES);
        subscription.connection.send({type: 'chat', sessionId, available: true, messages});
    }

    private schedulePoll(): void {
        if (this.poller !== null) return;
        this.poller = this.deps.timers.setTimeout(() => {
            this.poller = null;
            this.poll();
            if (this.subscriptions.size > 0) this.schedulePoll();
        }, CHAT_POLL_MS);
    }

    private poll(): void {
        for (const byId of this.subscriptions.values()) {
            for (const subscription of byId.values()) {
                try {
                    this.follow(subscription);
                } catch (err) {
                    this.deps.log.warn(`[phone] chat of ${subscription.sessionId}: ${(err as Error).message}`);
                }
            }
        }
    }

    /** Whatever the transcript gained since the last read; a transcript that shrank starts over. */
    private follow(subscription: Subscription): void {
        const {sessionId, offset} = subscription;
        const size = this.sizeOf(subscription);
        if (size === null || size === offset) return;
        if (size < offset) {
            this.startOver(subscription);
            return;
        }
        const messages = this.readOn(subscription, CHAT_READ_BYTES);
        if (messages.length > 0) subscription.connection.send({type: 'chat-append', sessionId, messages});
    }

    /** Read from the subscription's offset to the end, `limit` bytes at a time, moving the offset on. */
    private readOn(subscription: Subscription, limit: number): ChatMessage[] {
        const lines: string[] = [];
        for (;;) {
            const {folder, sessionId, offset, midLine} = subscription;
            const read = this.deps.transcripts.readFrom(folder, sessionId, offset, limit);
            if (!read) break;
            const bytes = Math.max(0, Math.min(read.size - offset, limit));
            if (bytes === 0) break;
            const more = read.size - offset > limit;
            const taken = takeLines({text: read.text, bytes, more, midLine});
            lines.push(...taken.lines);
            subscription.offset += taken.consumed;
            subscription.midLine = taken.midLine;
            if (!more || taken.consumed === 0) break;
        }
        return chatMessagesOf(lines);
    }

    /** The transcript's size now (a read of no bytes), or null while there is none. */
    private sizeOf({folder, sessionId}: Subscription): number | null {
        return this.deps.transcripts.readFrom(folder, sessionId, 0, 0)?.size ?? null;
    }

    private stopPollingIfIdle(): void {
        if (this.subscriptions.size > 0 || this.poller === null) return;
        this.deps.timers.clearTimeout(this.poller);
        this.poller = null;
    }
}
