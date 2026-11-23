/**
 * The Schedule manager's page: its facts and each schedule's details, saving
 * a schedule's file, turning one on or off, running or skipping it, drafting
 * one with Claude, and the Mac's wake.
 *
 * The scheduler (`ScheduleEngine`) finds the files and runs them; this
 * service reads what it knows and what the run store kept, and writes the
 * files the scheduler reads back on its next scan. Every change it makes, and
 * every one the scheduler reports, pushes the whole facts to the renderer:
 * nothing here polls.
 */
import {chatMessagesOf} from '../../domain/session/chat';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {isValidCron} from '../../domain/schedule/next-run';
import {scheduleFileParts, scheduleFileText, scheduleSlug} from '../../domain/schedule/file-writer';
import {conversationText, draftArgs, draftPrompt, readDraftRun} from '../../domain/schedule/draft';
import {DETAIL_RUNS, RECENT_RUNS_MS, managerFacts, scheduleDetail, scheduleSummary} from '../../domain/schedule/page';
import {isClockTime} from '../../domain/power/wake';
import type {DraftProject, DraftRequest} from '../../domain/schedule/draft';
import type {
    ScheduleActionResult,
    ScheduleDetail,
    ScheduleDraftResult,
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleSaveResult,
    ScheduleSettings,
    ScheduleSummary,
} from '../../domain/schedule/manager';
import type {ClaudeCaller} from '../ports/claude-cli';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {FileSystem} from '../ports/file-system';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {ScheduleRunStore} from '../ports/schedule-runs';
import type {TranscriptQueries} from '../ports/transcript-queries';
import type {WakeSchedule} from '../ports/wake-schedule';
import type {ScheduleEngine, ScheduleEntry} from './schedule-engine';

/** How long Sonnet gets to draft before the form is told it took too long. */
export const DRAFT_TIMEOUT_MS = 120_000;
/** How long the wake read from pmset is trusted before it is read again. */
export const WAKE_FRESH_MS = 60_000;
/** The most runs of one schedule the page's stats count. */
const STATS_RUNS = 10_000;
/** How much of a session's transcript start and end the draft reads. */
const SESSION_HEAD_BYTES = 256 * 1024;
const SESSION_TAIL_BYTES = 512 * 1024;

/** The note on the first version of a schedule written outside Switchboard, when it is turned on. */
export const WRITTEN_OUTSIDE_NOTE = 'written outside Switchboard';
/** The note on the first version of a schedule created on the page. */
export const CREATED_NOTE = 'created';

export interface ScheduleManagerServiceDeps {
    engine: ScheduleEngine;
    runs: ScheduleRunStore;
    fs: Pick<
        FileSystem,
        'exists' | 'isDirectory' | 'readText' | 'writeText' | 'makeDir' | 'remove' | 'join' | 'dirname'
    >;
    wake: WakeSchedule;
    /** The all-models week used, in percent, as last read from the usage endpoint; never a fresh call. */
    week: () => number | null;
    cli: Pick<ClaudeCaller, 'call'>;
    /** The local projects a draft may pick from (`routeCandidates`). */
    projects: () => readonly DraftProject[];
    /** Where a session's transcript is. */
    locate: (sessionId: string) => {folder: string | null; projectPath: string} | null;
    transcripts: Pick<TranscriptQueries, 'readHeadLines' | 'readTail'>;
    renderer: Pick<RendererGateway, 'scheduleManagerChanged'>;
    /** Archive a session: Mark all read puts the runs' sessions away with them. */
    archive?: (sessionId: string) => void;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** How far back Mark all read looks for sessions to archive: as far as the shelf shows runs. */
const MARK_ALL_WINDOW_MS = 36 * 60 * 60 * 1000;

export class ScheduleManagerService {
    private unsubscribe: (() => void) | null = null;
    private wakeRead: {at: string | null; readAt: number} | null = null;

    constructor(private readonly deps: ScheduleManagerServiceDeps) {}

    /** Push on every change the scheduler reports, and once now. */
    public start(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.deps.engine.onChanged(() => this.push());
        this.push();
    }

    public stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    // ── Reading ──

    public async facts(): Promise<ScheduleManagerFacts> {
        const {engine, runs, clock} = this.deps;
        const now = clock.now();
        const files = engine.all();
        return managerFacts({
            summaries: files.map((entry) => this.summary(entry, runs.runsOf(entry.key, DETAIL_RUNS), now)),
            files,
            recentRuns: runs.runsSince(now - RECENT_RUNS_MS),
            wakeAt: await this.wakeAt(),
            week: this.deps.week(),
        });
    }

