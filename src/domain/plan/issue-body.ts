/**
 * What the Plan tab's detail panel shows of an issue's body (D4): a short
 * summary and its acceptance criteria.
 */

const SUMMARY_LIMIT = 320;

const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const FENCE = /^\s{0,3}(```|~~~)/;
const LIST = /^\s*([-*+]|\d+[.)])\s/;
const TABLE = /^\s*\|/;
const PART_OF = /^\s*part of\b/i;
const WHAT_TO_BUILD = /^\s{0,3}#{1,6}\s+what to build\s*#*\s*$/i;
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

/** A run of lines between blank lines, headings and code fences. */
interface Block { lines: string[]; heading: boolean; code: boolean }

function blocksOf(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ lines: paragraph, heading: false, code: false });
    paragraph = [];
  };
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code = [line];
      while (++i < lines.length && !FENCE.test(lines[i])) code.push(lines[i]);
      blocks.push({ lines: code, heading: false, code: true });
    } else if (HEADING.test(line)) {
      flush();
      blocks.push({ lines: [line], heading: true, code: false });
    } else if (line.trim() === '') {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** A block of plain prose: not a list, a table, an HTML comment or a "Part of …" line. */
function isProse(block: Block): boolean {
  if (block.heading || block.code) return false;
  const first = block.lines[0];
  return !LIST.test(first) && !TABLE.test(first) && !PART_OF.test(first) && !first.trim().startsWith('<!--');
}

function plainText(lines: string[]): string {
  const text = lines.map((line) => line.trim()).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  const cut = text.slice(0, SUMMARY_LIMIT - 1);
  const space = cut.lastIndexOf(' ');
  return (space > SUMMARY_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '') + '…';
}

/**
 * The summary is the first paragraph under `## What to build` when there is
 * one, else the first prose paragraph. The acceptance criteria are every
 * `- [ ]` / `- [x]` line, in order.
 */
export function summariseIssueBody(body: string): { summary: string; acceptance: { text: string; done: boolean }[] } {
  const blocks = blocksOf(body);
  let chosen: Block | undefined;
  const whatToBuild = blocks.findIndex((block) => block.heading && WHAT_TO_BUILD.test(block.lines[0]));
  if (whatToBuild !== -1) {
    for (const block of blocks.slice(whatToBuild + 1)) {
      if (block.heading) break;
      if (isProse(block)) { chosen = block; break; }
    }
  }
  chosen ??= blocks.find(isProse);

  const acceptance: { text: string; done: boolean }[] = [];
  let inCode = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inCode = !inCode;
    if (inCode) continue;
    const match = CHECKBOX.exec(line);
    if (match) acceptance.push({ text: match[2].trim(), done: match[1] !== ' ' });
  }

  return { summary: chosen ? plainText(chosen.lines) : '', acceptance };
}
