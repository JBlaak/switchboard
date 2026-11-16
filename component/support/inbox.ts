/**
 * Main's inbox (#413) for the Bug and Issue manager pages, played by the fake
 * api: it holds the items a test starts with and changes them the way main's
 * inbox and its Fix and Start flows do, with the same domain functions
 * (src/domain/inbox/items.ts), pushing the counts after each change as main
 * does. Nothing reaches Bugsnag or GitHub: a bug's detail and trend answer
 * nothing, as they do in e2e with no token saved.
 *
 * ```ts
 * test.use({inbox: {items: [ISSUE]}});
 * test('…', async ({page, mainInbox}) => { … mainInbox.item(KEY) … });
 * ```
 *
 * Built on the component `test`; a Fix or a Start names its
 * session in the renderer.
 */
import {test as base} from './test';
import {
    inboxSummary,
    markRead,
    returnToInbox,
    setNotes,
    setWork,
    snooze,
    startWork,
    toBacklog,
} from '../../src/domain/inbox/items';
import type {FakeApi} from './fake-api';
import type {ConfiguredManagers, InboxItem} from '../../src/domain/inbox/model';
import {NO_INBOX_FRESHNESS, type InboxFreshness} from '../../src/domain/inbox/freshness';

export class FakeInbox {
    private readonly items = new Map<string, InboxItem>();

    constructor(
        private readonly api: FakeApi,
        items: readonly InboxItem[],
        private readonly configured: ConfiguredManagers,
        private readonly freshness: InboxFreshness = NO_INBOX_FRESHNESS,
    ) {
        for (const item of items) this.items.set(item.key, item);
        api.handle('inboxSummary', () => this.summary());
        api.handle('inboxItems', (manager) => [...this.items.values()].filter((item) => item.manager === manager));
        api.handle('inboxPolledAt', () => null);
        api.handle('inboxSnoozeOptions', () => []);
        api.handle('inboxMarkRead', (key) => this.change(key, markRead));
        api.handle('inboxSnooze', (key, until) =>
            this.change(key, (item) => snooze(item, until === null ? null : Date.parse(until))),
        );
        api.handle('inboxBacklog', (key) => this.change(key, toBacklog));
        api.handle('inboxSetNotes', (key, notes) => this.change(key, (item) => setNotes(item, notes)));
        // No Bugsnag token: the detail pane's reads answer nothing.
        api.handle('bugDetail', () => null);
        api.handle('bugTrend', () => []);
        api.handle('bugStopWorking', (key) => this.change(key, (item) => returnToInbox(item, 'stopped')));
        api.handle('issueManagerStarted', (key, branch, sessionId) =>
            this.change(key, (item) => setWork(startWork(item), {branch, sessionId, pullRequest: null})),
        );
    }

    /** The item as main holds it now. */
    public item(key: string): InboxItem | undefined {
        return this.items.get(key);
    }

    /** Change an item as main does: written, answered, and the counts pushed. */
    public async change(key: string, apply: (item: InboxItem) => InboxItem): Promise<InboxItem | null> {
        const before = this.items.get(key);
        if (!before) return null;
        const after = apply(before);
        this.items.set(key, after);
        if (after !== before) await this.api.emit('onInboxChanged', this.summary());
        return after;
    }

    public summary() {
        return inboxSummary([...this.items.values()], this.configured, undefined, this.freshness);
    }
}

export interface InboxOptions {
    /**
     * The items main's inbox holds at launch, and which managers are set up
     * (both by default), and how fresh each manager is (nothing read yet by
     * default). An object, as a fixture option given as an array is
     * read as Playwright's `[value, options]`.
     */
    inbox: {items: InboxItem[]; configured?: ConfiguredManagers; freshness?: InboxFreshness};
}

const stores = new WeakMap<FakeApi, FakeInbox>();

export const test = base.extend<InboxOptions & {mainInbox: FakeInbox}>({
    inbox: [{items: []}, {option: true}],
    // In place before the page loads, which asks for the summary first.
    api: async ({api, inbox}, use) => {
        stores.set(api, new FakeInbox(api, inbox.items, inbox.configured ?? {bug: true, issue: true}, inbox.freshness));
        await use(api);
    },
    mainInbox: async ({api}, use) => {
        await use(stores.get(api)!);
    },
});

export {expect} from './test';
