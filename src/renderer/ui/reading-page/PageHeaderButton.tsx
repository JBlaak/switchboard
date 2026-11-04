/**
 * The terminal header's way back to a page put away: shown while the session
 * on screen has a page and it is not laid over the terminal. While the page
 * is up, its own header has the way out.
 */
import {dispatch} from '../../state/app-store';
import {useStore} from '../use-store';
import {PageIcon} from './ReadingPage';
import type {JSX} from 'react';

export function PageHeaderButton({sessionId}: {sessionId: string}): JSX.Element | null {
    const page = useStore((s) => s.pages.bySession[sessionId]);
    if (!page || page.open) return null;
    return (
        <button
            type="button"
            className="sw-btn rp-reopen"
            title={`Show “${page.title}” again`}
            onClick={() => dispatch({type: 'pageReopened', sessionId})}>
            <PageIcon />
            Page
        </button>
    );
}
