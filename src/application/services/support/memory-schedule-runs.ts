/**
 * A ScheduleRunStore that keeps everything in memory, for the scheduler on a
 * VM, whose runs are not recorded on the Mac (#276 stage 5), and for tests.
 * Ordered as the SQLite store is: by start, else cron time, else end; newest
 * first, the later added first on a tie. Only the last `MEMORY_RUNS_KEPT`
 * runs are kept: an agent runs for weeks, and an every-minute schedule would
 * otherwise grow it without end.
 */
import type {PromptVersion, RunStatus, ScheduleRun} from '../../../domain/schedule/manager';
import type {ScheduleRunStore} from '../../ports/schedule-runs';

export const MEMORY_RUNS_KEPT = 500;

function placeOf(run: ScheduleRun): number {
    return run.startedAt ?? run.dueAt ?? run.endedAt ?? 0;
}

export class MemoryScheduleRunStore implements ScheduleRunStore {
    private runs: ScheduleRun[] = [];
    private readonly versions = new Map<string, PromptVersion[]>();

    public add(run: ScheduleRun): void {
        this.runs.push(run);
        if (this.runs.length > MEMORY_RUNS_KEPT) {
            const oldest = this.runs.findIndex((kept) => kept.status !== 'running');
            if (oldest >= 0) this.runs.splice(oldest, 1);
        }
    }

    public update(id: string, change: Partial<Omit<ScheduleRun, 'id' | 'scheduleKey'>>): void {
        const defined = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
        this.runs = this.runs.map((run) => (run.id === id ? {...run, ...defined} : run));
    }

    public get(id: string): ScheduleRun | null {
        return this.runs.find((run) => run.id === id) ?? null;
    }

    public runsOf(scheduleKey: string, limit: number): ScheduleRun[] {
        return this.newestFirst()
            .filter((run) => run.scheduleKey === scheduleKey)
            .slice(0, limit);
    }

    public runsSince(since: number): ScheduleRun[] {
        return this.newestFirst().filter((run) =>
            [run.startedAt, run.endedAt, run.dueAt].some((at) => at !== null && at >= since),
        );
    }

    public runningRuns(): ScheduleRun[] {
        return this.newestFirst().filter((run) => run.status === 'running');
    }

    public hasRunFor(scheduleKey: string, dueAt: number): boolean {
        return this.runs.some((run) => run.scheduleKey === scheduleKey && run.dueAt === dueAt);
    }

    public markAllSeen(): number {
        let count = 0;
        this.runs = this.runs.map((run) => {
            if (run.seen || run.status === 'running') return run;
            count++;
            return {...run, seen: true};
        });
        return count;
    }

    public lastStatuses(scheduleKey: string, limit: number): RunStatus[] {
        return this.runsOf(scheduleKey, limit)
            .map((run) => run.status)
            .reverse();
    }

    public versionsOf(scheduleKey: string): PromptVersion[] {
        return [...(this.versions.get(scheduleKey) ?? [])].reverse();
    }

    public versionFor(scheduleKey: string, text: string, savedAt: number, note: string | null): number {
        const list = this.versions.get(scheduleKey) ?? [];
        const current = list[list.length - 1];
        if (current && current.text === text) return current.version;
        const version = (current?.version ?? 0) + 1;
        this.versions.set(scheduleKey, [...list, {version, text, savedAt, note}]);
        return version;
    }

    public rekey(from: string, to: string): void {
        if (from === to) return;
        this.runs = this.runs.map((run) => (run.scheduleKey === from ? {...run, scheduleKey: to} : run));
        const moved = this.versions.get(from);
        if (moved) {
            this.versions.set(to, moved);
            this.versions.delete(from);
        }
    }

    private newestFirst(): ScheduleRun[] {
        return this.runs
            .map((run, index) => ({run, index}))
            .sort((a, b) => placeOf(b.run) - placeOf(a.run) || b.index - a.index)
            .map(({run}) => run);
    }
}
