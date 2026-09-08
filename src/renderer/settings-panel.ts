// Settings panel component
// Manages the global and project settings viewer UI.
import { loadProjects, refreshSidebar } from './app.js';
import {
  el, jsonlViewer, memoryViewer, placeholder, planViewer, settingsViewer,
  statsViewer, terminalArea, terminalHeader,
} from './dom.js';
import { openSessions, state } from './state.js';
import { applyTerminalFont, isFontAvailable, refitOpenTerminals } from './terminal-manager.js';
import {
  DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_LINE_HEIGHT,
  normalizeTerminalFont,
} from './terminal-input.js';
import { TERMINAL_THEMES, applyTerminalTheme } from './terminal-themes.js';
import { PERMISSION_MODES, escapeHtml, shortProjectPath } from './utils.js';
import type { UpdaterEventData } from '../preload/index.js';

/** A settings blob — open-ended, since each feature writes its own keys. */
type SettingsRecord = Record<string, any>;

/**
 * A control in the settings form.
 *
 * The panel renders this markup itself immediately above every lookup, so a
 * missing id is a bug in the template rather than something to handle at
 * runtime — hence the throw instead of threading `| null` through every read.
 */
function ctl<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const found = settingsViewerBody.querySelector<T>(selector);
  if (!found) throw new Error(`settings form is missing ${selector}`);
  return found;
}


const settingsViewerTitle = el('settings-viewer-title');
const settingsViewerBody = el('settings-viewer-body');

export function closeSettingsViewer(): void {
  settingsViewer.style.display = 'none';
  const { gridViewActive, activeSessionId } = state;
  // Check if there's an active session with an open terminal
  if (activeSessionId && openSessions.has(activeSessionId)) {
    terminalArea.style.display = '';
    terminalHeader.style.display = '';
  } else if (gridViewActive) {
    terminalArea.style.display = '';
  } else {
    placeholder.style.display = '';
  }
  // Terminals had no layout box while the panel covered them, so anything that
  // changed their metrics in the meantime (font size, line height) could not fit
  // itself and would leave output running off the right edge until the next resize.
  refitOpenTerminals();
}

