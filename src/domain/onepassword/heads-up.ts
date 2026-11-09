/**
 * The heads-up before a Claude session reaches for 1Password.
 *
 * 1Password's own prompt (Touch ID, or the account password when it is locked)
 * says what wants a key, never why, and it can come up while the user is in
 * another app entirely. So a local session's Bash calls pass a PreToolUse hook
 * first, and one that will reach 1Password is held there: Patch comes up in a
 * pop-up saying why, before 1Password says anything. Enter lets the command
 * run, and 1Password asks as it always does; Escape stops it, and Claude is
 * told the user said no.
 *
 * Two ways a command reaches 1Password:
 *
 * - `access`: the `op` CLI, which reads secrets out of a vault (and asks to
 *   unlock 1Password first when it is locked).
 * - `unlock`: anything that authenticates over SSH (`ssh`, `scp`, `sftp`,
 *   `rsync` to a host, `git` against an SSH remote), since the user's SSH agent
 *   is 1Password's, which asks before it hands over a key.
 *
 * The rules only look at the command text. A `git push` to a remote named in
 * the repository's config cannot be told apart from an HTTPS one here, so git
 * counts only when the command itself names an SSH address; a missed heads-up
 * there costs what it always cost, a false one would be noise on every push.
 */

/** What the command will ask 1Password for. */
export type OnePasswordNeed = 'access' | 'unlock';

/** A Bash call held for the heads-up, as the hook carried it. */
export interface OnePasswordCall {
    toolUseId: string;
    need: OnePasswordNeed;
    /** The command as Claude wrote it. */
    command: string;
    /** Claude's own description of the command, which is the why; empty when it gave none. */
    description: string;
}

/** A heads-up as the pop-up shows it. */
export interface OnePasswordHeadsUp extends OnePasswordCall {
    /** Its own id, unique across sessions, which the pop-up answers under. */
    id: string;
    /** The project the session runs in, by its folder name. */
    project: string;
    /** Epoch ms the hook gives up and the command goes ahead without an answer. */
    deadline: number;
}

/** Enter (`go`) or Escape (`stop`). */
export type HeadsUpAnswer = 'go' | 'stop';

/** How long the CLI waits on the hook. Running out lets the command go ahead, as without Switchboard. */
export const ONEPASSWORD_HOOK_TIMEOUT_SECONDS = 300;

/** The CLI shows this in its spinner while the hook waits. */
export const ONEPASSWORD_HOOK_STATUS = 'Waiting for your go-ahead for 1Password in Switchboard';

/** Told to Claude when the user stops the command. */
export const STOPPED_REASON =
    'The user saw a heads-up that this command would use 1Password and pressed Escape, so it did not run. ' +
    'Do not retry it unless the user asks.';

/** Where a command starts: the line's start, or after a separator, a pipe, `$(`, a backtick or a brace. */
const COMMAND_START = String.raw`(?:^|[;&|(\x60{\n]|\$\()\s*`;
/** What may come before the program: env assignments, and wrappers that run the next word. */
const PREFIXES = String.raw`(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|sudo|env|command|exec|time|nohup)\s+)*`;

function invokes(program: string): RegExp {
    return new RegExp(COMMAND_START + PREFIXES + String.raw`(?:\S*/)?` + program + String.raw`(?=\s|$|[;&|)])`);
}

const OP = invokes('op');
const SSH_TOOLS = invokes('(?:ssh|scp|sftp|ssh-copy-id|mosh|sshfs)');
const RSYNC = invokes('rsync');
const GIT = invokes('git');
/** A `host:path` argument, which sends rsync over ssh. */
const RSYNC_REMOTE = /\s(?:[\w.-]+@)?[\w.-]+:(?!\/\/)\S*/;
/** An SSH address git would dial: `ssh://…`, `git+ssh://…`, or scp-like `user@host:path`. */
const SSH_ADDRESS = /(?:\b(?:git\+)?ssh:\/\/|\b[\w.-]+@[\w.-]+:(?!\/\/))/;
/** git told to use a particular ssh command, which is ssh either way. */
const GIT_SSH = /\bGIT_SSH(?:_COMMAND)?=|\bcore\.sshCommand\b/;