    public detail(key: string): ScheduleDetail | null {
        const entry = this.entry(key);
        if (!entry) return null;
        const now = this.deps.clock.now();
        const all = this.deps.runs.runsOf(key, STATS_RUNS);
        return scheduleDetail(this.summary(entry, all, now), all, this.deps.runs.versionsOf(key), now);
    }

    private summary(entry: ScheduleEntry, runs: readonly ScheduleRun[], now: number): ScheduleSummary {
        return scheduleSummary({
            file: entry,
            runs,
            running: this.deps.engine.isRunning(entry.key),
            promptVersion: this.deps.runs.versionsOf(entry.key)[0]?.version ?? 0,
            now,
        });
    }

    // ── Saving ──

    /**
     * Write a schedule's file. A new one (`key` null) goes to its project's
     * `.claude/commands/schedule-<slug>.md` and never over another file; an
     * existing one is rewritten in place, keeping what the page does not
     * edit, and moved (its runs and versions with it) when its slug or
     * project changed. The prompt is recorded as a version either way.
     */
    public save(
        key: string | null,
        settings: ScheduleSettings,
        note: string | null,
        runNow: boolean,
    ): ScheduleSaveResult {
        const {fs, runs, engine, clock, log} = this.deps;
        const invalid = this.invalid(settings);
        if (invalid) return {error: invalid};

        const slug = scheduleSlug(settings.slug) || scheduleSlug(settings.name);
        const target = fs.join(settings.projectPath, ...scheduleFileParts(slug));
        const saved: ScheduleSettings = {...settings, slug};

        if (key === null) {
            if (fs.exists(target)) return {error: `This project already has a schedule saved as ${slug}`};
            fs.makeDir(fs.dirname(target));
            fs.writeText(target, scheduleFileText(saved));
        } else {
            if (!fs.exists(key)) return {error: 'That schedule’s file is gone'};
            const existing = fs.readText(key);
            if (target !== key) {
                if (fs.exists(target)) return {error: `This project already has a schedule saved as ${slug}`};
                fs.makeDir(fs.dirname(target));
                fs.writeText(target, scheduleFileText(saved, existing));
                fs.remove(key);
                runs.rekey(key, target);
            } else {
                fs.writeText(target, scheduleFileText(saved, existing));
            }
        }

        runs.versionFor(target, saved.prompt.trim(), clock.now(), note?.trim() || (key === null ? CREATED_NOTE : null));
        if (runNow) {
            const started = engine.runNow(target, 'try');
            // Saved either way: the form shows it saved, and the run's absence on the page says the rest.
            if ('error' in started)
                log.warn(`[schedule-manager] saved ${target} but could not try it: ${started.error}`);
        }
        this.push();
        return {key: target};
    }

    /** Why these settings cannot be saved, or null when they can. */
    private invalid(settings: ScheduleSettings): string | null {
        const {fs} = this.deps;
        if (!settings.name.trim()) return 'A schedule needs a name';
        if (!scheduleSlug(settings.slug) && !scheduleSlug(settings.name)) return 'The name needs a letter or a digit';
        if (!settings.prompt.trim()) return 'A schedule needs a prompt';
        if (!isValidCron(settings.cron)) return `“${settings.cron.trim()}” is not a time the scheduler can read`;
        if (isRemoteProjectPath(settings.projectPath) || !fs.isDirectory(settings.projectPath)) {
            return 'That project is not on this Mac';
        }
        if (settings.limitMinutes !== null && !(Number.isInteger(settings.limitMinutes) && settings.limitMinutes > 0)) {
            return 'The time limit is a whole number of minutes';
        }
        if (settings.weekCap !== null && !(settings.weekCap > 0 && settings.weekCap <= 100)) {
            return 'The week cap is a percentage';
        }
        return null;
    }

    /**
     * Turn a schedule on or off in its file. Turning on one written outside
     * Switchboard records its prompt as version 1, which is what lets the
     * scheduler run it.
     */
    public setEnabled(key: string, enabled: boolean): ScheduleActionResult {
        const {fs, runs, clock} = this.deps;
        const entry = this.entry(key);
        if (!entry || !fs.exists(key)) return {error: 'That schedule’s file is gone'};
        fs.writeText(key, scheduleFileText({...entry.settings, enabled}, fs.readText(key)));
        if (enabled && entry.isNew)
            runs.versionFor(key, entry.settings.prompt.trim(), clock.now(), WRITTEN_OUTSIDE_NOTE);
        this.push();
        return {ok: true};
    }

    // ── Runs ──

    public runNow(key: string): ScheduleActionResult {
        const result = this.deps.engine.runNow(key, 'manual');
        this.push();
        return result;
    }

    public skipNext(key: string): ScheduleActionResult {
        const result = this.deps.engine.skipNext(key);
        this.push();
        return result;
    }

