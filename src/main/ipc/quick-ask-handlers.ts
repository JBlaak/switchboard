/**
 * Quick Ask (#142): what the pop-up asks of main.
 *
 * The window's own plumbing, hiding it and letting the mouse through beside
 * the slab, is here to stay. The rest is a STUB, until #149 brings
 * `QuickAskService`: it routes nothing, and answers with a canned reply after
 * a short wait, so the pop-up can be built and tested on its own. Under the
 * e2e harness, `globalThis.__switchboardTestHooks.quickAskStub` picks the reply.
 */
import path from 'node:path';
import { INVOKE, SEND } from '../../ipc/channels';
import type { QuickAskReply } from '../../ipc/quick-ask-api';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerQuickAskHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.on(SEND.quickAskDismiss, () => app.quickAskPanel.hide());
  ipc.on(SEND.quickAskPointerOverSlab, (over: boolean) => app.quickAskWindow()?.pointerOverSlab(!!over));
  registerQuickAskStub(ipc, app);
}

// ── STUB: replaced by #149 ──

/** The replies the stub can give a send. */
export type StubReplyKind = 'started' | 'choose' | 'handedOff';

/** How long the stub "thinks" before it answers. */
const STUB_DELAY_MS = 800;

const STUB_CANDIDATES = [
  { projectPath: '/Users/example/Development/example', folder: 'example' },
  { projectPath: '/Users/example/Development/example-api', folder: 'example-api' },
  { projectPath: '/Users/example/Development/example-web', folder: 'example-web' },
];

function stubReply(kind: StubReplyKind): QuickAskReply {
  switch (kind) {
    case 'started': return { kind: 'started', folder: 'example' };
    case 'choose': return { kind: 'choose', candidates: STUB_CANDIDATES };
    case 'handedOff': return { kind: 'handedOff' };
  }
}

function registerQuickAskStub(ipc: IpcRegistrar, app: Container): void {
  let reply: StubReplyKind = 'started';
  let delayMs = STUB_DELAY_MS;
  let pending: { timer: ReturnType<typeof setTimeout>; resolve(reply: QuickAskReply): void } | null = null;

  if (process.env.SWITCHBOARD_E2E === '1') {
    const hooks = globalThis as typeof globalThis & { __switchboardTestHooks?: Record<string, unknown> };
    hooks.__switchboardTestHooks = {
      ...hooks.__switchboardTestHooks,
      quickAskStub: {
        answer: (kind: StubReplyKind, ms = STUB_DELAY_MS) => { reply = kind; delayMs = ms; },
      },
    };
  }

  ipc.handle(INVOKE.quickAskRoute, (text: string) => {
    app.log.info(`[quick-ask] stub route: ${String(text).length} chars`);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: 'unlocked' });
    }
    return new Promise<QuickAskReply>((resolve) => {
      const timer = setTimeout(() => { pending = null; resolve(stubReply(reply)); }, delayMs);
      pending = { timer, resolve };
    });
  });
  ipc.handle(INVOKE.quickAskCancel, () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve({ kind: 'unlocked' });
    pending = null;
  });
  ipc.handle(INVOKE.quickAskStart, (projectPath: string): QuickAskReply =>
    ({ kind: 'started', folder: path.basename(String(projectPath)) }));
  ipc.handle(INVOKE.quickAskOpenPicker, () => app.log.info('[quick-ask] stub picker'));
  ipc.handle(INVOKE.quickAskUndo, () => ({ ok: false }));
}
