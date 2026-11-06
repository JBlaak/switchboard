/**
 * Grilling-round views for the renderer's tests: a question and a round as
 * main would send them, with only what a test cares about spelled out.
 */
import type {GrillQuestionView, GrillView} from '../../src/domain/grill/model';

/** An open question numbered `number`, titled after it unless `over` says otherwise. */
export function question(number: number, over: Partial<GrillQuestionView> = {}): GrillQuestionView {
    return {
        number,
        title: `Question ${number}`,
        reason: `Why ${number}.`,
        recommendation: `Do ${number}.`,
        answer: null,
        setAside: null,
        mark: null,
        asked: false,
        explanation: null,
        ...over,
    };
}

/** A round of session `s1` with `count` open questions, unless `over` says otherwise. */
export function view(count: number, over: Partial<GrillView> = {}): GrillView {
    return {
        sessionId: 's1',
        roundId: 'r1',
        revision: 0,
        preamble: 'Context.',
        questions: Array.from({length: count}, (_, i) => question(i + 1)),
        dropped: 0,
        agentsRunning: 0,
        send: 'idle',
        asking: null,
        ...over,
    };
}

/** A question offering choices (a) Forever, (b) 30 days, (c) Until removed, recommending `recommended`. */
export function choiceQuestion(number: number, recommended = 'c'): GrillQuestionView {
    return question(number, {
        choices: {
            lead: 'How long?',
            list: [
                {letter: 'a', text: 'Forever'},
                {letter: 'b', text: '30 days'},
                {letter: 'c', text: 'Until removed'},
            ],
            after: '',
        },
        recommendedChoice: recommended,
    });
}
