/**
 * Adding a project — a local folder, or a machine over SSH.
 *
 * Two forms behind one dialog, because they answer the same question. The
 * validation that matters happens in the main process; this only catches the
 * empty-field cases so the user is not waiting on a round trip to be told they
 * left the host blank.
 */
import { reloadProjects } from '../../app/refresh';
import { openDialog } from './dialog-shell';

type Mode = 'local' | 'remote';

export function showAddProjectDialog(): void {
  const handle = openDialog({
    overlayClass: 'add-project-overlay',
    dialogClass: 'add-project-dialog',
    submitFromInputs: true,
    html: `
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
    `,
  });

  const pathInput = handle.field<HTMLInputElement>('#add-project-path');
  const errorEl = handle.field('#add-project-error');
  let mode: Mode = 'local';

  const showError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  };

  handle.dialog.querySelectorAll<HTMLElement>('.add-project-tab').forEach(tab => {
    tab.onclick = () => {
      mode = (tab.dataset.mode as Mode) ?? 'local';
      handle.dialog.querySelectorAll<HTMLElement>('.add-project-tab')
        .forEach(t => t.classList.toggle('active', t === tab));
      handle.field('#add-project-local').style.display = mode === 'local' ? '' : 'none';
      handle.field('#add-project-remote').style.display = mode === 'remote' ? '' : 'none';
      errorEl.style.display = 'none';
      (mode === 'local' ? pathInput : handle.field<HTMLInputElement>('#add-remote-user')).focus();
    };
  });

  const add = async (): Promise<void> => {
    errorEl.style.display = 'none';
    const result = mode === 'remote' ? await addRemote() : await addLocal();
    if (result) {
      showError(result);
      return;
    }
    handle.close();
    await reloadProjects();
  };

  /** Answers with an error message, or null on success. */
  async function addRemote(): Promise<string | null> {
    const user = handle.field<HTMLInputElement>('#add-remote-user').value.trim();
    const host = handle.field<HTMLInputElement>('#add-remote-host').value.trim();
    const port = handle.field<HTMLInputElement>('#add-remote-port').value.trim();
    const dir = handle.field<HTMLInputElement>('#add-remote-dir').value.trim();

    if (!user || !host) return 'Please enter a username and host.';
    const result = await window.api.addRemoteProject({
      user, host, port: Number(port) || 22, dir,
    });
    return result.error ?? null;
  }

  async function addLocal(): Promise<string | null> {
    const projectPath = pathInput.value.trim();
    if (!projectPath) return 'Please enter a folder path.';
    const result = await window.api.addProject(projectPath);
    return result.error ?? null;
  }

  handle.field('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  handle.field('.add-project-cancel-btn').onclick = handle.close;
  handle.field('.add-project-add-btn').onclick = () => void add();
  handle.onSubmit(() => void add());

  pathInput.focus();
}
