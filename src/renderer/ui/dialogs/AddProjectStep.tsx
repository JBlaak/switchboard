/**
 * The Projects modal's add step (#171): a local folder, or a machine over SSH.
 *
 * What the Add Project dialog was, moved into the modal: two forms behind one
 * pair of tabs, with the local folder checked as it is typed (is it there, is
 * it a git repository, is that on GitHub). The validation that matters
 * happens in main; the actions only catch the blank fields.
 */
import { useEffect, useRef, useState } from 'react';
import { addLocalProject, addRemoteProject, browseForFolder, checkProjectFolder } from './actions';
import { folderCheckLines } from './add-project-request';
import { pickerKeyAction } from './picker-selection';
import type { JSX, KeyboardEvent } from 'react';
import type { RemoteFields } from './actions';
import type { ProjectFolderCheck } from '../../../domain/project/folder-check';

export type AddTab = 'local' | 'remote';

/** What the step opens on: a tab, and what the search had already typed. */
export interface AddStepStart {
  tab: AddTab;
  path: string;
  remote: RemoteFields;
}

export interface AddProjectStepProps {
  start: AddStepStart;
  onBack(): void;
  onClose(): void;
  /** Added, and the project list reloaded. */
  onAdded(projectPath: string): void;
}

/** How long typing has to pause before the folder is checked. */
const CHECK_DELAY_MS = 150;

export function AddProjectStep({ start, onBack, onClose, onAdded }: AddProjectStepProps): JSX.Element {
  const [tab, setTab] = useState<AddTab>(start.tab);
  const [path, setPath] = useState(start.path);
  const [remote, setRemote] = useState<RemoteFields>(start.remote);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ProjectFolderCheck | null>(null);

  const pathRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  // Each tab's first field takes the focus, on opening and on every switch.
  useEffect(() => {
    (tab === 'local' ? pathRef : userRef).current?.focus();
  }, [tab]);

  // The local folder is checked once typing pauses; a late answer for older text is dropped.
  useEffect(() => {
    const typed = path.trim();
    if (tab !== 'local' || !typed) {
      setCheck(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void checkProjectFolder(typed).then(answer => { if (current) setCheck(answer); });
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [tab, path]);

  const switchTo = (next: AddTab): void => {
    setTab(next);
    setError(null);
  };

  const add = async (): Promise<void> => {
    setError(null);
    const outcome = tab === 'remote' ? await addRemoteProject(remote) : await addLocalProject(path);
    if ('error' in outcome) setError(outcome.error);
    else onAdded(outcome.projectPath);
  };

  const browse = async (): Promise<void> => {
    const folder = await browseForFolder();
    if (folder) setPath(folder);
  };

  // ↵ adds, and ⌘[ or ← at the start of a field goes back, from any field.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const field = e.target as HTMLElement;
    if (!(field instanceof HTMLInputElement)) return;
    const collapsed = field.selectionStart === field.selectionEnd;
    const action = pickerKeyAction('add', {
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      caretAtStart: collapsed && field.selectionStart === 0,
      caretAtEnd: collapsed && field.selectionEnd === field.value.length,
    }, false);
    if (action === 'open') {
      e.preventDefault();
      void add();
    } else if (action === 'back-to-projects') {
      e.preventDefault();
      onBack();
    }
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
    <div className="projects-add-step" onKeyDown={onKeyDown}>
      <div className="add-project-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'local'} className={'add-project-tab' + (tab === 'local' ? ' active' : '')}
          onClick={() => switchTo('local')}>Local folder</button>
        <button role="tab" aria-selected={tab === 'remote'} className={'add-project-tab' + (tab === 'remote' ? ' active' : '')}
          onClick={() => switchTo('remote')}>Remote (SSH)</button>
      </div>
      {tab === 'local'
        ? (
          <div id="add-project-local">
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
              <button className="add-project-browse-btn" onClick={() => void browse()}>Browse…</button>
            </div>
            {check && path.trim() && (
              <ul className="projects-add-check" aria-label="Folder check">
                {folderCheckLines(check).map(line => (
                  <li key={line.text} className={line.ok ? 'ok' : 'not'}>
                    <CheckMark ok={line.ok} />
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
            <div className="add-project-hint">A folder without git still works, with sessions only.</div>
          </div>
        )
        : (
          <div id="add-project-remote">
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
        )}
      {error && <div className="add-project-error" role="alert">{error}</div>}
      <div className="add-project-actions">
        <button className="add-project-cancel-btn" onClick={onClose}>Cancel</button>
        <button className="add-project-add-btn" onClick={() => void add()}>
          Add <kbd className="sw-kbd" aria-hidden="true">↵</kbd>
        </button>
      </div>
    </div>
  );
}

function CheckMark({ ok }: { ok: boolean }): JSX.Element {
  return ok
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M7 12h10" /></svg>;
}
