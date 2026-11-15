/** The ×, for the Merge manager page's Close and its side views' close buttons. */
import type {JSX} from 'react';

export function CloseIcon(): JSX.Element {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    );
}
