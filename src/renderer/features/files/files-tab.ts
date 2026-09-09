/**
 * The Files tab: wiring, and the one decision neither half makes.
 *
 * Small on purpose. The tab holds two independent surfaces — the Changes list
 * above (`changes-list.ts`, rules in `changes-list-model.ts`) and the project
 * tree below (`file-tree.ts`, rules in `file-tree-model.ts`) — and what is left
 * here is who tells them the scope moved, and where a file either of them
 * opened goes.
 *
 * That last one is here rather than in the two because it is the only part that
 * reaches the main area. `openFileInCodeArea` pulls in the code area, which
 * imports the tab router, which imports the search — and the search drives the
 * tree's filter. Keeping the call in this module, which nothing else imports,
 * is what stops that from being a cycle.
 */
import { installChangesList, resetChangesList } from './changes-list';
import { installFileTree, resetFileTree } from './file-tree';
import { onScopeChange } from '../../state/scope-store';
import { openDiffInCodeArea, openFileInCodeArea } from '../code/code-area';
import type { OpenedFile } from './file-tree';

/**
 * Wire the tab up. Does not draw: the first paint belongs to the tab router,
 * which knows when the tab is actually on screen — and drawing the tree means
 * reading a directory, which is not worth doing until someone is looking.
 */
export function installFilesTab(): void {
  installChangesList(showInCodeArea, showDiffInCodeArea);
  installFileTree(showInCodeArea);

  // A different project (or a different checkout of the same one) means every
  // path in either half is relative to a root that is no longer in effect.
  onScopeChange(() => {
    resetChangesList();
    resetFileTree();
  });
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

/**
 * Show the whole worktree's diff, optionally at one file.
 *
 * Here for the same reason `showInCodeArea` is: this is the other thing in the
 * sidebar that reaches the main area, and both go through the module nothing
 * else imports so that neither becomes a cycle.
 */
function showDiffInCodeArea(focusPath?: string): void {
  openDiffInCodeArea(focusPath);
}
