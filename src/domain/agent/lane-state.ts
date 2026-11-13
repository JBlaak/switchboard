/**
 * The lane state a VM keeps while it is the Merging host (#438, epic #432).
 *
 * Almost everything the Merge manager knows is re-read from GitHub on every
 * tick: labels, reviews, checks, the trunk. The file holds only what GitHub
 * does not: which pull requests were landed in a Switchboard lane (and when,
 * which is their place in the lane), and which fix errand session belongs to
 * which pull request. It lives at LANE_STATE_FILE on the VM, written whole and
 * atomically, so it outlives an agent restart, a crash or an upgrade.
 *
 * The agent's sessions are its own children and die with it, so after a
 * restart every errand in the file names a session that is gone. Recovery
 * (`recoveryPlan`) decides what happens to each: an errand whose pull request
 * is still landed gets a fresh session on the same prompt; one whose pull
 * request was unlanded meanwhile is dropped. The lanes themselves need no
 * recovery: their order is the landed times, and the rest is GitHub's.
 */

/** A pull request by its repository (`owner/name`) and number. */
export interface LanePrRef {
    repo: string;
    number: number;
}

/** One pull request landed in a Switchboard lane. */
export interface LandedPr extends LanePrRef {
    /** The head branch, which a fix errand checks out and pushes to. */
    branch: string;
    /** When it was landed, epoch ms: its place in its lane. */
    landedAt: number;
}

/** A fix errand the VM runs for a landed pull request, and the session doing it. */
export interface LaneErrand extends LanePrRef {
    branch: string;
    /** The errand's session on the VM; changes when recovery starts a fresh one. */
    sessionId: string;
    /** The folder the session runs in, absolute on the VM. */
    dir: string;
    /** What the errand's session was started on, so a fresh one can start on it again. */
    prompt: string;
    /** When its current session started, epoch ms. */
    startedAt: number;
}

export interface LaneState {
    landed: LandedPr[];
    errands: LaneErrand[];
}

export const EMPTY_LANE_STATE: LaneState = {landed: [], errands: []};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isRepo = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isPrNumber = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function landedOf(value: unknown): LandedPr | null {
    if (!isObject(value)) return null;
    const {repo, number, branch, landedAt} = value;
    if (!isRepo(repo) || !isPrNumber(number) || !isText(branch) || !isNumber(landedAt)) return null;
    return {repo, number, branch, landedAt};
}

function errandOf(value: unknown): LaneErrand | null {
    if (!isObject(value)) return null;
    const {repo, number, branch, sessionId, dir, prompt, startedAt} = value;
    if (!isRepo(repo) || !isPrNumber(number) || !isText(branch)) return null;
    if (!isText(sessionId) || !isText(dir) || !isText(prompt) || !isNumber(startedAt)) return null;
    return {repo, number, branch, sessionId, dir, prompt, startedAt};
}

/**
 * The state in the file's text. Missing, unreadable or malformed text reads as
 * empty, and malformed entries are skipped, as are repeats of a pull request
 * (the first one wins): the file must never stop the agent from starting.
 */
export function parseLaneState(text: string | null): LaneState {
    if (text === null) return EMPTY_LANE_STATE;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return EMPTY_LANE_STATE;
    }
    if (!isObject(parsed)) return EMPTY_LANE_STATE;
    const landed = Array.isArray(parsed.landed) ? parsed.landed.map(landedOf) : [];
    const errands = Array.isArray(parsed.errands) ? parsed.errands.map(errandOf) : [];
    return {
        landed: firstPerPr(landed.filter((entry): entry is LandedPr => entry !== null)),
        errands: firstPerPr(errands.filter((entry): entry is LaneErrand => entry !== null)),
    };
}

/** The file's text for a state. */
export function serializeLaneState(state: LaneState): string {
    return JSON.stringify({landed: state.landed, errands: state.errands}, null, 2) + '\n';
}

/** Whether two references name the same pull request. */
export function samePr(a: LanePrRef, b: LanePrRef): boolean {
    return a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

function firstPerPr<T extends LanePrRef>(entries: T[]): T[] {
    return entries.filter((entry, index) => entries.findIndex((other) => samePr(other, entry)) === index);
}

/**
 * Land a pull request. Landing one that is already landed keeps its place
 * (its first landed time), so a repeated Land it never sends it to the back.
 */
export function landPr(state: LaneState, pr: LandedPr): LaneState {
    if (state.landed.some((entry) => samePr(entry, pr))) return state;
    return {...state, landed: [...state.landed, pr]};
}

/**
 * Unland a pull request: out of its lane, and its errand no longer owned. The
 * errand's session is left running (Unland leaves errands alone); only the
 * record that the lane runner owns it goes.
 */
export function unlandPr(state: LaneState, pr: LanePrRef): LaneState {
    return {
        landed: state.landed.filter((entry) => !samePr(entry, pr)),
        errands: state.errands.filter((entry) => !samePr(entry, pr)),
    };
}

/** Record a pull request's errand, replacing any earlier one for it. */
export function withErrand(state: LaneState, errand: LaneErrand): LaneState {
    return {...state, errands: [...state.errands.filter((entry) => !samePr(entry, errand)), errand]};
}

/** Forget the errand run by a session; the state as it was when no errand is. */
export function withoutErrandSession(state: LaneState, sessionId: string): LaneState {
    if (!state.errands.some((entry) => entry.sessionId === sessionId)) return state;
    return {...state, errands: state.errands.filter((entry) => entry.sessionId !== sessionId)};
}

/** The errand a session runs, if any. */
export function errandOfSession(state: LaneState, sessionId: string): LaneErrand | undefined {
    return state.errands.find((entry) => entry.sessionId === sessionId);
}

/** The pull requests of a repository's lane in land order: earliest landed first. */
export function laneOrder(state: LaneState, repo: string): LandedPr[] {
    return state.landed
        .filter((entry) => entry.repo.toLowerCase() === repo.toLowerCase())
        .sort((a, b) => a.landedAt - b.landedAt);
}

/** What recovery does with the errands in the file. */
export interface RecoveryPlan {
    /** Their session is still running: nothing to do. */
    running: LaneErrand[];
    /** Their session is gone and their pull request still landed: start a fresh session. */
    restart: LaneErrand[];
    /** Their pull request is no longer landed: forget them. */
    drop: LaneErrand[];
}

/**
 * Sort the errands in the file by what recovery does with each, given the
 * sessions alive on the agent now (none, right after a restart).
 */
export function recoveryPlan(state: LaneState, isAlive: (sessionId: string) => boolean): RecoveryPlan {
    const plan: RecoveryPlan = {running: [], restart: [], drop: []};
    for (const errand of state.errands) {
        if (!state.landed.some((entry) => samePr(entry, errand))) plan.drop.push(errand);
        else if (isAlive(errand.sessionId)) plan.running.push(errand);
        else plan.restart.push(errand);
    }
    return plan;
}
