/**
 * Opening the "Add Project" dialog from vanilla code.
 *
 * The dialog itself is React (`ui/dialogs/AddProjectDialog`); this stays as
 * the entry point its callers already import, until they move too.
 */
import { openDialog } from '../../ui/dialogs/actions';

export function showAddProjectDialog(): void {
  openDialog({ kind: 'addProject' });
}
