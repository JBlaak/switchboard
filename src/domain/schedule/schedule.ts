/**
 * Scheduled tasks: a markdown file with a cron expression in its frontmatter.
 *
 * A schedule lives in the project's own `.claude/commands/` directory, so the
 * same file is both what Switchboard runs on a timer and a slash command the
 * user can invoke by hand. Each run resumes a freshly seeded session, which is
 * what groups the runs under one slug in the sidebar. A schedule's key, in the
 * Schedule manager and its run store, is its file's absolute path.
 */
import type {MissedPolicy, ScheduleSettings} from './manager';
import {block, parseFrontmatter, scalar} from './support/frontmatter';
import type {FrontmatterValue} from './support/frontmatter';

/** The `cli:` block of a schedule's frontmatter — flags passed through to claude. */
export type ScheduleCli = Record<string, string>;

/** A `schedule-*.md` file, parsed. */
export interface Schedule {
    file: string;
    filePath: string;
    projectPath: string;
    folder: string;
    name: string;
    cron: string;
    slug: string;
    cli: ScheduleCli;
    prompt: string;
    /** `enabled: false` turns it off; it is still listed, for the Schedule manager. */
    enabled: boolean;
    missed: MissedPolicy;
    /** Stop a run after this many minutes; null for no limit. */
    limitMinutes: number | null;
    /** Don't start when the week's all-models usage is past this percent; null for no cap. */
    weekCap: number | null;
    /** Run in a fresh worktree off the default branch rather than in the checkout. */
    worktree: boolean;
}

/** `limit-minutes` when the file does not say. */
export const DEFAULT_LIMIT_MINUTES = 30;
/** `week-cap` when the file does not say. */
export const DEFAULT_WEEK_CAP = 80;

/** Where a schedule file must live, relative to the project root. */
export const SCHEDULE_COMMANDS_SUBPATH = ['.claude', 'commands'];

/** Only files named this way are picked up as schedules. */
export function isScheduleFileName(name: string): boolean {
    return name.startsWith('schedule-') && name.endsWith('.md');
}

/** The slug a schedule file defaults to, from its own name. */
export function defaultScheduleSlug(fileName: string): string {
    return fileName.replace(/^schedule-/, '').replace(/\.md$/, '');
}

/** Where a schedule's identity comes from, beyond its own content. */
export interface ScheduleLocation {
    file: string;
    filePath: string;
    projectPath: string;
    folder: string;
}

/**
 * Parse a schedule file, or null when it is not a schedule yet.
 *
 * A file with no cron or no body is skipped rather than reported: it is still
 * being written. One with `enabled: false` is parsed, and off: the Schedule
 * manager lists it, and the tick leaves it alone.
 */
export function parseSchedule(content: string, location: ScheduleLocation): Schedule | null {
    const {meta, body} = parseFrontmatter(content);
    const cron = typeof meta.cron === 'string' ? meta.cron : null;
    if (!cron || !body) return null;

    return {
        ...location,
        name: scalar(meta, 'name', location.file),
        cron,
        slug: scalar(meta, 'slug', defaultScheduleSlug(location.file)),
        cli: block(meta, 'cli'),
        prompt: body,
        enabled: meta.enabled !== 'false',
        missed: meta.missed === 'skip' ? 'skip' : 'run-once',
        limitMinutes: optionalNumber(meta, 'limit-minutes', DEFAULT_LIMIT_MINUTES),
        weekCap: optionalNumber(meta, 'week-cap', DEFAULT_WEEK_CAP),
        worktree: meta.worktree !== 'false',
    };
}

/**
 * A positive number from the frontmatter: the default when absent or not a
 * number, null when the file says there is none (`none`, `off`, `0`). A
 * trailing `%` on `week-cap` is allowed.
 */
function optionalNumber(meta: Record<string, FrontmatterValue>, key: string, fallback: number): number | null {
    const value = meta[key];
    if (typeof value !== 'string') return fallback;
    const text = value.trim().replace(/%$/, '').toLowerCase();
    if (text === 'none' || text === 'off' || text === 'false') return null;
    const n = Number(text);
    if (text === '' || !Number.isFinite(n) || n < 0) return fallback;
    return n === 0 ? null : n;
}

