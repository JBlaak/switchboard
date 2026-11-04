/**
 * The tool a session shows the user a page with: `show_page`, offered next to
 * `archive_session` on Switchboard's own MCP server.
 *
 * A long text is hard to read in a terminal font: a contract's clauses, a
 * report, a comparison. The session sends the text as an article body in HTML,
 * and Switchboard lays it over that session's terminal, typeset for reading,
 * until the user dismisses it (Esc) or a later call replaces it.
 *
 * The page is shown in a sandboxed frame: no scripts run in it and nothing is
 * loaded from the network (`readingDocument`'s CSP), so whatever the HTML
 * holds, it can only be looked at.
 */
import {ARCHIVE_TOOL_SERVER, type ArchiveToolOutcome, type McpPrompt, type McpTool} from './archive-tool';

export const PAGE_TOOL_NAME = 'show_page';
/** The tool's full name in the CLI, as `--allowedTools` takes it. */
export const PAGE_TOOL_QUALIFIED_NAME = `mcp__${ARCHIVE_TOOL_SERVER}__${PAGE_TOOL_NAME}`;

/** Longer titles are cut; the header has room for one line. */
const MAX_TITLE = 200;

export const PAGE_TOOL_DEFINITION: McpTool['definition'] = {
    name: PAGE_TOOL_NAME,
    title: 'Show a page in Switchboard',
    description:
        "Show the user a page to read inside Switchboard, laid over this session's terminal: a long text made " +
        'readable as an article, a report, a summary, a comparison. Use it when the user asks to see something ' +
        'as a page, or to make a text readable. Pass the article body as HTML: headings (h1 to h3), paragraphs, ' +
        'ordered and unordered lists, tables, blockquotes, code, <strong> and <em>. Leave out <html>, <head>, ' +
        "<style> and <script>: Switchboard typesets the page and follows the user's light or dark mode. Scripts " +
        'do not run and nothing is loaded from the network, so the HTML has to hold everything (images only as ' +
        'data: URLs). Links to http(s) pages open in the browser. When you restructure a text the user gave you, ' +
        'keep its wording: add headings, lists and emphasis, not words. The user dismisses the page with Esc and ' +
        'can bring it back from the terminal header; a new call replaces this session’s page. Carry on with your ' +
        'reply after calling it.',
    inputSchema: {
        type: 'object',
        properties: {
            title: {type: 'string', description: 'The page title, shown in its header. One line.'},
            html: {type: 'string', description: 'The article body, as HTML.'},
        },
        required: ['title', 'html'],
        additionalProperties: false,
    },
};

/**
 * When to use the tool, as the server's instructions. A session that lists the
 * tool only by name would otherwise answer "make this readable" some other
 * way: a published page, an HTML file.
 */
export const PAGE_TOOL_INSTRUCTIONS =
    'This session runs in Switchboard, a desktop app that can show the user a page right here, over this ' +
    `session's terminal, with the \`${PAGE_TOOL_NAME}\` tool (\`${PAGE_TOOL_QUALIFIED_NAME}\`). When the user ` +
    'asks to make a text readable, to see something as a page or an article, or to read something outside the ' +
    `terminal, call \`${PAGE_TOOL_NAME}\` with the text as HTML (load its schema first if it is deferred). Prefer it ` +
    'to publishing an artifact, writing an HTML file or opening a browser, unless the user asks for a link to ' +
    'share or a file to keep.';

/**
 * `/mcp__switchboard__show_page`: show what was just said as a page. It takes
 * no arguments, because the CLI splits a slash command's text on spaces, one
 * word per argument; the text to show is already in the conversation.
 */
export const PAGE_PROMPT: McpPrompt = {
    name: PAGE_TOOL_NAME,
    title: 'Show as a page',
    description: 'Show the latest text in this conversation as a readable page over the terminal',
    text:
        `Show the most recent text worth reading in this conversation as a page, with the \`${PAGE_TOOL_NAME}\` ` +
        `tool (\`${PAGE_TOOL_QUALIFIED_NAME}\`): the text I pasted last, or else your last long answer. Keep its ` +
        'wording; add structure only: headings, numbered or bulleted lists, emphasis for defined terms. Then tell me ' +
        'in one line that it is open.',
};

/** What a session asked to show. */
export interface PageInput {
    readonly title: string;
    readonly html: string;
}

/** A page as the window gets it: whose it is, and when it came. */
export interface ShownPage extends PageInput {
    readonly sessionId: string;
    readonly shownAt: number;
}

