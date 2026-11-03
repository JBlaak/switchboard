/**
 * The ssh command lines that install and check the agent on a VM (#276), as
 * pure functions so every quoting layer is unit-tested.
 *
 * Provisioning is not a terminal: it runs short scripts and reads their output,
 * so ssh gets no TTY (`-T`) and is spawned with stdin and stdout as pipes. Two
 * shells sit between the Mac and a script: the user's login shell on the VM,
 * which sshd hands the command line to, and the POSIX `sh` the script runs in.
 * The login shell may be bash, zsh or fish, so the command line it sees is kept
 * to one `exec sh -c '<script>'` that all of them parse the same way, and the
 * scripts themselves are POSIX `sh`. (csh and tcsh reject newlines inside
 * quotes, so a host whose login shell is one of those is not supported.)
 */
import {posixQuote} from '../shell/quoting';
import type {RemoteConfig} from '../project/remote-target';

/**
 * Seconds ssh may spend reaching the host. The same as a session's: long
 * enough for a VM to answer, short enough that a host that is off fails the
 * install with a message instead of hanging on the OS's TCP timeout.
 */
export const PROVISION_CONNECT_TIMEOUT_SECONDS = 10;

/** How long a provisioning command may run before it is killed, unless the caller says otherwise. */
export const PROVISION_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The ssh argv that runs `script` with POSIX `sh` on the host.
 *
 * - `-T`: no TTY. Output is read by a program, and a TTY would turn `\n` into
 *   `\r\n` and mix stderr into stdout.
 * - `BatchMode=yes`: ssh never prompts. With no terminal to answer in, a
 *   password or passphrase prompt could only hang until the timeout, or worse,
 *   appear in the terminal `npm run electron-dev` was started from. It does not
 *   stop agent-held keys: 1Password (and any other agent) asks for its approval
 *   in its own window when ssh asks it to sign, which BatchMode does not touch.
 *   A host that only takes a password therefore fails fast with ssh's
 *   "Permission denied", which names the problem.
 * - `StrictHostKeyChecking=accept-new`: a VM added a minute ago is not in
 *   `known_hosts` yet, and BatchMode would refuse it rather than ask. accept-new
 *   records a host seen for the first time, which is what answering "yes" at
 *   the prompt does, and still refuses a host whose key has *changed*.
 * - `ConnectTimeout` and the keep-alives: as for sessions, so a dead link is an
 *   error within seconds rather than a hang.
 *
 * No `-A`: nothing the installer runs needs the Mac's agent on the VM.
 */
export function buildProvisionSshArgv(host: RemoteConfig, script: string): string[] {
    const argv = [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=' + PROVISION_CONNECT_TIMEOUT_SECONDS,
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
    ];
    if (host.port && Number(host.port) !== 22) argv.push('-p', String(host.port));
    argv.push(host.user + '@' + host.host, remoteShCommand(script));
    return argv;
}

/**
 * The command line the VM's login shell gets: `script` run by POSIX `sh`.
 *
 * Single quotes with `'\''` for an embedded quote mean the same in bash, zsh,
 * dash and fish, so the script reaches `sh` byte for byte whatever the user's
 * shell is.
 */
export function remoteShCommand(script: string): string {
    return 'exec sh -c ' + posixQuote(script);
}

/**
 * A remote path as one shell word, with a leading `$HOME/` or `~/` left to
 * expand on the VM and everything else quoted literally.
 *
 * The layout's paths all start with `$HOME`, which has to expand in the remote
 * shell and so cannot sit in single quotes; the rest is quoted so a space or a
 * `$` in it stays literal.
 */
export function remotePathWord(remotePath: string): string {
    for (const prefix of ['$HOME/', '~/']) {
        if (remotePath.startsWith(prefix)) return '"$HOME"/' + posixQuote(remotePath.slice(prefix.length));
    }
    if (remotePath === '$HOME' || remotePath === '~') return '"$HOME"';
    return posixQuote(remotePath);
}

/** The folder part of a remote path; `.` when it has none. */
export function remoteDirname(remotePath: string): string {
    const i = remotePath.replace(/\/+$/, '').lastIndexOf('/');
    if (i < 0) return '.';
    return i === 0 ? '/' : remotePath.slice(0, i);
}

/**
 * The script that writes its stdin to `remotePath` with `mode`, creating the
 * folder.
 *
 * It writes beside the target and renames, so a reader (the systemd unit, the
 * connect command) never sees half a file and a dropped upload leaves the old
 * file in place. Used for uploads and for every small file the installer
 * writes. This replaces scp: it goes through the very same ssh invocation, so
 * the user's ssh config, agent and host keys behave exactly as for `run`.
 */
export function writeStdinToFileScript(remotePath: string, mode = 0o644): string {
    const target = remotePathWord(remotePath);
    const tmp = remotePathWord(remotePath + '.partial');
    const octal = mode.toString(8).padStart(4, '0');
    return [
        'set -e',
        `umask 077`,
        `mkdir -p ${remotePathWord(remoteDirname(remotePath))}`,
        `cat > ${tmp}`,
        `chmod ${octal} ${tmp}`,
        `mv -f ${tmp} ${target}`,
    ].join('\n');
}

/**
 * Whether an ssh exit means ssh itself never got the command to the host.
 *
 * ssh exits 255 for its own errors (unknown host, refused, timed out, key
 * rejected, host key mismatch), and otherwise passes on the remote command's
 * code. A remote command can exit 255 too, so the code alone is not enough:
 * ssh's own failures also leave its message on stderr.
 */
export function isSshConnectFailure(code: number | null, stderr: string): boolean {
    if (code !== 255) return false;
    return SSH_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

const SSH_ERROR_PATTERNS = [
    /^ssh: /m,
    /Permission denied \(/,
    /Host key verification failed/,
    /Connection (refused|timed out|closed by|reset)/,
    /kex_exchange_identification/,
    /Could not resolve hostname/,
    /REMOTE HOST IDENTIFICATION HAS CHANGED/,
];

/** The line of ssh's stderr worth showing: the last non-empty one, which is where ssh puts the reason. */
export function sshFailureMessage(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    return lines[lines.length - 1] ?? 'ssh could not connect';
}
