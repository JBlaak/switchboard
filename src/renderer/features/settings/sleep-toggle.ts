/**
 * The sidebar toolbar's "can this Mac sleep?" button.
 *
 * It mirrors `pmset disablesleep`: a faint zzz while the Mac may sleep, an
 * amber coffee cup while sleep is disabled. The switch is also flipped from a
 * terminal, so the state is read again whenever the window regains focus and
 * once a minute, rather than trusted from the last click. Hidden on hosts that
 * cannot answer.
 */
import { ICONS } from '../../lib/icons';

const POLL_MS = 60_000;

function render(button: HTMLButtonElement, disabled: boolean | null): void {
  button.hidden = disabled === null;
  button.classList.toggle('sleep-disabled', disabled === true);
  button.innerHTML = disabled ? ICONS.coffee(18) : ICONS.sleep(18);
  button.title = disabled
    ? 'Sleep is disabled: this Mac stays awake (click to allow sleep)'
    : 'This Mac can sleep (click to keep it awake)';
}

export function installSleepToggle(): void {
  const button = document.getElementById('sleep-toggle-btn') as HTMLButtonElement | null;
  if (!button) return;

  let disabled: boolean | null = null;

  const refresh = async (): Promise<void> => {
    if (button.disabled) return;
    disabled = await window.api.getSleepDisabled();
    render(button, disabled);
  };

  button.addEventListener('click', async () => {
    if (disabled === null || button.disabled) return;
    // Waits on the result rather than flipping optimistically: the click may
    // open a password prompt, and a cancelled one leaves the switch as it was.
    button.disabled = true;
    try {
      disabled = await window.api.setSleepDisabled(!disabled);
    } finally {
      button.disabled = false;
    }
    render(button, disabled);
  });

  window.addEventListener('focus', () => { void refresh(); });
  setInterval(() => { void refresh(); }, POLL_MS);
  void refresh();
}