    public markSeen(runId: string): void {
        const run = this.deps.runs.get(runId);
        if (!run || run.seen) return;
        this.deps.runs.update(runId, {seen: true});
        this.push();
    }

    /**
     * Every finished run seen, and the sessions of those not seen until now
     * archived: they were read on the shelf, not opened. A run opened from the
     * shelf is left as it is, since the user is looking at it.
     */
    public markAllSeen(): void {
        const {runs, clock, archive} = this.deps;
        const unseen = runs
            .runsSince(clock.now() - MARK_ALL_WINDOW_MS)
            .filter((run) => !run.seen && run.status !== 'running' && run.sessionId);
        if (runs.markAllSeen() === 0) return;
        for (const run of unseen) archive?.(run.sessionId!);
        this.push();
    }

    // ── Drafting ──

    /** Claude drafts a schedule from one sentence, in `projectPath` or one it picks. */
    public draft(sentence: string, projectPath: string | null): Promise<ScheduleDraftResult> {
        if (!sentence.trim()) return Promise.resolve({error: 'Say what it should do, and when'});
        return this.callDraft({
            ask: {kind: 'sentence', text: sentence},
            projectPath,
            projects: projectPath ? [] : this.deps.projects(),
            existing: this.existing(),
        });
    }

    /** Claude drafts a schedule that repeats what a session asked for and did, in its project. */
    public async draftFromSession(sessionId: string): Promise<ScheduleDraftResult> {
        const {locate, transcripts, log} = this.deps;
        const location = locate(sessionId);
        if (!location?.folder || isRemoteProjectPath(location.projectPath)) {
            return {error: 'That session’s transcript is not on this Mac'};
        }
        let lines: string[];
        try {
            const head = await transcripts.readHeadLines(location.folder, sessionId, SESSION_HEAD_BYTES);
            const tail = (await transcripts.readTail(location.folder, sessionId, SESSION_TAIL_BYTES)).split('\n');
            lines = [...head, ...tail];
        } catch (err) {
            log.warn('[schedule-manager] could not read the session for a draft:', (err as Error).message);
            return {error: 'Could not read that session'};
        }
        const conversation = conversationText(chatMessagesOf(lines));
        if (!conversation) return {error: 'That session has nothing to repeat yet'};
        return this.callDraft({
            ask: {kind: 'session', conversation},
            projectPath: location.projectPath,
            projects: [],
            existing: this.existing(),
        });
    }

    private existing(): DraftRequest['existing'] {
        return this.deps.engine
            .all()
            .filter((entry) => entry.settings.enabled)
            .map((entry) => ({
                name: entry.settings.name,
                cron: entry.settings.cron,
                projectPath: entry.settings.projectPath,
            }));
    }

    private async callDraft(request: DraftRequest): Promise<ScheduleDraftResult> {
        const {cli, timers, log} = this.deps;
        const controller = new AbortController();
        let timer: TimerHandle = null;
        const timedOut = new Promise<ScheduleDraftResult>((resolve) => {
            timer = timers.setTimeout(() => {
                log.warn('[schedule-manager] the draft timed out');
                resolve({error: 'Claude took too long to draft it. Try again?'});
            }, DRAFT_TIMEOUT_MS);
        });
        const answered = cli.call(draftArgs(draftPrompt(request)), controller.signal).then(
            (run) => readDraftRun(run, request),
            (err: Error): ScheduleDraftResult => {
                log.warn('[schedule-manager] could not run the draft:', err.message);
                return {error: 'Could not start Claude to draft it'};
            },
        );
        try {
            return await Promise.race([answered, timedOut]);
        } finally {
            timers.clearTimeout(timer);
            controller.abort();
        }
    }

    // ── The wake ──

    /** Wake the Mac at `at` (`HH:MM`) every day, or (null) stop. Asks for an administrator password. */
    public async setWake(at: string | null): Promise<ScheduleActionResult> {
        if (at !== null && !isClockTime(at)) return {error: `“${at}” is not a time of day`};
        const result = await this.deps.wake.set(at);
        this.wakeRead = null;
        this.push();
        return result;
    }

    private async wakeAt(): Promise<string | null> {
        const now = this.deps.clock.now();
        if (this.wakeRead && now - this.wakeRead.readAt < WAKE_FRESH_MS) return this.wakeRead.at;
        const at = await this.deps.wake.read().catch(() => null);
        this.wakeRead = {at, readAt: now};
        return at;
    }

    // ── Helpers ──

    private entry(key: string): ScheduleEntry | null {
        return this.deps.engine.all().find((entry) => entry.key === key) ?? null;
    }

    private push(): void {
        this.facts().then(
            (facts) => this.deps.renderer.scheduleManagerChanged(facts),
            (err: Error) => this.deps.log.warn('[schedule-manager] could not build the facts:', err.message),
        );
    }
}
