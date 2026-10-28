/**
 * The global settings form. A project's overrides of the launch options are
 * on its page (#176).
 *
 * The controls are uncontrolled: each starts from what was stored when the
 * panel opened and is read once, on Save, the way the vanilla form did. Only
 * what changes the form as you use it is state — the live warnings.
 */
import { useRef, useState } from 'react';
import { PERMISSION_MODES } from '../../../domain/launch/session-options';
import {
  resolveBlaakTasksUrl, resolveQuickAskEnabled, resolveRemoveWorktreeOnArchive, resolveWeatherEnabled,
  resolveWeatherLocation,
} from '../../../domain/settings/settings';
import { ADD_TO_CLAUDE_LINE, addToClaudeCommand } from '../../../domain/tasks/model';
import { DEFAULT_WEATHER_LOCATION } from '../../../domain/weather/weather';
import { missingServersLine } from '../../../domain/ask/capture';
import { isFontAvailable } from '../../features/terminal/terminal-manager';
import {
  DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_LINE_HEIGHT,
  normalizeTerminalFont,
} from '../../features/terminal/terminal-input';
import { TERMINAL_THEMES } from '../../features/terminal/terminal-themes';
import { closeSettings, saveSettings } from './actions';
import { AppField, LaunchField } from './SettingsField';
import { useWeatherCity } from './use-weather-city';
import { useBlaakTasksUrl } from './use-blaak-tasks-url';
import { PhoneAccessSection } from '../phone-access/PhoneAccessSection';
import type { JSX } from 'react';
import type { SettingsPanel } from '../../state/settings-slice';

/** The launch options, which a project can override on its page, in the order the form shows them. */
const LAUNCH_FIELDS = ['permissionMode', 'worktree', 'chrome', 'addDirs', 'preLaunchCmd'] as const;
type LaunchOption = typeof LAUNCH_FIELDS[number];

/**
 * Without this the fallback is invisible: naming a font you don't have
 * installed looks identical to the setting not working at all.
 */
function fontWarningFor(family: string): string {
  const name = family.trim();
  return !name || isFontAvailable(name) ? '' : ` — “${name}” isn't installed; falling back to the default.`;
}

/** The line under the Quick Ask switch: ⌥Space taken (H3) first, then a capture server missing (C6). */
function quickAskWarning(enabled: boolean, panel: SettingsPanel): string {
  if (!enabled) return '';
  if (!panel.quickAskRegistered) return '⌥Space is in use by another app';
  return missingServersLine(panel.quickAskMissing);
}

