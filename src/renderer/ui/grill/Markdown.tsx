/**
 * A round's Markdown drawn as elements: a title's inline runs, or a reason's
 * paragraphs, lists, tables and code blocks (see `grill-markdown`). A PR link opens the
 * peek, any other web link the browser; the window itself never navigates.
 */
import {inlineMarkdown, markdownBlocks} from '../../features/grill/grill-markdown';
import type {JSX, MouseEvent} from 'react';
import type {Block, Inline} from '../../features/grill/grill-markdown';
import {openLink as followLink} from '../pr-view/actions';

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
                ) : block.kind === 'table' ? (
                    <Table key={i} table={block} />
                ) : block.kind === 'code' ? (
                    <pre key={i} className="gc-codeblock" data-lang={block.lang ?? undefined}>
                        <code>{block.text}</code>
                    </pre>
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

/** A wide table scrolls sideways in its own box rather than widening the card. */
function Table({table}: {table: Extract<Block, {kind: 'table'}>}): JSX.Element {
    const align = (i: number) => table.align[i] ?? undefined;
    return (
        <div className="gc-table">
            <table>
                <thead>
                    <tr>
                        {table.header.map((cell, i) => (
                            <th key={i} style={{textAlign: align(i)}}>
                                <Runs runs={cell} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row, r) => (
                        <tr key={r}>
                            {row.map((cell, i) => (
                                <td key={i} style={{textAlign: align(i)}}>
                                    <Runs runs={cell} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
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
    if (/^(https?:|mailto:)/i.test(href)) followLink(href);
}
