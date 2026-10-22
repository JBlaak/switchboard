/**
 * Settings: the global settings panel, and a project's settings view on its
 * page (#176).
 *
 * The panel's stored blob is read once, when it opens, and held here so the
 * form renders from one snapshot. What the user then types stays in the form
 * itself until Save — a half-edited field is not state anyone else reads.
 *
 * `openId` counts opens. The form is keyed on it, so opening the panel again
 * starts from what is stored now, not from the edits an earlier, cancelled
 * open left behind.
 *
 * A project's settings view saves on every change, so it holds the project's
 * blob as last written, beside the global one it is compared with. It starts
 * empty each time the view opens and fills when the read lands.
 */
import type { RendererEvent } from './events';
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { CaptureTarget } from '../../domain/ask/model';

/** A settings blob — open-ended, since each feature writes its own keys. */
export type SettingsRecord = Readonly<Record<string, any>>;

export interface SettingsPanel {
  /** The global blob as stored. */
  readonly current: SettingsRecord;
  readonly shellProfiles: readonly ShellProfile[];
  /** The app's version, for the About section; null until known. */
  readonly appVersion: string | null;
  /** Whether main holds ⌥Space; false with the switch on means another app has it (H3). */
  readonly quickAskRegistered: boolean;
  /** Quick Ask's capture targets whose server isn't set up in Claude Code (C6). */
  readonly quickAskMissing: readonly CaptureTarget[];
  readonly openId: number;
  /** Save went through; the panel shows "✓ Saved" until it closes. */
  readonly saved: boolean;
}

/** A project's settings view on its page. */
export interface ProjectSettingsView {
  readonly projectPath: string;
  /** The project's own blob, as last read or written. */
  readonly current: SettingsRecord;
  /** The global blob, which every field the project does not override shows. */
  readonly globalSettings: SettingsRecord;
  /** A change was stored since the view opened: "Saved · applies to new sessions". */
  readonly saved: boolean;
}

export interface SettingsState {
  /** Null while the panel is closed. */
  readonly panel: SettingsPanel | null;
  readonly opens: number;
  /** Null until the open project settings view has read what is stored. */
  readonly project: ProjectSettingsView | null;
}

export const initialSettingsState: SettingsState = { panel: null, opens: 0, project: null };

export function settingsReducer(state: SettingsState, event: RendererEvent): SettingsState {
  switch (event.type) {
    case 'settingsOpened': {
      const openId = state.opens + 1;
      return {
        ...state,
        opens: openId,
        panel: {
          current: event.current,
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

    // Each visit to a project's settings reads afresh, with no "Saved" left over.
    case 'projectOpened':
      return event.view.kind === 'settings' && state.project ? { ...state, project: null } : state;
    case 'projectSettingsLoaded':
      return {
        ...state,
        project: {
          projectPath: event.projectPath,
          current: event.current,
          globalSettings: event.globalSettings,
          saved: false,
        },
      };
    case 'projectSettingsSaved':
      return state.project && state.project.projectPath === event.projectPath
        ? { ...state, project: { ...state.project, current: event.current, saved: true } }
        : state;
    default:
      return state;
  }
}
