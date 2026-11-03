/**
 * The shell scripts that install, upgrade and start the agent on a VM (#276).
 *
 * Each is a POSIX `sh` string the provisioner runs over ssh (see
 * `ssh-provision.ts` for how it gets there). They are pure functions of the
 * layout and the versions, so their content and quoting are unit-tested, and
 * every one is safe to run again: an install that stopped half-way is finished
 * by running it once more.
 *
 * Scripts that the installer has to read an answer from print `key=value`
 * lines on stdout and keep their explanations on stderr, so a login banner or a
 * warning can't be mistaken for an answer.
 */
import {
    AGENT_BIN,
    AGENT_CURRENT,
    AGENT_HOME,
    AGENT_NODE,
    AGENT_SOCKET,
    AGENT_UNIT,
    agentVersionDir,
    nodeDir,
} from './layout';
import type {AgentArch} from './layout';
import {remoteDirname, remotePathWord, writeStdinToFileScript} from './ssh-provision';

/**
 * The oldest glibc the agent runs on: Node 22's official Linux builds and the
 * node-pty prebuilds both link against glibc 2.28.
 */
export const MIN_GLIBC = '2.28';

/** Seconds the start script waits for the agent's socket to appear. */
export const SOCKET_WAIT_SECONDS = 10;

/** Where the installer uploads the agent bundle before unpacking it. */
export function agentUploadPath(version: string, arch: AgentArch): string {
    return `${AGENT_HOME}/upload/agent-${safeVersion(version)}-${arch}.tar`;
}

/**
 * Makes `systemctl --user` reachable from a non-interactive ssh command.
 *
 * pam_systemd normally sets XDG_RUNTIME_DIR for an ssh login, but not on every
 * distro and not for every sshd config; without it `systemctl --user` can't
 * find the user manager and reports "Failed to connect to bus" even though the
 * manager is running.
 */
const RUNTIME_DIR_PRELUDE =
    'if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi';

// ── Host check ──

/** What the host check found, parsed from its `key=value` lines. */
export interface HostCheck {
    /** `uname -s`, e.g. `Linux` or `Darwin`. */
    os: string;
    /** `uname -m`, e.g. `x86_64`. */
    machine: string;
    /** The machine mapped to an architecture the agent ships for, or null. */
    arch: AgentArch | null;
    /** `glibc`, `musl`, or `unknown` (also for a non-Linux host). */
    libc: string;
    /** The glibc version, e.g. `2.35`, when it could be read. */
    glibcVersion: string | null;
    /** Whether `systemctl --user` reaches a user manager. */
    systemdUser: boolean;
    /** Whether lingering is on, so the user manager outlives the last login. */
    linger: boolean;
    /** Whether `sudo -n true` works (or the user is root): what the host instructions may promise. */
    sudo: boolean;
    /** What `switchboard-agent version` printed, or null when no agent is installed. */
    agentVersion: string | null;
    curl: boolean;
    wget: boolean;
    tar: boolean;
    xz: boolean;
    sha256sum: boolean;
}

/**
 * The script that checks a host before anything is installed.
 *
 * It only reads: nothing is written, so it is also safe to run on a host the
 * agent will be refused on.
 */
export function hostCheckScript(): string {
    const bin = remotePathWord(AGENT_BIN);
    return [
        RUNTIME_DIR_PRELUDE,
        'os=$(uname -s 2>/dev/null || echo unknown)',
        'm=$(uname -m 2>/dev/null || echo unknown)',
        'case "$m" in x86_64|amd64) a=x64 ;; aarch64|arm64) a=arm64 ;; *) a=unsupported ;; esac',
        'echo "os=$os"',
        'echo "machine=$m"',
        'echo "arch=$a"',
        // musl's ldd says "musl libc" on stderr; glibc's says "GNU libc" / "GLIBC".
        'libc=unknown; glibc=',
        'if [ "$os" = Linux ]; then',
        '    if ldd --version 2>&1 | grep -qi musl; then libc=musl;',
        "    else libc=glibc; glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p'); fi",
        'fi',
        'echo "libc=$libc"',
        'echo "glibc=$glibc"',
        'if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo systemd=yes; else echo systemd=no; fi',
        'u=$(id -un 2>/dev/null || echo "${USER:-}")',
        'l=$(loginctl show-user "$u" -p Linger 2>/dev/null | sed -n \'s/^Linger=//p\')',
        'if [ -z "$l" ] && [ -e "/var/lib/systemd/linger/$u" ]; then l=yes; fi',
        'echo "linger=${l:-no}"',
        'if [ "$(id -u)" = 0 ]; then echo sudo=yes;',
        'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then echo sudo=yes;',
        'else echo sudo=no; fi',
        'v=',
        `if [ -x ${bin} ]; then v=$(${bin} version 2>/dev/null | head -n 1 | tr -d '\\r'); fi`,
        'echo "agent=$v"',
        'for t in curl wget tar xz sha256sum; do',
        '    if command -v "$t" >/dev/null 2>&1; then echo "$t=yes"; else echo "$t=no"; fi',
        'done',
    ].join('\n');
}

