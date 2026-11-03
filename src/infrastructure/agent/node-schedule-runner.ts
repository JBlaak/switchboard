/**
 * Running a scheduled task's headless `claude` on the VM, behind the
 * scheduler's CommandRunner port (#276 stage 5).
 *
 * The Mac's runner (`claude-cli/command-runner.ts`) is Electron-free, but it
 * goes through a shell profile from the Mac's settings, so that `claude` sees
 * the PATH an interactive session would. The agent already has that PATH: it
 * asked the VM user's login shell for its environment once at start, and every
 * PTY gets it. So `claude` is spawned directly with that environment, without
 * a shell and so without any quoting of the schedule's own text.
 *
 * Every launch on a host gets the host instructions after the project's own
 * appended prompt (Q25), and a scheduled run is a launch: a schedule's
 * `append-system-prompt` keeps its text, with the host's after it, and one
 * without gets the host's alone.
 *
 * The process is detached, in its own process group, so a run in progress
 * when the agent restarts (an upgrade) is not taken down by a signal to the
 * agent's group; systemd's stop of the whole unit still ends it. Nobody
 * watches a run, so what it prints goes to the agent's log, the journal:
 * stdout is the run's final answer, stderr says why one failed. Both are
 * capped, since the real record of a run is the transcript it writes.
 */
import {spawn} from 'node:child_process';

import type {CommandRunner} from '../../application/ports/claude-cli';
import type {Logger} from '../../application/ports/logger';
import {withHostInstructions} from '../../domain/agent/host-instructions';
import {headlessEnv} from '../../domain/launch/terminal-env';

/** The most of a run's stdout and of its stderr kept for the journal. */
export const SCHEDULE_OUTPUT_CAP_CHARS = 16 * 1024;

const APPEND_SYSTEM_PROMPT = '--append-system-prompt';

export interface NodeScheduleRunnerDeps {
    /** The login shell's environment, with the PATH that finds `claude`. */
    env: Record<string, string>;
    /** The host instructions now, read at each run so an edit counts on the next. */
    hostInstructions: () => string;
    log: Logger;
    /** The command to run; `claude`, or a fake in tests. */
    command?: string;
}

export class NodeScheduleRunner implements CommandRunner {
    constructor(private readonly deps: NodeScheduleRunnerDeps) {}

    public run(claudeArgs: readonly string[], cwd: string, name: string, onDone: () => void): void {
        const {env, log} = this.deps;
        const command = this.deps.command ?? 'claude';
        const args = withHostInstructionsArgs(claudeArgs, this.deps.hostInstructions());
        log.info(`[schedule] running ${name} in ${cwd}`);

        let finished = false;
        const done = () => {
            if (finished) return;
            finished = true;
            onDone();
        };

        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env: headlessEnv(env),
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            log.error(`[schedule] ${name} could not start:`, errorText(err));
            done();
            return;
        }

        const stdout = capped();
        const stderr = capped();
        child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));

        // 'close' comes after the streams are drained, so the output is whole.
        child.on('close', (code, signal) => {
            if (stdout.text().trim()) log.info(`[schedule] ${name} output:\n${stdout.text().trim()}`);
            if (stderr.text().trim()) log.error(`[schedule] ${name} stderr:\n${stderr.text().trim()}`);
            log.info(`[schedule] ${name} finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
            done();
        });
        child.on('error', (err: Error) => {
            log.error(`[schedule] ${name} error:`, err.message);
            done();
        });
    }
}

/**
 * The schedule's argv with the host instructions applied: put after the
 * schedule's own `--append-system-prompt` text, or added as one when it has
 * none. Unchanged when the host has no instructions.
 */
export function withHostInstructionsArgs(claudeArgs: readonly string[], hostInstructions: string): string[] {
    const args = [...claudeArgs];
    const at = args.indexOf(APPEND_SYSTEM_PROMPT);
    const own = at >= 0 ? args[at + 1] : undefined;
    const prompt = withHostInstructions(own, hostInstructions);
    if (at >= 0) {
        if (prompt === undefined) args.splice(at, 2);
        else args[at + 1] = prompt;
    } else if (prompt !== undefined) {
        args.push(APPEND_SYSTEM_PROMPT, prompt);
    }
    return args;
}

/** Collects text up to SCHEDULE_OUTPUT_CAP_CHARS, keeping the start. */
function capped(): {add(chunk: Buffer): void; text(): string} {
    let text = '';
    let cut = false;
    return {
        add(chunk) {
            if (cut) return;
            text += chunk.toString('utf8');
            if (text.length > SCHEDULE_OUTPUT_CAP_CHARS) {
                text = text.slice(0, SCHEDULE_OUTPUT_CAP_CHARS) + '\n[…cut]';
                cut = true;
            }
        },
        text: () => text,
    };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
