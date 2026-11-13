/**
 * What the managers on the empty screen do (#416): choosing one opens its
 * page, the Bug manager's (⌘B, #414) or the Issue manager's (⌘I, #415),
 * which take `managerPageRequested`.
 */
import {dispatch} from '../../state/app-store';
import type {InboxManager} from '../../../domain/inbox/model';

export function openManagerPage(manager: InboxManager): void {
    dispatch({type: 'managerPageRequested', manager});
}

/**
 * The Merge manager chosen on the empty screen (#440): its page (⌘⇧L, #439),
 * which takes `mergeManagerPageRequested`.
 */
export function openMergeManagerPage(): void {
    dispatch({type: 'mergeManagerPageRequested'});
}
