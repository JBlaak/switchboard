/**
 * The Merging host (#442, decisions #429, epic #432): the one machine that
 * runs the Merge manager, the Mac or one VM, never both.
 *
 * - **Hand off.** "Hand off merging to <VM>" moves the whole Merge manager:
 *   every Switchboard lane and fix-errand duty for queue-lane PRs. The VM's
 *   `gh` login is checked first (`ghAuthCheck`): no login refuses the
 *   hand-off with the fix; a missing `workflow` scope hands off with a
 *   warning. With several VMs the last choice is offered first (`pickVm`).
 * - **On quit** with landed PRs in a Switchboard lane the Mac asks "Hand off
 *   merging to <VM>?" (`quitPrompt`); with no VM registered it asks nothing.
 * - **While on the VM** Land it, Unland and Try again go to the VM
 *   (`actionRoute`); the Mac shows the VM's lanes with a "Merging on <VM>"
 *   badge, and a "While merging was on <VM>" summary (`awaySummary`, its
 *   bubble `awayBubble`) until it is dismissed or merging comes back.
 * - **Bring merging back** is explicit (`broughtBack`). **Take back anyway**
 *   (`tookBackAnyway`) makes the Mac the host while the VM is unreachable,
 *   and remembers to tell that VM to stand down when it reconnects
 *   (`onVmConnected`). A brief overlap is safe: every update and merge is
 *   pinned to an expected head commit.
 *
 * Pure, so the tests hold it still. Times are epoch ms.
 */
import type {LaneStage, MergeManagerState} from './model';

/** A registered VM, by its key (`user@host:port`) and the name it shows. */
export interface VmChoice {
    readonly key: string;
    readonly name: string;
}

/** Where merging is, as the Mac keeps it across restarts. */
export type MergingHostRecord =
    | {
          readonly kind: 'mac';
          /** The VM last handed off to, offered first next time. */
          readonly lastVm: string | null;
          /** A VM merging was taken back from while it was unreachable: told to stand down when it reconnects. */
          readonly standDown: VmChoice | null;
      }
    | {
          readonly kind: 'vm';
          readonly vm: VmChoice;
          /** When merging was handed off. */
          readonly since: number;
          /** What the hand-off warned of (a `gh` login without the `workflow` scope); null when nothing. */
          readonly warning: string | null;
          /** The "While merging was on <VM>" summary was dismissed. */
          readonly summaryDismissed: boolean;
          readonly lastVm: string | null;
      };

export const MAC_HOST: MergingHostRecord = {kind: 'mac', lastVm: null, standDown: null};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function vmOf(value: unknown): VmChoice | null {
    if (!isObject(value)) return null;
    const key = textOrNull(value.key);
    if (!key) return null;
    return {key, name: textOrNull(value.name) ?? key};
}

/** A stored record, read defensively: anything malformed is the Mac. */
export function parseMergingHostRecord(value: unknown): MergingHostRecord {
    if (!isObject(value)) return MAC_HOST;
    const lastVm = textOrNull(value.lastVm);
    if (value.kind === 'vm') {
        const vm = vmOf(value.vm);
        const since = value.since;
        if (vm && typeof since === 'number' && Number.isFinite(since)) {
            return {
                kind: 'vm',
                vm,
                since,
                warning: textOrNull(value.warning),
                summaryDismissed: value.summaryDismissed === true,
                lastVm: lastVm ?? vm.key,
            };
        }
    }
    return {kind: 'mac', lastVm, standDown: vmOf(value.standDown)};
}

// ── The GitHub check ──

/** What `gh auth status` on the VM says about handing off. */
export type GhCheck =
    | {readonly ok: false; readonly reason: string; readonly fix: string}
    | {readonly ok: true; readonly warning: string | null};

/**
 * Read `gh auth status` as run on the VM (its exit code, stdout and stderr
 * together). Not signed in refuses the hand-off, with the command that fixes
 * it; signed in without the `workflow` scope hands off with a warning, since
 * only an errand that must push workflow files is stopped by it. A token
 * whose scopes `gh` does not list (a fine-grained one) is taken as it is.
 */
export function ghAuthCheck(run: {readonly code: number; readonly output: string}, vm: string): GhCheck {
    const loggedIn = run.code === 0 && /logged in to/i.test(run.output) && !/not logged in/i.test(run.output);
    if (!loggedIn) {
        return {
            ok: false,
            reason: `${vm} is not signed in to GitHub, so it could not update or merge anything.`,
            fix: `On ${vm}, run: gh auth login`,
        };
    }
    const scopes = /token scopes:\s*(.*)/i.exec(run.output);
    if (scopes && !/(^|[^a-z_])workflow([^a-z_]|$)/i.test(scopes[1])) {
        return {
            ok: true,
            warning:
                `${vm}'s GitHub login has no workflow scope: an errand that must change workflow files ` +
                `goes to Needs you. To add it, run on ${vm}: gh auth refresh -s workflow`,
        };
    }
    return {ok: true, warning: null};
}

// ── Moving ──

/** Merging is on `vm` from `now`. */
export function handedOff(vm: VmChoice, warning: string | null, now: number): MergingHostRecord {
    return {kind: 'vm', vm, since: now, warning, summaryDismissed: false, lastVm: vm.key};
}

/** Merging came back: the VM finished its step and stopped its errands. */
export function broughtBack(record: MergingHostRecord): MergingHostRecord {
    return {kind: 'mac', lastVm: record.lastVm, standDown: record.kind === 'mac' ? record.standDown : null};
}

/** Taken back while the VM could not be reached: it stands down when it reconnects. */
export function tookBackAnyway(record: MergingHostRecord): MergingHostRecord {
    if (record.kind === 'mac') return record;
    return {kind: 'mac', lastVm: record.lastVm, standDown: record.vm};
}

