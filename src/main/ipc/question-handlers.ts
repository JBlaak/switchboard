/**
 * Claude's AskUserQuestion, answered from Switchboard.
 */
import { INVOKE } from '../../ipc/channels';
import type { Answers } from '../../domain/questions/question';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerQuestionHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getPendingQuestions, () => app.questions.pending());
  // Answered here, which makes the Mac the session's device (#194).
  ipc.handle(INVOKE.answerQuestions, (sessionId: string, toolUseId: string, answers: Answers) =>
    app.questions.answer(sessionId, toolUseId, answers, 'mac'));
}
