/**
 * The toolbar's reminder that Phone access is on (#194): a quiet "On" pill
 * while it listens with no phone attached, mint with the phone's name while
 * one is, and nothing at all while it is off. A click opens Settings at the
 * Phone access section.
 */
import { shallowEqual } from '../../state/store';
import { phoneIndicatorIn } from '../../state/phone-access-slice';
import { useStore } from '../use-store';
import { openPhoneAccessSettings } from './open-settings';
import { PhoneIcon } from './icons';
import type { JSX } from 'react';

export function PhoneIndicator(): JSX.Element | null {
  const indicator = useStore(s => phoneIndicatorIn(s.phoneAccess.access), shallowEqual);
  if (!indicator) return null;
  return (
    <button
      type="button"
      id="phone-access-indicator"
      className={indicator.connected ? 'is-connected' : undefined}
      title={indicator.title}
      aria-label={indicator.title}
      onClick={() => void openPhoneAccessSettings()}
    >
      <PhoneIcon />
      <span className="pa-indicator-label">{indicator.label}</span>
    </button>
  );
}
