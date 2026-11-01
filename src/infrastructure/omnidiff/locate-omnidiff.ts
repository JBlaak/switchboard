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
    /** Electron's `app.getAppPath()`: the checkout in development. */
    appPath: string;
    /** `process.arch`. */
    arch: string;
}

export function omnidiffPath(where: OmnidiffWhere): string {
    return where.packaged
        ? path.join(where.resourcesPath, 'omnidiff', 'omnidiff')
        : path.join(where.appPath, 'vendor', 'omnidiff', where.arch, 'omnidiff');
}

export function locateOmnidiff(where: OmnidiffWhere): string | null {
    const candidate = omnidiffPath(where);
    try {
        if (!statSync(candidate).isFile()) return null;
        accessSync(candidate, constants.X_OK);
        return candidate;
    } catch {
        return null;
    }
}
