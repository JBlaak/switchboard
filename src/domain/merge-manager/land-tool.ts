/**
 * The tool a session lands its own pull request with: `land`, offered next to
 * `archive_session` on Switchboard's own MCP server.
 *
 * A session that opens a pull request can hand it straight to the Merge
 * manager, the same as Land it on its row: the PR waits in its repository's
 * lane and merges once it is approved and green. The Merging host judges the
 * call as it does the button, so a draft, someone else's PR or a closed one is
 * refused, and the session reads why.
 */
import {ARCHIVE_TOOL_SERVER, type ArchiveToolOutcome, type McpTool} from '../session/archive-tool';
import {landedToastText} from './land-it';
import type {LandedView} from './model';

export const LAND_TOOL_NAME = 'land';
/** The tool's full name in the CLI, as `--allowedTools` takes it. */
export const LAND_TOOL_QUALIFIED_NAME = `mcp__${ARCHIVE_TOOL_SERVER}__${LAND_TOOL_NAME}`;

export const LAND_TOOL_DEFINITION: McpTool['definition'] = {
    name: LAND_TOOL_NAME,
    title: 'Land a pull request',
    description:
        "Land a pull request: hand it to Switchboard's Merge manager, which merges it once it is approved and " +
        "its checks are green, one at a time in its repository's lane. Pass the pull request's URL (as " +
        '`gh pr create` prints it) or `owner/repo#number`. Only your own open pull requests that are ready for ' +
        'review land; a draft, a closed one or a teammate’s is refused, and the result says why. Landing one that ' +
        'is already landed says where it stands. Carry on with your reply after calling it.',
    inputSchema: {
        type: 'object',
        properties: {
            pull_request: {
                type: 'string',
                description: 'The pull request: https://github.com/owner/repo/pull/123 or owner/repo#123.',
            },
        },
        required: ['pull_request'],
        additionalProperties: false,
    },
};

/**
 * When to land, as the server's instructions: right after opening a pull
 * request, so the user does not have to press Land it on the row.
 */
export const LAND_TOOL_INSTRUCTIONS =
    `Switchboard's Merge manager merges pull requests for the user. After you open a pull request that is ready ` +
    `for review (not a draft), land it with the \`${LAND_TOOL_NAME}\` tool (\`${LAND_TOOL_QUALIFIED_NAME}\`; load ` +
    'its schema first if it is deferred), passing the URL `gh pr create` printed, and tell the user in one line ' +
    'where it landed. Do not land it when the user asked you not to, asked for a draft, or said they will merge ' +
    'it themselves.';

/** Which pull request a call names. */
export interface LandInput {
    readonly repository: string;
    readonly number: number;
}

const PR_URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_REF = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

/** The call's arguments as a pull request, or why they are not one (the session reads it back). */
export function parseLandInput(args: unknown): {ok: true; input: LandInput} | {ok: false; error: string} {
    const value =
        typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>).pull_request
            : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        return {ok: false, error: 'land needs the pull request: its URL, or owner/repo#number.'};
    }
    const match = PR_URL.exec(value.trim()) ?? PR_REF.exec(value.trim());
    const number = match ? Number(match[3]) : NaN;
    if (!match || !Number.isSafeInteger(number) || number < 1) {
        return {
            ok: false,
            error: `land could not read "${value.trim()}" as a pull request: pass its GitHub URL, or owner/repo#number.`,
        };
    }
    return {ok: true, input: {repository: `${match[1]}/${match[2]}`, number}};
}

/** What the session reads back after landing: where it landed, or why not. */
export function landOutcome(
    input: LandInput,
    result: {ok: true; landed: LandedView} | {ok: false; reason: string},
): ArchiveToolOutcome {
    if (!result.ok) {
        return {ok: false, message: `${input.repository}#${input.number} did not land: ${result.reason}.`};
    }
    return {
        ok: true,
        message:
            `${landedToastText(result.landed)} (${input.repository}). The Merge manager merges it once it is ` +
            'approved and its checks are green; the user can follow it, or unland it, in Switchboard.',
    };
}

/** The tool as the MCP server offers it, calling `land` with a valid pull request. */
export function landTool(
    land: (input: LandInput) => Promise<ArchiveToolOutcome>,
): McpTool<ArchiveToolOutcome | Promise<ArchiveToolOutcome>> {
    return {
        definition: LAND_TOOL_DEFINITION,
        instructions: LAND_TOOL_INSTRUCTIONS,
        call: (args) => {
            const parsed = parseLandInput(args);
            return parsed.ok ? land(parsed.input) : {ok: false, message: parsed.error};
        },
    };
}
