/**
 * The settings panel: which scope is open, and what the form was opened with.
 *
 * The stored blobs are read once, when the panel opens, and held here so the
 * form renders from one snapshot. What the user then types stays in the form
 * itself until Save — a half-edited field is not state anyone else reads.
 *
 * `openId` counts opens. The form is keyed on it, so opening the panel again —
 * even on the same scope — starts from what is stored now, not from the edits
 * an earlier, cancelled open left behind.
 */
import type { RendererEvent } from './events';
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { CaptureTarget } from '../../domain/ask/model';

/** A settings blob — open-ended, since each feature writes its own keys. */
export type SettingsRecord = Readonly<Record<string, any>>;

export type SettingsScope = 'global' | 'project';

export interface SettingsPanel {
  readonly scope: SettingsScope;
  /** The project, in project scope; null in global scope. */
  readonly projectPath: string | null;
  /** The scope's own stored blob. */
  readonly current: SettingsRecord;
  /** The global blob, which project scope shows for every field it inherits. */
  readonly globalSettings: SettingsRecord;
  readonly shellProfiles: readonly ShellProfile[];
  /** The app's version, for global scope's About section; null until known. */
  readonly appVersion: string | null;
  /** Whether main holds ⌥Space; false with the switch on means another app has it (H3). */
  readonly quickAskRegistered: boolean;
  /** Quick Ask's capture targets whose server isn't set up in Claude Code (C6). */
  readonly quickAskMissing: readonly CaptureTarget[];
  readonly openId: number;
  /** Save went through; the panel shows "✓ Saved" until it closes. */
  readonly saved: boolean;
}

export interface SettingsState {
  /** Null while the panel is closed. */
  readonly panel: SettingsPanel | null;
  readonly opens: number;
}

export const initialSettingsState: SettingsState = { panel: null, opens: 0 };

export function settingsReducer(state: SettingsState, event: RendererEvent): SettingsState {
  switch (event.type) {
    case 'settingsOpened': {
      const openId = state.opens + 1;
      return {
        opens: openId,
        panel: {
          scope: event.scope,
          projectPath: event.projectPath,
          current: event.current,
          globalSettings: event.globalSettings,
          shellProfiles: event.shellProfiles,
          appVersion: event.appVersion,
          quickAskRegistered: event.quickAskRegistered,
          quickAskMissing: event.quickAskMissing,
          openId,
          saved: false,
        },
      };
    }
    case 'settingsSaved':
      return state.panel && !state.panel.saved
        ? { ...state, panel: { ...state.panel, saved: true } }
        : state;
    case 'settingsClosed':
      return state.panel ? { ...state, panel: null } : state;
    default:
      return state;
  }
}