/** The file's settings, as the Schedule manager shows and edits them. */
export function scheduleSettings(schedule: Schedule): ScheduleSettings {
    return {
        name: schedule.name,
        slug: schedule.slug,
        projectPath: schedule.projectPath,
        cron: schedule.cron,
        enabled: schedule.enabled,
        prompt: schedule.prompt,
        model: schedule.cli.model || null,
        permissionMode: schedule.cli['permission-mode'] || DEFAULT_PERMISSION_MODE,
        allowedTools: schedule.cli['allowed-tools'] || DEFAULT_ALLOWED_TOOLS,
        limitMinutes: schedule.limitMinutes,
        weekCap: schedule.weekCap,
        missed: schedule.missed,
        worktree: schedule.worktree,
    };
}

/**
 * Where a run with a worktree of its own works, and on which branch:
 * `<project>/.claude/worktrees/schedule-<slug>-<yyyymmdd-hhmm>` on
 * `schedule/<slug>-<yyyymmdd-hhmm>`, local time.
 */
export function scheduleWorktree(projectPath: string, slug: string, at: number): {path: string; branch: string} {
    const d = new Date(at);
    const two = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
    return {
        path: `${projectPath.replace(/\/+$/, '')}/.claude/worktrees/schedule-${slug}-${stamp}`,
        branch: `schedule/${slug}-${stamp}`,
    };
}

/** Raised when a frontmatter value cannot be passed to the CLI safely. */
export class UnsafeScheduleFieldError extends Error {}

/**
 * Defence in depth: reject control characters in frontmatter values.
 *
 * The shell quoter is the real defence — these values go into an argv that is
 * quoted before it reaches a shell — but a schedule file is the one input to
 * this app that another Claude session writes, so a value that could not
 * possibly be legitimate is refused rather than escaped.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function assertSafe(field: string, value: string): string {
    if (CONTROL_CHARS.test(value)) {
        throw new UnsafeScheduleFieldError(`Schedule field "${field}" contains unsafe characters`);
    }
    return value;
}

const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch';
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

/**
 * Appended to every run's system prompt, after the file's own: nobody is
 * there to answer during a run, and the report is what the Schedule manager
 * shows of it the next morning. Plain words without quotes or backticks, as
 * it goes through the user's shell.
 */
export const UNATTENDED_INSTRUCTIONS = [
    'You are running as a scheduled task, unattended: nobody is there to answer questions or approve anything,',
    'so do not ask. Decide what you can on your own and leave out what you cannot.',
    'End with a short report: one line per thing you did.',
    'If there was nothing to do, make the first line of the report exactly: Nothing to do.',
].join('\n');

/**
 * The `claude` argv for one scheduled run.
 *
 * A plain argv with zero shell interpretation — the caller shell-quotes it when
 * building the command string.
 */
export function buildScheduleArgs(sessionId: string, schedule: Pick<Schedule, 'cli'>): string[] {
    const cli: ScheduleCli = schedule.cli || {};
    const args = [
        '--resume',
        assertSafe('sessionId', sessionId),
        '-p',
        'Run the scheduled task',
        '--output-format',
        'json',
        '--permission-mode',
        assertSafe('permission-mode', cli['permission-mode'] || DEFAULT_PERMISSION_MODE),
    ];

    if (cli.model) args.push('--model', assertSafe('model', cli.model));

    if (cli['max-budget-usd']) {
        const budget = String(cli['max-budget-usd']).trim();
        if (!/^\d+(\.\d+)?$/.test(budget)) {
            throw new UnsafeScheduleFieldError(
                `Schedule field "max-budget-usd" must be a number, got: ${cli['max-budget-usd']}`,
            );
        }
        args.push('--max-budget-usd', budget);
    }

    args.push('--allowedTools', assertSafe('allowed-tools', cli['allowed-tools'] || DEFAULT_ALLOWED_TOOLS));

    // Newlines are legitimate in prompt text; other control characters are not.
    const own = cli['append-system-prompt'] ? String(cli['append-system-prompt']) : '';
    if (CONTROL_CHARS.test(own)) {
        throw new UnsafeScheduleFieldError('Schedule field "append-system-prompt" contains unsafe characters');
    }
    args.push('--append-system-prompt', own.trim() ? `${own}\n\n${UNATTENDED_INSTRUCTIONS}` : UNATTENDED_INSTRUCTIONS);

    if (cli['add-dirs']) {
        for (const dir of String(cli['add-dirs'])
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean)) {
            args.push('--add-dir', assertSafe('add-dirs', dir));
        }
    }

    return args;
}
