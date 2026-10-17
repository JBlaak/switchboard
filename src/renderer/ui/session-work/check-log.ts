/**
 * The Checks panel's one action: reading the end of a failing check's log
 * from main, once per check run (a finished run's log does not change).
 */
import { dispatch, getState } from '../../state/app-store';

export function loadCheckLog(repository: string, checkRunUrl: string): void {
  if (getState().ciStatus.checkLogs[checkRunUrl]) return;
  dispatch({ type: 'checkLogRequested', url: checkRunUrl });
  window.api.getCheckLog({ repository, checkRunUrl })
    .catch(() => null)
    .then((text) => dispatch({ type: 'checkLogLoaded', url: checkRunUrl, text }));
}
