/**
 * Finding the shells this machine has.
 *
 * Platform archaeology, and the reason it is behind a port: on Unix the
 * canonical list is /etc/shells, on Windows it is four hard-coded install
 * locations plus whatever `wsl.exe --list` says. None of it is knowledge the
 * launch path should carry.
 *
 * Discovered once per launch. Re-discovering per request would shell out to
 * `wsl.exe --list` every time the settings panel opened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';

const IS_WINDOWS = process.platform === 'win32';

/** Pretty names for the shells /etc/shells is likely to list. */
const UNIX_SHELL_NAMES: Record<string, string> = {
  zsh: 'Zsh',
  bash: 'Bash',
  sh: 'POSIX Shell',
  fish: 'Fish',
  nu: 'Nushell',
  pwsh: 'PowerShell',
  dash: 'Dash',
  ksh: 'Korn Shell',
  tcsh: 'tcsh',
  csh: 'C Shell',
};

function programFiles(): string {
  return process.env.ProgramFiles || 'C:\\Program Files';
}

function firstExisting(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function gitBashCandidates(): string[] {
  return [
    path.join(programFiles(), 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
}

function discoverWindowsProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = [];

  const comspec = process.env.COMSPEC || 'C:\\WINDOWS\\system32\\cmd.exe';
  if (fs.existsSync(comspec)) {
    profiles.push({ id: 'cmd', name: 'Command Prompt', path: comspec });
  }

  const pwsh = firstExisting([
    path.join(programFiles(), 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles(), 'PowerShell', '7-preview', 'pwsh.exe'),
  ]);
  if (pwsh) profiles.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh });

  const ps5 = path.join(
    process.env.SystemRoot || 'C:\\WINDOWS',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(ps5)) {
    profiles.push({ id: 'powershell', name: 'Windows PowerShell', path: ps5 });
  }

  const gitBash = firstExisting(gitBashCandidates());
  if (gitBash) profiles.push({ id: 'git-bash', name: 'Git Bash', path: gitBash });

  if (fs.existsSync('C:\\msys64\\usr\\bin\\bash.exe')) {
    profiles.push({ id: 'msys2', name: 'MSYS2', path: 'C:\\msys64\\usr\\bin\\bash.exe' });
  }

  try {
    // --quiet drops the header; the output is UTF-16, hence the NUL stripping.
    const raw = execSync('wsl.exe --list --quiet', {
      timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const distros = raw.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const distro of distros) {
      profiles.push({ id: 'wsl:' + distro, name: 'WSL — ' + distro, path: 'wsl.exe', args: ['-d', distro] });
    }
  } catch {
    // No WSL installed, or the call timed out.
  }

  return profiles;
}

function discoverUnixProfiles(): ShellProfile[] {
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
      profiles.push({ id: base, name: UNIX_SHELL_NAMES[base] || base, path: shellPath });
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

export function discoverShellProfiles(): ShellProfile[] {
  return IS_WINDOWS ? discoverWindowsProfiles() : discoverUnixProfiles();
}

export class SystemShellProfileProvider implements ShellProfileProvider {
  readonly isWindows = IS_WINDOWS;
  #profiles: ShellProfile[] | null = null;

  list(): ShellProfile[] {
    this.#profiles ??= discoverShellProfiles();
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
      // 'wsl.exe' is resolved off PATH, so it will not exist as a path.
      if (profile && (profile.path === 'wsl.exe' || fs.existsSync(profile.path))) return profile;
    }
    return this.#autoDetect();
  }

  #autoDetect(): ShellProfile {
    const auto = (shellPath: string): ShellProfile => ({ id: 'auto', name: 'Auto', path: shellPath });

    // SHELL is what the user's own terminal uses, and is set by Git Bash,
    // MSYS2 and WSL too — so it outranks any guess.
    if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return auto(process.env.SHELL);

    if (IS_WINDOWS) {
      const bash = firstExisting([...gitBashCandidates(), 'C:\\msys64\\usr\\bin\\bash.exe']);
      if (bash) return auto(bash);
      return auto(process.env.COMSPEC || 'powershell.exe');
    }

    return auto(firstExisting(['/bin/zsh', '/bin/bash', '/bin/sh']) ?? '/bin/sh');
  }
}

/** Where a shell is started when the project directory cannot be used. */
export function shellHomeDir(): string {
  return os.homedir();
}
