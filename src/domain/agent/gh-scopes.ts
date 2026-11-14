/**
 * The token scopes a VM's `gh` login needs for Switchboard: `repo`, which
 * covers cloning and pushing private repos and reading or changing their
 * pull requests, issues, labels and Actions runs. Nothing Switchboard runs
 * needs more.
 *
 * Pure, so it is tested in node.
 */

export const REQUIRED_GH_SCOPES: readonly string[] = ['repo'];

/**
 * The scopes of the first token `gh auth status` lists (the active account),
 * from a line like `- Token scopes: 'gist', 'read:org', 'repo'` (older gh:
 * `✓ Token scopes: gist, read:org, repo`). Null when no such line is there,
 * e.g. for a fine-grained token, whose rights gh cannot list.
 */
export function ghTokenScopes(authStatus: string): string[] | null {
    const line = /Token scopes:\s*(.*)$/m.exec(authStatus);
    if (!line) return null;
    const value = line[1].trim();
    if (value === '' || /^none$/i.test(value)) return [];
    return value
        .split(',')
        .map((scope) => scope.trim().replace(/^'|'$/g, ''))
        .filter((scope) => scope !== '');
}

/** The required scopes the token lacks; empty when it has them all or its scopes can't be read. */
export function missingGhScopes(authStatus: string): string[] {
    const scopes = ghTokenScopes(authStatus);
    if (scopes === null) return [];
    return REQUIRED_GH_SCOPES.filter((scope) => !scopes.includes(scope));
}
