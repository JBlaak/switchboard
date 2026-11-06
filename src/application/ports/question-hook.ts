/**
 * Where a Claude session's question hook posts to.
 *
 * The hook is a URL baked into each launch's `--settings`, so the question
 * service has to know the server's address and secret before the CLI is
 * spawned — but not how the server is built. The address is null until the
 * server is listening (and stays null if it never managed to), in which case a
 * session simply launches without the hook and asks in its own terminal.
 */
import type {EndedTurn} from '../../domain/grill/model';
import type {AskedQuestions} from '../../domain/questions/question';

export interface QuestionHookEndpoint {
    /** The server's base URL, e.g. `http://127.0.0.1:53124`; null while not listening. */
    readonly url: string | null;
    /** The per-run secret the hook must send in QUESTION_HOOK_TOKEN_HEADER. */
    readonly token: string;
}

/**
 * What a hook server hands its questions and notices to.
 *
 * `receive` holds an AskUserQuestion until `reply` is called (or the handle is
 * withdrawn). The rest are notices the CLI was already answered for:
 * `turnEnded` with the text blocks the turn wrote and, when the Stop said, the
 * background subagents still running; `promptSubmitted` with the prompt that
 * went in; `subagentChanged` when a subagent starts or stops. On the Mac this
 * is the question and grilling services; on a VM's agent, the forwarder that
 * sends each over the link to the Mac's.
 */
export interface HookReceiver {
    receive(
        launchId: string,
        asked: AskedQuestions,
        reply: (json: Record<string, unknown>) => void,
    ): {withdraw(): void};
    turnEnded(launchId: string, turn: EndedTurn, backgroundAgents: string[] | null): void;
    promptSubmitted(launchId: string, prompt: string): void;
    subagentChanged(launchId: string, event: 'start' | 'stop', agentId: string): void;
}
