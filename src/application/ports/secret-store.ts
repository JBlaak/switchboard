/**
 * Secrets Switchboard holds for itself (#411), such as the Bugsnag personal
 * auth token: encrypted at rest with Electron safeStorage, a key in the login
 * Keychain, and kept out of the settings file. A secret read here stays in
 * main; nothing derived from it but what a caller chooses (the last four
 * characters) goes to the renderer.
 */
export interface SecretStore {
    /** The secret stored under `name`, or null when there is none or it can't be read. */
    read(name: string): string | null;
    /** Store `value` under `name`, replacing what was there. Throws when it can't be encrypted. */
    write(name: string, value: string): void;
    /** Forget `name`. Safe when nothing is stored. */
    remove(name: string): void;
}
