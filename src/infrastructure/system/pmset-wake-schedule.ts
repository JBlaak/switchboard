/**
 * `pmset repeat` behind the WakeSchedule port, in the style of the sleep
 * switch (`pmset-sleep-control.ts`): reading needs no privileges; writing
 * first tries `sudo -n`, which succeeds without a prompt when sudoers lets
 * pmset through, and otherwise asks through macOS's own administrator dialog
 * via osascript. Unlike the sleep switch, a cancelled dialog is answered as
 * an error, so the page can say the wake was not changed.
 */
import {execFile} from 'node:child_process';
import {parseRepeatingWake, promptCancelled, repeatWakeArgs} from '../../domain/power/wake';
import type {Logger} from '../../application/ports/logger';
import type {WakeSchedule} from '../../application/ports/wake-schedule';
import type {ScheduleActionResult} from '../../domain/schedule/manager';

const PMSET = '/usr/bin/pmset';

interface Ran {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

function run(file: string, args: string[]): Promise<Ran> {
    return new Promise((resolve) => {
        execFile(file, args, {timeout: 120_000}, (err, stdout, stderr) =>
            resolve({ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || '')}),
        );
    });
}

export class PmsetWakeSchedule implements WakeSchedule {
    constructor(private readonly log: Logger) {}

    public async read(): Promise<string | null> {
        if (process.platform !== 'darwin') return null;
        const output = await run(PMSET, ['-g', 'sched']);
        return output.ok ? parseRepeatingWake(output.stdout) : null;
    }

    public async set(at: string | null): Promise<ScheduleActionResult> {
        if (process.platform !== 'darwin') return {error: 'Waking the computer is only set on a Mac'};
        let args: string[];
        try {
            args = repeatWakeArgs(at);
        } catch (err) {
            return {error: (err as Error).message};
        }

        const viaSudo = await run('/usr/bin/sudo', ['-n', PMSET, ...args]);
        if (viaSudo.ok) return {ok: true};

        // Every argument is a fixed word or a checked HH:MM:00, so the command needs no quoting.
        const command = [PMSET, ...args].join(' ');
        const viaPrompt = await run('/usr/bin/osascript', [
            '-e',
            `do shell script "${command}" with administrator privileges`,
        ]);
        if (viaPrompt.ok) return {ok: true};
        if (promptCancelled(viaPrompt.stderr)) {
            this.log.info(`[schedule-manager] ${command} not applied: the password prompt was cancelled`);
            return {error: 'The password prompt was cancelled, so the wake was not changed'};
        }
        const reason = viaPrompt.stderr.trim().split('\n')[0] || 'pmset failed';
        this.log.warn(`[schedule-manager] ${command} failed: ${reason}`);
        return {error: `Could not set the wake: ${reason}`};
    }
}
