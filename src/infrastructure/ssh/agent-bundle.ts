/**
 * The agent bundle the installer uploads to a VM (#276): one tar per
 * architecture, unpacked into `agentVersionDir(version)` there.
 *
 *     agent.js, connect.js (and their source maps)   from app/agent/
 *     node_modules/node-pty/package.json, lib/…      the node-pty JS
 *     node_modules/node-pty/prebuilds/linux-<arch>/pty.node
 *
 * `agent.js` requires `node-pty`, which Node resolves to the
 * `node_modules/node-pty` beside it. node-pty 1.x looks for its addon in
 * `build/Release`, then `prebuilds/<platform>-<arch>`, so the prebuild needs no
 * renaming. On Linux node-pty forks with `forkpty(3)`: the `spawn-helper`
 * binary it ships is macOS-only, so it isn't needed.
 *
 * Where the files come from differs between a packaged app and a checkout
 * (`agentBundleSources`); `scripts/fetch-agent-pty.mjs` puts the node-pty
 * builds there, and electron-builder's `extraResources` ships both.
 */
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {AgentArch} from '../../domain/agent/layout';
import {safeVersion} from '../../domain/agent/install-script';
import {tarArchive} from '../../domain/agent/tar';
import type {TarFile} from '../../domain/agent/tar';

/** Where the bundle's two halves are on this Mac. */
export interface AgentBundleSources {
    /** The built agent: `agent.js` and `connect.js`. */
    agentDir: string;
    /** Holds `linux-<arch>/node-pty/` for each architecture. */
    ptyRoot: string;
    /** Where built bundles are written; one file per version and architecture, overwritten. */
    outDir: string;
}

/**
 * The sources for a packaged app (`process.resourcesPath`, where
 * `extraResources` put them) or for a checkout (`app/agent` from the build,
 * `build/agent-pty` from the fetch script).
 */
export function agentBundleSources(options: {
    isPackaged: boolean;
    resourcesPath: string;
    appRoot: string;
    tmpDir: string;
}): AgentBundleSources {
    const outDir = path.join(options.tmpDir, 'switchboard-agent-bundles');
    if (options.isPackaged) {
        return {
            agentDir: path.join(options.resourcesPath, 'agent'),
            ptyRoot: path.join(options.resourcesPath, 'agent-pty'),
            outDir,
        };
    }
    return {
        agentDir: path.join(options.appRoot, 'app', 'agent'),
        ptyRoot: path.join(options.appRoot, 'build', 'agent-pty'),
        outDir,
    };
}

/** The agent's own files: the scripts and their source maps, nothing else that may sit in the folder. */
const AGENT_FILE = /\.(js|js\.map|cjs|cjs\.map)$/;

export class AgentBundleBuilder {
    constructor(private readonly sources: AgentBundleSources) {}

    /** Build the bundle for `arch` and answer its path on this Mac. */
    public async build(arch: AgentArch, version: string): Promise<string> {
        const agentFiles = (await readdir(this.sources.agentDir)).filter((name) => AGENT_FILE.test(name)).sort();
        for (const required of ['agent.js', 'connect.js']) {
            if (!agentFiles.includes(required)) {
                throw new Error(`${required} is missing from ${this.sources.agentDir}; build the app first.`);
            }
        }
        const ptyDir = path.join(this.sources.ptyRoot, `linux-${arch}`, 'node-pty');
        const addon = path.join(ptyDir, 'prebuilds', `linux-${arch}`, 'pty.node');
        if (!(await isFile(addon))) {
            throw new Error(
                `The Linux ${arch} node-pty build is missing (${addon}); run node scripts/fetch-agent-pty.mjs.`,
            );
        }

        const files: TarFile[] = [];
        for (const name of agentFiles) files.push(await tarFile(path.join(this.sources.agentDir, name), name));
        for (const rel of await listFiles(ptyDir)) {
            files.push(await tarFile(path.join(ptyDir, rel), `node_modules/node-pty/${rel}`));
        }

        await mkdir(this.sources.outDir, {recursive: true});
        const out = path.join(this.sources.outDir, `agent-${safeVersion(version)}-linux-${arch}.tar`);
        await writeFile(out, tarArchive(files));
        return out;
    }
}

async function tarFile(absolute: string, archivePath: string): Promise<TarFile> {
    const [data, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    return {path: archivePath, data, mode: info.mode & 0o777, mtime: Math.floor(info.mtimeMs / 1000)};
}

/** Every file under `dir`, relative and `/`-separated, in a stable order. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(path.join(dir, prefix), {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

async function isFile(p: string): Promise<boolean> {
    try {
        return (await stat(p)).isFile();
    } catch {
        return false;
    }
}

/**
 * The build stamp of the agent this app ships (`<agentDir>/VERSION`, written
 * by the build): what a VM's agent must report to count as current. The app's
 * own version stands in when the file is missing, as in a test harness.
 */
export function bundledAgentVersion(sources: Pick<AgentBundleSources, 'agentDir'>, fallback: string): string {
    try {
        return readFileSync(path.join(sources.agentDir, 'VERSION'), 'utf8').trim() || fallback;
    } catch {
        return fallback;
    }
}
