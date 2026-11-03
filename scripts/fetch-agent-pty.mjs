// Puts the Linux node-pty builds the Switchboard agent runs with (#276) at
//
//   build/agent-pty/linux-x64/node-pty/{package.json,LICENSE,lib/…,prebuilds/linux-x64/pty.node}
//   build/agent-pty/linux-arm64/node-pty/{…,prebuilds/linux-arm64/pty.node}
//
// which electron-builder's `extraResources` ships as `Resources/agent-pty/`,
// and the installer packs into the bundle it uploads to a VM (see
// src/infrastructure/ssh/agent-bundle.ts).
//
//   node scripts/fetch-agent-pty.mjs     fetch now (skips when already there)
//
// It also runs as electron-builder's `beforePack` hook, so every package
// (`npm run build:mac`, `release`, `dist`, and CI's `electron-builder --mac`)
// has the builds, while `npm test` never touches the network.
//
// Where the builds come from, and why:
//
// - node-pty 1.1.0 (what the Mac app uses) publishes prebuilds for macOS and
//   Windows only; on Linux it compiles at install time, which the VM can't do
//   without a compiler and which the app shouldn't ask of it.
// - node-pty 1.2.0 (Microsoft's own package, still tagged beta on npm) adds
//   official `prebuilds/linux-x64` and `prebuilds/linux-arm64` builds, made by
//   its CI. These are the ones used. node-pty 1.x is a Node-API addon
//   (node-addon-api), so one build loads in every Node from 18 on, including
//   the agent's pinned Node 22, with no ABI matching to get wrong. Both link
//   against glibc 2.28 at most, the same floor as Node 22's own Linux builds,
//   so they run wherever that Node runs. On Linux node-pty uses forkpty(3):
//   the spawn-helper it ships is macOS-only and not needed.
// - Rejected: @homebridge/node-pty-prebuilt-multiarch is a fork with its own
//   JS (0.x versions) rather than node-pty itself; building in Docker needs
//   Docker and QEMU (for arm64) on every machine that packages the app, and is
//   only as reproducible as the image tag.
//
// Reproducible: the package is pinned to one version and its npm `integrity`
// (sha512), checked before anything is unpacked. It's only ever copied into
// the app's resources and uploaded to VMs; the Mac app never loads it, so it
// adds no runtime dependency there. Bump NODE_PTY.version and integrity
// together (`npm view node-pty@<version> dist.integrity`), and move to the
// stable 1.2.0 once it's published.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const NODE_PTY = {
    version: '1.2.0-beta.18',
    integrity: 'sha512-3Rej3788OnasAwoSmTZhlCeUraJ9CQldtL5b571b9+3Nv47+PaxA5VPIGOOs+16OYQePTrC1Lrs8a9/df5WPRg==',
};

/** The architectures the agent ships for; matches AgentArch in src/domain/agent/layout.ts. */
export const ARCHES = ['x64', 'arm64'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'build', 'agent-pty');
const stampFile = path.join(outRoot, 'source.json');

/** The JS node-pty needs at run time: lib/ without tests and source maps, its manifest and licence. */
function wanted(rel) {
    if (rel === 'package.json' || rel === 'LICENSE') return true;
    return rel.startsWith('lib/') && rel.endsWith('.js') && !rel.endsWith('.test.js');
}

function alreadyThere() {
    try {
        const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
        if (stamp.version !== NODE_PTY.version || stamp.integrity !== NODE_PTY.integrity) return false;
    } catch {
        return false;
    }
    return ARCHES.every((arch) =>
        fs.existsSync(path.join(outRoot, `linux-${arch}`, 'node-pty', 'prebuilds', `linux-${arch}`, 'pty.node')),
    );
}

async function download() {
    const url = `https://registry.npmjs.org/node-pty/-/node-pty-${NODE_PTY.version}.tgz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const [algorithm, expected] = NODE_PTY.integrity.split(/-(.*)/s);
    const actual = createHash(algorithm).update(bytes).digest('base64');
    if (actual !== expected) {
        throw new Error(
            `node-pty ${NODE_PTY.version} does not match its pinned integrity (got ${algorithm}-${actual}).`,
        );
    }
    return bytes;
}

function listFiles(dir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(dir, prefix), {withFileTypes: true})) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(dir, rel));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

/** Fetch the builds unless the pinned ones are already in place. Also electron-builder's `beforePack` hook. */
export default async function fetchAgentPty() {
    if (alreadyThere()) return;
    console.log(`fetch-agent-pty: node-pty ${NODE_PTY.version} Linux builds → build/agent-pty`);
    const bytes = await download();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-agent-pty-'));
    try {
        const tgz = path.join(work, 'node-pty.tgz');
        fs.writeFileSync(tgz, bytes);
        const unpacked = path.join(work, 'unpacked');
        fs.mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', tgz, '-C', unpacked]);
        const pkg = path.join(unpacked, 'package');
        const js = listFiles(pkg).filter(wanted);

        fs.rmSync(outRoot, {recursive: true, force: true});
        for (const arch of ARCHES) {
            const addon = path.join(pkg, 'prebuilds', `linux-${arch}`, 'pty.node');
            if (!fs.existsSync(addon)) throw new Error(`node-pty ${NODE_PTY.version} has no prebuilds/linux-${arch}.`);
            const dest = path.join(outRoot, `linux-${arch}`, 'node-pty');
            for (const rel of [...js, `prebuilds/linux-${arch}/pty.node`]) {
                fs.mkdirSync(path.dirname(path.join(dest, rel)), {recursive: true});
                fs.copyFileSync(path.join(pkg, rel), path.join(dest, rel));
            }
        }
        fs.writeFileSync(stampFile, JSON.stringify(NODE_PTY, null, 4) + '\n');
    } finally {
        fs.rmSync(work, {recursive: true, force: true});
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    fetchAgentPty().catch((err) => {
        console.error(`fetch-agent-pty: ${err.message}`);
        process.exit(1);
    });
}