/** The `key=value` lines of a script's stdout; later keys win, other lines are ignored. */
export function parseKeyValues(stdout: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const raw of stdout.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
        if (m) values[m[1]] = m[2].trim();
    }
    return values;
}

/** The host check's stdout, as a `HostCheck`. Missing keys read as "no". */
export function parseHostCheck(stdout: string): HostCheck {
    const v = parseKeyValues(stdout);
    const yes = (key: string) => v[key] === 'yes';
    const arch = v.arch === 'x64' || v.arch === 'arm64' ? v.arch : null;
    return {
        os: v.os || 'unknown',
        machine: v.machine || 'unknown',
        arch,
        libc: v.libc || 'unknown',
        glibcVersion: v.glibc || null,
        systemdUser: yes('systemd'),
        linger: yes('linger'),
        sudo: yes('sudo'),
        agentVersion: v.agent || null,
        curl: yes('curl'),
        wget: yes('wget'),
        tar: yes('tar'),
        xz: yes('xz'),
        sha256sum: yes('sha256sum'),
    };
}

/**
 * Why the agent can't be installed on this host, or null when it can.
 *
 * Each message says what is wrong and, where the user can fix it, what to do;
 * a host that is refused keeps working as an ssh+tmux remote.
 */
export function hostCheckProblem(check: HostCheck): string | null {
    if (check.os !== 'Linux') {
        return `The Switchboard agent runs on Linux only, and this host runs ${check.os}. It keeps working as an SSH remote.`;
    }
    if (!check.arch) {
        return `The Switchboard agent runs on x64 and arm64 machines, and this host is ${check.machine}. It keeps working as an SSH remote.`;
    }
    if (check.libc === 'musl') {
        return 'This host uses musl libc (Alpine, for example). The agent needs a glibc-based Linux such as Debian, Ubuntu or Fedora. It keeps working as an SSH remote.';
    }
    if (check.glibcVersion && compareVersions(check.glibcVersion, MIN_GLIBC) < 0) {
        return `This host has glibc ${check.glibcVersion}, and the agent needs ${MIN_GLIBC} or newer (Debian 10, Ubuntu 20.04, RHEL 8 or later). It keeps working as an SSH remote.`;
    }
    if (!check.systemdUser) {
        return "This host has no systemd user instance (`systemctl --user` doesn't work), and the agent runs as a systemd user service. It keeps working as an SSH remote.";
    }
    const missing: string[] = [];
    if (!check.curl && !check.wget) missing.push('curl (or wget)');
    if (!check.tar) missing.push('tar');
    if (!check.xz) missing.push('xz');
    if (!check.sha256sum) missing.push('sha256sum');
    if (missing.length) {
        return (
            `This host is missing ${listing(missing)}, which the install needs. Install ${missing.length > 1 ? 'them' : 'it'} and try again: ` +
            '`sudo apt install curl tar xz-utils coreutils` on Debian or Ubuntu, `sudo dnf install curl tar xz coreutils` on Fedora.'
        );
    }
    return null;
}

/** A dotted version comparison, enough for glibc's `2.35`; non-numbers count as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

function listing(items: string[]): string {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// ── Node ──

/**
 * The script that puts the pinned Node on the host.
 *
 * Skips when that version is already unpacked. Otherwise it downloads the
 * official tarball from nodejs.org, refuses it unless its SHA-256 matches the
 * sum baked into the app (so a compromised mirror or proxy can't hand the agent
 * another binary), and unpacks it beside the target before renaming, so a
 * failed download never leaves a half-unpacked Node that the skip check would
 * take for a good one. The download goes under `AGENT_HOME`, not `/tmp`, which
 * may be a small tmpfs.
 */
