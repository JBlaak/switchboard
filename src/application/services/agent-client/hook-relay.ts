/**
 * A VM session's hooks, answered by the Mac (#276).
 *
 * The CLI on the VM posts its AskUserQuestion, Stop, UserPromptSubmit and
 * Subagent hooks, and its archive tool calls, to the agent's own hook server;
 * the agent forwards them over the link. The Mac's hook receiver (the same one
 * a local session's hook server hands to) and ArchiveToolService are the ones
 * that answer, so the question panel, the grilling card and `archive_session`
 * work on a VM session unchanged. Both find the session by the id it was
 * launched under, which is the id the Mac opened it with. A turn arrives
 * already read: the agent read its text blocks from the transcript on the VM.
 *
 * An `ask` holds the CLI until it is answered. The handle QuestionService
 * gives back is kept by the agent's `hookId` so the agent can withdraw it;
 * when the link drops every held one is withdrawn, because the agent releases
 * them on its side (the CLI then asks in its terminal) and an answer could no
 * longer reach them.
 */
import type {AgentMessage} from '../../../domain/agent/protocol';
import type {HookReceiver} from '../../ports/question-hook';
import type {ArchiveToolService} from '../archive-tool-service';
import type {AgentConnection} from './agent-connection';

export interface HookRelayDeps {
    /** Where asks and the grilling card's notices go: the same receiver the Mac's own hook server has. */
    hooks: HookReceiver;
    archiveTool: Pick<ArchiveToolService, 'request' | 'turnEnded'>;
}

/** The hook messages the relay answers. */
export type HookMessage = Extract<
    AgentMessage,
    {
        type:
            'ask' | 'ask-withdrawn' | 'grill-turn' | 'prompt-submitted' | 'subagent' | 'archive-request' | 'turn-ended';
    }
>;

const HOOK_TYPES: ReadonlySet<string> = new Set([
    'ask',
    'ask-withdrawn',
    'grill-turn',
    'prompt-submitted',
    'subagent',
    'archive-request',
    'turn-ended',
]);

export function isHookMessage(message: {type: string}): message is HookMessage {
    return HOOK_TYPES.has(message.type);
}

/** One host's relay; attached to its connection for the connection's life. */
export class HookRelay {
    private readonly held = new Map<string, {withdraw(): void}>();

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
        const {hooks, archiveTool} = this.deps;
        switch (message.type) {
            case 'ask': {
                const {hookId} = message;
                let answered = false;
                const handle = hooks.receive(message.launchId, message.asked, (json) => {
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
            case 'grill-turn':
                hooks.turnEnded(message.launchId, message.turn, message.backgroundAgents);
                break;
            case 'prompt-submitted':
                hooks.promptSubmitted(message.launchId, message.prompt ?? '');
                break;
            case 'subagent':
                hooks.subagentChanged(message.launchId, message.event, message.agentId);
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
