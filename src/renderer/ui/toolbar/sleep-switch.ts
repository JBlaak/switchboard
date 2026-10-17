/**
 * The sleep switch: what `pmset` says, read again on focus and every minute,
 * and a click that waits for main's answer.
 *
 * Apart from the toolbar's other actions so it imports nothing but the store:
 * with `window.api` stood in for, it runs in node.
 */
import { dispatch, getState } from '../../state/app-store';

/**
 * The switch is also flipped from a terminal (`pmset disablesleep`), so the
 * state is read again whenever the window regains focus and once a minute,
 * rather than trusted from the last click.
 */
const SLEEP_POLL_MS = 60_000;

export function watchSleepState(): void {
  window.addEventListener('focus', () => { void readSleepState(); });
  setInterval(() => { void readSleepState(); }, SLEEP_POLL_MS);
  void readSleepState();
}

async function readSleepState(): Promise<void> {
  // A read mid-click would show the old state before the answer lands.
  if (getState().toolbar.sleepPending) return;
  dispatch({ type: 'sleepStateRead', disabled: await window.api.getSleepDisabled() });
}

/**
 * Waits on the result rather than flipping optimistically: the click may open
 * a password prompt, and a cancelled one leaves the switch as it was.
 */
export async function toggleSleep(): Promise<void> {
  const { sleepDisabled, sleepPending } = getState().toolbar;
  if (sleepDisabled === null || sleepPending) return;
  dispatch({ type: 'sleepSwitchPending', pending: true });
  try {
    dispatch({ type: 'sleepStateRead', disabled: await window.api.setSleepDisabled(!sleepDisabled) });
  } finally {
    dispatch({ type: 'sleepSwitchPending', pending: false });
  }
}
