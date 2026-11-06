/**
 * One question of a grilling round: its counter and title, what a revision
 * did to it, the reason (with its inline choices as rows to pick), Claude's
 * recommendation, Claude's explanation once the user asked, and the answer
 * given so far.
 */
import {answerLabel, pickedChoice, questionCounter, revisionNote} from '../../features/grill/grill-card';
import {BlockMarkdown, InlineMarkdown} from './Markdown';
import type {JSX, Ref} from 'react';
import type {GrillView} from '../../../domain/grill/model';

export interface GrillQuestionProps {
    view: GrillView;
    place: number;
    blockRef: Ref<HTMLDivElement>;
    onChoice(letter: string): void;
}

export function GrillQuestion({view, place, blockRef, onChoice}: GrillQuestionProps): JSX.Element | null {
    const q = view.questions[place];
    if (!q) return null;
    const note = revisionNote(q);
    const picked = pickedChoice(q);
    const asking = view.asking === place;

    return (
        <div ref={blockRef} className="gc-q">
            <div className="gc-head">
                <span className="gc-counter">{questionCounter(view, place)}</span>
                <h1 className="gc-title">
                    <InlineMarkdown text={q.title} />
                </h1>
            </div>
            {note && (
                <div className="gc-rev-note">
                    {note}
                    {q.mark === 'changed' && q.setAside && (
                        <span className="gc-aside">Your earlier answer, set aside: {answerLabel(q.setAside)}</span>
                    )}
                </div>
            )}
            <div className="gc-reason">
                {q.choices ? (
                    <>
                        {q.choices.lead.trim() && <BlockMarkdown text={q.choices.lead} />}
                        <ul className="gc-choices" role="group" aria-label="Choices">
                            {q.choices.list.map((choice, i) => {
                                const recommended = choice.letter === q.recommendedChoice;
                                return (
                                    <li key={choice.letter}>
                                        <button
                                            type="button"
                                            tabIndex={-1}
                                            className={
                                                'gc-choice' +
                                                (recommended ? ' is-recommended' : '') +
                                                (picked === choice.letter ? ' is-picked' : '')
                                            }
                                            aria-pressed={picked === choice.letter}
                                            onClick={() => onChoice(choice.letter)}>
                                            <span className="gc-badge" aria-hidden="true">
                                                {i + 1}
                                            </span>
                                            <span className="gc-choice-text">
                                                ({choice.letter}) <InlineMarkdown text={choice.text} />
                                            </span>
                                            {recommended && <span className="gc-tag">Recommended</span>}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                        {q.choices.after.trim() && <BlockMarkdown text={q.choices.after} />}
                    </>
                ) : (
                    <BlockMarkdown text={q.reason} />
                )}
            </div>
            <div className="gc-recbox">
                <div className="gc-label">Claude recommends</div>
                <BlockMarkdown text={q.recommendation} />
            </div>
            {asking ? (
                <div className="gc-explain is-waiting" role="status">
                    <div className="gc-label">You asked Claude</div>
                    <p>Claude is answering…</p>
                </div>
            ) : (
                q.explanation && (
                    <div className="gc-explain">
                        <div className="gc-label">Claude’s explanation</div>
                        <BlockMarkdown text={q.explanation} />
                    </div>
                )
            )}
            {q.answer && <div className="gc-answer-now">{answerLabel(q.answer)}</div>}
        </div>
    );
}