/**
 * What a command will ask 1Password for, or null when it will not reach it.
 * `access` wins when a command does both: reading a secret is the bigger ask.
 */
export function onePasswordNeed(command: string): OnePasswordNeed | null {
    const bare = withoutQuotedText(command);
    if (OP.test(bare) || /\bop:\/\//.test(command)) return 'access';
    if (SSH_TOOLS.test(bare)) return 'unlock';
    if (RSYNC.test(bare) && RSYNC_REMOTE.test(command)) return 'unlock';
    if (GIT.test(bare) && (SSH_ADDRESS.test(command) || GIT_SSH.test(command))) return 'unlock';
    return null;
}

/**
 * The command with quoted text blanked out, so a program named inside an
 * argument (`grep -E "run:|ssh|rsync"`) is not taken for one being run.
 * Double-quoted text that runs a command of its own (`$(…)` or a backtick)
 * is kept, since what it runs is real.
 */
function withoutQuotedText(command: string): string {
    return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
        quoted.startsWith('"') && /\$\(|\x60/.test(quoted) ? quoted : ' '.repeat(quoted.length),
    );
}

/**
 * Check a hook request body. Null for anything but a PreToolUse Bash call
 * whose command will reach 1Password.
 */
export function parseOnePasswordHookInput(body: unknown): OnePasswordCall | null {
    if (!isRecord(body) || body.hook_event_name !== 'PreToolUse' || body.tool_name !== 'Bash') return null;
    const input = body.tool_input;
    if (!isRecord(input) || typeof input.command !== 'string') return null;
    const need = onePasswordNeed(input.command);
    if (!need) return null;
    return {
        toolUseId: typeof body.tool_use_id === 'string' ? body.tool_use_id : '',
        need,
        command: input.command,
        description: typeof input.description === 'string' ? input.description.trim() : '',
    };
}

/**
 * The hook's reply to an answer. Enter makes no decision: the command goes on
 * through the session's own permission rules, exactly as it would have, so the
 * heads-up never lets through what the user had not allowed. Escape denies it,
 * with the reason Claude is shown.
 */
export function onePasswordHookResponse(answer: HeadsUpAnswer): Record<string, unknown> {
    if (answer === 'go') return {};
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: STOPPED_REASON,
        },
    };
}

/** What the pop-up says, top to bottom. */
export interface HeadsUpCopy {
    /** The small label on top: what is asked for, and where. */
    eyebrow: string;
    /** Patch's line, the headline: what it needs. */
    line: string;
    /** Why, in Claude's words, or a plain fallback. */
    why: string;
    /** The Enter button. */
    goLabel: string;
    /** What happens after Enter, in the footer. */
    then: string;
}

/**
 * The copy, from the approved "1Password heads-up" design: Patch speaks the
 * headline ("I need your SSH key." / "Can I borrow a secret?"), and Claude's
 * own description of the command, lowercased into "Claude wants to …", says
 * why.
 */
export function headsUpCopy(headsUp: Pick<OnePasswordHeadsUp, 'need' | 'description' | 'project'>): HeadsUpCopy {
    const access = headsUp.need === 'access';
    return {
        eyebrow: `1Password · ${access ? 'Secret' : 'SSH key'} · ${headsUp.project}`,
        line: access ? 'Can I borrow a secret?' : 'I need your SSH key.',
        why: headsUp.description
            ? `Claude wants to ${clause(headsUp.description)}`
            : 'Claude didn’t say why. Check the command below.',
        goLabel: access ? 'Allow' : 'Unlock',
        then: 'Then 1Password asks for Touch ID.',
    };
}

/** "Push the release branch" → "push the release branch.", keeping "SSH" and "npm" as written. */
function clause(text: string): string {
    const first = /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
    return /[.!?…]$/.test(first) ? first : first + '.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
