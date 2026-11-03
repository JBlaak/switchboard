/**
 * Where a project's schedules run, as the project pages and the hand-off
 * dialog say it (#276 stage 5, Q18).
 *
 * - A local project's page, once it has copies and schedules: a Schedules
 *   line with "Run on this Mac" or "Run on <host> (copy)", picked to move them.
 * - A copy's page: "Run here" or "Run on the Mac".
 * - The hand-off dialog: "Run this project’s schedules on the VM", on by
 *   default, saying so when a copy already runs them.
 *
 * No schedules (a count of 0) shows none of it. Pure, so it is tested in node.
 */
import {isRemoteProjectPath, parseRemoteProjectPath} from '../../../domain/project/remote-target';
import type {HandoffHost, HandoffPreview, ProjectCopy} from '../../../application/services/project-handoff';
import type {ScheduleLocation} from '../../../application/services/vm-schedules';

/** The picker's value for the Mac; any other value is a copy's path. */
export const ON_MAC = 'mac';

export interface ScheduleOption {
    readonly value: string;
    readonly label: string;
}

/** The Schedules line on a project page. */
export interface SchedulesSwitch {
    /** The local project the schedules belong to, which `runOn` is told about. */
    readonly localPath: string;
    /** "3 schedules". */
    readonly count: string;
    readonly options: readonly ScheduleOption[];
    /** The option they run on now. */
    readonly selected: string;
}

/**
 * The Schedules line for the page of `projectPath`, a local project or a
 * copy; null when there is nothing to switch: no schedules, or a local
 * project with no copy to move them to.
 */
export function schedulesSwitch(
    projectPath: string,
    location: ScheduleLocation | null,
    copies: readonly ProjectCopy[],
): SchedulesSwitch | null {
    if (!location || location.count <= 0) return null;
    const runsOn = location.runsOn.kind === 'vm' ? location.runsOn.copyPath : null;
    const selected = runsOn ?? ON_MAC;
    const options: ScheduleOption[] = [];

    if (isRemoteProjectPath(projectPath)) {
        options.push({value: projectPath, label: 'Run here'}, {value: ON_MAC, label: 'Run on the Mac'});
    } else {
        if (copies.length === 0 && !runsOn) return null;
        options.push({value: ON_MAC, label: 'Run on this Mac'});
        for (const copy of copies) options.push({value: copy.copyPath, label: runOnCopy(copy.hostLabel)});
    }
    // Another copy runs them (or one the page hasn't listed): it is offered as it is.
    if (runsOn && !options.some((option) => option.value === runsOn)) {
        options.push({value: runsOn, label: runOnCopy(hostOf(runsOn, copies))});
    }
    return {localPath: location.localPath, count: count(location.count, 'schedule'), options, selected};
}

/** What a picked option tells `runOn`: a copy's path, or null for the Mac. */
export function runOnTarget(value: string): string | null {
    return value === ON_MAC ? null : value;
}

/** The hand-off dialog's checkbox. */
export interface SchedulesChoice {
    readonly label: string;
    /** What it does, or that a copy runs them already. */
    readonly note: string;
}

export const SCHEDULES_CHOICE = 'Run this project’s schedules on the VM';

/**
 * The checkbox, once main has said the project has schedules; null with none
 * (or before it has said), and then nothing about schedules goes with the
 * hand-off.
 */
export function schedulesChoice(
    location: ScheduleLocation | null,
    host: HandoffHost,
    preview: Pick<HandoffPreview, 'existing'> | null,
    copies: readonly ProjectCopy[],
): SchedulesChoice | null {
    if (!location || location.count <= 0) return null;
    const n = count(location.count, 'schedule');
    if (location.runsOn.kind === 'mac') {
        return {label: SCHEDULES_CHOICE, note: `${n}. Ticked, they stop running on this Mac.`};
    }
    const copyPath = location.runsOn.copyPath;
    if (preview?.existing[host.key] === copyPath) {
        return {label: SCHEDULES_CHOICE, note: `${n}. They already run in the copy on ${host.label}.`};
    }
    return {
        label: SCHEDULES_CHOICE,
        note: `${n}. They run in the copy on ${hostOf(copyPath, copies)} now; ticked, they move to this one.`,
    };
}

/** What a project hand-off carries beyond the files: the schedules' choice, when the checkbox shows. */
export function handoffChoices(choice: SchedulesChoice | null, schedulesOnVm: boolean): {schedulesOnVm?: boolean} {
    return choice ? {schedulesOnVm} : {};
}

function runOnCopy(host: string): string {
    return `Run on ${host} (copy)`;
}

/** A copy's host, as the copies list names it, or `user@host` from its path. */
function hostOf(copyPath: string, copies: readonly ProjectCopy[]): string {
    const listed = copies.find((copy) => copy.copyPath === copyPath);
    if (listed) return listed.hostLabel;
    const remote = parseRemoteProjectPath(copyPath);
    return remote ? `${remote.user}@${remote.host}` : copyPath;
}

function count(n: number, noun: string): string {
    return n + ' ' + noun + (n === 1 ? '' : 's');
}
