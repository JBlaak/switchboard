/**
 * The rules behind a schedule's form: the choices it offers, what a blank or
 * copied schedule starts as, the slug a name makes, the allowed tools as
 * chips plus free text, and what stops one from being saved.
 *
 * The create form and a schedule's page share them, so both edit the same
 * `ScheduleSettings` the same way.
 */
import {cronProblem} from './presets';
import type {ScheduleSettings} from './manager';

/** The tools offered as chips, in the order they are shown and written. */
export const SCHEDULE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const;

/** The models the form offers; null is the CLI's own default. */
export const SCHEDULE_MODELS: readonly {readonly value: string | null; readonly label: string}[] = [
    {value: null, label: 'Default'},
    {value: 'sonnet', label: 'Sonnet'},
    {value: 'opus', label: 'Opus'},
    {value: 'haiku', label: 'Haiku'},
];

/** The permission modes a run can take, Accept edits first: nobody is there to answer a prompt. */
export const SCHEDULE_PERMISSION_MODES: readonly {readonly value: string; readonly label: string}[] = [
    {value: 'acceptEdits', label: 'Accept edits'},
    {value: 'auto', label: 'Auto'},
    {value: 'dontAsk', label: "Don't ask (only the allowed tools)"},
    {value: 'plan', label: 'Plan (read-only)'},
    {value: 'bypassPermissions', label: 'Bypass (every tool)'},
    {value: 'default', label: 'Default'},
];

/** What "Write it myself" starts from: nightly at 03:00 in a worktree, with room to work and a cap on the week. */
export function blankScheduleSettings(projectPath: string): ScheduleSettings {
    return {
        name: '',
        slug: '',
        projectPath,
        cron: '0 3 * * *',
        enabled: true,
        prompt: '',
        model: null,
        permissionMode: 'acceptEdits',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        limitMinutes: 30,
        weekCap: 80,
        missed: 'run-once',
        worktree: true,
    };
}

/**
 * A copy of a schedule to start a new one from: the same settings under a new
 * name and a slug no schedule in its project has yet, turned on.
 */
export function copyScheduleSettings(source: ScheduleSettings, takenSlugs: ReadonlySet<string>): ScheduleSettings {
    const name = `${source.name} copy`;
    return {...source, name, slug: uniqueSlug(scheduleSlug(name), takenSlugs), enabled: true};
}

/** The file slug a name makes: lower-case words joined by dashes, at most 48 characters. */
export function scheduleSlug(name: string): string {
    const slug = name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '');
    return slug || 'schedule';
}

/** `slug`, or `slug-2`, `slug-3`, … when it is taken. */
export function uniqueSlug(slug: string, taken: ReadonlySet<string>): string {
    if (!taken.has(slug)) return slug;
    for (let n = 2; ; n++) {
        if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
    }
}

/** Where a schedule's file is saved, relative to its project. */
export function scheduleFileHint(slug: string): string {
    return `.claude/commands/schedule-${slug || 'schedule'}.md`;
}

/**
 * The allowed tools as the form shows them: the chips that are on, in their
 * own order, and every other rule (`Bash(git:*)`, an MCP tool) as free text.
 */
export function splitAllowedTools(allowed: string): {tools: string[]; extra: string} {
    const rules = splitRules(allowed);
    const known = new Set<string>(SCHEDULE_TOOLS);
    return {
        tools: SCHEDULE_TOOLS.filter((tool) => rules.includes(tool)),
        extra: rules.filter((rule) => !known.has(rule)).join(', '),
    };
}

/** The allowed tools from the chips that are on and the free text, as `--allowedTools` takes them. */
export function joinAllowedTools(tools: readonly string[], extra: string): string {
    const known = SCHEDULE_TOOLS.filter((tool) => tools.includes(tool));
    const others = splitRules(extra).filter((rule) => !known.includes(rule as never));
    return [...known, ...others].join(',');
}

/** The allowed tools with one chip turned on or off. */
export function toggleAllowedTool(allowed: string, tool: string): string {
    const {tools, extra} = splitAllowedTools(allowed);
    const next = tools.includes(tool) ? tools.filter((t) => t !== tool) : [...tools, tool];
    return joinAllowedTools(next, extra);
}

/** What keeps the settings from being saved, in a few words; null when they can be. */
export function scheduleSettingsProblem(settings: ScheduleSettings): string | null {
    if (!settings.name.trim()) return 'Give it a name';
    if (!settings.projectPath) return 'Pick a project';
    if (!settings.prompt.trim()) return 'Say what it should do in the prompt';
    const cron = cronProblem(settings.cron);
    if (cron) return cron;
    if (settings.limitMinutes !== null && !(Number.isInteger(settings.limitMinutes) && settings.limitMinutes > 0)) {
        return 'The time limit is a whole number of minutes';
    }
    if (settings.weekCap !== null && !(settings.weekCap > 0 && settings.weekCap <= 100)) {
        return 'The week cap is a percentage from 1 to 100';
    }
    return null;
}

/** Comma-separated rules, keeping commas inside parentheses (`Bash(a,b)`) in their rule. */
function splitRules(text: string): string[] {
    const rules: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of text) {
        if (char === '(') depth++;
        if (char === ')') depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) {
            rules.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    rules.push(current);
    return rules.map((rule) => rule.trim()).filter(Boolean);
}
