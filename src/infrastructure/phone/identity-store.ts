/**
 * The Mac's TLS identity behind the ServerIdentityStore port.
 *
 * The key and the self-signed certificate are made by the system `openssl`
 * (LibreSSL on macOS, OpenSSL elsewhere; the one command below works on both)
 * in a single call that writes both PEM blocks to its stdout, so the
 * unencrypted key only ever exists in a pipe and in memory, never in a file.
 * It is written to disk encrypted with what the composition root passes in
 * (Electron safeStorage); the certificate is public and kept as plain PEM.
 */
import { execFile } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerIdentity, ServerIdentityStore } from '../../application/ports/phone-access';

/** What keeps the key unreadable at rest; Electron safeStorage in the app. */
export interface Encryption {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Runs a program and answers its stdout; rejects when it fails. */
export type Exec = (file: string, args: readonly string[]) => Promise<string>;

export interface IdentityStoreOptions {
  /** Where the key and certificate files live; made if missing. */
  directory: string;
  encryption: Encryption;
  /** The openssl binary; found on PATH by default. */
  openssl?: string;
  exec?: Exec;
}

const KEY_FILE = 'phone-server-key.enc';
const CERT_FILE = 'phone-server-cert.pem';

const VALID_DAYS = 3650;

const execOutput: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${file} ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`));
    else resolve(stdout);
  });
});

/** Lowercase hex SHA-256 of the certificate's DER, no separators. */
export function certificateFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

function pemBlock(text: string, label: string): string | null {
  const match = text.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`));
  return match ? match[0] + '\n' : null;
}

export class OpensslIdentityStore implements ServerIdentityStore {
  readonly #directory: string;
  readonly #encryption: Encryption;
  readonly #openssl: string;
  readonly #exec: Exec;
  /** The identity once read or made, so concurrent loads make only one. */
  #current: Promise<ServerIdentity> | null = null;

  constructor(options: IdentityStoreOptions) {
    this.#directory = options.directory;
    this.#encryption = options.encryption;
    this.#openssl = options.openssl ?? 'openssl';
    this.#exec = options.exec ?? execOutput;
  }

  load(): Promise<ServerIdentity> {
    this.#current ??= this.#readOrCreate();
    // A failed load is not remembered, so the next one tries again.
    this.#current.catch(() => { this.#current = null; });
    return this.#current;
  }

  reset(): Promise<ServerIdentity> {
    const next = (this.#current ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.#create());
    this.#current = next;
    next.catch(() => { this.#current = null; });
    return next;
  }

  async #readOrCreate(): Promise<ServerIdentity> {
    const stored = await this.#read();
    return stored ?? this.#create();
  }

  /**
   * The stored identity, or null when there is none yet or its key and
   * certificate do not belong together (a crash between the two writes).
   * A key that will not decrypt throws: making a new one would silently
   * un-pair every phone.
   */
  async #read(): Promise<ServerIdentity | null> {
    let encryptedKey: Buffer;
    let certPem: string;
    try {
      [encryptedKey, certPem] = await Promise.all([
        fs.readFile(path.join(this.#directory, KEY_FILE)),
        fs.readFile(path.join(this.#directory, CERT_FILE), 'utf8'),
      ]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const keyPem = this.#encryption.decrypt(encryptedKey);
    const certificate = new X509Certificate(certPem);
    if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) return null;
    return { keyPem, certPem, fingerprint: certificateFingerprint(certPem) };
  }

  async #create(): Promise<ServerIdentity> {
    const output = await this.#exec(this.#openssl, [
      'req', '-x509',
      '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', '/dev/stdout', '-out', '/dev/stdout',
      '-subj', '/CN=Switchboard', '-days', String(VALID_DAYS), '-sha256',
    ]);
    const keyPem = pemBlock(output, 'PRIVATE KEY') ?? pemBlock(output, 'EC PRIVATE KEY');
    const certPem = pemBlock(output, 'CERTIFICATE');
    if (!keyPem || !certPem) throw new Error('openssl did not print a key and a certificate');

    await fs.mkdir(this.#directory, { recursive: true });
    // Each file is written beside its final name and renamed over it, so a
    // crash part-way leaves the old file whole rather than a truncated one.
    await this.#writeAtomically(KEY_FILE, this.#encryption.encrypt(keyPem));
    await this.#writeAtomically(CERT_FILE, certPem);

    return { keyPem, certPem, fingerprint: certificateFingerprint(certPem) };
  }

  async #writeAtomically(name: string, data: Buffer | string): Promise<void> {
    const target = path.join(this.#directory, name);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
}
