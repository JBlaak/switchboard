/**
 * The box and its choice list, as drawn: shared by the empty screen's box
 * (`AskBox`) and the Quick Ask pop-up (#148), which each bring their own
 * store, focus rules and keys.
 */
import type { JSX, KeyboardEvent, Ref } from 'react';
import type { AskState } from '../../state/ask-slice';

export interface AskFieldProps {
  ask: AskState;
  boxRef: Ref<HTMLTextAreaElement>;
  placeholder: string;
  ariaLabel: string;
  /** What the choice at `index` is called in the list. */
  choiceLabel(projectPath: string, index: number): string;
  onChange(text: string): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
  onHoverChoice(index: number): void;
  onPickChoice(index: number): void;
}

export function AskField(props: AskFieldProps): JSX.Element {
  const { ask } = props;
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
        onChange={e => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
      />
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
                onMouseDown={e => e.preventDefault()}
                onClick={() => props.onPickChoice(index)}
              >
                {props.choiceLabel(projectPath, index)}
              </div>
            ))}
          </div>
          {ask.prompt && <p className="ask-prompt">{ask.prompt}</p>}
          <div className="ask-hints">
            <span><kbd className="sw-kbd">↵</kbd>start</span>
            <span><kbd className="sw-kbd">↑</kbd><kbd className="sw-kbd">↓</kbd>pick</span>
            <span><kbd className="sw-kbd">tab</kbd>all projects</span>
            <span><kbd className="sw-kbd">esc</kbd>edit</span>
          </div>
        </div>
      )}
    </div>
  );
}
