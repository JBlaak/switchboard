// --- Dialogs & session launch helpers ---
import { escapeHtml, shortProjectPath } from './utils.js';
import { archiveSessionRow, launchNewSession, loadProjects, openSession, pollActiveSessions, refreshSidebar } from './app.js';
import { el } from './dom.js';
import { ICONS } from './icons.js';
import { openSettingsViewer } from './settings-panel.js';
import { projectLabel } from './sidebar.js';
import { pendingSessions, sessionMap, state } from './state.js';
import { createTerminalEntry, showSession } from './terminal-manager.js';
import { PERMISSION_MODES, encodeProjectPath, fuzzyMatch } from './utils.js';
import type { Project, SessionOptions, SessionRow } from '../shared/types.js';

/**
 * A control inside a dialog this module just rendered.
 *
 * The markup is written a few lines above every call, so a miss is a bug in the
 * template rather than a runtime condition worth branching on.
 */
function field<T extends HTMLElement = HTMLInputElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`dialog is missing ${selector}`);
  return found;
}

/**
 * Whatever the popover measures itself against.
 *
 * Usually the button that opened it, but the project picker closes its row
 * first and passes a captured rect instead — a detached element measures 0x0.
 */
type PopoverAnchor = Pick<HTMLElement, 'getBoundingClientRect'>;

/** The launch options a new session is started with — the IPC payload itself. */
export type LaunchOptions = SessionOptions;

// --- New session dialog ---
export async function resolveDefaultSessionOptions(project: Project): Promise<LaunchOptions> {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const options: LaunchOptions = {};
  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }
  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;
  return options;
}

export async function forkSession(session: SessionRow, project: Project): Promise<void> {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  launchNewSession(project, options);
}

function showNewSessionPopover(
  project: Project,
  anchorEl: PopoverAnchor,
  { keyboard = false }: { keyboard?: boolean } = {},
): void {
  // Remove any existing popover
  document.querySelectorAll<HTMLElement>('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  const claudeBtn = document.createElement('button');
  claudeBtn.className = 'popover-option';
  claudeBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude';
  claudeBtn.onclick = async () => {
    popover.remove();
    if (project.remote) launchRemoteSession(project, 'claude');
    else launchNewSession(project, await resolveDefaultSessionOptions(project));
  };

  const claudeOptsBtn = document.createElement('button');
  claudeOptsBtn.className = 'popover-option';
  claudeOptsBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude (Configure...)';
  claudeOptsBtn.onclick = () => { popover.remove(); showNewSessionDialog(project); };

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg> Terminal';
  termBtn.onclick = () => {
    popover.remove();
    if (project.remote) launchRemoteSession(project, 'shell');
    else launchTerminalSession(project);
  };

  popover.appendChild(claudeBtn);
  // The configure dialog's options (worktree, permission modes, MCP) are all
  // local-machine concepts — remote sessions get plain `claude` inside tmux.
  if (!project.remote) popover.appendChild(claudeOptsBtn);
  popover.appendChild(termBtn);

  // Position relative to anchor, flip upward if it would overflow
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = rect.left + 'px';

  // Close on click outside
  function onClickOutside(e: MouseEvent) {
    if (!popover.contains(e.target as Node) && (e.target as unknown) !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);

  // Arrow keys walk the options; the options are real buttons, so Enter and
  // Space activate whichever one has focus without any help from us.
  popover.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const options = [...popover.querySelectorAll<HTMLElement>('.popover-option')];
    const i = options.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    options[(i + step + options.length) % options.length].focus();
  });

  // Opened from the keyboard: land on the first option so Enter starts a
  // session straight away.
  if (keyboard) popover.querySelector<HTMLElement>('.popover-option')?.focus();
}

export async function launchTerminalSession(project: Project): Promise<void> {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session: SessionRow = {
    sessionId,
    summary: 'Terminal',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'terminal' });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

// Start a new session on a remote (SSH) project. The main process records it
// in settings and connects ssh to a fresh tmux session; unlike plain
// terminals the sidebar entry persists, so after a disconnect (or app
// restart) clicking it re-attaches to the still-running remote session.
async function launchRemoteSession(project: Project, kind: string): Promise<void> {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session: SessionRow = {
    sessionId,
    summary: kind === 'shell' ? 'Remote terminal' : 'Remote Claude',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'remote',
    remoteKind: kind,
  };

  // Track as pending until the settings-stored copy comes back via get-projects
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in the sidebar immediately
  sessionMap.set(sessionId, session);
  for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, remote: true, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'remote', remoteKind: kind });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

