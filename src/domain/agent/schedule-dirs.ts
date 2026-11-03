/**
 * The folders a VM host runs schedules in, and which paths fall under them
 * (#276 stage 5, Q18).
 *
 * The Mac names a copy as its project path does, `~/projects/app`, because it
 * cannot know the VM's home. The agent stores them that way too (in
 * `HostSettings.scheduleDirs`) and expands `~` only when it compares, so the
 * settings read the same on both sides.
 *
 * "Under" is a folder or anything below it, segment by segment:
 * `~/projects/app` holds `~/projects/app/sub` but not `~/projects/app-two`.
 * The same rule answers which schedules run on the agent and which of the
 * VM's transcripts `list-transcripts` lists.
 */

/** The longest folder entry kept; a path is never this long, a mistake can be. */
const MAX_DIR_CHARS = 4096;

/**
 * Whether `dir` may be stored as a schedule folder: `~/…` or absolute, with
 * no `..` segment and no NUL. A relative path would depend on the agent's own
 * working folder, and `..` could reach a folder the user never named, so both
 * are refused rather than guessed at. `~` alone is refused too: the whole home
 * folder is never one copy.
 */
export function isValidScheduleDir(dir: string): boolean {
    const trimmed = dir.trim();
    if (!trimmed || trimmed.length > MAX_DIR_CHARS || trimmed.includes('\0')) return false;
    if (!trimmed.startsWith('/') && !trimmed.startsWith('~/')) return false;
    const segments = trimmed.split('/');
    if (segments.includes('..')) return false;
    // `~/` or `/` and nothing else names no folder in particular.
    return segments.slice(1).some((segment) => segment !== '' && segment !== '.');
}

/**
 * A stored entry as it is kept: trimmed, with doubled and trailing slashes and
 * `.` segments folded, so `~/projects/app/` and `~/projects/app` are one entry.
 * Only for entries `isValidScheduleDir` accepted.
 */
export function normalScheduleDir(dir: string): string {
    const trimmed = dir.trim();
    const [first, ...rest] = trimmed.split('/');
    const kept = rest.filter((segment) => segment !== '' && segment !== '.');
    return `${first}/${kept.join('/')}`;
}

/** `~` or `~/…` with `home` put in, and folded as `normalScheduleDir` does; anything else only folded. */
export function absoluteDir(dir: string, home: string): string {
    const trimmed = dir.trim();
    const homeless = home.replace(/\/+$/, '');
    let expanded = trimmed;
    if (trimmed === '~') expanded = homeless;
    else if (trimmed.startsWith('~/')) expanded = homeless + trimmed.slice(1);
    const kept = expanded.split('/').filter((segment) => segment !== '' && segment !== '.');
    return '/' + kept.join('/');
}

/** Whether `path` is `dir` or below it; both absolute and folded. */
export function isAtOrBelow(path: string, dir: string): boolean {
    if (dir === '/') return path.startsWith('/');
    return path === dir || path.startsWith(dir + '/');
}

/** Whether `path` (absolute) is one of `dirs` (as stored, `~` kept) or below one. */
export function isUnderAny(path: string, dirs: readonly string[], home: string): boolean {
    const target = absoluteDir(path, home);
    return dirs.some((dir) => isAtOrBelow(target, absoluteDir(dir, home)));
}

/**
 * An absolute path as the Mac names it: `~/…` when it is in `home`, as it is
 * otherwise. The Mac matches a VM session to a copy by its project path, which
 * is in this form.
 */
export function homeForm(path: string, home: string): string {
    const target = absoluteDir(path, home);
    const root = absoluteDir(home, home);
    if (target === root) return '~';
    if (root !== '/' && target.startsWith(root + '/')) return '~' + target.slice(root.length);
    return target;
}
