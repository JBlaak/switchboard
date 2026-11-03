/**
 * The setup terminal's script (#276, user stories 6–10): what makes a fresh VM
 * ready for Claude work, run where the user can see it and answer prompts.
 *
 * The installer writes it to `SETUP_SCRIPT_FILE` on every install, and the
 * setup terminal types `setupTerminalCommand()` into a shell on the VM. Typing
 * one short command rather than the script itself keeps it working whatever
 * the user's login shell is (fish would not parse a POSIX script typed at it)
 * and keeps the terminal readable.
 *
 * It is POSIX `sh`, idempotent and safe to re-run: every step first checks
 * whether it's done and says so. A step that fails says what went wrong and the
 * script carries on with the next, so one failure doesn't hide the others.
 * `sudo` is only used where a step needs root, and in the terminal, so its
 * password prompt is in front of the user (story 8). Nothing from the Mac is
 * copied: each tool is signed in on the VM with its own credentials (story 11).
 */
import {AGENT_HOME} from './layout';

/** Where the installer puts the setup script on the VM. */
export const SETUP_SCRIPT_FILE = `${AGENT_HOME}/setup.sh`;

/** The line the setup terminal types into the VM's shell. `$HOME` in double quotes reads the same in sh, bash, zsh and fish. */
export function setupTerminalCommand(): string {
    return `sh "${SETUP_SCRIPT_FILE}"`;
}

/**
 * The setup script.
 *
 * - **git** from the distro's package manager (apt, dnf, pacman, zypper).
 * - **gh** from GitHub's official package repository on apt and dnf systems,
 *   from the distro on pacman and zypper, and otherwise (or when that fails,
 *   e.g. without sudo) from the official release tarball into `~/.local/bin`,
 *   which needs no root.
 * - **claude** from the official native installer
 *   (`curl -fsSL https://claude.ai/install.sh | bash`), which installs into
 *   `~/.local/bin` without root.
 * - Then `gh auth login` when gh isn't signed in (plus `gh auth setup-git`, so
 *   git clones and pushes over HTTPS as that login), and `claude` once when it
 *   has no credentials, so the user can log in.
 * - Finally one line per tool with a check mark.
 */
