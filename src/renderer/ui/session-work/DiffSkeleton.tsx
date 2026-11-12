import type {JSX} from 'react';
import {SKELETON_CARDS} from './support/diff-skeleton';

/**
 * While the diff loads: cards shaped like the file cards to come, a header
 * with a path and a counts pill over a few lines, a couple of them tinted as
 * an addition or a deletion. They rise in one after another and a soft
 * highlight sweeps across them (none of it under reduced motion). The work
 * page's diff and the PR peek both draw it.
 */
export function DiffSkeleton(): JSX.Element {
    return (
        <div className="sw-diff-skeleton" aria-hidden="true">
            {SKELETON_CARDS.map((card, i) => (
                <div key={i} className="sw-skel-file">
                    <div className="sw-skel-head">
                        <span className="sw-skel-bar" style={{width: `${card.path}%`}} />
                        <span className="sw-skel-bar sw-skel-counts" />
                    </div>
                    <div className="sw-skel-lines">
                        {card.lines.map((line, j) => (
                            <div key={j} className={'sw-skel-line is-' + line.kind}>
                                <span className="sw-skel-bar sw-skel-num" />
                                <span
                                    className="sw-skel-bar"
                                    style={{marginLeft: `${line.indent}ch`, width: `${line.width}%`}}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
