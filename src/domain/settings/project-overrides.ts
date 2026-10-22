/**
 * A project's overrides of the global launch settings (#176): which fields a
 * project can set, whether it overrides each one, what a change stores, and
 * what "Reset to global settings" leaves behind.
 *
 * The project page's settings view shows every field at the value a session
 * in the project would launch with, and says beside it whether that is the
 * global value. One rule decides both: a field overrides the global default
 * when the project stores a value for it that differs from the global one.
 * A change back to the global value drops the field from the project's blob,
 * so the project follows the global default again rather than pinning a copy
 * of it.
 */
import { mergeEffectiveSettings } from './settings';
import { PERMISSION_MODES } from '../launch/session-options';

/** The launch settings a project can override, in the order the page shows them. */
export const PROJECT_SETTING_FIELDS = [
  'permissionMode', 'dangerouslySkipPermissions', 'worktree', 'chrome', 'preLaunchCmd', 'addDirs',
] as const;

export type ProjectSettingField = typeof PROJECT_SETTING_FIELDS[number];

type Blob = Readonly<Record<string, unknown>> | null | undefined;

/** One field as the page shows it. */
export interface ProjectFieldState {
  /** What a session in the project launches with. */
  readonly value: unknown;
  /** What it would launch with if the project did not override it. */
  readonly globalValue: unknown;
  readonly overrides: boolean;
}

/** Every field the project can override, resolved against the global blob. */
export function projectFieldStates(
  global: Blob, project: Blob,
): Readonly<Record<ProjectSettingField, ProjectFieldState>> {
  const inherited = mergeEffectiveSettings(global, null);
  const effective = mergeEffectiveSettings(global, project);
  const states = {} as Record<ProjectSettingField, ProjectFieldState>;
  for (const field of PROJECT_SETTING_FIELDS) {
    const value = shown(field, effective[field]);
    const globalValue = shown(field, inherited[field]);
    states[field] = { value, globalValue, overrides: !sameValue(value, globalValue) };
  }
  return states;
}

/** Whether the project overrides any field: what "Reset to global settings" would change. */
export function hasOverrides(global: Blob, project: Blob): boolean {
  const states = projectFieldStates(global, project);
  return PROJECT_SETTING_FIELDS.some(field => states[field].overrides);
}

/**
 * The project's blob with `field` set to `value`.
 *
 * Equal to the global value, the field is dropped: the project follows the
 * global default again. Keys the page does not manage are kept, and text is
 * stored trimmed.
 *
 * Default is the one permission mode stored as an empty string: null means
 * "not set" at every layer (`mergeEffectiveSettings`), so a project could not
 * otherwise turn off a mode the global settings choose. An empty mode passes
 * no flag, which is what Default means.
 */
export function withProjectValue(
  global: Blob, project: Blob, field: ProjectSettingField, value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(project ?? {}) };
  const wanted = shown(field, typeof value === 'string' ? value.trim() : value);
  const globalValue = shown(field, mergeEffectiveSettings(global, null)[field]);
  if (wanted === undefined || sameValue(wanted, globalValue)) delete next[field];
  else next[field] = wanted ?? '';
  return next;
}

/** "Reset to global settings": the project's blob without any of the fields it can override. */
export function withoutOverrides(project: Blob): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(project ?? {}) };
  for (const field of PROJECT_SETTING_FIELDS) delete next[field];
  return next;
}

/**
 * The permission modes the page's segmented control offers (#176): Default,
 * Accept edits, Plan and Bypass. A mode set some other way (Auto, Don't Ask,
 * from an older form or by hand) joins them while it is the value, so the
 * control never shows nothing selected.
 */
export const PAGE_PERMISSION_MODES: readonly { readonly value: string | null; readonly label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

export function permissionModeChoices(current: unknown): readonly { readonly value: string | null; readonly label: string }[] {
  const mode = typeof current === 'string' && current !== '' ? current : null;
  if (PAGE_PERMISSION_MODES.some(choice => choice.value === mode)) return PAGE_PERMISSION_MODES;
  const known = PERMISSION_MODES.find(m => m.value === mode);
  return [...PAGE_PERMISSION_MODES, { value: mode, label: known?.label ?? String(mode) }];
}

/**
 * How a value reads in "Overrides the global default (…)": a mode by its
 * label, a switch as on or off, an empty text as none.
 */
export function describeSettingValue(field: ProjectSettingField, value: unknown): string {
  if (field === 'permissionMode') {
    const mode = shown(field, value);
    return permissionModeChoices(mode).find(choice => choice.value === mode)!.label;
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const text = String(value ?? '').trim();
  return text === '' ? 'none' : text;
}

/** A value as the page reads it: a permission mode is null for Default, however it is stored. */
function shown(field: ProjectSettingField, value: unknown): unknown {
  if (field === 'permissionMode') return typeof value === 'string' && value !== '' ? value : null;
  return value;
}

/** Strings compare trimmed, so a stray space typed into a field is not an override. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}
