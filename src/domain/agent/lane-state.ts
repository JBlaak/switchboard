/**
 * The lane state a VM keeps while it is the Merging host (#438, #442, epic
 * #432): what the Mac keeps in SQLite, in one file the agent can read with
 * plain Node.
 *
 * - **Landed PRs**, as the Merge manager keeps them (`LandedPullRequest`):
 *   land order, set-asides and errand links. A hand-off carries the Mac's in
 *   whole, and a bring-back carries the VM's back.
 * - **Fix errands** (`FixErrand`): which session works on which PR, and what
 *   earlier errands said, for the next one's prompt.
 * - **Savings**: what the lane runner did not spend CI on, for the page.
 * - Whether the VM's `gh` login lacks the `workflow` scope, as the hand-off
 *   found, which errands' prompts mention.
 *
 * It lives at LANE_STATE_FILE on the VM, written whole and atomically, so it
 * outlives an agent restart, a crash or an upgrade. The agent's sessions die
 * with it, so after a restart every running errand names a session that is
 * gone: `deadErrands` names them, the Merge host forgets them, and the next
 * lane read starts a fresh errand for each PR still at Fixing. Everything
 * else is GitHub's, read again on every pass.
 *
 * Read defensively: a malformed entry is skipped, a malformed file is empty.
 */
import type {FixErrand} from '../merge-manager/errands';
import type {LandedPullRequest, LaneSaving} from '../merge-manager/model';
import {LANE_SAVINGS} from '../merge-manager/model';

/** One count of savings, as the Mac's `lane_savings` table keeps it. */
export interface LaneSavingEntry {
    repository: string;
    kind: LaneSaving;
    count: number;
    at: number;
}

export interface LaneState {
    landed: LandedPullRequest[];
    errands: FixErrand[];
    savings: LaneSavingEntry[];
    /** The hand-off found the VM's GitHub login without the `workflow` scope. */
    noWorkflowScope: boolean;
}

export const EMPTY_LANE_STATE: LaneState = {landed: [], errands: [], savings: [], noWorkflowScope: false};

/** How long savings are kept: the page counts this week's, so two weeks is plenty. */
export const SAVINGS_KEPT_MS = 14 * 24 * 60 * 60_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function landedOf(value: unknown): LandedPullRequest | null {
    if (!isObject(value)) return null;
    const {key, repository, number, lane, landedAt, stage} = value;
    if (!isText(key) || !isText(repository) || !Number.isInteger(number)) return null;
    if ((lane !== 'queue' && lane !== 'switchboard') || !isNumber(landedAt)) return null;
    if (!isObject(stage) || !isText(stage.kind)) return null;
    return value as unknown as LandedPullRequest;
}

function errandOf(value: unknown): FixErrand | null {
    if (!isObject(value)) return null;
    const {id, key, repository, number, sessionId, currentId, startedAt} = value;
    if (!isText(id) || !isText(key) || !isText(repository) || !Number.isInteger(number)) return null;
    if (!isText(sessionId) || !isText(currentId) || !isNumber(startedAt)) return null;
    return value as unknown as FixErrand;
}

function savingOf(value: unknown): LaneSavingEntry | null {
    if (!isObject(value)) return null;
    const {repository, kind, count, at} = value;
    if (!isText(repository) || !LANE_SAVINGS.includes(kind as LaneSaving) || !isNumber(count) || !isNumber(at)) {
        return null;
    }
    return {repository, kind: kind as LaneSaving, count, at};
}

function each<T>(value: unknown, read: (entry: unknown) => T | null): T[] {
    if (!Array.isArray(value)) return [];
    return value.map(read).filter((entry): entry is T => entry !== null);
}

/** The file's text as lane state; missing, malformed or an older shape reads as empty. */
export function parseLaneState(text: string | null): LaneState {
    if (!text) return EMPTY_LANE_STATE;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return EMPTY_LANE_STATE;
    }
    if (!isObject(parsed) || parsed.version !== 2) return EMPTY_LANE_STATE;
    return {
        landed: each(parsed.landed, landedOf),
        errands: each(parsed.errands, errandOf),
        savings: each(parsed.savings, savingOf),
        noWorkflowScope: parsed.noWorkflowScope === true,
    };
}

export function serializeLaneState(state: LaneState): string {
    return JSON.stringify({version: 2, ...state}, null, 2) + '\n';
}

/** Savings counted at `now`, the ones older than SAVINGS_KEPT_MS let go. */
export function withSaving(state: LaneState, entry: LaneSavingEntry, now: number): LaneState {
    return {...state, savings: [...state.savings.filter((s) => now - s.at < SAVINGS_KEPT_MS), entry]};
}

/** Every saving of each kind since `at`, by lower-case repository. */
export function savingsByRepository(state: LaneState, at: number): Record<string, Record<LaneSaving, number>> {
    const by: Record<string, Record<LaneSaving, number>> = {};
    for (const entry of state.savings) {
        if (entry.at < at) continue;
        const id = entry.repository.toLowerCase();
        by[id] ??= {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0};
        by[id][entry.kind] += entry.count;
    }
    return by;
}

/**
 * The errands still marked running whose session is gone: after a restart,
 * all of them. Forgotten, they make way for a fresh errand on the next lane
 * read of a PR still at Fixing.
 */
export function deadErrands(state: LaneState, isAlive: (sessionId: string) => boolean): FixErrand[] {
    return state.errands.filter(
        (errand) => !errand.finished && errand.stoppedAt === null && !isAlive(errand.currentId),
    );
}
