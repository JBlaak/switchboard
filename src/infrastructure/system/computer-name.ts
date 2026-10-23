/**
 * What this Mac is called, from `scutil`: the name people see, and the name
 * Bonjour resolves. Phone access (#194) shows the first on the phone and
 * advertises under it; the second goes in the pairing QR code and the
 * listening line.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** Reads one of `scutil`'s names; throws when it can't. */
export type ScutilRead = (name: 'ComputerName' | 'LocalHostName') => string;

const readScutil: ScutilRead = (name) =>
  execFileSync('/usr/sbin/scutil', ['--get', name], { encoding: 'utf8', timeout: 2_000 });

function scutil(name: 'ComputerName' | 'LocalHostName', read: ScutilRead): string | null {
  if (process.platform !== 'darwin' && read === readScutil) return null;
  try {
    return read(name).trim() || null;
  } catch {
    // Not set, or no scutil.
    return null;
  }
}

/**
 * "Joris's MacBook Pro", the name in System Settings → General → Sharing,
 * rather than the host name ("Joriss-MacBook-Pro.local").
 */
export function computerName(read: ScutilRead = readScutil): string {
  return scutil('ComputerName', read) ?? (os.hostname().replace(/\.local\.?$/, '') || 'Mac');
}

/**
 * The name this Mac answers to on the local network, "Joriss-MacBook-Pro-2.local":
 * macOS's LocalHostName, which is what mDNS resolves, unlike `os.hostname()`.
 * Null when `scutil` can't say; the advertiser then falls back to the host name.
 */
export function bonjourHostName(read: ScutilRead = readScutil): string | null {
  const name = scutil('LocalHostName', read);
  return name ? `${name}.local` : null;
}
