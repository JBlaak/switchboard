/**
 * What a key does on the Merge manager's page (#439): J/K (or ↓/↑) move to
 * the next or previous row, and on the selected one ⏎ opens its session or
 * its fix errand, T tries again, N nudges the reviewer it waits on, U unlands
 * it and O opens it on GitHub. A key the row does not offer does nothing.
 *
 * Only keys without ⌘, ⌃ or ⌥ reach this, never one typed into a field.
 * Pure, so it is tested in node; the page carries the answer out.
 */
import {rowActions, type PageRow} from '../../../domain/merge-manager/page';

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
