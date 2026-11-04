/**
 * A page a session showed the user (`show_page`), laid over that session's
 * terminal, rendered into #terminals.
 *
 * Like the question panel it is a sibling of the terminal containers, never a
 * child of one: the xterm stays mounted and sized underneath. It steps aside
 * while the question panel is up, because a session blocked on questions
 * needs answering more than its page needs reading.
 *
 * The page itself is a sandboxed frame, scripts off (`sandbox` without
 * `allow-scripts`) and nothing loaded from outside (the CSP in
 * `readingDocument`). Same-origin is allowed, but only so this side can reach
 * into the frame's document: to hear Esc, to send links to the browser, and
 * to read its headings for the outline.
 */
import {useCallback, useMemo, useRef, useState} from 'react';
import {readingDocument} from '../../../domain/session/page-tool';
import {dispatch} from '../../state/app-store';
import {openPage} from '../../state/pages-slice';
import {focusTerminal} from '../questions/actions';
import {useOnScreen} from '../questions/use-on-screen';
import {useStore} from '../use-store';
import type {JSX, KeyboardEvent as ReactKeyboardEvent} from 'react';
import type {SessionPage} from '../../state/pages-slice';

/** An outline needs a few headings to be worth its room. */
const MIN_OUTLINE = 3;

interface OutlineEntry {
    id: string;
    text: string;
    level: 2 | 3;
}

export function ReadingPage(): JSX.Element | null {
    const screen = useOnScreen();
    const page = useStore((s) => (screen.open ? openPage(s.pages, screen.sessionId) : null));
    if (!page || !screen.sessionId || screen.up) return null;
    // Keyed by arrival, so a page that replaces another starts at its top.
    return <ReadingSheet key={`${screen.sessionId}:${page.shownAt}`} sessionId={screen.sessionId} page={page} />;
}

function ReadingSheet({sessionId, page}: {sessionId: string; page: SessionPage}): JSX.Element {
    const frame = useRef<HTMLIFrameElement>(null);
    const [outline, setOutline] = useState<OutlineEntry[]>([]);
    const srcDoc = useMemo(() => readingDocument(page), [page.title, page.html]);

    const close = useCallback(() => {
        dispatch({type: 'pageClosed', sessionId});
        focusTerminal();
    }, [sessionId]);

    const onLoad = useCallback(() => {
        const doc = frame.current?.contentDocument;
        if (!doc) return;
        doc.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault();
                close();
            }
        });
        doc.addEventListener('click', (event) => followLink(doc, event));
        setOutline(readOutline(doc));
        // The keyboard goes to the page, so arrows and space scroll it and Esc closes it.
        frame.current?.contentWindow?.focus();
    }, [close]);

    const onKeyDown = (event: ReactKeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };

    const jumpTo = (id: string): void => {
        frame.current?.contentDocument?.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
    };

    return (
        <section className="reading-page" role="dialog" aria-label={page.title} onKeyDown={onKeyDown}>
            <header className="rp-header">
                <PageIcon />
                <h2 className="rp-title" title={page.title}>
                    {page.title}
                </h2>
                <button type="button" className="sw-btn rp-close" onClick={close}>
                    Back to terminal<kbd className="qh-kbd">esc</kbd>
                </button>
            </header>
            <div className="rp-body">
                {outline.length >= MIN_OUTLINE && (
                    <nav className="rp-outline" aria-label="Outline">
                        {outline.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={`rp-outline-item level-${entry.level}`}
                                onClick={() => jumpTo(entry.id)}>
                                {entry.text}
                            </button>
                        ))}
                    </nav>
                )}
                <iframe
                    ref={frame}
                    className="rp-frame"
                    title={page.title}
                    sandbox="allow-same-origin"
                    srcDoc={srcDoc}
                    onLoad={onLoad}
                />
            </div>
        </section>
    );
}

/**
 * A link in the page: an in-page anchor scrolls there, an http(s) or mailto
 * link opens in the browser, and anything else goes nowhere. The frame never
 * navigates away from the page.
 */
function followLink(doc: Document, event: MouseEvent): void {
    // The target belongs to the frame's realm, so `instanceof Element` would not hold.
    const target = event.target as {closest?: (selector: string) => Element | null} | null;
    const anchor = target?.closest?.('a[href]');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
        const id = safeDecode(href.slice(1));
        doc.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
        return;
    }
    if (/^(https?:|mailto:)/i.test(href)) void window.api.openExternal(href);
}

/** The page's h2 and h3 headings, each given an id to jump to if it had none. */
function readOutline(doc: Document): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    doc.querySelectorAll('h2, h3').forEach((heading, index) => {
        const text = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (!heading.id) heading.id = `section-${index + 1}`;
        entries.push({id: heading.id, text, level: heading.tagName === 'H2' ? 2 : 3});
    });
    return entries;
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

export function PageIcon(): JSX.Element {
    return (
        <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" />
            <path d="M9.25 1.75V4.75h3" />
            <path d="M6 8h4.25M6 10.5h4.25" />
        </svg>
    );
}
