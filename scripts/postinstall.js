#!/usr/bin/env node
/**
 * Runs after `npm install` (and after a mac build, which leaves the native
 * modules compiled for the packaged app) to get node_modules ready for
 * `electron .` on this Mac. Each step is best effort: a failure is logged and
 * the install carries on, because a broken postinstall blocks `npm ci` too.
 */
const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

/** Yields every file under `dir` whose name ends with `suffix`; unreadable folders are skipped. */
function* filesEndingWith(dir, suffix) {
    let entries;
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* filesEndingWith(full, suffix);
        } else if (entry.name.endsWith(suffix)) {
            yield full;
        }
    }
}

/**
 * Native modules have to be built against Electron's Node ABI, not the one npm
 * ran with. If electron-builder can't do it, rebuilding just better-sqlite3 is
 * enough: node-pty ships prebuilt binaries.
 */
function rebuildNativeModules() {
    try {
        execSync('npx electron-builder install-app-deps', {stdio: 'inherit'});
        return;
    } catch (error) {
        console.error(`electron-builder install-app-deps failed: ${error.message}`);
    }
    console.log('Rebuilding better-sqlite3 for Electron on its own instead...');
    try {
        execSync('npx @electron/rebuild -f -m . -o better-sqlite3', {stdio: 'inherit'});
        console.log('better-sqlite3 rebuilt.');
    } catch (error) {
        console.error(`Rebuilding better-sqlite3 failed as well: ${error.message}`);
    }
}

/** macOS refuses to load an unsigned .node binary, so give each one an ad-hoc signature. */
function signNativeBinaries() {
    for (const binary of filesEndingWith(NODE_MODULES, '.node')) {
        try {
            execSync(`codesign --sign - --force "${binary}"`, {stdio: 'ignore'});
        } catch {
            // Signing is only needed for binaries we load; one that fails is not fatal.
        }
    }
}

/** npm can unpack node-pty's spawn-helper without its execute bit, and then no terminal starts. */
function makeSpawnHelperExecutable() {
    for (const helper of filesEndingWith(path.join(NODE_MODULES, 'node-pty', 'prebuilds'), 'spawn-helper')) {
        try {
            fs.chmodSync(helper, 0o755);
        } catch {
            // Leave it; node-pty will report the missing permission when it spawns.
        }
    }
}

rebuildNativeModules();
signNativeBinaries();
makeSpawnHelperExecutable();
