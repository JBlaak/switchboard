/**
 * The little Markdown a grilling round is written in, read into pieces the
 * card can draw as elements (never as HTML).
 *
 * A round's titles, reasons and recommendations are Claude's prose: code
 * spans, bold and italics inline, links, paragraphs split by blank lines, and
 * now and then a list. That is all this reads; anything else stays as text.
 */

export type Inline =
    | {kind: 'text'; text: string}
    | {kind: 'code'; text: string}
    | {kind: 'strong'; text: string}
    | {kind: 'em'; text: string}
    | {kind: 'link'; text: string; href: string};

export type Block =
    /** Lines of one paragraph, each drawn on its own line. */
    | {kind: 'paragraph'; lines: Inline[][]}
    | {kind: 'list'; ordered: boolean; items: Inline[][]};

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** One line of inline Markdown, as runs. */
export function inlineMarkdown(text: string): Inline[] {
    const out: Inline[] = [];
    let at = 0;
    for (const m of text.matchAll(INLINE)) {
        const start = m.index;
        if (start > at) out.push({kind: 'text', text: text.slice(at, start)});
        if (m[1] !== undefined) out.push({kind: 'code', text: m[1]});
        else if (m[2] !== undefined) out.push({kind: 'strong', text: m[2]});
        else if (m[3] !== undefined) out.push({kind: 'strong', text: m[3]});
        else if (m[4] !== undefined) out.push({kind: 'em', text: m[4]});
        else out.push({kind: 'link', text: m[5]!, href: m[6]!});
        at = start + m[0].length;
    }
    if (at < text.length) out.push({kind: 'text', text: text.slice(at)});
    return out;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/** A block of Markdown, as paragraphs and lists. */
export function markdownBlocks(text: string): Block[] {
    return text
        .trim()
        .split(/\n\s*\n/)
        .map((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''))
        .filter((lines) => lines.length > 0)
        .map((lines): Block => {
            if (lines.every((line) => BULLET.test(line)))
                return {kind: 'list', ordered: false, items: lines.map((l) => inlineMarkdown(l.replace(BULLET, '')))};
            if (lines.every((line) => NUMBERED.test(line)))
                return {kind: 'list', ordered: true, items: lines.map((l) => inlineMarkdown(l.replace(NUMBERED, '')))};
            return {kind: 'paragraph', lines: lines.map((line) => inlineMarkdown(line.trim()))};
        });
}
