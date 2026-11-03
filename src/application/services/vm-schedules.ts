/**
 * Where a project's schedules run (#276 stage 5, Q18).
 *
 * A project's `schedule-*.md` files go along with every copy of it, so without
 * a rule each schedule would run twice: on the Mac and on the VM. One place
 * runs them. A hand-off asks (default: the VM); both project pages show where
 * they run now and can switch it. Running on the VM pauses them on the Mac;
 * the VM keeps them in its host settings (`scheduleDirs`), so they run while
 * the Mac is away.
 *
 * The IPC handlers call this; the composition root builds it.
 */

export interface ScheduleLocation {
    /** The local project the schedules belong to. */
    localPath: string;
    /** Where they run: on this Mac, or in that copy on its VM. */
    runsOn: {kind: 'mac'} | {kind: 'vm'; copyPath: string};
    /** How many `schedule-*.md` the local project has; 0 hides the switch. */
    count: number;
}

export interface VmSchedules {
    /** For a local project or one of its copies; null for a project with neither schedules nor copies. */
    where(projectPath: string): Promise<ScheduleLocation | null>;
    /**
     * Run the local project's schedules in `copyPath` on its VM, or (null)
     * back on the Mac. Answers the new location, or an error when the VM
     * could not be told.
     */
    runOn(localPath: string, copyPath: string | null): Promise<ScheduleLocation | {error: string}>;
}