export function SettingsForm({ panel }: { panel: SettingsPanel }): JSX.Element {
  const { current } = panel;

  function fieldValue(field: string, fallback: unknown): any {
    return current[field] !== undefined ? current[field] : fallback;
  }

  const fontFamilyValue: string = fieldValue('terminalFontFamily', '') ?? '';
  const [fontWarning, setFontWarning] = useState(() => fontWarningFor(fontFamilyValue));
  const weather = useWeatherCity(resolveWeatherLocation(current));
  const blaakTasks = useBlaakTasksUrl(resolveBlaakTasksUrl(current));

  const permMode = useRef<HTMLSelectElement>(null);
  const worktree = useRef<HTMLInputElement>(null);
  const chrome = useRef<HTMLInputElement>(null);
  const addDirs = useRef<HTMLInputElement>(null);
  const preLaunch = useRef<HTMLInputElement>(null);
  const quickSessionPath = useRef<HTMLInputElement>(null);
  const terminalTheme = useRef<HTMLSelectElement>(null);
  const fontFamily = useRef<HTMLInputElement>(null);
  const fontSize = useRef<HTMLInputElement>(null);
  const lineHeight = useRef<HTMLInputElement>(null);
  const shellProfile = useRef<HTMLSelectElement>(null);
  const visibleCount = useRef<HTMLInputElement>(null);
  const maxAge = useRef<HTMLInputElement>(null);
  const weatherEnabled = useRef<HTMLInputElement>(null);
  const quickAsk = useRef<HTMLInputElement>(null);
  const removeWorktree = useRef<HTMLInputElement>(null);

  const readers: Record<LaunchOption, () => unknown> = {
    permissionMode: () => permMode.current!.value || null,
    worktree: () => worktree.current!.checked,
    chrome: () => chrome.current!.checked,
    addDirs: () => addDirs.current!.value.trim(),
    preLaunchCmd: () => preLaunch.current!.value.trim(),
  };

  async function save(): Promise<void> {
    const settings: Record<string, unknown> = {};
    for (const field of LAUNCH_FIELDS) settings[field] = readers[field]();
    settings.quickSessionPath = quickSessionPath.current!.value.trim();
    settings.quickAsk = quickAsk.current!.checked;
    settings.removeWorktreeOnArchive = removeWorktree.current!.checked;
    settings.blaakTasksUrl = blaakTasks.urlRef.current!.value.trim();
    settings.visibleSessionCount = parseInt(visibleCount.current!.value) || 25;
    settings.sessionMaxAgeDays = parseInt(maxAge.current!.value) || 3;
    settings.terminalTheme = terminalTheme.current!.value || 'switchboard';
    settings.shellProfile = shellProfile.current!.value || 'auto';
    // Store the family verbatim (empty = follow the default stack, even if that
    // stack later changes) but store size/line height clamped to what xterm accepts.
    const font = normalizeTerminalFont({
      fontSize: fontSize.current!.value,
      lineHeight: lineHeight.current!.value,
    });
    settings.terminalFontFamily = fontFamily.current!.value.trim();
    settings.terminalFontSize = font.fontSize;
    settings.terminalLineHeight = font.lineHeight;
    // A city typed just before clicking Save is still resolving.
    const location = await weather.settled();
    settings.weatherEnabled = weatherEnabled.current!.checked;
    settings.weatherLocation = location;
    await saveSettings(settings);
  }

  const permModeValue = fieldValue('permissionMode', '') ?? '';
  const themeValue = fieldValue('terminalTheme', 'switchboard');
  const shellProfileValue = fieldValue('shellProfile', 'auto');

  return (
    <div className="settings-form">
      <div className="settings-section">
        <div className="settings-section-title">Claude Sessions</div>

        <LaunchField
          label="Permission Mode"
          description={<>Permission mode passed to the <code>claude</code> command</>}
        >
          <select className="settings-select" id="sv-perm-mode" ref={permMode}
            defaultValue={permModeValue}>
            {PERMISSION_MODES.map(m => m.value === null
              ? <option key="" value="">Your Claude default</option>
              : <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </LaunchField>

        <LaunchField label="Worktree"
          description={<>Start each new session in its own git worktree (<code>--worktree</code>)</>}>
          <label className="settings-toggle"><input type="checkbox" id="sv-worktree" ref={worktree}
            defaultChecked={!!fieldValue('worktree', false)} /><span className="settings-toggle-slider"></span></label>
        </LaunchField>

        <LaunchField label="Chrome"
          description={<>Let Claude use your browser through Claude in Chrome (<code>--chrome</code>)</>}>
          <label className="settings-toggle"><input type="checkbox" id="sv-chrome" ref={chrome}
            defaultChecked={!!fieldValue('chrome', false)} /><span className="settings-toggle-slider"></span></label>
        </LaunchField>

        <LaunchField wide label="Additional Directories"
          description={<>Folders outside the project that Claude can also work in, separated by commas (<code>--add-dir</code>)</>}>
          <input type="text" className="settings-input" id="sv-add-dirs" ref={addDirs} placeholder="/path/to/dir1, /path/to/dir2"
            defaultValue={fieldValue('addDirs', '') ?? ''} />
        </LaunchField>

        <LaunchField wide label="Pre-launch Command"
          description={<>Put in front of the <code>claude</code> command, e.g. to load credentials first</>}>
          <input type="text" className="settings-input" id="sv-pre-launch" ref={preLaunch} placeholder="e.g. aws-vault exec profile --"
            defaultValue={fieldValue('preLaunchCmd', '') ?? ''} />
        </LaunchField>

        <AppField wide label="Quick Session Folder"
          description="Where the lightning bolt, ⌘N and N (outside a session) start a session straight away">
          <input type="text" className="settings-input" id="sv-quick-session-path" ref={quickSessionPath}
            placeholder="/path/to/folder" defaultValue={fieldValue('quickSessionPath', '') ?? ''} />
        </AppField>

        <AppField label="Open Quick Ask with ⌥Space"
          description={<>Ask Patch for a session from any app, while Switchboard runs<span id="sv-quick-ask-warning" className="settings-warning">{
            quickAskWarning(resolveQuickAskEnabled(current), panel)}</span></>}>
          <label className="settings-toggle"><input type="checkbox" id="sv-quick-ask" ref={quickAsk}
            defaultChecked={resolveQuickAskEnabled(current)} /><span className="settings-toggle-slider"></span></label>
        </AppField>

        <AppField label="Remove Worktree on Archive"
          description="Archiving a session removes the git worktrees it worked in, when nothing in them is uncommitted. Their branches are kept; ignored files such as node_modules go with them">
          <label className="settings-toggle"><input type="checkbox" id="sv-remove-worktree-on-archive" ref={removeWorktree}
            defaultChecked={resolveRemoveWorktreeOnArchive(current)} /><span className="settings-toggle-slider"></span></label>
        </AppField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">BlaakTasks</div>

        <AppField wide label="BlaakTasks URL"
          description={<>Your tasks' MCP address. Leave it empty to keep BlaakTasks out of Switchboard{
            blaakTasks.checked && blaakTasks.setUp === false && (
              <span id="sv-blaak-tasks-warning" className="settings-warning">
                {ADD_TO_CLAUDE_LINE}: <code className="settings-copyable">{addToClaudeCommand(blaakTasks.checked)}</code>
              </span>
            )}</>}>
          <input type="text" className="settings-input" id="sv-blaak-tasks-url" ref={blaakTasks.urlRef}
            placeholder="https://tasks.example.com/mcp" defaultValue={resolveBlaakTasksUrl(current)} />
        </AppField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Terminal</div>

        <AppField label="Terminal Theme" description="Colour theme for terminal and Claude sessions">
          <select className="settings-select" id="sv-terminal-theme" ref={terminalTheme} defaultValue={themeValue}>
            {Object.entries(TERMINAL_THEMES).map(([key, t]) =>
              <option key={key} value={key}>{t.label}</option>)}
          </select>
        </AppField>

        <AppField label="Terminal Font"
          description={<>Font family for terminal sessions. Leave empty for the default.<span id="sv-font-warning" className="settings-warning">{fontWarning}</span></>}>
          <input type="text" className="settings-input" id="sv-font-family" ref={fontFamily} style={{ width: '220px' }}
            defaultValue={fontFamilyValue} placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
            onChange={e => setFontWarning(fontWarningFor(e.currentTarget.value))} />
        </AppField>

        <AppField label="Terminal Font Size" description="Font size in pixels for terminal sessions">
          <input type="number" className="settings-input settings-input-compact" id="sv-font-size" ref={fontSize}
            min="6" max="32" step="1" defaultValue={String(fieldValue('terminalFontSize', DEFAULT_TERMINAL_FONT_SIZE))} />
        </AppField>

        <AppField label="Terminal Line Height" description="Line spacing as a multiple of the font size (1 = tightest)">
          <input type="number" className="settings-input settings-input-compact" id="sv-line-height" ref={lineHeight}
            min="1" max="3" step="0.05" defaultValue={String(fieldValue('terminalLineHeight', DEFAULT_TERMINAL_LINE_HEIGHT))} />
        </AppField>

        <AppField label="Shell Profile"
          description="Shell used for terminal and Claude sessions. Changes take effect for new sessions only.">
          <select className="settings-select" id="sv-shell-profile" ref={shellProfile} defaultValue={shellProfileValue}>
            <option value="auto">Auto (detect)</option>
            {panel.shellProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </AppField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Sidebar</div>

        <AppField label="Max Visible Sessions"
          description={'Show up to this many sessions before folding the rest behind "+N older". Active and pinned sessions always show.'}>
          <input type="number" className="settings-input settings-input-compact" id="sv-visible-count" ref={visibleCount}
            min="1" max="100" defaultValue={String(fieldValue('visibleSessionCount', 25))} />
        </AppField>

        <AppField label="Session Max Age (days)"
          description={'Sessions older than this also fold behind "+N older", even under the limit above'}>
          <input type="number" className="settings-input settings-input-compact" id="sv-max-age" ref={maxAge}
            min="1" max="365" defaultValue={String(fieldValue('sessionMaxAgeDays', 3))} />
        </AppField>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Weather</div>

        <AppField label="Show weather on the empty screen"
          description="Patch dresses for the weather outside, fetched from Open-Meteo">
          <label className="settings-toggle"><input type="checkbox" id="sv-weather-enabled" ref={weatherEnabled}
            defaultChecked={resolveWeatherEnabled(current)} /><span className="settings-toggle-slider"></span></label>
        </AppField>

        <AppField label="City"
          description={<>Weather for <span id="sv-weather-resolved">{weather.resolvedName}</span><span id="sv-weather-warning" className="settings-warning">{weather.warning}</span></>}>
          <input type="text" className="settings-input" id="sv-weather-city" ref={weather.cityRef}
            placeholder={DEFAULT_WEATHER_LOCATION.name} defaultValue={resolveWeatherLocation(current).name} style={{ width: '180px' }} />
        </AppField>
      </div>

      <PhoneAccessSection />

      <div className="settings-section">
        <div className="settings-section-title">About</div>
        <AppField label="Version"
          description={<span id="sv-current-version">{panel.appVersion ? `v${panel.appVersion}` : ''}</span>} />
      </div>

      <div className="settings-btn-row">
        <button className="settings-cancel-btn" id="sv-cancel-btn" onClick={() => closeSettings()}>Cancel</button>
        <button className="settings-save-btn" id="sv-save-btn" onClick={() => void save()}
          style={panel.saved ? { background: 'var(--sb-mint)', color: 'var(--sb-accent)' } : undefined}>
          {panel.saved ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
