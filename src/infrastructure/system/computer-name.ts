/**
 * What this Mac is called where people see it: "Joris's MacBook Pro", the
 * name in System Settings → General → Sharing, rather than the host name
 * ("Joriss-MacBook-Pro.local"). Phone access (#194) shows it on the phone and
 * advertises under it.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export function computerName(): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim();
      if (name) return name;
    } catch {
      // No name set, or no scutil: the host name will do.
    }
  }
  return os.hostname().replace(/\.local\.?$/, '') || 'Mac';
}
