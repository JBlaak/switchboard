/**
 * What a key on the grilling card means, from the key alone and where it
 * landed.
 *
 * On the card itself: Y accepts, N opens a note, O an answer of one's own,
 * 1–9 pick one of the question's inline choices, ↓/↑ step through the round
 * (↓ past the last question opens the review), A accepts the rest, ? asks
 * about the question, W asks Claude to re-pitch it, and T or Esc look at the
 * terminal. On the review only A, ↑/↓ and the terminal keys mean anything.
 *
 * In one of the card's fields the text is the field's: Enter keeps it and
 * goes on (or asks), Shift+Enter is a newline, Esc closes the field. ⌘↵ sends
 * from anywhere, fields included.
 *
 * Unmodified keys stop at the card, so none of them reaches the terminal or a
 * global shortcut (a bare N would otherwise start a quick session); other
 * Cmd/Ctrl/Alt combinations, Tab and keys mid IME composition go on.
 */

export interface GrillKeyEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing: boolean;
}

export interface GrillKeyPlace {
    /** The key landed in one of the card's text fields. */
    inField: boolean;
    /** The card shows the review rather than a question. */
    onReview: boolean;
    /** How many inline choices the question on screen offers. */
    choices: number;
    /** The card has stepped aside to show the terminal. */
    peeking: boolean;
}

export type GrillAction =
    | 'accept'
    | 'note'
    | 'override'
    | 'ask'
    | 'wait'
    | 'next'
    | 'prev'
    | 'rest'
    | 'peek'
    | 'unpeek'
    | 'send'
    | 'commit'
    | 'close-field';

export type GrillKey =
    /** Not the card's: it goes on to the app. */
    | {does: 'pass'}
    /** Stops at the card, its default left alone (typing in a field, a button's click). */
    | {does: 'keep'}
    | {does: 'act'; action: GrillAction}
    /** Pick the question's inline choice at this index (0 for `a`). */
    | {does: 'choice'; index: number};

const PASS: GrillKey = {does: 'pass'};
const KEEP: GrillKey = {does: 'keep'};
const act = (action: GrillAction): GrillKey => ({does: 'act', action});

const CARD_KEYS: Record<string, GrillAction> = {
    y: 'accept',
    n: 'note',
    o: 'override',
    '?': 'ask',
    w: 'wait',
    a: 'rest',
    t: 'peek',
};

/** Keys that still act on the review page. */
const REVIEW_ACTIONS: ReadonlySet<GrillAction> = new Set(['rest', 'peek', 'next', 'prev']);

export function grillKey(e: GrillKeyEvent, at: GrillKeyPlace): GrillKey {
    if (e.isComposing) return PASS;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return act('send');
    if (e.metaKey || e.ctrlKey || e.altKey) return PASS;
    if (e.key === 'Tab') return PASS;

    if (at.inField) {
        if (e.key === 'Enter' && !e.shiftKey) return act('commit');
        if (e.key === 'Escape') return act('close-field');
        return KEEP;
    }

    // While the terminal shows, T or Esc brings the card back; nothing else
    // may answer a question no one can see.
    if (at.peeking) return e.key === 't' || e.key === 'T' || e.key === 'Escape' ? act('unpeek') : KEEP;

    let action: GrillAction | undefined;
    if (e.key === 'Escape') action = 'peek';
    else if (e.key === 'ArrowDown') action = 'next';
    else if (e.key === 'ArrowUp') action = 'prev';
    else action = CARD_KEYS[e.key.toLowerCase()];

    if (!action && /^[1-9]$/.test(e.key) && !at.onReview) {
        const index = Number(e.key) - 1;
        return index < at.choices ? {does: 'choice', index} : KEEP;
    }
    if (!action) return KEEP;
    if (at.onReview && !REVIEW_ACTIONS.has(action)) return KEEP;
    return act(action);
}
