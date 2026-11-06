/**
 * What a sidebar row shows of its session's activity, derived from state.
 *
 * Pure, so the rule for each class is written once and tested in node; each
 * row of the session list selects its own (`ui/session-list/SessionItem`).
 */
import {hasEntry} from './records';
import {askingCountIn} from './questions-slice';
import {turnHolds} from '../../domain/session/background-tasks';
import {pullRequestsLand} from '../../domain/session/status-tone';
import type {RendererState} from './root';
import type {TurnHolds} from '../../domain/session/background-tasks';
import type {SessionPullRequest} from '../../domain/session/session';
import type {WorkingAgent} from '../../domain/terminal/program-status-children';

export interface RowActivity {
    /** `needs-attention`: blocked on the user, or asking questions. */
    readonly needsAttention: boolean;
    /** `response-ready`: finished a turn the user has not looked at. */
    readonly responseReady: boolean;
    /** `cli-busy`: a turn is in flight. */
    readonly busy: boolean;
    /** The agents badge; empty means no badge. */
    readonly agents: readonly WorkingAgent[];
    /** `background-work`: the turn ended, but background work it started will wake it. */
    readonly backgroundWork: boolean;
    /** `is-merging`: only watches left, and its pull requests land on their own. */
    readonly merging: boolean;
}

const NO_AGENTS: readonly WorkingAgent[] = [];
const NO_PULL_REQUESTS: readonly SessionPullRequest[] = [];

/**
 * What the session's last turn left running, and whether its open pull
 * requests all land on their own: the parts of its status tone that are not
 * plain activity (see `domain/session/status-tone`). Landing is only worked out
 * for a turn that holds only watches, the one case it decides.
 */
export function turnSignalsIn(
    state: RendererState,
    sessionId: string,
    pullRequests: readonly SessionPullRequest[],
): {holds: TurnHolds; landing: boolean} {
    const holds = turnHolds(state.activity.background[sessionId] ?? []);
    const landing =
        holds === 'watches' &&
        pullRequestsLand(pullRequests, state.ciStatus.bySession[sessionId], state.mergeQueue.queues);
    return {holds, landing};
}

export function rowActivity(
    state: RendererState,
    sessionId: string,
    pullRequests: readonly SessionPullRequest[] = NO_PULL_REQUESTS,
): RowActivity {
    const {activity, questions} = state;
    // A session asking questions is waiting on the user just as surely, and
    // stays so while it is on screen: it is cleared by the set settling.
    const needsAttention = hasEntry(activity.attention, sessionId) || askingCountIn(questions, sessionId) > 0;
    const busy = activity.busy[sessionId] === true;
    const live = state.view.activePtyIds.has(sessionId);
    const ended = live && !needsAttention && !busy;
    const {holds, landing} = turnSignalsIn(state, sessionId, pullRequests);
    return {
        needsAttention,
        responseReady: hasEntry(activity.ready, sessionId),
        busy,
        agents: activity.agents[sessionId] ?? NO_AGENTS,
        backgroundWork: ended && holds === 'work',
        merging: ended && holds === 'watches' && landing,
    };
}
