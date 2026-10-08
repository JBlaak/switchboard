/**
 * Logging, as a dependency.
 *
 * Narrow on purpose: electron-log and `console` both satisfy it, so a use case
 * can be exercised in a test without pulling in Electron's log transports.
 */

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
