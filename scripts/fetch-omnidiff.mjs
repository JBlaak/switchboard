#!/usr/bin/env node
// Downloads the OmniDiff binaries that Switchboard bundles for finer diffs on the Session work page,
// into vendor/omnidiff/ (gitignored). Runs from postinstall; electron-builder copies the result into
// the app's Resources (see package.json "build.mac.extraResources").
//
// OmniDiff is AGPL-3.0-only and bundled unmodified; its licence, third-party notices and a pointer to
// its source go along with it.

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// To bump OmniDiff: change the version and both checksums (`shasum -a 256` of each release tarball).
const VERSION = '0.3.0';
const ASSETS = {
    arm64: {
        file: 'omnidiff-aarch64-apple-darwin.tar.gz',
        sha256: '6b6d0367b9ca4f1485f2b57da40d42d7190def1ca5bf56b2fef01f12a388bc20',
    },
    x64: {
        file: 'omnidiff-x86_64-apple-darwin.tar.gz',
        sha256: 'c45e88a96089139e2c43b2a1d6a70c9ee9680e0c720a94eddd2327f57159fc5a',
    },
};

const REPO = 'https://github.com/ivankovic/omnidiff';
const vendorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'omnidiff');
const versionFile = path.join(vendorDir, 'VERSION');

if (process.platform !== 'darwin') {
    console.log(`fetch-omnidiff: skipped, OmniDiff is only bundled on macOS (this is ${process.platform}).`);
    process.exit(0);
}

if (isInPlace()) {
    console.log(`fetch-omnidiff: OmniDiff ${VERSION} is already in vendor/omnidiff.`);
    process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidiff-'));
try {
    // Download and verify everything before touching vendor/, so a failed run leaves it as it was.
    const extracted = {};
    for (const [arch, {file, sha256}] of Object.entries(ASSETS)) {
        extracted[arch] = await downloadAndExtract(arch, file, sha256);
    }
    fs.rmSync(vendorDir, {recursive: true, force: true});
    for (const [arch, dir] of Object.entries(extracted)) {
        const target = path.join(vendorDir, arch, 'omnidiff');
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.copyFileSync(requireFile(dir, 'omnidiff'), target);
        fs.chmodSync(target, 0o755);
    }
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
        fs.copyFileSync(requireFile(extracted.arm64, name), path.join(vendorDir, name));
    }
    fs.writeFileSync(path.join(vendorDir, 'SOURCE.md'), sourceNote());
    // Written last, so an interrupted run is retried next time.
    fs.writeFileSync(versionFile, `${VERSION}\n`);
    console.log(`fetch-omnidiff: OmniDiff ${VERSION} is in vendor/omnidiff.`);
} finally {
    fs.rmSync(work, {recursive: true, force: true});
}

function isInPlace() {
    try {
        if (fs.readFileSync(versionFile, 'utf8').trim() !== VERSION) return false;
    } catch {
        return false;
    }
    const expected = [
        ...Object.keys(ASSETS).map((arch) => path.join(arch, 'omnidiff')),
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
        'SOURCE.md',
    ];
    return expected.every((file) => fs.existsSync(path.join(vendorDir, file)));
}

async function downloadAndExtract(arch, file, sha256) {
    const url = `${REPO}/releases/download/v${VERSION}/${file}`;
    console.log(`fetch-omnidiff: downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
    const tarball = path.join(work, file);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tarball, bytes);

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
        fs.rmSync(tarball, {force: true});
        throw new Error(`Checksum mismatch for ${file}: expected ${sha256}, got ${actual}. The download was deleted.`);
    }

    const dir = path.join(work, arch);
    fs.mkdirSync(dir);
    execFileSync('tar', ['-xzf', tarball, '-C', dir], {stdio: 'inherit'});
    return dir;
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return full;
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        }
    }
    return null;
}

function requireFile(dir, name) {
    const found = findFile(dir, name);
    if (!found) throw new Error(`${name} is not in the OmniDiff ${VERSION} tarball.`);
    return found;
}

function sourceNote() {
    return `# OmniDiff ${VERSION}

Switchboard bundles OmniDiff ${VERSION}, unmodified, to show finer diffs on the Session work page.

- Licence: AGPL-3.0-only (see LICENSE; third-party notices in THIRD-PARTY-NOTICES.md)
- Source: ${REPO}/tree/v${VERSION}
- Binaries: ${REPO}/releases/tag/v${VERSION}
`;
}
