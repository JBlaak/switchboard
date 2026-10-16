/**
 * Adding a project — a local folder, or a machine over SSH.
 *
 * Two forms behind one dialog, because they answer the same question. The
 * validation that matters happens in the main process; the actions only catch
 * the empty-field cases so the user is not waiting on a round trip to be told
 * they left the host blank.
 */
import { useEffect, useRef, useState } from 'react';
import { loadProjects } from '../../features/sessions/session-list';
import { addLocalProject, addRemoteProject } from './actions';
import { DialogShell } from './DialogShell';
import type { JSX } from 'react';
import type { RemoteFields } from './actions';

type Mode = 'local' | 'remote';

export interface AddProjectDialogProps {
  onClose(): void;
}

export function AddProjectDialog({ onClose }: AddProjectDialogProps): JSX.Element {
  const [mode, setMode] = useState<Mode>('local');
  const [path, setPath] = useState('');
  const [remote, setRemote] = useState<RemoteFields>({ user: '', host: '', port: '', dir: '' });
  const [error, setError] = useState<string | null>(null);

  const pathRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  // Each tab's first field takes the focus, on opening and on every switch.
  useEffect(() => {
    (mode === 'local' ? pathRef : userRef).current?.focus();
  }, [mode]);

  const switchTo = (next: Mode): void => {
    setMode(next);
    setError(null);
  };

  const add = async (): Promise<void> => {
    setError(null);
    const result = mode === 'remote' ? await addRemoteProject(remote) : await addLocalProject(path);
    if (result) {
      setError(result);
      return;
    }
    onClose();
    await loadProjects();
  };

  const browse = async (): Promise<void> => {
    const folder = await window.api.browseFolder();
    if (folder) setPath(folder);
  };

  const remoteInput = (field: keyof RemoteFields, placeholder: string, id: string) => (
    <input
      ref={field === 'user' ? userRef : undefined}
      type="text"
      id={id}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      value={remote[field]}
      onChange={e => setRemote({ ...remote, [field]: e.target.value })}
    />
  );

  return (
    <DialogShell
      overlayClass="add-project-overlay"
      dialogClass="add-project-dialog"
      submitFromInputs
      onClose={onClose}
      onSubmit={() => void add()}
    >
      <h3>Add Project</h3>
      <div className="add-project-tabs">
        <button className={'add-project-tab' + (mode === 'local' ? ' active' : '')} data-mode="local"
          onClick={() => switchTo('local')}>Local folder</button>
        <button className={'add-project-tab' + (mode === 'remote' ? ' active' : '')} data-mode="remote"
          onClick={() => switchTo('remote')}>Remote (SSH)</button>
      </div>
      <div id="add-project-local" style={mode === 'local' ? undefined : { display: 'none' }}>
        <div className="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + button above the session list.</div>
        <div className="folder-input-row">
          <input
            ref={pathRef}
            type="text"
            id="add-project-path"
            placeholder="/path/to/project"
            autoComplete="off"
            spellCheck={false}
            value={path}
            onChange={e => setPath(e.target.value)}
          />
          <button className="add-project-browse-btn" onClick={() => void browse()}>Browse</button>
        </div>
      </div>
      <div id="add-project-remote" style={mode === 'remote' ? undefined : { display: 'none' }}>
        <div className="add-project-hint">Connect to a machine over SSH (agent auth via your ssh config). Sessions run inside tmux on the remote host, so they keep working when you disconnect. Requires tmux on the remote.</div>
        <div className="folder-input-row remote-input-row">
          {remoteInput('user', 'user', 'add-remote-user')}
          <span className="add-remote-sep">@</span>
          {remoteInput('host', 'host or IP', 'add-remote-host')}
          <span className="add-remote-sep">:</span>
          {remoteInput('port', '22', 'add-remote-port')}
        </div>
        <div className="folder-input-row remote-input-row">
          {remoteInput('dir', 'working directory, e.g. ~/apps/foo (default: home)', 'add-remote-dir')}
        </div>
      </div>
      <div className="add-project-error" id="add-project-error" style={error ? { display: 'block' } : undefined}>
        {error}
      </div>
      <div className="add-project-actions">
        <button className="add-project-cancel-btn" onClick={onClose}>Cancel</button>
        <button className="add-project-add-btn" onClick={() => void add()}>Add</button>
      </div>
    </DialogShell>
  );
}
