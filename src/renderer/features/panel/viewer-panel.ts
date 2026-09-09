/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown files
 *   - Wrap: always shown (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * Depends on: viewer-toolbar.ts, codemirror-setup.ts
 */
import { CMEditorView, cmOpenGotoLine, createEditableViewer, createPlanEditor, marked } from '../../lib/codemirror-setup';
import type { WrappableEditorView } from '../../lib/codemirror-setup';
import { createViewerToolbar, toggleMarkdownPreview } from '../panel/viewer-toolbar';

/** How a panel is configured; every field is optional. */
export interface ViewerPanelOptions {
  /** Persist the buffer. Returning `{ error }` leaves the panel dirty. */
  onSave?: (filePath: string, content: string) => Promise<{ error?: string } | void>;
  onClose?: () => void;
  /** Show the copy-path button. */
  copyPath?: boolean;
  /** Show the copy-content button. */
  copyContent?: boolean;
  /** 'markdown' or 'auto' (default 'markdown'). */
  language?: string;
  /** localStorage key for preview-mode persistence. */
  storageKey?: string;
}

type Toolbar = ReturnType<typeof createViewerToolbar>;

/** The editor host also caches CodeMirror's floating search/goto bars. */
interface BarHost extends HTMLElement {
  _cmSearchBar?: unknown;
  _cmGotoLine?: unknown;
}

export class ViewerPanel {
  container: HTMLElement;
  opts: ViewerPanelOptions;
  filePath: string;
  editorView: WrappableEditorView | null;
  previewMode: boolean;
  wrapMode: boolean;
  toolbar: Toolbar;
  editorEl: HTMLElement;
  previewEl: HTMLElement;
  /** The path currently registered with main's file watcher, if any. */
  _watchedPath: string | null;
  /** Set while a save is in flight, so the watcher's echo is ignored. */
  _saving: boolean;
  _onFileChanged?: (changedPath: string) => void;

  constructor(container: HTMLElement, opts: ViewerPanelOptions = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._saving = false;

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      gotoLine: true,
      save: !!opts.onSave,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath && !this._saving) {
        this._reloadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      window.api.onFileChanged(this._onFileChanged);
    }
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && cmOpenGotoLine) {
          cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose?.());
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }
  }

  /**
   * Open a file in the viewer.
   */
  open(title: string, filePath: string, content: string): void {
    this._unwatchFile();

    this.filePath = filePath;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);

    const isMd = this._isMarkdown(filePath);

    // Show/hide preview button based on file type
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = isMd ? '' : 'none';
    }

    // Save preview preference before resetting
    const wantPreview = isMd && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true';

    // Reset to edit mode before updating content (without touching localStorage)
    if (this.previewMode) {
      this.previewEl.style.display = 'none';
      this.editorEl.style.display = '';
      if (this.toolbar.previewBtn) this.toolbar.previewBtn.classList.remove('active');
      this.previewMode = false;
    }

    // Create or update editor
    if (!this.editorView) {
      this._createEditor(content, filePath);
    } else {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
      });
    }

    // Set wrap default based on file type
    this.wrapMode = isMd;
    this.toolbar.setWrapMode(this.wrapMode);
    if (this.editorView && this.editorView._wrapCompartment) {
      this.editorView.dispatch({
        effects: this.editorView._wrapCompartment.reconfigure(
          this.wrapMode ? CMEditorView.lineWrapping : []
        ),
      });
    }

    // Re-apply preview preference
    if (wantPreview) {
      this._setPreview(true);
    }

    // Watch for external changes
    this._watchFile(filePath);
  }

  _createEditor(content: string, filePath: string): void {
    if (this.opts.language === 'auto') {
      this.editorView = createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = createPlanEditor(this.editorEl);
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  _togglePreview() {
    this.previewMode = toggleMarkdownPreview({
      editorEl: this.editorEl,
      previewEl: this.previewEl,
      toggleBtn: this.toolbar.previewBtn as HTMLElement,
      editorView: this.editorView,
      isPreview: this.previewMode,
      storageKey: this.opts.storageKey,
    });
  }

  _setPreview(show: boolean): void {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save() {
    if (!this.opts.onSave || !this.filePath) return;
    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (!result || !result.error) {
        this.toolbar.flashSave();
      }
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._unwatchFile();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    const host = this.editorEl as BarHost;
    delete host._cmSearchBar;
    delete host._cmGotoLine;
    this.editorEl.innerHTML = '';
    this.previewEl.innerHTML = '';
    this.previewEl.style.display = 'none';
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath: string | null): void {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel) return;
    const result = await window.api.readFileForPanel(this.filePath);
    if (!result.ok || result.content === undefined) return;

    const newContent = result.content;
    const currentContent = this.getContent();
    if (newContent === currentContent) return;

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: newContent },
      });
    }

    if (this.previewMode) {
      this.previewEl.innerHTML = marked.parse(newContent) as string;
    }
  }

  _isMarkdown(filePath: string | null | undefined): boolean {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }
}

