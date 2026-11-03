/**
 * The rules of a project hand-off (#276 stage 2) that need no git and no link:
 * which ignored files are offered to be carried along, which of them start
 * ticked, and where the copy goes on the VM.
 *
 * The hand-off carries the Mac's work through git (a bundle of unpushed
 * commits, a patch of uncommitted changes), but a checkout rarely runs on git
 * alone: it needs the `.env` and the `local.properties` nobody commits. Those
 * are ignored files, and so are `node_modules` and `build/`, which must never
 * go (they are huge, platform-specific, and the VM makes its own). The line
 * between the two is drawn here, by name, so the dialog, the service and the
 * tests all draw it the same way.
 */

/**
 * The most one offered file may be, raw. Config is small; a file larger than
 * this is data or a build product that happens to have a config-like name,
 * and is not offered at all. The total of the ticked files is capped again by
 * the contract's `HANDOFF_FILES_CAP_BYTES`.
 */
export const HANDOFF_FILE_CAP_BYTES = 512 * 1024;

/** Where copies go when the host has not said (the contract's default `baseFolder`). */
export const DEFAULT_COPY_BASE_FOLDER = '~/projects';

/**
 * Folders whose contents are never offered, at any depth: dependencies, build
 * output and caches. The VM installs and builds its own; carrying these would
 * be slow at best and wrong for another OS at worst.
 */
const NEVER_INSIDE: ReadonlySet<string> = new Set([
    '.git',
    'node_modules',
    'bower_components',
    '.gradle',
    'build',
    'dist',
    'out',
    '.next',
    '.nuxt',
    '.turbo',
    '.parcel-cache',
    '.svelte-kit',
    'target',
    'vendor',
    'Pods',
    'DerivedData',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    '.cache',
    'cache',
    'tmp',
    'coverage',
    '.idea',
]);

/** Files never offered whatever they are called otherwise: OS litter. */
const NEVER_NAMED: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

/** Exact file names that are config. */
const CONFIG_NAMES: ReadonlySet<string> = new Set(['.env', 'local.properties', '.npmrc']);

/**
 * Whether an ignored path (relative to the repository root, `/`-separated, as
 * `git ls-files --others --ignored --directory` lists it) is offered as a
 * config file to carry to the copy.
 *
 * Offered: `.env` and `.env.*`, `*.local`, `local.properties`, `.npmrc`,
 * `secrets.*`, `*.local.*` directly in a `config/` folder, and keys (`*.pem`,
 * `*.key`, see `isKeyFile`). Never: a directory (git lists a wholly ignored
 * one with a trailing `/`), anything in or being a dependency, build or cache
 * folder, and OS litter.
 */
export function isConfigCandidate(path: string): boolean {
    if (!path || path.endsWith('/') || path.startsWith('/')) return false;
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
    const name = segments[segments.length - 1];
    if (NEVER_NAMED.has(name)) return false;
    if (segments.slice(0, -1).some((folder) => NEVER_INSIDE.has(folder)) || NEVER_INSIDE.has(name)) return false;

    if (CONFIG_NAMES.has(name)) return true;
    if (name.startsWith('.env.')) return true;
    if (name.endsWith('.local') && name.length > '.local'.length) return true;
    if (/^secrets\.[^.]/.test(name)) return true;
    if (isKeyFile(path)) return true;
    const parent = segments.length >= 2 ? segments[segments.length - 2] : '';
    return parent === 'config' && /^[^.].*\.local\.[^.]+$/.test(name);
}

/**
 * A private key or certificate (`*.pem`, `*.key`). Offered, because a copy may
 * genuinely need one (a dev TLS cert), but never ticked unless the user ticked
 * it before: a key is the one thing a compromised VM should not get by default.
 */
export function isKeyFile(path: string): boolean {
    return /\.(pem|key)$/i.test(path);
}

/**
 * Which offered paths start ticked: exactly the ones the user carried last
 * time for this project (`remembered`), or, on a first hand-off (`null`),
 * every one except keys.
 */
export function tickedByDefault(path: string, remembered: readonly string[] | null): boolean {
    if (remembered) return remembered.includes(path);
    return !isKeyFile(path);
}

/**
 * The folder name a copy gets on the VM, from the local repository root's
 * basename: one path segment of letters, digits, `.`, `_` and `-` (what a
 * remote project's directory may hold, and what is safe in a shell), never
 * starting with `.` or `-`, and `project` when nothing is left.
 */
export function copyFolderName(repositoryRoot: string): string {
    const base = repositoryRoot.replace(/\/+$/, '').split('/').pop() ?? '';
    const safe = base
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[.-]+/, '')
        .replace(/-+$/, '');
    return safe || 'project';
}

/**
 * The copy's directory on its host: `<baseFolder>/<name>`, `~` kept as the
 * agent answers it. What a copy's project path holds as its `dir` when the
 * agent's answer does not name one.
 */
export function copyDir(baseFolder: string | null | undefined, name: string): string {
    const base = (baseFolder ?? '').trim().replace(/\/+$/, '') || DEFAULT_COPY_BASE_FOLDER;
    return `${base}/${name}`;
}