async function showNewSessionDialog(project: Project): Promise<void> {
  const effective = await window.api.getEffectiveSettings(project.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = PERMISSION_MODES;

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  dialog.innerHTML = `
    <h3>New Session — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="nsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Worktree</span>
        <div class="settings-description">Run session in an isolated git worktree</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-worktree-name" placeholder="name (optional)" value="${escapeHtml(effective.worktreeName || '')}" style="width:140px">
        <label class="settings-toggle"><input type="checkbox" id="nsd-worktree" ${effective.worktree ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="nsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  // The dialog's own markup, rendered a few lines above.
  const modeGrid = field(dialog, '#nsd-mode-grid')!;
  modeGrid.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : (mode ?? null);
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function start() {
    const options: LaunchOptions = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (field(dialog, '#nsd-worktree').checked) {
      options.worktree = true;
      options.worktreeName = field(dialog, '#nsd-worktree-name').value.trim();
    }
    if (field(dialog, '#nsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = field(dialog, '#nsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = field(dialog, '#nsd-add-dirs').value.trim();
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    launchNewSession(project, options);
  }

  field(dialog, '.new-session-cancel-btn').onclick = close;
  field(dialog, '.new-session-start-btn').onclick = start;
  overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) close(); });

  // Keyboard support
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !(e.target as HTMLElement).matches('input')) start();
  }
  document.addEventListener('keydown', onKey);
}

export async function showResumeSessionDialog(session: SessionRow): Promise<void> {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = PERMISSION_MODES;

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Resume Session — ${escapeHtml(sessionName)}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="rsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="rsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Resume</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = field(dialog, '#rsd-mode-grid');
  modeGrid.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : (mode ?? null);
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function resume() {
    const options: LaunchOptions = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (field(dialog, '#rsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = field(dialog, '#rsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = field(dialog, '#rsd-add-dirs').value.trim();
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    openSession(session, options);
  }

  field(dialog, '.new-session-cancel-btn').onclick = close;
  field(dialog, '.new-session-start-btn').onclick = resume;
  overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) close(); });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !(e.target as HTMLElement).matches('input')) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

// Instant hover label. The native `title` tooltip takes a beat to appear and is
// easy to miss on icon-only buttons, so the picker paints its own.
function setTooltip(el: HTMLElement, text: string): void {
  el.dataset.tooltip = text;
  el.setAttribute('aria-label', text);
}

// --- Project picker ---
// The session list is flat, so there are no per-directory headers to hang the
// project actions off. This dialog is where you pick a project to start a
// session in, and where each project's own actions live.
export function showProjectPickerDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog project-picker-dialog';
  dialog.innerHTML = `
    <h3>New Session</h3>
    <input type="text" class="project-picker-filter" placeholder="Filter projects..." autocomplete="off" spellcheck="false">
    <div class="project-picker-list"></div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const filterInput = field(dialog, '.project-picker-filter');
  const listEl = field(dialog, '.project-picker-list');

  // Keyboard selection. Focus stays in the filter input the whole time so you
  // can keep typing, so the highlighted row is tracked here rather than with
  // real DOM focus. `rows` is rebuilt by every render().
  let rows: { el: HTMLElement; activate: (opts?: { keyboard?: boolean }) => void }[] = [];
  let selected = 0;

  function setSelected(index: number, { scroll = true }: { scroll?: boolean } = {}) {
    if (rows.length === 0) { selected = 0; return; }
    selected = Math.max(0, Math.min(index, rows.length - 1));
    rows.forEach((row, i) => row.el.classList.toggle('selected', i === selected));
    if (scroll) rows[selected].el.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function mostRecent(project: Project): number {
    let max = 0;
    for (const s of project.sessions) {
      const t = new Date(s.modified).getTime();
      if (t > max) max = t;
    }
    return max;
  }

  // Paint the label with the fuzzy-matched characters picked out, coalescing
  // runs so a contiguous match is one span rather than one per character.
  function paintLabel(el: HTMLElement, label: string, positions: number[] | null): void {
    el.textContent = '';
    if (!positions || positions.length === 0) { el.textContent = label; return; }
    const matched = new Set(positions);
    let i = 0;
    while (i < label.length) {
      const isMatch = matched.has(i);
      let j = i + 1;
      while (j < label.length && matched.has(j) === isMatch) j++;
      const part = label.slice(i, j);
      if (isMatch) {
        const mark = document.createElement('span');
        mark.className = 'project-picker-match';
        mark.textContent = part;
        el.appendChild(mark);
      } else {
        el.appendChild(document.createTextNode(part));
      }
      i = j;
    }
  }

  function render() {
    const query = filterInput.value.trim();
    // Fuzzy: the query's characters just have to appear in order. Matching the
    // short label is what gets highlighted; the full path is a fallback so
    // typing a parent directory still finds a project.
    const matches = [];
    for (const project of state.cachedProjects) {
      const label = projectLabel(project.projectPath);
      const labelMatch = fuzzyMatch(query, label);
      const match = labelMatch || fuzzyMatch(query, project.projectPath);
      if (!match) continue;
      matches.push({
        project, label,
        onLabel: !!labelMatch,
        score: match.score,
        positions: labelMatch ? match.positions : [],
      });
    }
    // Anything the label matched comes first, however well a long path happened
    // to score — "sb" means switchboard, not the /Users/…/website whose path
    // happens to contain an s before a b. Then best score, then most recent.
    matches.sort((a, b) =>
      (Number(b.onLabel) - Number(a.onLabel)) || (b.score - a.score) || (mostRecent(b.project) - mostRecent(a.project)));

    listEl.innerHTML = '';
    rows = [];
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-picker-empty';
      empty.textContent = 'No matching projects.';
      listEl.appendChild(empty);
      return;
    }

    for (const { project, label, positions } of matches) {
      const row = document.createElement('div');
      row.className = 'project-picker-row';

      const name = document.createElement('div');
      name.className = 'project-picker-name';
      paintLabel(name, label, query ? positions : null);
      name.title = project.projectPath;
      if (project.remote) {
        const badge = document.createElement('span');
        badge.className = 'remote-badge';
        badge.textContent = 'SSH';
        name.appendChild(badge);
      }

      const count = document.createElement('span');
      count.className = 'project-picker-count';
      const live = project.sessions.filter(s => state.activePtyIds.has(s.sessionId)).length;
      const total = project.sessions.length;
      count.textContent = live > 0 ? `${live} running` : `${total} session${total === 1 ? '' : 's'}`;
      if (live > 0) count.classList.add('running');

      const actions = document.createElement('div');
      actions.className = 'project-picker-actions';

      if (project.remote) {
        // Remote projects have no local settings to edit; give them a remove
        // button instead (settings-stored, so nothing else offers removal).
        const removeBtn = document.createElement('button');
        removeBtn.className = 'picker-remove-btn';
        setTooltip(removeBtn, 'Remove remote project');
        removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        removeBtn.onclick = async (e: MouseEvent) => {
          e.stopPropagation();
          if (!confirm(`Remove ${projectLabel(project.projectPath)}?\n\nThis disconnects open connections. tmux sessions on the remote machine keep running.`)) return;
          await window.api.removeRemoteProject(project.projectPath);
          loadProjects();
          render();
        };
        actions.appendChild(removeBtn);
      } else {
        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'picker-settings-btn';
        setTooltip(settingsBtn, 'Project settings');
        settingsBtn.innerHTML = ICONS.gear(16);
        settingsBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); close(); openSettingsViewer('project', project.projectPath); };
        actions.appendChild(settingsBtn);
      }

      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'picker-archive-btn';
      setTooltip(archiveBtn, 'Archive all sessions in this project');
      archiveBtn.innerHTML = ICONS.archive(18);
      archiveBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.archived);
        if (sessions.length === 0) return;
        if (!confirm(`Archive all ${sessions.length} session${sessions.length > 1 ? 's' : ''} in ${projectLabel(project.projectPath)}?`)) return;
        for (const s of sessions) {
          // One failure stops the sweep rather than silently skipping a session
          // whose PTY is still running.
          if (!await archiveSessionRow(s, 1)) break;
        }
        pollActiveSessions();
        loadProjects();
        render();
      };
      actions.appendChild(archiveBtn);

      if (/\/\.claude\/worktrees\//.test(project.projectPath)) {
        const hideBtn = document.createElement('button');
        hideBtn.className = 'picker-hide-btn';
        setTooltip(hideBtn, 'Hide worktree');
        hideBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        hideBtn.onclick = async (e: MouseEvent) => {
          e.stopPropagation();
          const name = project.projectPath.split('/').pop();
          if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
          await window.api.removeProject(project.projectPath);
          loadProjects();
          render();
        };
        actions.appendChild(hideBtn);
      }

      row.append(name, count, actions);
      const activate = ({ keyboard = false } = {}) => {
        // Capture the anchor rect before closing — the row is detached by then,
        // and a detached element measures as 0x0 at the top-left corner.
        const rect = row.getBoundingClientRect();
        close();
        showNewSessionPopover(project, { getBoundingClientRect: () => rect }, { keyboard });
      };
      row.onclick = () => activate();
      // Keep the highlight under the pointer, so the mouse and the arrow keys
      // never disagree about which row Enter would open.
      const index = rows.length;
      row.addEventListener('mouseenter', () => setSelected(index, { scroll: false }));
      rows.push({ el: row, activate });
      listEl.appendChild(row);
    }

    setSelected(selected, { scroll: false });
  }

  filterInput.addEventListener('input', () => {
    // A new query reorders everything, so start from the best match again.
    selected = 0;
    render();
  });
  filterInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((selected + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      if (rows[selected]) rows[selected].activate({ keyboard: true });
    }
  });
  overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) close(); });

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  render();
  filterInput.focus();
}

