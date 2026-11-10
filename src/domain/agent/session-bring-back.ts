/**
 * The rules of a session's Bring back from a VM (#276) that need no git and no
 * link: which of the copy's checkouts the session works in, where on the Mac
 * it continues, and how its transcript is changed to continue there.
 */
import {absoluteDir, homeForm} from './schedule-dirs';
import {CLAUDE_WORKTREES_SEGMENT, rewriteTranscriptCwd} from './session-handoff';

/** The copy's checkout a VM session works in, absolute on the VM. */
export type VmCheckout =
    | {kind: 'main'; dir: string}
    /** `name` is its folder under `<copy>/.claude/worktrees/`, which the Mac's worktree takes too. */
    | {kind: 'worktree'; name: string; dir: string};

/**
 * Which of the copy's checkouts `cwd` is in: one of its worktrees under
 * `.claude/worktrees/`, or the copy itself. Both are absolute on the VM (`cwd`
 * as the agent or the transcript names it, `copy` with `~` expanded). A `cwd`
 * outside the copy has nothing Bring back knows how to bring.
 */
export function vmCheckout(cwd: string, copy: string): VmCheckout | {error: string} {
    const at = trimSlashes(cwd);
    const root = trimSlashes(copy);
    const under = root + CLAUDE_WORKTREES_SEGMENT;
    if (at.startsWith(under)) {
        const name = at.slice(under.length).split('/')[0];
        if (name) return {kind: 'worktree', name, dir: under + name};
    }
    if (at === root || at.startsWith(root + '/')) return {kind: 'main', dir: root};
    return {error: `The session works in ${cwd}, which is not in the copy at ${copy}.`};
}

/**
 * A VM transcript with every line's own `cwd` moved from the VM checkout `dir`
 * to `local`, the Mac's checkout. The VM names it two ways: absolute, as
 * Claude writes it there, and in `~` form, as a hand-off from the Mac wrote the
 * lines it carried over (`rewriteTranscriptCwd`); both are moved. Nothing else
 * in a line changes.
 */
export function rewriteBroughtBackCwd(raw: string, dir: string, home: string, local: string): string {
    const absolute = absoluteDir(dir, home);
    const tilde = homeForm(absolute, home);
    const moved = rewriteTranscriptCwd(raw, absolute, local);
    return tilde === absolute ? moved : rewriteTranscriptCwd(moved, tilde, local);
}

function trimSlashes(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
