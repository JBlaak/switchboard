/**
 * A stand-in for `window.api`, the renderer's one port to the main process.
 *
 * The renderer only ever reaches main through `SwitchboardApi` (src/ipc/api.ts),
 * so a component test loads the built renderer in a plain browser page and
 * puts this in the preload's place. No Electron, no fixture home, no database:
 * each call lands in the test, which answers it.
 *
 * - **Invokes** (`getProjects`, `archiveSession`, …) go to the handler the test
 *   set with `handle` or `answer`, or to `DEFAULT_ANSWERS`, and are recorded.
 * - **Sends** (`sendInput`, `resizeTerminal`, …) are recorded and answer nothing.
 * - **Subscriptions** (`onStatusUpdate`, …) are kept in the page; `emit` calls
 *   them, which is what main's `webContents.send` would have done.
 *
 * Handlers run in node, so they can close over the test's own state.
 */
import type {Page} from '@playwright/test';
import type {SwitchboardApi} from '../../src/ipc/api';
import {DEFAULT_ANSWERS} from './default-answers';

/** The methods that push from main: `onX(callback) => Unsubscribe`. */
export type EventName = {
    [K in keyof SwitchboardApi]: K extends `on${Capitalize<string>}` ? K : never;
}[keyof SwitchboardApi];

/** The methods the renderer calls. */
export type CallName = Exclude<keyof SwitchboardApi, EventName | 'getPathForFile'>;

type Method<K extends keyof SwitchboardApi> = SwitchboardApi[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : never;
type Args<K extends keyof SwitchboardApi> = Parameters<Method<K>>;
type Answer<K extends CallName> = Awaited<ReturnType<Method<K>>>;
type Callback<K extends EventName> = Parameters<Method<K>>[0];
type EventArgs<K extends EventName> = Callback<K> extends (...args: infer A) => unknown ? A : never;

export type Handler<K extends CallName> = (...args: Args<K>) => Answer<K> | Promise<Answer<K>>;

export interface Call {
    name: CallName;
    args: unknown[];
}

/** Sends: they return nothing, so the page does not wait for the test. */
const SENDS: readonly CallName[] = [
    'sendInput',
    'resizeTerminal',
    'closeTerminal',
    'closeSessionWork',
    'startWindowDrag',
    'moveWindowDrag',
    'endWindowDrag',
    'setNeedsInputCount',
    'rendererReady',
];

export class FakeApi {
    private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
    private page: Page | null = null;
    /** Every call the renderer made, in order. */
    public readonly calls: Call[] = [];
    /** Calls nothing answered: no handler and no default. */
    public readonly unhandled: CallName[] = [];
    /**
     * The settings store behind `getSetting`/`setSetting`, as main's would be:
     * what the renderer saves, it reads back.
     */
    public readonly settings: Record<string, unknown>;

    constructor(settings: Record<string, unknown> = {}) {
        this.settings = {...settings};
        this.handle('getSetting', (key) => (key in this.settings ? this.settings[key] : null) as never);
        this.handle('setSetting', (key, value) => {
            this.settings[key] = value;
            return {ok: true};
        });
    }

    /** Answer `name` with `handler` from now on, replacing what answered it. */
    public handle<K extends CallName>(name: K, handler: Handler<K>): this {
        this.handlers.set(name, handler as (...args: unknown[]) => unknown);
        return this;
    }

    /** Answer `name` with `value` from now on. */
    public answer<K extends CallName>(name: K, value: Answer<K>): this {
        return this.handle(name, () => value);
    }

    /** The arguments of each call to `name`, in order. */
    public callsTo<K extends CallName>(name: K): Args<K>[] {
        return this.calls.filter((call) => call.name === name).map((call) => call.args as Args<K>);
    }

    /** Push an event to the renderer, as main's `webContents.send` would. */
    public async emit<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<void> {
        if (!this.page) throw new Error(`emit('${name}') before the renderer was loaded`);
        await this.page.evaluate(([event, payload]) => window.__fakeApi!.emit(event, payload), [name, args] as const);
    }

    /** Put the fake in the preload's place on `page`, before any of its scripts run. */
    public async install(page: Page): Promise<void> {
        this.page = page;
        await page.exposeFunction('__fakeApiCall', (name: CallName, args: unknown[]) => this.call(name, args));
        await page.addInitScript(installInPage, SENDS);
    }

    private async call(name: CallName, args: unknown[]): Promise<unknown> {
        this.calls.push({name, args});
        const handler = this.handlers.get(name);
        if (handler) return handler(...args);
        if (SENDS.includes(name)) return undefined;
        if (!(name in DEFAULT_ANSWERS)) {
            this.unhandled.push(name);
            return undefined;
        }
        const fallback = (DEFAULT_ANSWERS as Record<string, unknown>)[name];
        return typeof fallback === 'function' ? (fallback as (...a: unknown[]) => unknown)(...args) : fallback;
    }
}

declare global {
    interface Window {
        __fakeApi?: {emit(event: string, args: readonly unknown[]): void};
        __fakeApiCall?: (name: string, args: unknown[]) => Promise<unknown>;
    }
}

/** Runs in the page, before the renderer's bundle: builds `window.api`. */
function installInPage(sends: readonly string[]): void {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const sendSet = new Set(sends);
    const call = (name: string, args: unknown[]): Promise<unknown> => window.__fakeApiCall!(name, args);
    const api = new Proxy(
        {},
        {
            get(_target, name) {
                // Not a method: keeps `await api` and console inspection sane.
                if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
                if (/^on[A-Z]/.test(name)) {
                    return (callback: (...args: unknown[]) => void) => {
                        let set = listeners.get(name);
                        if (!set) listeners.set(name, (set = new Set()));
                        set.add(callback);
                        return () => set.delete(callback);
                    };
                }
                if (name === 'getPathForFile') return (file: File) => `/dropped/${file.name}`;
                if (sendSet.has(name)) {
                    return (...args: unknown[]) => {
                        void call(name, args);
                    };
                }
                return (...args: unknown[]) => call(name, args);
            },
        },
    );
    Object.defineProperty(window, 'api', {value: api});
    // As the preload does under the harness: installs the terminal probe.
    Object.defineProperty(window, 'switchboardE2E', {value: true});
    window.__fakeApi = {
        emit(event, args) {
            for (const callback of listeners.get(event) ?? []) callback(...args);
        },
    };
}
