/**
 * The long-lived CodeMirror panels: plans, agent files and the code area.
 *
 * Separate from dom.ts because constructing them pulls in the whole editor
 * stack, and separate from app.ts because plans-memory-view needs them without
 * needing anything else app.ts owns.
 */
import { codeArea, memoryViewer, planViewer } from '../../lib/dom';
import { ViewerPanel } from '../panel/viewer-panel';

export const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath: string, content: string) => window.api.savePlan(filePath, content),
});

export const memoryPanel = new ViewerPanel(memoryViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath: string, content: string) => window.api.saveMemory(filePath, content),
});

/**
 * The code area's editor: any file in the scoped project, whatever its language.
 *
 * `language: 'auto'` because this one is not a markdown panel — the file comes
 * from a tree, so the mode has to follow the extension.
 *
 * No `onSave`, deliberately: the code area is read-only until a milestone gives
 * it an edit path, and a save button that half-works is worse than none. The
 * copy buttons are the way content leaves the panel for now.
 */
export const codePanel = new ViewerPanel(codeArea, {
  language: 'auto', copyPath: true, copyContent: true,
});
