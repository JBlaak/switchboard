/**
 * Electron's webContents behind the RendererGateway port.
 *
 * Every send is guarded on a live window, and every send is a no-op without
 * one — a session keeps running with no window attached (that is the point of
 * the output buffer), and the alternative would be a null check at each of the
 * fifty call sites.
 *
 * The window is fetched through a callback rather than held, because it is
 * replaced: on macOS the app survives its last window closing and builds a new
 * one when the dock icon is clicked.
 *
 * Quick Ask's two (#142) are the exception to sending into the void: they are
 * what a window is opened for (R4), so they wait for one whose renderer has
 * said it is ready, having loaded the projects and restored its view.
 */
import {EVENT} from '../../ipc/channels';
import type {BrowserWindow} from 'electron';
import type {RemoteStatusPayload} from '../../domain/remote/remote-status';
import type {WorkingAgent} from '../../domain/terminal/program-status-children';
import type {UpdateNotice} from '../../domain/update/release';
import type {PendingQuestions, QuestionsSettled} from '../../domain/questions/question';
import type {GrillChanged} from '../../domain/grill/model';
import type {SessionWorkSnapshot} from '../../domain/session-work/model';
import type {PullRequestStatusChange} from '../../domain/session-work/status';
import type {MergeQueueChange} from '../../domain/project/queue-elsewhere';
import type {RendererGateway} from '../../application/ports/renderer-gateway';
import type {PhoneAccessState, TerminalOwner} from '../../domain/phone/state';
import type {TasksUpdate} from '../../domain/tasks/surface';
import type {ShownPage} from '../../domain/session/page-tool';

export class ElectronRendererGateway implements RendererGateway {
    /** The window whose renderer said it is ready, while it is the current one. */
    private ready: BrowserWindow | null = null;
    /** Quick Ask's sends, held until then. */
    private held: [channel: string, args: unknown[]][] = [];

    constructor(private readonly getWindow: () => BrowserWindow | null) {}

    /**
     * The main window's renderer is ready: send what was held for it. Only its
     * preload has the channel, so the sender is the current window.
     */
    public rendererReady(): void {
        const window = this.getWindow();
        if (!window || window.isDestroyed()) return;
        this.ready = window;
        const held = this.held;
        this.held = [];
        for (const [channel, args] of held) this.send(channel, ...args);
    }

    public get attached(): boolean {
        const window = this.getWindow();
        return !!window && !window.isDestroyed();
    }

    // ── Terminal stream ──
    public terminalData(sessionId: string, data: string): void {
        this.send(EVENT.terminalData, sessionId, data);
    }

    public processExited(sessionId: string, exitCode: number): void {
        this.send(EVENT.processExited, sessionId, exitCode);
    }

    // ── Session identity ──
    public sessionForked(oldId: string, newId: string): void {
        this.send(EVENT.sessionForked, oldId, newId);
    }

    // ── Session state ──
    public cliBusyState(sessionId: string, busy: boolean): void {
        this.send(EVENT.cliBusyState, sessionId, busy);
    }

    public terminalNotification(sessionId: string, message: string): void {
        this.send(EVENT.terminalNotification, sessionId, message);
    }

    public sessionNeedsAttention(sessionId: string): void {
        this.send(EVENT.sessionNeedsAttention, sessionId);
    }

    public sessionAgents(sessionId: string, agents: WorkingAgent[]): void {
        this.send(EVENT.sessionAgents, sessionId, agents);
    }

    public remoteStatus(sessionId: string, status: RemoteStatusPayload): void {
        this.send(EVENT.remoteStatus, sessionId, status);
    }

    // ── Questions ──
    public questionsAsked(pending: PendingQuestions): void {
        this.send(EVENT.questionsAsked, pending);
    }

    public questionsSettled(settled: QuestionsSettled): void {
        this.send(EVENT.questionsSettled, settled);
    }

    public grillChanged(changed: GrillChanged): void {
        this.send(EVENT.grillChanged, changed);
    }

    // ── Pages ──
    public pageShown(page: ShownPage): void {
        this.send(EVENT.pageShown, page);
    }

    // ── Lists and chrome ──
    public projectsChanged(): void {
        this.send(EVENT.projectsChanged);
    }

    public vmHostsChanged(): void {
        this.send(EVENT.vmHostsChanged);
    }

    public statusUpdate(text: string, type: string): void {
        this.send(EVENT.statusUpdate, text, type);
    }

    public fullscreenChanged(isFullscreen: boolean): void {
        this.send(EVENT.fullscreenChanged, isFullscreen);
    }

    public updateAvailable(update: UpdateNotice): void {
        this.send(EVENT.updateAvailable, update);
    }

    // ── Session work ──
    public sessionWorkSnapshot(snapshot: SessionWorkSnapshot): void {
        this.send(EVENT.sessionWorkSnapshot, snapshot);
    }

    public prStatusChanged(change: PullRequestStatusChange): void {
        this.send(EVENT.prStatusChanged, change);
    }

    public mergeQueueChanged(change: MergeQueueChange): void {
        this.send(EVENT.mergeQueueChanged, change);
    }

    // ── Quick Ask ──
    public launchRequested(projectPath: string, initialPrompt: string): void {
        this.sendWhenReady(EVENT.launchRequested, projectPath, initialPrompt);
    }

    public pickerRequested(initialPrompt: string, reason?: string): void {
        this.sendWhenReady(EVENT.pickerRequested, initialPrompt, reason);
    }

    public phoneAccessChanged(state: PhoneAccessState): void {
        this.send(EVENT.phoneAccessChanged, state);
    }

    public terminalOwnerChanged(sessionId: string, owner: TerminalOwner): void {
        this.send(EVENT.terminalOwnerChanged, sessionId, owner);
    }

    public sessionStarted(sessionId: string, projectPath: string): void {
        this.send(EVENT.sessionStarted, sessionId, projectPath);
    }

    public sessionArchived(sessionId: string): void {
        this.send(EVENT.sessionArchived, sessionId);
    }

    public tasksChanged(update: TasksUpdate): void {
        this.send(EVENT.tasksChanged, update);
    }

    public sessionTaskChanged(sessionId: string, taskId: string | null): void {
        this.send(EVENT.sessionTaskChanged, sessionId, taskId);
    }

    private sendWhenReady(channel: string, ...args: unknown[]): void {
        const window = this.getWindow();
        // A reload or a new window says it is ready again.
        if (window && !window.isDestroyed() && window === this.ready && !window.webContents.isLoading()) {
            this.send(channel, ...args);
        } else {
            this.held.push([channel, args]);
        }
    }

    private send(channel: string, ...args: unknown[]): void {
        const window = this.getWindow();
        if (!window || window.isDestroyed()) return;
        window.webContents.send(channel, ...args);
    }
}
