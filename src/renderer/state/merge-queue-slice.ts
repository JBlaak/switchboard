/**
 * The merge queue outside the project page (#315): the latest queue and
 * errands of each repository a running session is in, as main pushed them
 * (`mergeQueueChanged`), for the sidebar's pills and the session header's
 * panel; and where the panel's buttons stand.
 *
 * Main pushes a repository only when its queue or errands changed, and
 * `queue: null` once nothing runs in it or it no longer uses the queue, which
 * drops it. The project page reads its own queue off its overview; this is
 * the one for everywhere else.
 */
import {withEntry, withoutEntry, type IdRecord} from './records';
import type {RendererEvent} from './events';
import type {MergeQueue} from '../../domain/project/merge-queue';
import type {QueueErrandView} from '../../domain/project/queue-errands';

/** What one of the header panel's buttons came to. */
export type QueuePanelAction =
    | {readonly phase: 'busy'; readonly action: 'fix' | 'retry'}
    | {readonly phase: 'done' | 'failed'; readonly action: 'fix' | 'retry'; readonly text: string};

export interface MergeQueueState {
    /** `owner/repo` → its queue. */
    readonly queues: IdRecord<MergeQueue>;
    /** `owner/repo` → its errands, oldest first. */
    readonly errands: IdRecord<readonly QueueErrandView[]>;
    /** `owner/repo#n` → the panel's last action on that PR. */
    readonly actions: IdRecord<QueuePanelAction>;
}

export type MergeQueueEvent =
    /** Fix in session or Retry on a session header's queue panel was clicked. */
    | {type: 'queuePanelActionStarted'; repository: string; number: number; action: 'fix' | 'retry'}
    /** What main answered it. */
    | {
          type: 'queuePanelActionFinished';
          repository: string;
          number: number;
          action: 'fix' | 'retry';
          ok: boolean;
          text: string;
      };

export const initialMergeQueueState: MergeQueueState = {queues: {}, errands: {}, actions: {}};

/** The key a PR's panel action is kept under. */
export function queueActionKey(repository: string, number: number): string {
    return `${repository}#${number}`;
}

export function mergeQueueReducer(state: MergeQueueState, event: RendererEvent): MergeQueueState {
    switch (event.type) {
        case 'mergeQueueChanged': {
            const {repository, queue, errands} = event.change;
            const queues = queue ? withEntry(state.queues, repository, queue) : withoutEntry(state.queues, repository);
            const errandsBy = queue
                ? withEntry(state.errands, repository, errands)
                : withoutEntry(state.errands, repository);
            const actions = settledActions(state.actions, repository, queue);
            if (queues === state.queues && errandsBy === state.errands && actions === state.actions) return state;
            return {queues, errands: errandsBy, actions};
        }
        case 'queuePanelActionStarted':
            return {
                ...state,
                actions: withEntry(state.actions, queueActionKey(event.repository, event.number), {
                    phase: 'busy',
                    action: event.action,
                }),
            };
        case 'queuePanelActionFinished':
            return {
                ...state,
                actions: withEntry(state.actions, queueActionKey(event.repository, event.number), {
                    phase: event.ok ? 'done' : 'failed',
                    action: event.action,
                    text: event.text,
                }),
            };
        default:
            return state;
    }
}

/**
 * A finished action is forgotten once its PR is no longer out of the queue
 * (it rejoined, or merged): the next time it fails, the buttons are fresh.
 * One still busy stays until main answers.
 */
function settledActions(
    actions: IdRecord<QueuePanelAction>,
    repository: string,
    queue: MergeQueue | null,
): IdRecord<QueuePanelAction> {
    const failed = new Set<number>();
    for (const entry of queue?.failed ?? []) {
        failed.add(entry.number);
        for (const member of entry.members) failed.add(member.number);
    }
    let next = actions;
    for (const [key, action] of Object.entries(actions)) {
        if (action.phase === 'busy' || !key.startsWith(repository + '#')) continue;
        if (!failed.has(Number(key.slice(repository.length + 1)))) next = withoutEntry(next, key);
    }
    return next;
}

/** A re-keyed errand session is still the errand's; see `rekeyState` in `root`. */
export function rekeyMergeQueue(state: MergeQueueState, oldId: string, newId: string): MergeQueueState {
    if (oldId === newId) return state;
    let errands = state.errands;
    for (const [repository, list] of Object.entries(state.errands)) {
        if (!list.some((errand) => errand.sessionId === oldId)) continue;
        errands = withEntry(
            errands,
            repository,
            list.map((errand) => (errand.sessionId === oldId ? {...errand, sessionId: newId} : errand)),
        );
    }
    return errands === state.errands ? state : {...state, errands};
}
