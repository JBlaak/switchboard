/**
 * The grilling card: a grilling round as a sheet over the terminal area,
 * one question at a time, with Patch beside it.
 *
 * It takes the question panel's place while the session on screen has a
 * grilling round open, and moves the same way: it rises over the terminal
 * (which sinks behind it), steps aside while the user peeks at the terminal
 * (T or Esc, and back), and keeps what the store keeps — the draft answers
 * are main's, the place, open fields and the rest are the store's per
 * session and round — so a session switch only changes what it reads.
 *
 * Keys are a native listener on the sheet, like the question panel's: they
 * act only while the sheet has the keyboard and stop unmodified keys from
 * reaching the window's shortcuts. ⌘↵ sends from anywhere while the card is
 * up. The card never takes the keyboard from a terminal the user is typing in
 * when a round arrives; showing the session, or coming back to the round,
 * does.
 */
import {useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {answeredFoot} from '../../features/questions/question-copy';
import {questionIn, settle} from '../../features/questions/question-motion';
import {bannerFor, bannerSeenFor} from '../../features/grill/grill-banner';
import {answeredCount, choiceAnswer, onReview, stepPlace} from '../../features/grill/grill-card';
import {grillKey} from '../../features/grill/grill-keys';
import {fieldText, freshUi, withInFlight} from '../../features/grill/grill-ui';
import {useStore} from '../use-store';
import {focusTerminal, greet, peek} from '../questions/actions';
import {onEvent} from '../../state/app-store';
import {PatchColumn} from '../questions/PatchColumn';
import * as grill from './actions';
import {GrillFieldBox, GrillFooter, GrillReview, GrillTabs} from './GrillParts';
import {GrillQuestion} from './GrillQuestion';
import {BlockMarkdown} from './Markdown';
import type {JSX} from 'react';
import type {GrillView} from '../../../domain/grill/model';
import type {PendingQuestions} from '../../../domain/questions/question';
import type {Answering} from '../../state/answers-slice';
import type {GrillCardUi, FieldKind, InFlightAnswer} from '../../features/grill/grill-ui';
import type {GrillAction} from '../../features/grill/grill-keys';
import type {OnScreen} from '../questions/use-on-screen';
import type {RoundAt} from './actions';

export interface GrillingCardProps {
    /** What is on screen; `up` only when it is a grilling round. */
    screen: OnScreen;
    /** The round, as main last described it. */
    view: GrillView | undefined;
    /** A round is coming up: the farewell must not sit over it. */
    onShow(): void;
}

interface Shown {
    sessionId: string;
    pending: PendingQuestions;
    answering: Answering;
    view: GrillView;
    ui: GrillCardUi | undefined;
    inFlight: readonly InFlightAnswer[] | undefined;
}

export function GrillingCard({screen, view: mainView, onShow}: GrillingCardProps): JSX.Element {
    const {up, peeking, sessionId} = screen;
    const sheet = useRef<HTMLElement>(null);
    const block = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const arriving = useRef<string | null>(null);

    const storedUi = useStore((s) => (sessionId ? s.grill.ui[sessionId] : undefined));
    const inFlight = useStore((s) => (sessionId ? s.grill.inFlight[sessionId] : undefined));

    // While hidden the sheet keeps what it last showed, so it fades out with it.
    const last = useRef<Shown | null>(null);
    if (up && sessionId && mainView && screen.pending && screen.answering)
        last.current = {
            sessionId,
            pending: screen.pending,
            answering: screen.answering,
            view: mainView,
            ui: storedUi,
            inFlight,
        };
    const shown = last.current;

    const view = useMemo(
        () => (shown ? withInFlight(shown.view, shown.inFlight ?? []) : undefined),
        [shown?.view, shown?.inFlight],
    );
    const ui: GrillCardUi | undefined =
        shown && view
            ? shown.ui && shown.ui.roundId === view.roundId
                ? shown.ui
                : freshUi(view.roundId, view.revision)
            : undefined;
    const at: RoundAt | undefined =
        shown && view
            ? {sessionId: shown.sessionId, roundId: view.roundId, toolUseId: shown.pending.toolUseId}
            : undefined;

    const total = view?.questions.length ?? 0;
    const place = Math.max(0, Math.min(ui?.place ?? 0, total));
    const reviewing = !!view && onReview(view, place);
    const question = view?.questions[place];
    const field = ui?.fields[place];
    const choices = question?.choices?.list.length ?? 0;
    const done = view ? answeredCount(view) : 0;
    const banner = view && ui ? bannerFor(view, ui.banner) : null;

    // ── Acting ──

    const live = useRef({at, view, place, field, reviewing, choices, up, peeking});
    live.current = {at, view, place, field, reviewing, choices, up, peeking};

    /** Put the keyboard where the card's cursor is: the open field, or the sheet. */
    function focusInside(): void {
        const now = live.current;
        if (!now.up || now.peeking) return;
        const box = input.current;
        if (now.field && box) {
            if (document.activeElement !== box) {
                box.focus({preventScroll: true});
                box.setSelectionRange(box.value.length, box.value.length);
            }
            return;
        }
        if (document.activeElement !== sheet.current) sheet.current?.focus({preventScroll: true});
    }

    function go(to: number): void {
        const now = live.current;
        if (!now.at) return;
        grill.navigate(now.at, to);
    }

    function next(): void {
        const now = live.current;
        if (now.view) go(stepPlace(now.view, now.place, 1));
    }

    function answerWith(answer: Parameters<typeof grill.giveAnswer>[2]): void {
        const now = live.current;
        if (!now.at) return;
        void grill.giveAnswer(now.at, now.place, answer);
        next();
    }

    function pickChoice(letter: string): void {
        const now = live.current;
        const q = now.view?.questions[now.place];
        if (!q) return;
        const answer = choiceAnswer(q, letter);
        if (answer) answerWith(answer);
    }

    function open(kind: FieldKind): void {
        const now = live.current;
        const q = now.view?.questions[now.place];
        if (!now.at || !q) return;
        grill.openField(now.at, now.place, {kind, text: fieldText(q, kind, now.field)});
    }

    /** Commit the field open on this question: answer (and go on), or ask. */
    function commitHere(): Promise<void> {
        const now = live.current;
        if (!now.at || !now.field) return Promise.resolve();
        const {advance, settled} = grill.commit(now.at, now.place, now.field);
        if (advance) next();
        return settled;
    }

    /** An answer half-typed goes with a send or Accept the rest; a question half-asked does not. */
    async function commitQuietly(): Promise<void> {
        const now = live.current;
        if (!now.at || !now.field || now.field.kind === 'ask') return;
        const {settled} = grill.commit(now.at, now.place, now.field);
        await settled;
    }

    async function send(): Promise<void> {
        const now = live.current;
        if (!now.at) return;
        const target = now.at;
        await commitQuietly();
        await grill.send(target);
    }

    async function acceptRest(): Promise<void> {
        const now = live.current;
        if (!now.at || !now.view) return;
        const target = now.at;
        await commitQuietly();
        go(now.view.questions.length);
        await grill.acceptTheRest(target);
    }

    function act(action: GrillAction): void {
        const now = live.current;
        if (!now.at) return;
        switch (action) {
            case 'accept':
                return answerWith({kind: 'accepted'});
            case 'note':
                return open('note');
            case 'override':
                return open('override');
            case 'ask':
                return open('ask');
            case 'wait':
                void grill.ask(now.at, now.place, null);
                return;
            case 'next':
                return next();
            case 'prev':
                if (now.view) go(stepPlace(now.view, now.place, -1));
                return;
            case 'rest':
                void acceptRest();
                return;
            case 'peek':
                return peek(now.at.toolUseId, true);
            case 'unpeek':
                return peek(now.at.toolUseId, false);
            case 'send':
                void send();
                return;
            case 'commit':
                void commitHere();
                return;
            case 'close-field':
                grill.closeField(now.at, now.place);
                sheet.current?.focus({preventScroll: true});
                return;
        }
    }

    const handlers = useRef({act, pickChoice});
    handlers.current = {act, pickChoice};

    // ── Keys ──

    useEffect(() => {
        const el = sheet.current!;
        const onKey = (e: KeyboardEvent): void => {
            const now = live.current;
            const key = grillKey(e, {
                inField: e.target === input.current,
                onReview: now.reviewing,
                choices: now.choices,
                peeking: now.peeking,
            });
            if (key.does === 'pass') return;
            e.stopPropagation();
            if (!now.up || key.does === 'keep') return;
            e.preventDefault();
            if (key.does === 'choice') {
                const letter = now.view?.questions[now.place]?.choices?.list[key.index]?.letter;
                if (letter) handlers.current.pickChoice(letter);
            } else handlers.current.act(key.action);
        };
        el.addEventListener('keydown', onKey);
        return () => el.removeEventListener('keydown', onKey);
    }, []);

    // ⌘↵ sends from anywhere while the card is up; inside the sheet its own listener has it.
    useEffect(() => {
        if (!up || peeking) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
            if (sheet.current?.contains(e.target as Node)) return;
            e.preventDefault();
            handlers.current.act('send');
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [up, peeking]);

    // ── Showing and hiding ──

    const before = useRef<{up: boolean; key: string | undefined; view: string | undefined}>({
        up: false,
        key: undefined,
        view: undefined,
    });
    const showKey = up && at ? `${at.sessionId}:${at.roundId}` : undefined;
    /** The round on screen, up or not, to tell a return from an arrival. */
    const roundKey = sessionId && mainView ? `${sessionId}:${mainView.roundId}` : undefined;

    useLayoutEffect(() => {
        const prev = before.current;
        before.current = {up, key: roundKey, view: screen.answering?.view};
        if (!up || !shown || !showKey) return;
        if (prev.up && prev.key === showKey) return;

        onShow();
        // Resolve the sheet's new style before anything inside it animates (see QuestionPanel).
        void sheet.current?.offsetWidth;
        if (block.current) settle(block.current);

        // The card covers the terminal, so it takes the keyboard as it comes up,
        // as the question panel does. The sheet only turns visible as its rise
        // starts and a hidden element cannot take focus, so this may miss; the
        // guard below catches the keyboard when it lands on the terminal.
        sheet.current?.focus({preventScroll: true});
        focusInside();

        if (!shown.answering.greeted) {
            arriving.current = shown.pending.toolUseId;
            greet(shown.pending.toolUseId);
        }
    });

    // Showing a session focuses its terminal; while the card is up the
    // keyboard belongs to it. A microtask, as the terminal is focused after
    // the showing renders (see QuestionPanel).
    useLayoutEffect(() => {
        let current = true;
        const openTerminal = screen.open;
        queueMicrotask(() => {
            if (!current || !live.current.up) return;
            if (!openTerminal?.element.contains(document.activeElement)) return;
            sheet.current?.focus({preventScroll: true});
            focusInside();
        });
        return () => {
            current = false;
        };
    }, [screen.shown]);

    // While the card is up, the terminal under it cannot keep the keyboard:
    // keys there would type into a prompt nobody can see. Whatever focuses it
    // (the session being shown, a late arrival, the round coming up before the
    // sheet could take focus), the keyboard comes back to the card. Peeking and
    // the terminal view are the ways to reach the terminal, and neither has the
    // card up and unpeeked.
    useEffect(() => {
        if (!up || peeking) return;
        const terminal = screen.open?.element;
        if (!terminal) return;
        let frame = 0;
        const reclaim = (): void => {
            cancelAnimationFrame(frame);
            frame = 0;
            if (!live.current.up || live.current.peeking) return;
            if (!terminal.contains(document.activeElement)) return;
            sheet.current?.focus({preventScroll: true});
            focusInside();
            // Still hidden this frame: try again on the next one.
            if (terminal.contains(document.activeElement)) frame = requestAnimationFrame(reclaim);
        };
        const onFocusIn = (e: FocusEvent): void => {
            if (terminal.contains(e.target as Node)) queueMicrotask(reclaim);
        };
        document.addEventListener('focusin', onFocusIn);
        reclaim();
        return () => {
            document.removeEventListener('focusin', onFocusIn);
            cancelAnimationFrame(frame);
        };
    }, [up, peeking, screen.open]);

    // Peeking keeps the keyboard on the sheet, so T or Esc can bring the card
    // back; coming back (from the pill, too) puts it where the cursor is.
    useLayoutEffect(() => {
        if (!up) return;
        sheet.current?.focus({preventScroll: true});
        if (!peeking) focusInside();
    }, [peeking]);

    // A round that closes while the card has the keyboard hands it to the terminal.
    useEffect(
        () =>
            onEvent('questionsSettled', ({settled}) => {
                if (settled.toolUseId !== live.current.at?.toolUseId) return;
                if (sheet.current?.contains(document.activeElement)) focusTerminal();
            }),
        [],
    );

    // The keyboard follows the cursor — into a field that opens, onto the
    // sheet when it closes — as long as it is the card's to move.
    const fieldKind = field?.kind;
    useLayoutEffect(() => {
        if (!up || peeking) return;
        const active = document.activeElement;
        const ours = !active || active === document.body || !!sheet.current?.contains(active);
        if (ours) focusInside();
    }, [up, peeking, showKey, place, fieldKind]);

    // Each question comes in as the card lands on it.
    const lastPlace = useRef<{key: string | undefined; place: number}>({key: undefined, place: 0});
    useLayoutEffect(() => {
        const prev = lastPlace.current;
        lastPlace.current = {key: showKey, place};
        if (!up || !block.current || prev.key !== showKey || prev.place === place) return;
        const rows = [...block.current.querySelectorAll<HTMLElement>('.gc-choice')];
        questionIn(block.current, rows, place > prev.place ? 'fwd' : 'back', 0);
    }, [showKey, place]);

    // A marked question in view counts towards the banner stepping aside.
    const revision = view?.revision ?? 0;
    const seenAlready = ui ? bannerSeenFor(ui.banner, revision).seen.includes(place) : true;
    useEffect(() => {
        if (!up || peeking || !at || !question?.mark || seenAlready) return;
        grill.seen(at, revision, place);
    }, [up, peeking, at?.sessionId, at?.roundId, revision, place, !!question?.mark, seenAlready]);

    // ── Drawing ──

    return (
        <section
            ref={sheet}
            className={'qp gc' + (up ? (peeking ? ' is-up is-peeking' : ' is-up') : '')}
            tabIndex={-1}
            aria-label="Grilling round from Claude"
            aria-hidden={up ? 'false' : 'true'}
            inert={!up}>
            <div className="qp-inner">
                <PatchColumn
                    up={up}
                    ready={up && !!at}
                    toolUseId={at?.toolUseId}
                    said={shown?.answering.said ?? null}
                    arriving={arriving}
                    foot={view ? answeredFoot(done, total) : ''}
                />
                {view && ui && at && (
                    <div className="gc-card">
                        <GrillTabs view={view} place={place} onGo={go} />
                        <div className="gc-progress">{answeredFoot(done, total)}</div>
                        {view.preamble.trim() && (
                            <details
                                className="gc-context"
                                open={ui.contextOpen}
                                onToggle={(e) => {
                                    const opened = e.currentTarget.open;
                                    if (opened !== ui.contextOpen) grill.toggleContext(at, opened);
                                }}>
                                <summary tabIndex={-1}>Context</summary>
                                <BlockMarkdown className="gc-context-body" text={view.preamble} />
                            </details>
                        )}
                        {banner && (
                            <div
                                className={'gc-banner' + (banner.kind === 'unsent' ? ' is-alert' : '')}
                                role={banner.kind === 'unsent' ? 'alert' : 'status'}>
                                <span>{banner.text}</span>
                                {banner.kind === 'revised' && (
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className="gc-banner-dismiss"
                                        onClick={() => grill.dismissBanner(at, view.revision)}>
                                        Dismiss
                                    </button>
                                )}
                            </div>
                        )}
                        {reviewing ? (
                            <GrillReview key={`${showKey}:review`} view={view} blockRef={block} onGo={go} />
                        ) : (
                            <GrillQuestion
                                key={`${showKey}:${place}`}
                                view={view}
                                place={place}
                                blockRef={block}
                                onChoice={pickChoice}
                            />
                        )}
                        {!reviewing && (
                            <div className="gc-actions">
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    className="gc-btn is-accept"
                                    onClick={() => act('accept')}>
                                    Accept <kbd className="gc-kbd">Y</kbd>
                                </button>
                                <button type="button" tabIndex={-1} className="gc-btn" onClick={() => act('note')}>
                                    With a note <kbd className="gc-kbd">N</kbd>
                                </button>
                                <button type="button" tabIndex={-1} className="gc-btn" onClick={() => act('override')}>
                                    Answer instead <kbd className="gc-kbd">O</kbd>
                                </button>
                                <span className="gc-askgroup">
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className="gc-btn is-quiet"
                                        onClick={() => act('ask')}>
                                        Ask about this <kbd className="gc-kbd">?</kbd>
                                    </button>
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className="gc-btn is-quiet"
                                        onClick={() => act('wait')}>
                                        Wait, what? <kbd className="gc-kbd">W</kbd>
                                    </button>
                                </span>
                            </div>
                        )}
                        {!reviewing && field && (
                            <GrillFieldBox
                                key={`${showKey}:${place}:${field.kind}`}
                                kind={field.kind}
                                text={field.text}
                                inputRef={input}
                                onType={(text) => grill.typeField(at, place, text)}
                                onCommit={() => act('commit')}
                            />
                        )}
                        <GrillFooter
                            view={view}
                            reviewing={reviewing}
                            choices={choices}
                            allAnswered={done === total}
                            error={ui.error}
                            onRest={() => act('rest')}
                            onSend={() => act('send')}
                            onQueue={() => void grill.queue(at)}
                            onCancelQueue={() => void grill.cancelQueue(at)}
                        />
                    </div>
                )}
            </div>
        </section>
    );
}
