/**
 * TEMPORARY: the hook receiver the Mac uses until the grilling card's
 * GrillService takes over; delete this file then.
 *
 * The hook server now hands on whole turns, prompts and subagent changes
 * (HookReceiver). This keeps the old grill rounds in the question panel
 * working meanwhile: a turn whose last text block is a round, as the old
 * `parseGrillRound` reads it, goes to `QuestionService.receiveRound`, and any
 * prompt to `promptSubmitted`, as before. Subagent changes are ignored.
 */
import {parseGrillRound} from '../../domain/questions/grill';
import type {HookReceiver} from '../ports/question-hook';
import type {QuestionService} from './question-service';

export function legacyGrillReceiver(
    questions: () => Pick<QuestionService, 'receive' | 'receiveRound' | 'promptSubmitted'>,
): HookReceiver {
    return {
        receive: (launchId, asked, reply) => questions().receive(launchId, asked, reply),
        turnEnded: (launchId, turn) => {
            const last = turn.texts.at(-1)?.text;
            const round = last ? parseGrillRound(last) : null;
            if (round) questions().receiveRound(launchId, round);
        },
        promptSubmitted: (launchId) => questions().promptSubmitted(launchId),
        subagentChanged: () => {},
    };
}
