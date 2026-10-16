/**
 * The "can this Mac sleep?" button: a faint zzz while it may, an amber coffee
 * cup while `pmset disablesleep` keeps it awake. Hidden on a host that cannot
 * say, and disabled while a click waits on its answer.
 */
import { ICONS } from '../../lib/icons';
import { useStore } from '../use-store';
import { toggleSleep } from './actions';
import type { JSX } from 'react';

export function SleepToggle(): JSX.Element {
  const disabled = useStore(s => s.toolbar.sleepDisabled);
  const pending = useStore(s => s.toolbar.sleepPending);
  return (
    <button
      id="sleep-toggle-btn"
      hidden={disabled === null}
      disabled={pending}
      className={disabled ? 'sleep-disabled' : undefined}
      title={disabled
        ? 'Sleep is disabled: this Mac stays awake (click to allow sleep)'
        : 'This Mac can sleep (click to keep it awake)'}
      dangerouslySetInnerHTML={{ __html: disabled ? ICONS.coffee(18) : ICONS.sleep(18) }}
      onClick={() => void toggleSleep()}
    />
  );
}
