/**
 * The managers' inbox (#413): both managers' counts, a manager's items, and
 * what the pages do to an item from the renderer (seen, snooze, backlog,
 * notes). Starting, staging and finishing an item are main's own, from the
 * Fix and Start flows (#414, #415): the Issue manager's are here too.
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerInboxHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.inboxSummary, () => app.inbox.summary());
    ipc.handle(INVOKE.inboxItems, (manager: unknown) => {
        if (manager !== 'bug' && manager !== 'issue') throw new Error('a manager is bug or issue');
        return app.inbox.list(manager);
    });
    ipc.handle(INVOKE.inboxMarkRead, (key: unknown) => app.inbox.markRead(asKey(key)));
    ipc.handle(INVOKE.inboxSnooze, (key: unknown, until: unknown) => {
        if (until === null) return app.inbox.snooze(asKey(key), null);
        const at = typeof until === 'string' ? Date.parse(until) : NaN;
        if (!Number.isFinite(at)) throw new Error('a snooze is until a time, or null');
        return app.inbox.snooze(asKey(key), at);
    });
    ipc.handle(INVOKE.inboxBacklog, (key: unknown) => app.inbox.backlog(asKey(key)));
    ipc.handle(INVOKE.inboxSetNotes, (key: unknown, notes: unknown) => {
        if (typeof notes !== 'string') throw new Error('notes are text');
        return app.inbox.setNotes(asKey(key), notes);
    });

    // The Issue manager page (#415): its thread, comments, Start and Stop.
    ipc.handle(INVOKE.issueManagerThread, (key: unknown) => app.issueManager.thread(asKey(key)));
    ipc.handle(INVOKE.issueManagerPolish, (key: unknown, notes: unknown) =>
        app.issueManager.polish(asKey(key), asText(notes)),
    );
    ipc.handle(INVOKE.issueManagerPost, (key: unknown, body: unknown) =>
        app.issueManager.post(asKey(key), asText(body)),
    );
    ipc.handle(INVOKE.issueManagerPolishAndPost, (key: unknown, notes: unknown) =>
        app.issueManager.polishAndPost(asKey(key), asText(notes)),
    );
    ipc.handle(INVOKE.issueManagerPrepareStart, (key: unknown) => app.issueManager.prepareStart(asKey(key)));
    ipc.handle(INVOKE.issueManagerStarted, (key: unknown, branch: unknown, sessionId: unknown) =>
        app.issueManager.started(asKey(key), asText(branch), typeof sessionId === 'string' ? sessionId : null),
    );
    ipc.handle(INVOKE.issueManagerStopWork, (key: unknown, unassign: unknown) =>
        app.issueManager.stopWork(asKey(key), unassign === true),
    );
}

function asText(value: unknown): string {
    if (typeof value !== 'string') throw new Error('expected text');
    return value;
}

function asKey(key: unknown): string {
    if (typeof key !== 'string' || key === '') throw new Error('an inbox key is text');
    return key;
}
