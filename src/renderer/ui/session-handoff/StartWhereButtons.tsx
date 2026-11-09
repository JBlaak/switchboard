/**
 * The answers to "Do you want to hand this off to…?" on a start that asks it
 * (an issue's, a task's, a level's): the start here first, under its own
 * label and primary (it is what Enter does where the start takes Enter), then
 * one Hand off to … per VM. Drawn inside the confirmation the start already
 * has, next to its Cancel.
 */
import type {JSX, ReactNode} from 'react';
import type {HandoffHost} from '../../../application/services/project-handoff';

export function StartWhereButtons({
    hosts,
    hereLabel,
    onHere,
    onVm,
}: {
    hosts: readonly HandoffHost[];
    hereLabel: ReactNode;
    onHere(): void;
    onVm(host: HandoffHost): void;
}): JSX.Element {
    return (
        <>
            <button type="button" className="sw-btn is-primary" onClick={onHere}>
                {hereLabel}
            </button>
            {hosts.map((host) => (
                <button type="button" key={host.key} className="sw-btn" onClick={() => onVm(host)}>
                    {'Hand off to ' + host.label}
                </button>
            ))}
        </>
    );
}
