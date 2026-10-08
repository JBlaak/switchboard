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
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';

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

function discoverProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = [];
  const seen = new Set<string>();

  try {
    const lines = fs.readFileSync('/etc/shells', 'utf8').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    for (const shellPath of lines) {
      if (!fs.existsSync(shellPath)) continue;
      // Deduplicate by basename: /bin/bash and /usr/bin/bash are one choice.
      const base = path.basename(shellPath);
      if (seen.has(base)) continue;
      seen.add(base);
      profiles.push({ id: base, name: SHELL_NAMES[base] || base, path: shellPath });
    }
  } catch {
    // /etc/shells unreadable — offer the three that are almost certainly there.
    for (const [id, name, shellPath] of [
      ['zsh', 'Zsh', '/bin/zsh'],
      ['bash', 'Bash', '/bin/bash'],
      ['sh', 'POSIX Shell', '/bin/sh'],
    ] as const) {
      if (fs.existsSync(shellPath)) profiles.push({ id, name, path: shellPath });
    }
  }

  return profiles;
}

export class SystemShellProfileProvider implements ShellProfileProvider {
  #profiles: ShellProfile[] | null = null;

  list(): ShellProfile[] {
    this.#profiles ??= discoverProfiles();
    return this.#profiles;
  }

  /**
   * The shell for a profile id, or the best guess when there isn't one.
   *
   * Always answers with something runnable: a profile the user selected and
   * then uninstalled falls through to auto-detection rather than failing the
   * launch.
   */
  resolve(profileId?: string | null): ShellProfile {
    if (profileId && profileId !== 'auto') {
      const profile = this.list().find(p => p.id === profileId);
      if (profile && fs.existsSync(profile.path)) return profile;
    }
    return this.#autoDetect();
  }

  #autoDetect(): ShellProfile {
    const auto = (shellPath: string): ShellProfile => ({ id: 'auto', name: 'Auto', path: shellPath });

    // SHELL is what the user's own terminal uses, so it outranks any guess.
    if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return auto(process.env.SHELL);

    return auto(firstExisting(['/bin/zsh', '/bin/bash', '/bin/sh']) ?? '/bin/sh');
  }
}