export function nodeInstallScript(arch: AgentArch, node: {version: string; sha256: string} = pinnedNode(arch)): string {
    const version = safeVersion(node.version);
    if (!/^[0-9a-f]{64}$/.test(node.sha256)) throw new Error(`Not a SHA-256 sum: ${node.sha256}`);
    const name = `node-v${version}-linux-${arch}`;
    const url = `https://nodejs.org/dist/v${version}/${name}.tar.xz`;
    const dir = nodeDir(version);
    return [
        'set -eu',
        `dir=${remotePathWord(dir)}`,
        'if [ -x "$dir/bin/node" ]; then echo node=present; exit 0; fi',
        `parent=${remotePathWord(remoteDirname(dir))}`,
        'mkdir -p "$parent"',
        'work=$(mktemp -d "$parent/.download.XXXXXX")',
        'trap \'rm -rf "$work"\' EXIT',
        `url='${url}'`,
        'echo "Downloading $url" >&2',
        'if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$work/node.tar.xz" "$url";',
        'else wget -q -O "$work/node.tar.xz" "$url"; fi',
        `expected='${node.sha256}'`,
        'actual=$(sha256sum "$work/node.tar.xz" | cut -d \' \' -f 1)',
        'if [ "$actual" != "$expected" ]; then',
        '    echo "Switchboard: the Node download\'s SHA-256 is $actual, not the expected $expected. Refusing to install it." >&2',
        '    exit 3',
        'fi',
        'tar -xJf "$work/node.tar.xz" -C "$work"',
        'rm -rf "$dir"',
        `mv "$work/${name}" "$dir"`,
        'echo node=installed',
    ].join('\n');
}

function pinnedNode(arch: AgentArch): {version: string; sha256: string} {
    return {version: AGENT_NODE.version, sha256: AGENT_NODE.sha256[arch]};
}

// ── Agent ──

/**
 * The script that unpacks an uploaded agent bundle into its version's folder
 * and points `current` at it.
 *
 * The bundle is unpacked beside the target and renamed into place. The switch
 * of `current` is a rename of a fresh link over the old one (`mv -T`), which is
 * atomic, so a service (re)starting at any moment finds either the old version
 * or the new one, never a missing link. The link is relative, so the folder
 * can be moved with the home it lives in.
 */
export function agentUnpackScript(version: string, uploadedPath: string): string {
    const v = safeVersion(version);
    const dest = agentVersionDir(v);
    const linkDir = remoteDirname(AGENT_CURRENT);
    if (remoteDirname(dest) !== linkDir) throw new Error('The agent versions and `current` must share a folder.');
    const linkName = AGENT_CURRENT.slice(linkDir.length + 1);
    return [
        'set -eu',
        `dest=${remotePathWord(dest)}`,
        `links=${remotePathWord(linkDir)}`,
        `bundle=${remotePathWord(uploadedPath)}`,
        'rm -rf "$dest.partial"',
        'mkdir -p "$dest.partial"',
        'tar -xf "$bundle" -C "$dest.partial"',
        'if [ ! -f "$dest.partial/agent.js" ] || [ ! -f "$dest.partial/connect.js" ]; then',
        '    echo "Switchboard: the agent bundle has no agent.js or connect.js." >&2',
        '    exit 5',
        'fi',
        'rm -rf "$dest"',
        'mv "$dest.partial" "$dest"',
        'rm -f "$bundle"',
        `ln -sfn '${v}' "$links/${linkName}.next"`,
        `mv -fT "$links/${linkName}.next" "$links/${linkName}"`,
        'echo agent=unpacked',
    ].join('\n');
}

/**
 * The content of `AGENT_BIN`: the agent's one command.
 *
 * - `connect`: what the Mac runs over ssh; `connect.js` bridges stdio to the socket.
 * - `version`: prints the installed agent's version; `connect.js` answers it too.
 * - `serve`: runs the agent itself; this is what the systemd unit starts.
 *
 * It always runs the pinned Node, never whatever `node` is on the PATH, and
 * always the `current` version, so an upgrade only has to switch the link.
 */
export function agentBinScript(): string {
    return [
        '#!/bin/sh',
        "# The Switchboard agent's command, written by Switchboard's installer. Rewritten on every install.",
        '#   switchboard-agent connect   bridge stdio to the agent (what the Mac runs over ssh)',
        "#   switchboard-agent version   print the installed agent's version",
        '#   switchboard-agent serve     run the agent (what the systemd unit runs)',
        `node=${remotePathWord(nodeDir(AGENT_NODE.version) + '/bin/node')}`,
        `current=${remotePathWord(AGENT_CURRENT)}`,
        'case "${1:-}" in',
        '    connect|version) exec "$node" "$current/connect.js" "$@" ;;',
        '    serve) shift; exec "$node" "$current/agent.js" "$@" ;;',
        '    *) echo "usage: switchboard-agent connect|version|serve" >&2; exit 2 ;;',
        'esac',
        '',
    ].join('\n');
}

/**
 * The systemd user unit.
 *
 * `ExecStart` goes through `AGENT_BIN serve`, which execs the pinned Node on
 * `current/agent.js`, so systemd tracks that Node process itself. Output goes
 * to the journal (`journalctl --user -u switchboard-agent`). `Restart=on-failure`
 * brings a crashed agent back without fighting a deliberate stop. The default
 * KillMode (the whole control group) applies: a session's PTY can't outlive
 * the agent that holds its other end, so stopping the agent ends its sessions.
 */
