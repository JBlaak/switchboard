import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  attentionSessions, clearActivity, clearNotifications, clearUnread, markNeedsAttention,
  markUnread, notifyActivityChanged, onActivityChange, responseReadySessions, sessionBusyState,
  setActivity,
} from '../src/renderer/state/activity-store';
import { onSidebarRefresh, refreshSidebar, setSidebarRefresher } from '../src/renderer/app/refresh';

// The store paints the affected row as a side effect, through
// `document.querySelector`. Under Node there is no document, so the mutators
// would throw before the listeners were reached. A query that finds nothing is
// exactly what the store sees before the sidebar has rendered, and every paint
// is already written as `rowFor(id)?.…`, so this is all the DOM it needs.
const g = globalThis as { document?: unknown };
if (g.document === undefined) g.document = { querySelector: () => null };

/** Run `fn` with console.error captured, so a deliberate failure stays quiet. */
function capturingErrors(fn: () => void): unknown[][] {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logged;
}

beforeEach(() => {
  attentionSessions.clear();
  responseReadySessions.clear();
  sessionBusyState.clear();
  setSidebarRefresher(() => {});
});

test('an activity listener hears each notification until it unsubscribes', () => {
  const heard: (string | null)[] = [];
  const off = onActivityChange(id => heard.push(id));

  notifyActivityChanged('a');
  // No argument means "the live set changed; recompute everything".
  notifyActivityChanged();
  assert.deepStrictEqual(heard, ['a', null]);

  off();
  notifyActivityChanged('b');
  assert.deepStrictEqual(heard, ['a', null]);
});

test('every mutator names the session it changed', () => {
  const heard: (string | null)[] = [];
  const off = onActivityChange(id => heard.push(id));
  try {
    setActivity('a', true);
    markNeedsAttention('b');
    markUnread('c');
    clearUnread('c');
    clearNotifications('b');
    clearActivity('a');
    assert.deepStrictEqual(heard, ['a', 'b', 'c', 'c', 'b', 'b', 'a']);
  } finally {
    off();
  }
});

test('a mutator that changes nothing stays silent', () => {
  const heard: (string | null)[] = [];
  const off = onActivityChange(id => heard.push(id));
  try {
    // An idle signal while the answer is unread is ignored, and so is clearing
    // a session that had nothing recorded — the poll does that for every
    // stopped row, every few seconds.
    markUnread('a');
    heard.length = 0;
    setActivity('a', false);
    clearActivity('never-seen');
    assert.deepStrictEqual(heard, []);
  } finally {
    off();
  }
});

test('a throwing listener neither breaks the mutator nor the listeners after it', () => {
  const heard: (string | null)[] = [];
  const offBad = onActivityChange(() => { throw new Error('badge failed to draw'); });
  const offGood = onActivityChange(id => heard.push(id));
  try {
    const logged = capturingErrors(() => markUnread('a'));
    // The state change landed, the good listener heard it, the failure was logged.
    assert.strictEqual(responseReadySessions.has('a'), true);
    assert.deepStrictEqual(heard, ['a']);
    assert.strictEqual(logged.length, 1);
  } finally {
    offBad();
    offGood();
  }
});

test('sidebar refresh listeners run after the refresher, with the same options', () => {
  const order: string[] = [];
  setSidebarRefresher(options => order.push(`render:${options?.resort ?? false}`));
  const off = onSidebarRefresh(options => order.push(`observe:${options?.resort ?? false}`));
  try {
    refreshSidebar({ resort: true });
    assert.deepStrictEqual(order, ['render:true', 'observe:true']);

    off();
    refreshSidebar();
    assert.deepStrictEqual(order, ['render:true', 'observe:true', 'render:false']);
  } finally {
    off();
  }
});

test('a throwing refresh listener is logged and the rest still run', () => {
  const order: string[] = [];
  const offBad = onSidebarRefresh(() => { throw new Error('rail failed'); });
  const offGood = onSidebarRefresh(() => order.push('observe'));
  try {
    const logged = capturingErrors(() => refreshSidebar());
    assert.deepStrictEqual(order, ['observe']);
    assert.strictEqual(logged.length, 1);
  } finally {
    offBad();
    offGood();
  }
});
