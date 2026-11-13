/**
 * The smaller pieces of the grilling card: the tabs along the top, the review
 * page, the open field, and the footer with the key hints and the ways to
 * send.
 */
import {answerLabel, reviewFlag, reviewPreview, sendGroup, tabState} from '../../features/grill/grill-card';
import {InlineMarkdown} from './Markdown';
import type {JSX, Ref} from 'react';
import {questionLabel} from '../../../domain/grill/model';
import type {GrillView} from '../../../domain/grill/model';
import type {FieldKind} from '../../features/grill/grill-ui';

// ── Tabs ──

export interface GrillTabsProps {
    view: GrillView;
    place: number;
    onGo(place: number): void;
}

/** A tab per question, its bar drawn by its state and a dot for a revision's mark; then the review. */
export function GrillTabs({view, place, onGo}: GrillTabsProps): JSX.Element {
    const reviewing = place >= view.questions.length;
    return (
        <nav className="gc-tabs" aria-label="Questions">
            {view.questions.map((q, i) => {
                const tab = tabState(q);
                const current = i === place;
                return (
                    <button
                        key={i}
                        type="button"
                        tabIndex={-1}
                        className={`gc-tab is-${tab.state}` + (current ? ' is-current' : '')}
                        aria-current={current ? 'step' : undefined}
                        aria-label={`Question ${questionLabel(q)}, ${tab.state}${tab.mark ? `, ${tab.mark}` : ''}`}
                        onClick={() => onGo(i)}>
                        <span className="gc-tab-bar" aria-hidden="true" />
                        <span className="gc-tab-label">
                            {tab.mark && <span className="gc-mark" title={tab.mark} />}Q{questionLabel(q)}
                        </span>
                    </button>
                );
            })}
            <button
                type="button"
                tabIndex={-1}
                className={'gc-tab is-review' + (reviewing ? ' is-current' : '')}
                aria-current={reviewing ? 'step' : undefined}
                onClick={() => onGo(view.questions.length)}>
                <span className="gc-tab-bar" aria-hidden="true" />
                <span className="gc-tab-label">✓ Review</span>
            </button>
        </nav>
    );
}

// ── Review ──

export interface GrillReviewProps {
    view: GrillView;
    blockRef: Ref<HTMLDivElement>;
    onGo(place: number): void;
}

/** Every question with its answer and a way back to it, then what Claude will receive. */
export function GrillReview({view, blockRef, onGo}: GrillReviewProps): JSX.Element {
    const preview = reviewPreview(view);
    return (
        <div ref={blockRef} className="gc-review">
            <h1 className="gc-review-title">Review your answers</h1>
            <div className="gc-rows">
                {view.questions.map((q, i) => {
                    const flag = reviewFlag(q);
                    return (
                        <div key={i} className="gc-row">
                            <span className="gc-row-title">
                                {questionLabel(q)} · <InlineMarkdown text={q.title} />
                                {flag && <span className="gc-row-flag">{flag}</span>}
                            </span>
                            <span className="gc-row-answer">{answerLabel(q.answer)}</span>
                            <button type="button" tabIndex={-1} className="gc-row-change" onClick={() => onGo(i)}>
                                Change
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className="gc-label gc-preview-label">What Claude will receive</div>
            <pre className="gc-preview">{preview || 'Nothing answered yet'}</pre>
        </div>
    );
}

// ── The open field ──

const PLACEHOLDERS: Record<FieldKind, string> = {
    override: 'Your answer instead, ↵ for next',
    note: 'Note, ↵ for next',
    ask: 'What do you want to know? ↵ to ask',
};

export interface GrillFieldProps {
    kind: FieldKind;
    text: string;
    inputRef: Ref<HTMLTextAreaElement>;
    onType(text: string): void;
    onCommit(): void;
}

export function GrillFieldBox({kind, text, inputRef, onType, onCommit}: GrillFieldProps): JSX.Element {
    return (
        <div className="gc-field">
            <textarea
                ref={inputRef}
                className="gc-field-input"
                rows={kind === 'note' ? 1 : 3}
                placeholder={PLACEHOLDERS[kind]}
                aria-label={PLACEHOLDERS[kind]}
                spellCheck={false}
                autoCorrect="off"
                value={text}
                onChange={(e) => onType(e.target.value)}
            />
            <button type="button" tabIndex={-1} className="gc-btn" onClick={onCommit}>
                {kind === 'ask' ? 'Ask' : 'Next'} <kbd className="gc-kbd">↵</kbd>
            </button>
        </div>
    );
}

// ── Footer ──

export interface GrillFooterProps {
    view: GrillView;
    reviewing: boolean;
    /** How many inline choices the question on screen offers. */
    choices: number;
    allAnswered: boolean;
    error: string | null;
    onRest(): void;
    onSend(): void;
    onQueue(): void;
    onCancelQueue(): void;
}

/** Key hints on the left; Accept the rest and the send buttons on the right; a failed call's error under them. */
export function GrillFooter(props: GrillFooterProps): JSX.Element {
    const {view, reviewing, choices, allAnswered, error} = props;
    const group = sendGroup(view);
    return (
        <div className="gc-footer">
            <span className="gc-hints">
                {reviewing ? (
                    <Hint keys={['←']} does="back to the questions" />
                ) : (
                    <>
                        <Hint keys={['←', '→']} does="back · skip" />
                        {choices > 0 && <Hint keys={[choices > 1 ? `1–${choices}` : '1']} does="pick a choice" />}
                    </>
                )}
                <Hint keys={['T']} does="terminal" />
            </span>
            <span className="gc-send">
                {group === 'queued' ? (
                    <>
                        <span className="gc-queued">Sends once the agents are done</span>
                        <button type="button" tabIndex={-1} className="gc-btn is-ghost" onClick={props.onCancelQueue}>
                            Cancel
                        </button>
                        <SendButton label="Send now" onSend={props.onSend} />
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            tabIndex={-1}
                            className="gc-btn is-quiet"
                            disabled={allAnswered}
                            onClick={props.onRest}>
                            Accept the rest <kbd className="gc-kbd">A</kbd>
                        </button>
                        {group === 'research' && (
                            <button type="button" tabIndex={-1} className="gc-btn" onClick={props.onQueue}>
                                When research is done
                            </button>
                        )}
                        <SendButton label={group === 'research' ? 'Send now' : 'Send'} onSend={props.onSend} />
                    </>
                )}
            </span>
            {error && (
                <span className="gc-error" role="alert">
                    {error}
                </span>
            )}
        </div>
    );
}

function SendButton({label, onSend}: {label: string; onSend(): void}): JSX.Element {
    return (
        <button type="button" tabIndex={-1} className="gc-btn is-primary" onClick={onSend}>
            {label} <kbd className="gc-kbd">⌘↵</kbd>
        </button>
    );
}

function Hint({keys, does}: {keys: string[]; does: string}): JSX.Element {
    return (
        <span className="gc-hint">
            {keys.map((key) => (
                <kbd key={key} className="gc-kbd">
                    {key}
                </kbd>
            ))}
            {does}
        </span>
    );
}
