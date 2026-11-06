/**
 * The toolbar's sign that a phone is connected (#194): mint with the phone's
 * name while one is, and nothing at all otherwise. A click opens Settings at
 * the Phone access section.
 */
import {shallowEqual} from '../../state/store';
import {phoneIndicatorIn} from '../../state/phone-access-slice';
import {useStore} from '../use-store';
import {openPhoneAccessSettings} from './open-settings';
import {PhoneIcon} from './icons';
import type {JSX} from 'react';

export function PhoneIndicator(): JSX.Element | null {
    const indicator = useStore((s) => phoneIndicatorIn(s.phoneAccess.access), shallowEqual);
    if (!indicator) return null;
    return (
        <button
            type="button"
            id="phone-access-indicator"
            title={indicator.title}
            aria-label={indicator.title}
            onClick={() => void openPhoneAccessSettings()}>
            <PhoneIcon />
            <span className="pa-indicator-label">{indicator.label}</span>
        </button>
    );
}
