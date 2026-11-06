/**
 * Claude's AskUserQuestion, answered from Switchboard, and the grilling card's
 * calls on an open grilling round.
 */
import {INVOKE} from '../../ipc/channels';
import type {Answers} from '../../domain/questions/question';
import type {GrillAnswer} from '../../domain/grill/model';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerQuestionHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.getPendingQuestions, () => app.questions.pending());
    // Answered here, which makes the Mac the session's device (#194).
    ipc.handle(INVOKE.answerQuestions, (sessionId: string, toolUseId: string, answers: Answers) =>
        app.questions.answer(sessionId, toolUseId, answers, 'mac'),
    );

    ipc.handle(INVOKE.grillViews, () => app.grill.views());
    ipc.handle(
        INVOKE.grillAnswer,
        (sessionId: string, roundId: string, revision: number, place: number, answer: GrillAnswer | null) =>
            app.grill.answer(sessionId, roundId, revision, place, answer, 'mac'),
    );
    ipc.handle(
        INVOKE.grillAsk,
        (sessionId: string, roundId: string, revision: number, place: number, text: string | null) =>
            app.grill.ask(sessionId, roundId, revision, place, text),
    );
    ipc.handle(INVOKE.grillSend, (sessionId: string, roundId: string) => app.grill.send(sessionId, roundId, 'mac'));
    ipc.handle(INVOKE.grillQueue, (sessionId: string, roundId: string) => app.grill.queue(sessionId, roundId));
    ipc.handle(INVOKE.grillCancelQueue, (sessionId: string, roundId: string) =>
        app.grill.cancelQueue(sessionId, roundId),
    );
}
