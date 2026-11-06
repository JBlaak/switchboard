/**
 * Opening a folder in another app on the Mac (#342): an IDE, Finder, a
 * terminal.
 *
 * Each call says whether it worked, so the workspace service can fall back to
 * the next app when one is not installed.
 */
export interface WorkspaceLauncher {
    /**
     * Open `directory` with the app called `app` (`open -a <app> <directory>`).
     * False when the app is not installed or would not open it.
     */
    openWith(app: string, directory: string): Promise<boolean>;
    /** Open `directory` in a Finder window. False when it could not. */
    showInFinder(directory: string): Promise<boolean>;
}
