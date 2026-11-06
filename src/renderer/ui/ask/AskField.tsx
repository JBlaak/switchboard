/**
 * The box and its choice list, as drawn: shared by the empty screen's box
 * (`AskBox`) and the Quick Ask pop-up (#148), which each bring their own
 * store, focus rules and keys. Under the box: the choice list, or Patch's
 * answer to a simple question.
 */
import {Fragment} from 'react';
import {answerBlocks} from './answer-blocks';
import type {JSX, KeyboardEvent, Ref} from 'react';
import type {AskState} from '../../state/ask-slice';

export interface AskFieldProps {
    ask: AskState;
    boxRef: Ref<HTMLTextAreaElement>;
    placeholder: string;
    ariaLabel: string;
    /** What the choice at `index` is called in the list. */
    choiceLabel(projectPath: string, index: number): string;
    /** The box took the focus. */
    onFocus?(): void;
    onChange(text: string): void;
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
    onHoverChoice(index: number): void;
    onPickChoice(index: number): void;
    /** What Esc does to Patch's answer, in its hint: put it away, or close the pop-up. */
    answerEscHint?: string;
}

export function AskField(props: AskFieldProps): JSX.Element {
    const {ask} = props;
    const locked = ask.phase !== 'editing';
    return (
        <div className={'ask' + (ask.phase === 'waiting' ? ' is-waiting' : '')}>
            <textarea
                ref={props.boxRef}
                className="ask-box"
                data-testid="ask-box"
                rows={1}
                placeholder={props.placeholder}
                aria-label={props.ariaLabel}
                aria-busy={ask.phase === 'waiting'}
                spellCheck={false}
                readOnly={locked}
                value={ask.text}
                onFocus={props.onFocus}
                onChange={(e) => props.onChange(e.target.value)}
                onKeyDown={props.onKeyDown}
            />
            {ask.phase === 'editing' && ask.answer && (
                <div className="ask-answer" data-testid="ask-answer">
                    <div className="ask-answer-text" role="status">
                        {answerBlocks(ask.answer).map((block, i) =>
                            block.kind === 'code' ? (
                                <pre key={i} className="ask-answer-code">
                                    {block.text}
                                </pre>
                            ) : (
                                <p key={i}>
                                    {block.lines.map((line, j) => (
                                        <Fragment key={j}>
                                            {j > 0 && <br />}
                                            {line.map((span, k) =>
                                                span.code ? <code key={k}>{span.text}</code> : span.text,
                                            )}
                                        </Fragment>
                                    ))}
                                </p>
                            ),
                        )}
                    </div>
                    <div className="ask-hints">
                        <span>
                            <kbd className="sw-kbd">⌘↵</kbd>start a session instead
                        </span>
                        <span>
                            <kbd className="sw-kbd">esc</kbd>
                            {props.answerEscHint ?? 'dismiss'}
                        </span>
                    </div>
                </div>
            )}
            {ask.phase === 'choosing' && (
                <div className="ask-choices" data-testid="ask-choices">
                    <div className="ask-choice-list" role="listbox" aria-label="Projects">
                        {ask.choices.map((projectPath, index) => (
                            <div
                                key={projectPath}
                                className={'ask-choice' + (index === ask.selected ? ' selected' : '')}
                                role="option"
                                aria-selected={index === ask.selected}
                                title={projectPath}
                                onMouseEnter={() => props.onHoverChoice(index)}
                                // Keep the focus, and the list's keys, in the box.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => props.onPickChoice(index)}>
                                {props.choiceLabel(projectPath, index)}
                            </div>
                        ))}
                    </div>
                    {ask.prompt && <p className="ask-prompt">{ask.prompt}</p>}
                    <div className="ask-hints">
                        <span>
                            <kbd className="sw-kbd">↵</kbd>start
                        </span>
                        <span>
                            <kbd className="sw-kbd">↑</kbd>
                            <kbd className="sw-kbd">↓</kbd>pick
                        </span>
                        <span>
                            <kbd className="sw-kbd">tab</kbd>all projects
                        </span>
                        <span>
                            <kbd className="sw-kbd">esc</kbd>edit
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
