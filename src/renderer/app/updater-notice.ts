/**
 * Telling the user about an update.
 *
 * Two surfaces, because the two things being said are different. A line in the
 * status bar narrates progress and is meant to be ignorable. A toast appears
 * once, when a version is actually ready, because installing it restarts the
 * app and the user has to choose when — and it can be dismissed per version, so
 * declining once does not mean being asked again every launch.
 */
import { escapeHtml } from '../lib/format';
import { el } from '../lib/dom';
import type { UpdaterEventData } from '../../ipc/api';

/** How long "Up to date" and error messages stay before clearing. */
const TRANSIENT_MS = 3000;
const ERROR_MS = 5000;

const RELEASES_URL = 'https://github.com/doctly/switchboard/releases';
const DISMISSED_KEY = 'update-dismissed';

const statusEl = el('status-bar-updater');
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(text: string, clearAfterMs?: number): void {
  if (clearTimer) clearTimeout(clearTimer);
  statusEl.textContent = text;
  if (!clearAfterMs) return;
  clearTimer = setTimeout(() => { statusEl.textContent = ''; }, clearAfterMs);
}

export function setUpdaterEvent(type: string, data: UpdaterEventData = {}): void {
  switch (type) {
    case 'checking':
      setStatus('Checking for updates…');
      break;
    case 'update-available':
      setStatus(`Downloading v${data.version}…`);
      break;
    case 'update-not-available':
      setStatus('Up to date', TRANSIENT_MS);
      break;
    case 'download-progress':
      setStatus(`Updating… ${Math.round(data.percent ?? 0)}%`);
      break;
    case 'update-downloaded':
      setStatus(`v${data.version} ready — restart to update`);
      showToast(data);
      break;
    case 'error':
      setStatus('Update check failed', ERROR_MS);
      break;
  }
}

function showToast(data: UpdaterEventData): void {
  if (readDismissed() === data.version) return;

  const toast = el('update-toast');
  const message = el('update-toast-msg');

  // The release name is only worth showing when it says something the version
  // number does not.
  const named = data.releaseName
    && data.releaseName !== `v${data.version}`
    && data.releaseName !== data.version;
  const notice = named ? `<span class="update-summary">${escapeHtml(data.releaseName!)}</span>` : '';

  message.innerHTML = 'New Version Ready<br>'
    + `<span class="update-version">v${escapeHtml(String(data.version ?? ''))}</span> `
    + `(<a href="${RELEASES_URL}" target="_blank" class="update-notes-link">release notes</a>)`
    + notice;

  toast.classList.remove('hidden');
  el('update-restart-btn').onclick = () => void window.api.updaterInstall();
  el('update-dismiss-btn').onclick = () => {
    toast.classList.add('hidden');
    writeDismissed(data.version ?? '');
  };
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Site data blocked; the toast will simply reappear next launch.
  }
}
