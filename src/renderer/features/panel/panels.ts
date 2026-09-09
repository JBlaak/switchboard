/**
 * The two long-lived CodeMirror panels: plans and agent files.
 *
 * Separate from dom.ts because constructing them pulls in the whole editor
 * stack, and separate from app.ts because plans-memory-view needs them without
 * needing anything else app.ts owns.
 */
import { memoryViewer, planViewer } from '../../lib/dom';
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
