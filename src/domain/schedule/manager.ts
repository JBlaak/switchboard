/**
 * The Schedule manager: what the page, the Automatic shelf and the figure on
 * the empty screen are told about the schedules and their runs.
 *
 * A schedule is still a `schedule-*.md` file in a project's
 * `.claude/commands/` (see `schedule.ts`); Switchboard keeps what the file
 * cannot: every run, what it said, how much of the week it used, and every
 * version of the prompt.
 *
 * Runs use the user's own Claude subscription, so their cost is told as a
 * share of the weekly limit (the usage endpoint's all-models week, sampled
 * before and after), never in dollars.
 */

/** What became of one run. */
export type RunStatus =
    /** Going now. */
    | 'running'
    /** Finished on its own. */
    | 'done'
    /** Ended with an error (a non-zero exit, a crash, the CLI refused). */
    | 'failed'
    /** Stopped by its time limit. */
    | 'limit'
    /** Not started: skipped by the user, the week cap, or the previous run still going. */
    | 'skipped'
    /** Not started because the Mac was asleep or off, and the schedule skips missed runs. */
    | 'missed';

/** What started a run. */
export type RunTrigger =
    /** Its cron time came. */
    | 'cron'
    /** A missed cron time, run once when the Mac woke or Switchboard started. */
    | 'catch-up'
    /** Run now. */
    | 'manual'
    /** Save and try it now, from the create form. */
    | 'try';

/** One run of a schedule. Times are epoch ms. */
export interface ScheduleRun {
    readonly id: string;
    /** The schedule's key (`ScheduleSummary.key`). */
    readonly scheduleKey: string;
    /** The session it ran in; null for a run that never started. */
    readonly sessionId: string | null;
    readonly trigger: RunTrigger;
    /** The cron time it was for; null for a manual or try run. */
    readonly dueAt: number | null;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
    readonly status: RunStatus;
    /**
     * Why, in a few words, when the status needs one: "the Mac was asleep at
     * 03:00", "you pressed Skip tonight", "the week was past 80%", "its 20 min
     * limit", "exit 1: …".
     */
    readonly reason: string | null;
    /** The prompt version it ran with. */
    readonly promptVersion: number;
    /** The run's last message (the `result` of `--output-format json`), its report; null until it ends. */
    readonly report: string | null;
    /** The all-models weekly limit used, in percent, when it started and when it ended; null when unknown. */
    readonly weekBefore: number | null;
    readonly weekAfter: number | null;
    /** The worktree it worked in, when it had one of its own. */
    readonly worktree: string | null;
    /** Opened or marked seen by the user. Runs that found nothing to do arrive seen. */
    readonly seen: boolean;
}

/** What a schedule does when the Mac slept through its time. */
export type MissedPolicy = 'run-once' | 'skip';

/**
 * A schedule's settings, as the detail page and the create form edit them.
 * Saved into the schedule file's frontmatter (`enabled`, `cron`, `name`,
 * `slug`, `missed`, `limit-minutes`, `week-cap`, `worktree`, and the `cli:`
 * block's `model`, `permission-mode`, `allowed-tools`) and body (`prompt`).
 */
export interface ScheduleSettings {
    readonly name: string;
    readonly slug: string;
    /** The local project it runs in, absolute. */
    readonly projectPath: string;
    /** Five-field cron, local time. */
    readonly cron: string;
    readonly enabled: boolean;
    readonly prompt: string;
    /** `sonnet`, `opus`, …; null for the CLI's default. */
    readonly model: string | null;
    readonly permissionMode: string;
    /** Comma-separated, as `--allowedTools` takes them. */
    readonly allowedTools: string;
    /** Stop the run after this many minutes; null for no limit. */
    readonly limitMinutes: number | null;
    /** Don't start when the week is past this percent; null for no cap. */
    readonly weekCap: number | null;
    readonly missed: MissedPolicy;
    /** Work in a fresh worktree off the default branch rather than the checkout. */
    readonly worktree: boolean;
}

/** Where a schedule runs: this Mac, or a project's copy on a VM (#276 stage 5). */
export type ScheduleRunsOn = {readonly kind: 'mac'} | {readonly kind: 'vm'; readonly host: string};

/** The group a schedule sits in on the page. */
export type ScheduleGroup =
    /** Its last run failed, hit its limit or was missed, and is not seen yet. */
    | 'needsYou'
    /** Running now. */
    | 'running'
    /** On, waiting for its next time. */
    | 'scheduled'
    /** Off. */
    | 'paused'
    /** Written outside Switchboard (the slash command, by hand) and never run: off until turned on. */
    | 'new';

/** One schedule on the overview. */
export interface ScheduleSummary {
    /** Stable: the schedule file's absolute path. */
    readonly key: string;
    readonly settings: ScheduleSettings;
    readonly runsOn: ScheduleRunsOn;
    readonly group: ScheduleGroup;
    /** Its next cron time from now (epoch ms); null when paused or the cron never matches. */
    readonly nextRunAt: number | null;
    /** The last 14 runs' statuses, oldest first. */
    readonly lastRuns: readonly RunStatus[];
    /** Its newest run, if any. */
    readonly last: ScheduleRun | null;
    /** The median run length in minutes over its finished runs; null with none. */
    readonly typicalMinutes: number | null;
    /** The median share of the week a run used, in percent; null when unknown. */
    readonly typicalWeekShare: number | null;
    /** The prompt's current version. */
    readonly promptVersion: number;
}

/** Everything the overview, the shelf and the figure need, pushed on every change. */
export interface ScheduleManagerFacts {
    readonly schedules: readonly ScheduleSummary[];
    /** Every schedule's runs that started, ended or were due in the last 36 hours, for the night strip and the shelf. */
    readonly recentRuns: readonly ScheduleRun[];
    /** The repeating wake this Mac is set to, `HH:MM`, or null when none is set. */
    readonly wakeAt: string | null;
    /** The wake Switchboard suggests: 5 minutes before the earliest nightly run on this Mac, `HH:MM`; null with none. */
    readonly suggestedWakeAt: string | null;
    /** The all-models weekly limit used now, in percent; null when unknown. */
    readonly week: number | null;
}

/** One saved version of a schedule's prompt. */
export interface PromptVersion {
    readonly version: number;
    readonly text: string;
    readonly savedAt: number;
    /** What changed, when the user said, or "edited outside Switchboard". */
    readonly note: string | null;
}

/** One schedule's page. */
export interface ScheduleDetail {
    readonly summary: ScheduleSummary;
    /** Newest first, at most 50. */
    readonly runs: readonly ScheduleRun[];
    /** Newest first. */
    readonly versions: readonly PromptVersion[];
    readonly stats: {
        readonly total: number;
        readonly done: number;
        readonly failed: number;
        readonly caughtUp: number;
        /** The first run's start; null with none. */
        readonly since: number | null;
        readonly medianMinutes: number | null;
        readonly medianWeekShare: number | null;
        /** The share of this week its runs used so far; null when unknown. */
        readonly thisWeekShare: number | null;
    };
}

/** A schedule Claude drafted from a sentence or a session, for the create form to review. */
export interface ScheduleDraft {
    readonly settings: ScheduleSettings;
    /** Why that time, in a few words: "\"every night\"; 03:00 because nothing else runs then". */
    readonly whenReason: string | null;
}

export type ScheduleSaveResult = {readonly key: string} | {readonly error: string};
export type ScheduleDraftResult = {readonly draft: ScheduleDraft} | {readonly error: string};
export type ScheduleActionResult = {readonly ok: true} | {readonly error: string};
