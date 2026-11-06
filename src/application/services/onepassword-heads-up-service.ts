/**
 * The 1Password heads-ups waiting on the user, one pop-up at a time.
 *
 * A Bash call that will reach 1Password reaches us as a held hook request, as
 * a question does: the CLI waits until we reply. The first one waiting is on
 * screen; the rest queue behind it in the order they came, so two sessions
 * pushing at once each get their own heads-up. A request that goes away first
 * (the hook's timeout, the session stopped, the CLI interrupted) leaves the
 * queue, and the pop-up moves on or goes away.
 */
import {
    ONEPASSWORD_HOOK_TIMEOUT_SECONDS,
    onePasswordHookResponse,
    type HeadsUpAnswer,
    type OnePasswordCall,
    type OnePasswordHeadsUp,
} from '../../domain/onepassword/heads-up';
import type {SessionRegistry} from '../model/session-registry';
import type {Clock} from '../ports/clock';
import type {HeadsUpPanel} from '../ports/heads-up-panel';
import type {Logger} from '../ports/logger';
import type {PendingQuestionsHandle, QuestionReply} from './question-service';

interface Waiting {
    readonly headsUp: OnePasswordHeadsUp;
    readonly reply: QuestionReply;
}

export interface OnePasswordHeadsUpServiceDeps {
    registry: Pick<SessionRegistry, 'find'>;
    panel: HeadsUpPanel;
    clock: Clock;
    log: Logger;
}

export class OnePasswordHeadsUpService {
    private readonly queue: Waiting[] = [];
    private count = 0;

    constructor(private readonly deps: OnePasswordHeadsUpServiceDeps) {}

    /**
     * A held Bash call that will reach 1Password, from the session launched as
     * `launchId`. Not one of ours (no running session): no decision, so the
     * command runs as it would have.
     */
    public receive(launchId: string, call: OnePasswordCall, reply: QuestionReply): PendingQuestionsHandle {
        const {registry, clock, log} = this.deps;
        const found = registry.find(launchId);
        if (!found) {
            reply({});
            return {withdraw() {}};
        }
        const now = clock.now();
        const waiting: Waiting = {
            headsUp: {
                ...call,
                id: `op-${now}-${++this.count}`,
                project: folderName(found.session.projectPath),
                deadline: now + ONEPASSWORD_HOOK_TIMEOUT_SECONDS * 1000,
            },
            reply,
        };
        this.queue.push(waiting);
        log.info(`[1password] session=${found.key} heads-up ${waiting.headsUp.id} (${call.need}) queued`);
        if (this.queue.length === 1) this.showFirst();
        return {withdraw: () => this.remove(waiting, 'withdrawn')};
    }

    /** Enter or Escape on the pop-up. False when that heads-up is no longer waiting. */
    public answer(id: string, answer: HeadsUpAnswer): boolean {
        const waiting = this.queue.find((entry) => entry.headsUp.id === id);
        if (!waiting) return false;
        this.remove(waiting, answer);
        waiting.reply(onePasswordHookResponse(answer));
        return true;
    }

    /** What the pop-up shows now, for a pop-up that has just loaded. */
    public current(): OnePasswordHeadsUp | null {
        return this.queue[0]?.headsUp ?? null;
    }

    private remove(waiting: Waiting, outcome: HeadsUpAnswer | 'withdrawn'): void {
        const index = this.queue.indexOf(waiting);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.deps.log.info(`[1password] heads-up ${waiting.headsUp.id} ${outcome}`);
        if (index === 0) this.showFirst();
    }

    private showFirst(): void {
        const first = this.queue[0];
        if (first) this.deps.panel.show(first.headsUp);
        else this.deps.panel.hide();
    }
}

/** The last part of a project's path, as the pop-up names it. */
function folderName(projectPath: string): string {
    return projectPath.replace(/\/+$/, '').split('/').pop() || projectPath;
}
