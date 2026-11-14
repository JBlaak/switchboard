/**
 * An errand's kind at a glance: a wrench for a fix, a paper plane for a
 * nudge. Drawn in `currentColor`, so the place that shows it decides the ink
 * (red while the errand needs you).
 */
import type {JSX} from 'react';
import type {ErrandKind} from '../../../domain/session/errand-shelf';

export function ErrandGlyph({kind, className}: {kind: ErrandKind; className?: string}): JSX.Element {
    return (
        <svg
            className={className}
            data-kind={kind}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            {kind === 'fix' ? (
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            ) : (
                <>
                    <path d="M22 2 15 22l-4-9-9-4z" />
                    <path d="M22 2 11 13" />
                </>
            )}
        </svg>
    );
}
