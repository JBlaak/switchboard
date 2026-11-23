/**
 * Tune the prompt from this run: what a new interactive session in the
 * schedule's project is asked, so Claude improves the schedule's prompt from
 * what one run did. It reads that run's transcript by its session id and
 * edits only the prompt in the schedule's file; Switchboard sees the file
 * change and keeps it as a new version ("edited outside Switchboard").
 */
import type {ScheduleRun} from './manager';
import {statusWord} from './page-view';

export function tunePrompt(key: string, name: string, run: ScheduleRun): string {
    const lines = [
        `Help me improve the Switchboard schedule "${name}", saved in ${key}.`,
        '',
        `One of its runs went like this: ${statusWord(run)}${run.reason ? ` (${run.reason})` : ''}, with prompt v${run.promptVersion}.`,
    ];
    if (run.sessionId) {
        lines.push(
            `Its transcript is the Claude Code session ${run.sessionId} (the ${run.sessionId}.jsonl file under ~/.claude/projects/): read it to see what the run did and where it lost time or went wrong.`,
        );
    }
    if (run.report) lines.push('', 'Its report:', '', ...run.report.split('\n').map((line) => `> ${line}`));
    lines.push(
        '',
        'Then rewrite the prompt in the body of that file so the next run does better. Keep the frontmatter as it is. Tell me what you changed and why before you save it.',
    );
    return lines.join('\n');
}
