/**
 * The session's task outside React (#250): which sessions are linked, asked
 * at start and again whenever Settings are saved (the BlaakTasks URL may
 * have been set, changed or cleared), and the task fetched as a link or an
 * archive's offer names it.
 */
import { onEvent } from '../../state/app-store';
import { loadSessionTasks, loadTask } from './actions';

/** Start following. Answers a teardown. */
export function installSessionTask(): () => void {
  void loadSessionTasks();
  const stops = [
    onEvent('settingsSaved', () => void loadSessionTasks()),
    onEvent('sessionTaskChanged', (event) => {
      if (event.taskId) loadTask(event.taskId);
    }),
    // The offer names the task, as it is now.
    onEvent('taskMarkDoneOffered', (event) => loadTask(event.taskId, { fresh: true })),
  ];
  return () => stops.forEach((stop) => stop());
}
