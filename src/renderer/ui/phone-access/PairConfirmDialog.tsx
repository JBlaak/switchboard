/**
 * "Pair 'Pixel 9 Pro'?" (#194): up whenever main has a phone waiting for the
 * user's word, over whatever is on screen.
 *
 * Not one of the dialog layer's dialogs (`state/dialog-slice`): nobody opens
 * it, main's snapshot does, and it must not replace a dialog the user has
 * open. It steps aside as soon as it is answered, and comes back with the
 * reason if main could not take the answer. Esc and a click outside are
 * Don't pair, the safe answer.
 */
import { confirmShownIn } from '../../state/phone-access-slice';
import { useStore } from '../use-store';
import { DialogShell } from '../dialogs/DialogShell';
import { confirmPairing } from './actions';
import { PhoneIcon } from './icons';
import { failureLine } from './phone-access-copy';
import type { JSX } from 'react';

export function PairConfirmDialog(): JSX.Element | null {
  const request = useStore(s => confirmShownIn(s.phoneAccess));
  const failure = useStore(s => s.phoneAccess.failure);
  if (!request) return null;
  const { requestId, deviceName } = request;
  const answer = (accept: boolean): void => void confirmPairing(requestId, accept);

  return (
    <DialogShell key={requestId} overlayClass="new-session-overlay" dialogClass="new-session-dialog pa-confirm"
      onClose={() => answer(false)}>
      <div className="pa-confirm-head">
        <span className="pa-confirm-icon"><PhoneIcon size={22} strokeWidth={1.6} /></span>
        <h3>{`Pair “${deviceName}”?`}</h3>
      </div>
      <p className="pa-confirm-body">
        This phone will be able to see your running sessions, watch their terminals, answer their questions and
        type into them, whenever Phone access is on.
      </p>
      <p className="pa-confirm-note">
        Only pair a phone you're holding right now. You can revoke it any time in Settings → Phone access.
      </p>
      {failure?.call === 'confirm' && <div className="pa-error" role="alert">{failureLine(failure)}</div>}
      <div className="pa-confirm-actions">
        <button type="button" className="settings-cancel-btn" onClick={() => answer(false)}>Don't pair</button>
        <button type="button" className="settings-save-btn" onClick={() => answer(true)}>Pair</button>
      </div>
    </DialogShell>
  );
}
