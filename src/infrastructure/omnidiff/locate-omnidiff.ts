/**
 * Where the bundled `omnidiff` binary is: in the app's resources when
 * packaged, under `vendor/omnidiff/<arch>/` of the checkout in development.
 * Null when it is not there as an executable file (a dev checkout that did
 * not fetch it), and the diff is then drawn by its lines alone.
 */
import {accessSync, constants, statSync} from 'node:fs';
import path from 'node:path';

export interface OmnidiffWhere {
    /** Electron's `app.isPackaged`. */
    packaged: boolean;
    /** `process.resourcesPath`. */
    resourcesPath: string;
    /**
     * Electron's `app.getAppPath()`: the checkout when started as `electron .`,
     * its `app/` build folder when started on `app/main.js` (as the e2e suite does).
     */
    appPath: string;
    /** `process.arch`. */
    arch: string;
}

/** Where the binary may be, most likely first. */
export function omnidiffPaths(where: OmnidiffWhere): string[] {
    if (where.packaged) return [path.join(where.resourcesPath, 'omnidiff', 'omnidiff')];
    const vendored = (root: string): string => path.join(root, 'vendor', 'omnidiff', where.arch, 'omnidiff');
    return [vendored(where.appPath), vendored(path.dirname(where.appPath))];
}

export function locateOmnidiff(where: OmnidiffWhere): string | null {
    return omnidiffPaths(where).find(isExecutableFile) ?? null;
}

function isExecutableFile(candidate: string): boolean {
    try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
