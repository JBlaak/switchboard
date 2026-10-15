/**
 * Replacing the running `.app` bundle with a newer one, behind the AppInstaller port.
 *
 * Release builds are not code-signed, and Squirrel.Mac — what electron-updater
 * installs through — refuses an unsigned app. So the swap is done by hand:
 * download the release zip, unpack it with `ditto` (which keeps the symlinks
 * and attributes the frameworks inside depend on), and hand a small shell
 * script the old and new paths. The script waits for this process to exit,
 * moves the old bundle aside, moves the new one in, and opens it; if the move
 * fails it puts the old one back, so the user is never left without an app.
 *
 * Everything that can fail — the download, the unpack — happens before the
 * quit, while the running app is still untouched.
 */
import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../../application/ports/logger';
import type { AppInstaller } from '../../application/ports/updates';

const SWAP_SCRIPT = `#!/bin/sh
# Put the new Switchboard in place once the running one has quit.
pid="$1"; old="$2"; new="$3"; work="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$old.previous-$$"
if mv "$old" "$backup"; then
  if mv "$new" "$old"; then
    rm -rf "$backup"
  else
    mv "$backup" "$old"
  fi
fi
open "$old"
rm -rf "$work"
`;

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

function writable(target: string): boolean {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class BundleInstaller implements AppInstaller {
  constructor(private readonly log: Logger) {}

  /** `/Applications/Switchboard.app`, from `…/Switchboard.app/Contents/MacOS/Switchboard`. */
  #bundlePath(): string {
    return path.resolve(app.getPath('exe'), '..', '..', '..');
  }

  canInstall(): boolean {
    if (!app.isPackaged || process.platform !== 'darwin') return false;
    const bundle = this.#bundlePath();
    // A quarantined app opened from Downloads runs from a read-only random
    // path; replacing that copy would change nothing the user launches.
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) return false;
    return writable(bundle) && writable(path.dirname(bundle));
  }

  async install(downloadUrl: string): Promise<void> {
    const bundle = this.#bundlePath();
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-update-'));
    try {
      const zip = path.join(work, 'update.zip');
      this.log.info(`[update] downloading ${downloadUrl}`);
      const response = await fetch(downloadUrl);
      if (!response.ok || !response.body) throw new Error(`download answered ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        createWriteStream(zip),
      );

      const unpacked = path.join(work, 'unpacked');
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      const name = (await fs.readdir(unpacked)).find(entry => entry.endsWith('.app'));
      if (!name) throw new Error('the download holds no .app bundle');
      const fresh = path.join(unpacked, name);
      await fs.access(path.join(fresh, 'Contents', 'MacOS'));
      // Not normally set on a file fetched from Node, but if it were the swapped-in
      // app would open behind a Gatekeeper prompt, or not at all.
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]).catch(() => {});

      const script = path.join(work, 'swap.sh');
      await fs.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
      spawn('/bin/sh', [script, String(process.pid), bundle, fresh, work], {
        detached: true, stdio: 'ignore',
      }).unref();
    } catch (err) {
      await fs.rm(work, { recursive: true, force: true });
      throw err;
    }

    this.log.info(`[update] swapping in the new bundle at ${bundle}; quitting`);
    app.quit();
  }
}