export function agentUnitFile(): string {
    return [
        '[Unit]',
        'Description=Switchboard agent (runs Switchboard sessions on this machine)',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${systemdPath(AGENT_BIN)} serve`,
        'WorkingDirectory=%h',
        'Restart=on-failure',
        'RestartSec=2',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=switchboard-agent',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}

/** A `$HOME/…` layout path as systemd spells it, with the `%h` specifier. */
function systemdPath(remotePath: string): string {
    if (!remotePath.startsWith('$HOME/')) throw new Error(`Not a home path: ${remotePath}`);
    const rest = remotePath.slice('$HOME/'.length);
    if (!/^[A-Za-z0-9._/-]+$/.test(rest)) throw new Error(`Not a plain path: ${remotePath}`);
    return '%h/' + rest;
}

// ── Lingering and the service ──

/**
 * The script that turns lingering on, so the user's systemd instance (and with
 * it the agent) keeps running when nobody is logged in.
 *
 * Prints `linger=yes` when it was already on, `linger=enabled` when this turned
 * it on, and `linger=needs-sudo` when neither polkit nor password-less sudo
 * would allow it. That last one is not a failure: the agent runs for as long as
 * a login lasts, and the installer hands the user `lingerCommand` to run in the
 * setup terminal, where sudo can ask for a password.
 */
export function lingerScript(): string {
    return [
        'u=$(id -un)',
        'l=$(loginctl show-user "$u" -p Linger 2>/dev/null | sed -n \'s/^Linger=//p\')',
        'if [ "$l" = yes ] || [ -e "/var/lib/systemd/linger/$u" ]; then echo linger=yes; exit 0; fi',
        'if loginctl enable-linger "$u" >/dev/null 2>&1; then echo linger=enabled; exit 0; fi',
        'if command -v sudo >/dev/null 2>&1 && sudo -n loginctl enable-linger "$u" >/dev/null 2>&1; then echo linger=enabled; exit 0; fi',
        'echo linger=needs-sudo',
    ].join('\n');
}

/** What the user runs on the host to turn lingering on by hand. */
export function lingerCommand(user: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`Not a plain user name: ${user}`);
    return `sudo loginctl enable-linger ${user}`;
}

/**
 * The script that makes sure the service is enabled and running, then waits
 * for its socket.
 *
 * With `restart` (an upgrade) the running agent is stopped first so the new
 * `current` is what starts. A stale socket file is removed whenever the agent
 * isn't running (after a crash, or by the restart), so finding the socket
 * really means a running agent opened it. Gives up after `SOCKET_WAIT_SECONDS`
 * with the unit's status on stderr, which the installer shows.
 */
export function startServiceScript({restart}: {restart: boolean}): string {
    const ticks = SOCKET_WAIT_SECONDS * 2;
    return [
        'set -u',
        RUNTIME_DIR_PRELUDE,
        `unit='${AGENT_UNIT}'`,
        `sock=${remotePathWord(AGENT_SOCKET)}`,
        'systemctl --user daemon-reload',
        'systemctl --user enable --quiet "$unit"',
        restart
            ? 'systemctl --user stop "$unit" 2>/dev/null || true; rm -f "$sock"'
            : 'if ! systemctl --user is-active --quiet "$unit"; then rm -f "$sock"; fi',
        'systemctl --user start "$unit"',
        'i=0',
        'while [ ! -S "$sock" ]; do',
        `    if [ "$i" -ge ${ticks} ]; then`,
        `        echo "Switchboard: the agent did not open its socket within ${SOCKET_WAIT_SECONDS} s." >&2`,
        '        systemctl --user status "$unit" --no-pager -n 20 >&2 || true',
        '        exit 4',
        '    fi',
        '    sleep 0.5',
        '    i=$((i + 1))',
        'done',
        'echo socket=ready',
    ].join('\n');
}

// ── Files ──

/**
 * The script that writes stdin to `remotePath` only when nothing is there yet,
 * printing `written=yes` or `written=no`.
 *
 * For the host settings: an install fills in the defaults once, and every
 * later install or upgrade keeps what the user changed since.
 */
export function writeFileIfMissingScript(remotePath: string, mode = 0o600): string {
    const target = remotePathWord(remotePath);
    return [
        // Drain stdin either way, so the Mac's write never fails on a closed pipe.
        `if [ -e ${target} ]; then cat >/dev/null; echo written=no; exit 0; fi`,
        '(',
        writeStdinToFileScript(remotePath, mode),
        ') || exit 1',
        'echo written=yes',
    ].join('\n');
}

/**
 * A version as it goes into a path and a script: the app's own `x.y.z` (with
 * an optional pre-release), never anything a shell would read as syntax.
 */
export function safeVersion(version: string): string {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`Not a version: ${version}`);
    }
    return version;
}
