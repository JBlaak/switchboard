/**
 * Opening the project picker ("New Session") from vanilla code.
 *
 * The picker itself is React (`ui/dialogs/ProjectPicker`); this stays as the
 * entry point the toolbar, the shortcuts and the terminal already import,
 * until they move too.
 */
import { openDialog } from '../../ui/dialogs/actions';

export function showProjectPickerDialog(): void {
  openDialog({ kind: 'projectPicker' });
}