export function setupScript(): string {
    const lines = [
        '#!/bin/sh',
        "# Switchboard's VM setup, written by Switchboard's installer. Safe to run again.",
        'set -u',
        'export PATH="$HOME/.local/bin:$PATH"',
        '',
        "bold=''; green=''; red=''; dim=''; reset=''",
        "if [ -t 1 ]; then bold=$(printf '\\033[1m'); green=$(printf '\\033[32m'); red=$(printf '\\033[31m'); dim=$(printf '\\033[2m'); reset=$(printf '\\033[0m'); fi",
        'step() { printf \'\\n%s==> %s%s\\n\' "$bold" "$1" "$reset"; }',
        'ok() { printf \'%s✓ %s%s\\n\' "$green" "$1" "$reset"; }',
        'fail() { printf \'%s✗ %s%s\\n\' "$red" "$1" "$reset"; }',
        'note() { printf \'%s%s%s\\n\' "$dim" "$1" "$reset"; }',
        'have() { command -v "$1" >/dev/null 2>&1; }',
        '',
        // Root runs package managers directly; everyone else through sudo, whose
        // prompt shows in this terminal. Empty when neither is possible.
        'if [ "$(id -u)" = 0 ]; then SUDO=\'\'; elif have sudo; then SUDO=sudo; else SUDO=none; fi',
        'as_root() { if [ "$SUDO" = none ]; then return 1; fi; $SUDO "$@"; }',
        '',
        'case "$(uname -m)" in x86_64|amd64) deb_arch=amd64 ;; aarch64|arm64) deb_arch=arm64 ;; *) deb_arch=unknown ;; esac',
        '',
        'fetch() {',
        '    if have curl; then curl -fsSL "$1"; elif have wget; then wget -qO- "$1"; else echo "neither curl nor wget is installed" >&2; return 1; fi',
        '}',
        '',
        'pkg_install() {',
        '    if have apt-get; then as_root apt-get update -qq && as_root apt-get install -y "$@"',
        '    elif have dnf; then as_root dnf install -y "$@"',
        '    elif have pacman; then as_root pacman -S --noconfirm --needed "$@"',
        '    elif have zypper; then as_root zypper --non-interactive install "$@"',
        '    else echo "no supported package manager (apt, dnf, pacman, zypper)" >&2; return 1; fi',
        '}',
        '',
        '# ── git ──',
        'step "git"',
        'if have git; then ok "git is installed ($(git --version))"',
        'elif pkg_install git; then ok "git installed ($(git --version))"',
        'else fail "Could not install git. Install it with your package manager and run this again."; fi',
        '',
        '# ── gh ──',
        'gh_from_repo() {',
        '    if have apt-get; then',
        '        have curl || have wget || pkg_install curl || return 1',
        '        keyring=/etc/apt/keyrings/githubcli-archive-keyring.gpg',
        '        as_root mkdir -p -m 755 /etc/apt/keyrings || return 1',
        '        fetch https://cli.github.com/packages/githubcli-archive-keyring.gpg | as_root tee "$keyring" >/dev/null || return 1',
        '        as_root chmod go+r "$keyring" || return 1',
        '        echo "deb [arch=$(dpkg --print-architecture) signed-by=$keyring] https://cli.github.com/packages stable main" | as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null || return 1',
        '        as_root apt-get update -qq && as_root apt-get install -y gh',
        '    elif have dnf; then',
        '        if dnf --version 2>/dev/null | grep -q "^dnf5"; then',
        '            as_root dnf install -y dnf5-plugins && as_root dnf config-manager addrepo --overwrite --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo || return 1',
        '        else',
        "            as_root dnf install -y 'dnf-command(config-manager)' && as_root dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || return 1",
        '        fi',
        '        as_root dnf install -y gh --repo gh-cli',
        '    elif have pacman; then as_root pacman -S --noconfirm --needed github-cli',
        '    elif have zypper; then as_root zypper --non-interactive install gh',
        '    else return 1; fi',
        '}',
        'gh_from_tarball() {',
        '    [ "$deb_arch" != unknown ] || { echo "no gh release for $(uname -m)" >&2; return 1; }',
        '    tag=$(fetch https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\' | head -n 1)',
        '    [ -n "$tag" ] || { echo "could not find the latest gh release" >&2; return 1; }',
        '    work=$(mktemp -d) || return 1',
        '    name="gh_${tag}_linux_${deb_arch}"',
        '    if fetch "https://github.com/cli/cli/releases/download/v${tag}/${name}.tar.gz" > "$work/gh.tar.gz" && tar -xzf "$work/gh.tar.gz" -C "$work"; then',
        '        mkdir -p "$HOME/.local/bin" && cp "$work/$name/bin/gh" "$HOME/.local/bin/gh" && chmod 755 "$HOME/.local/bin/gh"',
        '        rc=$?',
        '    else rc=1; fi',
        '    rm -rf "$work"',
        '    return $rc',
        '}',
        'step "gh (GitHub CLI)"',
        'if have gh; then ok "gh is installed ($(gh --version | head -n 1))"',
        'elif { [ "$SUDO" != none ] && gh_from_repo; } || { note "Installing gh into ~/.local/bin instead."; gh_from_tarball; }; then',
        '    hash -r 2>/dev/null || true',
        '    ok "gh installed ($(gh --version | head -n 1))"',
        'else fail "Could not install gh. See https://github.com/cli/cli#installation and run this again."; fi',
        '',
        '# ── claude ──',
        'step "claude (Claude Code)"',
        'if have claude; then ok "claude is installed ($(claude --version 2>/dev/null | head -n 1))"',
        'elif ! have bash; then fail "The Claude Code installer needs bash; install bash and run this again."',
        'elif fetch https://claude.ai/install.sh | bash; then',
        '    hash -r 2>/dev/null || true',
        '    if have claude; then ok "claude installed ($(claude --version 2>/dev/null | head -n 1))"; else fail "The installer ran, but claude is not on the PATH (~/.local/bin)."; fi',
        'else fail "Could not install claude with its installer (https://claude.ai/install.sh). Run this again, or install it by hand."; fi',
        '',
        '# ── gh login ──',
        'step "GitHub login"',
        'if ! have gh; then fail "Skipped: gh is not installed."',
        'elif gh auth status >/dev/null 2>&1; then ok "gh is signed in"',
        'else',
        '    note "Sign in to GitHub as yourself. This VM gets its own login; nothing is copied from your Mac."',
        '    if gh auth login && gh auth status >/dev/null 2>&1; then ok "gh is signed in"; else fail "gh is not signed in. Run gh auth login to try again."; fi',
        'fi',
        'if have gh && gh auth status >/dev/null 2>&1; then gh auth setup-git >/dev/null 2>&1 || true; fi',
        '',
        '# ── claude login ──',
        'claude_signed_in() { [ -s "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; }',
        'step "Claude login"',
        'if ! have claude; then fail "Skipped: claude is not installed."',
        'elif claude_signed_in; then ok "claude has credentials"',
        'else',
        '    note "Claude Code starts now so you can log in. Follow its login steps, then type /exit to come back here."',
        '    claude',
        '    if claude_signed_in; then ok "claude has credentials"; else fail "claude has no credentials yet. Run claude to log in."; fi',
        'fi',
        '',
        '# ── summary ──',
        'step "Summary"',
        'if have git; then ok "git"; else fail "git"; fi',
        'if have gh && gh auth status >/dev/null 2>&1; then ok "gh (signed in)"; elif have gh; then fail "gh (not signed in)"; else fail "gh"; fi',
        'if have claude && claude_signed_in; then ok "claude (signed in)"; elif have claude; then fail "claude (not signed in)"; else fail "claude"; fi',
        '',
    ];
    return lines.join('\n');
}