/** The tool call's arguments as a page, or why they are not one (the session reads it back). */
export function parsePageInput(args: unknown): {ok: true; page: PageInput} | {ok: false; error: string} {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return {ok: false, error: 'show_page needs a title and the page as html.'};
    }
    const {title, html} = args as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim() === '') {
        return {ok: false, error: 'show_page needs a title: one line for the page header.'};
    }
    if (typeof html !== 'string' || html.trim() === '') {
        return {ok: false, error: 'show_page needs the page body as html.'};
    }
    const line = title.replace(/\s+/g, ' ').trim();
    return {ok: true, page: {title: line.length > MAX_TITLE ? line.slice(0, MAX_TITLE - 1) + '…' : line, html}};
}

/** The tool as the MCP server offers it, calling `show` with a valid page. */
export function pageTool(show: (page: PageInput) => ArchiveToolOutcome): McpTool {
    return {
        definition: PAGE_TOOL_DEFINITION,
        instructions: PAGE_TOOL_INSTRUCTIONS,
        prompt: PAGE_PROMPT,
        call: (args) => {
            const parsed = parsePageInput(args);
            return parsed.ok ? show(parsed.page) : {ok: false, message: parsed.error};
        },
    };
}

/**
 * Nothing may run or load: no scripts, no fetches, no fonts or images from
 * outside, no form posts. Styles are inline, images only as data: URLs.
 */
export const READING_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * The whole document the frame shows: the session's body, wrapped in the
 * reading stylesheet and the CSP. The title is the frame's own; the page
 * header outside the frame shows it too.
 */
export function readingDocument(page: PageInput): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${READING_CSP}">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)}</title>
<style>${READING_STYLES}</style>
</head>
<body><article>
${page.html}
</article></body>
</html>`;
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/** Switchboard's palette (`_tokens.scss`), restated: the frame cannot see the window's custom properties. */
const READING_STYLES = `
:root {
    --bg: #141517; --text: #d9d7d2; --strong: #ecebe8; --muted: #a09e99; --line: #2e2f33;
    --raised: #1c1d20; --accent: #8fd8bf; --mark: rgba(240, 207, 126, 0.25);
}
@media (prefers-color-scheme: light) {
    :root {
        --bg: #fafbfd; --text: #262a31; --strong: #16181d; --muted: #626b78; --line: #e3e8ef;
        --raised: #f0f3f8; --accent: #1c6e56; --mark: rgba(240, 207, 126, 0.45);
    }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--text); -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 40px 32px 96px; }
article {
    max-width: 68ch; margin: 0 auto;
    font: 18px/1.65 Charter, 'Iowan Old Style', 'Source Serif Pro', Georgia, serif;
    font-kerning: normal; hyphens: auto; overflow-wrap: break-word;
}
h1, h2, h3, h4 {
    font-family: system-ui, -apple-system, sans-serif; color: var(--strong);
    line-height: 1.25; letter-spacing: -0.01em; margin: 2em 0 0.6em; scroll-margin-top: 24px;
}
h1 { font-size: 1.9em; margin-top: 0.4em; }
h2 { font-size: 1.35em; padding-top: 1.2em; border-top: 1px solid var(--line); }
h3 { font-size: 1.1em; }
h4 { font-size: 1em; }
p { margin: 0 0 1em; }
ol, ul { margin: 0 0 1em; padding-left: 1.6em; }
li { margin: 0.3em 0; }
li > ol, li > ul { margin: 0.3em 0; }
strong { color: var(--strong); }
a { color: var(--accent); text-underline-offset: 2px; }
mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; }
blockquote {
    margin: 1.2em 0; padding: 0.2em 1.1em; border-left: 3px solid var(--accent);
    background: var(--raised); border-radius: 0 8px 8px 0; color: var(--text);
}
code, pre { font-family: 'SF Mono', Menlo, monospace; font-size: 0.85em; }
code { background: var(--raised); padding: 0.1em 0.35em; border-radius: 4px; }
pre { background: var(--raised); padding: 14px 16px; border-radius: 8px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: 0.9em; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-family: system-ui, -apple-system, sans-serif; font-size: 0.85em; color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
img { max-width: 100%; height: auto; }
dl { margin: 0 0 1em; }
dt { font-weight: 600; color: var(--strong); margin-top: 0.8em; }
dd { margin: 0.2em 0 0 1.2em; }
`;