export function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Project</h3>
    <div class="add-project-tabs">
      <button class="add-project-tab active" data-mode="local">Local folder</button>
      <button class="add-project-tab" data-mode="remote">Remote (SSH)</button>
    </div>
    <div id="add-project-local">
      <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + button above the session list.</div>
      <div class="folder-input-row">
        <input type="text" id="add-project-path" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
        <button class="add-project-browse-btn">Browse</button>
      </div>
    </div>
    <div id="add-project-remote" style="display:none">
      <div class="add-project-hint">Connect to a machine over SSH (agent auth via your ssh config). Sessions run inside tmux on the remote host, so they keep working when you disconnect. Requires tmux on the remote.</div>
      <div class="folder-input-row remote-input-row">
        <input type="text" id="add-remote-user" placeholder="user" autocomplete="off" spellcheck="false">
        <span class="add-remote-sep">@</span>
        <input type="text" id="add-remote-host" placeholder="host or IP" autocomplete="off" spellcheck="false">
        <span class="add-remote-sep">:</span>
        <input type="text" id="add-remote-port" placeholder="22" autocomplete="off" spellcheck="false">
      </div>
      <div class="folder-input-row remote-input-row">
        <input type="text" id="add-remote-dir" placeholder="working directory, e.g. ~/apps/foo (default: home)" autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = field(dialog, '#add-project-path');
  const errorEl = field(dialog, '#add-project-error');
  pathInput.focus();

  let mode = 'local';
  dialog.querySelectorAll<HTMLElement>('.add-project-tab').forEach(tab => {
    tab.onclick = () => {
      mode = tab.dataset.mode ?? 'local';
      dialog.querySelectorAll<HTMLElement>('.add-project-tab').forEach(t => t.classList.toggle('active', t === tab));
      field(dialog, '#add-project-local').style.display = mode === 'local' ? '' : 'none';
      field(dialog, '#add-project-remote').style.display = mode === 'remote' ? '' : 'none';
      errorEl.style.display = 'none';
      (mode === 'local' ? pathInput : field(dialog, '#add-remote-user')).focus();
    };
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }

  async function addProject() {
    errorEl.style.display = 'none';

    if (mode === 'remote') {
      const user = field(dialog, '#add-remote-user').value.trim();
      const host = field(dialog, '#add-remote-host').value.trim();
      const port = field(dialog, '#add-remote-port').value.trim();
      const dir = field(dialog, '#add-remote-dir').value.trim();
      if (!user || !host) {
        showError('Please enter a username and host.');
        return;
      }
      const result = await window.api.addRemoteProject({ user, host, port: Number(port) || 22, dir });
      if (result.error) {
        showError(result.error);
        return;
      }
      close();
      await loadProjects();
      return;
    }

    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      showError('Please enter a folder path.');
      return;
    }
    const result = await window.api.addProject(projectPath);
    if (result.error) {
      showError(result.error);
      return;
    }
    close();

    await loadProjects();
  }

  field(dialog, '.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  field(dialog, '.add-project-cancel-btn').onclick = close;
  field(dialog, '.add-project-add-btn').onclick = addProject;
  overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) close(); });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}
