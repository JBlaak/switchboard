/**
 * A round's Markdown drawn as elements: a title's inline runs, or a reason's
 * paragraphs and lists (see `grill-markdown`). A web link opens in the
 * browser; the window itself never navigates.
 */
import {inlineMarkdown, markdownBlocks} from '../../features/grill/grill-markdown';
import type {JSX, MouseEvent} from 'react';
import type {Inline} from '../../features/grill/grill-markdown';

export function InlineMarkdown({text}: {text: string}): JSX.Element {
    return <Runs runs={inlineMarkdown(text)} />;
}

export function BlockMarkdown({text, className}: {text: string; className?: string}): JSX.Element {
    return (
        <div className={className}>
            {markdownBlocks(text).map((block, i) =>
                block.kind === 'paragraph' ? (
                    <p key={i}>
                        {block.lines.map((line, j) => (
                            <span key={j}>
                                {j > 0 && <br />}
                                <Runs runs={line} />
                            </span>
                        ))}
                    </p>
                ) : block.ordered ? (
                    <ol key={i}>
                        {block.items.map((item, j) => (
                            <li key={j}>
                                <Runs runs={item} />
                            </li>
                        ))}
                    </ol>
                ) : (
                    <ul key={i}>
                        {block.items.map((item, j) => (
                            <li key={j}>
                                <Runs runs={item} />
                            </li>
                        ))}
                    </ul>
                ),
            )}
        </div>
    );
}

function Runs({runs}: {runs: Inline[]}): JSX.Element {
    return (
        <>
            {runs.map((run, i) => {
                switch (run.kind) {
                    case 'text':
                        return <span key={i}>{run.text}</span>;
                    case 'code':
                        return <code key={i}>{run.text}</code>;
                    case 'strong':
                        return <strong key={i}>{run.text}</strong>;
                    case 'em':
                        return <em key={i}>{run.text}</em>;
                    case 'link':
                        return (
                            <a key={i} href={run.href} onClick={(e) => openLink(e, run.href)}>
                                {run.text}
                            </a>
                        );
                }
            })}
        </>
    );
}

function openLink(e: MouseEvent, href: string): void {
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) void window.api.openExternal(href);
}
