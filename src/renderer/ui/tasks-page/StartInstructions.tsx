/**
 * What Start session (S) asks first: any extra instructions for the new
 * session, added to its first prompt. Enter starts (with none, as before),
 * Shift+Enter is a new line, Esc puts it away. While there are VMs it also
 * asks "Do you want to hand this off to…?": Hand off to … starts it there.
 *
 * Under the task's row, or in its detail while that is open.
 */
import {useState, type JSX, type KeyboardEvent} from 'react';
import type {TaskRow} from '../../../domain/tasks/model';
import {dismissStart, startFromTask} from './actions';
import {useStore} from '../use-store';
import {StartWhereButtons} from '../session-handoff/StartWhereButtons';
import {handOffQuestion} from '../session-handoff/start-on-vm';
import type {HandoffHost} from '../../../application/services/project-handoff';

const NO_HOSTS: readonly HandoffHost[] = [];

export function StartInstructions({task}: {task: TaskRow}): JSX.Element {
    const [instructions, setInstructions] = useState('');
    const hosts = useStore((state) => state.handoff.hosts ?? NO_HOSTS);
    const start = (vm?: HandoffHost): void => void startFromTask(task, {instructions, ...(vm ? {vm} : {})});

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            start();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            dismissStart();
        }
    };

    return (
        // A click in here is the box's, not the row's: the row would take the keyboard back.
        <div
            className="tk-start tk-instructions"
            role="group"
            aria-label="Start session"
            onClick={(e) => e.stopPropagation()}>
            <textarea
                className="tk-instructions-input"
                rows={3}
                autoFocus
                placeholder="Any extra instructions? (optional)"
                aria-label="Extra instructions"
                value={instructions}
                spellCheck={false}
                onChange={(e) => setInstructions(e.target.value)}
                onKeyDown={onKeyDown}
            />
            {hosts.length > 0 && <span className="tk-start-text">{handOffQuestion(hosts)}</span>}
            <div className="tk-choices">
                <StartWhereButtons
                    hosts={hosts}
                    hereLabel={
                        <>
                            {hosts.length ? 'Start here' : 'Start session'} <kbd className="sw-kbd">↵</kbd>
                        </>
                    }
                    onHere={() => start()}
                    onVm={start}
                />
                <button type="button" className="sw-btn" onClick={dismissStart}>
                    Cancel <kbd className="sw-kbd">esc</kbd>
                </button>
            </div>
        </div>
    );
}
