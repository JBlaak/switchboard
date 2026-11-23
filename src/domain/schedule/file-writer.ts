/**
 * Writing a schedule file from the Schedule manager's settings.
 *
 * The file stays the schedule: the user, the slash command and other Claude
 * sessions write these too, so a save from the page changes only the keys the
 * page edits and keeps everything else as it was — keys Switchboard does not
 * know (`max-budget-usd`, `add-dirs`), comments, their order. The text is
 * what `support/frontmatter.ts` reads: `key: value` lines, one level of
 * nesting under a bare key, no quoting.
 */
import {SCHEDULE_COMMANDS_SUBPATH} from './schedule';
import type {ScheduleSettings} from './manager';

/** A frontmatter line: written as `key: value`, or left out when the value is null. */
type Line = readonly [key: string, value: string | null];

/** The top-level keys the page edits, in the order a new file has them. */
function topLevel(settings: ScheduleSettings, slug: string): Line[] {
    return [
        ['name', oneLine(settings.name)],
        ['slug', slug],
        ['cron', oneLine(settings.cron)],
        ['enabled', String(settings.enabled)],
        ['missed', settings.missed],
        ['limit-minutes', settings.limitMinutes === null ? null : String(settings.limitMinutes)],
        ['week-cap', settings.weekCap === null ? null : String(settings.weekCap)],
        ['worktree', String(settings.worktree)],
    ];
}

/** The `cli:` keys the page edits. */
function cliLines(settings: ScheduleSettings): Line[] {
    return [
        ['model', settings.model === null ? null : oneLine(settings.model) || null],
        ['permission-mode', oneLine(settings.permissionMode) || 'acceptEdits'],
        ['allowed-tools', oneLine(settings.allowedTools) || null],
    ];
}

const DEFAULT_INDENT = '  ';

/** A value the line grammar can hold: one line, trimmed. */
function oneLine(value: string): string {
    return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * A schedule's slug from its name: lower-case words joined by hyphens, only
 * letters and digits, at most 48 characters; '' when nothing usable is left.
 */
export function scheduleSlug(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '');
}

/** The file a schedule with this slug is saved as. */
export function scheduleFileName(slug: string): string {
    return `schedule-${slug}.md`;
}

/** Where that file lives under its project, as path parts to join onto the project. */
export function scheduleFileParts(slug: string): string[] {
    return [...SCHEDULE_COMMANDS_SUBPATH, scheduleFileName(slug)];
}

/**
 * The schedule file's text for these settings. With `existing`, that file's
 * text with the page's keys changed in place, and the keys and `cli:` entries
 * the page does not know kept; a key whose value is now null (no model, no
 * limit) is taken out.
 */
export function scheduleFileText(settings: ScheduleSettings, existing: string | null = null): string {
    const slug = scheduleSlug(settings.slug) || scheduleSlug(settings.name);
    const match = existing?.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?/);
    const frontmatter = match
        ? merge(match[1].split('\n'), topLevel(settings, slug), cliLines(settings))
        : fresh(topLevel(settings, slug), cliLines(settings));
    return `---\n${frontmatter.join('\n')}\n---\n\n${settings.prompt.trim()}\n`;
}

function written(lines: readonly Line[], indent = ''): string[] {
    return lines.filter(([, value]) => value !== null).map(([key, value]) => `${indent}${key}: ${value}`);
}

function fresh(top: readonly Line[], cli: readonly Line[]): string[] {
    return [...written(top), 'cli:', ...written(cli, DEFAULT_INDENT)];
}

/** How `parseFrontmatter` sees one line. */
type Parsed =
    | {kind: 'scalar'; key: string}
    | {kind: 'block'; key: string}
    | {kind: 'nested'; key: string; indent: string}
    | {kind: 'other'};

function classify(line: string, inBlock: boolean): Parsed {
    if (inBlock && /^\s+/.test(line) && line.includes(':')) {
        const m = /^(\s+)([^:]+):/.exec(line);
        return m ? {kind: 'nested', key: m[2].trim(), indent: m[1]} : {kind: 'other'};
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) return {kind: 'other'};
    return kv[2].trim() === '' ? {kind: 'block', key: kv[1].trim()} : {kind: 'scalar', key: kv[1].trim()};
}

/**
 * The existing frontmatter lines with the page's keys replaced where they
 * stand, dropped when null, and added where missing: top-level keys after
 * the last top-level one, `cli:` entries at the end of its block (a block
 * added at the end when there is none).
 */
function merge(lines: readonly string[], top: readonly Line[], cli: readonly Line[]): string[] {
    const topValues = new Map(top);
    const cliValues = new Map(cli);
    const seenTop = new Set<string>();
    const seenCli = new Set<string>();
    const out: string[] = [];
    let block: string | null = null;
    let cliIndent = DEFAULT_INDENT;
    let cliEnd = -1;
    let lastTop = -1;

    for (const line of lines) {
        const parsed = classify(line, block !== null);
        if (parsed.kind === 'nested') {
            if (block === 'cli' && !parsed.key.startsWith('#')) {
                cliIndent = parsed.indent;
                if (cliValues.has(parsed.key)) {
                    if (seenCli.has(parsed.key)) continue;
                    seenCli.add(parsed.key);
                    const value = cliValues.get(parsed.key)!;
                    if (value !== null) out.push(`${parsed.indent}${parsed.key}: ${value}`);
                    if (block === 'cli') cliEnd = out.length;
                    continue;
                }
            }
            out.push(line);
            if (block === 'cli') cliEnd = out.length;
            continue;
        }
        if (parsed.kind === 'other') {
            out.push(line);
            if (block === 'cli' && /^\s+/.test(line)) cliEnd = out.length;
            continue;
        }
        block = parsed.kind === 'block' ? parsed.key : null;
        if (block === 'cli') cliEnd = out.length + 1;
        if (parsed.kind === 'scalar' && topValues.has(parsed.key)) {
            if (seenTop.has(parsed.key)) continue;
            seenTop.add(parsed.key);
            const value = topValues.get(parsed.key)!;
            if (value !== null) {
                out.push(`${parsed.key}: ${value}`);
                lastTop = out.length;
            }
            continue;
        }
        out.push(line);
        if (parsed.kind === 'scalar') lastTop = out.length;
    }

    const missingCli = written(
        cli.filter(([key]) => !seenCli.has(key)),
        cliIndent,
    );
    const missingTop = written(top.filter(([key]) => !seenTop.has(key)));
    const topAt = lastTop >= 0 ? lastTop : 0;
    // The later place first, so the earlier one's index still holds.
    if (cliEnd < 0) {
        out.splice(topAt, 0, ...missingTop);
        if (missingCli.length > 0) out.push('cli:', ...missingCli);
    } else if (cliEnd >= topAt) {
        out.splice(cliEnd, 0, ...missingCli);
        out.splice(topAt, 0, ...missingTop);
    } else {
        out.splice(topAt, 0, ...missingTop);
        out.splice(cliEnd, 0, ...missingCli);
    }
    return out;
}
