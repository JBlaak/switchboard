/**
 * Schedules on a VM (#276 stage 5, Q18): the Mac's `ScheduleService`, scoped
 * to the copies the host's settings name.
 *
 * A project hand-off asks whether the copy's schedules run on the VM. A yes
 * adds the copy's folder to `HostSettings.scheduleDirs` (and pauses them on
 * the Mac), and from the next minute the agent's own cron loop runs them,
 * with the Mac on or off. The folders are read again on every tick, so a
 * change from either project page takes effect within a minute, with nothing
 * to restart.
 *
 * Two things differ from the Mac's instance:
 * - The agent has no SQLite index, so the folder → project mapping comes from
 *   the transcripts alone (`resolveProjectPath`), through a stand-in with no
 *   folder meta. A VM holds a handful of projects, so that read per minute is
 *   cheap here.
 * - Each schedule folder is also scanned directly, so a copy that has had no
 *   session on the VM yet (no transcript folder) still runs its schedules.
 */
import type {HostSettings} from '../../../domain/agent/protocol';
import {absoluteDir, isUnderAny} from '../../../domain/agent/schedule-dirs';
import type {FolderMeta} from '../../../domain/session/session';
import type {CommandRunner} from '../../ports/claude-cli';
import type {Clock, Timers} from '../../ports/clock';
import type {FileSystem} from '../../ports/file-system';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import type {TranscriptStore} from '../../ports/transcript-store';
import {ScheduleService} from '../schedule-service';

export interface HostSchedulesDeps {
    fs: FileSystem;
    /** The VM's own `~/.claude/projects`. */
    transcripts: TranscriptStore;
    /** Runs headless `claude` on the VM. */
    runner: CommandRunner;
    /** The host's settings now, for its schedule folders. */
    hostSettings: () => HostSettings;
    /** The VM user's home folder, for `~` in the schedule folders. */
    home: string;
    ids: IdGenerator;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** `~/.claude/commands`, absolute; unused unless the creator is installed. */
    commandsDir: string;
}

/** No index on the agent: every folder is resolved from its transcripts. */
const NO_INDEX = {getAllFolderMeta: (): Map<string, FolderMeta> => new Map()};

/** The schedule service an agent runs: only the copies in its host's schedule folders. */
export function hostScheduleService(deps: HostSchedulesDeps): ScheduleService {
    const dirs = (): string[] => deps.hostSettings().scheduleDirs ?? [];
    return new ScheduleService({
        fs: deps.fs,
        transcripts: deps.transcripts,
        repository: NO_INDEX,
        runner: deps.runner,
        ids: deps.ids,
        clock: deps.clock,
        timers: deps.timers,
        log: deps.log,
        commandsDir: deps.commandsDir,
        runsHere: (projectPath) => isUnderAny(projectPath, dirs(), deps.home),
        extraProjects: () => dirs().map((dir) => absoluteDir(dir, deps.home)),
    });
}
