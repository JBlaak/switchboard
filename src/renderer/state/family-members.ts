/**
 * Who is out with the Patch family on the empty screen: one member per
 * session with a live terminal that is not snoozed, posed for what it is
 * doing. A snoozed session would only add a sleeping Patch, so it stays home.
 *
 * Pure, so the rule is written once and tested in node; the scene itself is
 * drawn by `ui/patch/EmptyScreenFamily`. The order matters: the first members
 * stand in front, so a session waiting on the user comes first, then the busy
 * ones (most helpers first), then the finished and the resting.
 */
import {isSnoozed} from '../../domain/session/snooze';
import {rowActivity} from './row-activity';
import {sessionDisplayName} from './session-list-layout';
import type {RendererState} from './root';
import type {SessionRow} from '../../domain/session/session';

/** Matches `FamilyStatus` in @jblaak/patch. */
export type FamilyStatus = 'working' | 'blocked' | 'ready' | 'idle';

/** Matches `FamilyMember` in @jblaak/patch, which the renderer passes it to unchanged. */
export interface FamilyMemberView {
    id: string;
    name: string;
    status: FamilyStatus;
    helpers: number;
    detail: string;
}

/** The scene draws at most this many; the rest stay home. */
export const FAMILY_SIZE = 9;

/** Long session titles are cut down for the hover tag. */
const NAME_LENGTH = 28;

const ORDER: Record<FamilyStatus, number> = {blocked: 0, working: 1, ready: 2, idle: 3};
const WORDS: Record<FamilyStatus, string> = {blocked: 'Needs you', working: 'Working', ready: 'Ready', idle: 'Idle'};

function shorten(text: string): string {
    return text.length > NAME_LENGTH ? text.slice(0, NAME_LENGTH - 1).trimEnd() + '…' : text;
}

function folderOf(projectPath: string): string {
    const parts = projectPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? projectPath;
}

/** What a session is up to, as the family shows it. */
export function familyStatusOf(state: RendererState, sessionId: string): {status: FamilyStatus; helpers: number} {
    const activity = rowActivity(state, sessionId);
    const helpers = activity.agents.length;
    if (activity.needsAttention) return {status: 'blocked', helpers};
    if (activity.busy) return {status: 'working', helpers};
    if (activity.responseReady) return {status: 'ready', helpers};
    return {status: 'idle', helpers};
}

/**
 * The members for the sessions in `rows` that have a live terminal and are
 * not snoozed at `now`, front first, at most `FAMILY_SIZE` of them.
 */
export function familyMembersIn(
    state: RendererState,
    rows: Iterable<SessionRow>,
    now: number = Date.now(),
): FamilyMemberView[] {
    const live = state.view.activePtyIds;
    const members: FamilyMemberView[] = [];
    for (const row of rows) {
        if (!live.has(row.sessionId) || isSnoozed(row.snoozedUntil, now)) continue;
        const {status, helpers} = familyStatusOf(state, row.sessionId);
        const title = sessionDisplayName(row) || folderOf(row.projectPath);
        const helping = helpers ? ` · ${helpers} agent${helpers === 1 ? '' : 's'}` : '';
        members.push({
            id: row.sessionId,
            name: shorten(title),
            status,
            helpers,
            detail: `${folderOf(row.projectPath)} · ${WORDS[status]}${helping}`,
        });
    }
    members.sort(
        (a, b) =>
            ORDER[a.status] - ORDER[b.status] || b.helpers - a.helpers || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return members.slice(0, FAMILY_SIZE);
}
