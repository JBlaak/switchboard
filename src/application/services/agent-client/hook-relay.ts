/**
 * A VM session's hooks, answered by the Mac (#276).
 *
 * The CLI on the VM posts its AskUserQuestion, Stop and UserPromptSubmit
 * hooks, and its archive tool calls, to the agent's own hook server; the agent
 * forwards them over the link. The Mac's QuestionService and
 * ArchiveToolService are the ones that answer, exactly as they answer a local
 * session's hook server, so the question panel, grill rounds and
 * `archive_session` work on a VM session unchanged. Both find the session by
 * the id it was launched under, which is the id the Mac opened it with.
 *
 * An `ask` holds the CLI until it is answered. The handle QuestionService
 * gives back is kept by the agent's `hookId` so the agent can withdraw it;
 * when the link drops every held one is withdrawn, because the agent releases
 * them on its side (the CLI then asks in its terminal) and an answer could no
 * longer reach them.
 */
import type {AgentMessage} from '../../../domain/agent/protocol';
import type {ArchiveToolService} from '../archive-tool-service';
import type {PendingQuestionsHandle, QuestionService} from '../question-service';
import type {AgentConnection} from './agent-connection';

export interface HookRelayDeps {
    questions: Pick<QuestionService, 'receive' | 'receiveRound' | 'promptSubmitted'>;
    archiveTool: Pick<ArchiveToolService, 'request' | 'turnEnded'>;
}

/** The hook messages the relay answers. */
export type HookMessage = Extract<
    AgentMessage,
    {
        type: 'ask' | 'ask-withdrawn' | 'grill-round' | 'prompt-submitted' | 'archive-request' | 'turn-ended';
    }
>;

const HOOK_TYPES: ReadonlySet<string> = new Set([
    'ask',
    'ask-withdrawn',
    'grill-round',
    'prompt-submitted',
    'archive-request',
    'turn-ended',
]);

export function isHookMessage(message: {type: string}): message is HookMessage {
    return HOOK_TYPES.has(message.type);
}

/** One host's relay; attached to its connection for the connection's life. */
export class HookRelay {
    private readonly held = new Map<string, PendingQuestionsHandle>();

    constructor(
        private readonly connection: Pick<AgentConnection, 'send' | 'onMessage' | 'onDisconnected'>,
        private readonly deps: HookRelayDeps,
    ) {
        connection.onMessage((message) => {
            if (isHookMessage(message)) this.handle(message);
        });
        connection.onDisconnected(() => this.releaseAll());
    }

    /** How many asks are held now, waiting for an answer. */
    public get heldCount(): number {
        return this.held.size;
    }

    private handle(message: HookMessage): void {
        const {questions, archiveTool} = this.deps;
        switch (message.type) {
            case 'ask': {
                const {hookId} = message;
                let answered = false;
                const handle = questions.receive(message.launchId, message.asked, (json) => {
                    answered = true;
                    this.held.delete(hookId);
                    this.connection.send({type: 'ask-reply', hookId, json});
                });
                // `receive` answers at once when it cannot show the question (no
                // such session); then there is nothing left to hold.
                if (!answered) this.held.set(hookId, handle);
                break;
            }
            case 'ask-withdrawn': {
                const handle = this.held.get(message.hookId);
                this.held.delete(message.hookId);
                handle?.withdraw();
                break;
            }
            case 'grill-round':
                questions.receiveRound(message.launchId, message.questions);
                break;
            case 'prompt-submitted':
                questions.promptSubmitted(message.launchId);
                break;
            case 'archive-request': {
                const outcome = archiveTool.request(message.launchId);
                this.connection.send({type: 'archive-reply', hookId: message.hookId, outcome});
                break;
            }
            case 'turn-ended':
                archiveTool.turnEnded(message.launchId);
                break;
        }
    }

    /** The link is gone: the agent has released every held ask, so withdraw them here too. */
    private releaseAll(): void {
        const handles = [...this.held.values()];
        this.held.clear();
        handles.forEach((handle) => handle.withdraw());
    }
}