/** A VM connected: tell it to stand down when merging was taken back from it. */
export function onVmConnected(record: MergingHostRecord, key: string): 'stand-down' | null {
    return record.kind === 'mac' && record.standDown?.key === key ? 'stand-down' : null;
}

/** The VM heard it and stood down. */
export function stoodDown(record: MergingHostRecord): MergingHostRecord {
    return record.kind === 'mac' ? {...record, standDown: null} : record;
}

export function dismissedSummary(record: MergingHostRecord): MergingHostRecord {
    return record.kind === 'vm' ? {...record, summaryDismissed: true} : record;
}

/** Where Land it, Unland and Try again go: here, or forwarded to the VM that merges. */
export function actionRoute(
    record: MergingHostRecord,
): {readonly to: 'mac'} | {readonly to: 'vm'; readonly vm: VmChoice} {
    return record.kind === 'vm' ? {to: 'vm', vm: record.vm} : {to: 'mac'};
}

/** The VM to offer: the last one handed off to while it is still registered, else the first. */
export function pickVm(vms: readonly VmChoice[], last: string | null): VmChoice | null {
    return vms.find((vm) => vm.key === last) ?? vms[0] ?? null;
}

// ── On quit ──

/**
 * Whether quitting asks "Hand off merging to <VM>?": only while the Mac
 * merges, a VM is registered, and a Switchboard lane holds a landed PR that
 * has not merged (queue lanes go on without the Mac: the Action merges).
 */
export function quitPrompt(
    record: MergingHostRecord,
    state: MergeManagerState,
    vms: readonly VmChoice[],
): {readonly vm: VmChoice; readonly vms: readonly VmChoice[]} | null {
    if (record.kind !== 'mac') return null;
    const vm = pickVm(vms, record.lastVm);
    if (!vm) return null;
    const waiting = state.lanes.some(
        (lane) => lane.kind === 'switchboard' && lane.pullRequests.some((pr) => pr.stage.kind !== 'merged'),
    );
    return waiting ? {vm, vms} : null;
}

// ── While merging was on the VM ──

/** A PR the away summary names. */
export interface AwayPr {
    readonly key: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
}

export interface AwaySummary {
    /** The VM's name. */
    readonly vm: string;
    /** Merged since the hand-off, latest first. */
    readonly merged: readonly AwayPr[];
    /** Needs you now, with the question an errand stopped on. */
    readonly needsYou: readonly (AwayPr & {readonly question: string | null})[];
    /** A fix errand is still on it. */
    readonly running: readonly AwayPr[];
}

/**
 * "While merging was on <VM>": what merged since the hand-off, what needs
 * the user (with the question an errand stopped on) and which errands still
 * run, read from the VM's lanes. Null while the Mac merges or once dismissed.
 */
export function awaySummary(record: MergingHostRecord, state: MergeManagerState): AwaySummary | null {
    if (record.kind !== 'vm' || record.summaryDismissed) return null;
    const prs = state.lanes.flatMap((lane) => lane.pullRequests);
    const pr = (p: (typeof prs)[number]): AwayPr => ({
        key: p.key,
        repository: p.repository,
        number: p.number,
        title: p.title,
        url: p.url,
    });
    const mergedAt = (stage: LaneStage): number => (stage.kind === 'merged' ? stage.at : -1);
    return {
        vm: record.vm.name,
        merged: prs
            .filter((p) => p.stage.kind === 'merged' && p.stage.at >= record.since)
            .sort((a, b) => mergedAt(b.stage) - mergedAt(a.stage))
            .map(pr),
        needsYou: prs
            .filter((p) => p.stage.kind === 'needsYou')
            .map((p) => ({
                ...pr(p),
                question:
                    p.stage.kind === 'needsYou' && p.stage.reason.kind === 'errand-stopped'
                        ? (p.stage.reason.question ?? null)
                        : null,
            })),
        running: prs.filter((p) => p.stage.kind === 'fixing').map(pr),
    };
}

/** The bubble's short form: "3 merged · 1 needs you"; null when neither happened. */
export function awayBubble(summary: AwaySummary | null): string | null {
    if (!summary) return null;
    const parts = [
        ...(summary.merged.length ? [`${summary.merged.length} merged`] : []),
        ...(summary.needsYou.length ? [`${summary.needsYou.length} needs you`] : []),
    ];
    return parts.length ? parts.join(' · ') : null;
}

// ── What the renderer is shown ──

/** Where merging is, as the page header, the figure and the project page show it. */
export type MergingHostView =
    | {
          readonly kind: 'mac';
          /** The registered VMs merging can be handed off to. */
          readonly vms: readonly VmChoice[];
          /** The one offered first (the last choice), or null with none registered. */
          readonly offered: VmChoice | null;
      }
    | {
          readonly kind: 'vm';
          readonly vm: VmChoice;
          readonly since: number;
          readonly warning: string | null;
          /** Whether its agent answered lately; when not, Take back anyway is offered. */
          readonly reachable: boolean;
          readonly summary: AwaySummary | null;
          readonly vms: readonly VmChoice[];
      };

export function mergingHostView(
    record: MergingHostRecord,
    state: MergeManagerState,
    vms: readonly VmChoice[],
    reachable: boolean,
): MergingHostView {
    if (record.kind === 'mac') return {kind: 'mac', vms, offered: pickVm(vms, record.lastVm)};
    return {
        kind: 'vm',
        vm: record.vm,
        since: record.since,
        warning: record.warning,
        reachable,
        summary: awaySummary(record, state),
        vms,
    };
}
