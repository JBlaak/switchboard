/**
 * The rows of the question on screen: one button per option, then Other with
 * its text field.
 *
 * A row's check pops as it becomes selected, never when it is first drawn
 * selected — a question coming (back) on screen was not just answered. Rows
 * are keyed per question by their parent, so a new question draws new rows.
 */
import { useLayoutEffect, useRef } from 'react';
import { displayLabel, isRecommended } from '../../../domain/questions/answer-draft';
import { popMark } from '../../features/questions/question-motion';
import type { JSX, Ref } from 'react';
import type { QuestionOption } from '../../../domain/questions/question';

export interface OptionRowProps {
  option: QuestionOption;
  index: number;
  selected: boolean;
  cursor: boolean;
  onClick(): void;
}

export function OptionRow({ option, index, selected, cursor, onClick }: OptionRowProps): JSX.Element {
  const mark = usePop(selected);
  return (
    <button
      type="button"
      className={rowClass('qp-option', selected, cursor)}
      tabIndex={-1}
      data-row={String(index)}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="qp-key" aria-hidden="true">{String(index + 1)}</span>
      <span className="qp-option-text">
        <span className="qp-option-line">
          <span className="qp-option-label">{displayLabel(option.label)}</span>
          {isRecommended(option.label) && <span className="qp-chip">Recommended</span>}
        </span>
        {option.description && <span className="qp-option-desc">{option.description}</span>}
      </span>
      <Mark ref={mark} />
    </button>
  );
}

export interface OtherRowProps {
  /** Its row number, 0-based: one past the last option. */
  index: number;
  text: string;
  cursor: boolean;
  inputRef: Ref<HTMLInputElement>;
  onFocus(): void;
  onType(text: string): void;
}

export function OtherRow({ index, text, cursor, inputRef, onFocus, onType }: OtherRowProps): JSX.Element {
  const selected = text.trim() !== '';
  const mark = usePop(selected);
  return (
    <label className={rowClass('qp-option qp-other', selected, cursor)}>
      <span className="qp-key" aria-hidden="true">{String(index + 1)}</span>
      <span className="qp-option-label">Other</span>
      <input
        ref={inputRef}
        className="qp-other-input"
        type="text"
        placeholder="Type your own answer…"
        aria-label="Other answer"
        value={text}
        onFocus={onFocus}
        onChange={e => onType(e.currentTarget.value)}
      />
      <Mark ref={mark} />
    </label>
  );
}

function rowClass(base: string, selected: boolean, cursor: boolean): string {
  return base + (selected ? ' is-selected' : '') + (cursor ? ' is-cursor' : '');
}

/** The mark's element, which pops when `selected` turns on after the first draw. */
function usePop(selected: boolean): React.RefObject<HTMLSpanElement | null> {
  const mark = useRef<HTMLSpanElement>(null);
  const was = useRef(selected);
  useLayoutEffect(() => {
    if (selected && !was.current) {
      const svg = mark.current?.querySelector<SVGElement>('svg');
      if (svg) popMark(svg as unknown as HTMLElement);
    }
    was.current = selected;
  }, [selected]);
  return mark;
}

function Mark({ ref }: { ref: Ref<HTMLSpanElement> }): JSX.Element {
  return (
    <span ref={ref} className="qp-mark" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
    </span>
  );
}
