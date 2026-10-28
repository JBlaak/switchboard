/**
 * The one React root.
 *
 * It renders nothing of its own. Each surface renders into its container in
 * `index.html` through a `Portal` from here — so the page's layout and its
 * styles stay static markup, and a single root keeps one tree, one StrictMode
 * and one place to add context.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toolbar } from './toolbar/Toolbar';
import { Dialogs } from './dialogs/Dialogs';
import { Portal } from './Portal';
import { Footer } from './footer/Footer';
import { SettingsViewer } from './settings/SettingsViewer';
import { SessionWorkPage } from './session-work/SessionWorkPage';
import { ProjectPage } from './project-page/ProjectPage';
import { TasksPage } from './tasks-page/TasksPage';
import { EmptyScreenPatch } from './patch/EmptyScreenPatch';
import { AskBox } from './ask/AskBox';
import { Questions } from './questions/Questions';
import { QuestionsHeaderButton } from './questions/QuestionsHeaderButton';
import { SessionList } from './session-list/SessionList';
import { TerminalHost } from './terminal/TerminalHost';
import { TerminalHeaderControls, TerminalHeaderInfo } from './terminal/TerminalHeader';
import { PairConfirmDialog } from './phone-access/PairConfirmDialog';
import { MarkDoneOffer } from './session-task/MarkDoneOffer';
import type { JSX } from 'react';
import type { Root as ReactRoot } from 'react-dom/client';

/** Every surface, each a `<Portal>` into its container (the toolbar and the dialogs place their own). */
export function Root(): JSX.Element | null {
  return (
    <>
      <Toolbar />
      <Dialogs />
      <PairConfirmDialog />
      <Portal target="settings-viewer"><SettingsViewer /></Portal>
      <Portal target="session-work"><SessionWorkPage /></Portal>
      <Portal target="project-page"><ProjectPage /></Portal>
      <Portal target="tasks-page"><TasksPage /></Portal>
      <Portal target="sidebar-footer"><Footer /></Portal>
      <Portal target="terminals"><TerminalHost /></Portal>
      <Portal target="terminal-header-info"><TerminalHeaderInfo /></Portal>
      <Portal target="terminal-header-controls"><TerminalHeaderControls /></Portal>
      <Portal target="terminals"><Questions /></Portal>
      <Portal target="terminal-header-questions"><QuestionsHeaderButton /></Portal>
      <Portal target="placeholder"><EmptyScreenPatch /><AskBox /></Portal>
      <Portal target="sidebar-content"><SessionList /></Portal>
      <Portal target="main"><MarkDoneOffer /></Portal>
    </>
  );
}

/**
 * Mount the root in a host element of its own.
 *
 * The host is hidden and empty: the root's own children are portals, which
 * render into their target containers, not into the host. Answers the root so
 * a hot reload can unmount it.
 */
export function mountReactRoot(): ReactRoot {
  const host = document.createElement('div');
  host.id = 'react-root';
  host.hidden = true;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<StrictMode><Root /></StrictMode>);
  return root;
}
