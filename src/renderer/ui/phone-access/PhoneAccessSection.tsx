/**
 * Settings → Phone access (#194): the switch, the listening line, pairing a
 * phone with its QR code, the paired phones, and resetting this Mac's
 * identity.
 *
 * A card of the settings form like the others, but not part of its Save:
 * every control here acts at once, through main, and draws what main
 * answers (`state/phone-access-slice`).
 */
import { useStore } from '../use-store';
import { AppField } from '../settings/SettingsField';
import { switchShownIn } from '../../state/phone-access-slice';
import {
  PHONE_ACCESS_SECTION_ID, resetIdentity, revokeDevice, setPhoneAccessEnabled, startPairing, stopPairing,
} from './actions';
import { deviceLine, failureLine, listeningLine, pairingTimeLeft } from './phone-access-copy';
import { PhoneIcon } from './icons';
import { QrImage } from './QrImage';
import { useNow } from './use-now';
import type { JSX } from 'react';
import type { PhoneAccessState, PhoneDeviceView } from '../../../domain/phone/state';

export function PhoneAccessSection(): JSX.Element {
  const access = useStore(s => s.phoneAccess.access);
  const on = useStore(s => switchShownIn(s.phoneAccess));
  const failure = useStore(s => s.phoneAccess.failure);
  // The device lines' "last seen" moves on while the settings are open.
  const now = useNow(30_000);

  return (
    <div className="settings-section pa-section" id={PHONE_ACCESS_SECTION_ID}>
      <div className="settings-section-title">Phone access</div>

      <AppField label="Phone access"
        description="Watch, answer and type into running sessions from a paired Android phone on this Wi-Fi. Every connection is mutually authenticated and encrypted.">
        <label className="settings-toggle">
          <input type="checkbox" id="sv-phone-access-enabled" aria-label="Phone access"
            checked={on} onChange={e => void setPhoneAccessEnabled(e.currentTarget.checked)} />
          <span className="settings-toggle-slider"></span>
        </label>
      </AppField>

      <ListeningLine access={access} />
      {failure && failure.call !== 'useHere' && <div className="pa-error" role="alert">{failureLine(failure)}</div>}

      {access.enabled && <Pairing access={access} />}

      <div className="settings-field pa-devices-field">
        <div className="settings-field-info">
          <span className="settings-label">Paired phones</span>
          {access.devices.length === 0
            ? <div className="settings-description">No phone is paired with this Mac yet.</div>
            : (
              <ul className="pa-devices" aria-label="Paired phones">
                {access.devices.map(device => <DeviceRow key={device.id} device={device} now={now} />)}
              </ul>
            )}
        </div>
      </div>

      <AppField label="Reset this Mac's identity"
        description="Makes a new key and un-pairs every phone. Use it if you think a key has leaked.">
        <button type="button" className="pa-btn pa-btn-danger-fill" onClick={() => void resetIdentity()}>Reset…</button>
      </AppField>
    </div>
  );
}

function ListeningLine({ access }: { access: PhoneAccessState }): JSX.Element | null {
  const line = listeningLine(access);
  if (!line) return null;
  if (line.kind === 'failed') {
    return <div className="pa-status is-failed" role="alert"><span className="pa-dot" />Not listening: {line.message}</div>;
  }
  if (line.kind === 'starting') {
    return <div className="pa-status is-starting"><span className="pa-dot" />Starting…</div>;
  }
  return (
    <div className="pa-status is-listening">
      <span className="pa-dot" />
      <span>Listening on Wi-Fi as <span className="pa-host">{line.host}</span>{line.connected && <> · {line.connected}</>}</span>
    </div>
  );
}

function Pairing({ access }: { access: PhoneAccessState }): JSX.Element {
  const { pairing } = access;
  const now = useNow(1000, !!pairing);
  const left = pairing ? pairingTimeLeft(pairing.expiresAt, now) : null;

  if (!pairing || left === null) {
    return (
      <AppField label="Pair a phone"
        description={pairing
          ? 'That code has run out. Make a new one to pair a phone.'
          : 'Shows a one-time QR code to scan with Switchboard on your phone.'}>
        <button type="button" className="pa-btn" disabled={!access.listening} onClick={() => void startPairing()}>
          {pairing ? 'New code' : 'Pair a phone'}
        </button>
      </AppField>
    );
  }

  return (
    <div className="settings-field pa-pairing">
      <div className="pa-qr-frame"><QrImage text={pairing.invite} label="Pairing code" /></div>
      <div className="pa-pairing-info">
        <span className="settings-label">Pair a phone</span>
        <ol className="pa-steps">
          <li>Open Switchboard on your phone.</li>
          <li>Scan this code.</li>
          <li>Confirm the phone's name here.</li>
        </ol>
        <div className="pa-expiry">
          <span className="pa-expiry-pill">Expires in {left}</span>
          <span className="pa-expiry-note">Works once</span>
        </div>
        <div>
          <button type="button" className="pa-btn" onClick={() => void stopPairing()}>Stop pairing</button>
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ device, now }: { device: PhoneDeviceView; now: number }): JSX.Element {
  const line = deviceLine(device, now);
  return (
    <li className="pa-device">
      <span className="pa-device-icon"><PhoneIcon size={20} strokeWidth={1.6} /></span>
      <span className="pa-device-text">
        <span className="pa-device-name">{device.name}</span>
        <span className="pa-device-line">
          {line.paired} · <span className={line.connected ? 'pa-connected' : undefined}>{line.seen}</span>
        </span>
      </span>
      <button type="button" className="pa-btn pa-btn-danger" aria-label={`Revoke ${device.name}`}
        onClick={() => void revokeDevice(device)}>Revoke</button>
    </li>
  );
}
