/**
 * What the grilling card does beyond drawing itself: the calls to main for a
 * round's answers, asks and sends, and the card's own working state.
 *
 * Every call to main answers with a `GrillResult`; its error is shown in the
 * card's footer until the next call goes through. An answer is laid over the
 * view while its call is out (see `grill-slice`), so it shows at once.
 */
import {acceptRest, answeredCount} from '../../features/grill/grill-card';
import {commitField, withInFlight} from '../../features/grill/grill-ui';
import {dispatch, getState} from '../../state/app-store';
import type {GrillAnswer, GrillResult, GrillView} from '../../../domain/grill/model';
import type {QuestionMoment} from '../../../domain/companion/question-beats';
import type {GrillField} from '../../features/grill/grill-ui';

/** Numbers the answer calls, so a later one for the same question wins. */
let seq = 0;

/** The rounds open before this window loaded (or before a reload). */
export function installGrill(): void {
    void window.api
        .grillViews()
        .then((views) => dispatch({type: 'grillLoaded', views}))
        .catch(() => {});
}

/** One round of one session: who the calls are for. */
export interface RoundAt {
    sessionId: string;
    roundId: string;
    /** The set the round opened, which Patch talks beside. */
    toolUseId: string;
}

/** The round as the card shows it now: main's view with the answers in flight laid over it. */
function current(at: RoundAt): GrillView | undefined {
    const {views, inFlight} = getState().grill;
    const view = views[at.sessionId];
    return view && view.roundId === at.roundId ? withInFlight(view, inFlight[at.sessionId] ?? []) : undefined;
}

/** Show `result`'s error in the footer, or clear the last one. */
function report(at: RoundAt, result: GrillResult): boolean {
    dispatch({
        type: 'grillError',
        sessionId: at.sessionId,
        roundId: at.roundId,
        error: result.ok ? null : (result.error ?? 'That did not go through.'),
    });
    return result.ok;
}

async function call(at: RoundAt, make: () => Promise<GrillResult>): Promise<boolean> {
    try {
        return report(at, await make());
    } catch (err) {
        console.warn('[grill] call failed:', err);
        return report(at, {ok: false, error: 'Switchboard could not reach the session.'});
    }
}

function say(at: RoundAt, moment: QuestionMoment): void {
    dispatch({type: 'answersSaid', toolUseId: at.toolUseId, moment});
}

/**
 * Give (or clear, with null) the answer at `place`. It shows at once and stays
 * shown until main has answered; a failure takes it back and says why.
 */
export async function giveAnswer(at: RoundAt, place: number, answer: GrillAnswer | null): Promise<boolean> {
    const view = current(at);
    if (!view) return false;
    const entry = {seq: ++seq, roundId: at.roundId, revision: view.revision, place, answer, settled: false};
    dispatch({type: 'grillAnswerSent', sessionId: at.sessionId, entry});

    const before = answeredCount(view);
    const wasAnswered = view.questions[place]?.answer !== null;
    if (answer && !wasAnswered && before + 1 === view.questions.length) say(at, {kind: 'all-answered'});
    else if (answer) say(at, {kind: 'picked', recommended: answer.kind !== 'overridden'});

    const ok = await call(at, () => window.api.grillAnswer(at.sessionId, at.roundId, view.revision, place, answer));
    // The session may have been re-keyed while main answered; its calls moved with it.
    const sessionId = sessionOfRound(at.roundId) ?? at.sessionId;
    dispatch({type: 'grillAnswerSettled', sessionId, seq: entry.seq, ok});
    return ok;
}

/** Ask Claude about the question at `place` with `text`, or Wait, what? with null. */
export function ask(at: RoundAt, place: number, text: string | null): Promise<boolean> {
    const view = current(at);
    if (!view) return Promise.resolve(false);
    return call(at, () => window.api.grillAsk(at.sessionId, at.roundId, view.revision, place, text));
}

/** Accept the recommendation of every question not yet answered. */
export async function acceptTheRest(at: RoundAt): Promise<void> {
    const view = current(at);
    if (!view) return;
    await Promise.all(acceptRest(view).map(({place, answer}) => giveAnswer(at, place, answer)));
}

/** Send the answers now. A sent round closes in main, and Patch sees it off. */
export async function send(at: RoundAt): Promise<void> {
    const ok = await call(at, () => window.api.grillSend(at.sessionId, at.roundId));
    if (ok) dispatch({type: 'answersDelivered', toolUseId: at.toolUseId});
}

/** Send the answers once the session's research agents are done. */
export function queue(at: RoundAt): Promise<boolean> {
    return call(at, () => window.api.grillQueue(at.sessionId, at.roundId));
}

export function cancelQueue(at: RoundAt): Promise<boolean> {
    return call(at, () => window.api.grillCancelQueue(at.sessionId, at.roundId));
}

/**
 * Commit the field open at `place`: give its answer or ask its question, and
 * close it. Answers at once whether to go on to the next question, and the
 * call, to wait for before sending.
 */
export function commit(at: RoundAt, place: number, field: GrillField): {advance: boolean; settled: Promise<void>} {
    const done = commitField(field);
    closeField(at, place);
    const settled = done.ask
        ? ask(at, place, done.ask).then(() => {})
        : done.answer
          ? giveAnswer(at, place, done.answer).then(() => {})
          : Promise.resolve();
    return {advance: done.advance, settled};
}

// ── The card's own working state ──

export function navigate(at: RoundAt, place: number): void {
    dispatch({type: 'grillNavigated', sessionId: at.sessionId, roundId: at.roundId, place});
}

export function openField(at: RoundAt, place: number, field: GrillField): void {
    dispatch({type: 'grillFieldOpened', sessionId: at.sessionId, roundId: at.roundId, place, field});
    if (field.kind === 'override') say(at, {kind: 'started-other'});
}

export function typeField(at: RoundAt, place: number, text: string): void {
    dispatch({type: 'grillFieldTyped', sessionId: at.sessionId, roundId: at.roundId, place, text});
}

export function closeField(at: RoundAt, place: number): void {
    dispatch({type: 'grillFieldClosed', sessionId: at.sessionId, roundId: at.roundId, place});
}

export function toggleContext(at: RoundAt, open: boolean): void {
    dispatch({type: 'grillContextToggled', sessionId: at.sessionId, roundId: at.roundId, open});
}

export function dismissBanner(at: RoundAt, revision: number): void {
    dispatch({type: 'grillBannerDismissed', sessionId: at.sessionId, roundId: at.roundId, revision});
}

export function seen(at: RoundAt, revision: number, place: number): void {
    dispatch({type: 'grillSeen', sessionId: at.sessionId, roundId: at.roundId, revision, place});
}

function sessionOfRound(roundId: string): string | null {
    for (const [sessionId, view] of Object.entries(getState().grill.views)) {
        if (view.roundId === roundId) return sessionId;
    }
    return null;
}
