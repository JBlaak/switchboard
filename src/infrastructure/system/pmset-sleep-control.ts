/**
 * `pmset disablesleep` behind the SleepControl port.
 *
 * Reading needs no privileges. Writing does: it first tries `sudo -n`, which
 * succeeds without a prompt when sudoers lets pmset through without a password,
 * and otherwise asks through macOS's own administrator dialog via osascript.
 * Cancelling that dialog is not an error — the switch simply stays where it was.
 */
import { execFile } from 'node:child_process';
import { disableSleepArgs, parseSleepDisabled } from '../../domain/power/sleep';
import type { Logger } from '../../application/ports/logger';
import type { SleepControl } from '../../application/ports/sleep-control';

const PMSET = '/usr/bin/pmset';

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export class PmsetSleepControl implements SleepControl {
  constructor(private readonly log: Logger) {}

  async isSleepDisabled(): Promise<boolean | null> {
    if (process.platform !== 'darwin') return null;
    const output = await run(PMSET, ['-g']);
    return output === null ? null : parseSleepDisabled(output);
  }

  async setSleepDisabled(disabled: boolean): Promise<boolean | null> {
    if (process.platform !== 'darwin') return null;
    const args = disableSleepArgs(disabled);

    const viaSudo = await run('/usr/bin/sudo', ['-n', PMSET, ...args]);
    if (viaSudo === null) {
      const command = [PMSET, ...args].join(' ');
      const viaPrompt = await run('/usr/bin/osascript', [
        '-e', `do shell script "${command}" with administrator privileges`,
      ]);
      if (viaPrompt === null) this.log.info(`[sleep] ${command} not applied (prompt cancelled or failed)`);
    }

    return this.isSleepDisabled();
  }
}
