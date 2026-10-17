import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, getState } from '../src/renderer/state/app-store';
import { toggleSleep, watchSleepState } from '../src/renderer/ui/toolbar/sleep-switch';

// The switch reads and writes the app's one store; each test sets the part it
// starts from.

/** A host whose `pmset` says `disabled`, and whose switch answers when told to. */
interface FakeHost {
  disabled: boolean | null;
  /** Each click's answer, released by `answer()`; none pending answers at once. */
  answer: ((disabled: boolean | null) => void) | null;
  holdAnswers: boolean;
  clicks: boolean[];
  focus: () => void;
}

function installHost(disabled: boolean | null, { holdAnswers = false } = {}): FakeHost {
  const focusListeners: (() => void)[] = [];
  const host: FakeHost = {
    disabled, answer: null, holdAnswers, clicks: [],
    focus: () => focusListeners.forEach(listener => listener()),
  };
  const api = {
    getSleepDisabled: async () => host.disabled,
    setSleepDisabled: (want: boolean) => {
      host.clicks.push(want);
      if (!host.holdAnswers) return Promise.resolve(want);
      return new Promise<boolean | null>((resolve) => { host.answer = resolve; });
    },
  };
  Object.assign(globalThis, {
    window: {
      api,
      addEventListener: (type: string, listener: () => void) => { if (type === 'focus') focusListeners.push(listener); },
    },
  });
  return host;
}

/** Start from what the switch last showed. */
function showing(disabled: boolean | null): void {
  dispatch({ type: 'sleepSwitchPending', pending: false });
  dispatch({ type: 'sleepStateRead', disabled });
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// The watch polls on an interval; a real one would keep the test run alive.
beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => mock.timers.reset());

test('a click waits on main, showing the old state meanwhile', () => {
  /* Given */
  installHost(false, { holdAnswers: true });
  showing(false);

  /* When */
  void toggleSleep();

  /* Then */
  assert.equal(getState().toolbar.sleepPending, true);
  assert.equal(getState().toolbar.sleepDisabled, false);
});

test('main\'s answer is what the switch then shows', async () => {
  /* Given */
  const host = installHost(false);
  showing(false);

  /* When */
  await toggleSleep();

  /* Then */
  assert.deepEqual(host.clicks, [true]);
  assert.equal(getState().toolbar.sleepPending, false);
  assert.equal(getState().toolbar.sleepDisabled, true);
});

test('a cancelled prompt answers the old state, which stays', async () => {
  /* Given */
  const host = installHost(false, { holdAnswers: true });
  showing(false);
  const click = toggleSleep();

  /* When */
  host.answer!(false);
  await click;

  /* Then */
  assert.equal(getState().toolbar.sleepPending, false);
  assert.equal(getState().toolbar.sleepDisabled, false);
});

test('a click on a host that cannot say does nothing', async () => {
  /* Given */
  const host = installHost(null);
  showing(null);

  /* When */
  await toggleSleep();

  /* Then */
  assert.deepEqual(host.clicks, []);
});

test('a second click while the first waits does nothing', () => {
  /* Given */
  const host = installHost(false, { holdAnswers: true });
  showing(false);
  void toggleSleep();

  /* When */
  void toggleSleep();

  /* Then */
  assert.deepEqual(host.clicks, [true]);
});

test('the state is read once the watch starts', async () => {
  /* Given */
  installHost(true);
  showing(false);

  /* When */
  watchSleepState();
  await settle();

  /* Then */
  assert.equal(getState().toolbar.sleepDisabled, true);
});

test('the state is read again when the window regains focus', async () => {
  /* Given */
  const host = installHost(false);
  showing(false);
  watchSleepState();
  await settle();
  host.disabled = true;

  /* When */
  host.focus();
  await settle();

  /* Then */
  assert.equal(getState().toolbar.sleepDisabled, true);
});

test('the state is read again every minute', async () => {
  /* Given */
  const host = installHost(false);
  showing(false);
  watchSleepState();
  await settle();
  host.disabled = true;

  /* When */
  mock.timers.tick(59_999);
  await settle();
  const beforeTheMinute = getState().toolbar.sleepDisabled;
  mock.timers.tick(1);
  await settle();

  /* Then */
  assert.equal(beforeTheMinute, false);
  assert.equal(getState().toolbar.sleepDisabled, true);
});

test('a read while a click waits on its answer is dropped', async () => {
  /* Given */
  const host = installHost(false, { holdAnswers: true });
  showing(false);
  watchSleepState();
  void toggleSleep();
  host.disabled = true;

  /* When */
  host.focus();
  await settle();

  /* Then */
  assert.equal(getState().toolbar.sleepDisabled, false);
});
