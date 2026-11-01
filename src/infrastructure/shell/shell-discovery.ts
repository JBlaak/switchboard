/**
 * Finding the shells this machine has.
 *
 * The canonical list is /etc/shells; it sits behind a port so the launch path
 * only ever asks for a resolved profile.
 *
 * Discovered once per launch: the list does not change while the app runs, and
 * the settings panel asks for it every time it opens.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {ShellProfile} from '../../domain/shell/shell-profile';
import type {ShellProfileProvider} from '../../application/ports/shell-profiles';

/** Pretty names for the shells /etc/shells is likely to list. */
const SHELL_NAMES: Record<string, string> = {
    zsh: 'Zsh',
    bash: 'Bash',
    sh: 'POSIX Shell',
    fish: 'Fish',
    nu: 'Nushell',
    dash: 'Dash',
    ksh: 'Korn Shell',
    tcsh: 'tcsh',
    csh: 'C Shell',
};

function firstExisting(candidates: readonly string[]): string | null {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** The shells a Mac always has, best first: the fallback when nothing better is known. */
const SYSTEM_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'];

/** The paths /etc/shells lists, without its comments and blank lines. */
function listedShellPaths(): string[] {
    return fs
        .readFileSync('/etc/shells', 'utf8')
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && !entry.startsWith('#'));
}

function discoverProfiles(): ShellProfile[] {
    let candidates: string[];
    try {
        candidates = listedShellPaths();
    } catch {
        candidates = SYSTEM_SHELLS;
    }

    // One profile per shell name: /bin/bash and /usr/bin/bash are a single
    // choice to the user, and the first installed one listed is the one used.
    const profiles = new Map<string, ShellProfile>();
    for (const shellPath of candidates) {
        const id = path.basename(shellPath);
        if (profiles.has(id) || !fs.existsSync(shellPath)) continue;
        profiles.set(id, {id, name: SHELL_NAMES[id] || id, path: shellPath});
    }
    return [...profiles.values()];
}

export class SystemShellProfileProvider implements ShellProfileProvider {
    private profiles: ShellProfile[] | null = null;

    public list(): ShellProfile[] {
        this.profiles ??= discoverProfiles();
        return this.profiles;
    }

    /**
     * The shell for a profile id, or the best guess when there isn't one.
     *
     * Always answers with something runnable: a profile the user selected and
     * then uninstalled falls through to auto-detection rather than failing the
     * launch.
     */
    public resolve(profileId?: string | null): ShellProfile {
        if (profileId && profileId !== 'auto') {
            const profile = this.list().find((p) => p.id === profileId);
            if (profile && fs.existsSync(profile.path)) return profile;
        }
        return this.autoDetect();
    }

    private autoDetect(): ShellProfile {
        const auto = (shellPath: string): ShellProfile => ({id: 'auto', name: 'Auto', path: shellPath});

        // SHELL is what the user's own terminal uses, so it outranks any guess.
        if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return auto(process.env.SHELL);

        return auto(firstExisting(SYSTEM_SHELLS) ?? '/bin/sh');
    }
}
