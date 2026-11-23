/**
 * Claude drafting a schedule for the create form, from a sentence ("tidy the
 * changelog every night") or from a session the user wants repeated.
 *
 * One `claude -p` call to Sonnet, like the Issue manager's polish: no tools,
 * no settings, no MCP servers, and the answer as bare JSON that is checked
 * here. Sonnet rather than Haiku because the prompt it writes is what runs
 * unattended at 03:00, with nobody to ask: it has to say what to skip, when to
 * stop and what to report, and a weak one costs a night's run.
 *
 * Claude fills what needs judgement (the prompt, the time, the name, the
 * tools, the project); the rest are the defaults a scheduled run starts from.
 */
import {failureLine, parseEnvelope} from '../ask/route';
import {isValidCron} from './next-run';
import {scheduleSlug} from './file-writer';
import type {ClaudeRun} from '../ask/route';
import type {ScheduleDraft, ScheduleDraftResult, ScheduleSettings} from './manager';

/** The settings Claude does not choose. */
export const DRAFT_DEFAULTS = {
    enabled: true,
    model: null,
    permissionMode: 'acceptEdits',
    limitMinutes: 30,
    weekCap: 80,
    missed: 'run-once',
    worktree: true,
} as const satisfies Partial<ScheduleSettings>;

/** One of the user's schedules, for spreading a new one away from it. */
export interface ExistingSchedule {
    readonly name: string;
    readonly cron: string;
    readonly projectPath: string;
}

/** A project Claude may put the schedule in. */
export interface DraftProject {
    readonly projectPath: string;
    /** Its latest sessions' names, to tell what it is. */
    readonly recentTitles: readonly string[];
}

/** What a draft is asked from. */
export interface DraftRequest {
    /** The user's sentence, or the conversation of the session to repeat. */
    readonly ask:
        {readonly kind: 'sentence'; readonly text: string} | {readonly kind: 'session'; readonly conversation: string};
    /** The project it runs in when already known; else Claude picks one of `projects`. */
    readonly projectPath: string | null;
    readonly projects: readonly DraftProject[];
    readonly existing: readonly ExistingSchedule[];
}

export const DRAFT_SYSTEM_PROMPT = [
    "You draft a scheduled job for Switchboard. It runs Claude Code headless (`claude -p`) on a cron, mostly at night, on the user's own Claude subscription, in a fresh git worktree of one project.",
    '',
    'Answer with one JSON object and nothing else, with exactly these keys:',
    '- "name": a short human name, 2 to 5 words ("Nightly dependency check").',
    '- "slug": kebab-case, from the name.',
    '- "cron": a five-field cron in local time. Only `*`, `*/n`, numbers, lists (`1,3,5`) and ranges (`1-5`); weekdays are 0-6 with Sunday 0.',
    '- "whenReason": a few words on why that time ("\\"every night\\"; 03:20 because nothing else runs then").',
    '- "prompt": the instructions the job runs on.',
    '- "allowedTools": the fewest Claude Code tools it needs, comma-separated as `--allowedTools` takes them (for example `Read,Grep,Glob,Edit,Bash(git status:*),Bash(npm test:*)`). Leave out anything it does not need; prefer narrow Bash patterns over `Bash`.',
    '- "projectPath": the project it runs in, exactly as listed, or null when none of them fits.',
    '',
    'The prompt runs with nobody to ask. Write it so that it:',
    '- says exactly what to do and in which order, and what to leave alone or skip;',
    '- never waits on a question: when something is unclear or risky, it skips that part and says so;',
    '- says when to stop: when the work is done, or when there is nothing to do (then it stops at once);',
    '- ends with a short report of what it did, what it skipped and why, and anything the user should look at.',
    'Write the prompt in the second person, plainly, in the language the user wrote in.',
    '',
    'Pick the time from what the user asked. A job that runs "every night" or "nightly" goes between 02:00 and 05:00, at a minute that is not a round hour, spread away from the times of the existing schedules so two jobs do not start together. Run during the day only when the user asked for it.',
].join('\n');

