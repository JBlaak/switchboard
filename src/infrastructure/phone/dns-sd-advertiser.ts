/**
 * The Bonjour advertisement of the phone listener (Phone access, #194), made
 * with macOS's own `dns-sd`: `dns-sd -R` registers the service for as long as
 * the process runs, so advertising is spawning it and withdrawing is killing
 * it. No native module, no mDNS stack of our own.
 *
 * The advertisement only says where to connect. It carries no session data,
 * and the phone trusts nothing in it: identity comes from the pinned
 * certificate fingerprint.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';

import { BONJOUR_SERVICE_TYPE } from '../../domain/phone/protocol';
import type { Logger } from '../../application/ports/logger';
import type { ServiceAdvertiser } from '../../application/ports/phone-access';

const DNS_SD = '/usr/bin/dns-sd';

/** The slice of a child process the advertiser uses. */
export interface AdvertiserProcess {
  kill(): void;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface DnsSdAdvertiserDeps {
  log: Logger;
  /** Starts a process; `child_process.spawn` by default. */
  spawn?: (command: string, args: string[]) => AdvertiserProcess;
  /** The machine's host name; `os.hostname()` by default. */
  hostname?: () => string;
}

/**
 * The `.local` name phones resolve: the host name's first label with `.local`
 * after it, lowercased, so "Joris-MBP", "joris-mbp.local." and
 * "joris-mbp.fritz.box" all become "joris-mbp.local".
 */
export function localHostName(hostname: string): string {
  const label = hostname.trim().replace(/\.$/, '').split('.')[0].toLowerCase();
  return `${label || 'localhost'}.local`;
}

export class DnsSdAdvertiser implements ServiceAdvertiser {
  #process: AdvertiserProcess | null = null;

  constructor(private readonly deps: DnsSdAdvertiserDeps) {}

  advertise(name: string, port: number, txt: Record<string, string>): void {
    this.withdraw();
    const spawn: (command: string, args: string[]) => AdvertiserProcess =
      this.deps.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: 'ignore' }));
    const args = [
      '-R', name, BONJOUR_SERVICE_TYPE, 'local', String(port),
      ...Object.entries(txt).map(([key, value]) => `${key}=${value}`),
    ];
    const child = spawn(DNS_SD, args);
    this.#process = child;
    child.on('error', (err) => this.deps.log.error('[phone] dns-sd failed to start:', err.message));
    child.on('exit', (code, signal) => {
      if (this.#process !== child) return;
      this.#process = null;
      this.deps.log.warn(`[phone] dns-sd exited (${signal ?? code}); the Mac is no longer advertised`);
    });
    this.deps.log.info(`[phone] advertising "${name}" as ${BONJOUR_SERVICE_TYPE} on port ${port}`);
  }

  withdraw(): void {
    const child = this.#process;
    if (!child) return;
    this.#process = null;
    child.kill();
  }

  hostName(): string {
    return localHostName((this.deps.hostname ?? os.hostname)());
  }
}
