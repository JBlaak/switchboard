/**
 * The dialog layer: whichever modal dialog the store says is open.
 *
 * Keyed on the opening's `seq`, so opening a dialog again — even the same kind
 * — starts it fresh rather than keeping the last one's filter or half-typed
 * fields. Each dialog closes by its own `seq`, so a late close from one that
 * has since been replaced cannot close its successor.
 */
import { useStore } from '../use-store';
import { closeDialog } from './actions';
import { AddProjectDialog } from './AddProjectDialog';
import { ProjectPicker } from './ProjectPicker';
import { ResumeSessionDialog } from './ResumeSessionDialog';
import type { JSX } from 'react';

export function Dialogs(): JSX.Element | null {
  const { open, seq } = useStore(state => state.dialog);
  if (!open) return null;

  const onClose = (): void => closeDialog(seq);
  switch (open.kind) {
    case 'projectPicker':
      return <ProjectPicker key={seq} onClose={onClose} initialPrompt={open.initialPrompt} />;
    case 'addProject':
      return <AddProjectDialog key={seq} onClose={onClose} />;
    case 'resumeSession':
      return <ResumeSessionDialog key={seq} session={open.session} settings={open.settings} onClose={onClose} />;
  }
}