/** The text sent with the system prompt: the ask, the projects and the existing schedules. */
export function draftPrompt(request: DraftRequest): string {
    const ask =
        request.ask.kind === 'sentence'
            ? ['<request>', request.ask.text.trim(), '</request>']
            : [
                  'The user wants a schedule that repeats what this session did. First work out what they asked for and what was done, then draft a job that does that again on its own each time.',
                  '<session>',
                  request.ask.conversation.trim(),
                  '</session>',
              ];
    const project = request.projectPath
        ? [`It runs in ${request.projectPath}: answer that as projectPath.`]
        : [
              'Pick the project from these:',
              '<projects>',
              ...request.projects.map((p) =>
                  p.recentTitles.length > 0 ? `${p.projectPath} (recent: ${p.recentTitles.join('; ')})` : p.projectPath,
              ),
              '</projects>',
          ];
    const existing =
        request.existing.length > 0
            ? ['The existing schedules:', ...request.existing.map((s) => `- ${s.cron}  ${s.name} (${s.projectPath})`)]
            : ['There are no other schedules yet.'];
    return [...ask, '', ...project, '', ...existing].join('\n');
}

/** One `claude -p` call to Sonnet, with nothing to call but the model. */
export function draftArgs(prompt: string): string[] {
    return [
        '-p',
        '--model',
        'sonnet',
        '--output-format',
        'json',
        '--tools',
        '',
        '--no-session-persistence',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--disable-slash-commands',
        '--system-prompt',
        DRAFT_SYSTEM_PROMPT,
        prompt,
    ];
}

const FENCE = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/;

function parseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    try {
        const parsed: unknown = JSON.parse(trimmed.match(FENCE)?.[1] ?? trimmed);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

const GARBLED = 'Claude answered in a shape that could not be read. Try again?';

/**
 * The draft from a finished call, or why there is none. The project must be
 * the one asked for or one of those offered: a path Claude made up is never
 * saved into. A cron the scheduler would not read is refused too.
 */
export function readDraftRun(run: ClaudeRun, request: DraftRequest): ScheduleDraftResult {
    const envelope = parseEnvelope(run.stdout);
    if (!envelope) return {error: failureLine(run.stderr || run.stdout, run.exitCode)};
    const message = typeof envelope.result === 'string' ? envelope.result : '';
    if (envelope.is_error === true || run.exitCode !== 0)
        return {error: failureLine(message || run.stderr, run.exitCode)};

    const answer = parseJsonObject(message);
    if (!answer) return {error: GARBLED};
    const name = text(answer.name);
    const prompt = text(answer.prompt);
    const cron = text(answer.cron).replace(/\s+/g, ' ');
    if (!name || !prompt) return {error: GARBLED};
    if (!isValidCron(cron))
        return {error: `Claude picked a time the scheduler cannot read (${cron || 'none'}). Try again?`};

    const offered = new Set(request.projects.map((p) => p.projectPath));
    const picked = text(answer.projectPath);
    const projectPath = request.projectPath ?? (offered.has(picked) ? picked : null);
    if (!projectPath) return {error: 'Claude could not tell which project this is for. Pick one and try again.'};

    const settings: ScheduleSettings = {
        ...DRAFT_DEFAULTS,
        name,
        slug: scheduleSlug(text(answer.slug)) || scheduleSlug(name),
        projectPath,
        cron,
        prompt,
        allowedTools: text(answer.allowedTools),
    };
    const draft: ScheduleDraft = {settings, whenReason: text(answer.whenReason) || null};
    return {draft};
}

// ── A session, as the conversation to repeat ──

/** One message of a session, as `chatMessagesOf` reads it. */
export interface ConversationMessage {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'tool';
    readonly text: string;
}

/** The most of a session sent to Claude. */
export const CONVERSATION_LIMIT = 60_000;
/** The most of any one message. */
const MESSAGE_LIMIT = 4_000;

const ROLE_LABEL = {user: 'User', assistant: 'Claude', tool: 'Tool'} as const;

/**
 * A session's messages as one text for the draft: the head and the tail of
 * its transcript, each message once, cut in the middle when it runs past
 * `CONVERSATION_LIMIT` so both what was asked and how it ended are kept.
 */
export function conversationText(messages: readonly ConversationMessage[], limit = CONVERSATION_LIMIT): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const body = message.text.length > MESSAGE_LIMIT ? message.text.slice(0, MESSAGE_LIMIT) + '…' : message.text;
        lines.push(`${ROLE_LABEL[message.role]}: ${body.trim()}`);
    }
    const whole = lines.join('\n\n');
    if (whole.length <= limit) return whole;
    const half = Math.floor((limit - 3) / 2);
    return `${whole.slice(0, half)}\n…\n${whole.slice(whole.length - half)}`;
}
