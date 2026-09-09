/**
 * The Files tab: wiring, and the one decision the tree does not make.
 *
 * Small on purpose. The tab's sidebar half is drawn by `file-tree.ts` and its
 * rules live in `file-tree-model.ts`; what is left is who tells the tree the
 * scope moved, and where a file the user clicked goes.
 *
 * That last one is here rather than in the tree because it is the only part
 * that reaches the main area. `openFileInCodeArea` pulls in the code area,
 * which imports the tab router, which imports the search — and the search
 * drives the tree's filter. Keeping the call in this module, which nothing else
 * imports, is what stops that from being a cycle.
 */
import { installFileTree, resetFileTree } from './file-tree';
import { onScopeChange } from '../../state/scope-store';
import { openFileInCodeArea } from '../code/code-area';
import type { OpenedFile } from './file-tree';

/**
 * Wire the tab up. Does not draw: the first paint belongs to the tab router,
 * which knows when the tab is actually on screen — and drawing the tree means
 * reading a directory, which is not worth doing until someone is looking.
 */
export function installFilesTab(): void {
  installFileTree(showInCodeArea);

  // A different project (or a different checkout of the same one) means every
  // path in the tree is relative to a root that is no longer in effect.
  onScopeChange(() => resetFileTree());
}

/**
 * Show a file the tree read in the main area's code panel.
 *
 * `readOnly` is deliberately not passed. The panel has no save path yet, so the
 * flag is only a badge; leaving it out keeps the badge on, which is the truth.
 */
function showInCodeArea(file: OpenedFile): void {
  openFileInCodeArea({
    worktreePath: file.worktreePath,
    relPath: file.relPath,
    content: file.content,
  });
}
