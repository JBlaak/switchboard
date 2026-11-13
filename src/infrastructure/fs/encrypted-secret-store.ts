/**
 * Secrets as encrypted files, behind the SecretStore port (#411).
 *
 * One file per secret, `<name>.enc`, readable by the user alone, holding what
 * the encryption made of it: in the app that is Electron safeStorage, whose
 * key is in the login Keychain, so the file is useless off this Mac. The
 * settings file never holds a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../application/ports/logger';
import type {SecretStore} from '../../application/ports/secret-store';

/** What keeps a secret unreadable at rest; Electron safeStorage in the app. */
export interface SecretEncryption {
    encrypt(text: string): Buffer;
    decrypt(data: Buffer): string;
}

export class EncryptedFileSecretStore implements SecretStore {
    constructor(
        private readonly directory: string,
        private readonly encryption: SecretEncryption,
        private readonly log: Logger,
    ) {}

    public read(name: string): string | null {
        let data: Buffer;
        try {
            data = fs.readFileSync(this.file(name));
        } catch {
            return null;
        }
        try {
            return this.encryption.decrypt(data);
        } catch (err) {
            this.log.warn(`[secrets] could not decrypt ${name}:`, (err as Error).message);
            return null;
        }
    }

    public write(name: string, value: string): void {
        const data = this.encryption.encrypt(value);
        fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
        const file = this.file(name);
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, data, {mode: 0o600});
        fs.renameSync(temp, file);
    }

    public remove(name: string): void {
        fs.rmSync(this.file(name), {force: true});
    }

    private file(name: string): string {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`not a secret name: ${name}`);
        return path.join(this.directory, `${name}.enc`);
    }
}