export async function openSettingsViewer(
  scope: 'global' | 'project',
  projectPath?: string,
): Promise<void> {
  const isProject = scope === 'project';
  const settingsKey = isProject ? 'project:' + projectPath : 'global';
  const current: SettingsRecord = (await window.api.getSetting<SettingsRecord>(settingsKey)) || {};
  const globalSettings: SettingsRecord = isProject
    ? ((await window.api.getSetting<SettingsRecord>('global')) || {})
    : {};

  const shortName = isProject
    ? shortProjectPath(projectPath)
    : 'Global';

  settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

  // Show settings viewer, hide others
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  settingsViewer.style.display = 'flex';

  function useGlobalCheckbox(fieldName: string): string {
    if (!isProject) return '';
    const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
    return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
  }

  function fieldValue(fieldName: string, fallback: unknown): any {
    if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
      return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
    }
    return current[fieldName] !== undefined ? current[fieldName] : fallback;
  }

  function fieldDisabled(fieldName: string): string {
    if (!isProject) return '';
    return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
  }

  const permModeValue = fieldValue('permissionMode', '');
  const worktreeValue = fieldValue('worktree', false);
  const worktreeNameValue = fieldValue('worktreeName', '');
  const chromeValue = fieldValue('chrome', false);
  const preLaunchValue = fieldValue('preLaunchCmd', '');
  const addDirsValue = fieldValue('addDirs', '');
  const visCountValue = fieldValue('state.visibleSessionCount', 25);
  const maxAgeValue = fieldValue('state.sessionMaxAgeDays', 3);
  const themeValue = fieldValue('terminalTheme', 'switchboard');
  const mcpEmulationValue = fieldValue('mcpEmulation', true);
  const shellProfileValue = fieldValue('shellProfile', 'auto');
  const fontFamilyValue = fieldValue('terminalFontFamily', '');
  const fontSizeValue = fieldValue('terminalFontSize', DEFAULT_TERMINAL_FONT_SIZE);
  const lineHeightValue = fieldValue('terminalLineHeight', DEFAULT_TERMINAL_LINE_HEIGHT);

  // Discover available shell profiles
  let shellProfiles: { id: string; name: string; path: string }[] = [];
  try { shellProfiles = await window.api.getShellProfiles(); } catch {};

  settingsViewerBody.innerHTML = `
  <div class="settings-form">
    <div class="settings-section">
      <div class="settings-section-title">Claude CLI Options</div>

      <div class="settings-field">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Permission Mode</span>
            ${useGlobalCheckbox('permissionMode')}
          </div>
          <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
        </div>
        <div class="settings-field-control">
          <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
            ${PERMISSION_MODES.map(m => m.value === null
              ? '<option value="">Default (none)</option>'
              : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Worktree</span>
            ${useGlobalCheckbox('worktree')}
          </div>
          <div class="settings-description">Enable worktree for new sessions</div>
        </div>
        <div class="settings-field-control">
          <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Worktree Name</span>
            ${useGlobalCheckbox('worktreeName')}
          </div>
          <div class="settings-description">Custom name for worktree branches</div>
        </div>
        <div class="settings-field-control">
          <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Chrome</span>
            ${useGlobalCheckbox('chrome')}
          </div>
          <div class="settings-description">Enable Chrome browser automation</div>
        </div>
        <div class="settings-field-control">
          <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
        </div>
      </div>

      <div class="settings-field settings-field-wide">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Additional Directories</span>
            ${useGlobalCheckbox('addDirs')}
          </div>
          <div class="settings-description">Extra directories to include in Claude sessions</div>
        </div>
        <div class="settings-field-control">
          <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Session Launch</div>

      <div class="settings-field settings-field-wide">
        <div class="settings-field-info">
          <div class="settings-field-header">
            <span class="settings-label">Pre-launch Command</span>
            ${useGlobalCheckbox('preLaunchCmd')}
          </div>
          <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
        </div>
        <div class="settings-field-control">
          <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
        </div>
      </div>
    </div>

    ${!isProject ? `<div class="settings-section">
      <div class="settings-section-title">Application</div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Terminal Theme</span>
          <div class="settings-description">Color theme for terminal sessions</div>
        </div>
        <div class="settings-field-control">
          <select class="settings-select" id="sv-terminal-theme">
            ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
              `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Terminal Font</span>
          <div class="settings-description">Font family for terminal sessions. Leave empty for the default.<span id="sv-font-warning" class="settings-warning"></span></div>
        </div>
        <div class="settings-field-control">
          <!-- value/placeholder set as properties below: font stacks contain quotes, which escapeHtml leaves alone -->
          <input type="text" class="settings-input" id="sv-font-family" style="width:220px">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Terminal Font Size</span>
          <div class="settings-description">Font size in pixels for terminal sessions</div>
        </div>
        <div class="settings-field-control">
          <input type="number" class="settings-input settings-input-compact" id="sv-font-size" min="6" max="32" step="1" value="${fontSizeValue}">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Terminal Line Height</span>
          <div class="settings-description">Line spacing as a multiple of the font size (1 = tightest)</div>
        </div>
        <div class="settings-field-control">
          <input type="number" class="settings-input settings-input-compact" id="sv-line-height" min="1" max="3" step="0.05" value="${lineHeightValue}">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Shell Profile</span>
          <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
        </div>
        <div class="settings-field-control">
          <select class="settings-select" id="sv-shell-profile">
            <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
            ${shellProfiles.map(p =>
              `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Max Visible Sessions</span>
          <div class="settings-description">Show up to this many sessions in the list before collapsing the rest behind "+N older". Active and pinned sessions are always shown.</div>
        </div>
        <div class="settings-field-control">
          <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Session Max Age (days)</span>
          <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
        </div>
        <div class="settings-field-control">
          <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
        </div>
      </div>

      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">IDE Emulation</span>
          <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
        </div>
        <div class="settings-field-control">
          <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
        </div>
      </div>
    </div>` : ''}

    ${!isProject ? `<div class="settings-section">
      <div class="settings-section-title">Updates</div>
      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Version</span>
          <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
        </div>
        <div class="settings-field-control">
          <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
        </div>
      </div>
    </div>` : ''}

    <div class="settings-btn-row">
      <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
      <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
      ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
    </div>
  </div>
`;

  const fontFamilyInput = ctl('#sv-font-family');
  {
    fontFamilyInput.value = fontFamilyValue;
    fontFamilyInput.placeholder = DEFAULT_TERMINAL_FONT_FAMILY;
    // Without this the fallback is invisible: naming a font you don't have installed
    // looks identical to the setting not working at all.
    const fontWarning = ctl<HTMLElement>('#sv-font-warning');
    const checkFontAvailable = () => {
      const name = fontFamilyInput.value.trim();
      fontWarning.textContent = !name || isFontAvailable(name)
        ? ''
        : ` — “${name}” isn't installed; falling back to the default.`;
    };
    fontFamilyInput.addEventListener('input', checkFontAvailable);
    checkFontAvailable();
  }

  // Use-global checkboxes toggle field disabled state
  settingsViewerBody.querySelectorAll<HTMLInputElement>('.use-global-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const field = cb.dataset.field;
      const fieldMap = {
        permissionMode: 'sv-perm-mode',
        worktree: 'sv-worktree',
        worktreeName: 'sv-worktree-name',
        chrome: 'sv-chrome',
        preLaunchCmd: 'sv-pre-launch',
        addDirs: 'sv-add-dirs',
      } as Record<string, string>;
      const name = field ? fieldMap[field] : undefined;
      if (name) ctl('#' + name).disabled = cb.checked;
    });
  });

  // Save button
  ctl('#sv-save-btn').addEventListener('click', async () => {
    const settings: SettingsRecord = {};

    if (isProject) {
      // Only save fields where "use global" is unchecked
      settingsViewerBody.querySelectorAll<HTMLInputElement>('.use-global-cb').forEach(cb => {
        if (!cb.checked) {
          const field = cb.dataset.field;
          const fieldMap = {
            permissionMode: () => ctl('#sv-perm-mode').value || null,
            worktree: () => ctl('#sv-worktree').checked,
            worktreeName: () => ctl('#sv-worktree-name').value.trim(),
            chrome: () => ctl('#sv-chrome').checked,
            preLaunchCmd: () => ctl('#sv-pre-launch').value.trim(),
            addDirs: () => ctl('#sv-add-dirs').value.trim(),
          };
          const read = field ? (fieldMap as Record<string, () => unknown>)[field] : undefined;
          if (read && field) settings[field] = read();
        }
      });
    } else {
      settings.permissionMode = ctl('#sv-perm-mode').value || null;
      settings.worktree = ctl('#sv-worktree').checked;
      settings.worktreeName = ctl('#sv-worktree-name').value.trim();
      settings.chrome = ctl('#sv-chrome').checked;
      settings.preLaunchCmd = ctl('#sv-pre-launch').value.trim();
      settings.addDirs = ctl('#sv-add-dirs').value.trim();
      settings.visibleSessionCount = parseInt(ctl('#sv-visible-count').value) || 25;
      settings.sessionMaxAgeDays = parseInt(ctl('#sv-max-age').value) || 3;
      settings.terminalTheme = ctl('#sv-terminal-theme').value || 'switchboard';
      settings.mcpEmulation = ctl('#sv-mcp-emulation').checked;
      settings.shellProfile = ctl('#sv-shell-profile').value || 'auto';
      // Store the family verbatim (empty = follow the default stack, even if that
      // stack later changes) but store size/line height clamped to what xterm accepts.
      const font = normalizeTerminalFont({
        fontSize: ctl('#sv-font-size').value,
        lineHeight: ctl('#sv-line-height').value,
      });
      settings.terminalFontFamily = ctl('#sv-font-family').value.trim();
      settings.terminalFontSize = font.fontSize;
      settings.terminalLineHeight = font.lineHeight;
    }

    // Merge form values into existing settings to preserve keys not managed by the form
    if (!isProject) {
      const existing = (await window.api.getSetting<SettingsRecord>('global')) || {};
      Object.assign(settings, { ...existing, ...settings });
    }

    await window.api.setSetting(settingsKey, settings);

    // Update state.visibleSessionCount, state.sessionMaxAgeDays, and theme
    if (!isProject) {
      if (settings.visibleSessionCount) {
        state.visibleSessionCount = settings.visibleSessionCount;
      }
      if (settings.sessionMaxAgeDays) {
        state.sessionMaxAgeDays = settings.sessionMaxAgeDays;
      }
      if (settings.terminalTheme) {
        applyTerminalTheme(settings.terminalTheme);
      }
      if (typeof applyTerminalFont === 'function') {
        applyTerminalFont({
          fontFamily: settings.terminalFontFamily,
          fontSize: settings.terminalFontSize,
          lineHeight: settings.terminalLineHeight,
        });
      }
      if (typeof refreshSidebar === 'function') refreshSidebar();
    }

    // Notify if IDE Emulation changed
    if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
      const notice = document.createElement('div');
      notice.className = 'settings-notice';
      notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
      const saveBtn = ctl('#sv-save-btn');
      saveBtn.parentElement?.insertBefore(notice, saveBtn);
      setTimeout(() => notice.remove(), 8000);
    }

    const saveBtn = ctl('#sv-save-btn');
    saveBtn.textContent = '✓ Saved';
    saveBtn.style.background = 'var(--sb-green)';
    saveBtn.style.color = 'var(--sb-accent-ink)';
    setTimeout(() => closeSettingsViewer(), 600);
  });

  // Cancel button
  ctl('#sv-cancel-btn').addEventListener('click', () => {
    closeSettingsViewer();
  });

  // Check for updates button + current version + inline status
  const checkUpdatesBtn = ctl('#sv-check-updates-btn');
  if (checkUpdatesBtn) {
    const updateStatusEl = ctl('#sv-update-status');
    window.api.getAppVersion().then(v => {
      ctl<HTMLElement>('#sv-current-version').textContent = `v${v}`;
    });
    const settingsUpdaterHandler = (type: string, data: UpdaterEventData = {}) => {
      if (!updateStatusEl) return;
      switch (type) {
        case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
        case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
        case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
        case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent ?? 0)}%`; break;
        case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
        case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
      }
    };
    window.api.onUpdaterEvent(settingsUpdaterHandler);
    checkUpdatesBtn.addEventListener('click', () => {
      window.api.updaterCheck();
    });
  }

  // Remove project button
  const removeBtn = ctl('#sv-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
      if (projectPath) await window.api.removeProject(projectPath);
      settingsViewer.style.display = 'none';
      placeholder.style.display = 'flex';
      loadProjects();
    });
  }
}
