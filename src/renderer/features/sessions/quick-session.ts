/**
 * A quick session: a Claude session in one fixed folder, no picker.
 *
 * The folder is the `quickSessionPath` global setting. Until one is set there
 * is nowhere to launch: the lightning bolt is hidden, and the shortcuts open
 * global settings instead of doing nothing silently.
 */
import { el } from '../../lib/dom';
import { openSettingsViewer } from '../settings/settings-panel';
import { launchClaudeSession, projectStub } from './session-actions';

/** Cmd+N. */
export function isQuickSessionKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.code !== 'KeyN') return false;
  return e.metaKey && !e.shiftKey && !e.ctrlKey;
}

/**
 * A bare N, while the keyboard is not in a terminal or a text field.
 *
 * Anything that takes typing gets the key as a letter: the terminal, a dialog's
 * filter, a settings input, a rename.
 */
export function isBareQuickSessionKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.code !== 'KeyN') return false;
  const target = e.target as HTMLElement | null;
  if (!target) return true;
  if (target.closest('.xterm')) return false;
  return !target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

export async function launchQuickSession(): Promise<void> {
  const path = await quickSessionPath();
  if (!path) {
    await openSettingsViewer('global');
    return;
  }
  await launchClaudeSession(projectStub(path));
}

/** Show the lightning bolt only while there is a folder for it to launch in. */
export async function syncQuickSessionButton(): Promise<void> {
  el('quick-session-btn').hidden = !await quickSessionPath();
}

async function quickSessionPath(): Promise<string> {
  const global = await window.api.getSetting<Record<string, unknown>>('global');
  return typeof global?.quickSessionPath === 'string' ? global.quickSessionPath.trim() : '';
}
