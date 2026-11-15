/**
 * What a key does on the Merge manager's page (#439): J/K (or ↓/↑) move to
 * the next or previous row, and on the selected one ⏎ opens its session or
 * its fix errand, T tries again, N nudges the reviewer it waits on, U unlands
 * it and O opens it on GitHub. A key the row does not offer does nothing.
 *
 * On a Not landed row (`notLandedKeyAction`) L lands it, ⏎ opens the session
 * that opened it when there is one, and O opens it on GitHub; T, N and U do
 * nothing there.
 *
 * Only keys without ⌘, ⌃ or ⌥ reach this, never one typed into a field.
 * Pure, so it is tested in node; the page carries the answer out.
 */
import {rowActions, type PageRow} from '../../../domain/merge-manager/page';
import {canLand, type OpenPullRequest} from '../../../domain/merge-manager/not-landed';

export type MergeKeyAction =
    | {readonly kind: 'step'; readonly step: 1 | -1}
    | {readonly kind: 'open' | 'tryAgain' | 'nudge' | 'unland' | 'github'; readonly row: PageRow};

export function mergeKeyAction(key: string, selected: PageRow | null): MergeKeyAction | null {
    if (key === 'j' || key === 'ArrowDown') return {kind: 'step', step: 1};
    if (key === 'k' || key === 'ArrowUp') return {kind: 'step', step: -1};
    if (!selected) return null;
    const offers = rowActions(selected);
    switch (key) {
        case 'Enter':
            return offers.open ? {kind: 'open', row: selected} : null;
        case 't':
            return offers.tryAgain ? {kind: 'tryAgain', row: selected} : null;
        case 'n':
            return offers.nudge ? {kind: 'nudge', row: selected} : null;
        case 'u':
            return offers.unland ? {kind: 'unland', row: selected} : null;
        case 'o':
            return {kind: 'github', row: selected};
        default:
            return null;
    }
}

export type NotLandedKeyAction =
    | {readonly kind: 'step'; readonly step: 1 | -1}
    | {readonly kind: 'land' | 'open' | 'github'; readonly pr: OpenPullRequest};

/** A key on a Not landed row; `hasSession` says whether a session in the list opened it. */
export function notLandedKeyAction(key: string, pr: OpenPullRequest, hasSession: boolean): NotLandedKeyAction | null {
    if (key === 'j' || key === 'ArrowDown') return {kind: 'step', step: 1};
    if (key === 'k' || key === 'ArrowUp') return {kind: 'step', step: -1};
    switch (key) {
        case 'l':
            return canLand(pr) ? {kind: 'land', pr} : null;
        case 'Enter':
            return hasSession ? {kind: 'open', pr} : null;
        case 'o':
            return {kind: 'github', pr};
        default:
            return null;
    }
}
