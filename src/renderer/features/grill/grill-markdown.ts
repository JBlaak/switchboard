/**
 * The little Markdown a grilling round is written in, read into pieces the
 * card can draw as elements (never as HTML).
 *
 * A round's titles, reasons and recommendations are Claude's prose: code
 * spans, bold and italics inline, links, paragraphs split by blank lines, and
 * now and then a list or a table. That is all this reads; anything else stays
 * as text.
 */

export type Inline =
    | {kind: 'text'; text: string}
    | {kind: 'code'; text: string}
    | {kind: 'strong'; text: string}
    | {kind: 'em'; text: string}
    | {kind: 'link'; text: string; href: string};

export type Align = 'left' | 'center' | 'right' | null;

/** A paragraph (its lines, each drawn on a line of its own), a list or a table. */
export type Block =
    | {kind: 'paragraph'; lines: Inline[][]}
    | {kind: 'list'; ordered: boolean; items: Inline[][]}
    | {kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][]};

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

/** A block of Markdown, as paragraphs, lists and tables. */
export function markdownBlocks(text: string): Block[] {
    return text
        .trim()
        .split(/\n\s*\n/)
        .map((chunk) => chunk.split('\n').filter((line) => line.trim() !== ''))
        .filter((lines) => lines.length > 0)
        .flatMap(chunkBlocks);
}

/** A chunk's lines, with any table in it lifted out between what comes before and after. */
function chunkBlocks(lines: string[]): Block[] {
    const start = lines.findIndex((line, i) => i + 1 < lines.length && isTableStart(line, lines[i + 1]!));
    if (start < 0) return [linesBlock(lines)];
    let end = start + 2;
    while (end < lines.length && lines[end]!.includes('|')) end++;
    const before = lines.slice(0, start);
    return [
        ...(before.length > 0 ? [linesBlock(before)] : []),
        tableBlock(lines.slice(start, end)),
        ...(end < lines.length ? chunkBlocks(lines.slice(end)) : []),
    ];
}

function linesBlock(lines: string[]): Block {
    if (lines.every((line) => BULLET.test(line)))
        return {kind: 'list', ordered: false, items: lines.map((l) => inlineMarkdown(l.replace(BULLET, '')))};
    if (lines.every((line) => NUMBERED.test(line)))
        return {kind: 'list', ordered: true, items: lines.map((l) => inlineMarkdown(l.replace(NUMBERED, '')))};
    return {kind: 'paragraph', lines: lines.map((line) => inlineMarkdown(line.trim()))};
}

const DIVIDER = /^\s*:?-+:?\s*$/;

/** A header row with pipes, under it a divider row (`|---|:-:|`) with as many cells. */
function isTableStart(header: string, divider: string): boolean {
    if (!header.includes('|') || !divider.includes('|')) return false;
    const dividers = cells(divider);
    return dividers.every((cell) => DIVIDER.test(cell)) && dividers.length === cells(header).length;
}

function tableBlock(lines: string[]): Block {
    const header = cells(lines[0]!);
    const align = cells(lines[1]!).map((cell): Align => {
        const c = cell.trim();
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        if (c.startsWith(':')) return 'left';
        return null;
    });
    const rows = lines.slice(2).map((line) => {
        const row = cells(line);
        return header.map((_, i) => inlineMarkdown(row[i] ?? ''));
    });
    return {kind: 'table', align, header: header.map(inlineMarkdown), rows};
}

/** A row's cells: split on pipes outside code spans (`\|` keeps one), the outer pipes dropped. */
function cells(line: string): string[] {
    const out: string[] = [];
    let cell = '';
    let inCode = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === '\\' && line[i + 1] === '|') {
            cell += '|';
            i++;
        } else if (ch === '`') {
            inCode = !inCode;
            cell += ch;
        } else if (ch === '|' && !inCode) {
            out.push(cell.trim());
            cell = '';
        } else cell += ch;
    }
    out.push(cell.trim());
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) out.shift();
    if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) out.pop();
    return out;
}
