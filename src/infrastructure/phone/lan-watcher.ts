/**
 * Noticing the Mac changed networks, for the phone listener (#194).
 *
 * The listener binds the LAN addresses it finds when it starts, so a new
 * Wi-Fi or a new DHCP lease leaves it listening on an address that is gone.
 * macOS has no network-change event Electron exposes, so the addresses are
 * read on a timer and compared; only a real change (an address added or
 * removed, in any order) is reported.
 */
import os from 'node:os';
import { lanAddresses } from './tls-device-link';
import type { TimerHandle, Timers } from '../../application/ports/clock';

/** How often the addresses are read. */
export const LAN_POLL_MS = 10_000;

export interface LanWatcherDeps {
  timers: Timers;
  /** The addresses the listener would bind now; the LAN addresses by default. */
  addresses?: () => string[];
  /** The addresses changed since the last read. */
  onChange(): void;
  intervalMs?: number;
}

export class LanWatcher {
  #timer: TimerHandle | null = null;
  #last = '';

  constructor(private readonly deps: LanWatcherDeps) {}

  start(): void {
    if (this.#timer !== null) return;
    this.#last = this.#read();
    this.#timer = this.deps.timers.setInterval(() => this.#check(), this.deps.intervalMs ?? LAN_POLL_MS);
  }

  stop(): void {
    this.deps.timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  #check(): void {
    const now = this.#read();
    if (now === this.#last) return;
    this.#last = now;
    this.deps.onChange();
  }

  #read(): string {
    const read = this.deps.addresses ?? (() => lanAddresses(os.networkInterfaces()));
    return [...read()].sort().join(' ');
  }
}
